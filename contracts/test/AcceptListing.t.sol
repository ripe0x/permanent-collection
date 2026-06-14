// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {ICryptoPunksMarket} from "../src/interfaces/ICryptoPunksMarket.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @dev Simulates the PunkStrategy yoyo flow: a contract that buys floor
///      Punks and re-lists them publicly at a fixed markup. The acceptListing
///      path lets our protocol accept its listing whenever bounty ≥ listing
///      price. On sale proceeds, this mock simulates the buy-and-burn step by
///      tracking received ETH (no actual swap needed for the test).
contract MockPunkStrategy {
    ICryptoPunksMarket public immutable market;
    uint256 public proceedsBurned;

    constructor(
        address _market
    ) {
        market = ICryptoPunksMarket(_market);
    }

    function takeOwnership(
        uint16 punkId
    ) external {
        // Pretend we bought the Punk from the floor — caller transfers it in.
        // In reality PunkStrategy calls buyPunk directly, but we just need to
        // simulate the post-buy state for the test.
    }

    function listForSale(
        uint16 punkId,
        uint256 price
    ) external {
        market.offerPunkForSale(uint256(punkId), price);
    }

    receive() external payable {
        // Simulate burn flow: track proceeds as "burned".
        proceedsBurned += msg.value;
    }
}

contract AcceptListingTest is ForkFixtures {
    MockPunkStrategy internal punkStrategy;
    uint16 internal punkId = 7777;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        _fundPatronFromAdapter(30 ether);

        punkStrategy = new MockPunkStrategy(PUNKS_MARKET);

        // Move a real Punk into the MockPunkStrategy contract to simulate the
        // floor-buy step, then have it publicly list at a 1.2× markup.
        address current = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(current);
        punksMarket.transferPunk(address(punkStrategy), uint256(punkId));
    }

    function _listAt(
        uint256 price
    ) internal {
        vm.prank(address(punkStrategy));
        punkStrategy.listForSale(punkId, price);
    }

    function test_AcceptListing_HappyPath_PunkStrategyAllowlisted() public {
        _addAllowedSellerImmediate(address(punkStrategy));
        uint256 listingPrice = 15 ether;
        _listAt(listingPrice);

        uint256 hubBefore = patron.bidBalance();
        uint256 callerBefore = address(this).balance;

        patron.acceptListing(punkId, _pickTarget(punkId));

        // Per CryptoPunks market semantics, buyPunk proceeds queue in
        // pendingWithdrawals[seller] rather than transferring directly.
        // Strategy can claim by calling market.withdraw().
        assertEq(
            punksMarket.pendingWithdrawals(address(punkStrategy)),
            listingPrice,
            "strategy can withdraw listing proceeds"
        );

        // Punk is now in ReturnAuction custody; PC recorded acquisition.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
        assertTrue(collection.isRecorded(punkId));

        // ReturnAuction opening = paid × (100 + attemptCount) / 100. First trial of
        // this trait → reserve = 1.01 × paid.
        uint256 expectedReserve = (listingPrice * 101) / 100;
        assertEq(finalSale.reserveOf(punkId), expectedReserve);

        // Caller earned a finder fee; bounty decreased by minValue + fee.
        uint256 callerReward = address(this).balance - callerBefore;
        assertGt(callerReward, 0, "finder fee paid");
        assertLe(callerReward, patron.finderFeeFixedCap(), "fee under fixed cap");
        assertEq(address(patron).balance, hubBefore - listingPrice - callerReward, "bounty paid out");
        assertEq(patron.bidBalance(), hubBefore - listingPrice - callerReward, "bid balance debited");
    }

    function test_AcceptListing_RevertsIfSellerNotAllowed() public {
        // Allowlist is empty.
        _listAt(15 ether);
        uint8 target = _pickTarget(punkId);
        vm.expectRevert(abi.encodeWithSelector(Patron.SellerNotAllowed.selector, address(punkStrategy)));
        patron.acceptListing(punkId, target);
    }

    function test_AcceptListing_RevertsIfPriceExceedsBounty() public {
        _addAllowedSellerImmediate(address(punkStrategy));
        uint256 listingPrice = 100 ether; // hub only has 30
        _listAt(listingPrice);
        uint8 target = _pickTarget(punkId);
        vm.expectRevert(); // ListingExceedsBid
        patron.acceptListing(punkId, target);
    }

    function test_AcceptListing_RevertsIfListingRestrictedToAddress() public {
        _addAllowedSellerImmediate(address(punkStrategy));
        vm.prank(address(punkStrategy));
        punksMarket.offerPunkForSaleToAddress(uint256(punkId), 15 ether, address(0xCAFE));
        uint8 target = _pickTarget(punkId);
        vm.expectRevert(abi.encodeWithSelector(Patron.PunkNotPubliclyListed.selector, punkId));
        patron.acceptListing(punkId, target);
    }

    function test_AcceptListing_RevertsOnZeroPriceListing() public {
        _addAllowedSellerImmediate(address(punkStrategy));
        _listAt(0);
        uint8 target = _pickTarget(punkId);
        vm.expectRevert(abi.encodeWithSelector(Patron.ZeroListingPrice.selector, punkId));
        patron.acceptListing(punkId, target);
    }

    function test_AcceptListing_RevertsIfBountyBelowMinimum() public {
        _addAllowedSellerImmediate(address(punkStrategy));
        _listAt(0.1 ether);
        // Spend the hub down below MIN_BID_FOR_LISTING (0.5 ETH).
        uint16 drainPunk = 1;
        address owner = address(0xB0B);
        _giveAndOfferToBounty(owner, drainPunk);
        uint8 drainTarget = _pickTarget(drainPunk);
        vm.prank(owner);
        patron.acceptBid(drainPunk, drainTarget, type(uint256).max);
        _fundPatronFromAdapter(0.1 ether);
        uint8 target = _pickTarget(punkId);
        vm.expectRevert();
        patron.acceptListing(punkId, target);
    }

    function test_AcceptListing_RevertsIfPunkAlreadyCollected() public {
        _addAllowedSellerImmediate(address(punkStrategy));
        // Mark every trait the Punk would carry as already collected.
        uint256 mask = punksData.traitMaskOf(punkId);
        _setCollectedMask(mask);

        _listAt(15 ether);
        uint8 target;
        for (uint8 i = 0; i < 111; i++) {
            if ((mask >> i) & 1 == 1) {
                target = i;
                break;
            }
        }
        vm.expectRevert(abi.encodeWithSelector(Patron.TargetTraitAlreadyCollected.selector, target));
        patron.acceptListing(punkId, target);
    }

    function test_RemoveAllowedSeller_TakesEffectImmediately() public {
        _addAllowedSellerImmediate(address(punkStrategy));
        assertTrue(patron.allowedSellers(address(punkStrategy)));

        patron.removeAllowedSeller(address(punkStrategy));
        assertFalse(patron.allowedSellers(address(punkStrategy)));

        _listAt(15 ether);
        uint8 target = _pickTarget(punkId);
        vm.expectRevert(abi.encodeWithSelector(Patron.SellerNotAllowed.selector, address(punkStrategy)));
        patron.acceptListing(punkId, target);
    }

    function test_Allowlist_LocksAfterAdminBurned() public {
        // When the admin role is BURNED (transferAdmin(address(0))),
        // `admin` is address(0), so the `onlyAdminEvenIfLocked` carve-out
        // also closes — no caller can match msg.sender == admin == 0.
        // Burning is the only way to permanently disable allowlist edits.
        _addAllowedSellerImmediate(address(punkStrategy));
        adminContract.transferAdmin(address(0));
        assertTrue(adminContract.isLocked());
        assertEq(adminContract.admin(), address(0));

        address other = address(0xCAFE99);
        vm.expectRevert(Patron.NotAdmin.selector);
        patron.addAllowedSeller(other);
        vm.expectRevert(Patron.NotAdmin.selector);
        patron.removeAllowedSeller(address(punkStrategy));
    }

    function test_AllowlistEditable_AfterTimerExpiry() public {
        _addAllowedSellerImmediate(address(punkStrategy));
        // Fast-forward past the 1y timer expiry, without burning the role.
        vm.warp(block.timestamp + 366 days);
        assertTrue(adminContract.isLocked());

        // Allowlist setters still work past the timer expiry — the admin EOA
        // is still set, just the timer expired. The allowlist carve-out only
        // checks `msg.sender == admin`, not the timer. (Patron has no
        // checkAdmin-gated economic setter to contrast against anymore — the
        // finder-fee parameters are protocol constants.)
        address other = address(0xCAFE99);
        patron.addAllowedSeller(other);
        assertTrue(patron.allowedSellers(other), "allowlist still editable past lock");

        patron.removeAllowedSeller(other);
        assertFalse(patron.allowedSellers(other));
    }
}
