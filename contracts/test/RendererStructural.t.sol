// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {TraitIconCache} from "../src/TraitIconCache.sol";
import {Base64} from "solady/utils/Base64.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Structural validation of `PermanentCollectionMosaicRenderer.tokenURI()`.
///         The pre-existing Renderer.t.sol only checks that the output is
///         non-empty — this suite additionally validates:
///
///         1. The data-URI prefix is `data:application/json;base64,` (the
///            OpenSea-documented base64 envelope).
///         2. The base64 body decodes to valid JSON shape (starts with `{`,
///            ends with `}`).
///         3. The decoded JSON contains the expected top-level keys
///            (`name`, `description`, `image`, `attributes`).
///         4. The `image` field is a `data:image/svg+xml;base64,` URI
///            that decodes to bytes starting with `<svg`.
contract RendererStructuralTest is ForkFixtures {
    PermanentCollectionMosaicRenderer internal renderer;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        punkSvgCache = new PunkSvgFragmentCache(PUNKS_DATA);
        traitIconCache = new TraitIconCache(PUNKS_DATA);
        proofRenderer = new PermanentCollectionProofRenderer(
            address(vault), PUNKS_DATA, address(traitIconCache), address(punkSvgCache)
        );
        renderer = new PermanentCollectionMosaicRenderer(
            address(collection), address(vault), address(punkSvgCache), PUNKS_DATA, address(traitIconCache), address(proofRenderer)
        );
    }

    function test_DataUriPrefix_Json() public view {
        string memory uri = renderer.tokenURI();
        bytes memory u = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        require(u.length >= prefix.length, "uri too short");
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(u[i], prefix[i], "data URI prefix mismatch");
        }
    }

    function test_JsonBody_HasJsonShape() public view {
        bytes memory body = _jsonBody();
        assertGt(body.length, 0, "body empty");
        assertEq(body[0], "{", "body not JSON");
        assertEq(body[body.length - 1], "}", "body unclosed");
    }

    function test_JsonHasExpectedKeys() public view {
        bytes memory body = _jsonBody();
        assertTrue(_contains(body, '"name"'), "missing name key");
        assertTrue(_contains(body, '"description"'), "missing description key");
        assertTrue(_contains(body, '"image"'), "missing image key");
        assertTrue(_contains(body, '"attributes"'), "missing attributes key");
    }

    function test_ImageField_IsSvgDataUri() public view {
        bytes memory body = _jsonBody();
        assertTrue(
            _contains(body, '"image":"data:image/svg+xml;base64,'),
            "image field shape wrong"
        );
    }

    function test_DecodedSvg_StartsWithSvgTag() public view {
        bytes memory body = _jsonBody();

        bytes memory marker = bytes('"image":"data:image/svg+xml;base64,');
        uint256 start = _indexOf(body, marker);
        require(start != type(uint256).max, "image marker not found");
        uint256 svgB64Start = start + marker.length;

        uint256 end = svgB64Start;
        while (end < body.length && body[end] != '"') end++;
        require(end > svgB64Start, "empty image body");

        bytes memory svgB64 = new bytes(end - svgB64Start);
        for (uint256 i = 0; i < svgB64.length; i++) {
            svgB64[i] = body[svgB64Start + i];
        }

        bytes memory svg = Base64.decode(string(svgB64));
        assertGt(svg.length, 100, "svg too short");
        assertEq(svg[0], "<", "svg first byte");
        assertEq(svg[1], "s", "svg second byte");
        assertEq(svg[2], "v", "svg third byte");
        assertEq(svg[3], "g", "svg fourth byte");
    }

    function test_FullSet_ReportsAllTraitsCollected() public {
        _setCollectedMask(collection.FULL_SET_MASK());
        assertTrue(collection.isComplete());

        bytes memory body = _jsonBody();
        // The zero-arg tokenURI exposes the trait count as a metadata
        // attribute — at full set it must read 111.
        assertTrue(
            _contains(body, bytes('"trait_type":"Traits Collected","value":111')),
            "completion count missing"
        );
    }

    // ───────────────── helpers ─────────────────

    function _jsonBody() internal view returns (bytes memory) {
        string memory uri = renderer.tokenURI();
        bytes memory u = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory b64 = new bytes(u.length - prefix.length);
        for (uint256 i = 0; i < b64.length; i++) {
            b64[i] = u[i + prefix.length];
        }
        return Base64.decode(string(b64));
    }

    function _contains(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        return _indexOf(haystack, needle) != type(uint256).max;
    }

    function _indexOf(bytes memory haystack, bytes memory needle) internal pure returns (uint256) {
        if (needle.length == 0 || needle.length > haystack.length) return type(uint256).max;
        for (uint256 i = 0; i <= haystack.length - needle.length; i++) {
            bool match_ = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return i;
        }
        return type(uint256).max;
    }
}
