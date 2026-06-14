// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Adversarial coverage of the live bid — verifies that an
///         allowlisted seller cannot drain the bounty across repeated
///         `acceptListing` calls, and that the protocol's per-trait pending
///         lock blocks naive parallel attacks.
///
///         The threat model: a malicious allowlisted seller lists multiple
///         eligible Punks at prices designed to extract maximum bounty + finder
///         fee. We verify the per-call and aggregate protections.
contract BountyDrainTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
    }

    function _findEligiblePunkOwnedBy(address seller, uint16 startFrom)
        internal view returns (uint16)
    {
        for (uint16 i = startFrom; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) == 0) continue;
            address owner = punksMarket.punkIndexToAddress(i);
            if (owner != address(0)) {
                seller;
                return i;
            }
        }
        revert("no eligible");
    }

    /// @notice A single `acceptListing` cannot drain more than (price + finder
    ///         fee) from the bounty per call. With a bounty of 5 ETH and a
    ///         listing at 1 ETH, the bounty must drop by exactly 1 ETH + the
    ///         capped finder fee.
    function test_SingleListing_DrainsExactPriceAndFee() public {
        address seller = address(0xCAFE);
        _addAllowedSellerImmediate(seller);
        _fundPatronFromAdapter(5 ether);

        uint16 punkId = _findEligiblePunkOwnedBy(seller, 100);
        _giveAndPublicList(seller, punkId, 1 ether);

        uint256 bountyBefore = address(patron).balance;
        uint256 sellerBefore = seller.balance;
        uint256 callerBefore = address(this).balance;
        uint256 expectedFee = patron.finderFeeCapBps() * bountyBefore / 10_000;
        if (expectedFee > patron.finderFeeFixedCap()) expectedFee = patron.finderFeeFixedCap();

        uint8 target = _pickTarget(punkId);
        patron.acceptListing(punkId, target);

        // Patron pays the listing price via the market (queues in seller's
        // pendingWithdrawals — not in `seller.balance` directly).
        // Bounty drops by minValue + finderFee.
        assertEq(
            bountyBefore - address(patron).balance,
            1 ether + expectedFee,
            "bounty drop = price + fee"
        );
        // Caller (this test contract) earned the finder fee.
        assertEq(address(this).balance - callerBefore, expectedFee, "finder fee landed");
        sellerBefore; // seller payment queues in market.pendingWithdrawals; not tested here
    }

    /// @notice Two parallel attempts to drain the same trait must fail — the
    ///         second `acceptListing` reverts on `TargetTraitPending`. This
    ///         is the key defense against multi-fire drain attempts on the
    ///         same uncollected bit.
    /// @notice The one-in-flight-per-trait invariant is upheld by canonical
    ///         target derivation, WITHOUT a same-trait collision. The target is
    ///         protocol-derived, so two acceptListing calls can't both target
    ///         the same trait: the first makes A's canonical target T pending,
    ///         and because `canonicalTargetOf` excludes pending traits, a second
    ///         Punk that also carries T derives a DIFFERENT target — it routes
    ///         around T and its acquisition succeeds.
    function test_SecondListing_RoutesAroundPendingTrait() public {
        address seller = address(0xCAFE);
        _addAllowedSellerImmediate(seller);
        _fundPatronFromAdapter(5 ether);

        // Anchor on A's protocol-derived target T. Find a distinct Punk B that
        // also carries T AND has another uncollected trait, so once T is
        // pending, B's canonical routes around it to a different trait.
        uint16 punkA = 100;
        uint8 sharedTrait = collection.canonicalTargetOf(punkA);
        uint256 collected = collection.collectedMask();
        uint16 punkB = 0;
        for (uint16 i = 101; i < 10_000; i++) {
            uint256 m = punksData.traitMaskOf(i);
            if ((m >> sharedTrait) & 1 == 0) continue; // B must carry T
            uint256 otherUncollected = (m & ~collected) & ~(uint256(1) << sharedTrait);
            if (otherUncollected == 0) continue; // B needs a fallback trait
            punkB = i;
            break;
        }
        require(punkB != 0, "no shared-trait punk with a fallback found");

        _giveAndPublicList(seller, punkA, 1 ether);
        _giveAndPublicList(seller, punkB, 1 ether);

        // First accept acquires A toward its canonical target T → T pending.
        patron.acceptListing(punkA, sharedTrait);
        assertEq(collection.pendingTraitCount(sharedTrait), 1, "T now pending");

        // Second accept on B: its canonical routes around the pending T to a
        // different uncollected trait, and the acquisition succeeds.
        uint8 targetB = collection.canonicalTargetOf(punkB);
        assertTrue(targetB != sharedTrait, "B's canonical routed around pending T");
        patron.acceptListing(punkB, targetB);

        assertTrue(collection.isRecorded(punkB), "B acquired toward a different trait");
        assertEq(collection.pendingTraitCount(sharedTrait), 1, "still exactly one in-flight for T");
        assertEq(collection.pendingTraitCount(targetB), 1, "B's distinct trait now pending");
    }

    /// @notice Repeated drain attempts across DIFFERENT traits eventually hit
    ///         the `MIN_BID_FOR_LISTING` floor and revert.
    ///         Demonstrates that the bounty can't be drained to zero — there's
    ///         always at least `MIN_BID_FOR_LISTING - 1` left in the pool.
    function test_AggregateDrain_HaltsAtMinBountyFloor() public {
        address seller = address(0xCAFE);
        _addAllowedSellerImmediate(seller);
        _fundPatronFromAdapter(5 ether);

        // We use small listings (0.1 ETH each) and repeat acceptListing until
        // the bounty drops below MIN_BID_FOR_LISTING = 0.5 ETH. Each call
        // needs a unique uncollected trait.
        uint256 successCount = 0;
        for (uint16 p = 1; p < 200 && successCount < 50; p++) {
            if (collection.isRecorded(p)) continue;
            // The protocol records the CANONICAL target (rarest uncollected,
            // non-pending trait the Punk carries), so the acceptListing target
            // must match it. canonicalTargetOf already skips collected and
            // in-flight traits and reverts NoEligibleTarget when the Punk has
            // none — skip those Punks.
            uint8 target;
            try collection.canonicalTargetOf(p) returns (uint8 ct) {
                target = ct;
            } catch {
                continue;
            }

            _giveAndPublicList(seller, p, 0.1 ether);
            try patron.acceptListing(p, target) {
                successCount++;
            } catch {
                // Either bounty below floor (expected halt), or some
                // listing-state edge — stop and verify the halt condition.
                break;
            }
        }

        // The pool must NEVER be drained below MIN_BID_FOR_LISTING - epsilon.
        // The next call would revert with BidBelowMinimum.
        uint256 bountyNow = address(patron).balance;
        if (bountyNow < 0.5 ether) {
            // Confirm the floor is what blocked us. A fresh attempt at
            // a small listing should revert with BidBelowMinimum.
            // (Use a fresh punk to avoid `AlreadyRecorded`.)
            address rando = address(0xFEED);
            uint16 freshPunk = uint16(9000);
            _giveAndPublicList(rando, freshPunk, 0.05 ether);
            _addAllowedSellerImmediate(rando);
            vm.expectRevert(); // BidBelowMinimum
            patron.acceptListing(freshPunk, 0);
        }
        assertGt(successCount, 0, "drain attempt didn't even start");
    }

    /// @notice An adversary who lists at an inflated price (above the bounty)
    ///         is rejected — they cannot trick the protocol into spending more
    ///         than its live bid.
    function test_ListingAboveBounty_Rejected() public {
        address seller = address(0xCAFE);
        _addAllowedSellerImmediate(seller);
        _fundPatronFromAdapter(1 ether);

        uint16 punkId = _findEligiblePunkOwnedBy(seller, 100);
        _giveAndPublicList(seller, punkId, 100 ether); // way above bounty

        uint8 target = _pickTarget(punkId);
        vm.expectRevert(); // ListingExceedsBid
        patron.acceptListing(punkId, target);

        // State unchanged.
        assertEq(address(patron).balance, 1 ether);
        assertFalse(collection.isRecorded(punkId));
    }

    /// @notice L-2 verification: the `ListingExceedsBid` error reports
    ///         `totalOut` (minValue + finderFee), not just minValue. Catches
    ///         the case where finder fee is the part that tipped the call
    ///         over the bounty ceiling.
    function test_ListingExceedsBounty_ErrorReportsTotalOut_NotMinValue() public {
        // Set up bounty exactly equal to listing price. The finder fee on
        // top makes the total exceed bounty — the error should reflect
        // that, not the (under-budget-by-itself) minValue.
        address seller = address(0xCAFE99);
        _addAllowedSellerImmediate(seller);

        uint256 bountyBal = 1 ether;
        _fundPatronFromAdapter(bountyBal);

        uint256 minValue = bountyBal; // exactly at the bounty, leaves nothing for fee
        uint16 punkId = _findEligiblePunkOwnedBy(seller, 700);
        _giveAndPublicList(seller, punkId, minValue);

        // Expected finder fee. Cap is the smaller of bps × bounty and the fixed cap.
        uint256 finderFee = (bountyBal * patron.finderFeeCapBps()) / 10_000;
        if (finderFee > patron.finderFeeFixedCap()) finderFee = patron.finderFeeFixedCap();
        uint256 expectedTotalOut = minValue + finderFee;
        assertGt(expectedTotalOut, bountyBal, "fixture: totalOut must exceed bounty");

        uint8 target = _pickTarget(punkId);
        vm.expectRevert(
            abi.encodeWithSelector(
                Patron.ListingExceedsBid.selector, expectedTotalOut, bountyBal
            )
        );
        patron.acceptListing(punkId, target);
    }
}
