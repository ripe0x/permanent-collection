// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PunkVaultTitleAuction} from "../src/PunkVaultTitleAuction.sol";
import {PunkVault} from "../src/PunkVault.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Tests for `PunkVaultTitleAuction`:
///         - Threshold-gated permissionless `kickoff()`.
///         - Bid validation: no reserve, strictly increasing, anti-snipe.
///         - Outbid refunds (push) + pull-pattern fallback.
///         - Settle split: 50% Patron / 50% creator.
///         - No-bidder edge case (title strands in auction contract).
///         - State-machine lifecycle constraints.
contract PunkVaultTitleAuctionTest is ForkFixtures {
    address internal alice;
    address internal bob;
    address internal carol;

    /// @dev `creator` slot in the auction was set to `address(this)` in
    ///      `_deployProtocol()`, so the test contract receives the creator
    ///      share. It implements `receive()` (inherited from `Test`/our
    ///      fixture) so the send succeeds.

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    /// @dev Force the collection's `collectedMask` to a value with at
    ///      least `KICKOFF_THRESHOLD` (=22) bits set, satisfying
    ///      `collectedCount >= KICKOFF_THRESHOLD`.
    function _enableKickoff() internal {
        _setCollectedMask((uint256(1) << 22) - 1);
        require(collection.collectedCount() >= 22, "fixture: threshold not met");
    }

    function _kickoff() internal {
        _enableKickoff();
        titleAuction.kickoff();
    }

    // ────────── kickoff ──────────

    function test_Kickoff_BelowThreshold_Reverts() public {
        _setCollectedMask((uint256(1) << 21) - 1); // 21 traits — one short
        vm.expectRevert(PunkVaultTitleAuction.ThresholdNotReached.selector);
        titleAuction.kickoff();
    }

    function test_Kickoff_AtThreshold_Mints() public {
        _enableKickoff();
        uint64 expectedEnd = uint64(block.timestamp) + titleAuction.AUCTION_DURATION();
        titleAuction.kickoff();
        assertTrue(titleAuction.kickedOff());
        assertEq(titleAuction.endsAt(), expectedEnd);
        assertEq(vault.titleOwner(), address(titleAuction));
        assertTrue(titleAuction.isLive());
    }

    function test_Kickoff_OneShot() public {
        _kickoff();
        vm.expectRevert(PunkVaultTitleAuction.AlreadyKickedOff.selector);
        titleAuction.kickoff();
    }

    function test_Kickoff_Permissionless() public {
        _enableKickoff();
        vm.prank(makeAddr("randomCaller"));
        titleAuction.kickoff();
        assertEq(vault.titleOwner(), address(titleAuction));
    }

    function test_IsKickoffReady() public {
        assertFalse(titleAuction.isKickoffReady());
        _enableKickoff();
        assertTrue(titleAuction.isKickoffReady());
        titleAuction.kickoff();
        assertFalse(titleAuction.isKickoffReady());
    }

    // ────────── bid validation ──────────

    function test_Bid_BeforeKickoff_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(PunkVaultTitleAuction.AuctionNotLive.selector);
        titleAuction.bid{value: 1 ether}();
    }

    function test_Bid_AfterEnd_Reverts() public {
        _kickoff();
        vm.warp(block.timestamp + 25 hours);
        vm.prank(alice);
        vm.expectRevert(PunkVaultTitleAuction.AuctionEnded.selector);
        titleAuction.bid{value: 1 ether}();
    }

    function test_Bid_ZeroValue_Reverts() public {
        _kickoff();
        vm.prank(alice);
        vm.expectRevert(PunkVaultTitleAuction.ZeroBid.selector);
        titleAuction.bid{value: 0}();
    }

    function test_Bid_NotHigher_Reverts() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 2 ether}();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(
            PunkVaultTitleAuction.BidNotHigherThanCurrent.selector, 2 ether, 2 ether
        ));
        titleAuction.bid{value: 2 ether}();
    }

    function test_Bid_BelowMinimumIncrease_Reverts() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        // Min increase is 5%, so next bid must be ≥ 1.05 ether.
        uint256 belowMin = 1.04 ether;
        uint256 expectedMin = 1.05 ether;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(
            PunkVaultTitleAuction.BidBelowMinimumIncrease.selector, belowMin, expectedMin
        ));
        titleAuction.bid{value: belowMin}();
    }

    function test_Bid_AtMinimumIncrease_Succeeds() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        vm.prank(bob);
        titleAuction.bid{value: 1.05 ether}();
        assertEq(titleAuction.highBidder(), bob);
        assertEq(titleAuction.highBidWei(), 1.05 ether);
    }

    function test_MinNextBid_View() public {
        _kickoff();
        assertEq(titleAuction.minNextBid(), 0);
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        assertEq(titleAuction.minNextBid(), 1.05 ether);
        vm.prank(bob);
        titleAuction.bid{value: 2 ether}();
        assertEq(titleAuction.minNextBid(), 2.1 ether);
    }

    function test_Bid_AnyNonzero_AcceptedAsFirst() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 1}(); // 1 wei
        assertEq(titleAuction.highBidder(), alice);
        assertEq(titleAuction.highBidWei(), 1);
    }

    // ────────── outbid + refunds ──────────

    function test_OutbidRefund_PushSucceeds() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        vm.prank(bob);
        titleAuction.bid{value: 2 ether}();

        // Push refund to an EOA always succeeds, so the queued-fallback
        // mapping should stay at zero. (Reading alice.balance directly is
        // brittle under aggressive `via_ir` hoisting around vm.warp/prank.)
        assertEq(titleAuction.pendingRefund(alice), 0);
        assertEq(titleAuction.highBidder(), bob);
    }

    function test_OutbidRefund_PushFails_QueuesPending() public {
        _kickoff();
        // Use a reverting bidder so push refund fails.
        RevertOnReceive r = new RevertOnReceive();
        vm.deal(address(r), 5 ether);
        r.makeBid{value: 1 ether}(titleAuction);

        vm.prank(bob);
        titleAuction.bid{value: 2 ether}();

        assertEq(titleAuction.pendingRefund(address(r)), 1 ether);
    }

    function test_WithdrawRefund_Pulls() public {
        _kickoff();
        RevertOnReceive r = new RevertOnReceive();
        vm.deal(address(r), 5 ether);
        r.makeBid{value: 1 ether}(titleAuction);

        vm.prank(bob);
        titleAuction.bid{value: 2 ether}();

        // Have the contract turn off reverting, then pull.
        r.setAcceptEth(true);
        uint256 balBefore = address(r).balance;
        r.withdrawRefundOn(titleAuction);
        assertEq(address(r).balance, balBefore + 1 ether);
        assertEq(titleAuction.pendingRefund(address(r)), 0);
    }

    // ────────── anti-snipe ──────────

    function test_AntiSnipe_ExtendsEndsAt() public {
        _kickoff();
        uint64 initialEnd = titleAuction.endsAt();
        vm.warp(initialEnd - 5 minutes); // inside SNIPE_TRIGGER_WINDOW (15min)
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        assertEq(titleAuction.endsAt(), block.timestamp + 1 hours);
        assertGt(titleAuction.endsAt(), initialEnd);
    }

    function test_AntiSnipe_OutsideWindow_NoExtension() public {
        _kickoff();
        uint64 initialEnd = titleAuction.endsAt();
        vm.warp(initialEnd - 20 minutes); // outside trigger window
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        assertEq(titleAuction.endsAt(), initialEnd);
    }

    function test_AntiSnipe_Uncapped() public {
        _kickoff();
        // Each iteration warps to (current endsAt - 5min), bids, and the
        // extension pushes endsAt by `SNIPE_EXTENSION - 5min = 55min`.
        // We assert against the prior endsAt (a fresh staticcall each iter)
        // rather than block.timestamp, which `via_ir` may hoist out of the
        // loop across vm.warp calls.
        for (uint256 i = 0; i < 5; i++) {
            uint64 e = titleAuction.endsAt();
            vm.warp(e - 5 minutes);
            address bidder = makeAddr(string.concat("snipe", vm.toString(i)));
            vm.deal(bidder, 10 ether);
            vm.prank(bidder);
            titleAuction.bid{value: (i + 1) * 1 ether}();
            assertEq(titleAuction.endsAt(), e + 1 hours - 5 minutes);
        }
    }

    // ────────── settle ──────────

    function test_Settle_BeforeEnd_Reverts() public {
        _kickoff();
        vm.expectRevert(PunkVaultTitleAuction.AuctionLive.selector);
        titleAuction.settle();
    }

    /// @notice Audit F11 regression: a no-bid settle no longer strands the
    ///         title. The auction restarts in place — `endsAt` jumps by
    ///         another AUCTION_DURATION, `settled` stays false, and bidding
    ///         remains open. The Kickoff event re-fires for indexers.
    function test_Settle_NoBidder_RestartsAuction() public {
        _kickoff();
        uint64 firstEndsAt = titleAuction.endsAt();
        vm.warp(block.timestamp + 25 hours);
        titleAuction.settle();

        // Title NOT stranded — still in the auction, available for the
        // next round of bidding.
        assertFalse(titleAuction.settled(), "no-bid keeps auction live");
        assertEq(vault.titleOwner(), address(titleAuction), "title still held");
        // endsAt rolled forward by AUCTION_DURATION from the current time.
        assertEq(
            titleAuction.endsAt(),
            uint64(block.timestamp) + titleAuction.AUCTION_DURATION(),
            "endsAt extended"
        );
        assertGt(titleAuction.endsAt(), firstEndsAt, "endsAt strictly later");
        // And a bid in the restarted window goes through normally.
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        assertEq(titleAuction.highBidder(), alice);
    }

    function test_Settle_WithBidder_TransfersAndCreditsProceedsForPull() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 4 ether}();

        uint256 payoutBalBefore = address(this).balance;

        vm.warp(block.timestamp + 25 hours);
        titleAuction.settle();

        // Title transferred immediately on cleared settle.
        assertEq(vault.titleOwner(), alice);
        assertTrue(titleAuction.settled());
        // Audit F10: proceeds are CREDITED to the pull queue, not pushed — the
        // payout balance is unchanged until withdrawProceeds. 100% of cleared
        // proceeds route to payoutRecipient (= address(this) in this test).
        assertEq(address(this).balance - payoutBalBefore, 0, "payout not pushed");
        assertEq(titleAuction.pendingProceeds(address(this)), 4 ether, "payoutRecipient credited 100%");

        // An uncredited address has nothing to pull.
        vm.expectRevert(PunkVaultTitleAuction.NothingToWithdraw.selector);
        titleAuction.withdrawProceeds(bob);

        // Payout recipient pulls.
        titleAuction.withdrawProceeds();
        assertEq(address(this).balance - payoutBalBefore, 4 ether, "payoutRecipient pulled 100%");
        assertEq(titleAuction.pendingProceeds(address(this)), 0, "payout credit zeroed");
    }

    function test_Settle_Twice_AfterClearedSettle_Reverts() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 4 ether}();
        vm.warp(block.timestamp + 25 hours);
        titleAuction.settle();
        // Now settled flips true. A second settle reverts.
        vm.expectRevert(PunkVaultTitleAuction.AlreadySettled.selector);
        titleAuction.settle();
    }

    function test_Settle_NoBid_SecondSettleAttempt_RevertsAsLive() public {
        // After a no-bid settle, the auction is live again until the new
        // endsAt. A re-settle attempt before the new deadline reverts as
        // AuctionLive (NOT AlreadySettled — the no-bid path doesn't flip
        // settled).
        _kickoff();
        vm.warp(block.timestamp + 25 hours);
        titleAuction.settle();
        vm.expectRevert(PunkVaultTitleAuction.AuctionLive.selector);
        titleAuction.settle();
    }

    function test_Settle_BidAfterClearedSettle_Reverts() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 4 ether}();
        vm.warp(block.timestamp + 25 hours);
        titleAuction.settle();
        // settled flipped → bid() reverts AuctionNotLive (the `!kickedOff
        // || settled` check fires before the AuctionEnded check).
        vm.prank(bob);
        vm.expectRevert(PunkVaultTitleAuction.AuctionNotLive.selector);
        titleAuction.bid{value: 5 ether}();
    }

    function test_FullLifecycle_MultipleBidders() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        vm.prank(bob);
        titleAuction.bid{value: 3 ether}();
        vm.prank(carol);
        titleAuction.bid{value: 5 ether}();

        assertEq(titleAuction.highBidder(), carol);
        assertEq(titleAuction.highBidWei(), 5 ether);

        vm.warp(block.timestamp + 25 hours);
        titleAuction.settle();

        assertEq(vault.titleOwner(), carol);
        assertEq(titleAuction.highBidder(), carol);
    }

    // ────────── settled state ──────────

    function test_Settled_NewTitleOwner_NoPunkAccess() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        vm.warp(block.timestamp + 25 hours);
        titleAuction.settle();

        // Alice has the title; alice cannot move Punks.
        vm.prank(alice);
        vm.expectRevert(PunkVault.NotReturnAuction.selector);
        vault.receivePunk(0);
    }
}

/// @dev Contract that bids on the auction but reverts on incoming ETH —
///      used to test the pull-pattern refund fallback when a push refund
///      fails (e.g., contract bidder with unhappy `receive`).
contract RevertOnReceive {
    bool public acceptEth;

    function setAcceptEth(bool v) external {
        acceptEth = v;
    }

    function makeBid(PunkVaultTitleAuction auction) external payable {
        auction.bid{value: msg.value}();
    }

    function withdrawRefundOn(PunkVaultTitleAuction auction) external {
        auction.withdrawRefund();
    }

    receive() external payable {
        if (!acceptEth) revert("RevertOnReceive: blocked");
    }
}
