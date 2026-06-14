// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";

import {MockTaxVenueToken} from "./mocks/MockTaxVenueToken.sol";

interface IERC20B {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice Two-pool kit: buy/sell/add-liquidity on any V4 key, native ETH = c0,
///         token = c1. Buys can ATTEST the canonical budget before taking (the
///         canonical-equivalent pool is exempt); side-pool buys don't, so the
///         venue→trader take is taxed. The kit is set as the token's
///         `canonicalHook` so its attestation is accepted.
contract TwoPoolKit is IUnlockCallback {
    IPoolManager public immutable pm;
    MockTaxVenueToken public immutable token;
    bytes32 public canonPid;

    constructor(address _pm, address _token) {
        pm = IPoolManager(_pm);
        token = MockTaxVenueToken(_token);
    }

    receive() external payable {}

    function setCanonPid(bytes32 pid) external {
        canonPid = pid;
    }

    struct Job {
        uint8 op; // 0 buy→recipient, 1 addLiq, 2 sell(token in)→recipient
        bool attest; // (op 0) attest canonical budget for the take (exempt)
        PoolKey key;
        uint256 amtIn; // ETH for buy, token for sell
        address recipient;
        int24 tickLower;
        int24 tickUpper;
        int256 liq;
    }

    function buyTo(PoolKey calldata key, uint256 ethIn, address recipient, bool attest)
        external
        payable
        returns (uint256 grossOut)
    {
        require(msg.value == ethIn, "kit: exact ETH");
        Job memory j;
        j.op = 0;
        j.attest = attest;
        j.key = key;
        j.amtIn = ethIn;
        j.recipient = recipient;
        grossOut = abi.decode(pm.unlock(abi.encode(j)), (uint256));
    }

    function sellTo(PoolKey calldata key, uint256 tokIn, address recipient)
        external
        returns (uint256 ethOut)
    {
        Job memory j;
        j.op = 2;
        j.key = key;
        j.amtIn = tokIn;
        j.recipient = recipient;
        ethOut = abi.decode(pm.unlock(abi.encode(j)), (uint256));
    }

    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liq)
        external
        payable
    {
        Job memory j;
        j.op = 1;
        j.key = key;
        j.tickLower = tickLower;
        j.tickUpper = tickUpper;
        j.liq = liq;
        pm.unlock(abi.encode(j));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "kit: not pm");
        Job memory j = abi.decode(data, (Job));

        if (j.op == 0) {
            BalanceDelta d = pm.swap(
                j.key,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(j.amtIn),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                ""
            );
            uint256 ethSpent = uint256(uint128(-d.amount0()));
            uint256 tokenOut = uint256(uint128(d.amount1()));
            pm.settle{value: ethSpent}();
            // Canonical-equivalent buys attest the take amount so the
            // venue→trader transfer is exempt (mirrors the real hook's
            // afterSwap attestation). Side buys don't, so they're taxed.
            if (j.attest) token.attestCanonicalBudget(canonPid, tokenOut);
            pm.take(Currency.wrap(address(token)), j.recipient, tokenOut);
            return abi.encode(tokenOut);
        } else if (j.op == 1) {
            (BalanceDelta cd,) = pm.modifyLiquidity(
                j.key,
                ModifyLiquidityParams({
                    tickLower: j.tickLower,
                    tickUpper: j.tickUpper,
                    liquidityDelta: j.liq,
                    salt: bytes32(0)
                }),
                ""
            );
            int128 a0 = cd.amount0();
            int128 a1 = cd.amount1();
            if (a0 < 0) pm.settle{value: uint256(uint128(-a0))}();
            if (a1 < 0) {
                pm.sync(Currency.wrap(address(token)));
                token.transfer(address(pm), uint256(uint128(-a1)));
                pm.settle();
            }
            return "";
        } else {
            BalanceDelta d = pm.swap(
                j.key,
                SwapParams({
                    zeroForOne: false,
                    amountSpecified: -int256(j.amtIn),
                    sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            uint256 tokSpent = uint256(uint128(-d.amount1()));
            uint256 ethRecv = uint256(uint128(d.amount0()));
            pm.sync(Currency.wrap(address(token)));
            token.transfer(address(pm), tokSpent);
            pm.settle();
            pm.take(Currency.wrap(address(0)), j.recipient, ethRecv);
            return abi.encode(ethRecv);
        }
    }
}

/// @title  SidePoolTaxSweep — Phase 1, Track B (variable side tax 5–25%)
/// @notice Standalone fork harness answering the headline question the
///         production token's 5% cap blocks: at what side-pool buy tax does
///         canonical become the best route for BOTH buys and sells?
///
///         Uses a cap-parametrized double (`MockTaxVenueToken`) whose tax logic
///         is copied byte-for-byte from `ArtCoinsToken`. Two hookless V4 pools on
///         the same double token:
///           - canonical-equivalent: a `CANON_FEE` static-fee pool (default 6% =
///             5% skim + 1% LP trader cost), tax-EXEMPT via attestation, seeded
///             DEEP (canonical dominates depth in reality);
///           - side: `SIDE_FEE` static-fee pool (default 0.3%), TAXED at the swept
///             rate, seeded shallower at a controlled price discount.
///
///         The canonical-equivalent's flat fee faithfully reproduces the
///         trader-FACING canonical cost (which is all that decides routing); the
///         bid-funding distinction (canonical fee → bid vs side → burn) is
///         proven structurally in Track A. A fidelity check asserts the double at
///         5% reproduces Track A's qualitative result.
///
///         Run:
///           MAINNET_RPC_URL=https://gateway.tenderly.co/public/mainnet \
///           forge test --match-contract SidePoolTaxSweep -vv
contract SidePoolTaxSweepTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Canonical-equivalent trader cost = 5% skim + LP fee. Default 6% (1% LP).
    uint24 internal constant CANON_FEE = 60_000; // 6.0% in pips (1e6 = 100%)
    int24 internal constant CANON_TS = 200;
    // Side pool LP fee. Default 0.3% (the worst case — V2 / V3-0.3% tier).
    uint24 internal constant SIDE_FEE = 3_000; // 0.3%
    int24 internal constant SIDE_TS = 60;
    int24 internal constant SIDE_HALF = 10_000;

    MockTaxVenueToken internal tok;
    TwoPoolKit internal kit;
    PoolKey internal canonKey;
    bytes32 internal canonPid;

    address internal trader = address(0x7AaAAAAd);
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    // Tax rates to sweep (bps): 5, 10, 12.5, 15, 20, 25%.
    uint16[6] internal TAXES = [500, 1000, 1250, 1500, 2000, 2500];
    // Positive = side cheaper (discount); we also probe a small premium band.
    int16[8] internal DISCOUNTS = [-250, 0, 250, 500, 750, 1000, 1250, 1500];

    function setUp() public {
        string memory rpc =
            vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(rpc);

        address[] memory exempt = new address[](0);
        // Launch the double at 5% with a generous cap so the sweep can raise it.
        tok = new MockTaxVenueToken(
            "Route Test Token", "RTT", SUPPLY, address(this), POOL_MANAGER, DEAD, 500, 5000, exempt
        );
        kit = new TwoPoolKit(POOL_MANAGER, address(tok));
        // Each test creates its canonical-equivalent pool via `_setupCanon` so
        // the fee (= canonical trader cost) can vary per config.
    }

    receive() external payable {}

    /// @dev Create + wire + deep-seed the canonical-equivalent pool at trader
    ///      cost `canonFee` (in pips: 60_000 = 6%). Re-callable inside snapshots.
    function _setupCanon(uint24 canonFee) internal {
        canonKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(tok)),
            fee: canonFee,
            tickSpacing: CANON_TS,
            hooks: IHooks(address(0))
        });
        canonPid = PoolId.unwrap(canonKey.toId());
        tok.wire(address(kit), canonPid);
        kit.setCanonPid(canonPid);
        IPoolManager(POOL_MANAGER).initialize(canonKey, TickMath.getSqrtPriceAtTick(0));
        // Seed canonical DEEP: ~1000 ETH over a wide range around 1:1.
        _seedPool(canonKey, CANON_TS, 1000 ether, 1000 ether, 0);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Seeding + price helpers
    // ─────────────────────────────────────────────────────────────────────

    function _sqrt(PoolKey memory k) internal view returns (uint160 sp) {
        (sp,,,) = IPoolManager(POOL_MANAGER).getSlot0(k.toId());
    }

    /// @dev Add a symmetric position to `key` sized from `ethDepth`, centered at
    ///      the pool's current tick. `tokenDepth` oversupplied so ETH binds.
    function _seedPool(PoolKey memory key, int24 ts, uint256 ethDepth, uint256 tokenDepth, int24 half)
        internal
    {
        uint160 sp = _sqrt(key);
        int24 cur = TickMath.getTickAtSqrtPrice(sp);
        int24 hw = half == 0 ? int24(20_000) : half;
        int24 lower = ((cur - hw) / ts) * ts;
        int24 upper = ((cur + hw) / ts) * ts;
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sp, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), ethDepth, tokenDepth
        );
        tok.transfer(address(kit), tokenDepth);
        vm.deal(address(this), address(this).balance + ethDepth);
        kit.addLiquidity{value: ethDepth}(key, lower, upper, int256(uint256(liq)));
    }

    /// @dev Initialize + seed the side pool at `discountBps` below canonical
    ///      (negative = premium). Returns the seeded key.
    function _seedSide(int16 discountBps, uint256 ethDepth, uint24 sideFee)
        internal
        returns (PoolKey memory key)
    {
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(tok)),
            fee: sideFee,
            tickSpacing: SIDE_TS,
            hooks: IHooks(address(0))
        });
        uint160 cs = _sqrt(canonKey);
        // sideSqrt = cs * sqrt(1/(1-d)); d can be negative (premium ⇒ scale down).
        int256 dSigned = int256(discountBps);
        uint256 oneMinusD = uint256(int256(1e18) - (dSigned * 1e18) / 10_000);
        uint256 invX18 = (1e18 * 1e18) / oneMinusD;
        uint256 sqrtFactorX9 = FixedPointMathLib.sqrt(invX18 * 1e18) / 1e9;
        uint160 sideSqrt = uint160((uint256(cs) * sqrtFactorX9) / 1e9);
        IPoolManager(POOL_MANAGER).initialize(key, sideSqrt);
        _seedPool(key, SIDE_TS, ethDepth, ethDepth * 2, SIDE_HALF);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Route primitives + comparators (snapshot-based best execution)
    // ─────────────────────────────────────────────────────────────────────

    function _canonBuy(uint256 ethIn) internal returns (uint256 out) {
        vm.deal(address(this), address(this).balance + ethIn);
        out = kit.buyTo{value: ethIn}(canonKey, ethIn, address(this), true);
    }

    function _sideBuy(PoolKey memory key, uint256 ethIn) internal returns (uint256 net) {
        uint256 b = IERC20B(address(tok)).balanceOf(trader);
        vm.deal(address(this), address(this).balance + ethIn);
        kit.buyTo{value: ethIn}(key, ethIn, trader, false);
        net = IERC20B(address(tok)).balanceOf(trader) - b;
    }

    function _canonSell(uint256 tokIn) internal returns (uint256 ethOut) {
        tok.transfer(address(kit), tokIn);
        ethOut = kit.sellTo(canonKey, tokIn, address(this));
    }

    function _sideSell(PoolKey memory key, uint256 tokIn) internal returns (uint256 ethOut) {
        tok.transfer(address(kit), tokIn);
        ethOut = kit.sellTo(key, tokIn, address(this));
    }

    function _bestBuy(PoolKey memory key, uint256 ethIn)
        internal
        returns (uint256 canonOut, uint256 sideOut, uint256 burned)
    {
        uint256 s1 = vm.snapshotState();
        canonOut = _canonBuy(ethIn);
        vm.revertToState(s1);
        uint256 s2 = vm.snapshotState();
        uint256 d0 = IERC20B(address(tok)).balanceOf(DEAD);
        sideOut = _sideBuy(key, ethIn);
        burned = IERC20B(address(tok)).balanceOf(DEAD) - d0;
        vm.revertToState(s2);
    }

    function _bestSell(PoolKey memory key, uint256 tokIn)
        internal
        returns (uint256 canonOut, uint256 sideOut)
    {
        uint256 s1 = vm.snapshotState();
        canonOut = _canonSell(tokIn);
        vm.revertToState(s1);
        uint256 s2 = vm.snapshotState();
        sideOut = _sideSell(key, tokIn);
        vm.revertToState(s2);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Headline sweep: tax × discount × size at 6% canonical / 0.3% side
    // ─────────────────────────────────────────────────────────────────────

    function test_taxSweep_canon6_side03() public {
        console2.log("tax_bps,canon_fee_bps,side_lp_bps,discount_bps,size_eth_milli,buy_winner,canon_pct,side_pct,sell_winner,canon_eth,side_eth,burn_side");
        _setupCanon(CANON_FEE);
        uint256[2] memory sizes = [uint256(0.1 ether), 2 ether];

        for (uint256 ti = 0; ti < TAXES.length; ti++) {
            for (uint256 di = 0; di < DISCOUNTS.length; di++) {
                for (uint256 zi = 0; zi < sizes.length; zi++) {
                    uint256 root = vm.snapshotState();
                    tok.setTaxBps(TAXES[ti]);
                    PoolKey memory key = _seedSide(DISCOUNTS[di], 40 ether, SIDE_FEE);

                    (uint256 cBuy, uint256 sBuy, uint256 burned) = _bestBuy(key, sizes[zi]);

                    uint256 sellSnap = vm.snapshotState();
                    uint256 tokForSell = _canonBuy(sizes[zi]);
                    (uint256 cSell, uint256 sSell) = _bestSell(key, tokForSell);
                    vm.revertToState(sellSnap);

                    _log(TAXES[ti], CANON_FEE, SIDE_FEE, DISCOUNTS[di], sizes[zi], cBuy, sBuy, cSell, sSell, burned);
                    vm.revertToState(root);
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Sensitivity sweep: canonical LP fee (5.5/5.75/6%) × side LP fee
    //  (0.3%/1%) × tax × discount × size. Answers Q10 (does the canonical LP
    //  fee move the router math?) and the side-LP-fee dependence that makes
    //  5% sub-parity. Same CSV schema as the headline sweep.
    // ─────────────────────────────────────────────────────────────────────

    function test_sensitivity_lpFees() public {
        console2.log("tax_bps,canon_fee_bps,side_lp_bps,discount_bps,size_eth_milli,buy_winner,canon_pct,side_pct,sell_winner,canon_eth,side_eth,burn_side");
        // canonFee in pips (55_000=5.5%, 57_500=5.75%, 60_000=6%); sideFee 0.3%/1%.
        uint24[3] memory canonFees = [uint24(55_000), 57_500, 60_000];
        uint24[2] memory sideFees = [uint24(3_000), 10_000];
        uint256[2] memory sizes = [uint256(0.1 ether), 2 ether];

        for (uint256 ci = 0; ci < canonFees.length; ci++) {
            uint256 canonSnap = vm.snapshotState();
            _setupCanon(canonFees[ci]); // once per canonical fee, not per cell
            for (uint256 fi = 0; fi < sideFees.length; fi++) {
                for (uint256 ti = 0; ti < TAXES.length; ti++) {
                    for (uint256 di = 0; di < DISCOUNTS.length; di++) {
                        for (uint256 zi = 0; zi < sizes.length; zi++) {
                            uint256 root = vm.snapshotState();
                            tok.setTaxBps(TAXES[ti]);
                            PoolKey memory key = _seedSide(DISCOUNTS[di], 40 ether, sideFees[fi]);

                            (uint256 cBuy, uint256 sBuy, uint256 burned) = _bestBuy(key, sizes[zi]);

                            uint256 sellSnap = vm.snapshotState();
                            uint256 tokForSell = _canonBuy(sizes[zi]);
                            (uint256 cSell, uint256 sSell) = _bestSell(key, tokForSell);
                            vm.revertToState(sellSnap);

                            _log(
                                TAXES[ti], canonFees[ci], sideFees[fi], DISCOUNTS[di], sizes[zi],
                                cBuy, sBuy, cSell, sSell, burned
                            );
                            vm.revertToState(root);
                        }
                    }
                }
            }
            vm.revertToState(canonSnap);
        }
    }

    function _log(
        uint16 tax,
        uint24 canonFee,
        uint24 sideFee,
        int16 disc,
        uint256 sizeEth,
        uint256 cBuy,
        uint256 sBuy,
        uint256 cSell,
        uint256 sSell,
        uint256 burned
    ) internal view {
        console2.log(
            string.concat(
                vm.toString(uint256(tax)),
                ",",
                vm.toString(uint256(canonFee) / 10),
                ",",
                vm.toString(uint256(sideFee) / 10),
                ",",
                _i(disc),
                ",",
                vm.toString(sizeEth / 1e15),
                ",",
                cBuy >= sBuy ? "CANON" : "SIDE",
                ",",
                vm.toString(cBuy),
                ",",
                vm.toString(sBuy),
                ",",
                cSell >= sSell ? "CANON" : "SIDE",
                ",",
                vm.toString(cSell),
                ",",
                vm.toString(sSell),
                ",",
                vm.toString(burned)
            )
        );
    }

    function _i(int16 v) internal view returns (string memory) {
        return v < 0 ? string.concat("-", vm.toString(uint256(uint16(-v)))) : vm.toString(uint256(uint16(v)));
    }
}
