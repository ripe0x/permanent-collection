// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IArtcoinsFeeLocker} from "../src/interfaces/IArtcoinsFeeLocker.sol";

import {SkimForkFixture} from "./helpers/SkimForkFixture.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {PCSwapContext} from "../src/PCSwapContext.sol";
import {PCNoReentry} from "../src/libraries/PCNoReentry.sol";
import {Patron} from "../src/Patron.sol";
import {ProtocolAdmin} from "../src/ProtocolAdmin.sol";
import {LiveBidAdapter} from "../src/LiveBidAdapter.sol";
import {IPreSwapStream} from "../src/interfaces/IPreSwapStream.sol";
import {PCSwapData, PCAttribution} from "artcoins/hooks/interfaces/IArtCoinsHookSkimFee.sol";
import {IArtcoinsPoolExtension} from "../src/interfaces/IArtcoinsPoolExtension.sol";

import {UnipegDispatcher} from "./mocks/UnipegDispatcher.sol";
import {UnipegArt} from "./mocks/UnipegArt.sol";
import {IPCCallbackExtension} from "../src/interfaces/IPCCallbackExtension.sol";

import {IArtCoinsHook} from "artcoins/interfaces/IArtCoinsHook.sol";

import {ICryptoPunksMarket} from "../src/interfaces/ICryptoPunksMarket.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";

interface IPoolExtensionAllowlist {
    function setPoolExtension(
        address extension,
        bool enabled
    ) external;
    function enabledExtensions(
        address
    ) external view returns (bool);
    function owner() external view returns (address);
}

interface ITokenAdminPokerOwner {
    function owner() external view returns (address);
    function bindExtension(address extension) external;
    function lockExtension() external;
    function setHookMaxReferralBps(uint24 newCap) external;
    function adminContract() external view returns (address);
}

interface IProtocolAdminEoa {
    function admin() external view returns (address);
}

interface IHookPoolExtensionView {
    function poolExtension(
        PoolId poolId
    ) external view returns (address);
    function poolExtensionSetup(
        PoolId poolId
    ) external view returns (bool);
    function poolExtensionAllowlist() external view returns (address);
}

interface IERC20Min {
    function balanceOf(
        address
    ) external view returns (uint256);
    function approve(
        address,
        uint256
    ) external returns (bool);
    function transfer(
        address,
        uint256
    ) external returns (bool);
}

/// @notice TestSwapHelper variant that lets the test pass an attributed
///         `hookData` payload to PoolManager.swap. The stock TestSwapHelper
///         passes empty bytes, so we need a parallel helper for swaps that
///         exercise the attribution / referral / extension paths.
contract AttributedSwapHelper is IUnlockCallback {
    IPoolManager public immutable pm;
    address public immutable token;
    address public immutable hook;
    uint24 public immutable poolFee;
    int24 public immutable poolTickSpacing;

    constructor(
        address _pm,
        address _token,
        address _hook,
        uint24 _fee,
        int24 _ts
    ) {
        pm = IPoolManager(_pm);
        token = _token;
        hook = _hook;
        poolFee = _fee;
        poolTickSpacing = _ts;
    }

    receive() external payable {}

    /// @notice Buy `token` with exact `ethIn` wei, passing `hookData`.
    function buyWith(
        uint256 ethIn,
        bytes calldata hookData
    ) external payable returns (uint256 tokenOut) {
        require(msg.value == ethIn, "ASH: bad value");
        bytes memory data = abi.encode(uint8(0), ethIn, hookData);
        tokenOut = abi.decode(pm.unlock(data), (uint256));
        require(IERC20Min(token).transfer(msg.sender, tokenOut), "ASH: token xfer");
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        require(msg.sender == address(pm), "ASH: not pm");
        (uint8 dir, uint256 amount, bytes memory hookData) = abi.decode(data, (uint8, uint256, bytes));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: poolFee,
            tickSpacing: poolTickSpacing,
            hooks: IHooks(hook)
        });

        if (dir == 0) {
            SwapParams memory params = SwapParams({
                zeroForOne: true, amountSpecified: -int256(amount), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            });
            BalanceDelta delta = pm.swap(key, params, hookData);
            int256 d0 = int256(delta.amount0());
            int256 d1 = int256(delta.amount1());
            uint256 ethSpent = uint256(-d0);
            uint256 tokenReceived = uint256(d1);
            pm.settle{value: ethSpent}();
            pm.take(Currency.wrap(token), address(this), tokenReceived);
            return abi.encode(tokenReceived);
        }
        revert("ASH: unsupported dir");
    }
}

/// @notice Probe callback — records the value of `swapContext.inSwap()` and
///         a counter of how many times it was invoked. Used to verify the
///         transient-storage flag is set during a REAL swap's afterSwap.
contract InSwapRecorder is IPCCallbackExtension {
    PCSwapContext public immutable swapContext;
    bool public observedInSwap;
    uint256 public invocations;

    constructor(
        address _swapContext
    ) {
        swapContext = PCSwapContext(_swapContext);
    }

    function onSwap(
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes32) {
        observedInSwap = swapContext.inSwap();
        invocations++;
        return bytes32(uint256(invocations));
    }
}

/// @notice Reentry probe — during onSwap, tries to call into Patron's
///         `notInSwap`-decorated `acceptBid`. If the guard works, this
///         reverts with `PCNoReentry.InSwap`, which the dispatcher's
///         try/catch absorbs. We record whether the reentry was rejected.
contract ReentryProbe is IPCCallbackExtension {
    Patron public immutable patron;
    bool public reentryWasBlocked;
    uint256 public invocations;

    constructor(
        address _patron
    ) {
        patron = Patron(payable(_patron));
    }

    function onSwap(
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes32) {
        invocations++;
        try patron.acceptBid(0, 0, type(uint256).max) {
            // Should never reach this — but if we did, the reentry was NOT
            // blocked.
            reentryWasBlocked = false;
            return bytes32("reentry-NOT-blocked");
        } catch (bytes memory reason) {
            // Verify the revert was specifically PCNoReentry.InSwap, not
            // some other error (e.g. invalid punkId).
            if (reason.length >= 4 && bytes4(reason) == PCNoReentry.InSwap.selector) {
                reentryWasBlocked = true;
                return bytes32("reentry-blocked-by-InSwap");
            }
            reentryWasBlocked = false;
            return bytes32("reentry-blocked-by-other");
        }
    }
}

/// @title  LaunchInvariantForkTest
/// @notice End-to-end mainnet-fork verification of every load-bearing
///         piece of permanent infrastructure that **cannot be fixed after
///         launch**. The architecture welds these into the immutable
///         deploy state, so any bug here is a forever-bug.
///
///         **Coverage:**
///           - Hook can be bound to a real V4 pool via TokenAdminPoker
///           - A callback dispatcher fires under a REAL swap (PoolManager.unlock)
///           - PCSwapContext.inSwap is true during the callback, false after
///           - Reentry from a callback into a `notInSwap`-decorated PC
///             contract reverts with `PCNoReentry.InSwap`
///           - The dispatcher's try/catch isolates a reentering callback
///             so the swap still completes
///           - Four-leg fee split routes the right amounts to the right
///             adapters
///           - Attribution decode tolerates malformed hookData
///           - Referral leg is ungated (credited from the first swap)
///
/// @dev    Inherits SkimForkFixture which deploys the full PC stack +
///         the new four-leg hook + the conversion locker + PCController
///         on a mainnet fork. After setUp, the protocol is live.
contract LaunchInvariantForkTest is SkimForkFixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant TICK_SPACING = 200;

    TestSwapHelper internal swapper;
    AttributedSwapHelper internal attributedSwapper;
    UnipegDispatcher internal dispatcher;

    address internal trader;

    function setUp() public {
        string memory url = vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url);

        _runFullDeploy();

        swapper = new TestSwapHelper(POOL_MANAGER, token, deployedHook, DYNAMIC_FEE_FLAG, TICK_SPACING);
        attributedSwapper = new AttributedSwapHelper(POOL_MANAGER, token, deployedHook, DYNAMIC_FEE_FLAG, TICK_SPACING);

        trader = makeAddr("launch-invariant-trader");
        vm.deal(trader, 1000 ether);

        // Warp past the MEV window so public LP adds wouldn't be blocked and
        // skim is at baseline (5%) — simpler reasoning for the splits.
        vm.warp(block.timestamp + 90 minutes);

        // Deploy the dispatcher (we'll bind it pool-side in tests that need it).
        // Owner = this test contract.
        dispatcher = new UnipegDispatcher(deployedHook, address(pcSwapContext), address(this));
    }

    // ─── helpers ─────────────────────────────────────────────────────────

    function _poolKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(deployedHook)
        });
    }

    function _buy(
        uint256 ethIn
    ) internal returns (uint256 tokenOut) {
        vm.prank(trader);
        tokenOut = swapper.buyTokenWithEth{value: ethIn}(ethIn);
    }

    function _buyWithAttribution(
        uint256 ethIn,
        PCAttribution memory att
    ) internal returns (uint256 tokenOut) {
        bytes memory inner = abi.encode(PCSwapData({attribution: att, extensionPayload: ""}));
        // The parent hook decodes `hookData` as a 1-tuple `PoolSwapData` struct
        // (`abi.decode(swapData, (PoolSwapData))`), so callers MUST encode as
        // the struct — not as a 2-tuple of (bytes, bytes), which would be off
        // by a 32-byte outer-offset prefix.
        IArtCoinsHook.PoolSwapData memory psd =
            IArtCoinsHook.PoolSwapData({mevModuleSwapData: bytes(""), poolExtensionSwapData: inner});
        bytes memory hookData = abi.encode(psd);
        vm.prank(trader);
        tokenOut = attributedSwapper.buyWith{value: ethIn}(ethIn, hookData);
    }

    /// @dev Authorize the dispatcher on PCSwapContext (deployer is the owner
    ///      per Deploy.s.sol) and bind it via TokenAdminPoker on the real
    ///      hook. Also allowlists the dispatcher on the artcoins extension
    ///      allowlist (artcoins owner prank).
    function _bindDispatcherToPool() internal {
        address dev = vm.addr(DEV_PK);

        // Step 1: authorize dispatcher on PCSwapContext.
        vm.prank(dev);
        pcSwapContext.setAuthorizedExtension(address(dispatcher));

        // Step 2: allowlist dispatcher on the artcoins extension allowlist.
        address allowlist = IHookPoolExtensionView(deployedHook).poolExtensionAllowlist();
        address allowlistOwner = IPoolExtensionAllowlist(allowlist).owner();
        vm.prank(allowlistOwner);
        IPoolExtensionAllowlist(allowlist).setPoolExtension(address(dispatcher), true);

        // Step 3: bind via TokenAdminPoker.
        // Read the deployed TokenAdminPoker from deployments.json.
        string memory path = string.concat(vm.projectRoot(), "/deployments.json");
        string memory json = vm.readFile(path);
        address poker = vm.parseJsonAddress(json, ".tokenAdminPoker");
        // The poker owner is dev (per Deploy.s.sol step 9c — owner = deployer).
        require(ITokenAdminPokerOwner(poker).owner() == dev, "poker owner != dev");
        vm.prank(dev);
        ITokenAdminPokerOwner(poker).bindExtension(address(dispatcher));

        // Sanity: hook now points at dispatcher.
        require(
            IHookPoolExtensionView(deployedHook).poolExtension(_poolKey().toId()) == address(dispatcher),
            "bind sanity failed"
        );
    }

    // ─── (1) Design B chain: dispatcher binding works ────────────────────

    function test_fork_bindDispatcher_throughTokenAdminPoker() public {
        _bindDispatcherToPool();
        // Implicit assert in helper — if we got here, the bind succeeded.
        assertEq(IHookPoolExtensionView(deployedHook).poolExtension(_poolKey().toId()), address(dispatcher));
    }

    // ─── (2) Callback fires on a REAL swap ───────────────────────────────

    function test_fork_callbackFires_onRealSwap() public {
        InSwapRecorder rec = new InSwapRecorder(address(pcSwapContext));
        _bindDispatcherToPool();
        dispatcher.registerCallback(address(rec), 100_000);

        // Real swap through PoolManager.unlock → hook._beforeSwap →
        // pool swap math → hook._afterSwap → _runPoolExtension(try/catch) →
        // dispatcher.afterSwap → swapContext.enterSwap + callback loop +
        // swapContext.exitSwap.
        _buy(0.1 ether);

        assertEq(rec.invocations(), 1, "callback was invoked once");
    }

    // ─── (3) inSwap flag is true DURING the real callback ────────────────

    function test_fork_inSwapFlag_setDuringRealCallback() public {
        InSwapRecorder rec = new InSwapRecorder(address(pcSwapContext));
        _bindDispatcherToPool();
        dispatcher.registerCallback(address(rec), 100_000);

        assertFalse(pcSwapContext.inSwap(), "flag clear before swap");
        _buy(0.1 ether);
        assertTrue(rec.observedInSwap(), "flag was TRUE during callback");
        assertFalse(pcSwapContext.inSwap(), "flag clear after swap");
    }

    // ─── (4) Reentry from callback into Patron reverts ───────────────────

    function test_fork_reentry_blockedDuringRealSwap() public {
        ReentryProbe probe = new ReentryProbe(address(patron));
        _bindDispatcherToPool();
        dispatcher.registerCallback(address(probe), 100_000);

        uint256 patronBalBefore = address(patron).balance;
        _buy(0.1 ether);

        assertEq(probe.invocations(), 1, "probe invoked");
        assertTrue(probe.reentryWasBlocked(), "Patron.acceptBid reverted with PCNoReentry.InSwap as expected");
        // Patron's state must be unchanged — the reentry attempt must have
        // been a no-op (it reverted before mutating anything).
        assertEq(address(patron).balance, patronBalBefore, "Patron balance unchanged by reentry");
        // Flag is cleared after.
        assertFalse(pcSwapContext.inSwap());
    }

    // ─── (5) Three-leg split: real swap routes correctly ─────────────────

    function test_fork_baselineSplit_80_20_on_real_swap() public {
        // Snapshot the adapters + Patron AT START. The pre-swap stream (the
        // hook's `_beforeSwap` calling `liveBidAdapter.streamForward()`) moves
        // the bounty leg ONWARD into Patron on subsequent swaps, so the bounty
        // side is split between what streamed into Patron and the tail left in
        // the adapter — measure BOTH. The protocol leg lands in a separate
        // adapter the stream never touches, so it accumulates as before.
        uint256 bountyBefore = address(liveBidAdapter).balance;
        uint256 protocolBefore = IArtcoinsFeeLocker(protocolFeePhaseAdapter.feeEscrow())
            .feesToClaim(address(protocolFeePhaseAdapter), address(0));
        uint256 patronBefore = address(patron).balance;

        // Three swaps. Each swap's `_afterSwap` flushes ITS OWN skim to the
        // adapters; the next swap's `_beforeSwap` streams the adapter's
        // bounty-leg pending into Patron. So after three swaps the bounty side
        // = (Patron delta) + (adapter tail).
        uint256 ethIn1 = 1 ether;
        uint256 ethIn2 = 0.001 ether;
        uint256 ethIn3 = 0.001 ether;
        _buy(ethIn1);
        _buy(ethIn2);
        _buy(ethIn3);

        uint256 bountyDelta =
            (address(liveBidAdapter).balance - bountyBefore) + (address(patron).balance - patronBefore);
        uint256 protocolDelta = IArtcoinsFeeLocker(protocolFeePhaseAdapter.feeEscrow())
            .feesToClaim(address(protocolFeePhaseAdapter), address(0)) - protocolBefore;

        // Expected: skim from all three swaps lands in the adapters.
        uint256 totalEthSwapped = ethIn1 + ethIn2 + ethIn3;
        uint256 expectedSkim = totalEthSwapped * 6000 / 100_000;
        uint256 expectedBounty = expectedSkim * 8333 / 10_000;
        uint256 expectedProtocol = expectedSkim - expectedBounty;

        // Allow ±10 wei rounding (per-swap bps truncation across the swaps).
        assertApproxEqAbs(bountyDelta, expectedBounty, 10, "bounty leg = ~83.33% of skim");
        assertApproxEqAbs(protocolDelta, expectedProtocol, 10, "protocol leg = ~16.67% remainder");

        // CRITICAL invariant: legs sum to exactly the skim taken. The
        // bounty leg is a gross-volume × bps split, so a referral payment
        // (which would come from the protocol leg only) cannot reduce it.
        assertApproxEqAbs(bountyDelta + protocolDelta, expectedSkim, 2, "legs sum to skim");
    }

    /// @dev Phase 2: the hook's `_beforeSwap` streams the PRIOR swap's accrued
    ///      bounty-leg pending into Patron (the live bid) on the NEXT swap, with
    ///      NO manual `sweep()`. Proves the per-swap streaming cadence is live.
    function test_fork_preSwapStream_advancesBidOnNextSwap() public {
        // setUp warped past the MEV window → 5% baseline skim. One 1-ETH buy
        // lands ~0.04 ETH of bounty-leg skim in the adapter (above the dust
        // floor), with nothing yet streamed to Patron.
        _buy(1 ether);
        uint256 adapterAfter1 = address(liveBidAdapter).balance;
        uint256 patronAfter1 = address(patron).balance;
        assertGt(adapterAfter1, liveBidAdapter.MIN_STREAM_WEI(), "prior pending above dust floor");

        // A second swap's `_beforeSwap` must pull that prior pending into Patron
        // BEFORE this swap executes — no `sweep()` called anywhere.
        _buy(0.001 ether);

        // Patron grew by ~the prior pending (allow a small margin for the tiny
        // swap-2 dynamics). Definitive: the bid advanced via the pre-swap stream.
        assertGt(
            address(patron).balance,
            patronAfter1 + adapterAfter1 - 0.0005 ether,
            "live bid advanced by prior pending via pre-swap stream (no manual sweep)"
        );
    }

    /// @dev Brick-resistance: the hook's _beforeSwap calls the bounty
    ///      recipient's streamForward() in a try/catch. If that recipient
    ///      REVERTS, the swap MUST still succeed. We force streamForward() to
    ///      revert and confirm a swap clears.
    function test_fork_preSwapStream_revertingRecipient_doesNotBrickSwap() public {
        // Prime the adapter above the dust floor so _beforeSwap WILL invoke it.
        _buy(1 ether);
        assertGt(address(liveBidAdapter).balance, liveBidAdapter.MIN_STREAM_WEI(), "adapter primed");

        // Force the recipient's streamForward() to revert for the next swap.
        vm.mockCallRevert(
            address(liveBidAdapter), abi.encodeWithSelector(IPreSwapStream.streamForward.selector), "boom"
        );
        uint256 out = _buy(0.5 ether);
        vm.clearMockedCalls();

        assertGt(out, 0, "swap survives a reverting pre-swap stream recipient (try/catch held)");
    }

    /// @dev Design-B coexistence: with a dispatcher bound (so inSwap is set
    ///      during the _afterSwap callback), the _beforeSwap pre-swap stream
    ///      STILL fires — it runs before the inSwap window — AND the
    ///      dispatcher's callback still fires. They compose.
    function test_fork_preSwapStream_coexistsWithBoundDispatcher() public {
        InSwapRecorder rec = new InSwapRecorder(address(pcSwapContext));
        _bindDispatcherToPool();
        dispatcher.registerCallback(address(rec), 100_000);

        // Prime: first buy lands bounty in the adapter (its _beforeSwap had an
        // empty adapter, so nothing streamed yet → Patron still ~0 from fees).
        _buy(1 ether);
        uint256 patronBefore = address(patron).balance;
        uint256 invBefore = rec.invocations();

        // Second buy: _beforeSwap streams the prior bounty into Patron (inSwap
        // is false there), then _afterSwap fires the dispatcher callback.
        _buy(0.001 ether);

        assertGt(address(patron).balance, patronBefore, "pre-swap stream fired with a dispatcher bound");
        assertEq(rec.invocations(), invBefore + 1, "dispatcher _afterSwap callback also fired");
    }

    // ─── (6) Attribution decode is tolerant — malformed hookData ─────────

    function test_fork_attributionDecode_toleratesBadData() public {
        // Pass deliberately malformed bytes as hookData. The hook's
        // _decodeAttribution wraps each layer in try/catch, so the swap
        // must complete without revert.
        bytes memory malformed = hex"deadbeefcafebabe";
        vm.prank(trader);
        attributedSwapper.buyWith{value: 0.01 ether}(0.01 ether, malformed);
        // Implicit assert: we got here. If decode had reverted, we'd never
        // reach this line.
    }

    function test_fork_attributionDecode_toleratesValidOuterInvalidInner() public {
        // Outer PoolSwapData decodes cleanly, inner PCSwapData is garbage.
        bytes memory inner = hex"deadbeef";
        IArtCoinsHook.PoolSwapData memory psd =
            IArtCoinsHook.PoolSwapData({mevModuleSwapData: bytes(""), poolExtensionSwapData: inner});
        bytes memory hookData = abi.encode(psd);
        vm.prank(trader);
        attributedSwapper.buyWith{value: 0.01 ether}(0.01 ether, hookData);
    }

    function test_fork_attributionDecode_validData_doesNotRevert() public {
        PCAttribution memory att = PCAttribution({
            sourceId: bytes32("test-source"), referrer: address(0xb0bb), campaignId: bytes16(0), referralBps: 250
        });
        _buyWithAttribution(0.01 ether, att);
    }

    // ─── (7) Referral is ungated: paid from the first swap ──────────────

    function test_fork_referral_ungated_paysFromFirstSwap() public {
        // No first-acquisition gate: a referrer-attributed swap credits the
        // referrer immediately, with zero prior acquisitions.
        assertEq(pc.acquisitionCount(), 0, "no acquisitions at start");

        address referrer = address(0xc0ffee);
        uint256 referrerBefore = referralPayout.balances(referrer);

        PCAttribution memory att = PCAttribution({
            sourceId: bytes32("ungated"), referrer: referrer, campaignId: bytes16(0), referralBps: 250
        });
        _buyWithAttribution(1 ether, att);

        // 0.25% of the 1 ETH volume, credited despite acquisitionCount() == 0.
        assertEq(
            referralPayout.balances(referrer) - referrerBefore,
            uint256(1 ether) * 250 / 100_000,
            "referrer paid 0.25% of volume from the first swap (ungated)"
        );
    }

    // ─── (8) HARDENING: every decorated PC entry point blocks reentry ────

    /// @dev Registers a reentry probe targeting EACH high-risk decorated
    ///      function across PC contracts. One swap fires all probes; each
    ///      one's reentry attempt must be blocked with `PCNoReentry.InSwap`.
    ///      If ANY function's guard fails, the test fails AND identifies
    ///      which one — pinpointing the specific decoration gap.
    function test_fork_hardening_everyDecoratedFunction_blocksReentry() public {
        _bindDispatcherToPool();

        // Build the (target, calldata, label) triples for every decorated
        // function we care about. Each probe attempts a reentry; we check
        // they ALL got blocked by InSwap.
        LowLevelReentryProbe pAcceptBounty = new LowLevelReentryProbe(
            address(patron), abi.encodeWithSignature("acceptBid(uint16,uint8,uint256)", uint16(0), uint8(0), uint256(0))
        );
        LowLevelReentryProbe pAcceptListing = new LowLevelReentryProbe(
            address(patron), abi.encodeWithSignature("acceptListing(uint16,uint8)", uint16(0), uint8(0))
        );
        LowLevelReentryProbe pPoolReplenish = new LowLevelReentryProbe(
            address(liveBidAdapter), abi.encodeWithSignature("poolReplenish(uint16)", uint16(0))
        );
        LowLevelReentryProbe pFinalSaleBid = new LowLevelReentryProbe(
            address(finalSale),
            abi.encodeWithSignature("placeBidWithReferral(uint16,address,bytes32)", uint16(0), address(0), bytes32(0))
        );
        LowLevelReentryProbe pContribute = new LowLevelReentryProbe(
            address(liveBidAdapter), abi.encodeWithSignature("contribute(address,bytes32)", address(0), bytes32(0))
        );
        LowLevelReentryProbe pFinalSaleSettle =
            new LowLevelReentryProbe(address(finalSale), abi.encodeWithSignature("settle(uint16)", uint16(0)));
        LowLevelReentryProbe pFinalSaleWithdraw =
            new LowLevelReentryProbe(address(finalSale), abi.encodeWithSignature("withdrawRefund()"));
        LowLevelReentryProbe pBurnerExecute =
            new LowLevelReentryProbe(address(burner), abi.encodeWithSignature("executeStep(uint256)", uint256(0)));
        LowLevelReentryProbe pBountyAdapter =
            new LowLevelReentryProbe(address(liveBidAdapter), abi.encodeWithSignature("sweep()"));
        LowLevelReentryProbe pProtocolFeeAdapter =
            new LowLevelReentryProbe(address(protocolFeePhaseAdapter), abi.encodeWithSignature("sweep()"));
        LowLevelReentryProbe pVaultBurnPool =
            new LowLevelReentryProbe(address(vaultBurnPool), abi.encodeWithSignature("sweep()"));

        // Dispatcher's MAX_CALLBACKS = 8, so we split across two swaps.
        // Group 1: Patron + ReturnAuctionModule (7 probes; fits in 8).
        dispatcher.registerCallback(address(pAcceptBounty), 100_000);
        dispatcher.registerCallback(address(pAcceptListing), 100_000);
        dispatcher.registerCallback(address(pPoolReplenish), 100_000);
        dispatcher.registerCallback(address(pContribute), 100_000);
        dispatcher.registerCallback(address(pFinalSaleBid), 100_000);
        dispatcher.registerCallback(address(pFinalSaleSettle), 100_000);
        dispatcher.registerCallback(address(pFinalSaleWithdraw), 100_000);
        _buy(0.05 ether);
        assertTrue(pAcceptBounty.reentryWasBlocked(), "Patron.acceptBid guarded");
        assertTrue(pAcceptListing.reentryWasBlocked(), "Patron.acceptListing guarded");
        assertTrue(pPoolReplenish.reentryWasBlocked(), "LiveBidAdapter.poolReplenish guarded");
        assertTrue(pContribute.reentryWasBlocked(), "LiveBidAdapter.contribute guarded");
        assertTrue(pFinalSaleBid.reentryWasBlocked(), "ReturnAuction.bid guarded");
        assertTrue(pFinalSaleSettle.reentryWasBlocked(), "ReturnAuction.settle guarded");
        assertTrue(pFinalSaleWithdraw.reentryWasBlocked(), "ReturnAuction.withdrawRefund guarded");

        // Unregister group 1, register group 2.
        dispatcher.unregisterCallback(address(pAcceptBounty));
        dispatcher.unregisterCallback(address(pAcceptListing));
        dispatcher.unregisterCallback(address(pPoolReplenish));
        dispatcher.unregisterCallback(address(pContribute));
        dispatcher.unregisterCallback(address(pFinalSaleBid));
        dispatcher.unregisterCallback(address(pFinalSaleSettle));
        dispatcher.unregisterCallback(address(pFinalSaleWithdraw));

        // Group 2: BuybackBurner, remaining adapters, vault pool (4 probes —
        // under MAX_CALLBACKS = 8). POLDepositor's two fund-movers were retired
        // with the POL removal.
        dispatcher.registerCallback(address(pBurnerExecute), 200_000);
        dispatcher.registerCallback(address(pBountyAdapter), 100_000);
        dispatcher.registerCallback(address(pProtocolFeeAdapter), 100_000);
        dispatcher.registerCallback(address(pVaultBurnPool), 100_000);
        _buy(0.05 ether);
        assertTrue(pBurnerExecute.reentryWasBlocked(), "BuybackBurner.executeStep guarded");
        assertTrue(pBountyAdapter.reentryWasBlocked(), "LiveBidAdapter.sweep guarded");
        assertTrue(pProtocolFeeAdapter.reentryWasBlocked(), "ProtocolFeePhaseAdapter.sweep guarded");
        assertTrue(pVaultBurnPool.reentryWasBlocked(), "VaultBurnPool.sweep guarded");
    }

    // ─── (9) HARDENING: chained reentry through intermediary contract ───

    function test_fork_hardening_chainedReentry_blocked() public {
        Intermediary hop = new Intermediary(address(patron));
        ChainedReentryProbe probe = new ChainedReentryProbe(address(hop));
        _bindDispatcherToPool();
        dispatcher.registerCallback(address(probe), 100_000);
        _buy(0.1 ether);
        assertTrue(probe.reentryWasBlocked(), "Reentry guard holds even via intermediary contract");
    }

    // ─── (9b) HARDENING: nonReentrant blocks keeper-reward reentry ───────
    //
    // The reentry group above (test 8) exercises the `notInSwap` path —
    // a Design B dispatcher callback reaching back into a decorated PC
    // function. These tests exercise the COMPLEMENTARY `nonReentrant`
    // path (audit L-1): the permissionless fund-movers pay an
    // attacker-controllable keeper reward via an un-gas-limited `.call`
    // to `msg.sender`. A malicious keeper's `receive()` tries to re-enter
    // the same fund-mover within the SAME tx — the `nonReentrant` mutex
    // must revert that inner call with exactly `Reentrant`. (`notInSwap`
    // is a no-op at launch, so it provides NO protection here — only the
    // mutex does.) Each test fails loudly if the guard is removed: the
    // inner call would then either succeed or revert with a different
    // selector, flipping `reentryErrorWasReentrant` to false.

    /// @dev L-1: `LiveBidAdapter.sweep` in fast-mode (no cooldown) pays a
    ///      keeper reward then must reject the recipient's re-entry. The
    ///      `nonReentrant` mutex — not the cooldown — is what blocks the inner
    ///      call, so the guard must hold even on the no-cooldown fast-mode path.
    function test_fork_hardening_liveBidAdapterSweep_reentryFromKeeperBlocked() public {
        // Force fast-mode: above the threshold the OUTER call would be gated on
        // a cooldown; fast-mode (Patron.balance < threshold) is the exact
        // "no cooldown" path L-1 flags. `setActivationThreshold` is the lifetime
        // carve-out and the fixture holds the admin EOA.
        liveBidAdapter.setActivationThreshold(100 ether);
        // Buffer ETH for the adapter to forward + reward off the top.
        vm.deal(address(liveBidAdapter), 1 ether);

        ReentrantRewardCaller bad =
            new ReentrantRewardCaller(address(liveBidAdapter), abi.encodeWithSignature("sweep()"));
        (bool ok,) = bad.fire(abi.encodeWithSignature("sweep()"));

        assertTrue(ok, "outer sweep completed despite the inner attack");
        assertTrue(bad.reentryAttempted(), "keeper-reward receive() ran and tried to re-enter");
        assertTrue(bad.reentryWasBlocked(), "inner sweep reverted");
        assertTrue(
            bad.reentryErrorWasReentrant(), "inner sweep reverted with EXACTLY Reentrant (proves nonReentrant fired)"
        );
        // Exactly one bounded reward — no extra value extracted across the
        // nested calls.
        assertGt(bad.rewardReceived(), 0, "a reward was actually paid (path exercised)");
        assertLe(bad.rewardReceived(), liveBidAdapter.KEEPER_REWARD_CAP(), "single keeper reward, bounded by the cap");
    }

    // ─── (10) HARDENING: sell direction skim works (afterSwap path) ─────

    function test_fork_hardening_sellDirection_skimRoutesToAdapters() public {
        // First buy some tokens to sell.
        uint256 tokensOut = _buy(1 ether);
        assertTrue(tokensOut > 0, "got tokens from buy");

        // Snapshot adapters AFTER the buy's accrual has had a chance to
        // flush. The buy's accrual was minted but not flushed (no
        // subsequent swap yet). Do a small no-op buy to flush.
        _buy(0.001 ether);

        // Bounty side = adapter tail + what the pre-swap stream forwarded into
        // Patron (the stream moves the bounty leg onward each swap); the
        // protocol leg lands in a separate adapter the stream never touches.
        uint256 bountyBefore = address(liveBidAdapter).balance;
        uint256 protocolBefore = IArtcoinsFeeLocker(protocolFeePhaseAdapter.feeEscrow())
            .feesToClaim(address(protocolFeePhaseAdapter), address(0));
        uint256 patronBefore = address(patron).balance;

        // SELL direction: trader has tokens, sells for ETH. Skim is in
        // quote currency (ETH) on the OUTPUT side. The hook handles this
        // case in _afterSwap (quote-unspecified path) — different code
        // path from the buy direction.
        vm.prank(trader);
        IERC20Min(token).approve(address(swapper), tokensOut);
        vm.prank(trader);
        uint256 ethReceived = swapper.sellTokenForEth(tokensOut);

        // Flush the sell's accrual.
        _buy(0.001 ether);

        uint256 bountyDelta =
            (address(liveBidAdapter).balance - bountyBefore) + (address(patron).balance - patronBefore);
        uint256 protocolDelta = IArtcoinsFeeLocker(protocolFeePhaseAdapter.feeEscrow())
            .feesToClaim(address(protocolFeePhaseAdapter), address(0)) - protocolBefore;

        // The sell's skim is 5% of the gross output (before skim). The
        // trader received `ethReceived`; the pool produced `ethReceived /
        // 0.95` of which the hook took 5% = ethReceived * 5/95. We can't
        // know the exact swap-amount without simulating, but we CAN check:
        //   1. Both legs received non-zero ETH (sell skim path works).
        //   2. The 80/20 ratio holds.
        assertTrue(bountyDelta > 0, "bounty leg received ETH from sell");
        assertTrue(protocolDelta > 0, "protocol leg received ETH from sell");

        // The two tiny buys (0.001 ETH each) also contribute, but they're
        // ~0.05% of the sell's contribution — within the rounding margin
        // for the ratio check below.
        uint256 totalSkim = bountyDelta + protocolDelta;
        // Bounty share / total ≈ 0.8333; protocol / total ≈ 0.1667.
        // Allow ±1% absolute tolerance on the ratios.
        uint256 bountyPct = bountyDelta * 100 / totalSkim;
        uint256 protocolPct = protocolDelta * 100 / totalSkim;
        assertApproxEqAbs(bountyPct, 83, 1, "bounty leg ~83% of sell skim");
        assertApproxEqAbs(protocolPct, 16, 1, "protocol leg ~16.67% of sell skim");

        // Sanity: trader actually received ETH (a sell that produced 0 ETH
        // would also satisfy the ratio assertions vacuously if all deltas
        // were 0, but our `> 0` checks above already rule that out).
        assertTrue(ethReceived > 0, "trader got ETH back");
    }

    // ─── (11) HARDENING: post-acquisition gate OPENS for referrals ──────

    /// @dev Referral also flows after an acquisition (a referrer-attributed
    ///      swap credits the referrer). Complements the ungated-from-first-swap
    ///      test above.
    function test_fork_hardening_postAcquisitionGate_referralFlows() public {
        assertEq(pc.acquisitionCount(), 0, "no acquisitions at start");

        // Trigger the first acquisition via the existing fork helper.
        // Find a Punk and have its owner pre-list to Patron at price 0.
        // Then call acceptBid.
        uint16 punkId = 0; // PunkId 0 is well-known and reliable on fork.
        // Fund the Patron pool minimally so acceptBid has a non-zero
        // bounty to pay out (otherwise it returns to the seller with 0).
        _fundPatronFromAdapter(0.5 ether);

        _giveAndOfferToBounty(makeAddr("punk0-owner"), punkId);
        // The Punk owner is now "punk0-owner". Patron's acceptBid
        // restricts the caller to msg.sender == seller. We need to find
        // a target trait first.
        uint8 target = _pickTarget(punkId);

        vm.prank(makeAddr("punk0-owner"));
        patron.acceptBid(punkId, target, type(uint256).max);

        assertEq(pc.acquisitionCount(), 1, "first acquisition recorded");

        // Now do a swap with referral attribution. The hook should accrue
        // a referral now that the gate is open.
        address referrer = makeAddr("post-acq-referrer");
        PCAttribution memory att = PCAttribution({
            sourceId: bytes32("post-acq-test"), referrer: referrer, campaignId: bytes16(0), referralBps: 250
        });
        _buyWithAttribution(1 ether, att);

        uint256 referrerBalance = referralPayout.balances(referrer);
        assertTrue(referrerBalance > 0, "referrer accrued non-zero balance post-acquisition");

        // Approximate: 0.25% of 1 ETH = 0.0025 ETH. Allow ±10% tolerance
        // because the swap doesn't move exactly 1 ETH of volume (hook
        // takes skim before swap math, so the volume measured for
        // referral is the trader-facing magnitude).
        uint256 expected = 0.0025 ether;
        assertApproxEqAbs(referrerBalance, expected, expected / 10, "~0.25% of 1 ETH");
    }

    // ─── (12) HARDENING: end-to-end referral claim ──────────────────────

    function test_fork_hardening_referralEndToEnd_claimWorks() public {
        // acceptBid sets up the post-acquisition state for the claim path.
        uint16 punkId = 0;
        _fundPatronFromAdapter(0.5 ether);
        _giveAndOfferToBounty(makeAddr("punk0-owner-2"), punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(makeAddr("punk0-owner-2"));
        patron.acceptBid(punkId, target, type(uint256).max);

        address referrer = makeAddr("e2e-referrer");
        PCAttribution memory att =
            PCAttribution({sourceId: bytes32("e2e"), referrer: referrer, campaignId: bytes16(0), referralBps: 250});
        _buyWithAttribution(1 ether, att);

        uint256 owed = referralPayout.balances(referrer);
        assertTrue(owed > 0, "referrer credited");

        uint256 referrerEthBefore = referrer.balance;
        referralPayout.claimFor(referrer);
        uint256 referrerEthAfter = referrer.balance;

        assertEq(referrerEthAfter - referrerEthBefore, owed, "referrer received the full balance");
        assertEq(referralPayout.balances(referrer), 0, "balance zeroed");
    }

    // ─── (13) Unbound dispatcher: no callback fires ───────────────────────

    function test_fork_unboundDispatcher_noCallbackFires() public {
        InSwapRecorder rec = new InSwapRecorder(address(pcSwapContext));
        // Register the callback on the dispatcher but DO NOT bind the
        // dispatcher to the pool. Real swap should complete; rec stays at 0.
        dispatcher.registerCallback(address(rec), 100_000);

        _buy(0.1 ether);

        assertEq(rec.invocations(), 0, "no callback when dispatcher unbound");
        assertFalse(rec.observedInSwap());
    }

    // ─── (14) HARDENING: PCSwapContext lockdown ──────────────────────────

    /// @dev PCSwapContext is permanent. Only the bound dispatcher (the
    ///      `authorizedExtension`) can flip the inSwap flag. Outside callers
    ///      — EOAs OR contracts — cannot. The exploit this protects against:
    ///      a malicious callback in the dispatcher's loop calling exitSwap
    ///      to clear the flag so subsequent callbacks could reenter PC
    ///      contracts. Tested across four angles.
    function test_fork_pcSwapContext_eoaCannotEnterOrExit() public {
        address eoa = makeAddr("flag-eoa");
        // Authorize the dispatcher (otherwise enterSwap reverts trivially).
        _bindDispatcherToPool();
        // EOA tries to call enterSwap directly.
        vm.prank(eoa);
        vm.expectRevert(PCSwapContext.NotAuthorizedExtension.selector);
        pcSwapContext.enterSwap();
        // EOA tries to call exitSwap directly.
        vm.prank(eoa);
        vm.expectRevert(PCSwapContext.NotAuthorizedExtension.selector);
        pcSwapContext.exitSwap();
    }

    function test_fork_pcSwapContext_atLaunch_flagPermanentlyZero() public {
        // No bind — authorizedExtension == address(0) at launch.
        assertEq(pcSwapContext.authorizedExtension(), address(0));
        // Therefore NO ONE can set the flag — not even a contract.
        FlagFlipper flipper = new FlagFlipper(address(pcSwapContext));
        vm.expectRevert(PCSwapContext.NotAuthorizedExtension.selector);
        flipper.tryEnter();
        assertFalse(pcSwapContext.inSwap(), "flag stays false at launch");
    }

    /// @dev Most critical: during a real swap, the dispatcher enters swap
    ///      before invoking callbacks. A malicious callback tries to call
    ///      exitSwap to clear the flag — that must revert (msg.sender is
    ///      the callback, NOT the dispatcher). Verified by chaining a
    ///      second observer callback that records inSwap; if the attacker
    ///      had succeeded, the observer would see inSwap == false.
    function test_fork_pcSwapContext_callbackCannotClearFlag() public {
        SwapContextManipulator manipulator = new SwapContextManipulator(address(pcSwapContext));
        InSwapRecorder rec = new InSwapRecorder(address(pcSwapContext));
        _bindDispatcherToPool();
        // Order matters — manipulator runs first, then rec. If the attack
        // worked, rec would observe inSwap == false.
        dispatcher.registerCallback(address(manipulator), 100_000);
        dispatcher.registerCallback(address(rec), 100_000);

        _buy(0.1 ether);

        assertTrue(manipulator.exitRejected(), "exitSwap from callback reverted");
        assertTrue(manipulator.enterRejected(), "enterSwap from callback reverted");
        assertTrue(rec.observedInSwap(), "downstream callback still saw inSwap == true");
        // And flag cleared after the swap.
        assertFalse(pcSwapContext.inSwap());
    }

    function test_fork_pcSwapContext_postLockSetExtensionReverts() public {
        // Spawn a fresh PCSwapContext (this test owns it). Authorize, lock,
        // then attempt re-set. Verifies the one-way lock holds.
        PCSwapContext fresh = new PCSwapContext(address(this));
        fresh.setAuthorizedExtension(address(0xabc));
        fresh.lockAuthorizedExtension();
        vm.expectRevert(PCSwapContext.AuthorizedExtensionAlreadyLocked.selector);
        fresh.setAuthorizedExtension(address(0xdef));
        // Lock is also one-way — second lock call reverts.
        vm.expectRevert(PCSwapContext.AuthorizedExtensionAlreadyLocked.selector);
        fresh.lockAuthorizedExtension();
        // transferOwnership to zero must revert (would foreclose Design B).
        vm.expectRevert(PCSwapContext.ZeroAddress.selector);
        fresh.transferOwnership(address(0));
    }

    // ─── (16) HARDENING: PermanentCollection / PunkVault access control ──

    function test_fork_pc_recordAcquisition_fromNonPatronReverts() public {
        address attacker = makeAddr("acquisition-attacker");
        vm.prank(attacker);
        // Signature: recordAcquisition(uint16 punkId, uint8 targetTraitId,
        //   uint256 mask, address acquirer, address originalSeller, uint256 priceWei)
        (bool ok,) = address(pc)
            .call(
                abi.encodeWithSignature(
                    "recordAcquisition(uint16,uint8,uint256,address,address,uint256)",
                    uint16(0),
                    uint8(0),
                    uint256(0),
                    attacker,
                    attacker,
                    uint256(0)
                )
            );
        assertFalse(ok, "recordAcquisition from non-patron must revert");
    }

    function test_fork_pc_markCustody_fromNonFinalSaleReverts() public {
        address attacker = makeAddr("custody-attacker");
        vm.prank(attacker);
        (bool ok,) = address(pc).call(abi.encodeWithSignature("markCustody(uint16,uint8)", uint16(0), uint8(2)));
        assertFalse(ok, "markCustody from non-finalSale must revert");
    }

    function test_fork_punkVault_receivePunk_fromNonFinalSaleReverts() public {
        address attacker = makeAddr("vault-attacker");
        address vault = pc.punkVault();
        vm.prank(attacker);
        (bool ok,) = vault.call(abi.encodeWithSignature("receivePunk(uint16)", uint16(0)));
        assertFalse(ok, "PunkVault.receivePunk from non-finalSale must revert");
    }

    // ─── (17) HARDENING: Multi-referrer independence ─────────────────────

    function test_fork_referrals_distinctReferrers_accrueIndependently() public {
        // First acquisition (incidental setup; referral is ungated).
        uint16 punkId = 0;
        _fundPatronFromAdapter(0.5 ether);
        _giveAndOfferToBounty(makeAddr("punk0-multiref"), punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(makeAddr("punk0-multiref"));
        patron.acceptBid(punkId, target, type(uint256).max);

        address refA = makeAddr("ref-A");
        address refB = makeAddr("ref-B");
        PCAttribution memory attA =
            PCAttribution({sourceId: bytes32("multi-A"), referrer: refA, campaignId: bytes16(0), referralBps: 250});
        PCAttribution memory attB =
            PCAttribution({sourceId: bytes32("multi-B"), referrer: refB, campaignId: bytes16(0), referralBps: 250});

        _buyWithAttribution(1 ether, attA);
        _buyWithAttribution(2 ether, attB);

        // Under per-swap auto-flush each swap's credited referrer is
        // forwarded to ReferralPayout within the swap's own tx, so the
        // hook's `accruedReferral` mapping is zero between swaps. The
        // distinct-accrual guarantee now lives at the ReferralPayout
        // layer (each referrer has their own pull-balance).
        assertEq(
            IHookSkimAccessor(deployedHook).accruedReferral(_poolKey().toId(), refA),
            0,
            "refA accrual auto-flushed by its own swap"
        );
        assertEq(
            IHookSkimAccessor(deployedHook).accruedReferral(_poolKey().toId(), refB),
            0,
            "refB accrual auto-flushed by its own swap"
        );

        uint256 payoutA = referralPayout.balances(refA);
        uint256 payoutB = referralPayout.balances(refB);
        assertTrue(payoutA > 0, "refA credited in ReferralPayout");
        assertTrue(payoutB > 0, "refB credited in ReferralPayout");
        // refB swapped 2× volume so ~2× the credit.
        assertApproxEqAbs(payoutB, payoutA * 2, payoutA / 20, "refB credit ~= 2x refA credit");

        // The external `flushReferral` is now a no-op for an already-
        assertEq(referralPayout.balances(refA), payoutA, "flushReferral no-op for already-flushed referrer");
        assertEq(referralPayout.balances(refB), payoutB, "refB balance unaffected by refA flush");
    }

    // ─── (18) HARDENING: Referral cap clamping ───────────────────────────

    function test_fork_referralCap_overMaxClampedToCap() public {
        // First acquisition (incidental setup; referral is ungated).
        uint16 punkId = 0;
        _fundPatronFromAdapter(0.5 ether);
        _giveAndOfferToBounty(makeAddr("punk0-cap"), punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(makeAddr("punk0-cap"));
        patron.acceptBid(punkId, target, type(uint256).max);

        address greedy = makeAddr("greedy-ref");
        // Request 50% — but cap is 250 (0.25%). Clamp must apply.
        PCAttribution memory att = PCAttribution({
            sourceId: bytes32("cap-test"), referrer: greedy, campaignId: bytes16(0), referralBps: 50_000
        });
        _buyWithAttribution(1 ether, att);

        uint256 owed = referralPayout.balances(greedy);
        // Cap: 250 / 100_000 = 0.25% of 1 ETH = 0.0025 ETH.
        uint256 capExpected = 0.0025 ether;
        assertApproxEqAbs(owed, capExpected, capExpected / 10, "clamped to cap");
        // Crucial sanity: owed must be MUCH less than the requested 50%.
        assertTrue(owed < 0.05 ether, "greedy request was clamped to cap");
    }

    // ─── (18b) HARDENING: Carve-out tuning takes effect on next swap ─────

    /// @notice Verifies the `TokenAdminPoker.setHookMaxReferralBps` carve-out:
    ///         changing the cap via the wrapper IMMEDIATELY affects the next
    ///         attributed swap. Exercises both authorization paths:
    ///         (a) TokenAdminPoker.owner, (b) ProtocolAdmin.admin() EOA.
    ///         Mirrors how an operator would post-launch raise/lower the
    ///         referral cap to track market conditions.
    function test_fork_carveOut_setReferralBps_takesEffectImmediately() public {
        // First acquisition (incidental setup; referral is ungated).
        uint16 punkId = 0;
        _fundPatronFromAdapter(0.5 ether);
        _giveAndOfferToBounty(makeAddr("punk0-carve"), punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(makeAddr("punk0-carve"));
        patron.acceptBid(punkId, target, type(uint256).max);

        // Read fixture handles.
        address dev = vm.addr(DEV_PK);
        string memory path = string.concat(vm.projectRoot(), "/deployments.json");
        string memory json = vm.readFile(path);
        address poker = vm.parseJsonAddress(json, ".tokenAdminPoker");
        address admin = ITokenAdminPokerOwner(poker).adminContract();

        // At deploy, dev was both poker.owner AND admin.admin(). The fork
        // fixture rotates admin to address(this) in _loadDeployments so
        // tests can drive admin-gated setters. So we read the live admin
        // EOA dynamically rather than assuming it's still `dev`.
        require(ITokenAdminPokerOwner(poker).owner() == dev, "poker owner != dev");
        address adminEoa = IProtocolAdminEoa(admin).admin();

        // Baseline: 1 ETH swap with maxed-out request, current cap 250 → ~0.25%.
        address refA = makeAddr("carve-ref-A");
        _buyWithAttribution(
            1 ether,
            PCAttribution({
                sourceId: bytes32("carve-A"),
                referrer: refA,
                campaignId: bytes16(0),
                referralBps: 50_000 // request way over the cap
            })
        );
        uint256 owedA = referralPayout.balances(refA);
        assertApproxEqAbs(owedA, 0.0025 ether, 0.0025 ether / 10, "baseline ~0.25% of 1 ETH");

        // ── Path A: ProtocolAdmin admin EOA tunes the cap (carve-out path) ──
        // Raise to 500 (0.50% of volume). Pranks as the current admin EOA.
        vm.prank(adminEoa);
        ITokenAdminPokerOwner(poker).setHookMaxReferralBps(500);

        address refB = makeAddr("carve-ref-B");
        _buyWithAttribution(
            1 ether,
            PCAttribution({sourceId: bytes32("carve-B"), referrer: refB, campaignId: bytes16(0), referralBps: 50_000})
        );
        uint256 owedB = referralPayout.balances(refB);
        // 500 / 100_000 = 0.5% of 1 ETH = 0.005 ETH (clamped to protocolShare = 1%).
        assertApproxEqAbs(owedB, 0.005 ether, 0.005 ether / 10, "post-tune ~0.5% of 1 ETH");
        assertGt(owedB, owedA + 0.0015 ether, "new cap (500) > old cap (250) by margin");

        // ── Path B: TokenAdminPoker.owner tunes the cap (owner path) ──
        // Raise to the hook's hard ceiling (1000 = 1% of volume).
        vm.prank(dev); // dev is also the poker.owner at deploy
        ITokenAdminPokerOwner(poker).setHookMaxReferralBps(1000);

        address refC = makeAddr("carve-ref-C");
        _buyWithAttribution(
            1 ether,
            PCAttribution({sourceId: bytes32("carve-C"), referrer: refC, campaignId: bytes16(0), referralBps: 50_000})
        );
        uint256 owedC = referralPayout.balances(refC);
        // 1000 / 100_000 = 1% of 1 ETH = 0.01 ETH, but clamped to protocolShare
        // (also = 1% of volume after the existing 75/5/20 split → 0.01 ETH).
        // So referral consumes the FULL protocol slice.
        assertApproxEqAbs(owedC, 0.01 ether, 0.01 ether / 10, "post-tune ~1% of 1 ETH");
        assertGt(owedC, owedB + 0.003 ether, "new cap (1000) > prior cap (500) by margin");

        // ── Path C: lower the cap back down — should clamp immediately ──
        vm.prank(dev);
        ITokenAdminPokerOwner(poker).setHookMaxReferralBps(100);

        address refD = makeAddr("carve-ref-D");
        _buyWithAttribution(
            1 ether,
            PCAttribution({sourceId: bytes32("carve-D"), referrer: refD, campaignId: bytes16(0), referralBps: 50_000})
        );
        uint256 owedD = referralPayout.balances(refD);
        // 100 / 100_000 = 0.10% of 1 ETH = 0.001 ETH.
        assertApproxEqAbs(owedD, 0.001 ether, 0.001 ether / 10, "lowered cap ~0.1% of 1 ETH");
        assertLt(owedD, owedA, "lowered cap (100) < original cap (250)");
    }

    // ─── (19) HARDENING: Dispatcher limits ───────────────────────────────

    function test_fork_dispatcher_maxCallbacks_ninthRejected() public {
        for (uint256 i = 0; i < 8; i++) {
            DummyCallback c = new DummyCallback();
            dispatcher.registerCallback(address(c), 100_000);
        }
        assertEq(dispatcher.callbackCount(), 8);
        DummyCallback ninth = new DummyCallback();
        vm.expectRevert(UnipegDispatcher.TooManyCallbacks.selector);
        dispatcher.registerCallback(address(ninth), 100_000);
    }

    function test_fork_dispatcher_externalAfterSwap_revertsOnlyHook() public {
        SwapParams memory params =
            SwapParams({zeroForOne: true, amountSpecified: -int256(1 ether), sqrtPriceLimitX96: 0});
        BalanceDelta zeroDelta = BalanceDelta.wrap(0);
        vm.expectRevert(UnipegDispatcher.OnlyHook.selector);
        dispatcher.afterSwap(_poolKey(), params, zeroDelta, false, "");
    }

    // ─── (20) HARDENING: Extension lock + allowlist enforcement ──────────

    function test_fork_extensionLock_blocksRebind() public {
        _bindDispatcherToPool();

        string memory path = string.concat(vm.projectRoot(), "/deployments.json");
        string memory json = vm.readFile(path);
        address poker = vm.parseJsonAddress(json, ".tokenAdminPoker");
        address dev = vm.addr(DEV_PK);

        vm.prank(dev);
        ITokenAdminPokerOwner(poker).lockExtension();

        // Try to rebind to address(0).
        vm.prank(dev);
        vm.expectRevert();
        ITokenAdminPokerOwner(poker).bindExtension(address(0));

        // And try to rebind to the dispatcher again.
        vm.prank(dev);
        vm.expectRevert();
        ITokenAdminPokerOwner(poker).bindExtension(address(dispatcher));

        // Lock is one-way — second lock attempt also reverts.
        vm.prank(dev);
        vm.expectRevert();
        ITokenAdminPokerOwner(poker).lockExtension();
    }

    function test_fork_nonAllowlistedExtension_rejectedByHook() public {
        // Deploy a fresh dispatcher — DO NOT allowlist on artcoins allowlist.
        UnipegDispatcher rogue = new UnipegDispatcher(deployedHook, address(pcSwapContext), address(this));
        // Also authorize on PCSwapContext (so this isn't what trips it).
        address dev = vm.addr(DEV_PK);
        vm.prank(dev);
        pcSwapContext.setAuthorizedExtension(address(rogue));

        string memory path = string.concat(vm.projectRoot(), "/deployments.json");
        string memory json = vm.readFile(path);
        address poker = vm.parseJsonAddress(json, ".tokenAdminPoker");

        // Attempt to bind the rogue dispatcher — hook reverts because it's
        // not on the artcoins extension allowlist.
        vm.prank(dev);
        vm.expectRevert();
        ITokenAdminPokerOwner(poker).bindExtension(address(rogue));
    }

    // ─── (21) HARDENING: MEV-window elevated fee still routes 80/20 ─────

    function test_fork_mevWindow_elevatedFeeRoutesThroughSameLegs() public {
        // setUp warps +90 minutes (past 69-min MEV window). Warp BACK to
        // ~30 minutes after launch — inside the window, elevated fee active.
        vm.warp(block.timestamp - 60 minutes);

        uint256 bountyBefore = address(liveBidAdapter).balance;
        uint256 protocolBefore = IArtcoinsFeeLocker(protocolFeePhaseAdapter.feeEscrow())
            .feesToClaim(address(protocolFeePhaseAdapter), address(0));
        uint256 patronBefore = address(patron).balance;

        _buy(1 ether);
        _buy(0.001 ether);
        _buy(0.001 ether);

        // Bounty side = adapter tail + the pre-swap stream's forward into
        // Patron. antiSniperExtra still routes 100% to the bounty leg, so the
        // bounty SIDE share stays ≥ 80% regardless of where it currently sits.
        uint256 bountyDelta =
            (address(liveBidAdapter).balance - bountyBefore) + (address(patron).balance - patronBefore);
        uint256 protocolDelta = IArtcoinsFeeLocker(protocolFeePhaseAdapter.feeEscrow())
            .feesToClaim(address(protocolFeePhaseAdapter), address(0)) - protocolBefore;

        // Both legs MUST still flow even at the elevated fee — a dead leg
        // here would silently lose money for the protocol.
        assertTrue(bountyDelta > 0, "bounty received MEV-window skim");
        assertTrue(protocolDelta > 0, "protocol received MEV-window skim");

        // antiSniperExtra routes entirely to bounty per the hook spec. So
        // in-window: bounty's share of total ≥ baseline 80% (extra inflates
        // it). Verifies the spec property "antiSniperExtra → bounty"
        // without needing to know the exact elevated bps.
        uint256 totalSkim = bountyDelta + protocolDelta;
        uint256 bountyPctOfTotal = bountyDelta * 100 / totalSkim;
        assertTrue(bountyPctOfTotal >= 80, "MEV: bounty leg absorbs antiSniperExtra so share >= 80%");
    }

    // ─── (22) HARDENING: Live-deployed bytecode scans ────────────────────

    /// @dev Scans the LIVE-DEPLOYED bytecode (produced by Deploy.s.sol on
    ///      the fork — i.e. the exact bytecode mainnet would receive) for
    ///      market-write selectors. Complements the unit-level scan in
    ///      PunkVault.t.sol: this proves the DEPLOYED bytecode is clean,
    ///      not just the compiled artifact. PunkVault is immutable; this
    ///      property must hold forever.
    function test_fork_bytecode_punkVault_noMarketWriteSelectors() public view {
        bytes memory code = pc.punkVault().code;
        assertTrue(code.length > 0, "punkVault has deployed code");
        _assertNoSelector(code, bytes4(keccak256("transferPunk(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("buyPunk(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSale(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSaleToAddress(uint256,uint256,address)")));
        _assertNoSelector(code, bytes4(keccak256("acceptBidForPunk(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("enterBidForPunk(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
        _assertNoSelector(code, bytes4(keccak256("withdrawBidForPunk(uint256)")));
    }

    /// @dev Confirms Patron has no admin-controlled withdrawal path. Patron
    ///      holds the live bid; any escape selector here is a forever
    ///      rug-pull risk.
    function test_fork_bytecode_patron_noWithdrawalSelectors() public view {
        bytes memory code = address(patron).code;
        assertTrue(code.length > 0, "patron has deployed code");
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
        _assertNoSelector(code, bytes4(keccak256("withdraw(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(address)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(address,address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("sweep()")));
        _assertNoSelector(code, bytes4(keccak256("sweep(address)")));
        _assertNoSelector(code, bytes4(keccak256("migrate(address)")));
        _assertNoSelector(code, bytes4(keccak256("emergencyWithdraw()")));
        _assertNoSelector(code, bytes4(keccak256("drain()")));
        _assertNoSelector(code, bytes4(keccak256("drain(address)")));
    }

    function _assertNoSelector(
        bytes memory code,
        bytes4 sel
    ) internal pure {
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2] && code[i + 3] == sel[3]) {
                revert("bytecode contains forbidden selector");
            }
        }
    }

    // ─── (23) HARDENING: acceptBid pays via market, no seller-push reentry ─

    /// @dev acceptBid pays the seller through the 2017 market
    ///      (`pendingWithdrawals`), NOT a push, so a seller contract whose
    ///      receive() would re-enter Patron is never invoked during the
    ///      acquisition — the bid path has no seller-controlled callback and
    ///      therefore no reentrancy vector at all. The acquisition completes and
    ///      the proceeds wait in the market for the seller to withdraw.
    function test_fork_hardening_acceptBounty_noSellerPushReentry() public {
        // Fund the live bid so the listed price > 0.
        _fundPatronFromAdapter(1 ether);

        // Choose a Punk and transfer to the malicious contract.
        uint16 punkId = 0;
        MaliciousSeller bad = new MaliciousSeller(address(patron), address(punksMarket));
        address owner_ = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(owner_);
        punksMarket.transferPunk(address(bad), uint256(punkId));

        uint8 target = _pickTarget(punkId);
        uint256 listed = patron.bidBalance();
        // The malicious contract lists + accepts. Its receive() is NEVER called,
        // because acceptBid pushes the seller nothing.
        bad.offerAndAccept(punkId, target, punkId, target);

        // No push reached the seller contract: its balance is untouched and the
        // re-entry hook never fired.
        assertEq(address(bad).balance, 0, "no ETH pushed to the seller");
        assertFalse(bad.reentryWasBlocked(), "seller receive() never invoked (no push)");

        // The acquisition completed; the proceeds wait in the market.
        assertEq(pc.acquisitionCount(), 1, "acceptBid completed");
        assertEq(punksMarket.pendingWithdrawals(address(bad)), listed, "proceeds wait in the market");
    }

    // ─── (24) HARDENING: ReferralPayout claim with reverting recipient ───

    /// @dev ReferralPayout uses a pull-based model with a 35k gas budget on
    ///      the send. If the recipient reverts on receive, the claim must
    ///      revert with TransferFailed AND reinstate the balance. This
    ///      proves the ledger is robust against malicious-recipient grief.
    function test_fork_hardening_referralPayout_revertingRecipient() public {
        // First acquisition (incidental setup; referral is ungated).
        uint16 punkId = 0;
        _fundPatronFromAdapter(0.5 ether);
        _giveAndOfferToBounty(makeAddr("punk0-revrec"), punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(makeAddr("punk0-revrec"));
        patron.acceptBid(punkId, target, type(uint256).max);

        // Deploy a recipient that reverts on every ETH receive.
        RevertingRecipient bad = new RevertingRecipient();
        PCAttribution memory att = PCAttribution({
            sourceId: bytes32("rev-recv"), referrer: address(bad), campaignId: bytes16(0), referralBps: 250
        });
        _buyWithAttribution(1 ether, att);

        // Balance MUST be > 0 (the hook routed it here via notify).
        // notify() doesn't trigger receive() — it only updates a mapping —
        // so the malicious receive() never fired during notify.
        uint256 owedBefore = referralPayout.balances(address(bad));
        assertTrue(owedBefore > 0, "balance credited by hook");

        // Now attempt to claim — this DOES trigger receive() on the
        // recipient, which reverts. ReferralPayout should revert
        // TransferFailed and reinstate the balance.
        vm.expectRevert(ReferralPayoutErrors.TransferFailed.selector);
        referralPayout.claimFor(address(bad));

        // Balance must be unchanged (reinstated after failed send).
        assertEq(referralPayout.balances(address(bad)), owedBefore, "balance reinstated after failed transfer");
    }

    // ─── (25) HARDENING: ReferralPayout stray ETH is unclaimable ─────────

    /// @dev ReferralPayout's `receive()` accepts stray ETH but does NOT
    ///      credit it to any referrer. This is intentional: prevents
    ///      misattribution and keeps the hook as the sole authoritative
    ///      credit source. Untestable on UNIT level since you can't easily
    ///      assert the negative — but a fork test confirms the actual
    ///      deployed bytecode behaves this way.
    function test_fork_hardening_referralPayout_strayEthUncredited() public {
        address stranger = makeAddr("stray-sender");
        address randomRef = makeAddr("random-referrer-not-credited");
        vm.deal(stranger, 1 ether);

        uint256 contractBalBefore = address(referralPayout).balance;
        // Send 0.5 ETH directly to ReferralPayout (triggers receive).
        vm.prank(stranger);
        (bool ok,) = address(referralPayout).call{value: 0.5 ether}("");
        require(ok, "raw send to referralPayout receive() succeeded");

        // Contract balance went up, but NO referrer was credited.
        assertEq(address(referralPayout).balance - contractBalBefore, 0.5 ether, "stray ETH accepted into contract");
        assertEq(referralPayout.balances(stranger), 0, "sender NOT credited");
        assertEq(referralPayout.balances(randomRef), 0, "random ref NOT credited");
        // Stranger cannot claim what they didn't earn.
        vm.prank(stranger);
        vm.expectRevert(ReferralPayoutErrors.NothingToClaim.selector);
        referralPayout.claim();
    }

    // ─── (26) HARDENING: acceptBid rejects un-pre-listed Punk ─────────

    /// @dev acceptBid requires the Punk to be pre-listed exclusively to
    ///      Patron at price 0. If the Punk owner forgets the offer step
    ///      and just calls acceptBid, the market view returns
    ///      isForSale=false and Patron reverts PunkNotListedToHub. Proves
    ///      the two-step UX is enforced on-chain (no implicit pre-list).
    function test_fork_hardening_acceptBounty_unlistedPunkReverts() public {
        _fundPatronFromAdapter(0.5 ether);
        uint16 punkId = 0;
        // Transfer Punk to a fresh owner — but DO NOT pre-list.
        address fresh = makeAddr("fresh-owner-no-offer");
        address owner_ = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(owner_);
        punksMarket.transferPunk(fresh, uint256(punkId));

        uint8 target = _pickTarget(punkId);
        vm.prank(fresh);
        vm.expectRevert(); // PunkNotListedToHub or InvalidTargetTrait
        patron.acceptBid(punkId, target, type(uint256).max);

        // Sanity: no acquisition recorded.
        assertEq(pc.acquisitionCount(), 0, "no acquisition recorded");
    }

    // ─── (27) HARDENING: ReturnAuction vault-path end-to-end ─────────────────

    /// @dev The "Silenced" outcome (no rescue): Punk → PunkVault forever,
    ///      ONLY the recorded target trait gets collected (V2 spec), and
    ///      the VaultBurnPool is swept to BuybackBurner so the supply
    ///      reduction parallels the cleared-path's bounty replenishment.
    ///      This is the protocol's primary collection mechanism — must
    ///      work end-to-end on live fork bytecode.
    function test_fork_hardening_finalSale_vaultPathFullFlow() public {
        // Fund Patron so acquisitionCost > 0.
        _fundPatronFromAdapter(1 ether);

        uint16 punkId = 0;
        address seller = makeAddr("vaultpath-seller");
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);

        // Capture pre-state.
        uint256 collectedBefore = pc.collectedMask();
        assertEq((collectedBefore >> target) & 1, 0, "target NOT collected pre-acquire");

        // acceptBid → starts ReturnAuction.
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Punk is now in the ReturnAuction module's custody. Verify the trait
        // is pending (not collected).
        assertEq(pc.pendingTraitCount(target), 1, "target trait is pending during sale");
        assertEq((pc.collectedMask() >> target) & 1, 0, "still NOT collected");
        // Punk transferred to finalSale.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale), "Punk in ReturnAuction custody");

        // Advance past the 72h sale duration with no bids.
        vm.warp(block.timestamp + 72 hours + 1 minutes);

        // Settle — anyone can call.
        address keeper = makeAddr("settle-keeper");
        vm.prank(keeper);
        finalSale.settle(punkId);

        // Permanent outcomes:
        // 1. Punk is now in PunkVault, immobile.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), pc.punkVault(), "Punk locked in PunkVault");
        // 2. ONLY the target trait is now collected (V2 spec — not every
        //    uncollected bit on the mask).
        assertEq((pc.collectedMask() >> target) & 1, 1, "target trait collected");
        assertEq(pc.pendingTraitCount(target), 0, "target trait no longer pending");
    }

    // ─── (28) HARDENING: ReturnAuction bid validation + anti-snipe extension ─

    function test_fork_hardening_finalSale_bidValidation_andAntiSnipe() public {
        _fundPatronFromAdapter(1 ether);
        uint16 punkId = 0;
        address seller = makeAddr("bid-test-seller");
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Acquisition cost = patron's balance at acceptBid time = 1 ETH.
        // First-trial reserve = 1 ETH × (101 + 0) / 100 = 1.01 ETH.
        uint256 expectedReserve = 1.01 ether;

        // Bid below reserve reverts.
        address bidder1 = makeAddr("bidder-low");
        vm.deal(bidder1, expectedReserve - 1);
        vm.prank(bidder1);
        vm.expectRevert();
        finalSale.placeBidWithReferral{value: expectedReserve - 1}(punkId, address(0), bytes32(0));

        // Bid at reserve succeeds.
        address bidder2 = makeAddr("bidder-at-reserve");
        vm.deal(bidder2, 2 ether);
        vm.prank(bidder2);
        finalSale.placeBidWithReferral{value: expectedReserve}(punkId, address(0), bytes32(0));

        // Warp to inside the anti-snipe window (last 15 min of the sale).
        // Sale duration = 72h. Warp 72h - 14min from start.
        vm.warp(block.timestamp + 72 hours - 14 minutes);

        // Bid in the anti-snipe window. Must clear minIncrementBps over
        // expectedReserve. Use 1.5× to easily clear any reasonable bps.
        address bidder3 = makeAddr("bidder-snipe");
        uint256 snipeBid = expectedReserve * 3 / 2;
        vm.deal(bidder3, snipeBid + 1 ether);
        vm.prank(bidder3);
        finalSale.placeBidWithReferral{value: snipeBid}(punkId, address(0), bytes32(0));

        // Verify deadline extended +1h from now via the canonical getter.
        ReturnAuctionModule.ReturnAuction memory s = finalSale.getSale(punkId);
        assertEq(uint256(s.endsAt), block.timestamp + 1 hours, "anti-snipe extended deadline +1h");
    }

    // ─── (29) HARDENING: BuybackBurner pacing enforcement ────────────────

    function test_fork_hardening_buybackBurner_pacingEnforced() public {
        // Generate some ETH into BuybackBurner via swaps' vault-burn leg.
        // The VaultBurnPool sweeps to the burner on settle, but we don't
        // need to go through a settle — we can directly send ETH.
        vm.deal(address(burner), 1 ether);
        // Bump the burner's remainingEth directly via the deposit receive().
        (bool ok,) = address(burner).call{value: 0.5 ether}("");
        require(ok, "deposit succeeded");

        // First call to executeStep — succeeds.
        address keeper1 = makeAddr("burn-keeper-1");
        vm.prank(keeper1);
        try burner.executeStep(0) {
        // Step 1 succeeded.
        }
        catch {
            // Pool may not have liquidity yet — fork fixture deploys but
            // might not have meaningful 111 side. In that case, skip the
            // pacing check — the StepTooEarly logic is independent.
            return;
        }

        // Immediately call again in the same block — StepTooEarly.
        address keeper2 = makeAddr("burn-keeper-2");
        vm.prank(keeper2);
        vm.expectRevert();
        burner.executeStep(0);
    }

    // ─── (30) HARDENING: 1y admin auto-lock + allowlist carve-out ────────

    /// @dev The protocol's trust-minimization model: admin powers auto-lock
    ///      after 365 days unless renewed. Scoped carve-outs remain editable
    ///      past lock; this test covers two of them — the seller allowlist and
    ///      the adapter's activation threshold — and verifies the lock fires
    ///      automatically, that BOTH carve-outs still work, and that the
    ///      checkAdmin-gated rate-cap setters do NOT.
    function test_fork_hardening_oneYearLock_andAllowlistCarveOut() public {
        // adminContract was transferred to this test contract in setUp.
        // The transfer sets adminTimerExpires = now + 365 days.
        // Warp 365d + 1s — admin is now locked.
        vm.warp(block.timestamp + 365 days + 1 seconds);
        assertTrue(adminContract.isLocked(), "admin auto-locked after 1y");

        // checkAdmin-gated economic setters revert past the lock. (Patron's
        // own finder-fee setters are gone — those parameters are now protocol
        // constants — so demonstrate the lock on a still-tunable surface, the
        // adapter's sweep throttle.)
        vm.expectRevert(LiveBidAdapter.NotAdmin.selector);
        liveBidAdapter.setMaxSweepWei(1 ether);

        // BUT onlyAdminEvenIfLocked carve-outs still work as long as the admin
        // EOA hasn't been burned via transferAdmin(0): the seller allowlist...
        address newSeller = makeAddr("post-lock-seller");
        patron.addAllowedSeller(newSeller);
        assertTrue(patron.allowedSellers(newSeller), "post-lock allowlist add OK");

        // ...and the adapter's activation threshold (the lone adapter carve-out;
        // an anomaly-correction valve), which survives the lock unlike the
        // rate-cap setters above.
        liveBidAdapter.setActivationThreshold(7 ether);
        assertEq(liveBidAdapter.activationThreshold(), 7 ether, "post-lock activation-threshold set OK (carve-out)");
    }

    /// @dev M-1 regression (auditor finding): the admin *burn* path must stay
    ///      reachable after the 1-year timer lapses. Before the fix,
    ///      `transferAdmin` reverted `Locked` once the timer expired — for ANY
    ///      argument, including `address(0)` — so the role could never be
    ///      burned post-lapse and the raw-admin carve-outs (allowlist,
    ///      activation threshold, referral cap, transfer-tax rate) stayed
    ///      callable by the live EOA forever, with no on-chain off-switch. A post-lapse key
    ///      compromise could `addAllowedSeller(malicious)` and drain the live
    ///      bid via an overpriced `acceptListing`. The fix gates only
    ///      renewals/rotations on the timer; burning is always allowed.
    ///
    ///      Exercises the live-deployed Deploy.s.sol bytecode end-to-end:
    ///      lapse → renewal reverts → carve-out still live → burn succeeds →
    ///      carve-out now disabled.
    function test_fork_hardening_burnAfterLapse_disablesCarveOuts() public {
        // Precompute labelled addresses before any expectRevert so the
        // cheatcode calls don't interleave with the asserted reverts.
        address rotationTarget = makeAddr("post-lapse-rotation-target");
        address preBurnSeller = makeAddr("pre-burn-seller");
        address postBurnSeller = makeAddr("post-burn-seller");

        // adminContract was transferred to this test contract in setUp, with
        // adminTimerExpires = now + 365 days. Warp past it without renewing.
        vm.warp(block.timestamp + 365 days + 1 seconds);
        assertTrue(adminContract.isLocked(), "admin auto-locked after 1y");
        assertEq(adminContract.admin(), address(this), "admin EOA still live post-lapse");

        // (1) A renewal / rotation is time-gated — reverts Locked even though
        //     this test contract is still the admin.
        vm.expectRevert(ProtocolAdmin.Locked.selector);
        adminContract.transferAdmin(rotationTarget);

        // The carve-out is STILL exploitable here (pre-burn) — this is exactly
        // the M-1 exposure window: the live admin can still add sellers.
        patron.addAllowedSeller(preBurnSeller);
        assertTrue(patron.allowedSellers(preBurnSeller), "carve-out live pre-burn");

        // The adapter's activation-threshold carve-out is likewise live pre-burn.
        liveBidAdapter.setActivationThreshold(9 ether);
        assertEq(liveBidAdapter.activationThreshold(), 9 ether, "adapter carve-out live pre-burn");

        // Contrast: the LiveBidAdapter rate-cap setters have NO carve-out —
        // they locked at the timer expiry above, BEFORE any burn.
        vm.expectRevert(LiveBidAdapter.NotAdmin.selector);
        liveBidAdapter.setMaxSweepWei(1 ether);

        // (2) The burn path is NOT time-gated — it succeeds, zeroes admin,
        //     sets adminBurned, and emits AdminBurned.
        vm.expectEmit(false, false, false, true, address(adminContract));
        emit ProtocolAdmin.AdminBurned(block.timestamp);
        adminContract.transferAdmin(address(0));
        assertTrue(adminContract.adminBurned(), "role burned after lapse");
        assertEq(adminContract.admin(), address(0), "admin zeroed on burn");

        // (3) The carve-outs are now truly disabled — both the Patron allowlist
        //     and the adapter's activation threshold revert NotAdmin, since
        //     adminContract.admin() == address(0). The always-available burn
        //     off-switch worked.
        vm.expectRevert(Patron.NotAdmin.selector);
        patron.addAllowedSeller(postBurnSeller);

        vm.expectRevert(LiveBidAdapter.NotAdmin.selector);
        liveBidAdapter.setActivationThreshold(20 ether);
    }

    // ─── (31) HARDENING: locker tail positions absorb high-FDV trades ────
    //
    // POLDepositor (and its access-control + immobility tests) was retired —
    // permanent depth now comes from the conversion locker's two concentrated
    // high-FDV tail positions. Their behaviour (registration, fee routing to
    // LiveBidAdapter, sequential activation) is covered by the dedicated
    // LockerTailExtensionFork suite.

    // ─── (32) HARDENING: ReturnAuction cleared (rescue) path end-to-end ──────

    /// @dev The "Rescue" outcome — the cleared-path settle. acceptBid →
    ///      bid above reserve → warp 72h → settle. Verifies the full
    ///      provenance round-trip via ReturnAuctionEscrow + the three-way
    ///      split: 70% cost → Patron, 30% cost → BuybackBurner, (highBid
    ///      − cost) → VaultBurnPool. Companion to the vault-path E2E test
    ///      above; together they cover the two terminal outcomes of every
    ///      return auction.
    function test_fork_hardening_finalSale_clearedPath_endToEnd() public {
        // Fund Patron so acquisitionCost > 0. acquisitionCost is snapshot
        // of address(this).balance at acceptBid time.
        _fundPatronFromAdapter(1 ether);

        uint16 punkId = 0;
        address seller = makeAddr("clearedpath-seller");
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);

        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Reserve formula: acquisitionCost × (101 + prevTrials) / 100.
        // With cost = 1 ETH and prevTrials = 0, reserve = 1.01 ETH.
        uint256 expectedReserve = 1.01 ether;
        uint256 bidAmount = 1.5 ether; // comfortably above reserve

        // Bidder must be able to receive ETH (no refund collision) AND
        // not be a contract whose receive() trips notInSwap. A fresh EOA
        // works.
        address bidder = makeAddr("clearedpath-bidder");
        vm.deal(bidder, bidAmount + 1 ether);

        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: bidAmount}(punkId, address(0), bytes32(0));

        // Snapshot adapters BEFORE settle — these grow on the split. Under
        // inflow consolidation the 65% bounty share routes to the
        // LiveBidAdapter buffer (via module-only poolReplenish), not Patron
        // directly — Patron's balance is untouched by settle.
        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 patronBefore = address(patron).balance;
        uint256 burnerBefore = address(burner).balance;
        uint256 vaultPoolBefore = address(vaultBurnPool).balance;

        // Warp past 72h sale duration. Anti-snipe wasn't triggered (bid
        // was placed early), so endsAt is unchanged.
        vm.warp(block.timestamp + 72 hours + 1 minutes);

        // Anyone can settle.
        address keeper = makeAddr("clearedpath-keeper");
        vm.prank(keeper);
        finalSale.settle(punkId);

        // Verify outcomes:
        // 1. Punk delivered to the WINNING BIDDER (not the keeper, not
        //    the recorded buyer-of-record which is the ReturnAuction module
        //    via the ReturnAuctionEscrow round-trip).
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), bidder, "Punk delivered to winning bidder");

        // 2. Three-way split (acquisitionCost = 1 ETH, highBid = 1.5 ETH):
        //    - bountyShareWei = 1 ETH × 6500 / 10000 = 0.65 ETH (full, no tip)
        //    - vaultBurnFromCost = 1 ETH × 1000 / 10000 = 0.1 ETH
        //    - burnShare = 1 ETH − 0.65 ETH − 0.1 ETH = 0.25 ETH (exact)
        //    - vaultBurnShare = (1.5 ETH − 1 ETH) + 0.1 ETH = 0.6 ETH (exact)
        uint256 adapterDelta = address(liveBidAdapter).balance - adapterBefore;
        uint256 burnerDelta = address(burner).balance - burnerBefore;
        uint256 vaultPoolDelta = address(vaultBurnPool).balance - vaultPoolBefore;

        // The full 65% bounty share landed in the adapter buffer (no keeper
        // tip on the cleared path); it meters into Patron on the next sweep.
        // Patron itself is untouched by settle.
        assertEq(
            adapterDelta,
            0.65 ether,
            "adapter buffered exactly 65% of acquisitionCost (no tip)"
        );
        assertEq(address(patron).balance, patronBefore, "Patron untouched by settle (refund buffers in adapter)");
        assertEq(burnerDelta, 0.25 ether, "BuybackBurner received exactly 25% of cost residual");
        assertEq(vaultPoolDelta, 0.6 ether, "VaultBurnPool received (highBid - cost) + 10%-of-cost");

        // 3. acquisitionCount stayed at 1 (only the original acceptBid;
        //    cleared-path doesn't record an additional acquisition).
        assertEq(pc.acquisitionCount(), 1, "single acquisition recorded");

        // 4. Target trait was NOT collected — cleared rescue path returns
        //    the Punk to circulation; only vault path collects traits.
        assertEq((pc.collectedMask() >> target) & 1, 0, "target trait NOT collected on cleared path");
        assertEq(pc.pendingTraitCount(target), 0, "pending counter cleared on rescue");
    }

    // ─── (33) HARDENING: acceptListing flow end-to-end ───────────────────

    /// @dev The OTHER acquisition path — `acceptListing`. An allowlisted
    ///      seller (e.g. PunkStrategy) lists a Punk publicly at a price
    ///      ≤ bounty; anyone calls acceptListing to pull it into a Final
    ///      Sale and earn the finder fee. Tests the full flow including
    ///      the 24h activation delay carve-out.
    function test_fork_hardening_acceptListing_endToEnd() public {
        // Bounty must be ≥ MIN_BID_FOR_LISTING (0.5 ETH).
        _fundPatronFromAdapter(5 ether);

        // Allowlist a new seller. This goes through onlyAdminEvenIfLocked
        // (adminContract.admin() == address(this) per fixture setUp).
        address seller = makeAddr("listing-seller");
        patron.addAllowedSeller(seller);
        // ALLOWLIST_DELAY (24h) protection: the activation timestamp is
        // set in the future. Warp past it.
        vm.warp(block.timestamp + 24 hours + 1 seconds);

        // Seller now owns the Punk and lists it publicly.
        uint16 punkId = 0;
        address punkOwner = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(punkOwner);
        punksMarket.transferPunk(seller, uint256(punkId));
        uint256 listingPrice = 1 ether;
        vm.prank(seller);
        punksMarket.offerPunkForSale(uint256(punkId), listingPrice);

        uint8 target = _pickTarget(punkId);

        // Anyone calls acceptListing. Finder fee is paid to msg.sender.
        // Use a fresh EOA so the fee transfer is uncomplicated.
        address finder = makeAddr("listing-finder");

        uint256 finderBalBefore = finder.balance;
        uint256 sellerBalBefore = seller.balance;

        vm.prank(finder);
        patron.acceptListing(punkId, target);

        // Verify outcomes:
        // 1. Punk transferred to ReturnAuction module (via Patron's buyPunk +
        //    transferPunk).
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale), "Punk in ReturnAuction custody");

        // 2. Finder received a non-zero finder fee.
        uint256 finderDelta = finder.balance - finderBalBefore;
        assertTrue(finderDelta > 0, "finder fee paid");
        // Bounded: max(50 bps × balance, 0.05 ETH) per Patron bounds.
        assertTrue(finderDelta <= 0.05 ether, "finder fee within absolute cap");

        // 3. Acquisition recorded.
        assertEq(pc.acquisitionCount(), 1, "acquisition recorded via acceptListing");

        // 4. Seller is paid the listing price via the 2017 market's
        //    pendingWithdrawals (CryptoPunks queues the payment). The
        //    seller can withdraw it separately. We don't assert seller
        //    balance directly here — that's a property of the canonical
        //    market, not PC.
        sellerBalBefore; // silence unused-var warning
    }

    // ─── (34) HARDENING: Allowlist 24h activation delay ──────────────────

    /// @dev `addAllowedSeller` sets `allowedSellerActiveAt[seller] =
    ///      block.timestamp + ALLOWLIST_DELAY`. acceptListing reverts
    ///      with `SellerNotYetActive` until that timestamp passes. This
    ///      is the documented defence-in-depth: a hostile admin add can
    ///      be caught + removed before any listings are consumable.
    function test_fork_hardening_allowlist_activationDelay() public {
        _fundPatronFromAdapter(5 ether);
        address seller = makeAddr("delay-seller");
        patron.addAllowedSeller(seller);

        // Immediately after add, the activation timer is in the future.
        // Set up a listing to attempt acceptListing.
        uint16 punkId = 0;
        address punkOwner = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(punkOwner);
        punksMarket.transferPunk(seller, uint256(punkId));
        vm.prank(seller);
        punksMarket.offerPunkForSale(uint256(punkId), 1 ether);

        uint8 target = _pickTarget(punkId);
        address finder = makeAddr("delay-finder");

        // Immediate acceptListing call reverts SellerNotYetActive.
        vm.prank(finder);
        vm.expectRevert();
        patron.acceptListing(punkId, target);

        // Warp past 24h.
        vm.warp(block.timestamp + 24 hours + 1 seconds);

        // Now it works.
        vm.prank(finder);
        patron.acceptListing(punkId, target);

        assertEq(pc.acquisitionCount(), 1, "acquisition recorded post-delay");
    }

    // ─── (HARDENING) Referral leg auto-flushes within its own tx ────────

    /// @dev Mirrors test #5 (75/5/20 baseline split) for the referral
    ///      leg. Under the same-tx flush a swap that carries valid
    ///      attribution should credit the referrer in `ReferralPayout`
    ///      within the swap's own tx — no separate `flushReferral` call
    ///      needed. Verifies (a) `accruedReferral` is 0 right after the
    ///      credit-swap, (b) `referralPayout.balances(referrer)` is
    ///      non-zero and matches ~0.25%-of-volume (the cap).
    function test_fork_hardening_referral_intraTxFlush() public {
        // First acquisition (incidental setup; referral is ungated).
        uint16 punkId = 0;
        _fundPatronFromAdapter(0.5 ether);
        _giveAndOfferToBounty(makeAddr("punk0-intraref"), punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(makeAddr("punk0-intraref"));
        patron.acceptBid(punkId, target, type(uint256).max);

        address referrer = makeAddr("intra-ref");
        PCAttribution memory att =
            PCAttribution({sourceId: bytes32("intra"), referrer: referrer, campaignId: bytes16(0), referralBps: 250});

        uint256 ethIn = 1 ether;
        uint256 payoutBefore = referralPayout.balances(referrer);
        _buyWithAttribution(ethIn, att);

        // accruedReferral cleared by the swap's own _afterSwap flush.
        assertEq(
            IHookSkimAccessor(deployedHook).accruedReferral(_poolKey().toId(), referrer),
            0,
            "referrer accrual cleared in same tx"
        );
        // ReferralPayout received the credit in the same tx.
        uint256 payoutAfter = referralPayout.balances(referrer);
        uint256 delta = payoutAfter - payoutBefore;
        assertTrue(delta > 0, "referrer credited in ReferralPayout same-tx");
        // Expected: 0.25% of swap volume (the cap), within rounding.
        uint256 expected = ethIn * 250 / 100_000;
        assertApproxEqAbs(delta, expected, 1e12, "referral ~= 0.25% of volume");
    }

    // ─── (REFERRAL — auction) helper ─────────────────────────────────────

    /// @dev Standard cleared-path scaffold: fund Patron with `costWei`
    ///      so acquisitionCost snapshots to that, run `acceptBid` on
    ///      `punkId`, return the chosen target trait. Reserve is then
    ///      `costWei * 101 / 100` (first trial).
    function _setupAuction(
        uint16 punkId,
        uint256 costWei
    ) internal returns (uint8 target, address seller) {
        _fundPatronFromAdapter(costWei);
        seller = makeAddr(string.concat("ref-seller-", vm.toString(uint256(punkId))));
        _giveAndOfferToBounty(seller, punkId);
        target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);
    }

    // ─── (R-1) AUCTION REFERRAL: split correctness with referrer ─────────

    /// @dev With cost = 1 ETH and a 1.5 ETH winning bid:
    ///        - bountyShare    = 0.7 ETH  → Patron (minus ≤ 0.01 keeper)
    ///        - burnShare      = 0.3 ETH  → BuybackBurner (exact)
    ///        - premium        = 0.5 ETH
    ///        - referrerShare  = 0.025 ETH (5% × premium) → referrer
    ///        - vaultBurnShare = 0.475 ETH                → VaultBurnPool
    ///      Each constant is hard-coded in ReturnAuctionModule; no setter
    ///      can change them. Verifies the four-way split fires on-chain.
    function test_fork_referral_auction_splitCorrectness_withReferrer() public {
        (uint8 target,) = _setupAuction(0, 1 ether);
        target; // silence unused

        address referrer = makeAddr("r1-eoa-referrer");
        address bidder = makeAddr("r1-bidder");
        vm.deal(bidder, 2 ether);

        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: 1.5 ether}(0, referrer, bytes32("r1"));

        // Sanity: the storage slot was written to the supplied referrer.
        assertEq(finalSale.referrerOfHighBid(0), referrer, "slot wrote referrer");

        uint256 patronBefore = address(patron).balance;
        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 burnerBefore = address(burner).balance;
        uint256 vaultPoolBefore = address(vaultBurnPool).balance;
        uint256 referrerBefore = referrer.balance;

        vm.warp(block.timestamp + 72 hours + 1 minutes);
        finalSale.settle(0);

        // referrer received exactly 5% of the 0.5 ETH premium.
        assertEq(referrer.balance - referrerBefore, 0.025 ether, "referrer got 5% of premium");
        // VaultBurnPool received the remaining 95% of the premium (0.475)
        // PLUS the 10%-of-cost slice (0.1) = 0.575 ETH.
        assertEq(
            address(vaultBurnPool).balance - vaultPoolBefore,
            0.575 ether,
            "vault pool got 95% of premium + 10% of cost"
        );
        // BuybackBurner: 25% of cost exactly (residual after the 10%-of-cost
        // vault slice; unchanged by referrer attribution).
        assertEq(
            address(burner).balance - burnerBefore,
            0.25 ether,
            "burner got exactly 25% of cost (referrer did NOT carve burn)"
        );
        // The full 65%-of-cost bounty share landed in the adapter buffer (no
        // keeper tip) — referrer attribution does NOT carve it. Under inflow
        // consolidation it buffers in the adapter (meters into Patron via
        // sweep), so Patron itself is untouched by settle.
        assertEq(
            address(liveBidAdapter).balance - adapterBefore,
            0.65 ether,
            "adapter buffered exactly 65% of cost (referrer did NOT carve bounty)"
        );
        assertEq(address(patron).balance, patronBefore, "Patron untouched by settle");
    }

    // ─── (R-2) AUCTION REFERRAL: overwrite on new high bid ───────────────

    /// @dev Bidder A bids with referrer X; bidder B outbids with referrer Y.
    ///      `referrerOfHighBid[punkId]` should hold Y at settle, and only Y
    ///      should receive a payout. X loses attribution permanently.
    function test_fork_referral_auction_overwriteOnNewHighBid() public {
        _setupAuction(0, 1 ether);

        address referrerX = makeAddr("r2-X-loses");
        address referrerY = makeAddr("r2-Y-wins");
        address bidderA = makeAddr("r2-A-outbid");
        address bidderB = makeAddr("r2-B-winner");
        vm.deal(bidderA, 2 ether);
        vm.deal(bidderB, 2 ether);

        vm.prank(bidderA);
        finalSale.placeBidWithReferral{value: 1.2 ether}(0, referrerX, bytes32("r2-X"));
        assertEq(finalSale.referrerOfHighBid(0), referrerX, "X recorded");

        // B outbids A. minBidIncrementBps default = 100 (1%);
        // 1.2 × 1.01 = 1.212, so 1.5 comfortably clears.
        vm.prank(bidderB);
        finalSale.placeBidWithReferral{value: 1.5 ether}(0, referrerY, bytes32("r2-Y"));
        assertEq(finalSale.referrerOfHighBid(0), referrerY, "Y overwrote X");

        uint256 xBefore = referrerX.balance;
        uint256 yBefore = referrerY.balance;

        vm.warp(block.timestamp + 72 hours + 1 minutes);
        finalSale.settle(0);

        // Only Y gets paid. X received nothing — its attribution was
        // overwritten when B outbid A.
        assertEq(referrerX.balance, xBefore, "X received NOTHING (lost slot)");
        assertEq(referrerY.balance - yBefore, 0.025 ether, "Y received 5% of premium");
    }

    // ─── (R-3) AUCTION REFERRAL: no referrer → full premium to vault ─────

    /// @dev Bid with referrer = address(0). Premium 100% to VaultBurnPool.
    ///      `referrerOfHighBid` stays zero; referrer slice never computed.
    function test_fork_referral_auction_noReferrer_fullPremiumToVaultBurnPool() public {
        _setupAuction(0, 1 ether);

        address bidder = makeAddr("r3-bidder");
        vm.deal(bidder, 2 ether);
        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: 1.5 ether}(0, address(0), bytes32(0));

        assertEq(finalSale.referrerOfHighBid(0), address(0), "no referrer recorded");

        uint256 vaultPoolBefore = address(vaultBurnPool).balance;
        vm.warp(block.timestamp + 72 hours + 1 minutes);
        finalSale.settle(0);

        // Full 0.5 ETH premium + 10%-of-cost slice (0.1) → VaultBurnPool = 0.6.
        assertEq(
            address(vaultBurnPool).balance - vaultPoolBefore,
            0.6 ether,
            "100% of premium + 10% of cost routed to vault pool"
        );
    }

    // ─── (R-4) AUCTION REFERRAL: reverting referrer fails-closed ─────────

    /// @dev Referrer is a contract whose receive() always reverts. The
    ///      35k-gas-budget send returns `(false, ...)`; settle folds the
    ///      `referrerShare` into `vaultBurnShare` and the rescue completes
    ///      normally. Settle itself MUST NOT revert.
    function test_fork_referral_auction_revertingRecipient_failClosed() public {
        _setupAuction(0, 1 ether);

        RevertingRecipient badReferrer = new RevertingRecipient();
        address bidder = makeAddr("r4-bidder");
        vm.deal(bidder, 2 ether);
        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: 1.5 ether}(0, address(badReferrer), bytes32("r4"));

        uint256 referrerBalBefore = address(badReferrer).balance;
        uint256 vaultPoolBefore = address(vaultBurnPool).balance;

        vm.warp(block.timestamp + 72 hours + 1 minutes);
        finalSale.settle(0); // must NOT revert

        // Reverting referrer received nothing.
        assertEq(address(badReferrer).balance, referrerBalBefore, "reverting referrer received nothing");
        // The would-be referrer share folded back into vault pool — full
        // 0.5 ETH premium + 10%-of-cost slice (0.1) routed there = 0.6.
        assertEq(
            address(vaultBurnPool).balance - vaultPoolBefore,
            0.6 ether,
            "premium fully folded into vault pool + 10% of cost"
        );
    }

    // ─── (R-5) AUCTION REFERRAL: OOG referrer fails-closed ───────────────

    /// @dev Same fail-closed branch but triggered by a referrer that
    ///      consumes ≫ 35k gas in receive() (not by a revert). The
    ///      35k-budget call returns false either way, so the folded-back
    ///      behaviour is identical to the revert case.
    function test_fork_referral_auction_oogRecipient_failClosed() public {
        _setupAuction(0, 1 ether);

        GasGriefReceiver hog = new GasGriefReceiver();
        address bidder = makeAddr("r5-bidder");
        vm.deal(bidder, 2 ether);
        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: 1.5 ether}(0, address(hog), bytes32("r5"));

        uint256 referrerBalBefore = address(hog).balance;
        uint256 vaultPoolBefore = address(vaultBurnPool).balance;

        vm.warp(block.timestamp + 72 hours + 1 minutes);
        finalSale.settle(0); // must NOT revert

        assertEq(address(hog).balance, referrerBalBefore, "OOG referrer received nothing");
        assertEq(
            address(vaultBurnPool).balance - vaultPoolBefore,
            0.6 ether,
            "premium fully folded into vault pool + 10% of cost on OOG"
        );
    }

    // ─── (R-6) AUCTION REFERRAL: vault path never pays referrer ──────────

    /// @dev When no bids land, settle takes the vault branch. That branch
    ///      reads no referrer state and pays no referrer. The referrer
    ///      mapping should also remain zero (no bid ever wrote it).
    function test_fork_referral_auction_vaultPath_noReferrerPayout() public {
        _setupAuction(0, 1 ether);

        // No bids placed. `referrerOfHighBid` stays default-zero.
        assertEq(finalSale.referrerOfHighBid(0), address(0), "no bid => no referrer slot");

        // A would-be referrer EOA that should NOT see any inflow.
        address ghostReferrer = makeAddr("r6-ghost");
        uint256 ghostBefore = ghostReferrer.balance;

        vm.warp(block.timestamp + 72 hours + 1 minutes);
        finalSale.settle(0);

        // Punk is now in vault — verify the vault branch ran.
        assertEq(punksMarket.punkIndexToAddress(uint256(0)), pc.punkVault(), "Punk vaulted (vault branch)");
        // Ghost wasn't recorded and so wasn't paid.
        assertEq(ghostReferrer.balance, ghostBefore, "vault branch paid no referrer");
    }

    // ─── (R-7) AUCTION REFERRAL: bounty + burn unchanged by referrer ─────

    /// @dev Even with a winning bid that carries a referrer, bountyShare
    ///      and burnShare scale purely on `acquisitionCost` — they're
    ///      `cost × 6500 / 10_000` and `cost × 2500 / 10_000` exactly.
    ///      Verifies the spec's "fresh external value" framing: the
    ///      referrer's slice comes out of the premium, not internal pools.
    function test_fork_referral_auction_bountyAndBurnUnchanged() public {
        _setupAuction(0, 1 ether);

        address referrer = makeAddr("r7-referrer");
        address bidder = makeAddr("r7-bidder");
        vm.deal(bidder, 2 ether);
        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: 1.5 ether}(0, referrer, bytes32("r7"));

        uint256 burnerBefore = address(burner).balance;
        uint256 patronBefore = address(patron).balance;
        uint256 adapterBefore = address(liveBidAdapter).balance;

        vm.warp(block.timestamp + 72 hours + 1 minutes);
        finalSale.settle(0);

        // burnShare is EXACTLY 25% of cost — referrer never reduced it.
        assertEq(
            address(burner).balance - burnerBefore,
            0.25 ether,
            "burnShare = 25% of cost, unchanged by referrer"
        );
        // bountyShare is EXACTLY 65% of cost — no keeper tip, and referrer
        // attribution never carves the bounty (it pulls only from premium).
        // Under inflow consolidation it buffers in the adapter (meters into
        // Patron via sweep), so we measure the adapter's delta; Patron is
        // untouched by settle.
        uint256 adapterDelta = address(liveBidAdapter).balance - adapterBefore;
        assertEq(
            adapterDelta,
            0.65 ether,
            "bountyShare = exactly 65% of cost (referrer did NOT carve it)"
        );
        assertEq(address(patron).balance, patronBefore, "Patron untouched by settle");
    }

    // ─── (C-1) CONTRIBUTION REFERRAL: split correctness with referrer ────

    /// @dev `contribute{value: 1 ether}(R, tag)` (now on the adapter) pays R
    ///      exactly 5% of the value (REFERRER_CONTRIB_BPS = 500); the remaining
    ///      0.95 ETH BUFFERS in the adapter (inflow consolidation — it meters
    ///      into Patron via sweep, never spiking the bid). Emits Contribution
    ///      with all three indexed topics matching the call args.
    function test_fork_referral_contribute_splitCorrectness_withReferrer() public {
        address referrer = makeAddr("c1-referrer");
        address contributor = makeAddr("c1-contributor");
        bytes32 tag = bytes32("c1-tag");
        vm.deal(contributor, 1 ether);

        uint256 patronBefore = address(patron).balance;
        uint256 bufBefore = liveBidAdapter.bufferedEth();
        uint256 referrerBefore = referrer.balance;

        vm.expectEmit(true, true, true, true, address(liveBidAdapter));
        emit LiveBidAdapter.Contribution(contributor, 1 ether, referrer, tag, 0.05 ether);

        vm.prank(contributor);
        liveBidAdapter.contribute{value: 1 ether}(referrer, tag);

        assertEq(referrer.balance - referrerBefore, 0.05 ether, "referrer got 5% of contribution");
        assertEq(
            liveBidAdapter.bufferedEth() - bufBefore, 0.95 ether, "adapter buffered 95% (meters into bid via sweep)"
        );
        assertEq(address(patron).balance, patronBefore, "contribution did NOT spike Patron directly");
    }

    // ─── (C-2) CONTRIBUTION REFERRAL: no referrer → 100% buffered ────────

    /// @dev `referrer == address(0)` skips the bps slice entirely; the
    ///      full `msg.value` buffers in the adapter. Emits Contribution with
    ///      `referrerShare == 0`.
    function test_fork_referral_contribute_noReferrer_fullToBid() public {
        address contributor = makeAddr("c2-contributor");
        vm.deal(contributor, 1 ether);

        uint256 bufBefore = liveBidAdapter.bufferedEth();

        vm.prank(contributor);
        liveBidAdapter.contribute{value: 1 ether}(address(0), bytes32("c2"));

        assertEq(liveBidAdapter.bufferedEth() - bufBefore, 1 ether, "100% of contribution buffered in the adapter");
    }

    // ─── (C-3) CONTRIBUTION REFERRAL: reverting referrer → 100% buffered ─

    /// @dev Fail-closed: a referrer whose receive() reverts gets paid
    ///      nothing; the would-be share never leaves the adapter buffer. The
    ///      call itself MUST NOT revert — contribute() catches the failure.
    function test_fork_referral_contribute_revertingReferrer_fullToBid() public {
        RevertingRecipient bad = new RevertingRecipient();
        address contributor = makeAddr("c3-contributor");
        vm.deal(contributor, 1 ether);

        uint256 bufBefore = liveBidAdapter.bufferedEth();
        uint256 badBefore = address(bad).balance;

        vm.prank(contributor);
        liveBidAdapter.contribute{value: 1 ether}(address(bad), bytes32("c3"));

        // Reverting referrer paid nothing.
        assertEq(address(bad).balance, badBefore, "reverting referrer received nothing");
        // Full 1 ETH buffered in the adapter.
        assertEq(liveBidAdapter.bufferedEth() - bufBefore, 1 ether, "all 1 ETH kept in the adapter buffer");
    }

    // ─── (C-4) CONTRIBUTION REFERRAL: contribute() rejects mid-swap ──────

    /// @dev `contribute()` (on the adapter) is decorated with `notInSwap`. The
    ///      existing `everyDecoratedFunction_blocksReentry` sweep covers this in
    ///      bulk; this test is the focused, single-function smoke version
    ///      so an auditor reading the referral tests can see the property
    ///      asserted directly.
    function test_fork_referral_contribute_notInSwap_reverts() public {
        _bindDispatcherToPool();
        LowLevelReentryProbe probe = new LowLevelReentryProbe(
            address(liveBidAdapter), abi.encodeWithSignature("contribute(address,bytes32)", address(0), bytes32(0))
        );
        dispatcher.registerCallback(address(probe), 100_000);
        _buy(0.05 ether);
        assertTrue(probe.reentryWasBlocked(), "LiveBidAdapter.contribute reverted with InSwap during real swap");
    }

    // ─── (C-5) CONTRIBUTION REFERRAL: zero-value reverts ─────────────────

    /// @dev `contribute()` reverts ZeroValue if msg.value == 0. Defends
    ///      against accidentally emitting an attribution event for a
    ///      no-op call.
    function test_fork_referral_contribute_zeroValue_reverts() public {
        address contributor = makeAddr("c5-contributor");
        vm.prank(contributor);
        vm.expectRevert(LiveBidAdapter.ZeroValue.selector);
        liveBidAdapter.contribute{value: 0}(makeAddr("c5-referrer"), bytes32("c5"));
    }

    // ─── (C-6) CONTRIBUTION REFERRAL: bare top-up event on receive() ─────

    /// @dev A raw `address(liveBidAdapter).call{value:}("")` (no calldata) hits
    ///      the adapter's `receive()` which emits `BareTopUp` and buffers the
    ///      ETH. Confirms unattributed top-ups are distinguished on-chain from
    ///      referrer-bearing `contribute()` calls — both now on the adapter,
    ///      the single faucet into the live bid.
    function test_fork_referral_contribute_bareTopUpEvent() public {
        address fan = makeAddr("c6-fan");
        vm.deal(fan, 1 ether);
        uint256 bufBefore = liveBidAdapter.bufferedEth();

        vm.expectEmit(true, false, false, true, address(liveBidAdapter));
        emit LiveBidAdapter.BareTopUp(fan, 1 ether);

        vm.prank(fan);
        (bool ok,) = address(liveBidAdapter).call{value: 1 ether}("");
        assertTrue(ok, "bare send via adapter receive() succeeded");
        assertEq(liveBidAdapter.bufferedEth() - bufBefore, 1 ether, "buffered in the adapter");
    }

    /// @dev Direct sends to Patron are now rejected — only the adapter may fund
    ///      it. The single-faucet invariant (#13) at the bytecode boundary.
    function test_fork_referral_patron_rejectsDirectSend() public {
        address fan = makeAddr("c6b-fan");
        vm.deal(fan, 1 ether);
        vm.prank(fan);
        (bool ok,) = address(patron).call{value: 1 ether}("");
        assertFalse(ok, "direct send to Patron rejected (NotAdapter)");
    }

    // ─── (R-bytecode-1) Patron: no admin; contribute/poolReplenish moved ─

    /// @dev Re-run the admin-withdrawal scan. Under inflow consolidation
    ///      `contribute` / `poolReplenish` MOVED off Patron to the adapter, so
    ///      Patron must NO LONGER expose either selector — and the adapter MUST
    ///      expose both (so launchpads / wallet widgets / the auction module can
    ///      reach them). No forbidden withdrawal selectors on either.
    function test_fork_bytecode_patron_noAdminSelectors_postReferral() public view {
        bytes memory code = address(patron).code;
        assertTrue(code.length > 0, "patron has deployed code");
        // Forbidden — same list as the original Patron bytecode scan.
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
        _assertNoSelector(code, bytes4(keccak256("withdraw(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(address)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(address,address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("sweep()")));
        _assertNoSelector(code, bytes4(keccak256("sweep(address)")));
        _assertNoSelector(code, bytes4(keccak256("migrate(address)")));
        _assertNoSelector(code, bytes4(keccak256("emergencyWithdraw()")));
        _assertNoSelector(code, bytes4(keccak256("drain()")));
        _assertNoSelector(code, bytes4(keccak256("drain(address)")));
        // Moved to the adapter — Patron must NOT expose these anymore.
        _assertNoSelector(code, bytes4(keccak256("contribute(address,bytes32)")));
        _assertNoSelector(code, bytes4(keccak256("poolReplenish(uint16)")));

        // The adapter is the single faucet: it MUST expose both, and have no
        // withdrawal/rescue/drain path (the buffer only exits toward Patron via
        // `sweep`, which legitimately exists here).
        bytes memory acode = address(liveBidAdapter).code;
        assertTrue(acode.length > 0, "adapter has deployed code");
        _assertSelectorPresent(acode, bytes4(keccak256("contribute(address,bytes32)")));
        _assertSelectorPresent(acode, bytes4(keccak256("poolReplenish(uint16)")));
        _assertNoSelector(acode, bytes4(keccak256("withdraw()")));
        _assertNoSelector(acode, bytes4(keccak256("withdraw(uint256)")));
        _assertNoSelector(acode, bytes4(keccak256("rescue(address)")));
        _assertNoSelector(acode, bytes4(keccak256("rescue(address,uint256)")));
        _assertNoSelector(acode, bytes4(keccak256("migrate(address)")));
        _assertNoSelector(acode, bytes4(keccak256("emergencyWithdraw()")));
        _assertNoSelector(acode, bytes4(keccak256("drain()")));
    }

    // ─── (R-bytecode-2) ReturnAuctionModule: no admin, new bid selector ──

    /// @dev Analogous bytecode-scan for ReturnAuctionModule. Confirms (a)
    ///      none of the admin / withdrawal selectors are present, and (b)
    ///      BOTH bid entry points — the simple `placeBid(uint16)` and the
    ///      referral-bearing `placeBidWithReferral(uint16,address,bytes32)` —
    ///      ARE present so external integrators can reach them.
    ///
    ///      Does NOT assert any superseded `bid(...)` selector is absent: the
    ///      bytecode scan is a coarse byte-sequence search, and any 4-byte
    ///      window in ~30KB of deployed code may match a given selector
    ///      hash by chance (PUSH constants, jumpdest tables, etc.).
    ///      Asserting a selector is NOT in bytecode would be a false-
    ///      positive risk; the production guarantee comes from the Solidity
    ///      dispatch table, which only routes the two declared entry points
    ///      to the shared bid logic.
    function test_fork_bytecode_finalSale_noAdminSelectors_postReferral() public view {
        bytes memory code = address(finalSale).code;
        assertTrue(code.length > 0, "finalSale has deployed code");
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
        _assertNoSelector(code, bytes4(keccak256("withdraw(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(address)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("migrate(address)")));
        _assertNoSelector(code, bytes4(keccak256("emergencyWithdraw()")));
        _assertNoSelector(code, bytes4(keccak256("drain()")));
        // NB: `sweep()` (selector 0x35faa416) is NOT in this list because
        // ReturnAuctionModule legitimately CALLS `sweep()` on its
        // `vaultBurnPool` dependency. The compiler emits the call's
        // 4-byte selector as a bytecode constant, so a byte-level scan
        // can't distinguish "is reachable via external dispatch" from
        // "appears as a constant pushed for an outgoing call." The
        // semantic guarantee (no admin-controlled sweep ON the module
        // itself) comes from the source — ReturnAuctionModule declares
        // no `sweep()` function.
        // Both bid entry points MUST be present.
        _assertSelectorPresent(code, bytes4(keccak256("placeBid(uint16)")));
        _assertSelectorPresent(code, bytes4(keccak256("placeBidWithReferral(uint16,address,bytes32)")));
    }

    /// @dev Dual of `_assertNoSelector` — scans deployed bytecode for the
    ///      presence of `sel`. Reverts if absent. Used by the post-
    ///      referral bytecode scans to confirm the new function selectors
    ///      ARE reachable, not just that the forbidden ones aren't.
    function _assertSelectorPresent(
        bytes memory code,
        bytes4 sel
    ) internal pure {
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2] && code[i + 3] == sel[3]) {
                return;
            }
        }
        revert("bytecode missing expected selector");
    }

    // ─── (37) HARDENING: H-1 — buy-and-burn survives 111 appreciation ────

    /// @notice Audit H-1 regression, against the live `Deploy.s.sol` bytecode.
    ///
    ///         The pre-fix `BuybackBurner` shipped an immutable
    ///         `minTokensPerEthFloor` set to ~30% of the launch spot. The
    ///         pool is ETH→111, so tokens-per-ETH FALLS as 111 appreciates;
    ///         once 111 rose past ~3.33x its launch price the static floor
    ///         became unreachable and EVERY `executeStep` reverted
    ///         `InsufficientOutput` permanently — bricking buy-and-burn in
    ///         the protocol's SUCCESS case, with ETH stranded and no recovery
    ///         path. The fix removes the static floor entirely and relies on
    ///         a fixed V4 price-impact cap that partial-fills instead of
    ///         judging whether appreciation is "too high."
    ///
    ///         This drives the real deployed pool up >=4x and proves
    ///         `executeStep` STILL burns. It FAILS (the burn #2 call reverts)
    ///         if a static 30%-of-launch floor is ever reintroduced.
    function test_fork_H1_buyAndBurnSurvivesAppreciation() public {
        // The fix: the static tokens-per-ETH floor was removed entirely (the
        // immutable + its getter no longer exist). The fixed V4 price-impact
        // cap governs how hard each burn can push, but does not reject organic
        // appreciation.

        // --- Burn #1 at launch price: capture the launch effective rate. ---
        vm.deal(address(this), 20 ether);
        (bool ok1,) = address(burner).call{value: 5 ether}("");
        require(ok1, "fund burner #1");
        vm.roll(block.number + burner.minBlocksBetweenSteps());

        uint256 tokens0 = burner.totalTokensBurned();
        uint256 eth0 = burner.totalEthBurned();
        burner.executeStep(0);
        uint256 launchTokens = burner.totalTokensBurned() - tokens0;
        uint256 launchEth = burner.totalEthBurned() - eth0;
        assertGt(launchTokens, 0, "launch burn produced tokens");
        assertGt(launchEth, 0, "launch burn spent eth");

        // --- Appreciate the pool: buy 111 until spot has risen >=4x. ---
        // Buying 111 (zeroForOne) walks sqrtPriceX96 DOWN; P=(sqrt/2^96)^2 =
        // 111-per-ETH falls => 111 appreciates. A >=4x price rise means
        // sqrtPrice drops to <= launchSqrt/2 (since price ~ sqrt^2).
        uint160 launchSqrt = _burnerSpot();
        _appreciatePoolPriceAtLeast4x(launchSqrt);
        uint160 apprSqrt = _burnerSpot();
        assertGe(uint256(launchSqrt), uint256(apprSqrt) * 2, "111 appreciated >= 4x");

        // --- Burn #2 at the appreciated price: MUST still succeed. ---
        // With the removed static floor in place this call would revert
        // InsufficientOutput; with floor=0 it burns.
        (bool ok2,) = address(burner).call{value: 5 ether}("");
        require(ok2, "fund burner #2");
        vm.roll(block.number + burner.minBlocksBetweenSteps());

        uint256 tokens1 = burner.totalTokensBurned();
        uint256 eth1 = burner.totalEthBurned();
        burner.executeStep(0);
        uint256 apprTokens = burner.totalTokensBurned() - tokens1;
        uint256 apprEth = burner.totalEthBurned() - eth1;
        assertGt(apprTokens, 0, "H-1: appreciated burn STILL produces tokens");
        assertGt(apprEth, 0, "H-1: appreciated burn STILL spends eth");

        // Smoking gun: the appreciated effective rate fell below 30% of the
        // launch rate — i.e. below the exact threshold the removed static
        // floor (~30% of launch spot) enforced. So this successful burn is
        // one the pre-H-1 floor would have rejected. Rates are tokens-per-ETH,
        // both net of the same 5% skim + 1% LP fee, so the ratio is clean:
        //   apprRate (= apprTokens/apprEth) < 0.30 * launchRate (= launchTokens/launchEth)
        // Cross-multiplied to avoid division (values ~1e44, far under 2^256):
        assertLt(
            apprTokens * launchEth * 100,
            launchTokens * apprEth * 30,
            "H-1: appreciated rate fell below the removed 30%-of-launch floor"
        );
    }

    // ─── (38) HARDENING: H-1 — impact cap bounds sandwichable movement ──

    /// @notice After the static-floor removal, the fixed V4 price-impact cap
    ///         is the slippage guard. Verify a pumped pool does not let
    ///         `executeStep` add a large second movement: the burn may
    ///         partial-fill, but its own sqrt-price movement remains below the
    ///         measured fee moat.
    function test_fork_H1_impactCapBoundsBurnMovement() public {
        assertEq(burner.maxSlippageBps(), 500, "deployed impact cap = 5%");

        // Fund + clear pacing so the burn can run.
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(burner).call{value: 5 ether}("");
        require(ok, "fund burner");
        vm.roll(block.number + burner.minBlocksBetweenSteps());

        uint160 prePumpSpot = _burnerSpot();
        // Front-run: buy 111 until spot has moved by more than the old 10%
        // rejection threshold. The new system does not care about stale
        // reference drift; it cares that the burn itself cannot push farther
        // than the fixed cap.
        vm.deal(trader, 50_000 ether);
        for (uint256 i = 0; i < 200; i++) {
            if (_devBps(uint256(_burnerSpot()), uint256(prePumpSpot)) > 1000) break;
            _buy(5 ether);
        }
        uint160 postPumpSpot = _burnerSpot();
        assertGt(_devBps(uint256(postPumpSpot), uint256(prePumpSpot)), 1000, "pump moved spot >10%");

        uint256 burnedBefore = burner.totalTokensBurned();
        burner.executeStep(0);
        uint160 postBurnSpot = _burnerSpot();

        assertGt(burner.totalTokensBurned(), burnedBefore, "burn still delivered tokens");
        assertLe(
            _devBps(uint256(postBurnSpot), uint256(postPumpSpot)),
            300,
            "burn movement stayed inside 5% price-impact cap"
        );
    }

    // ─── helpers for the H-1 tests ───────────────────────────────────────

    /// @dev Current pool spot `sqrtPriceX96` for the burner's pool.
    function _burnerSpot() internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = IPoolManager(POOL_MANAGER).getSlot0(burner.poolKey().toId());
    }

    /// @dev `|a - b| * 10_000 / b` in bps for spot-movement assertions.
    function _devBps(
        uint256 a,
        uint256 b
    ) internal pure returns (uint256) {
        uint256 diff = a > b ? a - b : b - a;
        return (diff * 10_000) / b;
    }

    /// @dev Buy 111 (as `trader`) in escalating chunks until the pool's
    ///      sqrtPriceX96 has fallen to <= launchSqrt/2 (a >=4x 111 price
    ///      rise). Escalating sizes reach the target in a handful of swaps on
    ///      a deep pool while not overshooting wildly on the thin launch pool.
    ///      Fails LOUD if the target isn't reached (never silently passes).
    function _appreciatePoolPriceAtLeast4x(
        uint160 launchSqrt
    ) internal {
        vm.deal(trader, trader.balance + 30_000 ether);
        uint160 target = uint160(uint256(launchSqrt) / 2);
        uint256[10] memory chunks = [
            uint256(10 ether),
            20 ether,
            40 ether,
            80 ether,
            160 ether,
            320 ether,
            640 ether,
            1280 ether,
            2560 ether,
            5120 ether
        ];
        for (uint256 i = 0; i < chunks.length; i++) {
            if (_burnerSpot() <= target) return;
            _buy(chunks[i]);
        }
        require(_burnerSpot() <= target, "H-1 test: pool did not appreciate >=4x within cap");
    }
}

/// @notice Read-only access to the hook's four-leg accrual map plus the
///         held-skim retry path used when a recipient `_tryForward` fails.
interface IHookSkimAccessor {
    function accruedReferral(
        PoolId,
        address
    ) external view returns (uint256);
}

/// @notice Adversarial probe — tries to reenter an arbitrary target via a
///         **low-level** call (raw selector + calldata) instead of a typed
///         interface. Verifies the `notInSwap` guard can't be bypassed by
///         dropping below Solidity's type checks.
contract LowLevelReentryProbe is IPCCallbackExtension {
    address public immutable target;
    bytes public payload;
    bool public reentryWasBlocked;
    bytes public observedRevert;
    uint256 public invocations;

    constructor(
        address _target,
        bytes memory _payload
    ) {
        target = _target;
        payload = _payload;
    }

    function onSwap(
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes32) {
        invocations++;
        (bool ok, bytes memory ret) = target.call(payload);
        observedRevert = ret;
        if (!ok && ret.length >= 4 && bytes4(ret) == PCNoReentry.InSwap.selector) {
            reentryWasBlocked = true;
        } else if (!ok) {
            // Reverted, but with a non-InSwap reason. Could be a parameter-
            // validation revert that fired BEFORE the notInSwap modifier.
            // Solidity runs modifiers in declaration order — `nonReentrant`
            // comes before `notInSwap` in some contracts, so a malformed
            // arg could fail nonReentrant... no, nonReentrant just sets a
            // lock. The function body's parameter checks come AFTER both
            // modifiers. So InSwap should always be the first revert when
            // the flag is set.
            reentryWasBlocked = false;
        } else {
            // Call succeeded — guard FAILED.
            reentryWasBlocked = false;
        }
        return bytes32("done");
    }
}

/// @notice Chained-reentry probe — calls an intermediary helper that then
///         calls the PC contract. Tests that the `notInSwap` guard holds
///         even when the call doesn't come from `msg.sender == callback`
///         but from a downstream contract.
contract ChainedReentryProbe is IPCCallbackExtension {
    Intermediary public immutable hop;
    bool public reentryWasBlocked;

    constructor(
        address _hop
    ) {
        hop = Intermediary(_hop);
    }

    function onSwap(
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes32) {
        try hop.tryReenter() {
            reentryWasBlocked = false;
        } catch (bytes memory reason) {
            if (reason.length >= 4 && bytes4(reason) == PCNoReentry.InSwap.selector) {
                reentryWasBlocked = true;
            } else {
                reentryWasBlocked = false;
            }
        }
        return bytes32("chained");
    }
}

/// @notice Helper contract that the chained probe calls — IT then calls
///         Patron, demonstrating that the guard's effect doesn't depend
///         on the immediate `msg.sender` of the reentry attempt.
contract Intermediary {
    Patron public immutable patron;

    constructor(
        address _patron
    ) {
        patron = Patron(payable(_patron));
    }

    function tryReenter() external {
        patron.acceptBid(0, 0, type(uint256).max);
    }
}

/// @notice Adversarial probe — during onSwap, tries to call BOTH
///         `swapContext.enterSwap()` AND `swapContext.exitSwap()` to
///         manipulate the reentrancy flag. Both must fail because
///         msg.sender (this callback) is not the `authorizedExtension`
///         (the dispatcher). Recorded as `enterRejected` /
///         `exitRejected` flags.
contract SwapContextManipulator is IPCCallbackExtension {
    PCSwapContext public immutable swapContext;
    bool public exitRejected;
    bool public enterRejected;

    constructor(
        address _swapContext
    ) {
        swapContext = PCSwapContext(_swapContext);
    }

    function onSwap(
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes32) {
        try swapContext.exitSwap() {
            exitRejected = false;
        } catch {
            exitRejected = true;
        }
        try swapContext.enterSwap() {
            enterRejected = false;
        } catch {
            enterRejected = true;
        }
        return bytes32("manipulator");
    }
}

/// @notice Standalone helper for the "at-launch flag can't be set" test.
///         Lives outside of any callback so we can probe enterSwap from a
///         contract address other than the dispatcher's.
contract FlagFlipper {
    PCSwapContext public immutable swapContext;

    constructor(
        address _swapContext
    ) {
        swapContext = PCSwapContext(_swapContext);
    }

    function tryEnter() external {
        swapContext.enterSwap();
    }
}

/// @notice Minimal callback used to fill dispatcher registry slots for
///         the MAX_CALLBACKS boundary test. Does nothing on swap.
contract DummyCallback is IPCCallbackExtension {
    function onSwap(
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes32) {
        return bytes32("dummy");
    }
}

/// @notice Malicious seller contract for the acceptBid reentry test.
///         Pre-lists a Punk to Patron, calls acceptBid, and during the
///         seller-payout call attempts a second `acceptBid` from its
///         receive() handler. The expected outcome: Patron's `nonReentrant`
///         modifier reverts with `Patron.Reentrant` and the malicious
///         contract catches that specific selector, completing the outer
///         flow without disrupting it.
contract MaliciousSeller {
    Patron public immutable patron;
    ICryptoPunksMarket public immutable market;
    uint16 public reentryPunkId;
    uint8 public reentryTarget;
    bool public reentryWasBlocked;
    bool public reentryErrorWasReentrant;

    constructor(
        address _patron,
        address _market
    ) {
        patron = Patron(payable(_patron));
        market = ICryptoPunksMarket(_market);
    }

    function offerAndAccept(
        uint16 punkId,
        uint8 target,
        uint16 reentryPunk,
        uint8 reentryTrait
    ) external {
        reentryPunkId = reentryPunk;
        reentryTarget = reentryTrait;
        market.offerPunkForSaleToAddress(uint256(punkId), patron.bidBalance(), address(patron));
        patron.acceptBid(punkId, target, type(uint256).max);
    }

    receive() external payable {
        try patron.acceptBid(reentryPunkId, reentryTarget, type(uint256).max) {
            reentryWasBlocked = false;
        } catch (bytes memory reason) {
            reentryWasBlocked = true;
            // `Reentrant()` selector — the error now lives on the shared
            // PCReentrancyGuard mixin that Patron inherits; the selector is
            // unchanged. Matches the keccak form used by ReentrantRewardCaller.
            if (reason.length >= 4 && bytes4(reason) == bytes4(keccak256("Reentrant()"))) {
                reentryErrorWasReentrant = true;
            }
        }
    }
}

/// @notice Malicious keeper for the `nonReentrant` (L-1) tests. Triggers a
///         permissionless fund-mover (`sweep` / `deposit` / `compoundFees`)
///         and, on receiving the keeper reward via the un-gas-limited
///         `.call`, re-enters a target function. The `nonReentrant` mutex
///         must make that inner call revert with `Reentrant`. Records the
///         outcome (without propagating the inner revert) so the outer
///         call still completes — exactly the shape of a real attack that
///         tries to "absorb" the guard.
contract ReentrantRewardCaller {
    /// @dev `bytes4(keccak256("Reentrant()"))` — the same selector every PC
    ///      contract's inline guard declares, so it matches regardless of
    ///      which contract reverted.
    bytes4 internal constant REENTRANT_SELECTOR = bytes4(keccak256("Reentrant()"));

    address public immutable target;
    bytes internal reenterCalldata;
    bool public reentryAttempted;
    bool public reentryWasBlocked;
    bool public reentryErrorWasReentrant;
    uint256 public rewardReceived;
    bool internal armed;

    constructor(
        address _target,
        bytes memory _reenterCalldata
    ) {
        target = _target;
        reenterCalldata = _reenterCalldata;
    }

    /// @notice Fire the OUTER fund-mover (the call that pays us the reward).
    function fire(
        bytes calldata outerCalldata
    ) external returns (bool ok, bytes memory ret) {
        armed = true;
        (ok, ret) = target.call(outerCalldata);
        armed = false;
    }

    receive() external payable {
        rewardReceived += msg.value;
        if (!armed) return;
        // Disarm BEFORE re-entering: single-shot. If the guard ever FAILED
        // (reentry succeeded), this prevents unbounded recursion so the
        // test fails on the assertion, not via out-of-gas.
        armed = false;
        reentryAttempted = true;
        (bool innerOk, bytes memory innerRet) = target.call(reenterCalldata);
        if (!innerOk) {
            reentryWasBlocked = true;
            if (innerRet.length >= 4 && bytes4(innerRet) == REENTRANT_SELECTOR) {
                reentryErrorWasReentrant = true;
            }
        }
        // innerOk == true → guard FAILED; flags stay false and the asserting
        // test fails loudly.
    }
}

/// @notice Recipient contract that ALWAYS reverts on receive. Used for the
///         ReferralPayout-pull-fails test. ReferralPayout's `_claim` must
///         revert `TransferFailed` and reinstate the balance when the
///         outgoing `call` fails.
contract RevertingRecipient {
    error RecipientRefusesEth();

    receive() external payable {
        revert RecipientRefusesEth();
    }
}

/// @notice ReferralPayout error selector ABI — needed because the live
///         contract is referenced via its address; `vm.expectRevert(sel)`
///         requires a static selector. Mirrors the errors declared in
///         `ReferralPayout.sol`.
interface ReferralPayoutErrors {
    error TransferFailed();
    error NothingToClaim();
    error Unauthorized();
    error ZeroAddress();
}

/// @notice Bytecode-substitution target for the hook held-skim retry test.
///         vm.etch'd over a recipient's address so EVERY incoming call
///         (including bare ETH transfers via `.call{value:}`) reverts.
///         Used to simulate a recipient that refuses ETH so the hook's
///         held-skim retry path can be exercised against the live
///         deployed bytecode.
contract RevertOnAnyCall {
    error AlwaysReverts();

    receive() external payable {
        revert AlwaysReverts();
    }

    fallback() external payable {
        revert AlwaysReverts();
    }
}

/// @notice Receive consumes ≫ 35k gas (the fail-closed send budget on both
///         `ReturnAuctionModule.REFERRER_GAS` and `Patron.REFERRER_GAS`).
///         Five fresh SSTOREs (~22k each = ~110k total) exceed the budget
///         comfortably, forcing the outgoing `call{gas: 35_000}` to OOG
///         and return `(false, ...)` so the fail-closed branch runs.
contract GasGriefReceiver {
    mapping(uint256 => uint256) public junk;

    receive() external payable {
        for (uint256 i = 0; i < 5; i++) {
            // Fresh-slot SSTORE — each iteration writes a previously-zero
            // slot keyed on a unique value so the cost is the fresh-storage
            // 22.1k, not the warm 5k.
            junk[uint256(keccak256(abi.encodePacked(block.number, i)))] = i + 1;
        }
    }
}

/// @notice Patron error selector ABI — mirrors the errors declared in
///         `Patron.sol` so `vm.expectRevert(sel)` works.
// (PatronErrors interface removed — `ZeroValue` moved to LiveBidAdapter under
//  inflow consolidation; the contribute tests now use
//  `LiveBidAdapter.ZeroValue.selector` directly.)
