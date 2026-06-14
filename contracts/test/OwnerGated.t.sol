// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {ICryptoPunksMarket} from "../src/interfaces/ICryptoPunksMarket.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @dev Minimal smart-wallet-style owner. Lists its Punk EXCLUSIVELY to Patron
///      at the live bid and calls `acceptBid`; collects the proceeds from the
///      market with `collect()` (the seller is paid via `pendingWithdrawals`,
///      never a push from Patron).
contract SmartOwner {
    Patron public patron;
    ICryptoPunksMarket public market;

    constructor(address _patron, address _market) {
        patron = Patron(payable(_patron));
        market = ICryptoPunksMarket(_market);
    }

    function listAndAccept(uint16 punkId, uint8 target) external {
        market.offerPunkForSaleToAddress(uint256(punkId), patron.bidBalance(), address(patron));
        patron.acceptBid(punkId, target, type(uint256).max);
    }

    function collect() external {
        market.withdraw();
    }

    // Empty: the 2017 market's withdraw() uses `.transfer` (2300-gas stipend),
    // so a contract seller's receive() must do no state writes to collect.
    receive() external payable {}
}

/// @notice `acceptBid` is permissionless: the owner lists their Punk
///         EXCLUSIVELY to Patron at the live bid, and ANYONE may finalize the
///         acquisition. The target trait is protocol-derived
///         (`canonicalTargetOf`), so there is no caller-chosen target for a
///         front-runner to hijack — the remaining guard is that a non-canonical
///         target reverts. The seller is always paid the listed price through
///         the market, regardless of who calls.
contract OwnerGatedTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        _fundPatronFromAdapter(10 ether);
    }

    function _findEligiblePunk(uint16 start) internal view returns (uint16) {
        for (uint16 i = start; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible");
    }

    // ─── permissionless: a third party can finalize an owner's listing ──────

    function test_AcceptBid_PermissionlessThirdPartyCanComplete() public {
        uint16 punkId = _findEligiblePunk(100);
        address owner = address(0xCAFE);
        uint256 listed = _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);

        // A third party (not the owner) finalizes the owner's exclusive listing.
        address bot = address(0xB07);
        vm.prank(bot);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Punk acquired; the OWNER is credited the listed price by the market,
        // and the caller (bot) is paid nothing on the bid path.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
        assertTrue(collection.isRecorded(punkId));
        assertEq(punksMarket.pendingWithdrawals(owner), listed, "owner credited the listed price");
        assertEq(punksMarket.pendingWithdrawals(bot), 0, "caller paid nothing on acceptBid");
    }

    function test_AcceptBid_RevertsOnNonCanonicalTarget() public {
        uint16 punkId = _findEligiblePunk(200);
        address owner = address(0xCAFE);
        _giveAndOfferToBounty(owner, punkId);

        uint8 canonical = collection.canonicalTargetOf(punkId);
        // A target other than the canonical one is rejected (absent →
        // InvalidTargetTrait, present-but-not-canonical → NotCanonicalTarget).
        uint8 wrong = canonical == 0 ? 1 : 0;

        address attacker = address(0xBAD);
        vm.prank(attacker);
        vm.expectRevert();
        patron.acceptBid(punkId, wrong, type(uint256).max);

        // The canonical target lands cleanly (called by anyone — here the test).
        patron.acceptBid(punkId, canonical, type(uint256).max);
        assertEq(uint8(collection.getAcquisitionFor(punkId).targetTraitId), canonical);
    }

    // ─── owner / smart-wallet owner happy paths ─────────────────────────────

    function test_AcceptBid_OwnerCanCallDirectly() public {
        uint16 punkId = _findEligiblePunk(300);
        address owner = address(0xCAFE);
        uint256 listed = _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);

        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Owner collects the listed price from the market.
        uint256 ownerBefore = owner.balance;
        vm.prank(owner);
        punksMarket.withdraw();
        assertEq(owner.balance - ownerBefore, listed, "owner withdrew the listed price");
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
    }

    function test_AcceptBid_ContractOwnerCollectsFromMarket() public {
        // Smart-wallet pattern: a contract owns the Punk, lists + accepts, then
        // collects the proceeds from the market via withdraw().
        SmartOwner sw = new SmartOwner(address(patron), PUNKS_MARKET);
        uint16 punkId = _findEligiblePunk(400);

        address current = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(current);
        punksMarket.transferPunk(address(sw), uint256(punkId));

        uint8 target = _pickTarget(punkId);
        uint256 listed = patron.bidBalance();

        sw.listAndAccept(punkId, target);
        sw.collect();

        assertEq(address(sw).balance, listed, "smart owner collected the listed price");
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
    }

    // ─── acceptListing remains permissionless with a finder fee ─────────────

    function test_AcceptListing_PermissionlessFinder() public {
        // The listing path is independent of the bid path: an allowlisted
        // seller lists publicly and ANY caller can finalize for a finder fee.
        address sellerEoa = address(0xC0FFEE);
        patron.addAllowedSeller(sellerEoa);
        vm.warp(block.timestamp + patron.ALLOWLIST_DELAY() + 1);

        uint16 punkId = _findEligiblePunk(500);
        _giveAndPublicList(sellerEoa, punkId, 1 ether);

        uint8 target = _pickTarget(punkId);
        address randomBot = address(0xB07);
        vm.prank(randomBot);
        patron.acceptListing(punkId, target);

        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
    }
}
