// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base64} from "solady/utils/Base64.sol";

import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {TraitIconCache} from "../src/TraitIconCache.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Renders the Mosaic trait grid SVG at multiple states and writes
///         them to `svg-out/` for visual confirmation that the layout
///         renders correctly across the full range of collection states.
contract RendererSnapshotTest is ForkFixtures {
    PermanentCollectionMosaicRenderer internal mosaic;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        punkSvgCache = new PunkSvgFragmentCache(PUNKS_DATA);
        traitIconCache = new TraitIconCache(PUNKS_DATA);
        proofRenderer = new PermanentCollectionProofRenderer(address(vault), PUNKS_DATA, address(traitIconCache), address(punkSvgCache));
        mosaic = new PermanentCollectionMosaicRenderer(
            address(collection),
            address(vault),
            address(punkSvgCache),
            PUNKS_DATA,
            address(traitIconCache),
            address(proofRenderer)
        );
    }

    /// @notice Render the shipped Mosaic renderer at four states: empty,
    ///         one Punk vaulted-but-uncached (the live-fallback path
    ///         introduced by PR #81), the same after caching (must be
    ///         byte-identical by the identity invariant), and a multi-
    ///         Punk state with a mix of cached and uncached tiles.
    function test_RenderSnapshots_Mosaic() public {
        // `Patron.acceptBid` debits the live bid by the listed price (set to
        // ~the full bid) on every call, so each acquisition drains the pool.
        // Re-fund the live bid before EACH acceptBid below — otherwise the next
        // acquisition lists against a 0 bid and reverts ZeroListingPrice.

        // (1) Empty — every cell is an uncollected swatch.
        _writeSvg("svg-out/mosaic-00-empty.svg", mosaic.svg());

        // (2) Settle one Punk, do NOT cache → live-fallback path runs.
        uint16 punkA = _findEligiblePunk(1);
        address ownerA = address(0xBEA71E);
        _fundPatronFromAdapter(30 ether);
        _giveAndOfferToBounty(ownerA, punkA);
        uint8 targetA = _pickTarget(punkA);
        vm.prank(ownerA);
        patron.acceptBid(punkA, targetA, type(uint256).max);
        vm.warp(uint256(finalSale.endsAt(punkA)) + 1);
        finalSale.settle(punkA);
        _writeSvg("svg-out/mosaic-01-uncached.svg", mosaic.svg());

        // (3) Cache the Punk → cached path runs. Should be byte-identical
        //     to (2) per `buildFragment == cachePunk` identity invariant.
        mosaic.cacheTrait(targetA);
        _writeSvg("svg-out/mosaic-02-cached.svg", mosaic.svg());

        // (4) Settle two more Punks WITHOUT caching them, then a third
        //     WITH caching, to show a heterogeneous grid.
        uint16 punkB = _findEligiblePunk(punkA + 1);
        address ownerB = address(0xBEA72E);
        _fundPatronFromAdapter(30 ether);
        _giveAndOfferToBounty(ownerB, punkB);
        uint8 targetB = _pickTarget(punkB);
        vm.prank(ownerB);
        patron.acceptBid(punkB, targetB, type(uint256).max);
        vm.warp(uint256(finalSale.endsAt(punkB)) + 1);
        finalSale.settle(punkB);

        uint16 punkC = _findEligiblePunk(punkB + 1);
        address ownerC = address(0xBEA73E);
        _fundPatronFromAdapter(30 ether);
        _giveAndOfferToBounty(ownerC, punkC);
        uint8 targetC = _pickTarget(punkC);
        vm.prank(ownerC);
        patron.acceptBid(punkC, targetC, type(uint256).max);
        vm.warp(uint256(finalSale.endsAt(punkC)) + 1);
        finalSale.settle(punkC);

        uint16 punkD = _findEligiblePunk(punkC + 1);
        address ownerD = address(0xBEA74E);
        _fundPatronFromAdapter(30 ether);
        _giveAndOfferToBounty(ownerD, punkD);
        uint8 targetD = _pickTarget(punkD);
        vm.prank(ownerD);
        patron.acceptBid(punkD, targetD, type(uint256).max);
        vm.warp(uint256(finalSale.endsAt(punkD)) + 1);
        finalSale.settle(punkD);
        mosaic.cacheTrait(targetD);

        _writeSvg("svg-out/mosaic-03-mixed.svg", mosaic.svg());

        // (5) acceptBid on a fresh Punk WITHOUT settling — the target
        //     trait bit is now `pending` (in-auction) but not yet
        //     collected. Renders with the uncollected fill + trait icon
        //     overlaid with a dashed PENDING_STROKE (#454545) border.
        uint16 punkE = _findEligiblePunk(punkD + 1);
        address ownerE = address(0xBEA75E);
        _fundPatronFromAdapter(30 ether);
        _giveAndOfferToBounty(ownerE, punkE);
        uint8 targetE = _pickTarget(punkE);
        vm.prank(ownerE);
        patron.acceptBid(punkE, targetE, type(uint256).max);
        // Deliberately do NOT warp + settle — leave the auction live.
        _writeSvg("svg-out/mosaic-04-pending.svg", mosaic.svg());
    }

    function _writeSvg(string memory path, string memory svg) internal {
        vm.writeFile(path, svg);
    }

    /// @notice Dump several Proof SVGs. The unminted Proof image is one
    ///         square 24×24 trait tile on a `#8F918B` background
    ///         — the trait visual alone, since no Punk has been
    ///         acquired yet. Once minted, the acquired Punk is drawn
    ///         faintly (5% opacity) behind the trait, so the minted
    ///         image DIFFERS from its unminted preview. This test
    ///         exercises a representative sample across trait categories
    ///         AND confirms: (a) the minted image is no longer
    ///         byte-identical to the preview, (b) the unminted preview is
    ///         still exactly the trait-only render, and (c) the minted
    ///         image carries the faint Punk layer.
    function test_RenderSnapshots_Proofs() public {
        _fundPatronFromAdapter(30 ether);

        // (1) Trait tiles — one per category, named by traitId. Unminted,
        //     so trait-only (no Punk layer).
        _writeSvg("svg-out/proof-tile-000-alien.svg",       proofRenderer.svg(0));    // type
        _writeSvg("svg-out/proof-tile-004-zombie.svg",      proofRenderer.svg(4));    // pulled-out type
        _writeSvg("svg-out/proof-tile-016-attrs-0.svg",     proofRenderer.svg(16));   // 0-attribute count
        _writeSvg("svg-out/proof-tile-056-goat.svg",        proofRenderer.svg(56));   // mid-range accessory
        _writeSvg("svg-out/proof-tile-110-wildwhite.svg",   proofRenderer.svg(110));  // last accessory

        // (2) Mint a single Proof end-to-end and verify the post-mint
        //     image now DIFFERS from the pre-mint preview — the acquired
        //     Punk appears as a faint background layer once minted.
        uint16 punkA = _findEligiblePunk(1);
        address ownerA = address(0xBEA71E);
        _giveAndOfferToBounty(ownerA, punkA);
        uint8 targetA = _pickTarget(punkA);
        string memory preMint = proofRenderer.svg(targetA);
        bytes32 preMintHash = keccak256(bytes(preMint));
        // Pre-mint preview must be the trait-only tile (no Punk layer).
        assertFalse(
            _contains(preMint, '<g opacity="0.05">'),
            "Unminted Proof must not draw a Punk layer"
        );
        vm.prank(ownerA);
        patron.acceptBid(punkA, targetA, type(uint256).max);
        vm.warp(uint256(finalSale.endsAt(punkA)) + 1);
        finalSale.settle(punkA);
        string memory postMint = proofRenderer.svg(targetA);
        bytes32 postMintHash = keccak256(bytes(postMint));
        assertTrue(preMintHash != postMintHash, "Minted Proof image must differ from the unminted preview");
        // Minted image must carry the faint acquired-Punk layer.
        assertTrue(
            _contains(postMint, '<g opacity="0.05">'),
            "Minted Proof must draw the acquired Punk at 5% opacity"
        );

        // (3) Also dump the minted trait's tile so it's visible alongside
        //     the other samples in svg-out/.
        string memory mintedPath = string.concat(
            "svg-out/proof-tile-",
            _pad3(uint256(targetA)),
            "-minted.svg"
        );
        _writeSvg(mintedPath, postMint);
    }

    function _pad3(uint256 n) internal pure returns (string memory) {
        if (n < 10) return string.concat("00", _u(n));
        if (n < 100) return string.concat("0", _u(n));
        return _u(n);
    }

    function _u(uint256 n) internal pure returns (string memory) {
        // Tiny uint-to-string helper to keep this self-contained and
        // avoid pulling solady/LibString into the test layer.
        if (n == 0) return "0";
        uint256 tmp = n;
        uint256 len;
        while (tmp != 0) { len++; tmp /= 10; }
        bytes memory b = new bytes(len);
        while (n != 0) { b[--len] = bytes1(uint8(48 + n % 10)); n /= 10; }
        return string(b);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return n.length == 0;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) { ok = false; break; }
            }
            if (ok) return true;
        }
        return false;
    }

    function _findEligiblePunk(uint16 startFrom) internal view returns (uint16) {
        for (uint16 i = startFrom; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible punk");
    }
}
