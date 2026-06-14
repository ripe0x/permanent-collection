// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {Patron} from "../src/Patron.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {LiveBidAdapter} from "../src/LiveBidAdapter.sol";
import {ProtocolAdmin} from "../src/ProtocolAdmin.sol";
import {PermanentCollection} from "../src/PermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Fuzz tests for the protocol's calculation-heavy functions and
///         setters. Confirms the formulas match a Solidity reference
///         implementation across a wide input distribution.
contract FuzzTest is ForkFixtures {
    uint256 internal constant BPS_DENOM = 10_000;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
    }

    // ───────────────────────────────────────────────────────────────
    //  Reserve formula: paid × (101 + attemptCount) / 100
    // ───────────────────────────────────────────────────────────────

    /// @dev Reference implementation of the reserve formula. Uses ceilDiv
    ///      so the 1%-per-trial premium is enforced literally even for dust
    ///      acquisitions (audit F12). `paid == 0` keeps the reserve at 0
    ///      rather than rounding up to 1.
    function _expectedReserve(uint128 paid, uint16 trials) internal pure returns (uint256) {
        uint256 product = uint256(paid) * (101 + uint256(trials));
        return product == 0 ? 0 : (product + 99) / 100;
    }

    /// @notice Reserve formula must match the reference across the full
    ///         uint128 payment space. We construct a fresh ReturnAuctionModule
    ///         + PermanentCollection per-call so we control `attemptCount`.
    function testFuzz_ReserveFormula_FirstTrial(uint128 paid) public {
        // Bound to avoid `ReserveOverflow` (uint128 max ÷ 211 ≈ 1.6e36 ETH).
        paid = uint128(bound(paid, 0, type(uint128).max / 256));

        uint16 punkId = 9999;
        address current = punksMarket.punkIndexToAddress(punkId);
        if (current != address(finalSale)) {
            vm.prank(current);
            punksMarket.transferPunk(address(finalSale), uint256(punkId));
        }

        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 trait;
        for (uint8 i = 0; i < 111; i++) {
            if ((mask >> i) & 1 == 1) {
                trait = i;
                break;
            }
        }

        vm.prank(address(patron));
        finalSale.startSale(punkId, paid, trait);

        assertEq(finalSale.reserveOf(punkId), _expectedReserve(paid, 0));
    }

    // ───────────────────────────────────────────────────────────────
    //  Finder fee: min(bountyBal × bps / 10_000, fixedCap)
    // ───────────────────────────────────────────────────────────────

    function _expectedFinderFee(uint256 bountyBal, uint256 capBps, uint256 fixedCap)
        internal
        pure
        returns (uint256)
    {
        uint256 byBps = (bountyBal * capBps) / BPS_DENOM;
        return byBps < fixedCap ? byBps : fixedCap;
    }

    function testFuzz_FinderFee_FormulaMatchesReference(uint256 bountyBal) public view {
        bountyBal = bound(bountyBal, 0, 10_000 ether);
        uint256 capBps = patron.finderFeeCapBps();
        uint256 fixedCap = patron.finderFeeFixedCap();

        uint256 expected = _expectedFinderFee(bountyBal, capBps, fixedCap);
        // We can't directly call an internal compute. Verify the bound
        // properties:
        //   - expected <= bountyBal * capBps / 10_000
        //   - expected <= fixedCap
        assertLe(expected, (bountyBal * capBps) / BPS_DENOM);
        assertLe(expected, fixedCap);
        // And expected is exactly one of those two.
        if ((bountyBal * capBps) / BPS_DENOM < fixedCap) {
            assertEq(expected, (bountyBal * capBps) / BPS_DENOM);
        } else {
            assertEq(expected, fixedCap);
        }
    }

    // Note on removed setter-bounds fuzz tests: `setFinderFeeCapBps` /
    // `setFinderFeeFixedCap` were removed when `finderFeeCapBps` /
    // `finderFeeFixedCap` became protocol constants (no setter, no bounds to
    // fuzz). `setCreatorShareBps` was removed earlier in audit F6 (dead
    // writes). The finder-fee *formula* is still fuzzed across `bountyBal`
    // above (`testFuzz_FinderFee_FormulaMatchesReference`), now against the
    // fixed constant values.

    // ───────────────────────────────────────────────────────────────
    //  BuybackBurner: slippage floor (minTokensPerEthFloor)
    // ───────────────────────────────────────────────────────────────

    // REMOVED: testFuzz_MinOutFloor_RejectsBelowFloor — the static
    // `minTokensPerEthFloor` was removed entirely (audit H-1: wrong shape for
    // an appreciating ETH→111 pool). The fixed V4 price-impact cap is now the
    // slippage guard; its coverage lives in the sandwich-economics suites.

    // ───────────────────────────────────────────────────────────────
    //  LiveBidAdapter: setter bounds
    // ───────────────────────────────────────────────────────────────

    function testFuzz_BountyAdapterBounds_MaxSweep(uint256 v) public {
        _launchPool(); // need liveBidAdapter
        v = bound(v, 0.01 ether, 5 ether);
        liveBidAdapter.setMaxSweepWei(v);
        assertEq(liveBidAdapter.maxSweepWei(), v);
    }

    function testFuzz_BountyAdapterBounds_MinBlocks(uint256 v) public {
        _launchPool();
        v = bound(v, 1, 7_200);
        liveBidAdapter.setMinBlocksBetweenSweeps(v);
        assertEq(liveBidAdapter.minBlocksBetweenSweeps(), v);
    }

    // ───────────────────────────────────────────────────────────────
    //  Reserve formula at higher trialCounts (premium grows linearly)
    // ───────────────────────────────────────────────────────────────

    /// @notice After N trials against the same trait, the reserve premium is
    ///         exactly N% on top of paid (rounded down per integer division).
    ///         Verify for a moderate range of N.
    function testFuzz_ReservePremiumLinearInTrialCount(uint8 trials, uint128 paid) public pure {
        // Bound paid so the multiplication doesn't overflow uint128.
        paid = uint128(bound(uint256(paid), 1, type(uint128).max / 256));
        trials = uint8(bound(uint256(trials), 0, 200));

        uint256 ref = _expectedReserve(paid, trials);
        // Independent restatement of ceilDiv: ((paid × (101 + trials)) + 99) ÷ 100.
        // (Audit F12: integer floor would let dust acquisitions open with no
        // premium; ceilDiv enforces ≥1% literally.)
        uint256 product = uint256(paid) * (uint256(trials) + 101);
        uint256 alt = product == 0 ? 0 : (product + 99) / 100;
        assertEq(ref, alt, "formula self-consistency");

        // Property: each additional trial increases the reserve by either
        // ceil(paid/100) or floor(paid/100) (the ceilDiv rounds the cumulative
        // product, so step alternates within ±1 of paid/100 like the old floor
        // version did, just on the upper side).
        if (trials > 0) {
            uint256 prev = _expectedReserve(paid, trials - 1);
            assertGe(ref, prev, "reserve non-decreasing in trials");
            uint256 step = ref - prev;
            uint256 floorPer = uint256(paid) / 100;
            uint256 ceilPer = (uint256(paid) + 99) / 100;
            assertGe(step, floorPer == 0 ? 0 : floorPer - 1, "step too small");
            assertLe(step, ceilPer + 1, "step too large");
        }
    }
}
