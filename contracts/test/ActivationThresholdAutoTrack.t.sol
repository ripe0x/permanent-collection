// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LiveBidAdapter} from "../src/LiveBidAdapter.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Auto-tracking of `LiveBidAdapter.activationThreshold` to the latest
///         `acceptBid` clearing price, plus the knowingly-accepted M-1 grief.
///
///         The `autoAdapter` / `manualAdapter` are DEDICATED instances built on
///         top of `_deployProtocol` to isolate the sync logic. They sweep with
///         an EMPTY buffer (sync runs first, then the empty-buffer early return),
///         so they never forward to Patron — only the fixture's WIRED
///         `liveBidAdapter` may do that (Patron's `receive()` is adapter-only).
///         The wired adapter is exercised in the M-1 test, which needs a real
///         forward. Production wiring parity (Deploy.s.sol / ForkFixtures passing
///         `address(collection)`) is covered by the broader fork suites.
contract ActivationThresholdAutoTrackTest is ForkFixtures {
    LiveBidAdapter internal autoAdapter;   // PC wired → auto-track ON
    LiveBidAdapter internal manualAdapter; // PC = 0 → auto-track OFF

    address internal punkOwner = address(0xA11CE);
    address internal listingSeller = address(0x5E11E2);
    address internal finder = address(0xF1ABE2);

    uint16 internal _scanCursor; // advances as tests consume Punks

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        // `_deployProtocol` sets `adminContract = new ProtocolAdmin(address(this))`,
        // so this contract is the admin EOA and can call `setActivationThreshold`.

        autoAdapter = new LiveBidAdapter(
            payable(address(patron)),
            address(adminContract),
            ADAPTER_MAX_SWEEP_WEI,
            ADAPTER_MIN_BLOCKS,
            ADAPTER_ACTIVATION_THRESHOLD,
            address(collection), // auto-track ON
            address(finalSale), // returnAuctionModule (poolReplenish gate; unused here)
            address(0)
        );
        manualAdapter = new LiveBidAdapter(
            payable(address(patron)),
            address(adminContract),
            ADAPTER_MAX_SWEEP_WEI,
            ADAPTER_MIN_BLOCKS,
            ADAPTER_ACTIVATION_THRESHOLD,
            address(0), // auto-track disabled
            address(finalSale), // returnAuctionModule (poolReplenish gate; unused here)
            address(0)
        );
    }

    // ──────────────── helpers ────────────────

    /// @dev Find the next un-recorded Punk whose protocol-derived canonical
    ///      target is eligible (`canonicalTargetOf` reverts `NoEligibleTarget`
    ///      when the Punk carries no uncollected, non-pending trait, so chained
    ///      acquisitions in one test naturally pick distinct targets and never
    ///      hit `TargetTraitAlreadyPending`).
    function _nextEligible() internal returns (uint16 punkId, uint8 target) {
        for (uint16 i = _scanCursor; i < 10_000; i++) {
            if (collection.isRecorded(i)) continue;
            try collection.canonicalTargetOf(i) returns (uint8 t) {
                _scanCursor = i + 1;
                return (i, t);
            } catch {
                continue;
            }
        }
        revert("no eligible punk");
    }

    /// @dev Accept the live bid for a fresh Punk at exactly `priceWei`. Funds
    ///      the live bid to `priceWei` THROUGH the wired adapter (the only path
    ///      that sets `accountedLiveBidWei` under inflow consolidation), lists
    ///      the Punk to the hub at that price, and finalizes (permissionless).
    ///      Records an acquisition with `acquirer == originalSeller == punkOwner`
    ///      (the acceptBid shape the sync keys on).
    function _acceptBidAt(uint256 priceWei) internal returns (uint16 punkId) {
        uint8 target;
        (punkId, target) = _nextEligible();
        _fundPatronFromAdapter(priceWei);
        _giveAndOfferToBounty(punkOwner, punkId); // lists at patron.bidBalance() == priceWei
        patron.acceptBid(punkId, target, type(uint256).max);
    }

    // ──────────────── tests ────────────────

    /// @dev An acceptBid clearing price, less the −25% band, becomes the
    ///      threshold on the next sweep (20 ETH × 0.75 = 15 ETH).
    function test_acceptBid_setsThreshold() public {
        _acceptBidAt(20 ether);
        autoAdapter.sweep();
        assertEq(autoAdapter.activationThreshold(), 15 ether, "threshold tracks acceptBid price x0.75");
        assertEq(autoAdapter.lastSyncedAcquisitionCount(), 1, "high-water mark advanced");
    }

    /// @dev A clearing price above the bound clamps to ACTIVATION_THRESHOLD_HI
    ///      even after the −25% band (150 × 0.75 = 112.5 ETH > 100 ETH cap).
    function test_acceptBid_clampsToHi() public {
        _acceptBidAt(150 ether);
        autoAdapter.sweep();
        assertEq(
            autoAdapter.activationThreshold(),
            autoAdapter.ACTIVATION_THRESHOLD_HI(),
            "threshold clamps to 100 ETH"
        );
    }

    /// @dev acceptListing (acquirer = finder, distinct from the listing seller)
    ///      is excluded: a cheap aligned listing must NOT drag the threshold down.
    function test_acceptListing_doesNotLowerThreshold() public {
        // 1) Establish a 15 ETH threshold from a 20 ETH acceptBid (×0.75 band).
        _acceptBidAt(20 ether);
        autoAdapter.sweep();
        assertEq(autoAdapter.activationThreshold(), 15 ether, "seed acceptBid threshold x0.75");

        // 2) A low (5 ETH) allowlisted public listing, accepted by a finder.
        (uint16 punkId, uint8 target) = _nextEligible();
        _addAllowedSellerImmediate(listingSeller);
        _giveAndPublicList(listingSeller, punkId, 5 ether);
        _fundPatronFromAdapter(6 ether); // cover minValue + finder fee
        vm.prank(finder);
        patron.acceptListing(punkId, target);

        // 3) Sweep observes the new (acceptListing) acquisition but skips it.
        autoAdapter.sweep();
        assertEq(autoAdapter.activationThreshold(), 15 ether, "listing did not lower threshold");
        assertEq(autoAdapter.lastSyncedAcquisitionCount(), 2, "mark advanced past the listing row");
    }

    /// @dev A manual override holds until the next acceptBid re-syncs
    ///      (last-writer-wins on the single slot).
    function test_manualOverride_holdsUntilNextAcceptBid() public {
        _acceptBidAt(20 ether);
        autoAdapter.sweep();
        assertEq(autoAdapter.activationThreshold(), 15 ether, "auto-tracked to 20 x0.75");

        // Manual override; no new acquisition, so a sweep must not undo it.
        // The manual setter writes the raw value (no band).
        autoAdapter.setActivationThreshold(50 ether);
        autoAdapter.sweep();
        assertEq(autoAdapter.activationThreshold(), 50 ether, "override survives a no-acquisition sweep");

        // Next acceptBid re-syncs and replaces the override (30 × 0.75 = 22.5).
        _acceptBidAt(30 ether);
        autoAdapter.sweep();
        assertEq(autoAdapter.activationThreshold(), 22.5 ether, "auto-track resumes on next acceptBid x0.75");
    }

    /// @dev `permanentCollection == address(0)` disables auto-tracking entirely;
    ///      the manual setter still works.
    function test_disabledMode_neverAutoSyncs() public {
        _acceptBidAt(20 ether);
        manualAdapter.sweep();
        assertEq(
            manualAdapter.activationThreshold(),
            ADAPTER_ACTIVATION_THRESHOLD,
            "disabled adapter keeps its seed"
        );
        assertEq(manualAdapter.lastSyncedAcquisitionCount(), 0, "no sync recorded");

        manualAdapter.setActivationThreshold(10 ether);
        assertEq(manualAdapter.activationThreshold(), 10 ether, "manual setter still works when disabled");
    }

    /// @dev ACCEPTED GRIEF (audit M-1). A 1-wei acceptBid drives the synced
    ///      value to `(1 * 75) / 100 == 0`. A 0 threshold pins the adapter into
    ///      throttled mode permanently (`patron.balance >= 0` is always true).
    ///      This test DOCUMENTS that the worst-case outcome is exactly the
    ///      rate-cap-always behaviour — the live bid still grows at the drip and
    ///      the griefer extracts no protocol value (they paid gas and gave up a
    ///      Punk into a 72h return auction for 1 wei). It is not a fix.
    function test_M1_GrieferCanCraterThreshold_Accepted() public {
        // 1) A 1-wei acceptBid. The recorded clearing price is 1.
        _acceptBidAt(1);

        // 2) Sync via the wired adapter (empty buffer → sync-only path). The
        //    −25% band floors to 0.
        liveBidAdapter.sweep();
        assertEq(liveBidAdapter.activationThreshold(), 0, "1-wei acceptBid craters the threshold to 0");

        // 3) Threshold 0 ⇒ every forward is throttled. Prove a 100 ETH lump
        //    cannot fast-spike the bid: one sweep forwards at most maxSweepWei,
        //    the rest stays buffered — the cap-always worst case. The buffer can
        //    only ever drain toward Patron, so nothing is extractable.
        vm.deal(address(liveBidAdapter), 100 ether);
        vm.roll(liveBidAdapter.nextSweepBlock()); // clear any cooldown window
        uint256 fwd = liveBidAdapter.sweep();
        assertLe(fwd, liveBidAdapter.maxSweepWei(), "threshold=0 -> throttled: lump cannot fast-spike the bid");
        assertGt(liveBidAdapter.bufferedEth(), 90 ether, "the lump stays buffered and drips, not forwarded at once");
    }
}
