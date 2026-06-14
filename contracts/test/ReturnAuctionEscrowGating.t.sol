// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReturnAuctionEscrow} from "../src/ReturnAuctionEscrow.sol";

/// @notice Access-control unit tests for ReturnAuctionEscrow: only the module that
///         deployed it may drive it, and only the Punk market may pay it. No
///         fork needed — the escrow constructor just sets immutables.
contract FinalSaleEscrowGatingTest is Test {
    address internal constant MARKET = 0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB;

    ReturnAuctionEscrow internal escrow;
    address internal stranger = address(0xBEEF);

    function setUp() public {
        // This test contract is the deployer, so MODULE == address(this).
        escrow = new ReturnAuctionEscrow(MARKET);
    }

    function test_PinsModuleAndMarket() public view {
        assertEq(escrow.MODULE(), address(this), "module = deployer");
        assertEq(address(escrow.punksMarket()), MARKET, "market wired");
    }

    function test_listForSettlement_RevertsForNonModule() public {
        vm.prank(stranger);
        vm.expectRevert(ReturnAuctionEscrow.NotModule.selector);
        escrow.listForSettlement(1, 1 ether);
    }

    function test_sweepProceeds_RevertsForNonModule() public {
        vm.prank(stranger);
        vm.expectRevert(ReturnAuctionEscrow.NotModule.selector);
        escrow.sweepProceeds();
    }

    function test_receive_RejectsNonMarketSender() public {
        // address(this) is a non-market sender (and is even the MODULE — the
        // receive guard allows only the market, not the module). The send must
        // fail and no ETH may land.
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(escrow).call{value: 1 ether}("");
        assertFalse(ok, "non-market ETH send must fail");
        assertEq(address(escrow).balance, 0, "escrow rejected non-market ETH");
    }

    function test_receive_AcceptsFromMarket() public {
        vm.deal(MARKET, 1 ether);
        vm.prank(MARKET);
        (bool ok,) = address(escrow).call{value: 1 ether}("");
        assertTrue(ok, "escrow accepts ETH from the Punk market");
        assertEq(address(escrow).balance, 1 ether, "market ETH held");
    }
}
