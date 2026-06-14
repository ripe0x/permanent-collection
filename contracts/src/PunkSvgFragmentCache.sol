// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {SvgPrimitives} from "./libraries/SvgPrimitives.sol";
import {IPunksData} from "./interfaces/IPunksData.sol";

/// @title  PunkSvgFragmentCache
/// @notice Public, permissionless cache of compact 24×24 SVG fragments
///         derived from the canonical on-chain CryptoPunks pixel data.
///
///         Each cached fragment is a row-major sequence of `<rect>`
///         elements representing maximal horizontal runs of same-colored
///         opaque pixels. Fragments are coordinate-local: `x`/`y` are in
///         the 0..23 range. Consumers wrap them in
///         `<g transform="translate(cx cy)">…</g>` to place them in a
///         larger composition, or use the full-SVG view `svgOf(punkId)`
///         to get a standalone 24×24 tile.
///
///         The cache derives bytes from `PunksData.indexedPixelsOf` +
///         `PunksData.paletteRgbaBytes` — never from user-supplied data.
///         `PunksData` is pinned at construction by its `datasetHash`, so
///         pointing at a fake `PunksData` impostor reverts.
///
///         There is no admin. No setters. No funds. Once cached, a Punk's
///         fragment is permanent. The contract is intended for shared use
///         across any project that wants compact, on-chain Punk tiles —
///         the PERMANENT COLLECTION protocol is one consumer; others can
///         use the same instance.
contract PunkSvgFragmentCache {
    /// @notice Emitted once per Punk on its first `cachePunk` call.
    /// @param punkId      The CryptoPunks index (0..9999).
    /// @param pointer     The SSTORE2 storage contract holding the fragment.
    /// @param byteLength  Length of the cached fragment bytes.
    event PunkCached(uint16 indexed punkId, address indexed pointer, uint256 byteLength);

    /// @notice Reverts if `punkId >= 10_000`.
    error InvalidPunkId(uint16 punkId);
    /// @notice Reverts when a read view is called for a Punk that has never
    ///         been cached. Differentiated from `EmptySvg` (which is a
    ///         baking-time anomaly) so consumers can tell uncached apart
    ///         from cached-but-empty.
    error NotCached(uint16 punkId);
    /// @notice Reverts at `cachePunk` time if the derived fragment is
    ///         empty (i.e. `indexedPixelsOf` returned a 24×24 of entirely
    ///         transparent pixels). Defense in depth — no real Punk is
    ///         all-transparent, but the rule keeps the cache honest if
    ///         `PunksData` is ever extended.
    error EmptySvg(uint16 punkId);
    /// @notice Reverts at construction if the supplied `_punksData` does
    ///         not match a known dataset hash.
    error UnexpectedDatasetHash(bytes32 expected, bytes32 actual);

    /// @notice Width/height of a Punk tile in pixels. Constant by the
    ///         2017 CryptoPunks specification.
    uint256 public constant PUNK_DIM = 24;

    /// @notice Pinned hash of the PunksData dataset. Mirrors the value used
    ///         by `PermanentCollection.EXPECTED_DATASET_HASH` — the cache
    ///         is independent of the protocol but inherits the same source
    ///         of truth.
    bytes32 public constant EXPECTED_DATASET_HASH =
        0x92117ce6cb6bb70f9ffb9bf51ebbca6a84eae10e70639295d9c4a07958cd1f68;

    /// @notice Source of pixel + palette data. Sealed at construction.
    IPunksData public immutable punksData;

    /// @dev punkId → SSTORE2 storage-contract address. Zero means uncached.
    mapping(uint16 => address) private _pointers;

    constructor(address _punksData) {
        IPunksData pd = IPunksData(_punksData);
        bytes32 actual = pd.datasetHash();
        if (actual != EXPECTED_DATASET_HASH) {
            revert UnexpectedDatasetHash(EXPECTED_DATASET_HASH, actual);
        }
        punksData = pd;
    }

    // ────────── write ──────────

    /// @notice Bake `punkId`'s SVG fragment into a fresh SSTORE2 storage
    ///         contract. Idempotent — if already cached, returns the
    ///         existing pointer without redeploying.
    /// @param  punkId The CryptoPunks index (0..9999).
    /// @return pointer The address of the SSTORE2 contract holding the fragment.
    function cachePunk(uint16 punkId) external returns (address pointer) {
        if (punkId >= 10_000) revert InvalidPunkId(punkId);
        pointer = _pointers[punkId];
        if (pointer != address(0)) return pointer;

        bytes memory fragment = _buildFragment(punkId);
        if (fragment.length == 0) revert EmptySvg(punkId);

        pointer = SSTORE2.write(fragment);
        _pointers[punkId] = pointer;
        emit PunkCached(punkId, pointer, fragment.length);
    }

    // ────────── read ──────────

    /// @notice True iff `punkId` has been cached.
    function isCached(uint16 punkId) external view returns (bool) {
        return _pointers[punkId] != address(0);
    }

    /// @notice Storage-contract address holding the fragment for `punkId`.
    ///         Reverts `NotCached` if uncached. Useful for callers that
    ///         want to compose via the SSTORE2 layer directly rather than
    ///         materialising the bytes.
    function pointerOf(uint16 punkId) external view returns (address) {
        address p = _pointers[punkId];
        if (p == address(0)) revert NotCached(punkId);
        return p;
    }

    /// @notice Raw cached fragment bytes for `punkId`. The output is a
    ///         sequence of `<rect>` elements with coordinates in the
    ///         0..23 range. Reverts `NotCached` if uncached.
    function fragmentOf(uint16 punkId) external view returns (bytes memory) {
        address p = _pointers[punkId];
        if (p == address(0)) revert NotCached(punkId);
        return SSTORE2.read(p);
    }

    /// @notice Convenience view: the cached fragment wrapped in a
    ///         standalone 24×24 `<svg>` element. Useful for direct
    ///         consumption by previewers and tests. Reverts `NotCached`
    ///         if uncached.
    function svgOf(uint16 punkId) external view returns (string memory) {
        address p = _pointers[punkId];
        if (p == address(0)) revert NotCached(punkId);
        bytes memory frag = SSTORE2.read(p);
        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">',
                frag,
                "</svg>"
            )
        );
    }

    /// @notice Live, cacheless re-derivation of `punkId`'s SVG fragment —
    ///         the exact bytes that `cachePunk` would store. Reads
    ///         `indexedPixelsOf` + `paletteRgbaBytes` from `PunksData`
    ///         on every call.
    ///
    ///         Used by the Mosaic renderer as a fallback when a collected
    ///         trait's first-vaulted Punk has not yet been baked into the
    ///         cache: the renderer reads the fragment live so the cell
    ///         shows real art the moment the trait is collected, with no
    ///         placeholder marker.
    ///
    ///         Mirrors `TraitIconCache.buildFragment` in shape and
    ///         purpose. The cross-contract identity invariant
    ///         `this.buildFragment(p) == cachePunk(p) bytes` is what
    ///         keeps cached and uncached renderings byte-identical.
    ///
    /// @dev    **Gas budget**: building a fragment touches the full
    ///         24×24 = 576 indexed-pixel byte buffer plus a 256-entry
    ///         palette, and emits one `<path>` per distinct opaque
    ///         color used by the Punk (typically 8–12). The compute is
    ///         O(pixels) + O(colors × pixels). On mainnet, a typical
    ///         Punk renders in a few million gas. **For a fully-
    ///         uncached collection, a `Vault.tokenURI(111)` view call
    ///         can multiply that by ~111 cells** — well into the
    ///         hundreds-of-millions of gas range that some public RPC
    ///         endpoints throttle for `eth_call` (Alchemy defaults to
    ///         150M, Infura ~125M, many publics ~50M). Callers that
    ///         expect to render frequently SHOULD bake the cache via
    ///         `cachePunk(punkId)` once per collected Punk; the
    ///         renderer then reads the SSTORE2 pointer directly and
    ///         the per-cell cost drops to a single `SLOAD` + the
    ///         SSTORE2 read.
    ///
    ///         Note that read-gas limits apply only to `eth_call`
    ///         (off-chain views). Other contracts that compose this
    ///         renderer at runtime would pay the same gas live as
    ///         part of their own tx, which is bounded by the block
    ///         gas limit. Marketplace tokenURI fetches are eth_calls.
    function buildFragment(uint16 punkId) external view returns (bytes memory) {
        if (punkId >= 10_000) revert InvalidPunkId(punkId);
        return _buildFragment(punkId);
    }

    // ────────── internal: bake ──────────

    /// @dev Build the cached fragment for `punkId`. Reads
    ///      `indexedPixelsOf` + `paletteRgbaBytes` from `PunksData` and
    ///      emits one `<path>` per distinct color used by this Punk,
    ///      packing all maximal horizontal opaque runs of that color
    ///      into a single SVG path `d` attribute.
    ///
    ///      Output shape (per run, closed 1-pixel-tall rectangle):
    ///        `<path fill="#RGB" d="M0 0h3v1h-3zM5 0h2v1h-2z …"/>` × (≤16 paths)
    ///
    ///      Each subpath is closed (`v1h-{w}z`) so SVG fill renders a
    ///      visible 1×{w} rectangle. A bare `M{x} {y}h{w}` per run would
    ///      be a zero-area horizontal line, and standards-compliant SVG
    ///      renderers (rsvg, every browser) draw NOTHING for a fill-only
    ///      zero-area path. The `v1h-{w}z` close suffix is what makes the
    ///      run visible.
    ///
    ///      This is still several times smaller than emitting one
    ///      `<rect>` per run — a typical Punk has ~100 runs spread
    ///      over ~8–12 distinct colors, so per-color grouping
    ///      deduplicates the `fill="…"` attribute (~13 bytes) per run.
    ///      Full-set savings cascade into the renderer's gas budget
    ///      for `tokenURI()`.
    function _buildFragment(uint16 punkId) internal view returns (bytes memory out) {
        bytes memory ip = punksData.indexedPixelsOf(punkId);
        bytes memory pal = punksData.paletteRgbaBytes();

        // Pass 1: collect the set of distinct opaque colors used by this
        // Punk. The palette has up to 256 entries — most Punks use fewer
        // than 16. `colorSeen[c] = true` if `c` appears with opaque alpha
        // anywhere in the 576-pixel tile.
        bool[256] memory colorSeen;
        uint256 colorCount;
        uint256[16] memory colorList; // 16 is comfortably above observed max
        for (uint256 i = 0; i < PUNK_DIM * PUNK_DIM; i++) {
            uint8 c = uint8(ip[i]);
            uint8 alpha = uint8(pal[uint256(c) * 4 + 3]);
            if (alpha == 0) continue;
            if (!colorSeen[c]) {
                colorSeen[c] = true;
                require(colorCount < colorList.length, "PunkSvgFragmentCache: color overflow");
                colorList[colorCount++] = c;
            }
        }

        // Pass 2: for each distinct color, emit a `<path>` with one move
        // + horizontal-line command per run.
        for (uint256 k = 0; k < colorCount; k++) {
            uint8 target = uint8(colorList[k]);
            bytes memory pathData = _runsForColor(ip, pal, target);
            if (pathData.length == 0) continue;
            uint256 off = uint256(target) * 4;
            out = abi.encodePacked(
                out,
                '<path fill="',
                _hex(uint8(pal[off]), uint8(pal[off + 1]), uint8(pal[off + 2])),
                '" d="',
                pathData,
                '"/>'
            );
        }
    }

    /// @dev Walk the pixel grid and emit `M{x} {y}h{w}` for each maximal
    ///      horizontal run of `target` (opaque). Caller has already
    ///      verified `target` is opaque-used. Output is suitable for
    ///      direct inclusion in an SVG `<path d="…">` attribute.
    function _runsForColor(bytes memory ip, bytes memory pal, uint8 target)
        internal pure returns (bytes memory out)
    {
        for (uint256 row = 0; row < PUNK_DIM; row++) {
            uint256 runStart;
            bool inRun;
            for (uint256 col = 0; col < PUNK_DIM; col++) {
                uint8 c = uint8(ip[row * PUNK_DIM + col]);
                uint8 alpha = uint8(pal[uint256(c) * 4 + 3]);
                bool isTarget = (alpha != 0) && (c == target);
                if (!isTarget && inRun) {
                    out = abi.encodePacked(out, _emitMove(runStart, row, col - runStart));
                    inRun = false;
                } else if (isTarget && !inRun) {
                    runStart = col;
                    inRun = true;
                }
            }
            if (inRun) {
                out = abi.encodePacked(out, _emitMove(runStart, row, PUNK_DIM - runStart));
            }
        }
    }

    /// @dev Emit one `M{x} {y}h{w}v1h-{w}z` chunk into a path's `d`
    ///      attribute — a closed 1-pixel-tall rectangle covering the
    ///      run [x, x+w) × [y, y+1). Closed so SVG `fill` actually
    ///      renders. No trailing separator — SVG path commands are
    ///      self-delimiting.
    function _emitMove(uint256 x, uint256 y, uint256 width)
        internal pure returns (bytes memory)
    {
        bytes memory w = bytes(_u(width));
        return abi.encodePacked(
            "M", _u(x), " ", _u(y), "h", w, "v1h-", w, "z"
        );
    }

    function _u(uint256 v) internal pure returns (string memory) {
        return SvgPrimitives.uintToString(v);
    }

    function _hex(uint8 r, uint8 g, uint8 b) internal pure returns (string memory) {
        return SvgPrimitives.hexColor(r, g, b);
    }
}
