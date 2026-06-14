// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {RotationPool} from "./libraries/RotationPool.sol";
import {SvgPrimitives} from "./libraries/SvgPrimitives.sol";
import {IPunksData} from "./interfaces/IPunksData.sol";

/// @title  TraitIconCache
/// @notice Public, permissionless cache of compact SVG fragments for each
///         of the 111 CryptoPunks trait icons. Companion to
///         `PunkSvgFragmentCache`: that one caches whole-Punk tiles for
///         collected-cell rendering; this one caches the trait icons drawn
///         in uncollected/pending cells of the PERMANENT COLLECTION
///         mosaic.
///
///         For each trait id 0..110 the cache stores the same SVG bytes
///         that the renderer would compose on the fly:
///
///           Type / HeadVariant (0..15)      → full canonical Punk RLE
///           AttributeCount (16..23)         → 7-slot dot strip
///           Accessory (24..110)             → canonical-vs-baseline diff
///
///         The canonical Punk per trait is pinned in `CANONICAL_IDS` —
///         identical to the table used by the renderer.
///
///         There is no admin. No setters. No funds. Once cached, a
///         trait's fragment is permanent. Anyone can pay gas to bake a
///         trait. The renderer reads from this cache when a fragment is
///         present and falls back to on-the-fly compute when it isn't,
///         so the cache "turns on" gradually as bakes accumulate without
///         requiring any team coordination.
///
///         Designed as a public good — usable by any project rendering
///         Punk trait icons, not just the PERMANENT COLLECTION protocol.
contract TraitIconCache {
    /// @notice Emitted once per trait on its first `cacheTrait` call.
    /// @param traitId     The trait index (0..110).
    /// @param pointer     The SSTORE2 storage contract holding the fragment.
    /// @param byteLength  Length of the cached fragment bytes.
    event TraitCached(uint8 indexed traitId, address indexed pointer, uint256 byteLength);

    /// @notice Reverts if `traitId >= 111`.
    error InvalidTraitId(uint8 traitId);
    /// @notice Reverts on read for a trait that has never been baked.
    error NotCached(uint8 traitId);
    /// @notice Reverts at bake time if the derived fragment is empty.
    ///         Defense in depth: no valid trait icon resolves to zero
    ///         bytes given the on-chain CANONICAL_IDS + PunksData state.
    error EmptyFragment(uint8 traitId);
    /// @notice Reverts when `cacheTrait` or `buildFragment` is called for
    ///         a trait id whose renderer cell rotates per block (trait ids
    ///         {0, 1, 4, 5, 6, 15} — the rare types and their matching head
    ///         variants). The Mosaic renderer draws a per-block-rotated Punk
    ///         for these cells, so any cached or "what would be baked"
    ///         bytes would be wrong within ~12 seconds. The cache is not the
    ///         right abstraction here; the renderer's rotation path is.
    error RotationTraitNotCacheable(uint8 traitId);
    /// @notice Reverts at construction if the supplied `_punksData` does
    ///         not match the expected dataset hash.
    error UnexpectedDatasetHash(bytes32 expected, bytes32 actual);

    /// @notice Number of distinct CryptoPunks traits.
    uint8 public constant TOTAL_TRAITS = 111;

    /// @notice 24×24 dimension of canonical Punk tiles.
    uint256 public constant PUNK_DIM = 24;

    /// @notice Pinned hash of the PunksData dataset. Same value used by
    ///         `PunkSvgFragmentCache` and `PermanentCollection`.
    bytes32 public constant EXPECTED_DATASET_HASH =
        0x92117ce6cb6bb70f9ffb9bf51ebbca6a84eae10e70639295d9c4a07958cd1f68;

    /// @notice Source of pixel + palette data. Sealed at construction.
    IPunksData public immutable punksData;

    /// @dev Canonical exemplar Punk-id per trait, packed 2 bytes per id.
    ///      Index 0..110 = trait id. Identical to the table used by the
    ///      Mosaic renderer. Pinned against the on-chain trait taxonomy at
    ///      the same datasetHash.
    bytes private constant CANONICAL_IDS =
        hex"0c1c09bb0002000608120b4a0174089c041a0281195702e501fe01190ceb067a"
        hex"01190002000100000004002302f3209c0225005d015807ac06cd035f00600366"
        hex"1532011002460087212b005907f90cd7061a12d1014f17cb018d0014001a0006"
        hex"01180012003700b20b74068d1da4015103bd03800ff0002b0a600039003618c3"
        hex"008c002f169401b4002c007101430069098d1c43148e0ad00b6f061600f90021"
        hex"04d003460fb51851008601ac015a075b0024027523b900b700381bc714f0102f"
        hex"031e00bb006a01a1001f004202c2035315ca02a90132071d00f100020019";

    /// @dev traitId → SSTORE2 storage-contract address. Zero means uncached.
    mapping(uint8 => address) private _pointers;

    constructor(address _punksData) {
        IPunksData pd = IPunksData(_punksData);
        bytes32 actual = pd.datasetHash();
        if (actual != EXPECTED_DATASET_HASH) {
            revert UnexpectedDatasetHash(EXPECTED_DATASET_HASH, actual);
        }
        punksData = pd;
    }

    // ────────── write ──────────

    /// @notice Bake `traitId`'s SVG fragment into a fresh SSTORE2 storage
    ///         contract. Idempotent — if already cached, returns the
    ///         existing pointer without redeploying.
    /// @param  traitId The trait index (0..110).
    /// @return pointer The address of the SSTORE2 contract holding the fragment.
    function cacheTrait(uint8 traitId) external returns (address pointer) {
        if (traitId >= TOTAL_TRAITS) revert InvalidTraitId(traitId);
        if (RotationPool.isRotation(uint16(traitId))) revert RotationTraitNotCacheable(traitId);
        pointer = _pointers[traitId];
        if (pointer != address(0)) return pointer;

        bytes memory fragment = _buildFragment(traitId);
        if (fragment.length == 0) revert EmptyFragment(traitId);

        pointer = SSTORE2.write(fragment);
        _pointers[traitId] = pointer;
        emit TraitCached(traitId, pointer, fragment.length);
    }

    // ────────── read ──────────

    /// @notice True iff `traitId` has been cached.
    function isCached(uint8 traitId) external view returns (bool) {
        if (traitId >= TOTAL_TRAITS) revert InvalidTraitId(traitId);
        return _pointers[traitId] != address(0);
    }

    /// @notice Storage-contract address holding the fragment for `traitId`.
    ///         Reverts `NotCached` if uncached.
    function pointerOf(uint8 traitId) external view returns (address) {
        if (traitId >= TOTAL_TRAITS) revert InvalidTraitId(traitId);
        address p = _pointers[traitId];
        if (p == address(0)) revert NotCached(traitId);
        return p;
    }

    /// @notice Raw cached fragment bytes for `traitId`. The output is the
    ///         SVG markup the renderer would compose on the fly for an
    ///         uncollected cell at this trait (sequence of `<rect>`
    ///         elements with coordinates in the 0..23 range). Reverts
    ///         `NotCached` if uncached.
    function fragmentOf(uint8 traitId) external view returns (bytes memory) {
        if (traitId >= TOTAL_TRAITS) revert InvalidTraitId(traitId);
        address p = _pointers[traitId];
        if (p == address(0)) revert NotCached(traitId);
        return SSTORE2.read(p);
    }

    /// @notice Convenience view: the cached fragment wrapped in a
    ///         standalone 24×24 `<svg>` element. Useful for direct
    ///         consumption by previewers and tests.
    function svgOf(uint8 traitId) external view returns (string memory) {
        if (traitId >= TOTAL_TRAITS) revert InvalidTraitId(traitId);
        address p = _pointers[traitId];
        if (p == address(0)) revert NotCached(traitId);
        bytes memory frag = SSTORE2.read(p);
        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">',
                frag,
                "</svg>"
            )
        );
    }

    /// @notice Lookup the canonical exemplar Punk for a trait. Public
    ///         pure view so any consumer can reuse the mapping without
    ///         redoing the decode.
    function canonicalPunkForTrait(uint8 traitId) external pure returns (uint16) {
        if (traitId >= TOTAL_TRAITS) revert InvalidTraitId(traitId);
        return _canonicalPunkId(traitId);
    }

    /// @notice Compute (but don't store) the fragment bytes the cache
    ///         would produce for `traitId`. Pure view over sealed
    ///         PunksData state (and `block.number` for rotation traits).
    ///         Useful for:
    ///         - test invariants asserting that cached bytes equal what
    ///           consumers would generate on the fly,
    ///         - off-chain previewers that want the icon without paying
    ///           the SSTORE2 deploy gas,
    ///         - cross-instance verification (any caller can independently
    ///           reproduce expected bake bytes),
    ///         - the Proof renderer, which uses these bytes as the
    ///           image content for token ids 0..110.
    ///
    /// @dev    **Cross-contract identity invariant**: for every valid `t`,
    ///         `this.buildFragment(t) == mosaicRenderer.traitIconBytes(t)`
    ///         at the same `block.number`. For non-rotation traits the
    ///         bytes are stable forever; for the six rotation trait ids
    ///         {0, 1, 4, 5, 6, 15} (see [[RotationPool]]) both sides
    ///         compute the same per-block pick, so the invariant still
    ///         holds within a block. The rotation algorithm lives in the
    ///         shared `RotationPool` library so the cache and the
    ///         renderer can't drift on the pool data or the seed.
    ///         Enforced by the test
    ///         `PermanentCollectionMosaicRenderer.t.sol::
    ///         test_AllTraits_RendererOnTheFly_MatchesCacheBuild`.
    function buildFragment(uint8 traitId) external view returns (bytes memory) {
        if (traitId >= TOTAL_TRAITS) revert InvalidTraitId(traitId);
        return _buildFragment(traitId);
    }

    /// @notice Whether `traitId`'s renderer cell rotates per block instead
    ///         of pinning a canonical Punk. Trait ids {0, 1, 4, 5, 6, 15}
    ///         are the rare types and matching head variants. Rotation
    ///         traits can be queried via `buildFragment` (returns the
    ///         current block's pick) but cannot be SSTORE2-cached —
    ///         `cacheTrait` reverts `RotationTraitNotCacheable`.
    function isRotationTrait(uint8 traitId) external pure returns (bool) {
        if (traitId >= TOTAL_TRAITS) revert InvalidTraitId(traitId);
        return RotationPool.isRotation(uint16(traitId));
    }

    // ────────── internal: bake ──────────

    /// @dev Compose the trait icon for `traitId`. Same four branches as
    ///      the Mosaic renderer's on-the-fly path so cached + uncached
    ///      reads produce byte-identical fragments:
    ///        - Rotation trait (0, 1, 4, 5, 6, 15) → per-block-picked Punk
    ///          (via the shared `RotationPool` library; reads
    ///          `block.number`).
    ///        - Type or HeadVariant (traitId < 16 otherwise) → canonical
    ///          Punk in full.
    ///        - AttributeCount (16..23) → N-of-7 dot strip.
    ///        - Accessory (24..110) → canonical-vs-baseline diff.
    function _buildFragment(uint8 traitId) internal view returns (bytes memory) {
        bytes memory pal = punksData.paletteRgbaBytes();
        if (RotationPool.isRotation(uint16(traitId))) {
            // Rotation trait — pick a Punk for the current block from the
            // shared library and render its pixels. The Mosaic renderer
            // does the same via the same library, so the bytes match
            // within a block.
            uint16 picked = RotationPool.pick(uint16(traitId), block.number);
            bytes memory ip = punksData.indexedPixelsOf(picked);
            return _rlePunk(ip, pal);
        }
        if (traitId < 16) {
            // Type or HeadVariant: render the canonical Punk in full.
            bytes memory ip = punksData.indexedPixelsOf(_canonicalPunkId(traitId));
            return _rlePunk(ip, pal);
        } else if (traitId < 24) {
            // AttributeCount 0..7: render the N-of-7 dot strip.
            // Trait taxonomy exposes 8 count slots (0..7), but the max
            // attributes any Punk carries is 7, so the strip has 7 dots
            // and the count-7 trait fills all of them.
            return _renderCountDots(uint256(traitId) - 16);
        } else {
            // Accessory: diff canonical against its head-variant baseline.
            uint16 canonicalPunk = _canonicalPunkId(traitId);
            uint8 hv = punksData.headVariantOf(canonicalPunk);
            bytes memory canonical = punksData.indexedPixelsOf(canonicalPunk);
            bytes memory baseline =
                punksData.indexedPixelsOf(_canonicalPunkId(uint8(5 + hv)));
            return _rleDiff(canonical, baseline, pal);
        }
    }

    /// @dev Emit one `<rect>` per maximal horizontal run of same-colored
    ///      pixels in `ip` (24×24 indexed). Transparent palette entries
    ///      break runs and are skipped.
    function _rlePunk(bytes memory ip, bytes memory pal) internal pure returns (bytes memory out) {
        for (uint256 row = 0; row < PUNK_DIM; row++) {
            uint256 runStart = 0;
            uint8 runColor = 0;
            bool inRun = false;
            for (uint256 col = 0; col < PUNK_DIM; col++) {
                uint8 c = uint8(ip[row * PUNK_DIM + col]);
                uint8 alpha = uint8(pal[uint256(c) * 4 + 3]);
                bool opaque = alpha != 0;
                if (!opaque) {
                    if (inRun) {
                        out = abi.encodePacked(out, _emitPixelRun(runStart, col - 1, row, runColor, pal));
                        inRun = false;
                    }
                } else if (!inRun) {
                    runStart = col;
                    runColor = c;
                    inRun = true;
                } else if (c != runColor) {
                    out = abi.encodePacked(out, _emitPixelRun(runStart, col - 1, row, runColor, pal));
                    runStart = col;
                    runColor = c;
                }
            }
            if (inRun) {
                out = abi.encodePacked(out, _emitPixelRun(runStart, PUNK_DIM - 1, row, runColor, pal));
            }
        }
    }

    /// @dev Like `_rlePunk` but emits only pixels where `canonical`
    ///      differs from `baseline` AND canonical's color is opaque.
    function _rleDiff(bytes memory canonical, bytes memory baseline, bytes memory pal)
        internal pure returns (bytes memory out)
    {
        for (uint256 row = 0; row < PUNK_DIM; row++) {
            uint256 runStart = 0;
            uint8 runColor = 0;
            bool inRun = false;
            for (uint256 col = 0; col < PUNK_DIM; col++) {
                uint256 idx = row * PUNK_DIM + col;
                uint8 c = uint8(canonical[idx]);
                uint8 b = uint8(baseline[idx]);
                uint8 alpha = uint8(pal[uint256(c) * 4 + 3]);
                bool include = (c != b) && (alpha != 0);
                if (!include) {
                    if (inRun) {
                        out = abi.encodePacked(out, _emitPixelRun(runStart, col - 1, row, runColor, pal));
                        inRun = false;
                    }
                } else if (!inRun) {
                    runStart = col;
                    runColor = c;
                    inRun = true;
                } else if (c != runColor) {
                    out = abi.encodePacked(out, _emitPixelRun(runStart, col - 1, row, runColor, pal));
                    runStart = col;
                    runColor = c;
                }
            }
            if (inRun) {
                out = abi.encodePacked(out, _emitPixelRun(runStart, PUNK_DIM - 1, row, runColor, pal));
            }
        }
    }

    function _emitPixelRun(uint256 startCol, uint256 endCol, uint256 row, uint8 colorId, bytes memory pal)
        internal pure returns (bytes memory)
    {
        uint256 width = endCol - startCol + 1;
        uint256 paletteOffset = uint256(colorId) * 4;
        uint8 r = uint8(pal[paletteOffset]);
        uint8 g = uint8(pal[paletteOffset + 1]);
        uint8 b = uint8(pal[paletteOffset + 2]);
        return abi.encodePacked(
            '<rect x="', _u(startCol),
            '" y="', _u(row),
            '" width="', _u(width),
            '" height="1" fill="', _hexColor(r, g, b), '"/>'
        );
    }

    /// @dev Render a horizontal 7-slot dot strip with `count` filled. 7
    ///      is the maximum number of attributes any CryptoPunk carries,
    ///      so the count-7 trait fills all dots. `count == 0` (the bald
    ///      Aliens / Apes case) draws all 7 unfilled.
    function _renderCountDots(uint256 count) internal pure returns (bytes memory out) {
        uint256 dotSize = 2;
        uint256 gap = 1;
        uint256 totalDots = 7;
        uint256 totalW = totalDots * dotSize + (totalDots - 1) * gap;
        uint256 startX = (PUNK_DIM - totalW) / 2;
        uint256 yPos = (PUNK_DIM - dotSize) / 2;
        for (uint256 i = 0; i < totalDots; i++) {
            uint256 x = startX + i * (dotSize + gap);
            string memory color = i < count ? "#f5f5f5" : "#2a2a2a";
            out = abi.encodePacked(
                out,
                '<rect x="', _u(x),
                '" y="', _u(yPos),
                '" width="', _u(dotSize),
                '" height="', _u(dotSize),
                '" fill="', color, '"/>'
            );
        }
    }

    function _canonicalPunkId(uint8 traitId) internal pure returns (uint16) {
        bytes memory c = CANONICAL_IDS;
        uint256 offset = uint256(traitId) * 2;
        return (uint16(uint8(c[offset])) << 8) | uint16(uint8(c[offset + 1]));
    }

    function _hexColor(uint8 r, uint8 g, uint8 b) internal pure returns (string memory) {
        return SvgPrimitives.hexColor(r, g, b);
    }

    function _u(uint256 v) internal pure returns (string memory) {
        return SvgPrimitives.uintToString(v);
    }
}
