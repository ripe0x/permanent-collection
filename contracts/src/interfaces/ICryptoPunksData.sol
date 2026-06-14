// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal interface for the official CryptoPunksData contract at
///         0x16F5A35647D6F03D5D3da7b35409D65ba03aF3B2 — source of truth for
///         on-chain attribute strings and image data.
interface ICryptoPunksData {
    function punkAttributes(uint16 index) external view returns (string memory text);
    function punkImage(uint16 index) external view returns (bytes memory);
    function punkImageSvg(uint16 index) external view returns (string memory svg);
}
