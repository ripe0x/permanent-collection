// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  SvgPrimitives
/// @notice Pure SVG leaf helpers shared by the renderer/cache cluster
///         (`PunkSvgFragmentCache`, `TraitIconCache`, and the mosaic renderer).
///         The logic is stable and never expected to change; sharing it from
///         one place removes the silent-drift hazard of separate copies. As
///         `internal` library functions the bodies inline at each call site,
///         so the rendered bytes are identical across every consumer (guarded
///         by the renderer parity tests).
library SvgPrimitives {
    /// @dev Base-10 unsigned integer to its decimal ASCII string. "0" for zero.
    function uintToString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 d;
        while (n != 0) {
            d++;
            n /= 10;
        }
        bytes memory b = new bytes(d);
        for (uint256 i = d; i > 0; i--) {
            b[i - 1] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
        return string(b);
    }

    /// @dev (r,g,b) to a `"#rrggbb"` lowercase-hex color string.
    function hexColor(uint8 r, uint8 g, uint8 b) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(7);
        out[0] = "#";
        out[1] = hexChars[r >> 4];
        out[2] = hexChars[r & 0x0f];
        out[3] = hexChars[g >> 4];
        out[4] = hexChars[g & 0x0f];
        out[5] = hexChars[b >> 4];
        out[6] = hexChars[b & 0x0f];
        return string(out);
    }
}
