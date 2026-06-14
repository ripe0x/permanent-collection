// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice v2 invariant: a vault outcome collects ONLY the recorded
///         `targetTraitId`, even if the Punk carries 3+ uncollected traits.
///         Other uncollected bits stay available for future acquisitions.
contract VaultOutcomeTargetOnlyTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        _fundPatronFromAdapter(30 ether);
    }

    function _findPunkWithAtLeastNUncollectedBits(uint16 start, uint8 n)
        internal view returns (uint16)
    {
        uint256 collected = collection.collectedMask();
        for (uint16 i = start; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            uint256 open = mask & ~collected;
            uint8 popcount;
            for (uint8 b = 0; b < 111; b++) {
                if ((open >> b) & 1 == 1) popcount++;
            }
            if (popcount >= n) return i;
        }
        revert("no punk with N uncollected");
    }

    function test_VaultCollectsOnlyTarget_NotEntireMask() public {
        uint16 punkId = _findPunkWithAtLeastNUncollectedBits(100, 3);
        uint256 mask = punksData.traitMaskOf(punkId);

        // Target is protocol-derived (the rarest uncollected non-pending bit).
        // The Punk still carries ≥3 uncollected bits, so "only one of several
        // collected" remains the meaningful assertion.
        uint8 target = collection.canonicalTargetOf(punkId);

        address owner = address(0xCAFE);
        _giveAndOfferToBounty(owner, punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // No bids → vault.
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.Vaulted)
        );

        // ONLY the target bit is set in collectedMask. Mask had ≥ 3 uncollected
        // bits; only one collected now.
        uint256 collected = collection.collectedMask();
        assertEq(collected, uint256(1) << target, "only target collected");
        assertEq(collection.collectedCount(), 1, "exactly one trait collected");

        // The non-target bits on the Punk's mask remain uncollected and
        // available for future acquisitions to target.
        for (uint8 i = 0; i < 111; i++) {
            if ((mask >> i) & 1 == 1 && i != target) {
                assertFalse(collection.isCollected(i), "non-target stays uncollected");
                // Pending counter released (regardless of outcome).
                assertEq(collection.pendingTraitCount(i), 0);
            }
        }
    }

    function test_VaultedPunkStaysInVault() public {
        uint16 punkId = _findPunkWithAtLeastNUncollectedBits(200, 2);
        uint8 target = collection.canonicalTargetOf(punkId);

        address owner = address(0xCAFE);
        _giveAndOfferToBounty(owner, punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(vault));
        assertTrue(vault.isLocked(punkId));
    }
}
