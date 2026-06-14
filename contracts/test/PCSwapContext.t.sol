// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PCSwapContext} from "../src/PCSwapContext.sol";

/// @dev Test-only harness that exposes the `internal constant INSWAP_SLOT`
///      so a unit test can assert the hand-inlined literal matches its
///      documented keccak seed. The literal must stay inline in the contract
///      (`tstore`/`tload` only accept a literal slot argument), so this is the
///      only way to pin it to a reproducible derivation.
contract PCSwapContextSlotHarness is PCSwapContext {
    constructor(address _owner) PCSwapContext(_owner) {}

    function inswapSlot() external pure returns (uint256) {
        return INSWAP_SLOT;
    }
}

/// @notice Non-fork unit tests for `PCSwapContext`. The headline test pins
///         the transient-storage slot literal to its documented seed so the
///         constant and the NatSpec that explains it can never silently drift
///         (audit I-1). The two launch-state checks are a fast, RPC-free
///         smoke of the "permanently locked at launch" invariant that
///         `LaunchInvariantForkTest` also exercises adversarially.
contract PCSwapContextTest is Test {
    PCSwapContextSlotHarness internal harness;

    function setUp() public {
        harness = new PCSwapContextSlotHarness(address(this));
    }

    /// @notice The inlined `INSWAP_SLOT` literal must equal the keccak of the
    ///         canonical seed string cited in PCSwapContext's NatSpec. Guards
    ///         the I-1 audit fix: the literal and the documented seed cannot
    ///         drift apart without this test failing.
    function test_inswapSlot_matchesDocumentedSeed() public view {
        assertEq(
            harness.inswapSlot(),
            uint256(keccak256("pc.swap.context.inswap.v1")),
            "INSWAP_SLOT must equal keccak256 of its documented seed"
        );
    }

    /// @notice At launch no extension is authorized, so the flag can never be
    ///         set and `inSwap()` is permanently false.
    function test_inSwap_falseAtLaunch() public view {
        assertFalse(harness.inSwap());
    }

    /// @notice `enterSwap` / `exitSwap` revert for any caller while no
    ///         extension is authorized (the launch state).
    function test_enterExit_revertWithoutAuthorizedExtension() public {
        vm.expectRevert(PCSwapContext.NotAuthorizedExtension.selector);
        harness.enterSwap();
        vm.expectRevert(PCSwapContext.NotAuthorizedExtension.selector);
        harness.exitSwap();
    }
}
