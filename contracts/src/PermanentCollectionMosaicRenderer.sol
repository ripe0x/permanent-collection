// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibString} from "solady/utils/LibString.sol";
import {Base64} from "solady/utils/Base64.sol";
import {DynamicBufferLib} from "solady/utils/DynamicBufferLib.sol";

import {PunkSvgFragmentCache} from "./PunkSvgFragmentCache.sol";
import {TraitIconCache} from "./TraitIconCache.sol";
import {RotationPool} from "./libraries/RotationPool.sol";
import {SvgPrimitives} from "./libraries/SvgPrimitives.sol";
import {IPunksData} from "./interfaces/IPunksData.sol";

interface IPermanentCollectionForMosaic {
    function collectedMask() external view returns (uint256);
    function collectedCount() external view returns (uint256);
    function isComplete() external view returns (bool);
    function pendingMask() external view returns (uint256);
    function acquisitionCount() external view returns (uint256);
    function firstVaultedPunk(uint8 traitId) external view returns (uint16 punkId, bool exists);
}

interface IPunkVaultForMosaic {
    function lockedPunkCount() external view returns (uint256);
}

interface IPCProofRenderer {
    function tokenURI(uint256 id) external view returns (string memory);
}

/// @title  PermanentCollectionMosaicRenderer
/// @notice Renderer that composes the artwork as a true mosaic of the
///         actual collected CryptoPunks, sourcing each tile from a public
///         `PunkSvgFragmentCache` rather than re-building each Punk from raw
///         pixels on every `tokenURI()` call.
///
///         For each of the 111 trait slots:
///         - Uncollected → a flat dim cell.
///         - Pending     → the uncollected look + trait icon, overlaid
///                          with a 1-px dashed border (a return auction is live).
///         - Collected, fragment cached    → the cached Punk tile rendered
///           inline, wrapped in `<g transform="translate(cx cy)">…</g>`.
///         - Collected, fragment uncached  → a clear marker cell with a
///           bordered outline so the viewer can tell the slot has been
///           filled but the tile hasn't been baked yet. **Never reverts**
///           — caching is an off-chain catch-up activity, not a precondition
///           of metadata.
///
///         Caching is permissionless. Anyone can call
///         `cacheTrait(traitId)` once a trait has been Vaulted to bake the
///         responsible Punk's fragment into the public cache.
///
///         The renderer holds no state of its own. It is replaceable via
///         `RendererRegistry.setImplementation` until the registry is
///         frozen.
contract PermanentCollectionMosaicRenderer {
    using LibString for uint256;
    using DynamicBufferLib for DynamicBufferLib.DynamicBuffer;

    /// @notice Reverts if `cacheTrait` is called for a trait that has not
    ///         yet been collected (no first-vaulted Punk to derive from).
    error TraitNotCollected(uint8 traitId);
    /// @notice Reverts on `tokenURI(uint256 id)` for any id other than 1.
    error UnknownTokenId(uint256 id);

    /// @notice Records-only protocol core. Read for `collectedMask`,
    ///         `pendingMask`, `collectedCount`, `isComplete`,
    ///         `acquisitionCount`, and per-trait `firstVaultedPunk`.
    IPermanentCollectionForMosaic public immutable collection;
    /// @notice Permanent custodian. Read for `lockedPunkCount` when
    ///         producing title-token metadata via `tokenURI(uint256)`.
    IPunkVaultForMosaic public immutable vault;
    /// @notice Public Punk-tile cache. Read for `isCached(punkId)` and
    ///         `fragmentOf(punkId)` per collected trait.
    PunkSvgFragmentCache public immutable punkSvgCache;
    /// @notice Sealed pixel + palette source. Read at render time to
    ///         compose the trait-icon overlay drawn on each uncollected
    ///         and pending cell. Pinned at construction; `datasetHash`
    ///         is asserted by `PermanentCollection`.
    IPunksData public immutable punksData;
    /// @notice Public trait-icon cache. Read for `isCached(traitId)` and
    ///         `fragmentOf(traitId)` per uncollected/pending cell.
    ///         Permissionless, immutable, deploy-time empty — anyone can
    ///         pay gas to bake a trait into it. When unset for a trait,
    ///         `_traitIconContent` falls back to on-the-fly compute from
    ///         PunksData. Pinned at construction.
    TraitIconCache public immutable traitIconCache;
    /// @notice Dedicated renderer for Proof token ids (0..110). Mosaic
    ///         renderer dispatches `tokenURI(id)` to this contract for
    ///         every id in the Proof range. Pinned at construction;
    ///         swappable only by re-registering the Mosaic renderer
    ///         with a different proof renderer at registry-set time.
    IPCProofRenderer public immutable proofRenderer;

    uint256 private constant TOTAL_TRAITS = 111;
    uint256 private constant PUNK_DIM = 24;
    uint256 private constant COLS = 11;
    uint256 private constant ROWS = 10;            // main grid; 11th "row" is a single pulled-out cell
    uint256 private constant CELL = 28;            // 24 px punk + 4 px gap
    uint256 private constant PAD = 24;             // outer padding
    uint256 private constant GRID_W = COLS * CELL; // 308
    uint256 private constant GRID_H = ROWS * CELL; // 280
    uint256 private constant WIDTH = GRID_W + PAD * 2; // 356
    /// @dev Square canvas. The bottom 28 px slot holds the two-line
    ///      inscription (bottom-left) and the pulled-out "final type"
    ///      cell (bottom-right), both vertically aligned with each other.
    uint256 private constant HEIGHT = WIDTH;
    /// @dev Position of the pulled-out cell (bottom-right of the canvas).
    ///      x = PAD + (COLS-1)*CELL + 2 = 24 + 280 + 2 = 306;
    ///      y = PAD + ROWS*CELL + 2     = 24 + 280 + 2 = 306.
    uint256 private constant PULLED_CELL_X = 306;
    uint256 private constant PULLED_CELL_Y = 306;
    /// @dev The "final type" pulled out of the grid: NormalizedType 4
    ///      (Zombie). Trait taxonomy: types 0..4 = Alien, Ape, Female,
    ///      Male, Zombie. The remaining four types (0..3) stay in the
    ///      main grid's last row.
    uint16 private constant PULLED_TRAIT_ID = 4;
    /// @dev Output scale for the root SVG `width`/`height` attributes.
    ///      The `viewBox` stays at `WIDTH × HEIGHT` so coordinate space
    ///      and every cached fragment remain unchanged — only the
    ///      intrinsic raster size changes. Browsers rasterize SVGs at
    ///      their intrinsic size when copying to clipboard, so a small
    ///      intrinsic dimension yields a low-resolution paste. 8× of
    ///      the 356×356 canvas yields 2848×2848 — high enough that a
    ///      right-click "Copy Image" produces a print- and social-share
    ///      friendly raster. Display sizing in the frontend or on
    ///      marketplaces is unaffected (both constrain via container
    ///      CSS, which overrides intrinsic dims at display time).
    uint256 private constant OUTPUT_SCALE = 8;
    uint256 private constant OUTPUT_WIDTH = WIDTH * OUTPUT_SCALE;   // 2848
    uint256 private constant OUTPUT_HEIGHT = HEIGHT * OUTPUT_SCALE; // 2848

    string private constant BG_COLOR = "#000";
    string private constant TEXT_COLOR = "#f5f5f5";
    /// @dev Background for an uncollected trait cell. Visually flat.
    string private constant UNCOLLECTED_COLOR = "#1c1c1c";
    /// @dev Dashed-border stroke for a pending trait cell (an in-Final-
    ///      Sale Punk carries the trait but has not yet entered the
    ///      vault). The cell's background fill stays UNCOLLECTED_COLOR;
    ///      pending is communicated by overlaying a 1-px dashed border
    ///      in this color around the otherwise-uncollected tile.
    string private constant PENDING_STROKE = "#454545";
    /// @dev Background color for cells whose trait is permanently
    ///      collected. Drawn behind the vaulted Punk fragment so the
    ///      transparent pixels around the Punk read as a unified
    ///      "collection tile" swatch instead of falling through to
    ///      BG_COLOR.
    string private constant COLLECTED_COLOR = "#8F918B";
    string private constant DIM_TEXT = "#6a6a6a";

    /// @dev 5×7 monospace pixel font. Kept inline (rather than imported) so
    ///      the renderer is self-contained. Order: space, '0'..'9', '/',
    ///      A C D E F I L M N O P R S T U.
    bytes private constant GLYPHS =
        hex"00000000000000"  // ( 0) space
        hex"0E11131519110E"  // ( 1) 0
        hex"040C040404040E"  // ( 2) 1
        hex"0E11010204081F"  // ( 3) 2
        hex"1E01010E01011E"  // ( 4) 3
        hex"1111111F010101"  // ( 5) 4
        hex"1F10101E01011E"  // ( 6) 5
        hex"0E11101E11110E"  // ( 7) 6
        hex"1F010204080808"  // ( 8) 7
        hex"0E11110E11110E"  // ( 9) 8
        hex"0E11110F01110E"  // (10) 9
        hex"01010204081010"  // (11) /
        hex"0E11111F111111"  // (12) A
        hex"0F10101010100F"  // (13) C
        hex"1E11111111111E"  // (14) D
        hex"1F10101E10101F"  // (15) E
        hex"1F10101E101010"  // (16) F
        hex"1F04040404041F"  // (17) I
        hex"1010101010101F"  // (18) L
        hex"111B1511111111"  // (19) M
        hex"11111915131111"  // (20) N
        hex"0E11111111110E"  // (21) O
        hex"1E11111E101010"  // (22) P
        hex"1E11111E141211"  // (23) R
        hex"0F10100E01011E"  // (24) S
        hex"1F040404040404"  // (25) T
        hex"1111111111110E"; // (26) U

    /// @dev Canonical exemplar Punk-id per trait, packed 2 bytes per id.
    ///      Index 0..110 = trait id. Used to source the trait visual
    ///      drawn on uncollected and pending cells. Pinned against the
    ///      on-chain trait taxonomy at the same datasetHash — the table
    ///      never changes.
    bytes private constant CANONICAL_IDS =
        hex"0c1c09bb0002000608120b4a0174089c041a0281195702e501fe01190ceb067a"
        hex"01190002000100000004002302f3209c0225005d015807ac06cd035f00600366"
        hex"1532011002460087212b005907f90cd7061a12d1014f17cb018d0014001a0006"
        hex"01180012003700b20b74068d1da4015103bd03800ff0002b0a600039003618c3"
        hex"008c002f169401b4002c007101430069098d1c43148e0ad00b6f061600f90021"
        hex"04d003460fb51851008601ac015a075b0024027523b900b700381bc714f0102f"
        hex"031e00bb006a01a1001f004202c2035315ca02a90132071d00f100020019";

    constructor(
        address _collection,
        address _vault,
        address _punkSvgCache,
        address _punksData,
        address _traitIconCache,
        address _proofRenderer
    ) {
        require(_collection != address(0), "MosaicRenderer: zero collection");
        require(_vault != address(0), "MosaicRenderer: zero vault");
        require(_punkSvgCache != address(0), "MosaicRenderer: zero cache");
        require(_punksData != address(0), "MosaicRenderer: zero punksData");
        require(_traitIconCache != address(0), "MosaicRenderer: zero traitIconCache");
        require(_proofRenderer != address(0), "MosaicRenderer: zero proofRenderer");
        PunkSvgFragmentCache psc = PunkSvgFragmentCache(_punkSvgCache);
        TraitIconCache tic = TraitIconCache(_traitIconCache);
        require(address(psc.punksData()) == _punksData, "MosaicRenderer: punk cache data mismatch");
        require(address(tic.punksData()) == _punksData, "MosaicRenderer: trait cache data mismatch");

        collection = IPermanentCollectionForMosaic(_collection);
        vault = IPunkVaultForMosaic(_vault);
        punkSvgCache = psc;
        punksData = IPunksData(_punksData);
        traitIconCache = tic;
        proofRenderer = IPCProofRenderer(_proofRenderer);
    }

    // ────────── public renderer surface ──────────

    /// @notice ERC20-flavored zero-arg metadata. Used by the artcoins
    ///         ERC20 `tokenURI()` passthrough. The ERC20's symbol is "111".
    function tokenURI() external view returns (string memory) {
        return _collectionJson("111");
    }

    /// @notice ERC-7572 contract-level (collection) metadata. Returns the
    ///         collection envelope — name "PERMANENT COLLECTION", the live
    ///         mosaic image, and N-of-111 progress. Both the PunkVault ERC721
    ///         collection page (`PunkVault.contractURI()` → `token` = the
    ///         vault) and the artcoins ERC20 (`token` = the ERC20) read it, so
    ///         the `symbol` field is keyed off the caller: "PERMANENTCOLLECTION"
    ///         for the NFT collection, "111" for the ERC20.
    function contractURI(address token) external view returns (string memory) {
        return _collectionJson(token == address(vault) ? "PERMANENTCOLLECTION" : "111");
    }

    /// @notice ERC721 metadata for any PunkVault-issued token.
    ///         Dispatches by id:
    ///           - `0 ≤ id ≤ 110`       → the corresponding Proof
    ///                                    (delegated to `proofRenderer`;
    ///                                    `tokenId == traitId` directly,
    ///                                    matching the PunksData taxonomy)
    ///           - `id == 111`          → the Title (one-of-one, this contract)
    ///           - else                 → `UnknownTokenId`
    /// @dev    Reverts on any id ≥ 112 so stale marketplace polls don't
    ///         silently produce wrong data. PunkVault gates on `ownerOf`
    ///         before forwarding, so an unminted but in-range id never
    ///         reaches this dispatch from the canonical entry point.
    function tokenURI(uint256 id) external view returns (string memory) {
        if (id <= 110) return proofRenderer.tokenURI(id);
        if (id == 111) return _tokenURITitle();
        revert UnknownTokenId(id);
    }

    /// @notice Raw SVG payload. Useful for off-chain tools that don't want
    ///         the JSON envelope.
    function svg() external view returns (string memory) {
        return _renderSvg(
            collection.collectedMask(),
            collection.pendingMask(),
            collection.collectedCount()
        );
    }

    // ────────── caching helpers ──────────

    /// @notice Bake the cached fragment for `traitId`'s first vaulted
    ///         Punk into the public cache. Permissionless. Reverts
    ///         `TraitNotCollected` if the trait has not yet entered the
    ///         vault.
    /// @return pointer The SSTORE2 storage-contract address holding the
    ///                 cached fragment.
    function cacheTrait(uint8 traitId) external returns (address pointer) {
        (uint16 punkId, bool exists) = collection.firstVaultedPunk(traitId);
        if (!exists) revert TraitNotCollected(traitId);
        return punkSvgCache.cachePunk(punkId);
    }

    /// @notice True iff `traitId` is collected AND its first vaulted Punk
    ///         has a cached fragment. Returns false for uncollected
    ///         traits (so callers don't have to check existence first).
    function isTraitCached(uint8 traitId) external view returns (bool) {
        (uint16 punkId, bool exists) = collection.firstVaultedPunk(traitId);
        if (!exists) return false;
        return punkSvgCache.isCached(punkId);
    }

    /// @notice Convenience wrapper around `collection.firstVaultedPunk`
    ///         — returns the Punk responsible for `traitId`'s entry into
    ///         the collection, or `(0, false)` if uncollected.
    function cachedPunkForTrait(uint8 traitId) external view returns (uint16 punkId, bool exists) {
        return collection.firstVaultedPunk(traitId);
    }

    // ────────── JSON envelopes ──────────

    function _collectionJson(string memory symbol) internal view returns (string memory) {
        uint256 mask = collection.collectedMask();
        uint256 pending = collection.pendingMask();
        uint256 count = collection.collectedCount();

        string memory image = _imageDataUri(mask, pending, count);
        uint256 vaulted = vault.lockedPunkCount();

        // Outer envelope is base64-encoded JSON (`data:application/json;base64,`),
        // the OpenSea-documented form. The inner `image` is a base64 SVG data
        // URI, so the metadata carries no unescaped characters.
        string memory json = string.concat(
            '{"name":"PERMANENT COLLECTION",',
            '"symbol":"', symbol, '",',
            '"description":"PERMANENT COLLECTION is an ERC20 artwork built to assemble a permanent ',
            'CryptoPunks collection representing all 111 collectable traits. Collected Punks are ',
            'held in an immutable contract and can never be withdrawn.",',
            '"image":"', image, '",',
            '"attributes":[',
                '{"trait_type":"Traits Collected","value":', count.toString(), '},',
                '{"trait_type":"Traits Total","value":111},',
                '{"trait_type":"Punks Vaulted","value":', vaulted.toString(), '}',
            ']}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _tokenURITitle() internal view returns (string memory) {
        uint256 mask = collection.collectedMask();
        uint256 pending = collection.pendingMask();
        uint256 count = collection.collectedCount();
        bool complete = collection.isComplete();

        string memory image = _imageDataUri(mask, pending, count);
        string memory attrs = _titleAttributes(count, complete);

        // Same base64 JSON envelope as the zero-arg path.
        string memory json = string.concat(
            '{"name":"PERMANENT COLLECTION Vault Title","description":"',
            'Title to the PERMANENT COLLECTION vault. The vault is the immutable contract ',
            'that holds the collected CryptoPunks. Owning this token ',
            'records its holder as the title owner of the vault and grants no ',
            'claim on the Punks, no withdrawal rights, and no administrative control.',
            '","image":"',
            image,
            '","attributes":',
            attrs,
            '}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _imageDataUri(uint256 mask, uint256 pending, uint256 count)
        internal view returns (string memory)
    {
        return string.concat(
            "data:image/svg+xml;base64,",
            Base64.encode(bytes(_renderSvg(mask, pending, count)))
        );
    }

    function _titleAttributes(uint256 collected, bool complete)
        internal view returns (string memory)
    {
        uint256 vaulted = vault.lockedPunkCount();
        string memory completeStr = complete ? "Yes" : "No";

        return string.concat(
            '[',
            '{"trait_type":"Punks Vaulted","value":', vaulted.toString(), '},',
            '{"trait_type":"Traits Collected","value":', collected.toString(), '},',
            '{"trait_type":"Traits Total","value":111},',
            '{"trait_type":"Collection Complete","value":"', completeStr, '"}',
            ']'
        );
    }

    // ────────── Test / inspection surface ──────────

    /// @notice Public view exposing the same per-cell trait-icon content
    ///         the renderer composes internally. Used by tests and
    ///         off-chain inspection tools to verify that the cache's
    ///         baked bytes match what this renderer would produce on
    ///         the fly. Pre-fetches palette + baselines fresh on each
    ///         call so a single trait can be checked without rendering
    ///         the whole mosaic.
    ///
    /// @dev    **Cross-contract identity invariant**: for every valid `t`,
    ///         `this.traitIconBytes(t) == traitIconCache.buildFragment(t)`.
    ///         Two parallel implementations exist (one here for on-the-fly
    ///         fallback, one in `TraitIconCache` for the bake). If either
    ///         drifts, the renderer flips between cached and uncached
    ///         visuals for the same trait. Enforced by the test
    ///         `PermanentCollectionMosaicRenderer.t.sol::
    ///         test_AllTraits_RendererOnTheFly_MatchesCacheBuild`, which
    ///         iterates all 111 traits on a fresh-cache fixture.
    ///
    /// @param  traitId 0..110. Reverts otherwise.
    /// @return The exact bytes that `_traitIconContent` would return
    ///         when composing this cell.
    function traitIconBytes(uint16 traitId) external view returns (bytes memory) {
        require(traitId < TOTAL_TRAITS, "MosaicRenderer: bad traitId");
        bytes memory pal = punksData.paletteRgbaBytes();
        bytes[] memory baselines = new bytes[](11);
        for (uint16 i = 0; i < 11; i++) {
            baselines[i] = punksData.indexedPixelsOf(_canonicalPunkId(uint16(5 + i)));
        }
        return _traitIconContent(traitId, pal, baselines);
    }

    // ────────── Trait-icon helpers ──────────

    /// @dev Lookup the canonical exemplar Punk for a trait. Returns the
    ///      Punk-id that the trait taxonomy assigns as the visual
    ///      representative of `traitId`.
    function _canonicalPunkId(uint16 traitId) internal pure returns (uint16) {
        require(traitId < TOTAL_TRAITS, "MosaicRenderer: bad traitId");
        bytes memory c = CANONICAL_IDS;
        uint256 offset = uint256(traitId) * 2;
        return (uint16(uint8(c[offset])) << 8) | uint16(uint8(c[offset + 1]));
    }

    // Rotation logic for the six "rare type" trait ids
    // {0, 1, 4, 5, 6, 15} — Alien/Ape/Zombie types and their matching
    // head variants — is encapsulated in the `RotationPool` library
    // (`src/libraries/RotationPool.sol`). `TraitIconCache` reads from
    // the same library so the cache's rotation-aware `buildFragment`
    // and the renderer's `_traitIconContent` stay in lockstep without
    // duplicating the pool data.

    /// @dev Compose the trait visual for an uncollected/pending cell.
    ///
    ///      Cache-first design:
    ///        Step 1 — consult `traitIconCache`. If the trait is baked,
    ///                 return the stored fragment immediately. One SLOAD
    ///                 in the cache + one SSTORE2.read; ~50k gas total.
    ///        Step 2 — fall through to on-the-fly compute from PunksData.
    ///                 Three branches:
    ///                   Type / HeadVariant (traitIdx < 16) → full
    ///                     canonical Punk (a bare head IS the trait).
    ///                   AttributeCount (traitIdx 16..23) → N-of-7 dot
    ///                     strip (7 = max attributes any Punk carries).
    ///                   Accessory (traitIdx 24..110) → canonical-vs-
    ///                     head-variant-baseline pixel diff.
    ///
    ///      The cache is immutable but starts empty at launch — anyone
    ///      can pay gas to permissionlessly bake a trait via
    ///      `TraitIconCache.cacheTrait(id)`. As bakes accumulate,
    ///      `tokenURI()` gas drops from ~500M (empty state, all
    ///      on-the-fly) toward ~50M (full bake, all cached) without any
    ///      team coordination.
    function _traitIconContent(
        uint16 traitId,
        bytes memory pal,
        bytes[] memory baselines
    ) internal view returns (bytes memory) {
        // Rotation pool short-circuit: traits {0, 1, 4, 5, 6, 15} cycle
        // per block, so the cache can't help (cached bytes would go
        // stale every ~12s). Always recompute on-the-fly. The picked
        // Punk's full pixels are drawn — same `_rlePunk` path the
        // canonical branch would take, just with a different id.
        if (RotationPool.isRotation(traitId)) {
            uint16 picked = RotationPool.pick(traitId, block.number);
            return _rlePunk(punksData.indexedPixelsOf(picked), pal);
        }
        // Cache fast path. Falls through on uncached without reverting.
        uint8 t8 = uint8(traitId);
        if (traitIconCache.isCached(t8)) {
            return traitIconCache.fragmentOf(t8);
        }
        // On-the-fly fallback.
        if (traitId < 16) {
            bytes memory ip = punksData.indexedPixelsOf(_canonicalPunkId(traitId));
            return _rlePunk(ip, pal);
        } else if (traitId < 24) {
            return _renderCountDots(uint256(traitId) - 16);
        } else {
            uint16 canonicalPunk = _canonicalPunkId(traitId);
            uint8 hv = punksData.headVariantOf(canonicalPunk);
            bytes memory canonical = punksData.indexedPixelsOf(canonicalPunk);
            return _rleDiff(canonical, baselines[hv], pal);
        }
    }

    /// @dev Emit one <rect> per maximal horizontal run of same-colored
    ///      pixels in `ip` (24×24 indexed). Transparent palette entries
    ///      break runs and are skipped. Uses DynamicBuffer rather than
    ///      `out = abi.encodePacked(out, X)` accumulation so the inner
    ///      loop is O(n) in memory, not O(n²); also a major win at
    ///      compile time under via_ir (an inlined accumulator pattern is
    ///      a meaningful contributor to the unified Yul IR).
    function _rlePunk(bytes memory ip, bytes memory pal) internal pure returns (bytes memory) {
        DynamicBufferLib.DynamicBuffer memory buf;
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
                        buf.p(_emitPixelRun(runStart, col - 1, row, runColor, pal));
                        inRun = false;
                    }
                } else if (!inRun) {
                    runStart = col;
                    runColor = c;
                    inRun = true;
                } else if (c != runColor) {
                    buf.p(_emitPixelRun(runStart, col - 1, row, runColor, pal));
                    runStart = col;
                    runColor = c;
                }
            }
            if (inRun) {
                buf.p(_emitPixelRun(runStart, PUNK_DIM - 1, row, runColor, pal));
            }
        }
        return buf.data;
    }

    /// @dev Like `_rlePunk` but emits only pixels where `canonical` differs
    ///      from `baseline` AND canonical's color is opaque. Used to isolate
    ///      accessory pixels by diffing against the bald head variant.
    ///      Uses DynamicBuffer (see `_rlePunk` for rationale).
    function _rleDiff(bytes memory canonical, bytes memory baseline, bytes memory pal)
        internal pure returns (bytes memory)
    {
        DynamicBufferLib.DynamicBuffer memory buf;
        for (uint256 row = 0; row < PUNK_DIM; row++) {
            uint256 runStart = 0;
            uint8 runColor = 0;
            bool inRun = false;
            for (uint256 col = 0; col < PUNK_DIM; col++) {
                uint256 idx = row * PUNK_DIM + col;
                uint8 c = uint8(canonical[idx]);
                uint8 b = uint8(baseline[idx]);
                uint8 alpha = uint8(pal[uint256(c) * 4 + 3]);
                bool sameAsBaseline = c == b;
                bool opaque = alpha != 0;
                bool include = !sameAsBaseline && opaque;
                if (!include) {
                    if (inRun) {
                        buf.p(_emitPixelRun(runStart, col - 1, row, runColor, pal));
                        inRun = false;
                    }
                } else if (!inRun) {
                    runStart = col;
                    runColor = c;
                    inRun = true;
                } else if (c != runColor) {
                    buf.p(_emitPixelRun(runStart, col - 1, row, runColor, pal));
                    runStart = col;
                    runColor = c;
                }
            }
            if (inRun) {
                buf.p(_emitPixelRun(runStart, PUNK_DIM - 1, row, runColor, pal));
            }
        }
        return buf.data;
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
            '<rect x="', startCol.toString(),
            '" y="', row.toString(),
            '" width="', width.toString(),
            '" height="1" fill="', _hexColor(r, g, b), '"/>'
        );
    }

    /// @dev Render a horizontal 7-slot dot strip with `count` filled.
    ///      Visual placeholder for AttributeCount traits (0..7). 7 is
    ///      the maximum number of attributes any CryptoPunk carries, so
    ///      the count-7 trait fills all dots.
    function _renderCountDots(uint256 count) internal pure returns (bytes memory) {
        uint256 dotSize = 2;
        uint256 gap = 1;
        uint256 totalDots = 7;
        uint256 totalW = totalDots * dotSize + (totalDots - 1) * gap; // 20
        uint256 startX = (PUNK_DIM - totalW) / 2;
        uint256 yPos = (PUNK_DIM - dotSize) / 2;
        DynamicBufferLib.DynamicBuffer memory buf;
        for (uint256 i = 0; i < totalDots; i++) {
            uint256 x = startX + i * (dotSize + gap);
            string memory color = i < count ? "#f5f5f5" : "#2a2a2a";
            buf.p(
                abi.encodePacked(
                    '<rect x="', x.toString(),
                    '" y="', yPos.toString(),
                    '" width="', dotSize.toString(),
                    '" height="', dotSize.toString(),
                    '" fill="', color, '"/>'
                )
            );
        }
        return buf.data;
    }

    function _hexColor(uint8 r, uint8 g, uint8 b) internal pure returns (string memory) {
        return SvgPrimitives.hexColor(r, g, b);
    }

    // ────────── SVG composition ──────────

    function _renderSvg(uint256 mask, uint256 pending, uint256 count)
        internal view returns (string memory)
    {
        DynamicBufferLib.DynamicBuffer memory buf;
        // Reserve ~512KB up front. Avoids most doubling reallocs for a
        // near-full-set render. The buffer can still grow if needed.
        buf = buf.reserve(0x80000);

        // Root SVG: large intrinsic `width`/`height` for high-quality
        // "Copy Image" raster export (browsers rasterize at intrinsic
        // size, not displayed size). `viewBox` stays at the design
        // coordinates so every child rect's geometry is unchanged. The
        // black background is emitted as a `<rect>` (not a CSS `style=
        // background:`) so it survives `<img>` rendering and clipboard
        // rasterization — CSS backgrounds on the root SVG element only
        // render when the SVG is inlined into HTML, not when loaded as
        // an image or pasted from clipboard.
        buf.p(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" width="', OUTPUT_WIDTH.toString(),
                '" height="', OUTPUT_HEIGHT.toString(),
                '" viewBox="0 0 ', WIDTH.toString(), ' ', HEIGHT.toString(),
                '" shape-rendering="crispEdges">',
                '<rect width="100%" height="100%" fill="', BG_COLOR, '"/>'
            )
        );

        // Pre-fetch palette + the 11 head-variant baselines once per
        // render. The trait-icon overlay on every uncollected/pending
        // cell reads from both; computing them inside the loop would
        // multiply RPC reads by ~111.
        bytes memory pal = punksData.paletteRgbaBytes();
        bytes[] memory baselines = new bytes[](11);
        for (uint16 i = 0; i < 11; i++) {
            baselines[i] = punksData.indexedPixelsOf(_canonicalPunkId(uint16(5 + i)));
        }

        for (uint256 pos = 0; pos < COLS * ROWS; pos++) {
            uint16 traitId = _traitAt(pos);
            uint256 col = pos % COLS;
            uint256 row = pos / COLS;
            uint256 cx = PAD + col * CELL + 2;
            uint256 cy = PAD + row * CELL + 2;
            bool collected = ((mask >> traitId) & 1) == 1;
            bool isPending = !collected && ((pending >> traitId) & 1) == 1;
            _appendCell(buf, traitId, cx, cy, collected, isPending, pal, baselines);
        }
        // The "final type" cell, rendered as a single tile beneath the
        // main grid's bottom-left corner.
        {
            bool pulledCollected = ((mask >> PULLED_TRAIT_ID) & 1) == 1;
            bool pulledPending = !pulledCollected && ((pending >> PULLED_TRAIT_ID) & 1) == 1;
            _appendCell(
                buf, PULLED_TRAIT_ID, PULLED_CELL_X, PULLED_CELL_Y, pulledCollected, pulledPending, pal, baselines
            );
        }

        buf.p(_renderFooter(count));
        buf.p(bytes("</svg>"));
        return string(buf.data);
    }

    /// @dev Map a main-grid position (0..109) to a trait id. The 11×10
    ///      grid packs the trait sections continuously, with no filler
    ///      gaps; the "final type" (trait 4 / Zombie) is rendered
    ///      separately as the pulled-out cell beneath the grid.
    ///
    ///        rows 0..6  cols 0..10  (pos   0..76)  accessories 24..100   (77 cells)
    ///        row  7     cols 0..9   (pos  77..86)  accessories 101..110  (10 cells)
    ///        row  7     col  10     (pos      87)  attribute count 16    ( 1 cell)
    ///        row  8     cols 0..6   (pos  88..94)  attribute counts 17..23 (7 cells)
    ///        row  8     cols 7..10  (pos  95..98)  head variants 5..8    ( 4 cells)
    ///        row  9     cols 0..6   (pos  99..105) head variants 9..15   ( 7 cells)
    ///        row  9     cols 7..10  (pos 106..109) types 0..3            ( 4 cells)
    ///        — pulled out beneath grid — type 4 (Zombie)
    function _traitAt(uint256 pos) internal pure returns (uint16 traitId) {
        if (pos < 87)  return uint16(24 + pos);             // accessories 24..110 (pos 0..86)
        if (pos < 95)  return uint16(16 + (pos - 87));      // attribute counts 16..23 (pos 87..94)
        if (pos < 106) return uint16(5 + (pos - 95));       // head variants 5..15 (pos 95..105)
        return uint16(pos - 106);                            // types 0..3 (pos 106..109)
    }

    /// @dev Append the 24×24 cell for `traitId` at the given canvas
    ///      coordinates. Four branches:
    ///        collected + cached   → fragment wrapped in <g translate>
    ///        collected + uncached → live-built fragment wrapped in <g translate>
    ///        pending              → uncollected background + trait icon + dashed border overlay
    ///        uncollected          → uncollected background + trait icon
    function _appendCell(
        DynamicBufferLib.DynamicBuffer memory buf,
        uint16 traitId,
        uint256 cx,
        uint256 cy,
        bool collected,
        bool isPending,
        bytes memory pal,
        bytes[] memory baselines
    ) internal view {
        if (!collected) {
            _appendFlatCell(buf, cx, cy, UNCOLLECTED_COLOR);
            // Trait visual: rendered in a 24×24 local coordinate system,
            // translated to the cell's top-left so the icon sits inside
            // the background rect we just drew.
            buf.p(
                abi.encodePacked(
                    '<g transform="translate(', cx.toString(), ' ', cy.toString(), ')">',
                    _traitIconContent(traitId, pal, baselines),
                    '</g>'
                )
            );
            if (isPending) _appendDashedBorder(buf, cx, cy);
            return;
        }

        (uint16 punkId, bool exists) = collection.firstVaultedPunk(uint8(traitId));
        // `exists` is always true when `collected` is true (the collection
        // contract sets both atomically). Defensively fall through to the
        // uncollected styling if it ever isn't — keeps the renderer
        // strictly total over its inputs.
        if (!exists) {
            _appendFlatCell(buf, cx, cy, UNCOLLECTED_COLOR);
            return;
        }

        // Lay a COLLECTED_COLOR swatch under the Punk fragment so the
        // transparent pixels around the head/hat read as the collection
        // tile color instead of falling through to BG_COLOR.
        _appendFlatCell(buf, cx, cy, COLLECTED_COLOR);

        // Fast path: cached SSTORE2 read.
        // Slow path: live re-derivation from PunksData (no placeholder).
        // Both produce byte-identical fragments by the cache's identity
        // invariant. The view's gas budget grows with how many cells
        // are uncached; see PunkSvgFragmentCache.buildFragment NatSpec.
        bytes memory frag = punkSvgCache.isCached(punkId)
            ? punkSvgCache.fragmentOf(punkId)
            : punkSvgCache.buildFragment(punkId);
        buf.p(
            abi.encodePacked(
                '<g transform="translate(', cx.toString(), ' ', cy.toString(), ')">'
            )
        );
        buf.p(frag);
        buf.p(bytes("</g>"));
    }

    function _appendFlatCell(
        DynamicBufferLib.DynamicBuffer memory buf,
        uint256 cx,
        uint256 cy,
        string memory fill
    ) internal pure {
        buf.p(
            abi.encodePacked(
                '<rect x="', cx.toString(),
                '" y="', cy.toString(),
                '" width="', PUNK_DIM.toString(),
                '" height="', PUNK_DIM.toString(),
                '" fill="', fill, '"/>'
            )
        );
    }

    /// @dev Overlay a 1-px dashed PENDING_STROKE border on the pixel
    ///      ring immediately OUTSIDE a 24×24 cell at `(cx, cy)`. Used
    ///      to mark a pending trait cell — the underlying fill + trait
    ///      icon are drawn as for an uncollected tile; this stroke is
    ///      the only visual difference.
    ///
    ///      For pixel-perfect adjacency (no gap between cell and
    ///      stroke under shape-rendering="crispEdges"), the stroke
    ///      rect is positioned at `(cx-0.5, cy-0.5)` with size 25×25.
    ///      That places the stroke center on integer-pixel-edges so
    ///      the 1-px stroke snaps unambiguously to the single pixel
    ///      directly adjacent to the cell on each side, instead of
    ///      to a half-pixel that rounds outward.
    function _appendDashedBorder(
        DynamicBufferLib.DynamicBuffer memory buf,
        uint256 cx,
        uint256 cy
    ) internal pure {
        // Emit "<cx-1>.5" / "<cy-1>.5" for the half-pixel offset and
        // use a 25×25 stroke rect (PUNK_DIM + 1) so the rect's edges
        // sit on the pixel boundary 1 px outside the cell.
        buf.p(
            abi.encodePacked(
                '<rect x="', (cx - 1).toString(), '.5',
                '" y="', (cy - 1).toString(), '.5',
                '" width="', (PUNK_DIM + 1).toString(),
                '" height="', (PUNK_DIM + 1).toString(),
                '" fill="none" stroke="', PENDING_STROKE,
                '" stroke-dasharray="2 2"/>'
            )
        );
    }

    // ────────── footer ──────────

    function _renderFooter(uint256 count) internal pure returns (bytes memory) {
        string memory progress = string.concat(count.toString(), " / 111");
        // The two lines sit in the bottom-left of the canvas, vertically
        // aligned with the pulled-out cell on the right (which spans
        // y=306..330). Glyphs are 5×7 with a 6-px advance per char.
        //
        // Progress is the top (dim) row; the "PERMANENT COLLECTION"
        // headline is the bottom (bright) row. Inscription left edge is
        // fixed at x=26 (same left margin as the grid cells). Worst-case
        // headline string is "PERMANENT COLLECTION" (20 chars, last
        // pixel at 26 + 19*6 + 4 = 144) — well clear of the pulled-out
        // cell at x=306, with 162 px of slack.
        uint256 textX = 26;
        uint256 progressY = 312;
        uint256 headlineY = 323;
        return abi.encodePacked(
            _renderPixelText(progress, textX, progressY, DIM_TEXT),
            _renderPixelText("PERMANENT COLLECTION", textX, headlineY, TEXT_COLOR)
        );
    }

    function _renderPixelText(string memory text, uint256 x0, uint256 y0, string memory color)
        internal pure returns (bytes memory)
    {
        bytes memory t = bytes(text);
        DynamicBufferLib.DynamicBuffer memory buf;
        for (uint256 i = 0; i < t.length; i++) {
            uint256 cx = x0 + i * 6;
            uint256 base = uint256(_glyphIndex(uint8(t[i]))) * 7;
            for (uint256 row = 0; row < 7; row++) {
                uint8 bits = uint8(GLYPHS[base + row]);
                if (bits == 0) continue;
                uint256 runStart = 0;
                bool inRun = false;
                for (uint256 col = 0; col < 5; col++) {
                    bool on = ((bits >> (4 - col)) & 1) == 1;
                    if (on && !inRun) {
                        runStart = col;
                        inRun = true;
                    } else if (!on && inRun) {
                        buf.p(_emitTextRun(cx + runStart, y0 + row, col - runStart, color));
                        inRun = false;
                    }
                }
                if (inRun) {
                    buf.p(_emitTextRun(cx + runStart, y0 + row, 5 - runStart, color));
                }
            }
        }
        return buf.data;
    }

    function _emitTextRun(uint256 x, uint256 y, uint256 width, string memory color)
        internal pure returns (bytes memory)
    {
        return abi.encodePacked(
            '<rect x="', x.toString(),
            '" y="', y.toString(),
            '" width="', width.toString(),
            '" height="1" fill="', color, '"/>'
        );
    }

    function _glyphIndex(uint8 c) internal pure returns (uint8) {
        if (c == 0x20) return 0;                            // space
        if (c >= 0x30 && c <= 0x39) return 1 + (c - 0x30);  // 0..9
        if (c == 0x2F) return 11;                            // /
        if (c == 0x41) return 12;                            // A
        if (c == 0x43) return 13;                            // C
        if (c == 0x44) return 14;                            // D
        if (c == 0x45) return 15;                            // E
        if (c == 0x46) return 16;                            // F
        if (c == 0x49) return 17;                            // I
        if (c == 0x4C) return 18;                            // L
        if (c == 0x4D) return 19;                            // M
        if (c == 0x4E) return 20;                            // N
        if (c == 0x4F) return 21;                            // O
        if (c == 0x50) return 22;                            // P
        if (c == 0x52) return 23;                            // R
        if (c == 0x53) return 24;                            // S
        if (c == 0x54) return 25;                            // T
        if (c == 0x55) return 26;                            // U
        return 0;
    }
}
