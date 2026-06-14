// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Direct coverage of the M-1 min-bid-increment guard. The fixed
///         100 bps requirement — now a protocol constant
///         (`minBidIncrementBps`), not an admin-tunable parameter — caps the
///         indefinite-anti-snipe DoS by compounding the bid value by 1% per
///         round, so the locked-capital cost to keep an auction live grows
///         geometrically. (The former `setMinBidIncrementBps` bounds/admin
///         tests were removed with the setter.)
contract MinBidIncrementTest is ForkFixtures {
    uint16 internal punkId = 5500;
    uint128 internal cost = 10 ether;
    uint8 internal trait;
    uint256 internal reserve;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));

        // Stage a live return auction by directly invoking the patron-only path,
        // skipping the market-side rigmarole that the per-test logic doesn't
        // need to verify (covered separately in AcceptBounty.t.sol).
        address current = punksMarket.punkIndexToAddress(punkId);
        vm.prank(current);
        punksMarket.transferPunk(address(finalSale), uint256(punkId));

        uint256 mask = punksData.traitMaskOf(punkId);
        trait = collection.canonicalTargetOf(punkId);

        vm.startPrank(address(patron));
        finalSale.startSale(punkId, cost, trait);
        collection.recordAcquisition(punkId, trait, mask, address(this), address(this), cost);
        vm.stopPrank();

        reserve = finalSale.reserveOf(punkId);
    }

    // ─── default 100 bps behavior ───────────────────────────────────────

    function test_FirstBid_OnlyNeedsToMeetReserve() public {
        // First bid: only the reserve constraint applies; the increment check
        // is skipped because there's no prior high to increment from.
        vm.deal(address(this), 100 ether);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));
        assertEq(finalSale.highBidOf(punkId), uint128(reserve));
    }

    function test_SecondBid_RevertsBelowMinIncrement_Default100Bps() public {
        vm.deal(address(this), 100 ether);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));

        // Contract threshold: currentHigh × (10_000 + bps) / 10_000.
        // Bidding strictly below it reverts; bidding at-or-above succeeds.
        uint256 currentHigh = reserve;
        uint256 threshold = currentHigh + (currentHigh * 100) / 10_000;

        // One wei below the threshold reverts.
        address otherBidder = address(0xB1);
        vm.deal(otherBidder, 100 ether);
        vm.prank(otherBidder);
        vm.expectRevert(
            abi.encodeWithSelector(
                ReturnAuctionModule.BidBelowMinIncrement.selector, threshold - 1, threshold
            )
        );
        finalSale.placeBidWithReferral{value: threshold - 1}(punkId, address(0), bytes32(0));
    }

    function test_SecondBid_SucceedsAtExactMinIncrement_Default100Bps() public {
        vm.deal(address(this), 100 ether);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));

        uint256 currentHigh = reserve;
        uint256 threshold = currentHigh + (currentHigh * 100) / 10_000;

        address otherBidder = address(0xB2);
        vm.deal(otherBidder, 100 ether);
        vm.prank(otherBidder);
        finalSale.placeBidWithReferral{value: threshold}(punkId, address(0), bytes32(0));
        assertEq(finalSale.highBidOf(punkId), uint128(threshold));
    }

    function test_SecondBid_RevertsAtPlusOneWei() public {
        // Pre-M-1 the protocol allowed currentHigh + 1 wei; that path is now
        // explicitly broken to defang the 1-wei-overbid griefer.
        vm.deal(address(this), 100 ether);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));

        address otherBidder = address(0xB3);
        vm.deal(otherBidder, 100 ether);
        vm.prank(otherBidder);
        vm.expectRevert(); // BidBelowMinIncrement
        finalSale.placeBidWithReferral{value: reserve + 1}(punkId, address(0), bytes32(0));
    }

    function test_IncrementCompounds_BidValueGrowsGeometrically() public {
        // Walk 10 rounds at exactly the min increment; verify the bid
        // approximately doubles in value vs starting at reserve.
        vm.deal(address(this), 10_000 ether);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));
        uint256 high = reserve;
        for (uint256 i = 0; i < 10; i++) {
            uint256 next = high + (high * 100) / 10_000 + 1;
            address bidder = address(uint160(0x1000 + i));
            vm.deal(bidder, 10_000 ether);
            vm.prank(bidder);
            finalSale.placeBidWithReferral{value: next}(punkId, address(0), bytes32(0));
            high = next;
        }
        // After 10 × 1% increments, bid is reserve × 1.01^10 ≈ 1.1046 × reserve.
        assertGt(high, (reserve * 1100) / 1000, "bid grew >10% after 10 rounds");
        assertLt(high, (reserve * 1110) / 1000, "bid grew <11% after 10 rounds");
    }
}
