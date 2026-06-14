// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {ICryptoPunksMarket} from "../../src/interfaces/ICryptoPunksMarket.sol";

/// @notice Manipulates the real CryptoPunksMarket on a fork by impersonating
///         existing Punk owners. No mocks.
library PunkSeeder {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Move a Punk to a target address by impersonating its current owner.
    function giveTo(ICryptoPunksMarket market, uint16 punkId, address to) internal {
        address currentOwner = market.punkIndexToAddress(uint256(punkId));
        require(currentOwner != address(0), "PunkSeeder: unowned");
        if (currentOwner != to) {
            vm.prank(currentOwner);
            market.transferPunk(to, uint256(punkId));
        }
    }

    /// @notice List a Punk for sale at a given wei price.
    function listForSale(ICryptoPunksMarket market, uint16 punkId, uint256 priceWei) internal {
        address owner = market.punkIndexToAddress(uint256(punkId));
        require(owner != address(0), "PunkSeeder: unowned");
        vm.prank(owner);
        market.offerPunkForSale(uint256(punkId), priceWei);
    }

    /// @notice Atomically give to `to` and list at `priceWei`.
    function giveAndList(ICryptoPunksMarket market, uint16 punkId, address to, uint256 priceWei) internal {
        giveTo(market, punkId, to);
        vm.prank(to);
        market.offerPunkForSale(uint256(punkId), priceWei);
    }
}
