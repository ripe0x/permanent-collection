// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {ReturnAuctionEscrow} from "../src/ReturnAuctionEscrow.sol";
import {PermanentCollection} from "../src/PermanentCollection.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Verifies the cleared return auction settle records a real
///         `PunkBought(escrow, module, highBid)` on the canonical CryptoPunks
///         market — the provenance round-trip — and still delivers the Punk
///         to the winning bidder with the proceeds split intact.
contract FinalSaleEscrowProvenanceTest is ForkFixtures {
    // PunkBought(uint256 indexed punkIndex, uint256 value, address indexed fromAddress, address indexed toAddress)
    bytes32 internal constant PUNK_BOUGHT_SIG =
        keccak256("PunkBought(uint256,uint256,address,address)");

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

    function test_Escrow_IsDeployedAndPinnedToModule() public view {
        ReturnAuctionEscrow esc = finalSale.escrow();
        assertTrue(address(esc) != address(0), "escrow deployed");
        assertEq(esc.MODULE(), address(finalSale), "escrow pinned to module");
        assertEq(address(esc.punksMarket()), address(punksMarket), "escrow market wired");
    }

    function test_ClearedSettle_RecordsPunkBoughtAtHammerPrice() public {
        vm.deal(address(this), 100 ether);
        uint256 highBid = 20 ether; // above reserve
        finalSale.placeBidWithReferral{value: highBid}(punkId, address(0), bytes32(0));

        address escAddr = address(finalSale.escrow());

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        vm.recordLogs();
        finalSale.settle(punkId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(punksMarket)) continue;
            if (l.topics.length != 4 || l.topics[0] != PUNK_BOUGHT_SIG) continue;

            uint256 boughtPunk = uint256(l.topics[1]);
            address from = address(uint160(uint256(l.topics[2])));
            address to = address(uint160(uint256(l.topics[3])));
            uint256 value = abi.decode(l.data, (uint256));
            if (boughtPunk != uint256(punkId)) continue;

            assertEq(from, escAddr, "seller of record = escrow");
            assertEq(to, address(finalSale), "buyer of record = module");
            assertEq(value, highBid, "recorded sale price = hammer price");
            found = true;
            break;
        }
        assertTrue(found, "PunkBought(escrow, module, highBid) emitted on cleared settle");

        // Winner ends up owning the Punk; nothing stranded in the escrow.
        assertEq(punksMarket.punkIndexToAddress(punkId), address(this), "winner holds Punk");
        assertEq(escAddr.balance, 0, "escrow holds no residual ETH");
        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.ReturnedToMarket),
            "custody = ReturnedToMarket"
        );
    }

    function test_ClearedSettle_ProceedsSplitUnchangedByRoundTrip() public {
        vm.deal(address(this), 100 ether);
        uint256 highBid = 20 ether;
        finalSale.placeBidWithReferral{value: highBid}(punkId, address(0), bytes32(0));

        uint256 patronBefore = address(patron).balance;
        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 burnerBefore = address(burner).balance;
        uint256 vaultBurnPoolBefore = address(vaultBurnPool).balance;

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        // Three-way split:
        //   bountyShare       = 65% × cost → LiveBidAdapter buffer
        //   vaultBurnFromCost = 10% × cost (in addition to premium)
        //   burnShare         = 25% × cost (residual, untouched)
        //   vaultBurnShare    = (highBid - cost) + vaultBurnFromCost
        uint256 expectedBounty = (uint256(cost) * 6500) / 10_000;
        uint256 expectedVaultBurnFromCost = (uint256(cost) * 1000) / 10_000;
        uint256 expectedBurn = uint256(cost) - expectedBounty - expectedVaultBurnFromCost;
        uint256 expectedVaultBurn = (highBid - uint256(cost)) + expectedVaultBurnFromCost;

        assertEq(address(burner).balance - burnerBefore, expectedBurn, "burn = 25% of cost residual");
        assertEq(
            address(liveBidAdapter).balance - adapterBefore,
            expectedBounty,
            "bounty = full 65% of cost (buffered in adapter)"
        );
        assertEq(address(patron).balance, patronBefore, "Patron untouched by settle");
        assertEq(
            address(vaultBurnPool).balance - vaultBurnPoolBefore,
            expectedVaultBurn,
            "vault-burn pool got premium + 10%-of-cost slice"
        );
    }
}
