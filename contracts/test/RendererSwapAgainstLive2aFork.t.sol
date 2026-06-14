// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Base64} from "solady/utils/Base64.sol";

import {RendererRegistry} from "../src/RendererRegistry.sol";
import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";

/// @title  RendererSwapAgainstLive2aFork
/// @notice Forks the LIVE mainnet Phase-2a deployment, deploys the new
///         base64-envelope renderer pair (reusing the live collection /
///         vault / caches), pranks the ProtocolAdmin EOA to
///         `setImplementation`, and asserts the marketplace metadata surfaces
///         that flow through the registry now return the OpenSea-documented
///         `data:application/json;base64,` envelope that decodes to valid JSON.
///
///         This is the dry-run for the real mainnet swap: it proves the
///         registry forwards base64 output AND that the new renderers bind
///         cleanly to the already-deployed caches with no re-bake.
///
///         Heavy (renders the full mosaic on the on-the-fly path against the
///         live, likely-unbaked cache). Run:
///           MAINNET_RPC_URL=https://gateway.tenderly.co/public/mainnet \
///             forge test --match-contract RendererSwapAgainstLive2aFork -vv
contract RendererSwapAgainstLive2aForkTest is Test {
    RendererRegistry internal registry;
    address internal vault;
    address internal collection;
    address internal punkSvgCache;
    address internal traitIconCache;
    address internal adminEoa;
    address internal liveMosaic;

    address constant PUNKS_DATA = 0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C;

    // Live mainnet Phase-2a addresses (deployments.mainnet.json, block 25270161).
    // Overridable via env so the same dry-run can target a different stack.
    address constant DEFAULT_REGISTRY = 0x760421B7916917Ffd72ECeAa4c1F7ffC4D12eEc7;
    address constant DEFAULT_VAULT = 0x3614692b8C8B22890D66a5DfcBc6F6eAdEdE036f;
    address constant DEFAULT_COLLECTION = 0x59607d4d92a57EAa8544b2AdE7b014F8785AAf34;
    address constant DEFAULT_PUNK_SVG_CACHE = 0x3ab4b628AB844a723235F08554C49B5Dd54c56BD;
    address constant DEFAULT_TRAIT_ICON_CACHE = 0xCd7eE161a7aA9f49F7d970CF3B31fE5ac6D20Ca7;
    address constant DEFAULT_RENDERER = 0x40aa9edb0063ca5d12eef8A53be45F7e15a3Fe10;

    function setUp() public {
        string memory url =
            vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url);

        registry = RendererRegistry(vm.envOr("RENDERER_REGISTRY", DEFAULT_REGISTRY));
        vault = vm.envOr("PUNK_VAULT", DEFAULT_VAULT);
        collection = vm.envOr("PERMANENT_COLLECTION", DEFAULT_COLLECTION);
        punkSvgCache = vm.envOr("PUNK_SVG_CACHE", DEFAULT_PUNK_SVG_CACHE);
        traitIconCache = vm.envOr("TRAIT_ICON_CACHE", DEFAULT_TRAIT_ICON_CACHE);
        liveMosaic = vm.envOr("LIVE_RENDERER", DEFAULT_RENDERER);
        adminEoa = registry.adminContract().admin();
    }

    function test_Swap_RegistryServesBase64_AfterSetImplementation() public {
        // Pre-swap: the registry points at the live (utf8) renderer.
        assertEq(registry.implementation(), liveMosaic, "pre-swap impl is the live renderer");
        assertFalse(registry.frozen(), "registry must be swappable");

        // Deploy the new base64-envelope pair, reusing the live deps.
        PermanentCollectionProofRenderer newProof = new PermanentCollectionProofRenderer(
            vault, PUNKS_DATA, traitIconCache, punkSvgCache
        );
        PermanentCollectionMosaicRenderer newMosaic = new PermanentCollectionMosaicRenderer(
            collection, vault, punkSvgCache, PUNKS_DATA, traitIconCache, address(newProof)
        );

        // Swap as the live admin EOA.
        vm.prank(adminEoa);
        registry.setImplementation(address(newMosaic));
        assertEq(registry.implementation(), address(newMosaic), "post-swap impl is the new renderer");

        // Marketplace surfaces through the registry now return base64 JSON.
        _assertBase64JsonWithSvgImage(registry.contractURI(vault), "contractURI (collection card)");
        _assertBase64JsonWithSvgImage(registry.tokenURI(111), "tokenURI(111) Title");

        // The new Proof renderer binds to the live caches and renders a tile.
        bytes memory proofSvg = bytes(newProof.svg(42));
        assertEq(proofSvg[0], bytes1("<"), "proof svg starts with <");
        assertEq(proofSvg[1], bytes1("s"), "proof svg <s");
    }

    /// @dev Asserts `uri` is `data:application/json;base64,<b64>`, the body
    ///      base64-decodes to a JSON object, and that object carries a base64
    ///      SVG image data URI — i.e. nothing in the payload is unescaped.
    function _assertBase64JsonWithSvgImage(string memory uri, string memory label) internal {
        bytes memory u = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        assertGt(u.length, prefix.length, string.concat(label, ": uri too short"));
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(u[i], prefix[i], string.concat(label, ": base64 json prefix"));
        }
        bytes memory b64 = new bytes(u.length - prefix.length);
        for (uint256 i = 0; i < b64.length; i++) b64[i] = u[i + prefix.length];
        bytes memory jsonBytes = Base64.decode(string(b64));
        assertEq(jsonBytes[0], bytes1("{"), string.concat(label, ": decoded JSON object"));
        assertEq(jsonBytes[jsonBytes.length - 1], bytes1("}"), string.concat(label, ": JSON closed"));
        assertTrue(
            _contains(jsonBytes, bytes('"image":"data:image/svg+xml;base64,')),
            string.concat(label, ": inner base64 svg image")
        );
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0) return true;
        if (needle.length > hay.length) return false;
        for (uint256 i = 0; i <= hay.length - needle.length; i++) {
            bool match_ = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) { match_ = false; break; }
            }
            if (match_) return true;
        }
        return false;
    }
}
