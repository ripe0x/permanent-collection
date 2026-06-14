// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ProtocolFeePhaseAdapter} from "../src/ProtocolFeePhaseAdapter.sol";

/// @notice Unit tests for ProtocolFeePhaseAdapter — the contract that claims
///         the protocol-fee leg (~16.67% of the hook's baseline skim) from the
///         fee escrow and forwards it to the artcoins ProtocolFeeController on
///         every sweep.
contract ProtocolFeePhaseAdapterTest is Test {
    ProtocolFeePhaseAdapter internal adapter;

    MockSink internal controller;
    MockEscrow internal escrow;

    function setUp() public {
        controller = new MockSink();
        escrow = new MockEscrow();

        adapter = new ProtocolFeePhaseAdapter(payable(address(controller)), address(escrow), address(0));
    }

    function _fund(
        uint256 amount
    ) internal {
        vm.deal(address(this), address(this).balance + amount);
        (bool ok,) = payable(address(adapter)).call{value: amount}("");
        require(ok, "fund failed");
    }

    receive() external payable {}

    // ─── construction guards ─────────────────────────────────────────────

    function test_constructor_revertsOnZeroController() public {
        vm.expectRevert(ProtocolFeePhaseAdapter.ZeroAddress.selector);
        new ProtocolFeePhaseAdapter(payable(address(0)), address(escrow), address(0));
    }

    function test_constructor_revertsOnZeroEscrow() public {
        vm.expectRevert(ProtocolFeePhaseAdapter.ZeroAddress.selector);
        new ProtocolFeePhaseAdapter(payable(address(controller)), address(0), address(0));
    }

    // ─── forwards to controller from block 1 ─────────────────────────────

    function test_sweep_forwardsToController() public {
        _fund(1 ether);
        adapter.sweep();

        assertEq(address(controller).balance, 1 ether, "all to controller");
        assertEq(address(adapter).balance, 0, "drained");
    }

    function test_sweep_emitsEvent() public {
        _fund(0.5 ether);

        vm.expectEmit(true, false, false, true, address(adapter));
        emit ProtocolFeePhaseAdapter.Forwarded(address(controller), 0.5 ether);

        adapter.sweep();
    }

    // ─── zero-balance is no-op ──────────────────────────────────────────

    function test_sweep_zero_balance_is_noop() public {
        adapter.sweep();
        assertEq(address(controller).balance, 0);
    }

    // ─── permissionlessness ─────────────────────────────────────────────

    function test_sweep_callable_by_anyone() public {
        _fund(1 ether);
        address rando = makeAddr("rando");
        vm.prank(rando);
        adapter.sweep();
        assertEq(address(controller).balance, 1 ether);
    }

    // ─── failure: reverting recipient bubbles up so ETH stays for retry ──

    function test_sweep_reverts_whenControllerRejects() public {
        Rejector reject = new Rejector();

        adapter = new ProtocolFeePhaseAdapter(payable(address(reject)), address(escrow), address(0));

        _fund(1 ether);
        vm.expectRevert(ProtocolFeePhaseAdapter.ForwardFailed.selector);
        adapter.sweep();

        // Balance still here for retry.
        assertEq(address(adapter).balance, 1 ether, "held for retry");
    }

    // ─── protocol leg arrives via the fee escrow ─────────────────────────

    /// @notice sweep() pulls this adapter's escrowed protocol-fee balance
    ///         (the hook deposits the protocol leg under the adapter's address)
    ///         and forwards it to the controller.
    function test_sweep_claimsFromEscrow_thenForwards() public {
        vm.deal(address(this), 1 ether);
        escrow.fund{value: 1 ether}(address(adapter));
        assertEq(address(adapter).balance, 0, "adapter starts empty");

        adapter.sweep(); // pulls from escrow, forwards to controller
        assertEq(address(controller).balance, 1 ether, "escrowed protocol leg routed to controller");
        assertEq(address(adapter).balance, 0, "drained");
    }

    /// @notice A reverting escrow claim is caught (ClaimFailed) and sweep still
    ///         forwards whatever ETH is already on the adapter.
    function test_sweep_survivesEscrowClaimRevert() public {
        RevertingClaimEscrow badEscrow = new RevertingClaimEscrow();
        adapter = new ProtocolFeePhaseAdapter(payable(address(controller)), address(badEscrow), address(0));
        _fund(1 ether);

        vm.expectEmit(true, false, false, false, address(adapter));
        emit ProtocolFeePhaseAdapter.ClaimFailed(address(badEscrow));
        adapter.sweep();

        assertEq(address(controller).balance, 1 ether, "direct balance still forwarded");
    }
}

// ─── test helpers ───────────────────────────────────────────────────────

contract MockSink {
    receive() external payable {}
}

contract Rejector {
    receive() external payable {
        revert("nope");
    }
}

/// @notice Minimal escrow mock: holds native balances per fee-owner and
///         releases them on `claim`. No-op (not revert) on an empty balance so
///         the routing tests, which fund the adapter directly, stay clean.
contract MockEscrow {
    mapping(address => uint256) public bal;

    function fund(
        address feeOwner
    ) external payable {
        bal[feeOwner] += msg.value;
    }

    function availableFees(
        address feeOwner,
        address
    ) external view returns (uint256) {
        return bal[feeOwner];
    }

    function claim(
        address feeOwner,
        address
    ) external {
        uint256 b = bal[feeOwner];
        if (b == 0) return;
        bal[feeOwner] = 0;
        (bool ok,) = payable(feeOwner).call{value: b}("");
        require(ok, "claim send");
    }

    receive() external payable {}
}

/// @notice Escrow whose claim always reverts (for the claim-revert survival test).
contract RevertingClaimEscrow {
    function availableFees(
        address,
        address
    ) external pure returns (uint256) {
        return 0;
    }

    function claim(
        address,
        address
    ) external pure {
        revert("escrow down");
    }
}
