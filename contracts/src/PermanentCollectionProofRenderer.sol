// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibString} from "solady/utils/LibString.sol";
import {Base64} from "solady/utils/Base64.sol";

import {IPunksData} from "./interfaces/IPunksData.sol";
import {TraitIconCache} from "./TraitIconCache.sol";
import {PunkSvgFragmentCache} from "./PunkSvgFragmentCache.sol";

interface IPunkVaultProofView {
    /// @notice Mirror of `PunkVault.proofMeta` — see that contract for
    ///         per-field semantics. Returns a zero-valued struct for any
    ///         id that has never been minted.
    function proofMeta(uint256 tokenId)
        external
        view
        returns (uint16 punkId, uint8 traitId, uint16 sequence, uint64 mintedAtBlock);
}

/// @title  PermanentCollectionProofRenderer
/// @notice On-chain SVG + JSON renderer for the 111 Proof NFTs issued by
///         `PunkVault` (token ids 0..110). Each Proof attests to a single
///         trait's first-vaulting and is owned by the address that
///         originally gave up the Punk to the protocol.
///
///         The image is composed entirely on-chain. A minted Proof is two
///         layers on a `#8F918B` cell: the acquired Punk rendered faintly
///         (5% opacity) as a background — the Punk whose vaulting brought
///         the trait in, pulled from `PunkSvgFragmentCache` — with the
///         trait's isolated visual (from `TraitIconCache`'s pure-view
///         `buildFragment`, so the renderer works for unbaked traits too)
///         composited crisply on top. An unminted Proof has no acquired
///         Punk yet, so it renders the trait visual alone.
///
///         The minted-vs-unminted distinction lives in the IMAGE: the raw
///         `svg(traitId)` view renders the faint Punk layer once minted and
///         the trait tile alone before. `tokenURI(id)`, by contrast, exists
///         ONLY for a minted Proof — it reverts `ProofNotMinted` for an
///         unminted id (no preview envelope), so its `name` / `description`
///         / `attributes` always describe a minted Proof (trait name,
///         contributing Punk id, sequence "N of 111", vault-settle block).
///
/// @dev    This contract has no admin and no setters. It carries no
///         storage of its own beyond the three immutable references it
///         needs to compose output. Replaceable only via the shipped
///         dispatcher renderer (`PermanentCollectionMosaicRenderer`)
///         delegating to a different proof renderer at registry-set time,
///         until the registry is frozen.
///
///         For ids outside the Proof range (> 110) the renderer reverts
///         `UnknownTokenId`. The dispatcher front (Mosaic renderer) is
///         expected to route id 111 (the Title) elsewhere; this contract
///         refuses to claim it.
contract PermanentCollectionProofRenderer {
    using LibString for uint256;

    error UnknownTokenId(uint256 id);
    /// @notice Reverts on `tokenURI(id)` for an in-range Proof id (0..110)
    ///         whose Proof has not yet been minted. There is no preview
    ///         envelope — an unminted Proof has no metadata, matching the
    ///         canonical `PunkVault.tokenURI` path (which reverts
    ///         `UnknownTokenId` for the same ids). The raw `svg(traitId)`
    ///         trait-tile view stays total and is unaffected.
    error ProofNotMinted(uint256 id);
    error ZeroAddress();

    /// @notice The vault that issues the Proofs. Read for per-Proof
    ///         metadata (`proofMeta`) at render time.
    IPunkVaultProofView public immutable vault;
    /// @notice Sealed pixel + palette + trait-name source. Read for the
    ///         human-readable trait label inscribed on the Proof.
    IPunksData public immutable punksData;
    /// @notice Public trait-icon cache. Read for `buildFragment(traitId)`,
    ///         the pure-view that produces the isolated trait's `<rect>`
    ///         runs without requiring a prior bake. Falls through to the
    ///         on-the-fly compute path inside the cache itself.
    TraitIconCache public immutable traitIconCache;
    /// @notice Public full-Punk SVG cache. Read for the acquired Punk's
    ///         `<path>` fragment (`fragmentOf` when baked, else the
    ///         pure-view `buildFragment`) drawn as the faint 5%-opacity
    ///         background layer on a minted Proof. Same instance the
    ///         Mosaic renderer uses; same `0..23` coordinate space as the
    ///         trait icon, so it overlays with no scaling.
    PunkSvgFragmentCache public immutable punkSvgCache;

    /// @notice Total number of Proofs in the collection. Constant.
    uint256 public constant PROOF_COUNT = 111;
    /// @notice Highest valid Proof token id (inclusive). Proofs occupy
    ///         0..110 with `tokenId == traitId` directly.
    uint256 public constant MAX_PROOF_TOKEN_ID = 110;

    /// @dev Intrinsic raster dimensions of the Proof SVG. Browsers
    ///      rasterize SVGs at their intrinsic `width`/`height` when
    ///      copying to clipboard or saving as image. The `viewBox` is
    ///      `-2 -2 28 28`: a 24×24 trait/Punk tile, a 1px frame hugging
    ///      it, and 1px of padding out to the canvas edge on every side
    ///      (1 + 1 + 24 + 1 + 1 = 28). Explicit `width`/`height` at 100×
    ///      yield a 2800×2800 raster on right-click "Copy Image" — plenty
    ///      for marketplace, print, and social use. Display sizing at
    ///      marketplaces and in the frontend is unaffected (both constrain
    ///      via container CSS, which overrides intrinsic dims at display
    ///      time).
    string private constant OUTPUT_WIDTH = "2800";
    string private constant OUTPUT_HEIGHT = "2800";

    /// @dev Tile frame: a crisp 1px stroke hugging the 24×24 tile, with
    ///      1px of padding between the frame and the canvas edge. Drawn on
    ///      top of every Proof (minted or not). Matches the frontend's
    ///      `--line` card border (`#DADAD7`) so the on-chain image carries
    ///      the same frame everywhere it's shown — marketplaces,
    ///      copy-image, social — not just on the /proofs grid. The stroke
    ///      is centered on the half-pixel just outside the tile
    ///      (`-0.5 .. 24.5`) so it snaps to a clean 1px ring under
    ///      `shape-rendering="crispEdges"`.
    string private constant FRAME_COLOR = "#DADAD7";

    /// @dev Background fill for the Proof tile — the canvas behind the trait
    ///      icon (and, on a minted Proof, the faint acquired-Punk layer).
    string private constant BG_COLOR = "#8F918B";

    constructor(address _vault, address _punksData, address _traitIconCache, address _punkSvgCache) {
        if (
            _vault == address(0) || _punksData == address(0) || _traitIconCache == address(0)
                || _punkSvgCache == address(0)
        ) {
            revert ZeroAddress();
        }
        vault = IPunkVaultProofView(_vault);
        punksData = IPunksData(_punksData);
        traitIconCache = TraitIconCache(_traitIconCache);
        punkSvgCache = PunkSvgFragmentCache(_punkSvgCache);
    }

    /// @notice Returns the data-URI-encoded ERC721 JSON metadata for a
    ///         minted Proof token id. Valid range: 0..110
    ///         (`tokenId == traitId`).
    ///         - id > 110           → reverts `UnknownTokenId(id)`.
    ///         - in-range, unminted → reverts `ProofNotMinted(id)`. There
    ///           is no preview envelope; this mirrors the canonical
    ///           `PunkVault.tokenURI` path. The raw `svg(traitId)` view
    ///           still renders the trait tile for an unminted id.
    function tokenURI(uint256 id) external view returns (string memory) {
        if (id > MAX_PROOF_TOKEN_ID) revert UnknownTokenId(id);
        uint8 traitId = uint8(id);
        (uint16 punkId, , uint16 sequence, uint64 mintedAtBlock) = vault.proofMeta(id);
        if (mintedAtBlock == 0) revert ProofNotMinted(id);

        string memory traitName = punksData.traitName(uint16(traitId));
        // The acquired Punk (the `punkId` whose vaulting brought the trait
        // in) is drawn faintly behind the trait tile.
        string memory image = _imageDataUri(traitId, punkId, true);

        // Proof number IS the trait id (== token id), not the collection
        // sequence — so "Proof 102 (Tiara)" matches the token id, not the
        // order it was collected in.
        string memory name = string.concat(
            'Permanent Collection Proof ',
            uint256(traitId).toString(),
            ' (', traitName, ')'
        );

        string memory description = string.concat(
            'Proof that CryptoPunk ',
            uint256(punkId).toString(),
            " was added to Permanent Collection's immutable contract for the ",
            traitName,
            ' trait.'
        );

        string memory attributes = _attributesJson(traitId, traitName, punkId, sequence, mintedAtBlock);

        // Outer envelope is base64-encoded JSON (`data:application/json;base64,`),
        // the OpenSea-documented form. The inner image is a base64 SVG data URI,
        // so the metadata carries no unescaped characters.
        string memory json = string.concat(
            '{"name":"', name, '",',
            '"description":"', description, '",',
            '"image":"', image, '",',
            '"attributes":', attributes,
            '}'
        );
        return string.concat('data:application/json;base64,', Base64.encode(bytes(json)));
    }

    /// @notice Raw SVG payload for the Proof image at trait `traitId`.
    ///         Useful for off-chain tooling. `traitId` must be in [0, 110].
    ///         Reflects the live mint state: once the trait's Proof is
    ///         minted the acquired Punk is drawn faintly behind the trait,
    ///         so the image differs from the pre-mint preview.
    function svg(uint8 traitId) external view returns (string memory) {
        if (traitId >= PROOF_COUNT) revert UnknownTokenId(uint256(traitId));
        // tokenId == traitId for Proofs, so read this trait's mint state
        // directly to decide whether the acquired Punk layer is drawn.
        (uint16 punkId, , , uint64 mintedAtBlock) = vault.proofMeta(traitId);
        return _renderSvg(traitId, punkId, mintedAtBlock != 0);
    }

    // ────────── helpers ──────────

    function _imageDataUri(uint8 traitId, uint16 punkId, bool minted) internal view returns (string memory) {
        return string.concat(
            'data:image/svg+xml;base64,',
            Base64.encode(bytes(_renderSvg(traitId, punkId, minted)))
        );
    }

    /// @dev Renders the Proof tile — square 24×24 viewBox, `#8F918B`
    ///      background (`BG_COLOR`). On a MINTED Proof, the acquired Punk (`punkId`) is
    ///      drawn first at 5% opacity as a barely-visible background
    ///      layer, then the trait icon (`TraitIconCache.buildFragment`)
    ///      is composited crisply on top. On an UNMINTED Proof there is
    ///      no acquired Punk yet, so only the trait icon is drawn. Both
    ///      states get a 1px tile frame (`FRAME_COLOR`) on top. No
    ///      inscription, no text.
    ///
    ///      Both Punk and trait fragments live in the same `0..23`
    ///      coordinate space, so the Punk overlays with no scaling. The
    ///      minted-vs-unminted distinction lives in BOTH the image (faint
    ///      Punk layer) and the JSON envelope's `name` / `description` /
    ///      `attributes`.
    function _renderSvg(uint8 traitId, uint16 punkId, bool minted) internal view returns (string memory) {
        bytes memory frag = traitIconCache.buildFragment(traitId);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" ',
            'width="', OUTPUT_WIDTH, '" height="', OUTPUT_HEIGHT, '" ',
            'viewBox="-2 -2 28 28" shape-rendering="crispEdges">',
            // Tile fills the whole canvas (frame + 1px padding sit on it).
            '<rect x="-2" y="-2" width="28" height="28" fill="', BG_COLOR, '"/>',
            minted
                ? string.concat('<g opacity="0.05">', string(_punkFragment(punkId)), '</g>')
                : '',
            string(frag),
            // 1px frame on top, hugging the 24×24 tile from just outside it,
            // leaving 1px of padding between the frame and the canvas edge.
            '<rect x="-0.5" y="-0.5" width="25" height="25" fill="none" stroke="', FRAME_COLOR, '" stroke-width="1"/>',
            '</svg>'
        );
    }

    /// @dev Full-Punk SVG `<path>` fragment for the acquired Punk, used
    ///      cached when baked and computed live otherwise — same
    ///      cached/live fallback the Mosaic renderer uses so a Proof
    ///      renders correctly whether or not the Punk has been baked.
    function _punkFragment(uint16 punkId) internal view returns (bytes memory) {
        return punkSvgCache.isCached(punkId)
            ? punkSvgCache.fragmentOf(punkId)
            : punkSvgCache.buildFragment(punkId);
    }

    function _attributesJson(
        uint8 traitId,
        string memory traitName,
        uint16 punkId,
        uint16 sequence,
        uint64 mintedAtBlock
    ) internal pure returns (string memory) {
        // Numeric values emitted unquoted (OpenSea integer trait); strings
        // quoted. Sequence is emitted as a string "N of 111" because the
        // issue explicitly inscribes it that way ("'47 of 111'"). Only
        // minted Proofs reach here — `tokenURI` reverts `ProofNotMinted`
        // for an unminted id before building attributes.
        return string.concat(
            '[',
            '{"trait_type":"Trait","value":"', traitName, '"},',
            '{"trait_type":"Trait ID","value":', uint256(traitId).toString(), '},',
            '{"trait_type":"Punk ID","value":', uint256(punkId).toString(), '},',
            '{"trait_type":"Sequence","value":"',
                uint256(sequence).toString(), ' of 111',
            '"},',
            '{"trait_type":"Vaulted at Block","value":', uint256(mintedAtBlock).toString(), '}',
            ']'
        );
    }
}
