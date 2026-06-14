// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {LiveBidAdapter} from "../src/LiveBidAdapter.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

contract AcceptBountyTest is ForkFixtures {
    address internal punkOwner = address(0xBEA71E);

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        // Seed live bid.
        _fundPatronFromAdapter(30 ether);
    }

    function _findPunkWithUncollectedTrait() internal view returns (uint16, uint256) {
        for (uint16 i = 0; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return (i, mask);
        }
        revert("no eligible punk");
    }

    function test_AcceptBounty_HappyPath() public {
        (uint16 punkId, uint256 mask) = _findPunkWithUncollectedTrait();
        _giveAndOfferToBounty(punkOwner, punkId);

        uint256 hubBefore = patron.bidBalance();

        uint8 target = _pickTarget(punkId);
        vm.prank(punkOwner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Owner is paid the listed price (== the bid) via the market's
        // pendingWithdrawals, NOT a push from Patron; they collect with withdraw().
        assertEq(punksMarket.pendingWithdrawals(punkOwner), hubBefore, "listed price credited in market");
        uint256 ownerBefore = punkOwner.balance;
        vm.prank(punkOwner);
        punksMarket.withdraw();
        assertEq(punkOwner.balance - ownerBefore, hubBefore, "owner withdrew the listed price");
        assertEq(address(patron).balance, 0, "patron paid the listed price out via buyPunk");
        assertEq(patron.bidBalance(), 0, "bid balance debited");

        // Punk now in ReturnAuctionModule; PermanentCollection records it.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
        assertTrue(collection.isRecorded(punkId));
        assertEq(uint8(collection.custodyOf(punkId)), uint8(IPermanentCollection.Custody.InReturnAuction));

        // ReturnAuction opening = paid × (100 + attemptCount) / 100. First trial of
        // this trait → reserve = 1.01 × paid.
        uint256 expectedReserve = (hubBefore * 101) / 100;
        assertEq(finalSale.reserveOf(punkId), expectedReserve);
        mask; // silence unused
    }

    function test_AcceptBounty_RevertsIfNotListedToHub() public {
        (uint16 punkId,) = _findPunkWithUncollectedTrait();
        uint8 target = _pickTarget(punkId);
        // Owner takes custody but does NOT list to Patron.
        address current = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(current);
        punksMarket.transferPunk(punkOwner, uint256(punkId));

        vm.expectRevert(abi.encodeWithSelector(Patron.PunkNotListedToHub.selector, punkId));
        vm.prank(punkOwner);
        patron.acceptBid(punkId, target, type(uint256).max);
    }

    function test_AcceptBounty_RevertsIfListedToWrongAddress() public {
        (uint16 punkId,) = _findPunkWithUncollectedTrait();
        uint8 target = _pickTarget(punkId);
        address current = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(current);
        punksMarket.transferPunk(punkOwner, uint256(punkId));
        vm.prank(punkOwner);
        // Listed to someone else, not Patron.
        punksMarket.offerPunkForSaleToAddress(uint256(punkId), 0, address(0xDEAD));

        vm.expectRevert(abi.encodeWithSelector(Patron.PunkNotListedToHub.selector, punkId));
        vm.prank(punkOwner);
        patron.acceptBid(punkId, target, type(uint256).max);
    }

    function test_AcceptBounty_RevertsIfPunkHasNoUncollectedTrait() public {
        // Make every trait collected so the next Punk is ineligible.
        _setCollectedMask(collection.FULL_SET_MASK());

        uint16 punkId = 1;
        _giveAndOfferToBounty(punkOwner, punkId);

        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 target;
        for (uint8 i = 0; i < 111; i++) {
            if ((mask >> i) & 1 == 1) {
                target = i;
                break;
            }
        }
        vm.expectRevert(abi.encodeWithSelector(Patron.TargetTraitAlreadyCollected.selector, target));
        vm.prank(punkOwner);
        patron.acceptBid(punkId, target, type(uint256).max);
    }

    function test_AcceptBounty_RevertsIfPunkInAuction() public {
        (uint16 punkId,) = _findPunkWithUncollectedTrait();
        _giveAndOfferToBounty(punkOwner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(punkOwner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // The Punk is now InReturnAuction (held by the module) and no longer
        // listed to Patron, so a second acceptBid reverts at the listing
        // check — the realistic block on re-acquiring an in-auction Punk.
        // Re-acquisition is permitted ONLY from custody ReturnedToMarket; the
        // records-core custody gate is the deeper defense (see ReAuction.t.sol
        // for the direct recordAcquisition assertion). See
        // docs/RE_AUCTION_REDESIGN.md.
        vm.expectRevert(abi.encodeWithSelector(Patron.PunkNotListedToHub.selector, punkId));
        vm.prank(punkOwner);
        patron.acceptBid(punkId, target, type(uint256).max);
    }

    function test_AcceptBounty_OutOfRangePunkReverts() public {
        // No prank needed — InvalidPunkId reverts before the seller check.
        vm.expectRevert(abi.encodeWithSelector(Patron.InvalidPunkId.selector, uint16(10_000)));
        patron.acceptBid(10_000, 0, type(uint256).max);
    }

    function test_AcceptBounty_RevertsOnInvalidTarget() public {
        (uint16 punkId, uint256 mask) = _findPunkWithUncollectedTrait();
        _giveAndOfferToBounty(punkOwner, punkId);
        // Find a bit NOT set on this Punk's mask.
        uint8 absent;
        for (uint8 i = 0; i < 111; i++) {
            if ((mask >> i) & 1 == 0) {
                absent = i;
                break;
            }
        }
        vm.expectRevert(abi.encodeWithSelector(Patron.InvalidTargetTrait.selector, punkId, absent));
        vm.prank(punkOwner);
        patron.acceptBid(punkId, absent, type(uint256).max);
    }

    function test_AcceptBid_RevertsIfListingAboveExpectedCap() public {
        (uint16 punkId,) = _findPunkWithUncollectedTrait();
        uint256 listed = _giveAndOfferToBounty(punkOwner, punkId);
        uint8 target = _pickTarget(punkId);

        // `expectedListingWei` caps what the protocol will pay; a cap below the
        // listed price reverts (guards the caller against a seller who raised
        // the price after the caller's read).
        vm.expectRevert(abi.encodeWithSelector(Patron.ListingAboveExpected.selector, listed, listed - 1));
        patron.acceptBid(punkId, target, listed - 1);

        // A cap at the listed price succeeds.
        patron.acceptBid(punkId, target, listed);
    }

    function test_AcceptBid_AcceptsListingBelowBid() public {
        (uint16 punkId,) = _findPunkWithUncollectedTrait();
        uint8 target = _pickTarget(punkId);
        uint256 bid = patron.bidBalance();

        // A seller may list BELOW the live bid; the protocol pays the lower
        // listed price and the pool keeps the difference. There is no reserve
        // floor — the return auction's open-market exposure is the anti-grief
        // mechanism, not the listing price.
        address owner_ = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(owner_);
        punksMarket.transferPunk(punkOwner, uint256(punkId));
        uint256 lowPrice = bid / 2;
        vm.prank(punkOwner);
        punksMarket.offerPunkForSaleToAddress(uint256(punkId), lowPrice, address(patron));

        patron.acceptBid(punkId, target, type(uint256).max);

        // Paid the listed (lower) price via the market; the pool retains the rest;
        // the return-auction reserve is taken off the listed price.
        assertEq(punksMarket.pendingWithdrawals(punkOwner), lowPrice, "seller credited the listed price");
        assertEq(patron.bidBalance(), bid - lowPrice, "pool debited only the listed price");
        assertEq(finalSale.reserveOf(punkId), (lowPrice * 101) / 100, "reserve off the listed price");
    }

    function test_AcceptBid_RevertsIfListedAtZero() public {
        (uint16 punkId,) = _findPunkWithUncollectedTrait();
        uint8 target = _pickTarget(punkId);

        // A zero-price listing is rejected outright — there is no "donate a Punk
        // for 0" path; the seller must list at a real price.
        address owner_ = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(owner_);
        punksMarket.transferPunk(punkOwner, uint256(punkId));
        vm.prank(punkOwner);
        punksMarket.offerPunkForSaleToAddress(uint256(punkId), 0, address(patron));

        vm.expectRevert(abi.encodeWithSelector(Patron.ZeroListingPrice.selector, punkId));
        patron.acceptBid(punkId, target, type(uint256).max);
    }

    function test_AcceptBounty_RevertsIfTargetTraitPending() public {
        // First acquisition makes the target trait pending.
        (uint16 punk1,) = _findPunkWithUncollectedTrait();
        _giveAndOfferToBounty(punkOwner, punk1);
        uint8 target = _pickTarget(punk1);
        vm.prank(punkOwner);
        patron.acceptBid(punk1, target, type(uint256).max);

        // Find a different Punk that also carries the same target trait.
        uint16 punk2 = type(uint16).max;
        for (uint16 i = 0; i < 10_000; i++) {
            if (i == punk1) continue;
            uint256 m = punksData.traitMaskOf(i);
            if ((m >> target) & 1 == 1) {
                punk2 = i;
                break;
            }
        }
        require(punk2 != type(uint16).max, "fixture: no second punk with same trait");

        // Refill live bid and offer the second Punk to Patron.
        _fundPatronFromAdapter(10 ether);
        _giveAndOfferToBounty(punkOwner, punk2);

        vm.expectRevert(abi.encodeWithSelector(Patron.TargetTraitPending.selector, target));
        vm.prank(punkOwner);
        patron.acceptBid(punk2, target, type(uint256).max);
    }

    function test_Adapter_ReceivesTopUpsAndEmitsEvent() public {
        uint256 bufBefore = liveBidAdapter.bufferedEth();
        address fan = address(0xFA7);
        vm.deal(fan, 5 ether);

        // Under inflow consolidation, unattributed bare top-ups go to the
        // adapter (the single faucet into the live bid) via its `receive()`,
        // which emits `BareTopUp` and buffers the ETH. It meters into Patron on
        // the next `sweep()`. Use `LiveBidAdapter.contribute(referrer, tag)`
        // for attribution.
        vm.expectEmit(true, false, false, true, address(liveBidAdapter));
        emit LiveBidAdapter.BareTopUp(fan, 5 ether);

        vm.prank(fan);
        (bool ok,) = address(liveBidAdapter).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(liveBidAdapter.bufferedEth(), bufBefore + 5 ether, "buffered in the adapter");
    }

    /// @dev Direct sends to Patron are rejected — only the adapter may fund it.
    function test_Patron_RejectsDirectSend() public {
        address fan = address(0xFA7);
        vm.deal(fan, 5 ether);
        vm.prank(fan);
        (bool ok,) = address(patron).call{value: 5 ether}("");
        assertFalse(ok, "direct send to Patron rejected (NotAdapter)");
    }
}
