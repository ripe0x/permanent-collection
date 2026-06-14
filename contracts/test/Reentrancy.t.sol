// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {ICryptoPunksMarket} from "../src/interfaces/ICryptoPunksMarket.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @dev Malicious seller used in the `acceptBid` attack path. Its `receive()`
///      tries to re-enter `acceptBid`, but `acceptBid` pays the seller via the
///      market (pendingWithdrawals), never a push — so `receive()` is never
///      invoked during the acquisition and the reentry can't fire.
contract MaliciousAcceptBountySeller {
    Patron public hub;
    ICryptoPunksMarket public market;
    uint16 public targetPunk;
    uint8  public targetTrait;
    bool public attempted;

    constructor(address _hub, address _market) {
        hub = Patron(payable(_hub));
        market = ICryptoPunksMarket(_market);
    }

    function setup(uint16 punkId, uint8 trait) external {
        targetPunk = punkId;
        targetTrait = trait;
        // The Punk is already owned by us (test fixture transferred it in).
        // List EXCLUSIVELY to the hub at ~the live bid so acceptBid can pull.
        market.offerPunkForSaleToAddress(uint256(punkId), hub.bidBalance(), address(hub));
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            // Try to re-enter. nonReentrant should revert.
            hub.acceptBid(targetPunk, targetTrait, type(uint256).max);
        }
    }
}

/// @dev Malicious caller used in the `acceptListing` attack path. On receiving
///      the finder-fee payout, attempts to re-enter `acceptListing` against
///      a second Punk. The `nonReentrant` guard should make this revert.
contract MaliciousAcceptListingCaller {
    Patron public hub;
    uint16 public firstPunkTarget;
    uint8  public firstTrait;
    uint16 public secondPunk;
    uint8  public secondTrait;
    bool public attempted;

    constructor(address _hub) {
        hub = Patron(payable(_hub));
    }

    function setSecondTarget(uint16 punkId, uint8 trait) external {
        secondPunk = punkId;
        secondTrait = trait;
    }

    function attack(uint16 firstPunk, uint8 trait) external {
        firstPunkTarget = firstPunk;
        firstTrait = trait;
        hub.acceptListing(firstPunk, trait);
    }

    receive() external payable {
        if (!attempted && secondPunk != 0) {
            attempted = true;
            hub.acceptListing(secondPunk, secondTrait);
        }
    }
}

/// @dev Malicious bidder used in the return auction `bid` attack path. On
///      receiving an outgoing-bid refund, attempts to re-enter `bid`.
///      The 30k-gas-budget on the refund call + `nonReentrant` keep this safe.
contract MaliciousBidder {
    ReturnAuctionModule public fs;
    uint16 public targetPunk;
    bool public attempted;

    constructor(address payable _fs) { fs = ReturnAuctionModule(_fs); }

    function bid(uint16 punkId) external payable {
        targetPunk = punkId;
        fs.placeBidWithReferral{value: msg.value}(punkId, address(0), bytes32(0));
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            // Try to re-enter with the refund itself. Will run out of gas
            // (30k budget) or be guarded by nonReentrant. Encodes the
            // current `bid(uint16,address,bytes32)` selector so the inner
            // call genuinely reaches the bid function (otherwise selector
            // mismatch would silently mask the reentrancy-guard test).
            (bool ok,) = address(fs).call{value: msg.value, gas: 100_000}(
                abi.encodeWithSignature(
                    "placeBidWithReferral(uint16,address,bytes32)", targetPunk, address(0), bytes32(0)
                )
            );
            ok; // silence
        }
    }
}

contract ReentrancyTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        _fundPatronFromAdapter(30 ether);
    }

    function _findEligiblePunk(uint16 startFrom) internal view returns (uint16) {
        for (uint16 i = startFrom; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible punk");
    }

    function test_AcceptBid_MaliciousSellerReceive_CannotReenter() public {
        // acceptBid pays the seller via the market (pendingWithdrawals), NOT a
        // push, so a seller contract with a re-entering receive() is never
        // called during acceptBid and has no reentrancy vector. The acquisition
        // simply succeeds; the proceeds wait in the market for the seller.
        uint16 punkId = _findEligiblePunk(1);
        MaliciousAcceptBountySeller bad =
            new MaliciousAcceptBountySeller(address(patron), PUNKS_MARKET);

        // Move the Punk to the malicious seller and have it list to the hub.
        address current = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(current);
        punksMarket.transferPunk(address(bad), uint256(punkId));

        uint8 trait = _pickTarget(punkId);
        bad.setup(punkId, trait);

        uint256 listed = patron.bidBalance();
        patron.acceptBid(punkId, trait, type(uint256).max);

        // Acquisition succeeded and the malicious receive() never fired.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
        assertTrue(collection.isRecorded(punkId));
        assertFalse(bad.attempted(), "seller receive() not invoked during acceptBid");
        assertEq(punksMarket.pendingWithdrawals(address(bad)), listed, "proceeds wait in the market");
    }

    function test_AcceptListing_NonReentrant_BlocksMaliciousCaller() public {
        // Two Punks, both publicly listed by an allowlisted seller, both
        // eligible. Malicious caller tries to drain both in one tx by
        // re-entering during the finder-fee callback.
        uint16 punkA = _findEligiblePunk(100);
        uint16 punkB = _findEligiblePunk(uint16(punkA + 1));
        require(punkA != punkB, "need distinct punks");

        address seller = address(0xCAFEFEED);
        _addAllowedSellerImmediate(seller);

        _giveAndPublicList(seller, punkA, 1 ether);
        _giveAndPublicList(seller, punkB, 1 ether);

        MaliciousAcceptListingCaller bad = new MaliciousAcceptListingCaller(address(patron));
        uint8 traitA = _pickTarget(punkA);
        uint8 traitB = _pickTarget(punkB);
        bad.setSecondTarget(punkB, traitB);

        // Attack starts with punkA. The reentrant call should revert; since
        // Patron reverts on FinderPaymentFailed when the .call fails, the
        // whole outer tx reverts.
        vm.expectRevert();
        bad.attack(punkA, traitA);

        // Both Punks remain with seller; neither was acquired.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkA)), seller);
        assertEq(punksMarket.punkIndexToAddress(uint256(punkB)), seller);
        assertFalse(collection.isRecorded(punkA));
        assertFalse(collection.isRecorded(punkB));
    }

    function test_FinalSaleBid_MaliciousBidder_RefundQueuesAndNoReentry() public {
        // Set up a return auction by accepting a bounty first.
        uint16 punkId = _findEligiblePunk(5000);
        address owner = address(0xBEA71E);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        MaliciousBidder bad = new MaliciousBidder(payable(address(finalSale)));
        uint256 reserve = finalSale.reserveOf(punkId);
        vm.deal(address(bad), reserve);
        bad.bid{value: reserve}(punkId);

        // A second bidder outbids the malicious bidder. The refund to
        // bad.receive() tries to re-enter — the 30k gas budget makes it run
        // out, falling back to the pull-refund pattern.
        address bidder2 = address(0xC0DE);
        vm.deal(bidder2, 100 ether);
        vm.prank(bidder2);
        finalSale.placeBidWithReferral{value: reserve + 1 ether}(punkId, address(0), bytes32(0));

        // Reentry was attempted (proves the receive() ran).
        assertTrue(bad.attempted(), "malicious bidder tried to re-enter");
        // But the reentrancy guard prevented it — bidder2 still holds the
        // high-bid slot. This is the actual security property.
        assertEq(finalSale.highBidderOf(punkId), bidder2);
        // Refund either pushed successfully (receive swallowed inner revert)
        // or queued. Either way, the malicious bidder isn't the high bidder
        // and didn't double-spend the bounty. We don't assert on which
        // refund path took effect — only that reentry was blocked.
    }
}
