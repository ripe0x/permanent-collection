// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";

/// @title  SwapRenderer
/// @notice Deploys a fresh `PermanentCollectionProofRenderer` +
///         `PermanentCollectionMosaicRenderer` pair that reuses the live
///         collection / vault / caches, so only the renderer logic changes.
///         The new pair emits the OpenSea-documented
///         `data:application/json;base64,` metadata envelope.
///
///         This script is DEPLOY-ONLY: it does NOT call
///         `RendererRegistry.setImplementation`. The swap is a separate,
///         explicitly-confirmed admin transaction so the new renderer's
///         output can be verified standalone before the registry points at
///         it (and the registry stays swappable until `freeze()`).
///
///         Addresses are read from env with the live mainnet Phase-2a values
///         as defaults, so a plain `forge script` run on mainnet uses the
///         right reused contracts; override any of them on a fork.
///
///         Run:
///           forge script script/SwapRenderer.s.sol:SwapRenderer \
///             --rpc-url <mainnet> --broadcast --verify
contract SwapRenderer is Script {
    // PunksData is a sealed mainnet contract — the same constant Deploy uses.
    address constant PUNKS_DATA = 0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C;

    // Live mainnet Phase-2a addresses (deployments.mainnet.json, block 25270161).
    address constant DEFAULT_COLLECTION = 0x59607d4d92a57EAa8544b2AdE7b014F8785AAf34;
    address constant DEFAULT_VAULT = 0x3614692b8C8B22890D66a5DfcBc6F6eAdEdE036f;
    address constant DEFAULT_PUNK_SVG_CACHE = 0x3ab4b628AB844a723235F08554C49B5Dd54c56BD;
    address constant DEFAULT_TRAIT_ICON_CACHE = 0xCd7eE161a7aA9f49F7d970CF3B31fE5ac6D20Ca7;
    address constant DEFAULT_RENDERER_REGISTRY = 0x760421B7916917Ffd72ECeAa4c1F7ffC4D12eEc7;

    function run() external {
        address collection = vm.envOr("PERMANENT_COLLECTION", DEFAULT_COLLECTION);
        address vault = vm.envOr("PUNK_VAULT", DEFAULT_VAULT);
        address punkSvgCache = vm.envOr("PUNK_SVG_CACHE", DEFAULT_PUNK_SVG_CACHE);
        address traitIconCache = vm.envOr("TRAIT_ICON_CACHE", DEFAULT_TRAIT_ICON_CACHE);
        address rendererRegistry = vm.envOr("RENDERER_REGISTRY", DEFAULT_RENDERER_REGISTRY);

        require(collection != address(0), "SwapRenderer: zero collection");
        require(vault != address(0), "SwapRenderer: zero vault");
        require(punkSvgCache != address(0), "SwapRenderer: zero punkSvgCache");
        require(traitIconCache != address(0), "SwapRenderer: zero traitIconCache");

        console2.log("reusing collection    ", collection);
        console2.log("reusing vault         ", vault);
        console2.log("reusing punkSvgCache  ", punkSvgCache);
        console2.log("reusing traitIconCache", traitIconCache);
        console2.log("registry (unchanged)  ", rendererRegistry);

        vm.startBroadcast();

        PermanentCollectionProofRenderer proofRenderer = new PermanentCollectionProofRenderer(
            vault, PUNKS_DATA, traitIconCache, punkSvgCache
        );
        console2.log("NEW proofRenderer     ", address(proofRenderer));

        PermanentCollectionMosaicRenderer mosaic = new PermanentCollectionMosaicRenderer(
            collection, vault, punkSvgCache, PUNKS_DATA, traitIconCache, address(proofRenderer)
        );
        console2.log("NEW mosaic (impl)     ", address(mosaic));

        vm.stopBroadcast();

        console2.log("");
        console2.log("Next step (separate confirmed admin tx):");
        console2.log("  cast send", rendererRegistry);
        console2.log("    'setImplementation(address)'", address(mosaic));
    }
}
