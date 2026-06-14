// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SkimForkFixture} from "./helpers/SkimForkFixture.sol";
import {DeployScript} from "../script/Deploy.s.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";

import {console2} from "forge-std/console2.sol";
import {V4Quoter} from "v4-periphery/lens/V4Quoter.sol";
import {IV4Quoter} from "v4-periphery/interfaces/IV4Quoter.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Candidate deploy variants. Each overrides ONLY the locker geometry via the
// virtual `_lockerPositions()` hook on the production DeployScript, so every
// candidate is exercised against the exact same `_buildFactoryConfig` / factory
// path the real launch uses. Master control = the unmodified DeployScript
// (12-position taper). C1/C2/C3 are the three 14-position candidates from
// docs/LOCKER_TAIL_EXTENSION_SPEC.md §9a.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Master control — the ORIGINAL pre-extension 12-position taper. Pinned
///      explicitly here because `DeployScript`'s production default is now the
///      14-position C4-smoothed geometry (this work's output); without this
///      override the "master" control would silently deploy C4-smoothed.
contract DeployMaster12 is DeployScript {
    function _lockerPositions()
        internal
        view
        override
        returns (int24[] memory lowerOffsets, int24[] memory upperOffsets, uint16[] memory bps)
    {
        int24[12] memory lo = [
            int24(0), 1_400, 3_400, 6_000, 9_400, 14_000,
            19_400, 26_000, 33_000, 40_000, 47_000, 53_400
        ];
        int24[12] memory up = [
            int24(1_400), 3_400, 6_000, 9_400, 14_000, 19_400,
            26_000, 33_000, 40_000, 47_000, 53_400, 60_000
        ];
        uint16[12] memory w =
            [uint16(375), 150, 300, 500, 800, 1300, 1700, 1700, 1300, 1000, 600, 275];
        lowerOffsets = new int24[](12);
        upperOffsets = new int24[](12);
        bps = new uint16[](12);
        for (uint256 i = 0; i < 12; i++) {
            lowerOffsets[i] = lo[i];
            upperOffsets[i] = up[i];
            bps[i] = w[i];
        }
    }
}

/// @dev Shared 14-position offset grid (tails 12/13 extend +60k→+72k→+83k,
///      covering ~$30M→$100M→$300M FDV). Only the BPS weights differ per
///      candidate, supplied by `_bps14()`.
abstract contract Deploy14Base is DeployScript {
    function _bps14() internal pure virtual returns (uint16[14] memory);

    function _lockerPositions()
        internal
        view
        override
        returns (int24[] memory lowerOffsets, int24[] memory upperOffsets, uint16[] memory bps)
    {
        int24[14] memory lo = [
            int24(0), 1_400, 3_400, 6_000, 9_400, 14_000, 19_400,
            26_000, 33_000, 40_000, 47_000, 53_400, 60_000, 72_000
        ];
        int24[14] memory up = [
            int24(1_400), 3_400, 6_000, 9_400, 14_000, 19_400, 26_000,
            33_000, 40_000, 47_000, 53_400, 60_000, 72_000, 83_000
        ];
        uint16[14] memory w = _bps14();
        lowerOffsets = new int24[](14);
        upperOffsets = new int24[](14);
        bps = new uint16[](14);
        for (uint256 i = 0; i < 14; i++) {
            lowerOffsets[i] = lo[i];
            upperOffsets[i] = up[i];
            bps[i] = w[i];
        }
    }
}

/// @dev C1 — spread reduction. 1,100 bps pulled gradually from mid-band
///      positions 4-9. Floor (0) + existing tails (10,11) untouched.
contract DeployC1Spread is Deploy14Base {
    function _bps14() internal pure override returns (uint16[14] memory) {
        return [uint16(375), 150, 300, 500, 700, 1000, 1500, 1500, 1100, 900, 600, 275, 700, 400];
    }
}

/// @dev C2 — concentrated reduction. 1,100 bps pulled from the "main growth"
///      band (positions 6-9); positions 4-5 (launch-window-adjacent) preserved.
contract DeployC2Concentrated is Deploy14Base {
    function _bps14() internal pure override returns (uint16[14] memory) {
        return [uint16(375), 150, 300, 500, 800, 1300, 1400, 1400, 1000, 800, 600, 275, 700, 400];
    }
}

/// @dev C3 — position-5-isolated. Most of the cut (900 bps) taken from
///      position 5 alone (+200 from position 6) to isolate position 5's
///      depth contribution, which is the single biggest reduction in C1.
contract DeployC3Pos5 is Deploy14Base {
    function _bps14() internal pure override returns (uint16[14] memory) {
        return [uint16(375), 150, 300, 500, 800, 400, 1500, 1700, 1300, 1000, 600, 275, 700, 400];
    }
}

/// @dev C4 — C3-smoothed (dev's literal recipe). Lift position 5 from C3's
///      400 → 700 (softens the notch) and take the extra 300 from positions
///      8-9 (1300→1150, 1000→850). Minimal perturbation from C3; the position-5
///      dip shrinks 800→400→1500 to 800→700→1500.
contract DeployC4Smooth is Deploy14Base {
    function _bps14() internal pure override returns (uint16[14] memory) {
        return [uint16(375), 150, 300, 500, 800, 700, 1500, 1700, 1150, 850, 600, 275, 700, 400];
    }
}

/// @dev C5 — fully-monotone (no notch). Position 5 → 800 (equal to position 4,
///      so the depth curve is non-decreasing 4→5→6→7), with the cut spread
///      across 5/6/7/8/9. Eliminates the position-5 dip entirely at the cost of
///      a slightly broader mid-band trim than C3.
contract DeployC5Monotone is Deploy14Base {
    function _bps14() internal pure override returns (uint16[14] memory) {
        return [uint16(375), 150, 300, 500, 800, 800, 1500, 1600, 1150, 850, 600, 275, 700, 400];
    }
}

/// @notice Real-fork slippage probe for the locker tail-extension design.
///         Deploys the full PC stack four times (master + 3 candidates) against
///         a mainnet fork, warps the pool to each FDV checkpoint via real buys,
///         and measures effective buy-slippage at a grid of trade sizes using a
///         V4 Quoter. Effective slippage bundles the constant 5% hook skim +
///         1% LP fee + price impact; since fees are identical across candidates,
///         the candidate-minus-master DELTA isolates depth. See
///         docs/LOCKER_TAIL_EXTENSION_SPEC.md §9a + docs/LOCKER_TAIL_PROBE_RESULTS.md.
///
///         Run (MUST be single-threaded — every candidate's DeployScript.run()
///         writes the same host `deployments.json`, so parallel test threads
///         race on it; `-j 1` serializes them):
///           MAINNET_RPC_URL=https://gateway.tenderly.co/public/mainnet \
///             forge test --match-contract LockerSlippageProbe -j 1 -vv
contract LockerSlippageProbe is SkimForkFixture {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // FDV math basis — matches DeployScript's own convention so the FDV axis
    // labels line up with `_computeStartingTick` (999M supply, $2,100 ETH →
    // ~$69K launch FDV at the starting tick).
    uint256 internal constant SUPPLY_WHOLE = 999_000_000;
    uint256 internal constant ETH_USD = 2100;
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant TICK_SPACING = 200;

    // Probe grid (docs §9a). FDV checkpoints in USD (ascending — warps are
    // cumulative). Trade sizes in ETH wei spanning tiny → sizable (1000×).
    uint256[5] internal FDV_GRID = [
        uint256(200_000), 500_000, 1_000_000, 5_000_000, 10_000_000
    ];
    uint256[4] internal SIZE_GRID = [
        uint256(0.01 ether), 0.1 ether, 1 ether, 10 ether
    ];

    IV4Quoter internal quoter;

    /// @dev Accept ETH (keeper rewards / stray sends during warps).
    receive() external payable {}

    function setUp() public {
        // Tenderly public gateway — archive-capable, survives the fork
        // instantiation burst (per repo RPC discipline).
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(rpc);
        _setupSkimStackEnv();
        quoter = IV4Quoter(address(new V4Quoter(IPoolManager(POOL_MANAGER))));
    }

    function test_probe_master() public {
        _runProbe(new DeployMaster12(), "MASTER-12");
    }

    /// @dev The shipped production default (C4-smoothed). Confirms the geometry
    ///      Deploy.s.sol now deploys matches the C4 candidate's profile.
    function test_probe_production_default() public {
        _runProbe(new DeployScript(), "PROD-C4-default");
    }

    function test_probe_C1_spread() public {
        _runProbe(new DeployC1Spread(), "C1-spread");
    }

    function test_probe_C2_concentrated() public {
        _runProbe(new DeployC2Concentrated(), "C2-concentrated");
    }

    function test_probe_C3_pos5() public {
        _runProbe(new DeployC3Pos5(), "C3-pos5-isolated");
    }

    function test_probe_C4_smooth() public {
        _runProbe(new DeployC4Smooth(), "C4-smoothed");
    }

    function test_probe_C5_monotone() public {
        _runProbe(new DeployC5Monotone(), "C5-monotone");
    }

    /// @notice Tail-coverage assertion (distinct from the comparison probe):
    ///         the two NEW concentrated tail positions (12 & 13) must provide
    ///         real depth across the $30M–$300M FDV band that neither the prior
    ///         12-position locker NOR POL covered. Deploys the production
    ///         C4-smoothed default (14 positions — this very deploy would revert
    ///         TooManyPositions if the locker were still capped at 12) and
    ///         confirms a sizeable trade absorbs with bounded slippage at $50M
    ///         (tail 12) and $200M (tail 13). Reaching those FDVs at all proves
    ///         the liquidity is continuous past the old $31M ceiling.
    function test_fork_tailPositions_absorbHighFdvTrades() public {
        _fundDeployer();
        new DeployScript().run(); // production C4-smoothed 14-position geometry
        _loadDeployments();
        vm.deal(address(this), 5_000_000 ether);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(deployedHook)
        });
        PoolId pid = key.toId();
        vm.warp(block.timestamp + 2 hours);
        vm.roll(block.number + 600);

        TestSwapHelper swapper =
            new TestSwapHelper(POOL_MANAGER, token, deployedHook, DYNAMIC_FEE_FLAG, TICK_SPACING);

        // Tail 12 band (~$31M–$103M FDV): warp to $50M, confirm real depth.
        _warpTo(swapper, pid, 50_000_000);
        (uint160 s1,,,) = IPoolManager(POOL_MANAGER).getSlot0(pid);
        uint256 fdv1 = _fdvFromSqrt(s1);
        assertApproxEqRel(fdv1, 50_000_000, 0.03e18, "reached ~$50M FDV (tail 12 liquidity present)");
        uint256 slip1 = _quoteSlippageBps(key, s1, 10 ether);
        assertLt(slip1, 3000, "10 ETH buy bounded <30% at $50M (tail 12 depth)");

        // Tail 13 band (~$103M–$310M FDV): warp to $200M, confirm real depth.
        _warpTo(swapper, pid, 200_000_000);
        (uint160 s2,,,) = IPoolManager(POOL_MANAGER).getSlot0(pid);
        uint256 fdv2 = _fdvFromSqrt(s2);
        assertApproxEqRel(fdv2, 200_000_000, 0.03e18, "reached ~$200M FDV (tail 13 liquidity present)");
        uint256 slip2 = _quoteSlippageBps(key, s2, 10 ether);
        assertLt(slip2, 3000, "10 ETH buy bounded <30% at $200M (tail 13 depth)");

        console2.log(
            string.concat(
                "TAIL,fdv1=", vm.toString(fdv1), ",slip1=", vm.toString(slip1),
                ",fdv2=", vm.toString(fdv2), ",slip2=", vm.toString(slip2)
            )
        );
    }

    // ─── Core probe ──────────────────────────────────────────────────────────

    function _runProbe(DeployScript script, string memory label) internal {
        _fundDeployer();
        script.run();
        _loadDeployments();

        // Fund this contract to drive price warps (buys consume ETH; refunded).
        vm.deal(address(this), 2_000_000 ether);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(deployedHook)
        });
        PoolId pid = key.toId();

        // Past the ~30-min anti-sniper MEV window so the skim is the static 6%
        // baseline (constant across candidates → clean depth deltas). Roll a few
        // blocks too so any block-based gates clear.
        vm.warp(block.timestamp + 2 hours);
        vm.roll(block.number + 600);

        // Price-convention sanity: launch FDV must land near the $69K the deploy
        // targets. A wildly different value would mean the on-pool price is
        // inverted vs the formula and every downstream FDV target is wrong.
        (uint160 sqrtLaunch,,,) = IPoolManager(POOL_MANAGER).getSlot0(pid);
        uint256 launchFdv = _fdvFromSqrt(sqrtLaunch);
        console2.log(string.concat("LAUNCH_FDV_USD,", label, ",", vm.toString(launchFdv)));
        require(launchFdv > 40_000 && launchFdv < 120_000, "probe: launch FDV out of expected band");

        TestSwapHelper swapper =
            new TestSwapHelper(POOL_MANAGER, token, deployedHook, DYNAMIC_FEE_FLAG, TICK_SPACING);

        console2.log("CSV_HEADER,candidate,fdv_usd,eth_in_wei,slippage_bps");

        for (uint256 f = 0; f < FDV_GRID.length; f++) {
            uint256 targetFdv = FDV_GRID[f];

            // Warp the pool up to the target FDV via full-consumption buys. A
            // price-LIMITED swap can't be used: this hook skims on the full
            // *specified* exact-input amount, so a partial fill at the price
            // limit makes it over-skim and `poolManager.take` reverts
            // NativeTransferFailed. Full-consumption buys keep skim ↔ flow
            // consistent. See _warpTo.
            _warpTo(swapper, pid, targetFdv);

            (uint160 sqrtNow,,,) = IPoolManager(POOL_MANAGER).getSlot0(pid);
            uint256 fdvNow = _fdvFromSqrt(sqrtNow);

            for (uint256 s = 0; s < SIZE_GRID.length; s++) {
                uint256 ethIn = SIZE_GRID[s];
                uint256 slipBps = _quoteSlippageBps(key, sqrtNow, ethIn);
                console2.log(
                    string.concat(
                        "ROW,",
                        label,
                        ",",
                        vm.toString(fdvNow),
                        ",",
                        vm.toString(ethIn),
                        ",",
                        vm.toString(slipBps)
                    )
                );
            }
        }
    }

    /// @dev Effective buy-slippage in bps for an `ethIn` exact-input buy at the
    ///      current price. ideal (zero-impact, zero-fee) tokenOut = ethIn × P,
    ///      where P (token per ETH) = sqrtP² / 2^192. The Quoter's tokenOut
    ///      reflects the real swap incl. hook skim + LP fee.
    function _quoteSlippageBps(PoolKey memory key, uint160 sqrtNow, uint256 ethIn)
        internal
        returns (uint256 slipBps)
    {
        IV4Quoter.QuoteExactSingleParams memory qp = IV4Quoter.QuoteExactSingleParams({
            poolKey: key,
            zeroForOne: true,
            exactAmount: uint128(ethIn),
            hookData: ""
        });
        (uint256 tokenOut,) = quoter.quoteExactInputSingle(qp);

        uint256 sqrtSq = uint256(sqrtNow) * uint256(sqrtNow);
        uint256 idealOut = FixedPointMathLib.fullMulDiv(ethIn, sqrtSq, uint256(1) << 192);
        if (idealOut == 0 || tokenOut >= idealOut) return 0;
        slipBps = ((idealOut - tokenOut) * 10_000) / idealOut;
    }

    /// @dev Warp the pool up to `targetFdv` (price decreasing, FDV rising) via
    ///      a sequence of FULL-consumption buys. Each step aims at the geometric
    ///      midpoint between the current and target sqrtPrice and buys the
    ///      constant-liquidity ETH amount for that sub-move (un-inflated, so the
    ///      5% skim + 1% LP fee make it undershoot — guaranteeing monotone
    ///      approach without overshooting the target). Converges in a handful of
    ///      steps per checkpoint. Stops within 1% of the target FDV.
    function _warpTo(TestSwapHelper swapper, PoolId pid, uint256 targetFdv) internal {
        uint160 sqrtTarget = _sqrtFromFdv(targetFdv);
        for (uint256 i = 0; i < 100; i++) {
            (uint160 sqrtNow,,,) = IPoolManager(POOL_MANAGER).getSlot0(pid);
            if (_fdvFromSqrt(sqrtNow) >= (targetFdv * 99) / 100) return;

            // Geometric midpoint (in sqrt-price space) between now and target.
            // Buying lowers sqrtPrice toward the target.
            uint160 sqrtMid = uint160(FixedPointMathLib.sqrt(uint256(sqrtNow) * uint256(sqrtTarget)));
            if (sqrtMid >= sqrtNow) sqrtMid = sqrtNow - 1; // ensure forward progress

            uint128 L = IPoolManager(POOL_MANAGER).getLiquidity(pid);
            uint256 dEth = L == 0
                ? 0.01 ether
                : SqrtPriceMath.getAmount0Delta(sqrtMid, sqrtNow, L, true);
            if (dEth < 0.005 ether) dEth = 0.005 ether; // floor: make progress near boundaries
            if (dEth > address(this).balance) dEth = address(this).balance;

            swapper.buyTokenWithEth{value: dEth}(dEth);
        }
        revert("warp: did not converge to target FDV");
    }

    // ─── FDV ⇄ sqrtPrice helpers ──────────────────────────────────────────────
    //
    // P (token per ETH) = sqrtP² / 2^192. FDV_usd = SUPPLY_WHOLE × ETH_USD / P
    //                   = SUPPLY_WHOLE × ETH_USD × 2^192 / sqrtP².
    // Invert for the target price at a given FDV:
    //   sqrtP_target = sqrt( SUPPLY_WHOLE × ETH_USD × 2^192 / FDV_usd ).

    function _fdvFromSqrt(uint160 sqrtP) internal pure returns (uint256) {
        uint256 sqrtSq = uint256(sqrtP) * uint256(sqrtP);
        return FixedPointMathLib.fullMulDiv(SUPPLY_WHOLE * ETH_USD, uint256(1) << 192, sqrtSq);
    }

    function _sqrtFromFdv(uint256 fdvUsd) internal pure returns (uint160) {
        uint256 sqrtSq =
            FixedPointMathLib.fullMulDiv(SUPPLY_WHOLE * ETH_USD, uint256(1) << 192, fdvUsd);
        return uint160(FixedPointMathLib.sqrt(sqrtSq));
    }
}
