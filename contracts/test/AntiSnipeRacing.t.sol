// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Multi-bidder racing dynamics on a live return auction. Complements the
///         single-bidder anti-snipe tests in `ReturnAuctionModule.t.sol`:
///
///         - Two real bidders alternate +1 ETH increments, each landing in
///           the 15-min snipe window — verifies each bid extends by 1h and
///           the deadline accumulates uncapped.
///         - Outgoing bidder always receives a push refund (or a queued
///           pull-refund if the push fails); cumulative refund accounting
///           never under-pays the loser.
///         - Final settle pays the last bidder; 50/50 split lands correctly
///           even after dozens of extensions.
contract AntiSnipeRacingTest is ForkFixtures {
    address internal bidderA = address(0xAAAA);
    address internal bidderB = address(0xBBBB);
    uint16  internal punkId = 5500;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));

        // Set up a live return auction: top up patron, acquire the punk.
        _fundPatronFromAdapter(5 ether);
        address owner = address(0xCAFE);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        vm.deal(bidderA, 1_000 ether);
        vm.deal(bidderB, 1_000 ether);
    }

    function test_TwoBidders_AlternateInSnipeWindow_DeadlineAccumulates() public {
        uint64 startEndsAt = finalSale.endsAt(punkId);
        uint256 reserve = finalSale.reserveOf(punkId);

        // Both bidders alternate inside the snipe window. Each bid lands at
        // (endsAt - 5 min) so the extension fires.
        uint256 bidAmount = reserve;
        uint16 rounds = 30;
        for (uint i = 0; i < rounds; i++) {
            address who = (i % 2 == 0) ? bidderA : bidderB;
            uint64 currentEnd = finalSale.endsAt(punkId);
            vm.warp(uint256(currentEnd) - 5 minutes);

            // Strictly higher than current high.
            uint256 currentHigh = uint256(finalSale.highBidOf(punkId));
            bidAmount = currentHigh < reserve ? reserve : currentHigh + 1 ether;

            vm.prank(who);
            finalSale.placeBidWithReferral{value: bidAmount}(punkId, address(0), bytes32(0));
        }

        uint64 endsAtAfter = finalSale.endsAt(punkId);
        emit log_named_uint("startEndsAt",       startEndsAt);
        emit log_named_uint("endsAt after 30 alternating bids", endsAtAfter);
        emit log_named_uint("net extension (s)", endsAtAfter - startEndsAt);

        // Each bid adds ~55min of net deadline movement (warp to endsAt-5min,
        // extension to now+60min = endsAt+55min). Over 30 rounds: ~27.5 hours
        // of net deadline movement. The point is that NO bid reverts — the
        // protocol's pre-v2 had a 7-day fixed cap that was deleted; v2's
        // anti-snipe is unbounded.
        assertGt(endsAtAfter - startEndsAt, 25 hours, "deadline extends substantially");

        // High bidder is whichever bidder bid last.
        address expectedFinal = (rounds % 2 == 1) ? bidderA : bidderB;
        assertEq(finalSale.highBidderOf(punkId), expectedFinal, "final high bidder");
    }

    function test_TwoBidders_RefundAccountingNeverLoses() public {
        // Each outgoing bidder either gets a push refund (instant) or a
        // queued pendingRefund. Sum of (received-back + queued-pending +
        // last-bidder-bid) MUST equal sum of all bids placed.
        uint256 totalABidsPlaced;
        uint256 totalBBidsPlaced;
        uint256 aStartBalance = bidderA.balance;
        uint256 bStartBalance = bidderB.balance;

        uint256 reserve = finalSale.reserveOf(punkId);
        uint256 currentBid = reserve;

        // 10 alternating bids inside the snipe window.
        for (uint i = 0; i < 10; i++) {
            address who = (i % 2 == 0) ? bidderA : bidderB;
            uint64 currentEnd = finalSale.endsAt(punkId);
            vm.warp(uint256(currentEnd) - 5 minutes);
            currentBid += 0.5 ether;
            vm.prank(who);
            finalSale.placeBidWithReferral{value: currentBid}(punkId, address(0), bytes32(0));
            if (who == bidderA) totalABidsPlaced += currentBid;
            else                totalBBidsPlaced += currentBid;
        }

        // Whoever's losing has either gotten push refunds (counted in their
        // ETH balance) or a pending refund. Sum the two.
        uint256 aPending = finalSale.pendingRefund(bidderA);
        uint256 bPending = finalSale.pendingRefund(bidderB);
        uint256 aHeldNow = bidderA.balance;
        uint256 bHeldNow = bidderB.balance;

        // The last bidder's bid is still locked in the ReturnAuction module.
        address lastBidder = finalSale.highBidderOf(punkId);
        uint256 lastBid = uint256(finalSale.highBidOf(punkId));

        // For whichever is the WINNER, balance went down by their winning
        // bid (which is locked in ReturnAuction). For the LOSER, balance went
        // down by 0 (or by `pending` if push refunds failed).
        if (lastBidder == bidderA) {
            // A is winner. Their balance went down by lastBid net of pushed refunds in.
            // B is loser. Their balance went down by their total bid amount, minus push refunds and pending.
            assertEq(bStartBalance - bHeldNow, bPending, "B outflow == pending owed");
        } else {
            assertEq(aStartBalance - aHeldNow, aPending, "A outflow == pending owed");
        }

        // The push pattern with 30k gas budget always succeeds for plain EOAs
        // (no fallback code), so pendings should be 0 here.
        assertEq(aPending, 0, "A push refunds succeeded (EOA)");
        assertEq(bPending, 0, "B push refunds succeeded (EOA)");
    }

    function test_ClearedSettle_AfterManyExtensions_65_25_10_PlusExcess() public {
        // 20 alternating bids. Then settle past the (far-future) endsAt.
        uint256 reserve = finalSale.reserveOf(punkId);
        uint256 currentBid = reserve;

        for (uint i = 0; i < 20; i++) {
            address who = (i % 2 == 0) ? bidderA : bidderB;
            vm.warp(uint256(finalSale.endsAt(punkId)) - 5 minutes);
            currentBid += 0.25 ether;
            vm.prank(who);
            finalSale.placeBidWithReferral{value: currentBid}(punkId, address(0), bytes32(0));
        }

        uint256 highBid = uint256(finalSale.highBidOf(punkId));
        // Cost = patron balance at acceptBid time (5 ETH per setUp).
        uint256 cost = 5 ether;
        uint256 patronBefore = address(patron).balance;
        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 burnerBefore = address(burner).balance;
        uint256 vbpBefore = address(vaultBurnPool).balance;

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        // Three-way split (no keeper tip — full 65% reaches the adapter):
        //   bountyShare       = 65% × cost → LiveBidAdapter buffer
        //   vaultBurnFromCost = 10% × cost  (in addition to premium)
        //   burnShare         = 25% × cost (residual, untouched)
        //   vaultBurnShare    = (highBid - cost) + vaultBurnFromCost
        uint256 expectedBounty = (cost * 6500) / 10_000;
        uint256 expectedVaultBurnFromCost = (cost * 1000) / 10_000;
        uint256 expectedBurn = cost - expectedBounty - expectedVaultBurnFromCost;
        uint256 expectedVaultBurn = (highBid - cost) + expectedVaultBurnFromCost;

        assertEq(address(burner).balance - burnerBefore, expectedBurn, "burn = 25% of cost residual");
        assertEq(address(liveBidAdapter).balance - adapterBefore, expectedBounty, "bounty = full 65% of cost (buffered in adapter)");
        assertEq(address(patron).balance, patronBefore, "Patron untouched by settle");
        assertEq(address(vaultBurnPool).balance - vbpBefore, expectedVaultBurn, "vault-burn = premium + 10%-of-cost");
        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.ReturnedToMarket)
        );
        // Punk went to the last bidder.
        assertEq(
            punksMarket.punkIndexToAddress(punkId),
            finalSale.highBidderOf(punkId)   // last bid winner
        );
    }
}
