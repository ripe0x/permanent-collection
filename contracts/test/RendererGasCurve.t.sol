// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";

import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {TraitIconCache} from "../src/TraitIconCache.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @title  RendererGasCurve
/// @notice Emits a CSV-friendly table of `svg()` render gas vs trait-icon
///         cache population, baking one trait per row across the 105
///         cacheable traits. The six rotation traits ({0, 1, 4, 5, 6,
///         15}) are skipped — `TraitIconCache.cacheTrait` reverts on
///         them by design — and their cells stay on the renderer's
///         on-the-fly path forever, which the `svg()` measurements
///         still exercise. Useful for the docs in `docs/RENDERER_CACHE.md`
///         (the table there is a rough estimate; this captures the
///         real curve).
///
///         Measures `svg()` (the raw render), not `tokenURI()`, so the
///         cache-effectiveness signal is isolated. `tokenURI()`
///         base64-encodes the whole JSON envelope at the end — a large
///         allocation whose quadratic memory cost is sensitive to the
///         render path's memory high-water mark (the cache path's
///         per-trait external reads raise it), which swamps the cache
///         delta. The full-`tokenURI()` gas budgets are gated separately
///         by `DeployBakeRender`.
///
///         Heavy: bakes 105 + ~106 render measurements = ~30s on
///         the fork. Skipped from the default suite via the
///         `--match-contract RendererGasCurve` pattern.
contract RendererGasCurveTest is ForkFixtures {
    PermanentCollectionMosaicRenderer internal mosaic;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        // Fresh cache + mosaic — no shared state with the rest of the
        // suite. The mosaic is identical to what `_launchPool` would
        // wire, just constructed here so we don't pay the artcoins
        // factory cost (this test doesn't need the token / hook).
        punkSvgCache = new PunkSvgFragmentCache(PUNKS_DATA);
        traitIconCache = new TraitIconCache(PUNKS_DATA);
        proofRenderer = new PermanentCollectionProofRenderer(
            address(vault), PUNKS_DATA, address(traitIconCache), address(punkSvgCache)
        );
        mosaic = new PermanentCollectionMosaicRenderer(
            address(collection),
            address(vault),
            address(punkSvgCache),
            PUNKS_DATA,
            address(traitIconCache),
            address(proofRenderer)
        );
    }

    /// @notice Bake 1..111 traits and emit one CSV row per bake:
    ///           <cached>, <bakeGas>, <svgGas>
    ///         The output is consumable as CSV via:
    ///           forge test --match-contract RendererGasCurve -vv | \
    ///             grep -E '^csv,' | sed 's/^csv,//'
    function test_GasCurve_OverallDecreasing() public {
        // Header.
        console2.log("csv,cached,bakeGas,svgGas");

        uint256 zeroBakedGas;
        uint256 allBakedGas;

        // Baseline: render at 0 baked.
        zeroBakedGas = _measureSvgGas();
        console2.log("csv,0,0,", zeroBakedGas);

        uint256 cachedSoFar = 0;
        for (uint8 t = 0; t < 111; t++) {
            if (traitIconCache.isRotationTrait(t)) {
                // Rotation traits stay on-the-fly forever; nothing to bake.
                continue;
            }
            uint256 g0 = gasleft();
            traitIconCache.cacheTrait(t);
            uint256 bakeGas = g0 - gasleft();
            cachedSoFar++;

            uint256 svgGas = _measureSvgGas();
            // Emit one CSV row per bake.
            console2.log("csv,", cachedSoFar);
            console2.log("  bakeGas", bakeGas);
            console2.log("  svgGas", svgGas);

            if (t == 110) allBakedGas = svgGas;
        }
        // Curve is overall non-increasing but with small bumps where a
        // cached cell is cheaper to recompute than to read (e.g. the
        // AttributeCount dot strips at trait indices 16-23, which
        // compute as ~600k of pure arithmetic vs ~50k SSTORE2 + ~30k
        // memory copy + dictionary lookup once cached). The bumps are
        // a few hundred thousand gas — visible in the CSV but never
        // material against the multi-100M baseline. Assert the global
        // direction instead: post-111 is materially cheaper than 0.

        // Headline: bakes substantially reduce the render cost. The
        // absolute numbers vary between this local-fresh fixture and the
        // production-wired DeployBakeRender canary (the 50M Etherscan
        // budget is asserted in that canary; this test focuses on the
        // CSV curve and the relative cache effectiveness).
        emit log_named_uint("svg render gas @ 0 baked", zeroBakedGas);
        emit log_named_uint("svg render gas @ 105 baked (max cacheable)", allBakedGas);
        // Cache must materially reduce render cost. The six rotation
        // cells {0, 1, 4, 5, 6, 15} stay on the live per-block path
        // forever (RotationPool.pick) and are measured in BOTH endpoints,
        // so they don't contribute to the delta — the savings come purely
        // from the 105 cacheable cells and are block-independent. That
        // caps the achievable drop at ~14% here, not the ~33% an
        // all-cacheable set would give. Require a >= 10% reduction:
        // enough to prove the cache works, with headroom over the
        // measured ~14% for block-to-block rotation-Punk size variance.
        assertLt(
            allBakedGas + (allBakedGas / 9), // 1.111x  <=>  require >10% drop
            zeroBakedGas,
            "bakes barely moved gas: cache ineffective"
        );
    }

    function _measureSvgGas() internal returns (uint256 gasUsed) {
        uint256 gasBefore = gasleft();
        mosaic.svg();
        gasUsed = gasBefore - gasleft();
    }
}
