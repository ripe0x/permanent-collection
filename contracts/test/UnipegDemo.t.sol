// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

import {PCSwapContext} from "../src/PCSwapContext.sol";
import {PCNoReentry} from "../src/libraries/PCNoReentry.sol";
import {Patron} from "../src/Patron.sol";
import {
    PCSwapData,
    PCAttribution
} from "artcoins/hooks/interfaces/IArtCoinsHookSkimFee.sol";

import {UnipegDispatcher} from "./mocks/UnipegDispatcher.sol";
import {UnipegArt} from "./mocks/UnipegArt.sol";
import {IPCCallbackExtension} from "../src/interfaces/IPCCallbackExtension.sol";

/// @title  UnipegDemoTest
/// @notice Exercises the Design B path end-to-end with a mocked hook:
///         deploy `PCSwapContext`, the `UnipegDispatcher`, and the
///         `UnipegArt` callback; authorize the dispatcher on the context;
///         register the callback; invoke `afterSwap` as if from the hook;
///         and verify
///           1. the callback fired and emitted its `UnipegMinted` event
///           2. `inSwap()` was set during the callback (and cleared after)
///           3. a callback that tries to reenter a `notInSwap`-decorated
///              PC contract reverts; the dispatcher absorbs the revert
///              via try/catch
///           4. a callback that hangs is gas-capped: it fails but the
///              dispatcher loop continues to subsequent callbacks
contract UnipegDemoTest is Test {
    // ─── deployed harness ────────────────────────────────────────────────

    PCSwapContext internal swapContext;
    UnipegDispatcher internal dispatcher;
    UnipegArt internal art;

    /// @dev Stand-in for the artcoins hook — only used to identify who is
    ///      allowed to call the dispatcher's afterSwap.
    address internal hookEoa = address(0xbeef);

    address internal owner;

    function setUp() public {
        owner = address(this);
        swapContext = new PCSwapContext(owner);
        dispatcher = new UnipegDispatcher(hookEoa, address(swapContext), owner);
        art = new UnipegArt();

        // Authorize the dispatcher to toggle the in-swap flag, and register
        // the art callback.
        swapContext.setAuthorizedExtension(address(dispatcher));
        dispatcher.registerCallback(address(art), 100_000);
    }

    // ─── helpers ─────────────────────────────────────────────────────────

    function _poolKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(0xc01)),
            fee: 0x800000,
            tickSpacing: 200,
            hooks: IHooks(hookEoa)
        });
    }

    function _attribution(bytes32 sourceId, address referrer)
        internal
        pure
        returns (bytes memory)
    {
        PCSwapData memory psd = PCSwapData({
            attribution: PCAttribution({
                sourceId: sourceId,
                referrer: referrer,
                campaignId: bytes16(0),
                referralBps: 0
            }),
            extensionPayload: ""
        });
        return abi.encode(psd);
    }

    function _swap(bytes memory poolExtensionSwapData) internal {
        PoolKey memory pk = _poolKey();
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(1 ether),
            sqrtPriceLimitX96: 0
        });
        BalanceDelta delta = toBalanceDelta(int128(-int256(1 ether)), int128(int256(5 ether)));
        vm.prank(hookEoa);
        dispatcher.afterSwap(pk, params, delta, false, poolExtensionSwapData);
    }

    // ─── tests ───────────────────────────────────────────────────────────

    function test_callbackFires_andMintsUnipeg() public {
        bytes32 sourceId = bytes32(uint256(uint160(address(0xabcdef))));
        bytes memory data = _attribution(sourceId, address(0x123));

        assertEq(art.unipegsForSource(sourceId), 0, "no unipegs at start");
        // tx.origin in tests defaults to DefaultSender. Capture it for the
        // post-swap assertion.
        address swapper = tx.origin;

        _swap(data);

        assertEq(art.unipegsForSource(sourceId), 1, "one unipeg minted");
        uint24 latest = art.latestUnipeg(sourceId, swapper);
        assertTrue(latest != 0, "unipeg color set");
    }

    function test_inSwapFlag_setDuringCallback_clearedAfter() public {
        // Register a recording callback that snapshots inSwap() during onSwap.
        RecordingCallback rec = new RecordingCallback(address(swapContext));
        dispatcher.registerCallback(address(rec), 100_000);

        assertFalse(swapContext.inSwap(), "flag clear before swap");
        _swap(_attribution(bytes32("src1"), address(0)));

        assertTrue(rec.observedInSwap(), "flag was true during callback");
        assertFalse(swapContext.inSwap(), "flag clear after swap");
    }

    function test_reentryFromCallback_reverts_butLoopContinues() public {
        // Deploy a malicious callback that tries to call into a
        // PC-decorated contract during onSwap. PCNoReentry's `notInSwap`
        // modifier on Patron should make that revert. The dispatcher's
        // try/catch then logs the failure and continues to the next
        // callback (UnipegArt) — proving the protection holds AND that
        // failure is isolated.
        Patron patron = new Patron(
            address(0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB), // any non-zero
            address(0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C),
            address(0xa0001),
            address(swapContext)
        );

        ReentrantCallback evil = new ReentrantCallback(address(patron));
        dispatcher.registerCallback(address(evil), 100_000);

        // Make sure UnipegArt counter is at 0 baseline.
        bytes32 sourceId = bytes32("evil-test");
        assertEq(art.unipegsForSource(sourceId), 0);

        _swap(_attribution(sourceId, address(0)));

        // The evil callback's attempt at Patron.acceptBid reverted with
        // PCNoReentry.InSwap. UnipegArt's callback still ran:
        assertEq(art.unipegsForSource(sourceId), 1, "art callback still ran");
        // And the flag is properly cleared:
        assertFalse(swapContext.inSwap(), "flag clear after isolated failure");
    }

    function test_gasGriefingCallback_failsAndLoopContinues() public {
        GasHogCallback hog = new GasHogCallback();
        dispatcher.registerCallback(address(hog), 50_000);

        bytes32 sourceId = bytes32("hog-test");
        _swap(_attribution(sourceId, address(0)));

        // UnipegArt callback still ran despite the hog:
        assertEq(art.unipegsForSource(sourceId), 1, "art ran past hog");
        assertFalse(swapContext.inSwap());
    }

    function test_dispatcher_swapContextLocked_disablesFutureRebind() public {
        swapContext.lockAuthorizedExtension();
        // Owner can no longer change the authorized extension.
        vm.expectRevert(PCSwapContext.AuthorizedExtensionAlreadyLocked.selector);
        swapContext.setAuthorizedExtension(address(0xdead));
    }

    function test_unauthorizedHookCannotInvokeAfterSwap() public {
        bytes memory data = _attribution(bytes32("src"), address(0));
        // Caller != hookEoa → reverts.
        vm.expectRevert(UnipegDispatcher.OnlyHook.selector);
        PoolKey memory pk = _poolKey();
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(1 ether),
            sqrtPriceLimitX96: 0
        });
        dispatcher.afterSwap(pk, params, toBalanceDelta(0, 0), false, data);
    }
}

/// @dev Records the value of `swapContext.inSwap()` at the moment it's
///      called. Lets the test assert the flag was set during the callback.
contract RecordingCallback is IPCCallbackExtension {
    PCSwapContext public immutable swapContext;
    bool public observedInSwap;

    constructor(address _swapContext) {
        swapContext = PCSwapContext(_swapContext);
    }

    function onSwap(
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes32) {
        observedInSwap = swapContext.inSwap();
        return bytes32("ok");
    }
}

/// @dev Tries to reenter a PC contract during the swap. PC's `notInSwap`
///      modifier should revert it.
contract ReentrantCallback is IPCCallbackExtension {
    address public immutable patron;

    constructor(address _patron) {
        patron = _patron;
    }

    function onSwap(
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes32) {
        // Try Patron.acceptBid — should revert with PCNoReentry.InSwap.
        Patron(payable(patron)).acceptBid(0, 0, type(uint256).max);
        return bytes32("should never reach");
    }
}

/// @dev Consumes its full gas budget. Tests that the dispatcher's per-call
///      gas cap contains the damage and the loop continues.
contract GasHogCallback is IPCCallbackExtension {
    function onSwap(
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes32) {
        uint256 sum;
        // Loop until out of gas — the dispatcher's `try ... {gas: budget}`
        // catches the OOG.
        for (uint256 i; i < type(uint256).max; i++) {
            sum += i;
        }
        return bytes32(sum);
    }
}
