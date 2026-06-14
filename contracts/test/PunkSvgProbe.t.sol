// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ICryptoPunksData} from "../src/interfaces/ICryptoPunksData.sol";
import {IPunksData} from "../src/interfaces/IPunksData.sol";

/// @notice Probe of the official `CryptoPunksData.punkImageSvg(uint16)`
///         endpoint. Used as a one-time discovery test for sizing the
///         per-Punk SVG cache. Run with:
///
///             forge test --match-contract PunkSvgProbe -vv
///
///         The test logs:
///           - bytes returned per Punk
///           - first ~120 chars of the payload (so we can sanity-check the
///             root element / inline transform / unit shape)
///           - gas spent on a single call
///
///         Probed Punk ids span every trait category: alien (#7804),
///         ape (#5217), zombie (#6487), female (#3914), accessory-heavy
///         hat/pipe/glasses combo (#0), and a male-bald baseline (#5).
contract PunkSvgProbe is Test {
    /// @dev Address of the official `CryptoPunksData` contract (the one with
    ///      `punkImageSvg`). NOT the same as the `PunksData` at
    ///      `0x9cF9C8…117C` that the protocol's `PermanentCollection` uses
    ///      for trait masks — that contract exposes pixel + palette views
    ///      but no SVG endpoint.
    address internal constant CRYPTO_PUNKS_DATA = 0x16F5A35647D6F03D5D3da7b35409D65ba03aF3B2;
    address internal constant PUNKS_DATA = 0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C;

    ICryptoPunksData internal cryptoPunksData;
    IPunksData internal punksData;

    uint16[6] internal probeIds = [uint16(7804), 5217, 6487, 3914, 0, 5];

    function setUp() public {
        string memory url = vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url);
        require(CRYPTO_PUNKS_DATA.code.length > 0, "CryptoPunksData missing on fork");
        require(PUNKS_DATA.code.length > 0, "PunksData missing on fork");
        cryptoPunksData = ICryptoPunksData(CRYPTO_PUNKS_DATA);
        punksData = IPunksData(PUNKS_DATA);
    }

    function test_ProbeSvgOutput() public {
        for (uint256 i = 0; i < probeIds.length; i++) {
            uint16 id = probeIds[i];
            uint256 gasBefore = gasleft();
            string memory svg = cryptoPunksData.punkImageSvg(id);
            uint256 gasUsed = gasBefore - gasleft();
            bytes memory b = bytes(svg);

            emit log_named_uint("punkId", id);
            emit log_named_uint("byteLength", b.length);
            emit log_named_uint("gasUsed", gasUsed);

            // First 4 chars are critical: do we get a leading `<svg`, or a
            // data: URI, or what? Stash the leading slice for inspection.
            uint256 take = b.length < 120 ? b.length : 120;
            bytes memory head = new bytes(take);
            for (uint256 k = 0; k < take; k++) head[k] = b[k];
            emit log_named_string("head", string(head));

            // Same for trailing — confirms whether output is self-closing.
            uint256 tailLen = b.length < 60 ? b.length : 60;
            bytes memory tail = new bytes(tailLen);
            for (uint256 k = 0; k < tailLen; k++) tail[k] = b[b.length - tailLen + k];
            emit log_named_string("tail", string(tail));
        }
    }

    /// @notice Sanity-check that an RLE-derived 24×24 tile is materially
    ///         smaller than the official per-pixel SVG. Confirms the choice
    ///         to derive a compact fragment from `indexedPixelsOf` instead
    ///         of caching the official SVG output.
    function test_ProbeRleSizes() public {
        bytes memory pal = punksData.paletteRgbaBytes();
        uint256 totalRle;
        uint256 totalRaw;
        for (uint256 i = 0; i < probeIds.length; i++) {
            uint16 id = probeIds[i];
            bytes memory ip = punksData.indexedPixelsOf(id);
            bytes memory rle = _rleTile(ip, pal);
            string memory raw = cryptoPunksData.punkImageSvg(id);
            emit log_named_uint("punkId", id);
            emit log_named_uint("rleBytes", rle.length);
            emit log_named_uint("rawSvgBytes", bytes(raw).length);
            totalRle += rle.length;
            totalRaw += bytes(raw).length;
        }
        emit log_named_uint("totalRleBytes (6 punks)", totalRle);
        emit log_named_uint("totalRawSvgBytes (6 punks)", totalRaw);
    }

    // ─────────────────────────────────────────────────────────────
    // Mirror of `PermanentCollectionMosaicRenderer._rlePunk` / `_emitRun` /
    // `_hexColor`. Kept here as a self-contained probe — the real
    // implementation in the cache contract is a separate file so the cache
    // can be deployed without the renderer.
    // ─────────────────────────────────────────────────────────────

    uint256 internal constant DIM = 24;

    function _rleTile(bytes memory ip, bytes memory pal) internal pure returns (bytes memory out) {
        for (uint256 row = 0; row < DIM; row++) {
            uint256 runStart = 0;
            uint8 runColor = 0;
            bool inRun = false;
            for (uint256 col = 0; col < DIM; col++) {
                uint8 c = uint8(ip[row * DIM + col]);
                uint8 alpha = uint8(pal[uint256(c) * 4 + 3]);
                bool opaque = alpha != 0;
                if (!opaque) {
                    if (inRun) {
                        out = abi.encodePacked(out, _emitRun(runStart, col - 1, row, runColor, pal));
                        inRun = false;
                    }
                } else if (!inRun) {
                    runStart = col;
                    runColor = c;
                    inRun = true;
                } else if (c != runColor) {
                    out = abi.encodePacked(out, _emitRun(runStart, col - 1, row, runColor, pal));
                    runStart = col;
                    runColor = c;
                }
            }
            if (inRun) {
                out = abi.encodePacked(out, _emitRun(runStart, DIM - 1, row, runColor, pal));
            }
        }
    }

    function _emitRun(uint256 s, uint256 e, uint256 row, uint8 color, bytes memory pal)
        internal pure returns (bytes memory)
    {
        uint256 width = e - s + 1;
        uint256 off = uint256(color) * 4;
        return abi.encodePacked(
            '<rect x="', _u(s),
            '" y="', _u(row),
            '" width="', _u(width),
            '" height="1" fill="', _hex(uint8(pal[off]), uint8(pal[off + 1]), uint8(pal[off + 2])), '"/>'
        );
    }

    function _u(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 d;
        while (n != 0) { d++; n /= 10; }
        bytes memory b = new bytes(d);
        for (uint256 i = d; i > 0; i--) {
            b[i - 1] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
        return string(b);
    }

    function _hex(uint8 r, uint8 g, uint8 b) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(7);
        out[0] = "#";
        out[1] = hexChars[r >> 4]; out[2] = hexChars[r & 0x0f];
        out[3] = hexChars[g >> 4]; out[4] = hexChars[g & 0x0f];
        out[5] = hexChars[b >> 4]; out[6] = hexChars[b & 0x0f];
        return string(out);
    }
}
