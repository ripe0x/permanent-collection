// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {TraitIconCache} from "../src/TraitIconCache.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Invariants for the block-driven rotation of uncollected cells
///         on rare types {Alien, Ape, Zombie} and their matching head
///         variants. These six trait ids cannot pin a single canonical
///         Punk without locking a specific accessory into the artwork
///         forever — instead they cycle per block through the on-chain
///         pool of all members of the type. The cycling stops the
///         moment a Punk is vaulted for that trait (the collected branch
///         draws `firstVaultedPunk` directly).
contract MosaicRotationTest is ForkFixtures {
    PermanentCollectionMosaicRenderer r;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        punkSvgCache = new PunkSvgFragmentCache(PUNKS_DATA);
        traitIconCache = new TraitIconCache(PUNKS_DATA);
        proofRenderer = new PermanentCollectionProofRenderer(
            address(vault), PUNKS_DATA, address(traitIconCache), address(punkSvgCache)
        );
        r = new PermanentCollectionMosaicRenderer(
            address(collection), address(vault), address(punkSvgCache), PUNKS_DATA, address(traitIconCache), address(proofRenderer)
        );
    }

    /// @notice Rolling the block forward shifts the SVG bytes. Proves the
    ///         rotation is actually wired to `block.number` rather than
    ///         being silently ignored.
    function test_Rotation_BlockNumberShiftsSvgBytes() public {
        vm.roll(20_000_000);
        bytes32 a = keccak256(bytes(r.svg()));
        vm.roll(20_000_001);
        bytes32 b = keccak256(bytes(r.svg()));
        vm.roll(20_000_002);
        bytes32 c = keccak256(bytes(r.svg()));
        assertTrue(a != b, "SVG should differ between block N and N+1");
        assertTrue(b != c, "SVG should differ between block N+1 and N+2");
        assertTrue(a != c, "SVG should differ between block N and N+2");
    }

    /// @notice Same call at the same block returns the same bytes. The
    ///         renderer stays deterministic per-block — only the seed
    ///         (`block.number`) moves it forward. Critical for marketplace
    ///         caches.
    function test_Rotation_DeterministicWithinBlock() public {
        vm.roll(20_000_000);
        bytes32 a = keccak256(bytes(r.svg()));
        bytes32 a2 = keccak256(bytes(r.svg()));
        assertEq(a, a2, "two reads at the same block must match");
    }
}
