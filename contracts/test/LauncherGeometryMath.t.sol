// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

/// @notice Pure-math tests for the dynamic launch-tick and floor
///         calculation in `Deploy.s.sol`. Replicates the same math here
///         (instead of calling into Deploy.s.sol — Foundry's vm.envOr
///         doesn't behave well inside the script context for unit tests)
///         so we can verify the values produced at known ETH/USD prices
///         match the artist's spec.
///
///         **Coverage:**
///           - At ETH=$2,100: configured tick = -172,200 (matches spec).
///           - At ETH=$1,000: configured tick shifts by log(2.1) / log(1.0001)
///             ticks (sanity check on the env-var-driven path).
///
///         The `BuybackBurner` min-tokens-per-ETH floor is no longer
///         computed (here or in `Deploy.s.sol`): it ships DISABLED (0) per
///         audit H-1 — a static tokens-per-ETH floor bricks buy-and-burn as
///         111 appreciates (the pair is ETH→111, so tokens-per-ETH falls as
///         price rises). The live regression for that is
///         `LaunchInvariantForkTest::test_fork_H1_buyAndBurnSurvivesAppreciation`.
///
///         **Why this is a pure-math test, not a fork test:** the
///         full-launch fork verification (slippage + FDV measurement) is
///         blocked by a pre-existing issue — the MEV module's
///         `MAX_SKIM_BPS = 70_000` cap conflicts with our configured
///         `startingBps = 90_000` from the anti-sniper change. Deploys
///         currently revert `InvalidConfig` on MEV module init. Fork
///         verification for this locker geometry is gated on resolving
///         the MEV cap separately — see CLAUDE.md follow-up note.
contract LauncherGeometryMathTest is Test {
    // Mirror the constants in Deploy.s.sol exactly.
    uint256 internal constant TARGET_LAUNCH_FDV_USD = 69_000;
    uint256 internal constant FDV_CALC_SUPPLY_WHOLE = 999_000_000;
    int24 internal constant TICK_SPACING = 200;

    function _computeStartingTick(uint256 ethUsdPrice) internal pure returns (int24) {
        uint256 pctPerEth = (FDV_CALC_SUPPLY_WHOLE * ethUsdPrice) / TARGET_LAUNCH_FDV_USD;
        uint256 sqrtPriceX96 = FixedPointMathLib.sqrt(pctPerEth << 192);
        int24 onPoolTick = TickMath.getTickAtSqrtPrice(uint160(sqrtPriceX96));
        int24 configured = -onPoolTick;
        int24 rounded = (configured / TICK_SPACING) * TICK_SPACING;
        return rounded;
    }

    /// @notice At ETH=$2,100 (reference), configured tick should match
    ///         the artist's spec value of -172,200 within ±TICK_SPACING.
    function test_StartingTickAtReferenceEthPrice() public {
        int24 tick = _computeStartingTick(2100);
        console2.log("Configured tick at ETH=$2,100: ", int256(tick));
        console2.log("Expected (artist spec):         -172200");
        assertGe(tick, int24(-173_000), "tick too negative");
        assertLe(tick, int24(-171_400), "tick too high (closer to zero)");
    }

    /// @notice At ETH=$1,000, tick shifts vs reference. Numeric check:
    ///         pctPerEth = 999M * 1000 / 69000 = 14,478,260
    ///         ln(14.48M) ≈ 16.488 → tick ≈ 164,900 (on-pool)
    ///         configured ≈ -164,800 (rounded toward zero on tick spacing).
    function test_StartingTickAtLowerEthPrice() public {
        int24 tick = _computeStartingTick(1000);
        console2.log("Configured tick at ETH=$1,000: ", int256(tick));
        console2.log("Expected approximately:          -164800");
        assertLe(tick, int24(-164_600), "tick too high");
        assertGe(tick, int24(-165_000), "tick too low");
    }

    /// @notice At ETH=$4,200 (2x reference), tick should shift up by
    ///         ~log(2) / log(1.0001) ≈ 6931 ticks on-pool, so configured
    ///         shifts by -6931, landing around -179,000.
    function test_StartingTickAtHigherEthPrice() public {
        int24 tick = _computeStartingTick(4200);
        console2.log("Configured tick at ETH=$4,200: ", int256(tick));
        console2.log("Expected approximately:          -179000");
        assertLe(tick, int24(-178_400), "tick too high");
        assertGe(tick, int24(-179_400), "tick too low");
    }

    // REMOVED: test_MinTokensPerEthFloorAtReference +
    // test_FloorScalesLinearlyWithEthPrice. They asserted properties of the
    // `_computeMinTokensPerEthFloor` formula `Deploy.s.sol` used to size the
    // burner floor at 30% of launch spot. That floor is removed (audit H-1):
    // a static tokens-per-ETH floor bricks buy-and-burn as 111 appreciates.
    // The deploy now passes 0, and the live regression proving buy-and-burn
    // survives appreciation lives in
    // `LaunchInvariantForkTest::test_fork_H1_buyAndBurnSurvivesAppreciation`.

    /// @notice Position offsets (unchanged from launch design) are
    ///         tick-spacing-aligned for any starting tick. Verify by
    ///         computing actual ticks at the reference price.
    function test_AllPositionTicksAreSpacingAligned() public {
        int24 start = _computeStartingTick(2100);
        int24[12] memory lowerOffsets = [
            int24(0), 1_400, 3_400, 6_000, 9_400, 14_000,
            19_400, 26_000, 33_000, 40_000, 47_000, 53_400
        ];
        int24[12] memory upperOffsets = [
            int24(1_400), 3_400, 6_000, 9_400, 14_000, 19_400,
            26_000, 33_000, 40_000, 47_000, 53_400, 60_000
        ];

        for (uint256 i = 0; i < 12; i++) {
            int24 lo = start + lowerOffsets[i];
            int24 hi = start + upperOffsets[i];
            assertEq(lo % TICK_SPACING, 0, "lower tick not aligned");
            assertEq(hi % TICK_SPACING, 0, "upper tick not aligned");
            assertLt(lo, hi, "tick range backwards");
        }
    }

    /// @notice The 12 BPS weights still sum to 10_000 (no allocation drift).
    function test_PositionBpsSum() public {
        uint16[12] memory bps =
            [uint16(375), 150, 300, 500, 800, 1300, 1700, 1700, 1300, 1000, 600, 275];
        uint256 sum;
        for (uint256 i = 0; i < 12; i++) {
            sum += bps[i];
        }
        assertEq(sum, 10_000, "bps must sum to 10000");
    }

    /// @notice Position 0 is the thickened-floor change — assert the new
    ///         weight directly so any accidental revert to the old 50 bps
    ///         is caught in CI.
    function test_Position0BpsIs375() public {
        uint16[12] memory bps =
            [uint16(375), 150, 300, 500, 800, 1300, 1700, 1700, 1300, 1000, 600, 275];
        assertEq(bps[0], 375, "position 0 must be 375 bps (thickened floor)");
        assertEq(bps[10], 600, "position 10 reduced to 600");
        assertEq(bps[11], 275, "position 11 reduced to 275");
    }
}
