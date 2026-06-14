// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {PermanentCollection} from "../src/PermanentCollection.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Fork tests for the sole-carrier target guard (hard invariant #22 /
///         mission finding MF-1). Trait bit 23 ("7 Attributes") has exactly one
///         carrier in the sealed PunksData dataset — Punk #8348 — the unique
///         forced edge in the 111/111 trait→Punk matching. The guard forces an
///         acquisition of #8348 to target bit 23 while bit 23 is uncollected,
///         so the unique carrier can never be wasted on a common trait (which
///         would strand bit 23 forever, capping the Full Set at 110/111).
///
///         The data-grounded tests (`_Dataset_*`, `_FullSetMatching_*`) read the
///         canonical `PunksData` live and re-verify the facts the immutable
///         guard hardcodes — so a dataset substitution or a wrong constant
///         would fail CI before any broadcast.
contract SoleCarrierGuardForkTest is ForkFixtures {
    address internal punkOwner = address(0xB0B);  // arbitrary EOA
    address internal lister = address(0x5E11E2);  // arbitrary allowlisted seller

    uint16 internal constant SOLE_PUNK = 8348;
    uint8 internal constant SOLE_BIT = 23;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        _fundPatronFromAdapter(30 ether);
    }

    // ──────────────── helpers ────────────────

    /// @dev Lowest uncollected, in-mask trait bit on #8348 that is NOT bit 23 —
    ///      i.e. one of its 9 common traits, a target the guard must forbid.
    function _commonTargetFor8348() internal view returns (uint8) {
        uint256 mask = punksData.traitMaskOf(SOLE_PUNK);
        uint256 collected = collection.collectedMask();
        for (uint8 i = 0; i < 111; i++) {
            if (i == SOLE_BIT) continue;
            if ((mask >> i) & 1 == 1 && (collected >> i) & 1 == 0) return i;
        }
        revert("fixture: no common target on #8348");
    }

    /// @dev An eligible Punk that is NOT #8348, with an uncollected trait.
    function _findEligibleNon8348() internal view returns (uint16) {
        for (uint16 i = 0; i < 10_000; i++) {
            if (i == SOLE_PUNK) continue;
            if ((punksData.traitMaskOf(i) & ~collection.collectedMask()) != 0) return i;
        }
        revert("fixture: no eligible non-8348 punk");
    }

    // ──────────────── (a) wrong-target on #8348 reverts ────────────────

    function test_fork_AcceptBid_8348_CommonTarget_Reverts() public {
        uint8 common = _commonTargetFor8348();
        assertFalse(collection.isCollected(SOLE_BIT), "precondition: bit 23 uncollected");

        _giveAndOfferToBounty(punkOwner, SOLE_PUNK);

        vm.expectRevert(
            abi.encodeWithSelector(Patron.SoleCarrierMustTargetTrait.selector, SOLE_PUNK, SOLE_BIT)
        );
        vm.prank(punkOwner);
        patron.acceptBid(SOLE_PUNK, common, type(uint256).max);
    }

    function test_fork_AcceptListing_8348_CommonTarget_Reverts() public {
        uint8 common = _commonTargetFor8348();
        _addAllowedSellerImmediate(lister);
        _giveAndPublicList(lister, SOLE_PUNK, 1 ether);

        vm.expectRevert(
            abi.encodeWithSelector(Patron.SoleCarrierMustTargetTrait.selector, SOLE_PUNK, SOLE_BIT)
        );
        patron.acceptListing(SOLE_PUNK, common);
    }

    /// @dev The authoritative chokepoint: even if the Patron mirror were ever
    ///      bypassed, `recordAcquisition` itself rejects the wrong target.
    function test_fork_RecordAcquisition_Authoritative_8348_CommonReverts() public {
        uint256 mask = punksData.traitMaskOf(SOLE_PUNK);
        uint8 common = _commonTargetFor8348();

        vm.prank(address(patron));
        vm.expectRevert(
            abi.encodeWithSelector(
                PermanentCollection.SoleCarrierMustTargetTrait.selector, SOLE_PUNK, SOLE_BIT
            )
        );
        collection.recordAcquisition(SOLE_PUNK, common, mask, punkOwner, punkOwner, 1 ether);
    }

    // ──────────────── (b) bit-23 target on #8348 succeeds ────────────────

    function test_fork_AcceptBid_8348_TargetBit23_Succeeds() public {
        assertFalse(collection.isCollected(SOLE_BIT));
        _giveAndOfferToBounty(punkOwner, SOLE_PUNK);

        vm.prank(punkOwner);
        patron.acceptBid(SOLE_PUNK, SOLE_BIT, type(uint256).max);

        assertTrue(collection.isRecorded(SOLE_PUNK), "8348 recorded");
        assertEq(collection.pendingTraitCount(SOLE_BIT), 1, "bit 23 pending");
        assertEq(collection.attemptCount(SOLE_BIT), 1, "bit 23 attempted once");
        assertEq(
            uint8(collection.custodyOf(SOLE_PUNK)),
            uint8(IPermanentCollection.Custody.InReturnAuction)
        );
    }

    function test_fork_AcceptListing_8348_TargetBit23_Succeeds() public {
        _addAllowedSellerImmediate(lister);
        _giveAndPublicList(lister, SOLE_PUNK, 1 ether);

        patron.acceptListing(SOLE_PUNK, SOLE_BIT);

        assertTrue(collection.isRecorded(SOLE_PUNK), "8348 recorded");
        assertEq(collection.pendingTraitCount(SOLE_BIT), 1, "bit 23 pending");
    }

    function test_fork_RecordAcquisition_Authoritative_8348_Bit23Succeeds() public {
        uint256 mask = punksData.traitMaskOf(SOLE_PUNK);
        vm.prank(address(patron));
        collection.recordAcquisition(SOLE_PUNK, SOLE_BIT, mask, punkOwner, punkOwner, 1 ether);
        assertTrue(collection.isRecorded(SOLE_PUNK));
    }

    // ──────────────── (c) guard inert: bit 23 collected, or other Punk ──────

    /// @dev Once bit 23 is collected, the guard self-disables: #8348 may then be
    ///      targeted at any of its (still-uncollected) common traits. In reality
    ///      bit 23 is collected only by vaulting #8348 (which then makes it
    ///      terminal), but we set the mask directly so #8348 stays acquirable
    ///      and we can assert the guard is inert.
    function test_fork_GuardInert_WhenBit23Collected_AcceptBidCommon() public {
        _setCollectedMask(uint256(1) << SOLE_BIT);
        assertTrue(collection.isCollected(SOLE_BIT));

        // Once bit 23 is collected the sole-carrier guard is inert, so #8348 can
        // be acquired toward its next canonical trait (the rarest remaining
        // uncollected bit it carries — no longer forced to 23). The target is
        // protocol-derived, so we pass the canonical value (a hardcoded common
        // bit would now hit NotCanonicalTarget, masking the guard-inert claim).
        uint8 target = collection.canonicalTargetOf(SOLE_PUNK);
        assertTrue(target != SOLE_BIT, "bit 23 collected, so canonical is a different trait");
        _giveAndOfferToBounty(punkOwner, SOLE_PUNK);

        vm.prank(punkOwner);
        patron.acceptBid(SOLE_PUNK, target, type(uint256).max); // no revert — guard inert

        assertTrue(collection.isRecorded(SOLE_PUNK));
        assertEq(collection.pendingTraitCount(target), 1);
    }

    /// @dev The guard never fires for any Punk other than #8348.
    function test_fork_GuardInert_ForOtherPunk() public {
        uint16 p = _findEligibleNon8348();
        uint8 t = _pickTarget(p);
        _giveAndOfferToBounty(punkOwner, p);

        vm.prank(punkOwner);
        patron.acceptBid(p, t, type(uint256).max); // succeeds; guard irrelevant for non-8348

        assertTrue(collection.isRecorded(p));
    }

    function test_fork_SoleCarrierConstraintView() public {
        (bool req, uint8 t) = collection.soleCarrierConstraint(SOLE_PUNK);
        assertTrue(req, "constraint active for #8348 pre-collection");
        assertEq(t, SOLE_BIT);

        (bool req2, uint8 t2) = collection.soleCarrierConstraint(1);
        assertFalse(req2, "no constraint for other punks");
        assertEq(t2, 0);

        _setCollectedMask(uint256(1) << SOLE_BIT);
        (bool req3,) = collection.soleCarrierConstraint(SOLE_PUNK);
        assertFalse(req3, "constraint clears once bit 23 collected");
    }

    // ──────────────── (d) dataset facts + reachability preserved ────────────

    /// @notice Re-verify, against the live sealed dataset, the facts the
    ///         immutable guard hardcodes: bit 23 has EXACTLY one carrier and it
    ///         is #8348; and #8348 is NOT the sole carrier of any other trait
    ///         (so forcing #8348→bit 23 strands none of its 9 common traits).
    function test_fork_Dataset_Bit23_UniqueCarrierIs8348() public {
        // The guard's constants must match the deployed contract, and the live
        // dataset must be the sealed one the guard's facts were derived from
        // (datasetHash pins all 111 names + 10,000 masks, so "bit 23 ==
        // '7 Attributes'" and the carrier scan below are against canonical data).
        assertEq(collection.SOLE_CARRIER_PUNK_ID(), SOLE_PUNK);
        assertEq(collection.SOLE_CARRIER_TRAIT_BIT(), SOLE_BIT);
        assertEq(punksData.datasetHash(), collection.EXPECTED_DATASET_HASH(), "sealed dataset");

        vm.pauseGasMetering();
        uint256 mask8348 = punksData.traitMaskOf(SOLE_PUNK);
        uint16[] memory counts = new uint16[](111);
        uint16 carriers23;
        uint16 carrierOf23;
        for (uint16 i = 0; i < 10_000; i++) {
            uint256 m = punksData.traitMaskOf(i);
            for (uint8 b = 0; b < 111; b++) {
                if ((m >> b) & 1 == 1) {
                    counts[b]++;
                    if (b == SOLE_BIT) {
                        carriers23++;
                        carrierOf23 = i;
                    }
                }
            }
        }
        vm.resumeGasMetering();

        assertEq(carriers23, 1, "bit 23 must have exactly ONE carrier");
        assertEq(carrierOf23, SOLE_PUNK, "bit 23's sole carrier must be #8348");
        assertTrue((mask8348 >> SOLE_BIT) & 1 == 1, "#8348 carries bit 23");

        // Every OTHER trait #8348 carries must have an alternate carrier, so the
        // guard's forced edge cannot strand any of #8348's common traits.
        for (uint8 b = 0; b < 111; b++) {
            if (b == SOLE_BIT) continue;
            if ((mask8348 >> b) & 1 == 1) {
                assertGe(counts[b], 2, "a #8348 common trait must have an alternate carrier");
            }
        }
    }

    /// @notice Re-confirm Full Set is still reachable WITH the guard: a system of
    ///         distinct representatives (one distinct carrier Punk per trait)
    ///         saturates 111/111, where the rarest trait (bit 23) is forced onto
    ///         its unique carrier #8348 — exactly the edge the guard enforces.
    ///         Rarest-first greedy suffices because the graph has one forced
    ///         edge and abundant slack everywhere else (proven in
    ///         docs/MISSION_REVIEW_FINDINGS.md).
    function test_fork_FullSetMatchingSaturates_UnderGuard() public {
        vm.pauseGasMetering();

        // Load all masks + per-trait carrier counts.
        uint256[] memory masks = new uint256[](10_000);
        uint16[] memory counts = new uint16[](111);
        for (uint16 i = 0; i < 10_000; i++) {
            uint256 m = punksData.traitMaskOf(i);
            masks[i] = m;
            for (uint8 b = 0; b < 111; b++) {
                if ((m >> b) & 1 == 1) counts[b]++;
            }
        }

        // Rarest-first trait ordering (insertion sort over 111 traits). Bit 23
        // (count 1) sorts first, so it is matched before any contention — the
        // forced edge the guard hardcodes.
        uint8[] memory order = new uint8[](111);
        for (uint8 b = 0; b < 111; b++) {
            order[b] = b;
        }
        for (uint256 a = 1; a < 111; a++) {
            uint8 key = order[a];
            uint16 kc = counts[key];
            uint256 j = a;
            while (j > 0 && counts[order[j - 1]] > kc) {
                order[j] = order[j - 1];
                j--;
            }
            order[j] = key;
        }

        // Greedy SDR: assign each trait (rarest first) a distinct carrier Punk.
        bool[] memory used = new bool[](10_000);
        uint16 assigned;
        for (uint8 k = 0; k < 111; k++) {
            uint8 t = order[k];
            bool matched;
            for (uint16 i = 0; i < 10_000; i++) {
                if (!used[i] && (masks[i] >> t) & 1 == 1) {
                    if (t == SOLE_BIT) {
                        assertEq(i, SOLE_PUNK, "bit 23 forced onto its unique carrier #8348");
                    }
                    used[i] = true;
                    assigned++;
                    matched = true;
                    break;
                }
            }
            assertTrue(matched, "every trait must find a distinct carrier");
        }
        vm.resumeGasMetering();

        assertEq(assigned, 111, "Full Set matching must saturate 111/111 under the guard");
    }
}
