// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice End-to-end V4 flow: bounty accepted → return auction clears OR
///         times out → traits collected only on the unsold path.
contract IntegrationFlowTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
        adminContract.transferAdmin(address(this));
        // Pre-fund the live bid so acceptBid has something to pay out.
        _fundPatronFromAdapter(30 ether);
    }

    function _findPunkWithTrait(uint8 traitBit) internal view returns (uint16) {
        for (uint16 i = 0; i < 10_000; i++) {
            if ((punksData.traitMaskOf(i) >> traitBit) & 1 == 1) return i;
        }
        revert("no Punk with trait");
    }

    function test_FullFlow_AcceptBounty_FinalSaleClears_NoCollection() public {
        uint16 punkId = _findPunkWithTrait(69); // Mohawk carrier
        // Target is protocol-derived; the cleared-path assertions below are
        // target-independent (collectedMask stays 0 on the cleared/rescue path).
        uint8 trait = collection.canonicalTargetOf(punkId);
        address owner = address(0xCAFE01);

        // Owner takes custody and lists to Patron at the live bid.
        _giveAndOfferToBounty(owner, punkId);

        uint256 hubBalBefore = address(patron).balance;
        vm.prank(owner);
        patron.acceptBid(punkId, trait, type(uint256).max);
        uint256 expectedPayout = hubBalBefore;

        // Owner is credited the listed price by the market; Patron is empty.
        assertEq(punksMarket.pendingWithdrawals(owner), expectedPayout, "owner credited the listed price");
        assertEq(address(patron).balance, 0, "listed price paid out");

        // Punk in return auction; no collection yet.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.InReturnAuction)
        );
        assertEq(collection.collectedMask(), 0, "no collection on acquisition");

        // A buyer clears the Punk at reserve.
        address buyer = address(0xDEFEA7);
        uint256 reserve = finalSale.reserveOf(punkId);
        vm.deal(buyer, reserve);
        vm.prank(buyer);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        // Cleared → buyer holds Punk; 65/25/10-plus-excess split applies.
        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.ReturnedToMarket)
        );
        assertEq(collection.collectedMask(), 0, "still uncollected");
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), buyer);

        // Three-way split (no keeper tip — the full 65% reaches the adapter):
        //   bountyShare       = 65% × cost (acquisitionCost = expectedPayout) → LiveBidAdapter buffer
        //   vaultBurnFromCost = 10% × cost (in addition to premium)
        //   burnShare         = 25% × cost (residual)
        //   vaultBurnShare    = (highBid - cost) + vaultBurnFromCost
        uint256 cost = expectedPayout;
        uint256 expectedBounty = (cost * 6500) / 10_000;
        uint256 expectedVaultBurnFromCost = (cost * 1000) / 10_000;
        uint256 expectedBurn = cost - expectedBounty - expectedVaultBurnFromCost;
        uint256 expectedVaultBurn = (reserve - cost) + expectedVaultBurnFromCost; // bidder paid exactly reserve
        // Patron was emptied to 0 by acceptBid; the cleared bounty now buffers
        // in LiveBidAdapter (settle no longer touches Patron — it meters in on a
        // later sweep).
        assertEq(address(liveBidAdapter).balance, expectedBounty, "bounty = full 65% of cost (buffered in adapter)");
        assertEq(address(patron).balance, 0, "Patron untouched by settle");
        assertEq(address(burner).balance, expectedBurn, "burn = 25% of cost residual");
        assertEq(address(vaultBurnPool).balance, expectedVaultBurn, "premium + 10%-of-cost to vault-burn pool");
    }

    function test_FullFlow_AcceptBounty_FinalSaleUnsold_Collects() public {
        uint16 punkId = _findPunkWithTrait(69);
        // Target is protocol-derived; the vault path collects exactly it.
        uint8 trait = collection.canonicalTargetOf(punkId);
        address owner = address(0xCAFE01);
        _giveAndOfferToBounty(owner, punkId);

        vm.prank(owner);
        patron.acceptBid(punkId, trait, type(uint256).max);

        // Nobody bids; expires → vault. v2: only the target trait collects.
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.Vaulted)
        );
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(vault));
        assertEq(collection.collectedMask(), uint256(1) << trait, "only target collected");
    }

    function test_PendingDoesNotTriggerCompletion() public {
        _setCollectedMask((uint256(1) << 110) - 1); // bits 0..109
        assertFalse(collection.isComplete());

        uint16 punkId = type(uint16).max;
        for (uint16 i = 0; i < 10_000; i++) {
            if ((punksData.traitMaskOf(i) >> 110) & 1 == 1) { punkId = i; break; }
        }
        if (punkId == type(uint16).max) return;

        address owner = address(0xCAFE03);
        _giveAndOfferToBounty(owner, punkId);
        // Bits 0..109 are collected, so 110 is the only uncollected trait on
        // any Punk — canonical derives to 110 here.
        uint8 target = collection.canonicalTargetOf(punkId);
        assertEq(target, 110, "only bit 110 left to collect");
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        assertFalse(collection.isComplete(), "pending must not trigger completion");
        assertTrue(collection.isPending(110), "trait pending");
        assertFalse(collection.isCollected(110), "not yet collected");

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertTrue(collection.isCollected(110), "now collected");
        assertTrue(collection.isComplete(), "FULL SET COMPLETE");
    }
}
