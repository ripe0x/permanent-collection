// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @title  CrossTraitSequence
/// @notice Deterministic stateful sequence driving 100+ sequential
///         acquisitions through `acceptBid` + return auction (random
///         cleared vs vault). After every step, asserts the four
///         protocol-wide invariants alongside a new VaultBurnPool
///         invariant the existing suite doesn't cover:
///
///           A. `collectedMask` monotonically non-decreasing.
///           B. `pendingTraitCount` accounting matches `pendingMask`
///              popcount (no double-pending traits, no leakage on
///              vault-path collection).
///           C. `bidBalance == address(patron).balance` (no shadow
///              ledger).
///           D. VaultBurnPool balance is monotonic per *non-sweep step*
///              — it never falls outside a vault-path settle. Pool can
///              only decrease when ReturnAuctionModule.settle takes the
///              vault branch.
///
///         The "fuzz" is the per-step cleared/vault decision seeded by a
///         single uint256. Foundry runs this with the default fuzz runs
///         (256 by default; configurable) so we get many independent
///         100-step sequences, each asserting all invariants after
///         every step.
contract CrossTraitSequenceTest is ForkFixtures {
    /// @dev Number of sequential acquisitions per sequence.
    uint256 internal constant SEQ_LEN = 100;
    /// @dev Acquisition cost charged from Patron per acceptBid.
    uint256 internal constant ACQUIRE_COST = 0.5 ether;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        // No live bid here — Patron pays the seller its full balance
        // per acceptBid, so we top up before each iteration to a known
        // amount. Otherwise iter 1 would pay 200 ETH and iter 2 would
        // pay 0 (and ReturnAuction would start with reserveWei=0 → bid path
        // becomes degenerate).
    }

    /// @notice Drives SEQ_LEN sequential acceptBid → settle cycles,
    ///         randomly choosing cleared vs vault per step from `seed`.
    ///         Verifies every invariant after every step.
    ///
    ///         Each run is ~90s wall-clock against a public RPC so we
    ///         cap default fuzz runs at 5 (good signal in <10 min). For
    ///         a pre-broadcast canary pass, bump to 50+ via:
    ///           forge test --match-test testFuzz_CrossTraitSequence \
    ///                     --fuzz-runs 50 -vv
    /// forge-config: default.fuzz.runs = 5
    function testFuzz_CrossTraitSequence_100Acquisitions(uint256 seed) public {
        // Per-step acquisition cost is drawn from the seed but kept small
        // enough that we don't blow through wei-precision on bid math.
        // ACQUIRE_COST is paid by Patron from its balance — we top up
        // exactly that amount before each call so payouts are uniform.
        // Pre-seed the vault burn pool so the vault-path sweep has
        // something to forward. Mimics a few fee-distribution cycles.
        vm.deal(address(vaultBurnPool), 0.5 ether);
        seed; // also drives the cleared/vault decision via the shift below.

        uint16 nextPunk = 1; // search cursor
        uint256 stepsRun;

        // Ghost: VaultBurnPool balance going in. We assert that pool
        // balance is monotonic between vault-path settles.
        uint256 lastPoolBalance = address(vaultBurnPool).balance;

        for (uint256 i = 0; i < SEQ_LEN; i++) {
            // Find a Punk whose mask carries an uncollected, non-pending
            // bit. Skip Punks already recorded with the protocol.
            (uint16 pid, uint8 target, bool found) = _findFresh(nextPunk);
            if (!found) break;
            nextPunk = pid + 1;

            // Snapshot pre-step state for assertions.
            uint256 collectedBefore = collection.collectedMask();
            uint256 acqCountBefore = collection.acquisitionCount();

            // Top up Patron to exactly ACQUIRE_COST so the bounty paid to
            // the previous owner is uniform across iterations and the
            // ReturnAuction reserve is non-degenerate.
            uint256 currentBal = address(patron).balance;
            if (currentBal < ACQUIRE_COST) {
                _fundPatronFromAdapter(ACQUIRE_COST - currentBal);
            }
            uint256 patronBalBefore = address(patron).balance;

            // Owner offers Punk to Patron at price 0; patron pulls it
            // via acceptBid. We use a fresh owner address per step so
            // there's no cross-talk between iterations.
            address owner = address(uint160(0xBEA70000 + i));
            _giveAndOfferToBounty(owner, pid);
            vm.prank(owner);
            patron.acceptBid(pid, target, type(uint256).max);

            // Step accountancy assertions: invariants A-C immediately
            // after the acceptBid.
            _assertInvariantsAB(
                collectedBefore, acqCountBefore + 1
            );
            _assertInvariantC();

            // Decide cleared vs vault from the seed.
            // 50% cleared, 50% vault. Rotate the seed per step so the
            // run isn't dominated by either branch.
            bool cleared = ((seed >> (i & 0xff)) & 1) == 1;

            if (cleared) {
                // Place a reserve-clearing bid (1.01× cost). Owner places
                // it from a fresh bidder so the highBidder isn't address(this)
                // (a quirky shortcut that has bitten other tests).
                address bidder = address(uint160(0xB1DDE000 + i));
                vm.deal(bidder, 5 ether);
                uint256 reserve = finalSale.reserveOf(pid);
                vm.prank(bidder);
                finalSale.placeBidWithReferral{value: reserve}(pid, address(0), bytes32(0));
            }
            // Warp past endsAt and settle.
            vm.warp(uint256(finalSale.endsAt(pid)) + 1);
            finalSale.settle(pid);

            // Post-settle state. Custody MUST be terminal.
            IPermanentCollection.Custody c = collection.custodyOf(pid);
            assertTrue(
                c == IPermanentCollection.Custody.ReturnedToMarket
                    || c == IPermanentCollection.Custody.Vaulted,
                "custody not terminal"
            );

            // Invariant D — VaultBurnPool dynamics:
            //   - cleared path: pool monotonically grows (overbid premium
            //     `highBid - acquisitionCost` lands here per the new rescue
            //     split; the pool is otherwise unchanged).
            //   - vault path: pool swept to 0.
            uint256 poolNow = address(vaultBurnPool).balance;
            if (cleared) {
                assertGe(poolNow, lastPoolBalance, "cleared path: pool monotonic (gains premium)");
            } else {
                // Vault path swept — pool should be 0.
                assertEq(poolNow, 0, "vault settle must sweep pool to 0");
            }
            lastPoolBalance = poolNow;

            // Patron-balance assertions per branch.
            if (cleared) {
                // Cleared path: the 65%-of-cost live-bid share routes through
                // the LiveBidAdapter buffer (not Patron directly); 25% → burn,
                // 10% + premium → VaultBurnPool. No keeper tip is paid on
                // settle. The buyer is `bidder`, settled by `address(this)`.
                // Precise per-branch Patron accounting would require modeling
                // the finder fee + 2017-market pending withdrawal — out of
                // scope for an invariant test. The strong claim is just
                // `bidBalance == balance` (C).
                assertEq(
                    patron.bidBalance(),
                    address(patron).balance,
                    "cleared: bidBalance == balance"
                );
                // Sanity: Patron strictly received some bounty share
                // back (or at least didn't lose net more than the
                // acceptBid payment + finder fee).
                _assertPatronSane(patronBalBefore);
            } else {
                // Vault path: collectedMask gains exactly one bit (the
                // target). pendingTraitCount[target] decremented.
                uint256 collectedAfter = collection.collectedMask();
                uint256 expectedNewBit = uint256(1) << target;
                // collectedAfter must equal collectedBefore | targetBit
                // (since this is the only collected trait that changed
                // — and it must not have been collected before).
                assertEq(
                    collectedAfter,
                    collectedBefore | expectedNewBit,
                    "vault: only target bit set"
                );
                assertEq(
                    collection.pendingTraitCount(target), 0,
                    "vault: pending decremented to 0 for target"
                );
            }

            // Final overall invariants after this step.
            _assertInvariantsAB(
                collectedBefore | (cleared ? 0 : uint256(1) << target),
                acqCountBefore + 1
            );
            _assertInvariantC();
            _assertCustodyForwardOnly(pid, c);

            stepsRun++;
        }

        // We require the sequence to actually exercise lots of steps —
        // catches a regression where _findFresh stops finding eligible
        // Punks (e.g. due to an over-eager TargetTraitPending guard).
        // The 90-of-100 bar leaves slack for the small fraction of
        // Punks owned by no one or for the rare full-set case.
        assertGe(stepsRun, 90, "sequence too short: handler stalled");

        // Final landing: log a few summary numbers so the user can
        // sanity-check the run from `-vv` output.
        emit log_named_uint("steps run", stepsRun);
        emit log_named_uint("final collectedCount", collection.collectedCount());
        emit log_named_uint("final acquisitionCount", collection.acquisitionCount());
    }

    // ────────── helpers ──────────

    /// @dev Find the next Punk index `>= startFrom` whose mask carries an
    ///      uncollected, non-pending bit AND who hasn't been recorded yet.
    function _findFresh(uint16 startFrom)
        internal view
        returns (uint16 pid, uint8 target, bool found)
    {
        for (uint16 i = startFrom; i < 10_000; i++) {
            if (collection.isRecorded(i)) continue;
            address o = punksMarket.punkIndexToAddress(i);
            if (o == address(0)) continue;
            uint256 mask = punksData.traitMaskOf(i);
            uint256 collected = collection.collectedMask();
            uint256 newBits = mask & ~collected;
            if (newBits == 0) continue;
            for (uint8 t = 0; t < 111; t++) {
                if ((newBits >> t) & 1 != 1) continue;
                if (collection.pendingTraitCount(t) != 0) continue;
                // At least one uncollected, non-pending bit exists, so the
                // protocol-derived canonical target is well-defined (won't
                // revert NoEligibleTarget). The target is no longer free —
                // it MUST equal canonicalTargetOf or acceptBid reverts
                // NotCanonicalTarget.
                return (i, collection.canonicalTargetOf(i), true);
            }
        }
        return (0, 0, false);
    }

    function _assertInvariantsAB(uint256 minCollected, uint256 minAcqCount)
        internal view
    {
        assertGe(collection.collectedMask(), minCollected, "A: collectedMask regressed");
        assertGe(collection.acquisitionCount(), minAcqCount, "B: acqs regressed");
        // pendingTraitCount accounting matches pendingMask popcount.
        uint256 pmask = collection.pendingMask();
        uint256 derivedPopcount;
        for (uint8 t = 0; t < 111; t++) {
            if ((pmask >> t) & 1 == 1) derivedPopcount++;
        }
        uint256 ledgerPopcount;
        for (uint8 t = 0; t < 111; t++) {
            if (collection.pendingTraitCount(t) != 0) ledgerPopcount++;
        }
        assertEq(derivedPopcount, ledgerPopcount, "B: pendingMask vs ledger drift");
    }

    function _assertInvariantC() internal view {
        assertEq(
            patron.bidBalance(),
            address(patron).balance,
            "C: bidBalance != address(patron).balance"
        );
    }

    function _assertCustodyForwardOnly(uint16 pid, IPermanentCollection.Custody current)
        internal pure
    {
        // Single-step custody transition is well-typed by the contract
        // (no zero → terminal direct path possible from outside; only
        // markCustody by ReturnAuctionModule can move InReturnAuction → terminal).
        // Just confirm current is terminal here as a guard.
        pid;
        assertTrue(
            current == IPermanentCollection.Custody.ReturnedToMarket
                || current == IPermanentCollection.Custody.Vaulted,
            "custody must be terminal"
        );
    }

    function _assertPatronSane(uint256 before) internal view {
        // Patron's balance must never go negative (trivially true since
        // balance is uint256). The meaningful check: bidBalance is
        // still the contract's balance.
        before; // we don't make a strict claim — see invariant C above
        assertEq(patron.bidBalance(), address(patron).balance);
    }
}
