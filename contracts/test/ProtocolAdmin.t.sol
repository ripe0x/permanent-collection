// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ProtocolAdmin} from "../src/ProtocolAdmin.sol";

/// @notice Direct (non-fork) tests for `ProtocolAdmin`'s timer + burn
///         semantics. Covers the exact-expiry-tick boundary that was the
///         remediation in the v2 audit (`>` → `>=`).
contract ProtocolAdminTest is Test {
    ProtocolAdmin internal pa;
    address internal initialAdmin = address(0xA1);

    function setUp() public {
        pa = new ProtocolAdmin(initialAdmin);
    }

    function test_IsLocked_FalseBeforeExpiry() public {
        uint256 expires = pa.adminTimerExpires();
        assertGt(expires, block.timestamp, "fixture: timer set in the future");
        vm.warp(expires - 1);
        assertFalse(pa.isLocked(), "not locked one second before expiry");
        assertTrue(pa.checkAdmin(initialAdmin));
    }

    function test_IsLocked_TrueAtExactExpiryTick() public {
        // Audit remediation: `block.timestamp >= adminTimerExpires` (not `>`),
        // so the role locks AT the expiry second, not the one after.
        uint256 expires = pa.adminTimerExpires();
        vm.warp(expires);
        assertTrue(pa.isLocked(), "locked at exact expiry");
        assertFalse(pa.checkAdmin(initialAdmin));
        assertEq(pa.timeUntilLock(), 0);
    }

    function test_IsLocked_TrueAfterExpiry() public {
        uint256 expires = pa.adminTimerExpires();
        vm.warp(expires + 1 days);
        assertTrue(pa.isLocked());
    }

    function test_TransferAdmin_RenewsTimer() public {
        uint256 firstExpires = pa.adminTimerExpires();
        vm.warp(block.timestamp + 100 days);

        // Self-transfer = heartbeat, renews the timer to now + 365 days.
        vm.prank(initialAdmin);
        pa.transferAdmin(initialAdmin);

        uint256 newExpires = pa.adminTimerExpires();
        assertGt(newExpires, firstExpires, "timer renewed");
        assertEq(newExpires, block.timestamp + pa.ADMIN_TIMER_DURATION());
        assertEq(pa.admin(), initialAdmin);
    }

    function test_TransferAdmin_BurnDisablesAllAdminActions() public {
        vm.prank(initialAdmin);
        pa.transferAdmin(address(0));

        assertTrue(pa.adminBurned());
        assertTrue(pa.isLocked());
        assertEq(pa.admin(), address(0));

        // After burn, admin == address(0): there is no admin, so any further
        // transferAdmin reverts on the auth check (NotAdmin), not the timer.
        vm.expectRevert(ProtocolAdmin.NotAdmin.selector);
        vm.prank(initialAdmin);
        pa.transferAdmin(initialAdmin);
    }

    // ─── M-1: the burn path stays reachable after the timer lapses ───────
    //
    // Auditor finding M-1. Before the fix, `transferAdmin` began with
    // `if (isLocked()) revert Locked()`, so once the 1-year timer expired
    // without a heartbeat the burn path (`transferAdmin(address(0))`) reverted
    // forever — leaving the raw-admin carve-outs (allowlist, activation
    // threshold, referral cap, token tax) callable by the live EOA
    // permanently, with no on-chain off-switch. A post-lapse key compromise
    // could then `addAllowedSeller(malicious)` and drain the live bid. The fix
    // gates only renewals/rotations on the timer; burning is always allowed.

    /// @notice After the timer lapses, a renewal or rotation (non-zero
    ///         newAdmin) is still time-gated and reverts `Locked`.
    function test_M1_RenewalAndRotationRevertAfterLapse() public {
        vm.warp(pa.adminTimerExpires());
        assertTrue(pa.isLocked(), "timer lapsed");

        // Self-renewal heartbeat — too late.
        vm.expectRevert(ProtocolAdmin.Locked.selector);
        vm.prank(initialAdmin);
        pa.transferAdmin(initialAdmin);

        // Rotation to a fresh custodian — also too late.
        vm.expectRevert(ProtocolAdmin.Locked.selector);
        vm.prank(initialAdmin);
        pa.transferAdmin(address(0xB0B));

        // State untouched: still the original admin, not burned.
        assertEq(pa.admin(), initialAdmin, "admin unchanged");
        assertFalse(pa.adminBurned(), "not burned by a reverted call");
    }

    /// @notice After the same lapse, burning the role SUCCEEDS — it strictly
    ///         reduces power, so it is never timer-gated. This is the core
    ///         M-1 regression: the off-switch must remain reachable.
    function test_M1_BurnSucceedsAfterLapse() public {
        vm.warp(pa.adminTimerExpires() + 30 days);
        assertTrue(pa.isLocked(), "timer lapsed");

        vm.expectEmit(false, false, false, true, address(pa));
        emit ProtocolAdmin.AdminBurned(block.timestamp);
        vm.prank(initialAdmin);
        pa.transferAdmin(address(0));

        assertTrue(pa.adminBurned(), "burned after lapse");
        assertEq(pa.admin(), address(0), "admin zeroed on burn");
        // checkAdmin now fails for everyone — the carve-outs lose their gate.
        assertFalse(pa.checkAdmin(initialAdmin), "no admin survives the burn");
    }

    /// @notice The post-lapse burn is still authenticated: a stranger cannot
    ///         burn the role; only the live admin EOA can.
    function test_M1_BurnAfterLapse_RequiresCurrentAdmin() public {
        vm.warp(pa.adminTimerExpires() + 1);

        vm.expectRevert(ProtocolAdmin.NotAdmin.selector);
        vm.prank(address(0xBA5E));
        pa.transferAdmin(address(0));
        assertFalse(pa.adminBurned(), "stranger cannot burn");

        // The real admin still holds the off-switch.
        vm.prank(initialAdmin);
        pa.transferAdmin(address(0));
        assertTrue(pa.adminBurned(), "admin burns after lapse");
    }

    function test_TransferAdmin_OnlyFromCurrentAdmin() public {
        address rando = address(0xBA5E);
        vm.expectRevert(ProtocolAdmin.NotAdmin.selector);
        vm.prank(rando);
        pa.transferAdmin(rando);
    }

    function test_ConstructorRejectsZeroAdmin() public {
        vm.expectRevert();
        new ProtocolAdmin(address(0));
    }
}
