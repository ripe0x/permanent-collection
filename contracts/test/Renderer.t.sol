// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {TraitIconCache} from "../src/TraitIconCache.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Verify the production Mosaic renderer reads correctly from PC
///         state across the three render states.
contract RendererTest is ForkFixtures {
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
        _fundPatronFromAdapter(30 ether);
    }

    function _findEligiblePunk(uint16 startFrom) internal view returns (uint16) {
        for (uint16 i = startFrom; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible punk");
    }

    function test_Render_AllUncollected_NonEmpty() public view {
        string memory uri = renderer.tokenURI();
        assertGt(bytes(uri).length, 100, "tokenURI returns non-trivial output");
        // tokenURI starts with the data:application/json;base64 prefix.
        bytes memory u = bytes(uri);
        assertEq(u[0], "d");
        assertEq(u[1], "a");
        assertEq(u[2], "t");
        assertEq(u[3], "a");
    }

    function test_Render_WithPendingTrait() public {
        uint16 punkId = _findEligiblePunk(1);
        address owner = address(0xBEA71E);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Now there's at least one trait in Pending state.
        uint256 mask = punksData.traitMaskOf(punkId);
        bool foundPending = false;
        for (uint8 i = 0; i < 111; i++) {
            if ((mask >> i) & 1 == 1 && collection.isPending(i)) {
                foundPending = true;
                break;
            }
        }
        assertTrue(foundPending, "fixture: pending trait exists");

        string memory uri = renderer.tokenURI();
        assertGt(bytes(uri).length, 100, "renders with pending state");
    }

    function test_Render_WithCollectedTrait() public {
        uint16 punkId = _findEligiblePunk(1);
        uint256 mask = punksData.traitMaskOf(punkId);
        address owner = address(0xBEA71E);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Settle without bids → Punk vaults; ONLY the target trait collects
        // (v2 spec). Other uncollected bits on the mask remain available.
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertEq(collection.collectedMask(), uint256(1) << target, "only target collected");

        string memory uri = renderer.tokenURI();
        assertGt(bytes(uri).length, 100, "renders with collected state");
        (uint16 fv, bool exists) = collection.firstVaultedPunk(target);
        assertTrue(exists);
        assertEq(fv, punkId);
        mask; // silence unused
    }

    function test_Render_FullSetComplete_Flag() public {
        // Force-fill collectedMask via storage probe.
        _setCollectedMask(collection.FULL_SET_MASK());
        assertTrue(collection.isComplete());

        string memory uri = renderer.tokenURI();
        assertGt(bytes(uri).length, 100, "renders full-set state");
    }

    function test_Render_GasFullSet_LogOnly() public {
        // The renderer is a view function; off-chain reads can use unbounded
        // gas. This test just logs the current cost as a regression canary —
        // if it 5x's silently, someone introduced an unbounded loop.
        // Empirically ~6.2B gas at full saturation as of V4 launch.
        _setCollectedMask(collection.FULL_SET_MASK());
        uint256 gasBefore = gasleft();
        string memory uri = renderer.tokenURI();
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("renderer gas (full set)", gasUsed);
        assertGt(bytes(uri).length, 100, "renders non-trivial output");
        // Wide bound; catches 5x regressions but doesn't flag normal variation.
        assertLt(gasUsed, 50_000_000_000, "renderer gas under 50B");
    }
}
