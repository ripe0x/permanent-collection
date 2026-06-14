// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @title  FinalSaleBoundary
/// @notice Off-by-one canary around the `endsAt` boundary. The module uses
///         the following inequalities (verbatim from `ReturnAuctionModule.sol`):
///
///             bid():    `if (block.timestamp >= s.endsAt) revert SaleEnded;`
///             settle(): `if (block.timestamp <  s.endsAt) revert SaleLive;`
///
///         So the boundary is:
///           - at `endsAt - 1`: bid accepted (anti-snipe extends if within
///             the 15-min trigger window), settle reverts as SaleLive.
///           - at `endsAt`:     bid reverts as SaleEnded, settle SUCCEEDS.
///           - at `endsAt + 1`: bid reverts as SaleEnded, settle SUCCEEDS.
///
///         These tests pin those inequalities so any future change to the
///         module's deadline arithmetic surfaces immediately.
contract FinalSaleBoundaryTest is ForkFixtures {
    uint16 internal punkId = 5000;
    uint128 internal cost = 10 ether;
    uint8 internal trait;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));

        address current = punksMarket.punkIndexToAddress(punkId);
        vm.prank(current);
        punksMarket.transferPunk(address(finalSale), uint256(punkId));

        uint256 mask = punksData.traitMaskOf(punkId);
        trait = collection.canonicalTargetOf(punkId);
        vm.startPrank(address(patron));
        finalSale.startSale(punkId, cost, trait);
        collection.recordAcquisition(punkId, trait, mask, address(this), address(this), cost);
        vm.stopPrank();
    }

    /// @notice At `endsAt - 1`, a bid is still accepted AND triggers the
    ///         anti-snipe extension (1s is well inside the 15-min trigger
    ///         window). Confirms the `<` half of the `block.timestamp >= endsAt`
    ///         revert.
    function test_BidAtEndsAtMinus1_Accepted_AndExtends() public {
        uint64 endsAt0 = finalSale.endsAt(punkId);
        vm.warp(uint256(endsAt0) - 1);
        vm.deal(address(this), 100 ether);
        uint256 reserve = finalSale.reserveOf(punkId);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));

        assertEq(finalSale.highBidOf(punkId), uint128(reserve), "bid recorded");
        // Inside the 15-min trigger window, so endsAt extends by 1h.
        assertEq(
            finalSale.endsAt(punkId),
            uint64(block.timestamp) + 1 hours,
            "anti-snipe extension fires within 15-min window"
        );
    }

    /// @notice At `endsAt` exactly, `bid()` reverts as `SaleEnded`. Pins the
    ///         `>=` half of the comparison — a timestamp equal to endsAt is
    ///         already past the window.
    function test_BidAtEndsAt_Reverts() public {
        uint64 endsAt0 = finalSale.endsAt(punkId);
        uint256 reserve = finalSale.reserveOf(punkId);
        vm.warp(uint256(endsAt0));
        vm.deal(address(this), 100 ether);
        // NB: hoist `reserveOf` above the expectRevert — inlining it would
        // bind expectRevert to that staticcall rather than to `bid`.
        vm.expectRevert(abi.encodeWithSelector(ReturnAuctionModule.SaleEnded.selector, punkId));
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));
    }

    /// @notice At `endsAt` exactly, `settle()` SUCCEEDS — the inequality on
    ///         the settle side is strict `<`, so equality belongs to the
    ///         settleable side. This is the exact-boundary case (no slack).
    function test_SettleAtEndsAt_Succeeds() public {
        uint64 endsAt0 = finalSale.endsAt(punkId);
        vm.warp(uint256(endsAt0));
        // No bids — vault path. Punk goes to PunkVault and only the target
        // trait gets collected.
        finalSale.settle(punkId);

        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.Vaulted),
            "vault custody after settle at endsAt"
        );
        assertEq(
            punksMarket.punkIndexToAddress(uint256(punkId)),
            address(vault),
            "punk owned by vault"
        );
        assertTrue(vault.isLocked(punkId), "punk locked in vault");
    }

    /// @notice At `endsAt - 1`, `settle()` reverts as `SaleLive`. The 1-second
    ///         gap below endsAt is still inside the live window.
    function test_SettleAtEndsAtMinus1_Reverts() public {
        uint64 endsAt0 = finalSale.endsAt(punkId);
        vm.warp(uint256(endsAt0) - 1);
        vm.expectRevert(abi.encodeWithSelector(ReturnAuctionModule.SaleLive.selector, punkId));
        finalSale.settle(punkId);
    }

    /// @notice At `endsAt + 1`, `settle()` SUCCEEDS. Confirms there's no
    ///         off-by-one on the strict-less-than comparison. Also exercises
    ///         the cleared settlement at the boundary.
    function test_SettleAtEndsAtPlus1_Succeeds_AndCustodyTransitions() public {
        uint64 endsAt0 = finalSale.endsAt(punkId);

        // Place a single reserve-clearing bid OUTSIDE the snipe window so
        // endsAt stays unchanged. Then warp to endsAt+1 and settle.
        vm.warp(uint256(endsAt0) - 30 minutes);
        vm.deal(address(this), 100 ether);
        finalSale.placeBidWithReferral{value: finalSale.reserveOf(punkId)}(punkId, address(0), bytes32(0));
        assertEq(finalSale.endsAt(punkId), endsAt0, "no extension outside window");

        vm.warp(uint256(endsAt0) + 1);
        finalSale.settle(punkId);

        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.ReturnedToMarket),
            "cleared: custody returnedToMarket"
        );
        assertEq(
            punksMarket.punkIndexToAddress(uint256(punkId)),
            address(this),
            "cleared: buyer holds punk"
        );
    }
}

