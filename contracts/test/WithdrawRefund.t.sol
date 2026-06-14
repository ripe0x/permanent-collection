// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @dev Bidder whose receive() can be toggled between "reject" and "accept".
///      Used to (a) queue a refund by failing the push during outbid, then
///      (b) successfully pull it via `withdrawRefund`.
contract ToggleableBidder {
    ReturnAuctionModule public fs;
    bool public acceptEth;
    bool public reenterOnReceive;
    uint256 public reentryHits;

    constructor(address payable _f) {
        fs = ReturnAuctionModule(_f);
    }

    function bid(uint16 punkId) external payable {
        fs.placeBidWithReferral{value: msg.value}(punkId, address(0), bytes32(0));
    }

    function withdraw() external {
        fs.withdrawRefund();
    }

    function setAccept(bool v) external {
        acceptEth = v;
    }

    function setReenter(bool v) external {
        reenterOnReceive = v;
    }

    receive() external payable {
        if (reenterOnReceive) {
            reentryHits++;
            // Try to re-enter withdrawRefund mid-call. nonReentrant should revert.
            fs.withdrawRefund();
        }
        if (!acceptEth) revert("ToggleableBidder: rejecting");
    }
}

/// @notice Direct coverage for `ReturnAuctionModule.withdrawRefund` — the
///         pull-pattern fallback for refunds that couldn't push during a
///         later bid. Pre-existing tests only verified the queue side; this
///         covers the dequeue side, its zero-balance revert, the CEI
///         ordering (balance zeroed before send), and the nonReentrant guard.
contract WithdrawRefundTest is ForkFixtures {
    uint16 internal constant PUNK_ID = 5000;
    uint128 internal constant COST = 10 ether;
    uint8 internal trait;
    uint256 internal reserve;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));

        // Move a real mainnet Punk into the return auction module's custody (same
        // pattern as ReturnAuctionModule.t.sol — bypass Patron and synth-record
        // the acquisition so we can focus on refund semantics).
        address current = punksMarket.punkIndexToAddress(PUNK_ID);
        vm.prank(current);
        punksMarket.transferPunk(address(finalSale), uint256(PUNK_ID));

        uint256 mask = punksData.traitMaskOf(PUNK_ID);
        trait = collection.canonicalTargetOf(PUNK_ID);

        vm.startPrank(address(patron));
        finalSale.startSale(PUNK_ID, COST, trait);
        collection.recordAcquisition(PUNK_ID, trait, mask, address(this), address(this), COST);
        vm.stopPrank();

        reserve = finalSale.reserveOf(PUNK_ID);
    }

    /// @notice Queue a refund for `bidder` by having it bid at reserve, then
    ///         get outbid by `bidder2`. Returns the queued amount.
    function _queueRefundFor(ToggleableBidder bidder) internal returns (uint256) {
        vm.deal(address(bidder), reserve);
        bidder.setAccept(false); // ensures push-refund fails on outbid
        bidder.bid{value: reserve}(PUNK_ID);

        // Outbid: refund push fails (bidder rejects), refund queues.
        address bidder2 = address(0xC0DE);
        vm.deal(bidder2, 100 ether);
        vm.prank(bidder2);
        finalSale.placeBidWithReferral{value: reserve + 1 ether}(PUNK_ID, address(0), bytes32(0));

        uint256 queued = finalSale.pendingRefund(address(bidder));
        require(queued == reserve, "fixture: refund not queued");
        return queued;
    }

    // ──────────────── tests ────────────────

    function test_WithdrawRefund_HappyPath_EmptiesAndZeroes() public {
        ToggleableBidder bidder = new ToggleableBidder(payable(address(finalSale)));
        uint256 queued = _queueRefundFor(bidder);
        assertEq(queued, reserve);

        // Flip the bidder to accept ETH, then withdraw.
        bidder.setAccept(true);

        uint256 fsBalBefore = address(finalSale).balance;
        uint256 bidderBefore = address(bidder).balance;

        vm.expectEmit(true, false, false, true, address(finalSale));
        emit ReturnAuctionModule.RefundWithdrawn(address(bidder), reserve);
        bidder.withdraw();

        // CEI: pendingRefund zeroed before send.
        assertEq(finalSale.pendingRefund(address(bidder)), 0, "balance zeroed");
        assertEq(address(bidder).balance - bidderBefore, reserve, "bidder credited");
        assertEq(fsBalBefore - address(finalSale).balance, reserve, "module balance dropped");
    }

    function test_WithdrawRefund_RevertsOnZeroBalance() public {
        // A fresh address with no queued refund.
        address fresh = address(0xC1EAF1);
        vm.prank(fresh);
        vm.expectRevert(ReturnAuctionModule.NothingToWithdraw.selector);
        finalSale.withdrawRefund();
    }

    function test_WithdrawRefund_RevertsOnSecondCall() public {
        // After a successful withdraw, calling again should revert (balance
        // is zero). Catches a regression where the contract failed to clear
        // the balance and would double-pay.
        ToggleableBidder bidder = new ToggleableBidder(payable(address(finalSale)));
        _queueRefundFor(bidder);
        bidder.setAccept(true);
        bidder.withdraw();

        vm.expectRevert(ReturnAuctionModule.NothingToWithdraw.selector);
        bidder.withdraw();
    }

    function test_WithdrawRefund_Reentry_IsBlocked() public {
        // Bidder's receive() tries to call withdrawRefund again mid-payout.
        // The shared nonReentrant guard with `bid` / `settle` should make
        // the outer call revert with `Reentrant` (the inner reentry attempt
        // bubbles up via the receive(), which makes the `call` return false,
        // which then triggers `TransferFailed`).
        ToggleableBidder bidder = new ToggleableBidder(payable(address(finalSale)));
        _queueRefundFor(bidder);
        bidder.setAccept(true);
        bidder.setReenter(true);

        // The outer withdraw should revert. The inner reentry hits the
        // nonReentrant guard, which makes the receive() revert, which makes
        // the .call{value:}() fail, which then trips TransferFailed.
        vm.expectRevert(ReturnAuctionModule.TransferFailed.selector);
        bidder.withdraw();

        // CEI verification: balance was set to 0 BEFORE the call out, then
        // the call failed and reverted, restoring the balance. Critically,
        // the refund is NOT lost.
        assertEq(finalSale.pendingRefund(address(bidder)), reserve, "refund preserved on revert");
    }

    function test_WithdrawRefund_TransferFailed_PreservesBalance() public {
        // A bidder that's queued for refund but still in "reject mode"
        // (acceptEth = false). Calling withdraw() pulls but the send fails;
        // the whole tx reverts and the balance is preserved (not zeroed in
        // storage even though the function wrote zero, because the revert
        // rolls it back).
        ToggleableBidder bidder = new ToggleableBidder(payable(address(finalSale)));
        _queueRefundFor(bidder);
        // Bidder still rejects ETH.
        assertFalse(bidder.acceptEth());

        vm.expectRevert(ReturnAuctionModule.TransferFailed.selector);
        bidder.withdraw();

        // Storage rolled back — refund still queued.
        assertEq(finalSale.pendingRefund(address(bidder)), reserve);
    }

    function test_WithdrawRefund_MultiBidderIndependence() public {
        // Two bidders each queue their own refund. Withdrawing one must not
        // affect the other. Assert against balance DELTAS — ToggleableBidder.bid
        // forwards `msg.value` from the test contract, so the deal'd-in seed
        // stays on the bidder and adding the refund to it would not equal
        // `reserve` directly.
        ToggleableBidder a = new ToggleableBidder(payable(address(finalSale)));
        ToggleableBidder b = new ToggleableBidder(payable(address(finalSale)));

        uint256 aSeed = address(a).balance;
        uint256 bSeed = address(b).balance;

        // a bids first, b outbids, refund queued for a.
        vm.deal(address(this), 4 * reserve);
        a.setAccept(false);
        a.bid{value: reserve}(PUNK_ID);

        b.setAccept(false);
        b.bid{value: reserve + 1 ether}(PUNK_ID);
        // a was refunded but couldn't accept; refund queues. b is now high bidder.
        assertEq(finalSale.pendingRefund(address(a)), reserve);

        // A third bidder outbids b. Now b also has a queued refund.
        address c = address(0xC3);
        vm.deal(c, 100 ether);
        vm.prank(c);
        finalSale.placeBidWithReferral{value: reserve + 2 ether}(PUNK_ID, address(0), bytes32(0));
        assertEq(finalSale.pendingRefund(address(b)), reserve + 1 ether);

        // a withdraws. b's queue is untouched.
        a.setAccept(true);
        a.withdraw();
        assertEq(finalSale.pendingRefund(address(a)), 0);
        assertEq(finalSale.pendingRefund(address(b)), reserve + 1 ether, "b queue intact");
        assertEq(address(a).balance - aSeed, reserve, "a credited reserve");

        // Now b withdraws.
        b.setAccept(true);
        b.withdraw();
        assertEq(finalSale.pendingRefund(address(b)), 0);
        assertEq(address(b).balance - bSeed, reserve + 1 ether, "b credited bid amount");
    }
}
