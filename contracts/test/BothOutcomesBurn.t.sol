// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice v2 invariant: BOTH return auction outcomes produce a 111PUNKS supply
///         decrease. Cleared path → 50% of the high bid → BuybackBurner.
///         Vault path → entire VaultBurnPool balance → BuybackBurner.
///         A subsequent `executeStep` swaps the queued ETH for 111PUNKS and
///         calls `token.burn(amount)` on it.
contract BothOutcomesBurnTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
        adminContract.transferAdmin(address(this));
        _fundPatronFromAdapter(30 ether);
    }

    function _findEligiblePunk(uint16 start) internal view returns (uint16) {
        for (uint16 i = start; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible");
    }

    function _emptyQueueByBurning() internal {
        vm.roll(block.number + burner.minBlocksBetweenSteps());
        // Burn in steps until the burner's queue is empty.
        while (burner.remainingEth() > 0) {
            burner.executeStep(0);
            vm.roll(block.number + burner.minBlocksBetweenSteps());
        }
    }

    function test_ClearedPath_ReducesTokenSupply() public {
        uint16 punkId = _findEligiblePunk(100);
        address owner = address(0xCAFE);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Bidder clears at reserve.
        uint256 reserve = finalSale.reserveOf(punkId);
        address bidder = address(0xDEFEA7);
        vm.deal(bidder, reserve);
        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        // 50% of reserve is now queued in BuybackBurner.
        assertGt(burner.remainingEth(), 0, "burner has queued ETH");
        uint256 supplyBefore = token.totalSupply();
        _emptyQueueByBurning();
        assertLt(token.totalSupply(), supplyBefore, "111PUNKS supply decreased");
    }

    function test_VaultPath_ReducesTokenSupply() public {
        uint16 punkId = _findEligiblePunk(500);
        address owner = address(0xCAFE);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Pre-seed the VaultBurnPool. Simulates artcoins fee inflow having
        // accumulated there over the auction window.
        vm.deal(address(this), 2 ether);
        (bool ok,) = address(vaultBurnPool).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(vaultBurnPool.balance(), 2 ether);

        // Settle with no bids → vault path → VaultBurnPool sweeps to burner.
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertEq(vaultBurnPool.balance(), 0, "pool swept");
        assertGt(burner.remainingEth(), 0, "burner has queued ETH");

        uint256 supplyBefore = token.totalSupply();
        _emptyQueueByBurning();
        assertLt(token.totalSupply(), supplyBefore, "111PUNKS supply decreased");
    }
}
