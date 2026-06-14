// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {LiveBidAdapter} from "../src/LiveBidAdapter.sol";
import {ProtocolAdmin} from "../src/ProtocolAdmin.sol";
import {IPCAcquisitionReader} from "../src/interfaces/IPCAcquisitionReader.sol";

/// @notice Direct (non-fork) tests for the bounded-growth rate limiter in
///         LiveBidAdapter. We feed the adapter ETH directly via `receive()` to
///         focus on the rate-cap invariant: the live bid grows by at most
///         `maxSweepWei` per `minBlocksBetweenSweeps` blocks, across BOTH the
///         `sweep()` and `streamForward()` paths, regardless of inflow source
///         or magnitude. The V3 stack pays native ETH (not WETH) so no WETH
///         mock is needed.
contract BountyAdapterTest is Test {
    LiveBidAdapter internal adapter;
    ProtocolAdmin internal adminContract;
    address payable internal patron;

    uint256 internal constant MAX_SWEEP = 2 ether;
    uint256 internal constant COOLDOWN = 300;

    receive() external payable {}

    function setUp() public {
        adminContract = new ProtocolAdmin(address(this));
        patron = payable(address(new MockSink()));

        adapter = new LiveBidAdapter(
            patron,
            address(adminContract),
            MAX_SWEEP,
            COOLDOWN,
            0,              // activationThreshold = 0 → always throttled (isolates the rate cap)
            address(0),     // permanentCollection = 0 → auto-track off (manual/unit mode)
            address(this),  // returnAuctionModule — this test acts as the module for poolReplenish
            address(0)
        );
    }

    // ─── inflow consolidation: contribute / poolReplenish / receive ──────

    /// @dev `contribute` with a referrer pays exactly REFERRER_CONTRIB_BPS and
    ///      buffers the remainder (it does NOT land in Patron until a sweep).
    function test_Contribute_PaysReferrer_BuffersRemainder() public {
        address payable referrer = payable(address(new MockSink()));
        uint256 bufBefore = adapter.bufferedEth();

        vm.expectEmit(true, true, true, true, address(adapter));
        emit LiveBidAdapter.Contribution(address(this), 1 ether, referrer, bytes32("camp"), 0.05 ether);
        adapter.contribute{value: 1 ether}(referrer, bytes32("camp"));

        assertEq(referrer.balance, 0.05 ether, "referrer paid 5%");
        assertEq(adapter.bufferedEth(), bufBefore + 0.95 ether, "remainder buffered, not in Patron");
        assertEq(patron.balance, 0, "contribute does NOT spike Patron directly");
    }

    /// @dev No referrer → 100% buffered, no send.
    function test_Contribute_NoReferrer_FullyBuffered() public {
        adapter.contribute{value: 1 ether}(address(0), bytes32(0));
        assertEq(adapter.bufferedEth(), 1 ether, "full amount buffered");
    }

    /// @dev Reverting referrer → fail-closed, 100% buffered, referrerShare 0.
    function test_Contribute_RevertingReferrer_FullyBuffered() public {
        RejectsEth bad = new RejectsEth(address(adapter));
        vm.expectEmit(true, true, true, true, address(adapter));
        emit LiveBidAdapter.Contribution(address(this), 1 ether, address(bad), bytes32("x"), 0);
        adapter.contribute{value: 1 ether}(address(bad), bytes32("x"));
        assertEq(adapter.bufferedEth(), 1 ether, "reverting referrer -> full buffer");
    }

    /// @dev Zero-value contribute reverts.
    function test_Contribute_ZeroValue_Reverts() public {
        vm.expectRevert(LiveBidAdapter.ZeroValue.selector);
        adapter.contribute{value: 0}(address(0xBEEF), bytes32(0));
    }

    /// @dev `poolReplenish` is module-only: this test contract IS the wired
    ///      module, so it succeeds; a stranger reverts NotReturnAuction.
    function test_PoolReplenish_ModuleOnly() public {
        vm.expectEmit(true, false, false, true, address(adapter));
        emit LiveBidAdapter.PoolReplenished(uint16(42), 1 ether);
        adapter.poolReplenish{value: 1 ether}(uint16(42));
        assertEq(adapter.bufferedEth(), 1 ether, "refund buffered, not in Patron");

        // A non-module caller is rejected. Fund it so the value transfer
        // reaches the body (the gate, not an insufficient-balance EVM revert).
        vm.deal(address(0xBEEF), 1 ether);
        vm.prank(address(0xBEEF));
        vm.expectRevert(LiveBidAdapter.NotReturnAuction.selector);
        adapter.poolReplenish{value: 1 ether}(uint16(42));
    }

    /// @dev A direct ETH send into the adapter emits BareTopUp.
    function test_Receive_EmitsBareTopUp_ForNonFeeLocker() public {
        vm.expectEmit(true, false, false, true, address(adapter));
        emit LiveBidAdapter.BareTopUp(address(this), 1 ether);
        (bool ok,) = address(adapter).call{value: 1 ether}("");
        assertTrue(ok);
    }

    // ─── bounded-growth rate cap (sweep) ─────────────────────────────────

    function test_FirstSweepBoundedAtMaxSweep() public {
        // Buffer the adapter with 10 ETH.
        (bool ok,) = address(adapter).call{value: 10 ether}("");
        assertTrue(ok);
        assertEq(adapter.bufferedEth(), 10 ether);

        // Past the initial cooldown window.
        vm.roll(block.number + COOLDOWN);

        uint256 patronBefore = patron.balance;
        adapter.sweep();
        uint256 forwarded = patron.balance - patronBefore;

        // Forward is MAX_SWEEP minus the keeper reward (0.5% × 2 ETH = 0.01 ETH).
        uint256 expectedReward = (MAX_SWEEP * 50) / 10_000;
        assertEq(forwarded, MAX_SWEEP - expectedReward, "forward = MAX_SWEEP - reward");
        assertEq(adapter.bufferedEth(), 10 ether - MAX_SWEEP, "buffer drops by MAX_SWEEP");
    }

    function test_CooldownEnforced() public {
        (bool ok,) = address(adapter).call{value: 10 ether}("");
        assertTrue(ok);

        uint256 start = block.number;
        vm.roll(start + COOLDOWN);
        adapter.sweep();

        // Immediately after a sweep, the next call must revert until
        // COOLDOWN more blocks pass.
        vm.expectRevert();
        adapter.sweep();

        vm.roll(adapter.nextSweepBlock() - 1);
        vm.expectRevert();
        adapter.sweep();

        // One more block crosses the boundary; sweep succeeds.
        vm.roll(adapter.nextSweepBlock());
        adapter.sweep();
    }

    function test_EmptySweepIsFreeOfCooldown() public {
        // Buffer is empty (no `receive()` calls yet). sweep() should just
        // return 0 without consuming the cooldown.
        assertEq(adapter.sweep(), 0);
        assertEq(adapter.sweep(), 0);
        assertEq(adapter.sweep(), 0);
        assertEq(adapter.lastSweepBlock(), 0);
    }

    function test_BufferSweptAcrossMultipleSweeps() public {
        // 5 * MAX_SWEEP worth of buffer.
        (bool ok,) = address(adapter).call{value: 10 ether}("");
        assertTrue(ok);

        uint256 patronBefore = patron.balance;
        for (uint256 i = 0; i < 5; i++) {
            vm.roll(adapter.nextSweepBlock());
            adapter.sweep();
        }
        // Buffer fully swept.
        assertEq(adapter.bufferedEth(), 0, "buffer empty after 5 sweeps");
        // Patron got ~5 × MAX_SWEEP minus the per-call keeper rewards.
        uint256 totalForwarded = patron.balance - patronBefore;
        uint256 perCallReward = (MAX_SWEEP * 50) / 10_000;
        if (perCallReward > 0.01 ether) perCallReward = 0.01 ether;
        assertEq(totalForwarded, 5 * (MAX_SWEEP - perCallReward), "5 * (MAX_SWEEP - reward)");
    }

    function test_SmallerBufferFullyForwarded() public {
        // 0.5 ETH buffer < MAX_SWEEP → forwards in one call.
        (bool ok,) = address(adapter).call{value: 0.5 ether}("");
        assertTrue(ok);
        vm.roll(block.number + COOLDOWN);

        uint256 patronBefore = patron.balance;
        adapter.sweep();
        uint256 forwarded = patron.balance - patronBefore;

        uint256 expectedReward = (0.5 ether * 50) / 10_000; // 0.0025 ETH
        assertEq(forwarded, 0.5 ether - expectedReward);
        assertEq(adapter.bufferedEth(), 0, "buffer empty");
    }

    /// @dev The core invariant: a single LUMP inflow — no matter how large or
    ///      which source delivered it — cannot spike the live bid. A 1000 ETH
    ///      rescue refund only advances Patron by MAX_SWEEP per cooldown; the
    ///      rest buffers and drips. There is no inflow path that bypasses the
    ///      rate cap.
    function test_BoundedGrowth_LumpInflowCannotSpikeBid() public {
        // A fat rescue refund lands in one shot (this contract is the module).
        adapter.poolReplenish{value: 1000 ether}(uint16(7));
        assertEq(adapter.bufferedEth(), 1000 ether, "lump buffered, not forwarded");
        assertEq(patron.balance, 0, "no spike on inflow");

        // Every forward is bounded by MAX_SWEEP regardless of buffer size.
        for (uint256 i = 0; i < 10; i++) {
            uint256 patronBefore = patron.balance;
            vm.roll(adapter.nextSweepBlock());
            adapter.sweep();
            uint256 grew = patron.balance - patronBefore;
            assertLe(grew, MAX_SWEEP, "bid grows by at most MAX_SWEEP per cooldown");
        }
        // After 10 cooldowns the bid is ~10 × (MAX_SWEEP − reward) — far below
        // the 1000 ETH buffer. The standing offer can never lurch to the lump.
        assertLt(patron.balance, 21 ether, "bid still throttled far below the lump");
        assertGt(adapter.bufferedEth(), 970 ether, "the bulk is still buffered");
    }

    function test_KeeperReceivesReward() public {
        (bool ok,) = address(adapter).call{value: 10 ether}("");
        assertTrue(ok);
        vm.roll(block.number + COOLDOWN);

        address bot = address(0xB07);
        vm.prank(bot);
        adapter.sweep();

        // Bot got the keeper reward (0.5% × 2 ETH = 0.01 ETH).
        assertEq(bot.balance, 0.01 ether, "keeper paid the reward");
    }

    function test_Sweep_SwallowsKeeperRewardSendFailure() public {
        // Caller is a contract that reverts on ETH receive. The reward send
        // must NOT revert the whole sweep — the protocol-essential forward
        // to Patron has already succeeded.
        (bool ok,) = address(adapter).call{value: 5 ether}("");
        assertTrue(ok);
        vm.roll(block.number + COOLDOWN);

        RejectsEth caller = new RejectsEth(address(adapter));
        uint256 patronBefore = patron.balance;
        caller.fire();

        // Forward to patron happened.
        assertGt(patron.balance - patronBefore, 0, "patron forward landed");
        // No ETH stuck with the caller.
        assertEq(address(caller).balance, 0);
    }

    // ─── streamForward: hook-driven, buffered-native only, dust floor,
    //     no keeper reward, no-op (never revert) on cooldown, SAME rate cap ───

    /// @dev Below the 0.01 ETH dust floor → no-op, nothing forwarded.
    function test_StreamForward_NoOpBelowDustFloor() public {
        (bool ok,) = address(adapter).call{value: 0.009 ether}(""); // < MIN_STREAM_WEI
        assertTrue(ok);
        assertEq(adapter.streamForward(), 0, "no-op below dust floor");
        assertEq(patron.balance, 0, "nothing forwarded");
        assertEq(adapter.bufferedEth(), 0.009 ether, "buffer untouched");
    }

    /// @dev Above the dust floor: forwards the throttled cap (MAX_SWEEP) with
    ///      NO keeper reward (the whole remainder stays buffered — proving the
    ///      stream path takes no reward, unlike sweep()).
    function test_StreamForward_ForwardsCapped_NoReward() public {
        (bool ok,) = address(adapter).call{value: 15 ether}("");
        assertTrue(ok);
        vm.roll(block.number + COOLDOWN);

        uint256 fwd = adapter.streamForward();

        assertEq(fwd, MAX_SWEEP, "forwards exactly the per-call cap");
        assertEq(patron.balance, MAX_SWEEP, "bid grows by exactly MAX_SWEEP (no reward carved)");
        assertEq(adapter.bufferedEth(), 15 ether - MAX_SWEEP, "full remainder buffered (no reward taken)");
    }

    /// @dev A second stream call inside the cooldown NO-OPS (returns 0) instead
    ///      of reverting — so it can never brick a swap.
    function test_StreamForward_NoOpOnCooldown_NeverReverts() public {
        (bool ok,) = address(adapter).call{value: 10 ether}("");
        assertTrue(ok);
        vm.roll(block.number + COOLDOWN); // clear the initial cooldown window

        uint256 f1 = adapter.streamForward();
        assertEq(f1, MAX_SWEEP, "throttled stream forwards full MAX_SWEEP (no reward)");

        // Immediately again, still inside the cooldown → no-op, NOT a revert.
        uint256 f2 = adapter.streamForward();
        assertEq(f2, 0, "no-op on cooldown (does not revert)");
        assertEq(adapter.bufferedEth(), 10 ether - MAX_SWEEP, "buffer unchanged by the no-op");
    }

    /// @dev `streamForward` and `sweep` share ONE cooldown via `lastSweepBlock`:
    ///      a stream forward consumes the slot, so a `sweep` in the same window
    ///      reverts. The rate cap holds no matter which path fires.
    function test_StreamForward_SharesCooldownWithSweep() public {
        (bool ok,) = address(adapter).call{value: 10 ether}("");
        assertTrue(ok);
        vm.roll(block.number + COOLDOWN);

        adapter.streamForward(); // wins the cooldown slot
        // sweep in the same window is gated by the shared limiter.
        vm.expectRevert();
        adapter.sweep();

        // After the cooldown, sweep proceeds again.
        vm.roll(adapter.nextSweepBlock());
        adapter.sweep();
    }

    // ─── streamForward reentrancy: the nonReentrant mutex blocks a reentry via
    //     a malicious Patron; the outer call fails safely (no double-forward) —
    //     in the hook path the try/catch then swallows it ───────────────────

    function test_StreamForward_NonReentrant_BlocksReentryViaPatron() public {
        ReentrantPatron evil = new ReentrantPatron();
        LiveBidAdapter a2 = new LiveBidAdapter(
            payable(address(evil)),
            address(adminContract),
            MAX_SWEEP,
            COOLDOWN,
            0,           // activationThreshold = 0 → always throttled
            address(0),  // permanentCollection = 0 → auto-track off
            address(this),
            address(0)
        );
        evil.set(address(a2));
        (bool ok,) = address(a2).call{value: 1 ether}("");
        assertTrue(ok);
        vm.roll(block.number + COOLDOWN);

        // evil.receive() re-enters streamForward → nonReentrant reverts the
        // reentry → evil.receive() reverts → outer patron.call fails →
        // ForwardFailed. The mutex prevented any double-forward.
        vm.expectRevert(LiveBidAdapter.ForwardFailed.selector);
        a2.streamForward();
        assertEq(a2.bufferedEth(), 1 ether, "funds NOT moved; reentry blocked, no double-forward");
    }

    // ─── rate-cap setters (the two knobs; both 1y-locked, no carve-out) ──────

    function test_SetMaxSweepWei_BoundsEnforced() public {
        vm.expectRevert();
        adapter.setMaxSweepWei(0.001 ether);  // below lo
        vm.expectRevert();
        adapter.setMaxSweepWei(10 ether);     // above hi

        adapter.setMaxSweepWei(0.5 ether);
        assertEq(adapter.maxSweepWei(), 0.5 ether);
    }

    function test_SetMinBlocksBetweenSweeps_BoundsEnforced() public {
        vm.expectRevert();
        adapter.setMinBlocksBetweenSweeps(0);      // below lo
        vm.expectRevert();
        adapter.setMinBlocksBetweenSweeps(8000);   // above hi

        adapter.setMinBlocksBetweenSweeps(1);
        assertEq(adapter.minBlocksBetweenSweeps(), 1);
    }

    function test_NonAdmin_CannotSet() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        adapter.setMaxSweepWei(0.5 ether);

        vm.prank(address(0xBEEF));
        vm.expectRevert();
        adapter.setMinBlocksBetweenSweeps(10);
    }

    /// @dev The rate-cap setters lock with the rest of the economic surface at
    ///      the 1y admin expiry — there is NO adapter carve-out anymore.
    function test_RateCapSetters_LockAfterAdminExpiry() public {
        vm.warp(block.timestamp + 366 days);
        assertTrue(adminContract.isLocked());

        vm.expectRevert(LiveBidAdapter.NotAdmin.selector);
        adapter.setMaxSweepWei(0.5 ether);
        vm.expectRevert(LiveBidAdapter.NotAdmin.selector);
        adapter.setMinBlocksBetweenSweeps(10);
    }
}

/// @notice Direct (non-fork) tests for the activationThreshold two-mode meter.
///         Auto-tracking is OFF (`permanentCollection == address(0)`) so these
///         isolate the FORWARD behaviour from the records-core sync; the
///         threshold is set via the constructor seed. A `MockSink` stands in for
///         Patron (accepts ETH freely; `vm.deal` on it simulates the standing
///         live bid that drives the fast/throttled decision).
contract LiveBidAdapterFastModeTest is Test {
    ProtocolAdmin internal adminContract;
    uint256 internal constant MAX_SWEEP = 2 ether;
    uint256 internal constant COOLDOWN = 300;

    // Receives keeper rewards.
    receive() external payable {}

    function setUp() public {
        adminContract = new ProtocolAdmin(address(this));
    }

    /// @dev Fresh adapter seeded with `threshold`, auto-track OFF, fresh sink.
    function _adapter(uint256 threshold) internal returns (LiveBidAdapter a, address payable sink) {
        sink = payable(address(new MockSink()));
        a = new LiveBidAdapter(
            sink,
            address(adminContract),
            MAX_SWEEP,
            COOLDOWN,
            threshold,
            address(0),     // permanentCollection = 0 → auto-track OFF
            address(this),  // returnAuctionModule (unused here)
            address(0)
        );
    }

    /// @dev Below the threshold a single sweep forwards the whole buffer, far
    ///      exceeding the throttle's per-call cap (MAX_SWEEP = 2 ETH). Proves
    ///      fast-mode is genuinely uncapped.
    function test_FastMode_BelowThreshold_UncappedForward() public {
        (LiveBidAdapter a, address payable sink) = _adapter(100 ether); // == HI
        // Patron balance 0 < 100 ETH threshold; room = 100 ETH > buffer.
        vm.deal(address(a), 50 ether);
        uint256 fwd = a.sweep();
        assertGt(fwd, MAX_SWEEP, "fast-mode forward exceeds the 2 ETH throttle cap");
        assertApproxEqAbs(sink.balance, 50 ether, 0.01 ether, "~full buffer forwarded in one sweep");
        assertLt(a.bufferedEth(), 0.02 ether, "buffer drained (only keeper-reward dust may remain)");
    }

    /// @dev At the threshold boundary (Patron.balance == threshold) the throttle
    ///      engages: one sweep forwards at most MAX_SWEEP, the rest stays
    ///      buffered. Proves the rate cap turns on exactly at the threshold.
    function test_SlowMode_AboveThreshold_RespectsRateCap() public {
        (LiveBidAdapter a, address payable sink) = _adapter(10 ether);
        vm.deal(sink, 10 ether);       // Patron.balance == threshold (boundary)
        vm.deal(address(a), 50 ether); // big buffer
        vm.roll(block.number + COOLDOWN); // clear the initial cooldown window
        uint256 fwd = a.sweep();
        assertLe(fwd, MAX_SWEEP, "throttled: forward capped at MAX_SWEEP");
        assertApproxEqAbs(a.bufferedEth(), 48 ether, 0.02 ether, "remainder stays buffered (not fast-forwarded)");
    }

    /// @dev A fast-mode sweep that would overshoot the threshold lands the bid
    ///      EXACTLY at it and leaves the remainder buffered. This exact-landing
    ///      clamp is load-bearing: a hair below the threshold would never flip
    ///      the throttle on and the bid would stall just under it forever.
    function test_ExactThresholdLanding_FastModeFillsToThresholdOnly() public {
        (LiveBidAdapter a, address payable sink) = _adapter(30 ether);
        vm.deal(address(a), 100 ether); // buffer >> room (30 ETH) → clamp
        a.sweep();
        assertEq(sink.balance, 30 ether, "bid lands EXACTLY at the threshold");
        // Reward (<=0.01 ETH) is paid from the remainder, so ~70 ETH stays.
        assertApproxEqAbs(a.bufferedEth(), 70 ether, 0.02 ether, "remainder buffered, drips in under the throttle");
    }

    /// @dev `ThresholdCrossed` fires once on the forward that takes the bid from
    ///      below to at/above the threshold, and NOT again while it stays above.
    function test_ThresholdCrossed_EmittedOnce() public {
        (LiveBidAdapter a, address payable sink) = _adapter(10 ether);
        vm.deal(address(a), 100 ether);
        bytes32 sig = keccak256("ThresholdCrossed(uint256,uint256)");

        // First sweep: 0 → 10 (lands at threshold) → exactly one ThresholdCrossed.
        vm.recordLogs();
        a.sweep();
        assertEq(sink.balance, 10 ether, "landed at threshold");
        Vm.Log[] memory logs1 = vm.getRecordedLogs();
        uint256 crossed1;
        for (uint256 i = 0; i < logs1.length; i++) {
            if (logs1[i].emitter == address(a) && logs1[i].topics[0] == sig) crossed1++;
        }
        assertEq(crossed1, 1, "ThresholdCrossed fires once on the crossing sweep");

        // Second sweep (already above): must NOT re-fire.
        vm.roll(block.number + COOLDOWN);
        vm.recordLogs();
        a.sweep();
        Vm.Log[] memory logs2 = vm.getRecordedLogs();
        uint256 crossed2;
        for (uint256 i = 0; i < logs2.length; i++) {
            if (logs2[i].emitter == address(a) && logs2[i].topics[0] == sig) crossed2++;
        }
        assertEq(crossed2, 0, "ThresholdCrossed does not re-fire while the bid stays above");
    }

    /// @dev Fail-open hardening: a records core returning a `priceWei` that
    ///      would overflow the −25% band multiply (`priceWei * 75`) must NOT
    ///      brick `sweep()`. The clamp-first guard pins it to HI with no revert.
    ///      Drives the sync through a mock core returning `type(uint256).max`
    ///      (the old `(priceWei * 75)` would revert; physically impossible from
    ///      the real immutable core, but the guard must hold unconditionally).
    function test_SyncOverflowGuard_HugePriceClampsToHi() public {
        MockAcquisitionReader reader = new MockAcquisitionReader();
        reader.set(type(uint256).max); // acceptBid shape, overflowing price
        address payable sink = payable(address(new MockSink()));
        LiveBidAdapter a = new LiveBidAdapter(
            sink,
            address(adminContract),
            MAX_SWEEP,
            COOLDOWN,
            7 ether,         // seed (sync overwrites it)
            address(reader), // records core = the overflow mock
            address(this),
            address(0)
        );
        // sweep() runs _syncActivationThreshold FIRST; an empty buffer then
        // returns 0. The sync must clamp to HI rather than overflow-revert.
        a.sweep();
        assertEq(a.activationThreshold(), a.ACTIVATION_THRESHOLD_HI(), "overflowing price clamps to HI, no revert");
    }
}

/// @notice Test helper — a contract that rejects ETH on receive. Used to
///         exercise the failed-reward path on LiveBidAdapter.
contract RejectsEth {
    LiveBidAdapter immutable a;
    constructor(address _a) { a = LiveBidAdapter(payable(_a)); }
    function fire() external { a.sweep(); }
    receive() external payable { revert("no eth"); }
}

/// @notice Drop-in patron sink for tests: accepts ETH, accumulates.
contract MockSink {
    receive() external payable {}
}

/// @notice Minimal `IPCAcquisitionReader` mock for the Info-1 overflow-guard
///         test. Reports one acquisition in the acceptBid shape (acquirer ==
///         originalSeller != 0) with a settable `priceWei`, so the test can
///         feed `_syncActivationThreshold` a price that would overflow the
///         −25% band multiply on the un-guarded path.
contract MockAcquisitionReader {
    uint256 internal _price;

    function set(uint256 price) external {
        _price = price;
    }

    function acquisitionCount() external pure returns (uint256) {
        return 1;
    }

    function getAcquisition(uint256) external view returns (IPCAcquisitionReader.Acquisition memory a) {
        a.acquirer = address(0xBEEF);
        a.originalSeller = address(0xBEEF); // acceptBid shape → sync applies the band
        a.priceWei = _price;
    }
}

/// @notice Malicious Patron: on receiving the forward, re-enters
///         `streamForward()` to attempt a double-forward. The adapter's
///         `nonReentrant` mutex must revert the reentry.
contract ReentrantPatron {
    LiveBidAdapter internal a;
    function set(address _a) external { a = LiveBidAdapter(payable(_a)); }
    receive() external payable {
        // Re-enter; the mutex reverts this, which bubbles up and makes the
        // outer forward fail (ForwardFailed) rather than double-spend.
        a.streamForward();
    }
}
