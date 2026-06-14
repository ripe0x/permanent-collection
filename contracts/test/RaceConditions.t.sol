// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {ICryptoPunksMarket} from "../src/interfaces/ICryptoPunksMarket.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Same-block race conditions that affect bounty / listing entry
///         points. The protocol explicitly serialises Final Sales per
///         trait via the `TargetTraitPending` guard, and the listing
///         dispatch path checks the live market offer state at execution
///         time — these tests pin both behaviours under hostile ordering.
contract RaceConditionsTest is ForkFixtures {
    /// @dev Minimal helper for `_listAt` paths: a mock yoyo-style seller
    ///      that publicly lists a Punk at a fixed price.
    function _publicList(address seller, uint16 punkId, uint256 priceWei) internal {
        vm.prank(seller);
        punksMarket.offerPunkForSale(uint256(punkId), priceWei);
    }

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        // Pre-seed bounty above MIN_BID_FOR_LISTING with room for two
        // listing prices.
        _fundPatronFromAdapter(50 ether);
    }

    // ────────────────────────────────────────────────────────────────
    //  Gap #9: Two acceptListing calls in the same block, different
    //          Punks, same target trait. Second must revert with
    //          `TargetTraitPending`.
    // ────────────────────────────────────────────────────────────────

    /// @notice Canonical target derivation upholds the one-in-flight-per-trait
    ///         invariant WITHOUT a collision: the caller no longer supplies the
    ///         target, so two acceptListing calls in the same block can't both
    ///         target the same trait. The first call makes trait T pending;
    ///         because `canonicalTargetOf` EXCLUDES pending traits, a second
    ///         Punk that also carries T derives a DIFFERENT canonical target —
    ///         it routes around the pending trait and its acquisition succeeds.
    function test_AcceptListing_SameTrait_SecondRoutesAroundPending() public {
        // A's canonical target is T; B also carries T plus another trait.
        (uint16 punkA, uint16 punkB, uint8 sharedTrait) = _findCanonicalCollisionPair();
        assertTrue(punkA != punkB, "fixture: two distinct Punks");
        assertEq(collection.canonicalTargetOf(punkA), sharedTrait, "A canonical is T");

        // Move both Punks under an allowlisted seller and publicly list
        // them at a low fixed price so the bounty can absorb both.
        address seller = address(0xC0FFEE);
        address ownerA = punksMarket.punkIndexToAddress(uint256(punkA));
        vm.prank(ownerA);
        punksMarket.transferPunk(seller, uint256(punkA));
        address ownerB = punksMarket.punkIndexToAddress(uint256(punkB));
        vm.prank(ownerB);
        punksMarket.transferPunk(seller, uint256(punkB));

        // Allowlist + warp past activation delay.
        _addAllowedSellerImmediate(seller);

        // Both publicly listed.
        _publicList(seller, punkA, 1 ether);
        _publicList(seller, punkB, 1 ether);

        // First listing acquires A toward its canonical target T → T pending.
        patron.acceptListing(punkA, sharedTrait);
        assertEq(collection.pendingTraitCount(sharedTrait), 1, "T now pending");

        // B also carries T, but its canonical now routes AROUND the pending T
        // to a different uncollected trait. The second acquisition succeeds.
        uint8 targetB = collection.canonicalTargetOf(punkB);
        assertTrue(targetB != sharedTrait, "B's canonical routed around pending T");
        patron.acceptListing(punkB, targetB);

        // Both Punks acquired; one in-flight acquisition per trait upheld.
        assertTrue(collection.isRecorded(punkB), "B acquired toward a different trait");
        assertEq(collection.pendingTraitCount(sharedTrait), 1, "still exactly one in-flight for T");
        assertEq(collection.pendingTraitCount(targetB), 1, "B's distinct trait now pending");
    }

    /// @notice Same as above but mixing entry points: first call uses
    ///         `acceptListing`, second uses `acceptBid`. Both derive the target
    ///         from `canonicalTargetOf`, so the second can't collide with the
    ///         first's now-pending trait — it routes around it and succeeds.
    function test_AcceptBounty_AfterAcceptListing_SecondRoutesAroundPending() public {
        (uint16 punkA, uint16 punkB, uint8 sharedTrait) = _findCanonicalCollisionPair();
        address seller = address(0xC0FFEE);
        address ownerA = punksMarket.punkIndexToAddress(uint256(punkA));
        vm.prank(ownerA);
        punksMarket.transferPunk(seller, uint256(punkA));
        _addAllowedSellerImmediate(seller);
        _publicList(seller, punkA, 1 ether);
        patron.acceptListing(punkA, sharedTrait);
        assertEq(collection.pendingTraitCount(sharedTrait), 1, "T now pending");

        // punkB also carries T, but acceptBid targets B's canonical, which now
        // routes around the pending T. The acquisition succeeds with a
        // different target.
        address ownerB = punksMarket.punkIndexToAddress(uint256(punkB));
        uint256 listedB = patron.bidBalance();
        vm.prank(ownerB);
        punksMarket.offerPunkForSaleToAddress(uint256(punkB), listedB, address(patron));
        uint8 targetB = collection.canonicalTargetOf(punkB);
        assertTrue(targetB != sharedTrait, "B's canonical routed around pending T");
        vm.prank(ownerB);
        patron.acceptBid(punkB, targetB, type(uint256).max);

        assertTrue(collection.isRecorded(punkB), "B acquired toward a different trait");
        assertEq(collection.pendingTraitCount(sharedTrait), 1, "still exactly one in-flight for T");
        assertEq(collection.pendingTraitCount(targetB), 1, "B's distinct trait now pending");
    }

    // ────────────────────────────────────────────────────────────────
    //  Gap #10: acceptBid + transferPunk race. Owner lists to Patron
    //           at the live bid, then transfers the Punk elsewhere BEFORE
    //           acceptBid. The acquisition must revert cleanly (the offer is
    //           cleared on transfer) and the bid must be untouched.
    // ────────────────────────────────────────────────────────────────

    /// @notice Owner pre-lists to Patron, then transfers Punk away in the
    ///         same block. Patron.acceptBid should revert and Patron's
    ///         balance must remain intact.
    function test_AcceptBounty_OwnerTransferredAway_RevertsCleanly() public {
        uint16 punkId = _findEligiblePunk(1);
        address owner = address(0xBA771E);
        address other = address(0xC077E1);
        _giveAndOfferToBounty(owner, punkId);
        // 1) Confirm the listing is in place pre-race.
        (bool isForSale,,,uint256 minValue, address onlySellTo) =
            punksMarket.punksOfferedForSale(uint256(punkId));
        assertTrue(isForSale, "pre-race: listed");
        assertEq(onlySellTo, address(patron), "pre-race: addressed to patron");
        assertGt(minValue, 0, "pre-race: listed at a real price");

        // 2) Same block: owner transfers Punk away. CryptoPunks market
        //    clears the offer on any transfer. Anyone calling acceptBid
        //    after this must hit Patron's PunkNotListedToHub guard.
        vm.prank(owner);
        punksMarket.transferPunk(other, uint256(punkId));
        (bool stillForSale,,,,) = punksMarket.punksOfferedForSale(uint256(punkId));
        assertFalse(stillForSale, "post-race: offer cleared");

        // 3) acceptBid reverts cleanly with PunkNotListedToHub. The
        //    caller (now the new owner `other`) doesn't matter — the
        //    listing guard fires before the msg.sender check.
        uint8 target = _pickTarget(punkId);
        uint256 patronBefore = address(patron).balance;
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(Patron.PunkNotListedToHub.selector, punkId)
        );
        patron.acceptBid(punkId, target, type(uint256).max);

        // 4) Patron balance unchanged. No bounty was eaten by the race.
        assertEq(address(patron).balance, patronBefore, "bounty unchanged");
        // Punk now belongs to `other`. Patron is not affected.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), other);
    }

    /// @notice Variant: original owner front-runs themselves and tries to
    ///         finalise their own acceptBid after transferring the Punk.
    ///         Same outcome — Patron's guard fires before anyone can
    ///         exploit the gap.
    function test_AcceptBounty_OwnerSelfFrontRun_RevertsCleanly() public {
        uint16 punkId = _findEligiblePunk(2);
        address owner = address(0xBA772E);
        address other = address(0xC077E2);
        _giveAndOfferToBounty(owner, punkId);

        // Owner transfers Punk to themselves at a different address?
        // No — owner transfers to `other`, then attempts acceptBid.
        vm.prank(owner);
        punksMarket.transferPunk(other, uint256(punkId));

        uint8 target = _pickTarget(punkId);
        uint256 patronBefore = address(patron).balance;
        // Original owner attempts the bounty pull. Patron's guard
        // (listing-state check) reverts before checking msg.sender.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(Patron.PunkNotListedToHub.selector, punkId)
        );
        patron.acceptBid(punkId, target, type(uint256).max);

        assertEq(address(patron).balance, patronBefore, "bounty unchanged");
    }

    // ────────── helpers ──────────

    /// @dev Find a Punk index >= startFrom with at least one uncollected
    ///      bit on its mask.
    function _findEligiblePunk(uint16 startFrom) internal view returns (uint16) {
        for (uint16 i = startFrom; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible punk");
    }

    /// @dev Build a collision pair anchored on A's PROTOCOL-DERIVED target.
    ///      Returns Punk A (whose canonical target is `trait`) and a distinct
    ///      Punk B that ALSO carries `trait` AND carries at least one OTHER
    ///      uncollected, non-pending trait. Once A makes `trait` pending,
    ///      `canonicalTargetOf(B)` is guaranteed to route around it to that
    ///      other trait (so B's acquisition succeeds with a different target —
    ///      never the NoEligibleTarget edge case).
    function _findCanonicalCollisionPair()
        internal view returns (uint16 a, uint16 b, uint8 trait)
    {
        uint256 collected = collection.collectedMask();
        for (uint16 i = 1; i < 2_000; i++) {
            // A must have an eligible (no-pending at setup) canonical target.
            uint8 tA = collection.canonicalTargetOf(i);
            // Find B != A that carries tA AND has another uncollected trait,
            // so B's canonical after tA goes pending is a DIFFERENT trait.
            for (uint16 j = 1; j < 2_000; j++) {
                if (j == i) continue;
                uint256 maskB = punksData.traitMaskOf(j);
                if ((maskB >> tA) & 1 == 0) continue; // B must carry tA
                uint256 otherUncollected = (maskB & ~collected) & ~(uint256(1) << tA);
                if (otherUncollected == 0) continue; // B needs a fallback trait
                return (i, j, tA);
            }
        }
        revert("no canonical collision pair");
    }
}
