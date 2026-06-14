// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ForkFixtures} from "./helpers/ForkFixtures.sol";
import {PermanentCollection} from "../src/PermanentCollection.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {Patron} from "../src/Patron.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";

/// @title  ReAuctionTest
/// @notice Coverage for "re-auctionable Punks". A *rescued*
///         (ReturnedToMarket) Punk can re-enter the return auction, while a
///         Punk that is InReturnAuction (an auction is live) or Vaulted
///         (terminal) can NOT. The append-only acquisitions log grows a new
///         row per re-acquisition, `_acquisitionIndexOf` re-points to the
///         latest, and the Proof-on-vault recipient is the LATEST
///         acquisition's `originalSeller` (the rescuer who finally gave the
///         Punk up). See docs/RE_AUCTION_REDESIGN.md.
contract ReAuctionTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
    }

    function _findEligiblePunk(
        uint16 start
    ) internal view returns (uint16) {
        for (uint16 i = start; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible punk");
    }

    /// @dev acceptBid → cleared (rescue) settle. The rescuer (`bidder`) ends
    ///      up owning the Punk and custody is ReturnedToMarket.
    function _acquireThenRescue(
        address seller,
        address bidder,
        uint16 punkId
    ) internal returns (uint8 target) {
        _fundPatronFromAdapter(30 ether);
        _giveAndOfferToBounty(seller, punkId);
        target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);

        uint256 reserve = finalSale.reserveOf(punkId);
        vm.deal(bidder, reserve);
        vm.prank(bidder);
        finalSale.placeBid{value: reserve}(punkId);

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);
    }

    /// @dev Re-list a rescued Punk owned by `owner_` back to Patron at the live
    ///      bid and re-accept it, targeting `target`.
    function _reacquire(
        address owner_,
        uint16 punkId,
        uint8 target
    ) internal {
        uint256 listed = patron.bidBalance();
        vm.prank(owner_);
        punksMarket.offerPunkForSaleToAddress(uint256(punkId), listed, address(patron));
        vm.prank(owner_);
        patron.acceptBid(punkId, target, type(uint256).max);
    }

    // ────────── (1) Rescue → re-acquire → silence → vault (E2E) ──────────

    function test_ReAuction_RescuedPunk_ReacquiredThenVaulted() public {
        uint16 punkId = _findEligiblePunk(1);
        address seller1 = address(0xA11CE);
        address rescuer = address(0xB0B);

        uint8 target = _acquireThenRescue(seller1, rescuer, punkId);

        // After the cleared/rescue settle: custody ReturnedToMarket, one row,
        // rescuer owns the Punk, the target trait is NOT yet collected.
        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.ReturnedToMarket),
            "rescued => ReturnedToMarket"
        );
        assertEq(collection.acquisitionCount(), 1, "one row after first acquisition");
        assertEq(punksMarket.punkIndexToAddress(punkId), rescuer, "rescuer owns punk");
        assertEq((collection.collectedMask() >> target) & 1, 0, "cleared did not collect");

        // Re-acquire the SAME Punk (re-targeting the still-uncollected trait).
        _fundPatronFromAdapter(10 ether);
        _reacquire(rescuer, punkId, target);

        // A SECOND row is appended; the index re-points to it; custody flips
        // back to InReturnAuction. The OLD row stays frozen ReturnedToMarket.
        assertEq(collection.acquisitionCount(), 2, "second acquisition row appended");
        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.InReturnAuction),
            "re-acquired => InReturnAuction"
        );
        assertEq(collection.acquisitionIndexOf(punkId), 1, "index points to latest (row 1)");
        assertEq(collection.originalSellerOf(punkId), rescuer, "latest originalSeller = rescuer");

        PermanentCollection.Acquisition memory row0 = collection.getAcquisition(0);
        assertEq(
            uint8(row0.custody), uint8(IPermanentCollection.Custody.ReturnedToMarket), "row 0 frozen ReturnedToMarket"
        );
        assertEq(row0.originalSeller, seller1, "row 0 seller unchanged");
        assertEq(row0.punkId, punkId, "row 0 still references the Punk");

        // Silence the second auction → vault. The target trait is collected
        // for the FIRST time and the Proof mints to the LATEST seller.
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertEq(
            uint8(collection.custodyOf(punkId)), uint8(IPermanentCollection.Custody.Vaulted), "silenced => Vaulted"
        );
        assertEq((collection.collectedMask() >> target) & 1, 1, "target trait now collected");
        assertEq(punksMarket.punkIndexToAddress(punkId), address(vault), "punk in vault");
        assertTrue(vault.isLocked(punkId), "punk locked");
        assertEq(vault.ownerOf(uint256(target)), rescuer, "Proof minted to latest seller (rescuer)");
        assertTrue(vault.isProofMinted(target), "proof flag set");
        assertEq(vault.totalProofsMinted(), 1, "exactly one Proof for the trait");
    }

    // ────────── (2) Vaulted Punk can NEVER be re-acquired ──────────

    function test_ReAuction_VaultedPunk_CannotBeReacquired() public {
        uint16 punkId = _findEligiblePunk(2000);
        address seller = address(0xA11CE);
        _fundPatronFromAdapter(30 ether);
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Silence → vault.
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);
        assertEq(uint8(collection.custodyOf(punkId)), uint8(IPermanentCollection.Custody.Vaulted), "vaulted");

        // The records-core custody gate rejects a Vaulted Punk. The custody
        // check fires before the target-already-collected check, so the revert
        // is AlreadyRecorded (not TargetTraitAlreadyCollected).
        uint256 mask = punksData.traitMaskOf(punkId);
        vm.prank(address(patron));
        vm.expectRevert(abi.encodeWithSelector(PermanentCollection.AlreadyRecorded.selector, punkId));
        collection.recordAcquisition(punkId, target, mask, seller, seller, 1 ether);

        // Physical backstop: the Punk is owned by the vault forever — there is
        // no path to transfer it back to the module, so startSale could never
        // run for it even if the custody gate were bypassed.
        assertEq(punksMarket.punkIndexToAddress(punkId), address(vault), "punk owned by vault");
    }

    // ────────── (3) In-auction Punk can NOT be re-acquired ──────────

    function test_ReAuction_InAuctionPunk_CannotBeReacquired() public {
        uint16 punkId = _findEligiblePunk(3000);
        address seller = address(0xA11CE);
        _fundPatronFromAdapter(30 ether);
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);
        assertEq(uint8(collection.custodyOf(punkId)), uint8(IPermanentCollection.Custody.InReturnAuction), "in auction");

        // recordAcquisition rejects an InReturnAuction Punk (custody gate).
        uint256 mask = punksData.traitMaskOf(punkId);
        vm.prank(address(patron));
        vm.expectRevert(abi.encodeWithSelector(PermanentCollection.AlreadyRecorded.selector, punkId));
        collection.recordAcquisition(punkId, target, mask, seller, seller, 1 ether);
    }

    // ────────── (4) startSale resets the slot + clears stale referrer ──────────

    function test_ReAuction_StartSale_ResetsSlotAndClearsReferrer() public {
        uint16 punkId = _findEligiblePunk(4000);
        address seller = address(0xA11CE);
        address rescuer = address(0xB0B);
        address referrer = address(0xAEF);

        _fundPatronFromAdapter(30 ether);
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Rescue with a referral-bearing bid so the referrer slot is populated.
        uint256 reserve = finalSale.reserveOf(punkId);
        vm.deal(rescuer, reserve);
        vm.prank(rescuer);
        finalSale.placeBidWithReferral{value: reserve}(punkId, referrer, bytes32("camp"));
        assertEq(finalSale.referrerOfHighBid(punkId), referrer, "referrer set on bid");

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        // Re-acquire: startSale runs again and must fully reset the slot.
        _fundPatronFromAdapter(5 ether);
        _reacquire(rescuer, punkId, target);

        assertEq(finalSale.highBidOf(punkId), 0, "highBid reset");
        assertEq(finalSale.highBidderOf(punkId), address(0), "highBidder reset");
        assertEq(finalSale.referrerOfHighBid(punkId), address(0), "stale referrer cleared");

        ReturnAuctionModule.ReturnAuction memory s = finalSale.getSale(punkId);
        assertFalse(s.settled, "settled flag reset");
        assertEq(s.targetTraitId, target, "fresh target snapshot");
        assertGt(uint256(s.endsAt), block.timestamp, "fresh deadline in the future");
        assertTrue(finalSale.isLive(punkId), "new auction is live");
    }

    // ────────── (5) Reserve re-snapshots fresh with attempt escalation ──────────

    function test_ReAuction_ReserveResnapshotsWithAttemptEscalation() public {
        uint16 punkId = _findEligiblePunk(5000);
        address seller = address(0xA11CE);
        address rescuer = address(0xB0B);

        // First acquisition at cost 1 ETH: attemptCount 0 → reserve 1.01×.
        _fundPatronFromAdapter(1 ether);
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);
        assertEq(collection.attemptCount(target), 1, "first trial bumps attemptCount to 1");
        assertEq(finalSale.reserveOf(punkId), (uint256(1 ether) * 101) / 100, "first reserve 1.01x");

        // Rescue.
        uint256 reserve = finalSale.reserveOf(punkId);
        vm.deal(rescuer, reserve);
        vm.prank(rescuer);
        finalSale.placeBid{value: reserve}(punkId);
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        // Re-acquire at a NEW cost 2 ETH: attemptCount is now 1, so the
        // re-snapshotted reserve carries the per-trait escalation forward →
        // newCost × (101 + 1) / 100 = 2 ETH × 102 / 100.
        _fundPatronFromAdapter(2 ether);
        _reacquire(rescuer, punkId, target);
        assertEq(collection.attemptCount(target), 2, "attemptCount escalates across re-auction");
        assertEq(
            finalSale.reserveOf(punkId),
            (uint256(2 ether) * 102) / 100,
            "re-auction reserve is 1.02x of the NEW acquisition cost"
        );
    }
}
