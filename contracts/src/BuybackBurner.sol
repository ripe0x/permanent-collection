// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {IBuybackBurner} from "./interfaces/IBuybackBurner.sol";
import {OneTimeSetup} from "./libraries/OneTimeSetup.sol";
import {ProtocolAdmin} from "./ProtocolAdmin.sol";
import {PCNoReentry} from "./libraries/PCNoReentry.sol";

/// @dev Minimal subset of the burn-capable ERC20 (the artcoins 111 token).
///      `burn(amount)` reduces the supply by sending `amount` to `0xdead`
///      or by decrementing balance + totalSupply, depending on the artcoins
///      implementation — either way the tokens are out of circulation.
interface IERC20Burnable {
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function burn(uint256) external;
}

/// @title  BuybackBurner
/// @notice Paced V4 swap: accumulates ETH (from cleared return auction proceeds
///         and any other inflow), then converts up to `maxStepWei` of
///         remaining ETH to 111 per step and calls `token.burn(amount)` to
///         reduce supply. Each step is permissionless and pays the caller
///         a small ETH reward. The pool is native-ETH paired, so the swap
///         settles ETH directly without a WETH wrap.
contract BuybackBurner is IBuybackBurner, IUnlockCallback, OneTimeSetup, PCNoReentry {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    error NotPoolManager();
    error NotAdmin();
    error StepTooEarly(uint256 nextBlock);
    error NothingToBurn();
    error InsufficientOutput(uint256 received, uint256 required);
    /// @dev The V4 swap returned a delta indicating more ETH input was
    ///      consumed than the exact-input `swapAmount` the contract asked
    ///      for. Defends against a misbehaving or maliciously-permissioned
    ///      hook (`beforeSwapReturnDelta` / `afterSwapReturnDelta`) returning
    ///      a delta that bypasses the per-step ETH cap.
    error ExcessInputSpent(uint256 ethSpent, uint256 swapAmount);
    error OutOfBounds(uint256 value, uint256 lo, uint256 hi);

    event BurnEthDeposited(address indexed source, uint256 amount, uint256 remainingEth);
    event TokensBurned(uint256 ethSpent, uint256 tokensBurned, uint256 remainingEth);
    event ExecutionRewardPaid(address indexed caller, uint256 amount);
    /// @dev Emitted when the keeper-reward send fails. The reward ETH is
    ///      credited back to `remainingEth` so the next call to `executeStep`
    ///      can still spend it on a swap; nothing is stranded out of accounting.
    event ExecutionRewardFailed(address indexed caller, uint256 amount);
    event ParameterChanged(bytes32 indexed key, uint256 oldValue, uint256 newValue);

    /// @notice Cap on the permissionless-execution reward paid to anyone who
    ///         calls `executeStep`. Bounded by both bps of step size and a
    ///         fixed absolute cap.
    uint256 public constant EXEC_REWARD_BPS = 50;        // 0.5% of step size
    uint256 public constant EXEC_REWARD_CAP = 0.01 ether;

    /// @notice Bounds for `minBlocksBetweenSteps`. Lower bound of 1 = burn
    ///         can fire every block; upper bound of ~1 week prevents the
    ///         queue from stalling indefinitely.
    /// @dev    `MIN_BLOCKS_LO >= 1` is load-bearing for reentrancy safety:
    ///         `executeStep` carries no `nonReentrant` mutex and relies solely
    ///         on `lastStepBlock` block-pacing as its same-tx reentry guard. A
    ///         floor of 1 block guarantees a same-tx reentrant `executeStep`
    ///         reverts `StepTooEarly` (`lastStepBlock == block.number`). Never
    ///         lower this to 0.
    uint256 public constant MIN_BLOCKS_LO = 1;
    uint256 public constant MIN_BLOCKS_HI = 50_400;

    /// @notice Bounds for `maxStepWei` — the absolute ETH cap on a single
    ///         step's swap. Default 1 ETH keeps per-step price impact small
    ///         on the 111/ETH pool. Admin-tunable within these bounds.
    uint256 public constant MAX_STEP_WEI_LO = 0.01 ether;
    uint256 public constant MAX_STEP_WEI_HI = 10 ether;

    /// @notice Per-call price-impact cap applied through V4's
    ///         `sqrtPriceLimitX96`. Set below the canonical pool's round-trip
    ///         fee moat so a permissionless burn step can't move price enough
    ///         to pay for a sandwicher's buy/sell round trip. At launch the
    ///         moat is ~13% round trip: the hook's 6% baseline skim fires
    ///         symmetrically on BOTH legs of a sandwich (≈12%), plus 0.5% LP
    ///         each way (≈1%). The SKIM — not the LP fee — dominates the moat,
    ///         so this 5% cap stays safe only while the baseline skim does: if
    ///         the skim were ever lowered (or this burner pointed at a low-skim
    ///         pool) the cap would have to drop with it. V4 partial-fills when
    ///         the limit binds, leaving unspent ETH queued for later blocks.
    uint256 public constant maxSlippageBps = 500;

    // Set at construct.

    /// @notice V4 singleton PoolManager.
    IPoolManager public immutable poolManager;
    /// @notice Time-locked admin (1y auto-lock). Gates all setters here.
    ProtocolAdmin public immutable adminContract;
    /// @notice V4 pool fee. May be a dynamic fee sentinel — the swap reads
    ///         fees from the hook at runtime.
    uint24 public immutable poolFee;
    /// @notice V4 pool tick spacing. Permanently bound to the launch pool.
    int24 public immutable poolTickSpacing;

    // Tunable parameters (admin-settable until the 1y lock).
    uint256 public minBlocksBetweenSteps;
    uint256 public maxStepWei;

    // ─── Slippage-guard design ───
    //
    // `executeStep` is PERMISSIONLESS and spends PROTOCOL ETH, not the
    // caller's. A caller-supplied `minOut` alone can't be trusted, because a
    // griefer who is the LP on the other side would pass a loose `minOut` to
    // sandwich the protocol's own burn. The objective guard is therefore the
    // pool's own price-impact limit: the burner never pushes the V4 pool far
    // enough in one call to make a buy/sell sandwich worth its round-trip fees.
    //
    // A static tokens-per-ETH floor is deliberately NOT used: for
    // an appreciating ETH→111 pool it only tightens as 111 rises and would
    // brick buy-and-burn exactly when the protocol is working.

    // Set in one-time setup.

    /// @notice 111 token address. Wired post-factory via `setup`. Burned via
    ///         `IERC20Burnable.burn` after each successful swap.
    address public token;
    /// @notice V4 hook address (the artcoins static-fee-V2 hook). Used in
    ///         the `PoolKey`. Wired post-factory via `setup`.
    address public hook;

    /// @notice ETH queued for swap+burn. Receives all inbound ETH via
    ///         `receive`. Decremented by each step's full draw, then
    ///         re-credited on the rare path where the keeper reward send
    ///         fails (see `executeStep` / `ExecutionRewardFailed`).
    uint256 public remainingEth;
    /// @notice `block.number` of the most recent `executeStep`. Used with
    ///         `minBlocksBetweenSteps` to pace.
    uint256 public lastStepBlock;
    /// @notice Monotonic counter — total ETH ever spent on swaps (excludes
    ///         keeper-reward share).
    uint256 public totalEthBurned;
    /// @notice Monotonic counter — total 111 ever delivered to `burn`.
    uint256 public totalTokensBurned;

    modifier onlyAdmin() {
        if (!adminContract.checkAdmin(msg.sender)) revert NotAdmin();
        _;
    }

    constructor(
        address _poolManager,
        uint24 _poolFee,
        int24 _tickSpacing,
        uint256 _minBlocks,
        uint256 _maxStepWei,
        address _adminContract,
        address _swapContext
    ) OneTimeSetup() PCNoReentry(_swapContext) {
        require(_poolManager != address(0), "BB: zero poolManager");
        require(_adminContract != address(0), "BB: zero admin");
        require(_minBlocks >= MIN_BLOCKS_LO && _minBlocks <= MIN_BLOCKS_HI, "BB: bad minBlocks");
        require(_maxStepWei >= MAX_STEP_WEI_LO && _maxStepWei <= MAX_STEP_WEI_HI, "BB: bad maxStepWei");
        poolManager = IPoolManager(_poolManager);
        adminContract = ProtocolAdmin(_adminContract);
        poolFee = _poolFee;
        poolTickSpacing = _tickSpacing;
        minBlocksBetweenSteps = _minBlocks;
        maxStepWei = _maxStepWei;
    }

    /// @notice Pace setter — minimum block delta between `executeStep` calls.
    /// @dev    Bounded by `MIN_BLOCKS_LO`..`MIN_BLOCKS_HI`. Lower = faster
    ///         burn cadence. Locks at the 1y admin expiry.
    function setMinBlocksBetweenSteps(uint256 newValue) external onlyAdmin {
        if (newValue < MIN_BLOCKS_LO || newValue > MIN_BLOCKS_HI) {
            revert OutOfBounds(newValue, MIN_BLOCKS_LO, MIN_BLOCKS_HI);
        }
        uint256 old = minBlocksBetweenSteps;
        minBlocksBetweenSteps = newValue;
        emit ParameterChanged("minBlocksBetweenSteps", old, newValue);
    }

    /// @notice Per-step ETH ceiling — caps the ETH spent on a single swap.
    /// @dev    Bounded by `MAX_STEP_WEI_LO`..`MAX_STEP_WEI_HI`. Acts as a
    ///         soft price-impact guard alongside `maxSlippageBps`.
    function setMaxStepWei(uint256 newValue) external onlyAdmin {
        if (newValue < MAX_STEP_WEI_LO || newValue > MAX_STEP_WEI_HI) {
            revert OutOfBounds(newValue, MAX_STEP_WEI_LO, MAX_STEP_WEI_HI);
        }
        uint256 old = maxStepWei;
        maxStepWei = newValue;
        emit ParameterChanged("maxStepWei", old, newValue);
    }

    // There is no `maxSlippageBps` setter: it is the compile-time
    // price-impact guard. Keeping it immutable avoids a post-launch
    // configuration mistake that would make the burner sandwichable.
    //
    // There is no static tokens-per-ETH floor: it's the wrong shape for an
    // appreciating ETH→111 pool — it only tightens as 111 rises
    // and would brick buy-and-burn.

    /// @notice One-shot wiring of `token` (111) and `hook` (artcoins static-
    ///         fee hook). Callable by the deployer once before
    ///         `OneTimeSetup` finalization.
    function setup(address _token, address _hook) external onlySetup {
        require(_token != address(0) && _hook != address(0), "BB: zero");
        token = _token;
        hook = _hook;
        _markFinalized();
    }

    /// @notice Accept ETH from any source. Inflows are credited to
    ///         `remainingEth` and queued for the next `executeStep`.
    receive() external payable {
        remainingEth += msg.value;
        emit BurnEthDeposited(msg.sender, msg.value, remainingEth);
    }

    /// @notice Permissionless. Burns up to `maxStepWei` of queued ETH worth
    ///         of 111 in a single V4 swap. Caller earns a small ETH reward.
    /// @dev    Slippage protection is intentionally simple:
    ///         1. `sqrtPriceLimitX96` caps per-call price impact at
    ///            `maxSlippageBps` (5%). If the pool would move past that
    ///            bound, V4 partial-fills the swap — fewer tokens are burned,
    ///            and the unspent ETH stays queued.
    ///         2. Post-swap check: `received >= callerMinOut`.
    ///         3. On a partial fill, the caller's reward is pro-rated to the
    ///            ETH actually consumed, so a thin-pool clamp doesn't let
    ///            keepers extract the full reward for a tiny burn.
    ///
    ///         The `notInSwap` decoration is the dormant Design-B reentrancy
    ///         seam (`PCSwapContext.inSwap` is permanently false at launch, so
    ///         the modifier is a no-op until a synchronous extension is ever
    ///         bound). For `executeStep` it is belt-and-suspenders: the burn
    ///         swap runs inside `poolManager.unlock`, and V4 forbids a nested
    ///         unlock, so a callback firing during another swap's `afterSwap`
    ///         could never re-enter this function regardless of the seam.
    function executeStep(uint256 minOut) external notInSwap {
        uint256 next = lastStepBlock + minBlocksBetweenSteps;
        if (block.number < next) revert StepTooEarly(next);
        uint256 step = remainingEth < maxStepWei ? remainingEth : maxStepWei;
        if (step == 0) revert NothingToBurn();

        // Compute permissionless-execution reward. Deducted from the step
        // before the swap so callers earn gas back without distorting the
        // burn rate. Bounded by both a bps cap and a fixed-wei cap.
        uint256 reward = (step * EXEC_REWARD_BPS) / 10_000;
        if (reward > EXEC_REWARD_CAP) reward = EXEC_REWARD_CAP;
        if (reward >= step) reward = 0; // pathological tiny-step guard
        uint256 swapAmount = step - reward;

        lastStepBlock = block.number;

        // Pass only `swapAmount` into the callback. The post-swap output
        // check runs here against the actual `ethSpent` (not inside
        // `unlockCallback` against the requested minOut) so partial
        // fills succeed and the unspent ETH stays queued.
        bytes memory data = abi.encode(swapAmount);
        bytes memory result = poolManager.unlock(data);
        (uint256 received, uint256 ethSpent) = abi.decode(result, (uint256, uint256));

        // Defense-in-depth: `unlockCallback` already caps `ethOut <= step`,
        // but we re-assert here so the keeper-reward pro-rate can never
        // exceed `reward` even if the inner check is ever bypassed.
        if (ethSpent > swapAmount) revert ExcessInputSpent(ethSpent, swapAmount);

        // Post-swap output check against the caller's `minOut`. The fixed
        // price-impact cap is the protocol-level sandwich guard; caller
        // `minOut` is still useful for keepers that want an even stricter
        // per-call bound.
        if (received < minOut) revert InsufficientOutput(received, minOut);

        // Reconcile against a partial fill (sqrtPriceLimitX96 clamping). The
        // unspent ETH is still on this contract — it never left to the pool.
        // Pro-rate the reward to the actual spend so a 1%-fill caller doesn't
        // earn the full reward for a tiny burn. Unused ETH (incl. unpaid
        // reward) stays queued in `remainingEth` for the next step.
        uint256 actualReward = ethSpent == swapAmount
            ? reward
            : (reward * ethSpent) / swapAmount;

        // Debit `ethSpent` from the queue eagerly (it left to the pool).
        // The reward stays credited until we know it's been sent — flipping
        // the order eliminates the post-call state write Slither flags as
        // `reentrancy-eth`. Failure path is a no-op on `remainingEth`,
        // which matches the documented semantics ("reward ETH stays here").
        remainingEth -= ethSpent;
        totalEthBurned += ethSpent;
        totalTokensBurned += received;
        IERC20Burnable(token).burn(received);

        emit TokensBurned(ethSpent, received, remainingEth);

        if (actualReward > 0) {
            // Pre-debit the reward before the call. On success, we're done.
            // On failure, re-credit so the ETH stays queued for the next
            // step. A reentrant caller during the failed-send path cannot
            // observe the re-credited state: `ok=false` means the recipient's
            // receive() reverted, and a reverted callback unwinds all
            // intermediate state — there's no window where a reentrant call
            // sees `remainingEth` after the re-credit. Pacing
            // (`lastStepBlock == block.number`) also blocks any reentrant
            // `executeStep`. The re-credit on the failure path is therefore
            // safe; Slither's `reentrancy-eth` flag here is informational.
            remainingEth -= actualReward;
            // slither-disable-next-line reentrancy-eth
            (bool ok,) = msg.sender.call{value: actualReward}("");
            if (ok) {
                emit ExecutionRewardPaid(msg.sender, actualReward);
            } else {
                // Burn already happened — do NOT revert. Credit the unsent
                // reward back so accounting tracks `address(this).balance`.
                remainingEth += actualReward;
                emit ExecutionRewardFailed(msg.sender, actualReward);
            }
        }
    }

    /// @notice V4 unlock callback. Called by `PoolManager.unlock` during
    ///         `executeStep`. Performs the exact-input swap with the
    ///         narrowed `sqrtPriceLimitX96`, settles the ETH side with
    ///         native value (no WETH wrap), and takes the token side.
    /// @dev    Restricted to `PoolManager` — anyone can call this entry
    ///         point on-chain but the `msg.sender == address(poolManager)`
    ///         check above causes a revert from any other caller. The V4
    ///         architecture relies on this pattern: PoolManager is the
    ///         only address that should ever invoke an unlock callback.
    ///
    ///         The swap is always zeroForOne because native ETH = address(0)
    ///         = currency0 (lowest possible address sorts first). Negative
    ///         `amountSpecified` is "exact input" semantics — V4 consumes
    ///         AT MOST `step` of ETH; less is acceptable (partial fill
    ///         from a sqrtPriceLimit clamp). The post-call assertion
    ///         `ethOut <= step` defends against a misbehaving hook with
    ///         `beforeSwapReturnDelta` / `afterSwapReturnDelta`
    ///         permissions that could in principle return a delta
    ///         indicating more input consumed than asked for.
    ///
    ///         The caller's `minOut` is NOT enforced here — that check
    ///         lives in `executeStep` so partial fills don't
    ///         spuriously revert. Here we just settle and report back.
    /// @param  data abi-encoded `(uint256 swapAmount)` — the exact-input
    ///         cap passed in by `executeStep`.
    /// @return abi-encoded `(uint256 pctIn, uint256 ethSpent)` — the
    ///         tokens received and the ETH actually consumed (which may
    ///         be less than `swapAmount` on a partial fill).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 step = abi.decode(data, (uint256));

        PoolKey memory key = _poolKey();
        // Native ETH is `address(0)` — always sorts as token0 (lowest possible
        // address), so the burn swap is always zeroForOne (ETH in, token out).

        // Narrow sqrtPriceLimitX96 to the per-call price-impact bound. Linear
        // approximation: sqrt(1 - x) ~= 1 - x/2, so a `bps` price tolerance
        // becomes a `bps/2`-equivalent sqrtPrice tolerance, implemented as
        // `(20000 - slippageBps) / 20000`. At 500 bps this is very close to
        // the exact sqrt(0.95) limit and safely below the measured fee moat.
        (uint160 currentSqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint256 slippageBps = maxSlippageBps;
        uint256 candidate = (uint256(currentSqrtPriceX96) * (20000 - slippageBps)) / 20000;
        uint160 sqrtPriceLimitX96 = candidate <= uint256(TickMath.MIN_SQRT_PRICE)
            ? TickMath.MIN_SQRT_PRICE + 1
            : uint160(candidate);

        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(step),
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });

        BalanceDelta delta = poolManager.swap(key, params, "");
        // ETH in (currency0, negative delta), token out (currency1, positive delta).
        int256 d0 = int256(delta.amount0());
        int256 d1 = int256(delta.amount1());
        require(d0 <= 0, "BB: bad d0");
        require(d1 >= 0, "BB: bad d1");
        uint256 ethOut = uint256(-d0);
        uint256 pctIn = uint256(d1);

        // Enforce the exact-input cap locally. `amountSpecified = -int256(step)`
        // tells V4 "consume AT MOST `step` of ETH input"; an honest pool
        // honors this. A hook with `beforeSwapReturnDelta` /
        // `afterSwapReturnDelta` permissions can return a delta that
        // indicates more input was consumed than asked for — this would
        // bypass the burner's per-step ETH cap without breaking the
        // `balance == remainingEth` invariant. Reject defensively.
        if (ethOut > step) revert ExcessInputSpent(ethOut, step);

        // Settle the ETH side with native value — no WETH wrap step.
        poolManager.settle{value: ethOut}();
        poolManager.take(Currency.wrap(token), address(this), pctIn);

        // Return (received, ethSpent) so `executeStep` can enforce caller minOut.
        return abi.encode(pctIn, ethOut);
    }

    /// @notice ETH that would be drawn by the next `executeStep` (including
    ///         the keeper-reward share). Returns `min(remainingEth, maxStepWei)`.
    function quoteStepAmount() external view returns (uint256) {
        return remainingEth < maxStepWei ? remainingEth : maxStepWei;
    }

    /// @notice Earliest block at which `executeStep` will succeed.
    function nextExecutableBlock() external view returns (uint256) {
        return lastStepBlock + minBlocksBetweenSteps;
    }

    /// @notice The V4 `PoolKey` for the burner's pool. Useful for off-chain
    ///         tooling that wants to read pool state directly.
    function poolKey() external view returns (PoolKey memory) {
        return _poolKey();
    }

    /// @dev Construct the V4 PoolKey for the burner's pool. Order matters:
    ///      `currency0 < currency1` byte-wise. Native ETH = address(0) is
    ///      always the lowest possible address so it always sorts as
    ///      currency0, with the art coin (111) as currency1. This means
    ///      every burn swap is zeroForOne (ETH in, 111 out).
    function _poolKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: poolFee,
            tickSpacing: poolTickSpacing,
            hooks: IHooks(hook)
        });
    }
}
