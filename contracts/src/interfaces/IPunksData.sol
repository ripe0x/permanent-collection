// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  IPunksData
/// @notice Minimal subset of the live `PunksData` contract at
///         `0x9cf9c8ea737a7d5157d3f4282ace30880a7a117c` (ENS: punksdata.eth)
///         required by the PERMANENT COLLECTION protocol.
///
///         The full PunksData interface also exposes color, pixel, and rarity
///         data; this interface only declares the trait-mask facets the
///         protocol depends on. Re-binding the same contract through this
///         narrow interface avoids tying the protocol to PunksData
///         compilation artifacts.
///
///         Trait layout (111 traits, bits 0..110):
///           - bits   0..4   NormalizedType  (Alien, Ape, Female, Male, Zombie)
///           - bits   5..15  HeadVariant     (Alien, Ape, Female 1..4, Male 1..4, Zombie)
///           - bits  16..23  AttributeCount  (0 Attributes .. 7 Attributes)
///           - bits  24..110 Accessory       (87 named accessories)
interface IPunksData {
    /// @notice Returns the 111-bit trait mask for `punkId`.
    function traitMaskOf(uint16 punkId) external view returns (uint256);

    /// @notice Total number of distinct traits across all four dimensions. 111.
    function traitCount() external view returns (uint16);

    /// @notice Human-readable label for a trait id in [0, 110].
    function traitName(uint16 traitId) external view returns (string memory);

    /// @notice Pinned hash of the underlying trait dataset. Cycle contracts
    ///         assert this matches the expected value at construction time so
    ///         a misconfigured `_punksData` argument fails fast.
    function datasetHash() external view returns (bytes32);

    // ──────────────── Pixel/palette read surface ────────────────
    //
    // The on-chain SVG renderer (v3) reads these to compose Punk pixels
    // into the artwork. The protocol's cycle contracts don't depend on
    // them.

    /// @notice All palette indices for one Punk's image, in row-major
    ///         order (576 bytes for 24×24).
    function indexedPixelsOf(uint16 punkId) external view returns (bytes memory);

    /// @notice The HeadVariant enum value for a Punk: 0=Alien, 1=Ape,
    ///         2..5=Female 1..4, 6..9=Male 1..4, 10=Zombie. Maps to trait
    ///         bits 5..15 via `5 + headVariant`.
    function headVariantOf(uint16 punkId) external view returns (uint8);

    /// @notice The full palette as concatenated RGBA bytes (4 bytes per
    ///         color). The renderer indexes into this by `colorId * 4`.
    function paletteRgbaBytes() external view returns (bytes memory);
}
