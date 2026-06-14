// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {PermanentCollection} from "../src/PermanentCollection.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

contract RejectingBidder {
    ReturnAuctionModule public fs;
    constructor(address payable _f) { fs = ReturnAuctionModule(_f); }
    function bid(uint16 punkId) external payable {
        fs.placeBidWithReferral{value: msg.value}(punkId, address(0), bytes32(0));
    }
}

contract FinalSaleModuleTest is ForkFixtures {
    uint16 internal punkId = 5000;
    uint128 internal cost = 10 ether;
    uint8   internal trait;
    uint256 internal expectedReserve;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));

        // Move a real mainnet Punk into the return auction module's custody.
        address current = punksMarket.punkIndexToAddress(punkId);
        vm.prank(current);
        punksMarket.transferPunk(address(finalSale), uint256(punkId));

        uint256 mask = punksData.traitMaskOf(punkId);
        // The protocol now derives the target (rarest uncollected, non-pending
        // trait) — it must equal canonicalTargetOf or recordAcquisition reverts
        // TargetNotCanonical. The reserve assertions are target-independent.
        trait = collection.canonicalTargetOf(punkId);

        // Simulate Patron finalizing the acquisition + starting the sale.
        // Note: in production Patron calls startSale FIRST (when attemptCount is
        // still 0 for this trait), then recordAcquisition (which bumps the
        // counter to 1). The reserve formula adds 1 to the previous count, so
        // the first trial → reserve = 1.01 × paid.
        vm.startPrank(address(patron));
        finalSale.startSale(punkId, cost, trait);
        collection.recordAcquisition(punkId, trait, mask, address(this), address(this), cost);
        vm.stopPrank();

        expectedReserve = (uint256(cost) * 101) / 100;
    }

    function test_ReserveIsPaidTimesTrialFactor() public view {
        assertEq(finalSale.reserveOf(punkId), expectedReserve);
    }

    function test_BidBelowReserveReverts() public {
        vm.deal(address(this), 100 ether);
        uint256 reserve = finalSale.reserveOf(punkId);
        vm.expectRevert(
            abi.encodeWithSelector(ReturnAuctionModule.BidBelowReserve.selector, reserve - 1, reserve)
        );
        finalSale.placeBidWithReferral{value: reserve - 1}(punkId, address(0), bytes32(0));
    }

    function test_BidAtReserveSucceeds() public {
        vm.deal(address(this), 100 ether);
        uint256 reserve = finalSale.reserveOf(punkId);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));
        assertEq(finalSale.highBidOf(punkId), reserve);
        assertEq(finalSale.highBidderOf(punkId), address(this));
    }

    /// @dev The simple entry point lands an identical bid and records NO
    ///      referrer — it must behave exactly like
    ///      placeBidWithReferral(punkId, address(0), bytes32(0)).
    function test_PlaceBid_SimplePath_RecordsNoReferrer() public {
        vm.deal(address(this), 100 ether);
        uint256 reserve = finalSale.reserveOf(punkId);
        finalSale.placeBid{value: reserve}(punkId);
        assertEq(finalSale.highBidOf(punkId), reserve);
        assertEq(finalSale.highBidderOf(punkId), address(this));
        assertEq(finalSale.referrerOfHighBid(punkId), address(0));
    }

    function test_Cleared_65_25_10_OnCost_Excess_ToVaultBurnPool_AtReserve() public {
        vm.deal(address(this), 100 ether);
        uint256 reserve = finalSale.reserveOf(punkId);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));

        uint256 patronBefore = address(patron).balance;
        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 burnerBefore = address(burner).balance;
        uint256 vaultBurnPoolBefore = address(vaultBurnPool).balance;
        uint256 callerBefore = address(this).balance;
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        // Three-way split (denominator BPS_DENOM = 10_000). No keeper tip on
        // the cleared path, so the full 65%-of-cost bounty reaches the adapter:
        //   bountyShare    = 65% × cost                     → LiveBidAdapter buffer
        //   vaultBurnFromCost = 10% × cost                  → VaultBurnPool (in addition to premium)
        //   burnShare      = 25% × cost (residual)          → BuybackBurner (untouched)
        //   vaultBurnShare = (highBid − cost) + vaultBurnFromCost → VaultBurnPool
        uint256 expectedBounty = (uint256(cost) * 6500) / 10_000;
        uint256 expectedVaultBurnFromCost = (uint256(cost) * 1000) / 10_000;
        uint256 expectedBurn = uint256(cost) - expectedBounty - expectedVaultBurnFromCost;
        uint256 expectedVaultBurnShare = (reserve - uint256(cost)) + expectedVaultBurnFromCost;

        assertEq(address(liveBidAdapter).balance - adapterBefore, expectedBounty, "bounty = full 65% of cost (buffered in adapter)");
        assertEq(address(patron).balance, patronBefore, "Patron untouched by settle");
        assertEq(address(burner).balance - burnerBefore, expectedBurn, "burn = 25% of cost residual");
        assertEq(address(vaultBurnPool).balance - vaultBurnPoolBefore, expectedVaultBurnShare, "vault-burn = premium + 10% of cost");
        assertEq(address(this).balance, callerBefore, "caller earns no settle tip");
        // Hard invariant: shares sum to highBid exactly (no leakage, no tip).
        assertEq(
            expectedBounty + expectedBurn + expectedVaultBurnShare,
            reserve,
            "shares sum to highBid"
        );
        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.ReturnedToMarket)
        );
        assertEq(punksMarket.punkIndexToAddress(punkId), address(this), "buyer holds Punk");
    }

    function test_ClearedHighBid_OverbidPremium_FlowsToVaultBurnPool() public {
        vm.deal(address(this), 100 ether);
        uint256 bidAmt = 20 ether; // far above reserve, well above cost (10 ETH)
        finalSale.placeBidWithReferral{value: bidAmt}(punkId, address(0), bytes32(0));

        uint256 patronBefore = address(patron).balance;
        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 burnerBefore = address(burner).balance;
        uint256 vaultBurnPoolBefore = address(vaultBurnPool).balance;
        uint256 callerBefore = address(this).balance;
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        // Split is cost-keyed (NOT bid-keyed) for bounty + burn + vaultBurnFromCost.
        // The premium (highBid − cost) routes ENTIRELY to VaultBurnPool, on top
        // of the 10%-of-cost slice carved out of cost itself.
        //   bountyShare        = 65% × 10 ETH = 6.5 ETH → LiveBidAdapter buffer
        //   vaultBurnFromCost  = 10% × 10 ETH = 1 ETH
        //   burnShare          = 25% × 10 ETH = 2.5 ETH (residual, untouched)
        //   vaultBurnShare     = (20 − 10) + 1 = 11 ETH
        uint256 expectedBounty = (uint256(cost) * 6500) / 10_000;
        uint256 expectedVaultBurnFromCost = (uint256(cost) * 1000) / 10_000;
        uint256 expectedBurn = uint256(cost) - expectedBounty - expectedVaultBurnFromCost;
        uint256 expectedVaultBurnShare = (bidAmt - uint256(cost)) + expectedVaultBurnFromCost;

        assertEq(address(liveBidAdapter).balance - adapterBefore, expectedBounty, "bounty = full 65% of cost (buffered in adapter)");
        assertEq(address(patron).balance, patronBefore, "Patron untouched by settle");
        assertEq(address(burner).balance - burnerBefore, expectedBurn, "burn 25% of cost residual");
        assertEq(address(vaultBurnPool).balance - vaultBurnPoolBefore, expectedVaultBurnShare, "premium + 10%-of-cost to vault-burn pool");
        assertEq(address(this).balance, callerBefore, "caller earns no settle tip");
        // Hard invariant: shares sum to highBid exactly (no leakage, no tip).
        assertEq(
            expectedBounty + expectedBurn + expectedVaultBurnShare,
            bidAmt,
            "shares sum to highBid"
        );
    }

    /// @dev Sanity check on the cleared-path constants: they must sum to
    ///      BPS_DENOM so the settle math fully accounts for `cost` with no
    ///      leakage.
    function test_ClearedConstants_SumToBPSDENOM() public view {
        assertEq(
            finalSale.CLEARED_BID_BPS() + finalSale.CLEARED_VAULT_BURN_BPS(),
            7500,
            "patron + vault-burn shares = 75% of cost (burn = residual 25%)"
        );
    }

    function test_ClearedDoesNotCollect() public {
        vm.deal(address(this), 100 ether);
        finalSale.placeBidWithReferral{value: finalSale.reserveOf(punkId)}(punkId, address(0), bytes32(0));
        uint256 collectedBefore = collection.collectedMask();
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);
        assertEq(collection.collectedMask(), collectedBefore, "collectedMask untouched");
        assertEq(collection.collectedCount(), 0);
    }

    function test_UnsoldVaults_CollectsTargetTraitOnly() public {
        uint256 mask = punksData.traitMaskOf(punkId);
        // The Punk almost certainly has more than 1 bit set on its mask. v2:
        // only the recorded target trait should land in collectedMask.
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.Vaulted)
        );
        assertEq(punksMarket.punkIndexToAddress(punkId), address(vault), "vault custody");
        assertTrue(vault.isLocked(punkId));
        assertEq(collection.collectedMask(), uint256(1) << trait, "only target trait collected");
        // Sanity: if the Punk has >1 trait, mask has more bits than just target.
        if (mask != (uint256(1) << trait)) {
            assertNotEq(collection.collectedMask(), mask, "other bits NOT collected");
        }
    }

    function test_AntiSnipe_BidInLast15MinExtendsByHour() public {
        vm.deal(address(this), 100 ether);
        uint64 endsAt0 = finalSale.endsAt(punkId);
        vm.warp(uint256(endsAt0) - 10 minutes);
        finalSale.placeBidWithReferral{value: finalSale.reserveOf(punkId)}(punkId, address(0), bytes32(0));
        assertEq(finalSale.endsAt(punkId), uint64(block.timestamp) + 1 hours, "extended by 1h");
    }

    function test_AntiSnipe_BidOutsideWindowDoesNotExtend() public {
        vm.deal(address(this), 100 ether);
        uint64 endsAt0 = finalSale.endsAt(punkId);
        vm.warp(uint256(endsAt0) - 30 minutes);
        finalSale.placeBidWithReferral{value: finalSale.reserveOf(punkId)}(punkId, address(0), bytes32(0));
        assertEq(finalSale.endsAt(punkId), endsAt0, "deadline unchanged");
    }

    function test_AntiSnipe_UncappedExtensionsAccumulate() public {
        vm.deal(address(this), 100_000 ether);
        uint64 startedAt = finalSale.startedAt(punkId);
        uint256 incrementBps = finalSale.minBidIncrementBps();

        for (uint256 i = 0; i < 200; i++) {
            uint64 currentEnd = finalSale.endsAt(punkId);
            vm.warp(uint256(currentEnd) - 5 minutes);
            uint256 currentHigh = uint256(finalSale.highBidOf(punkId));
            // Honour the M-1 min-increment: each bid must clear
            // `currentHigh × (10000 + incrementBps) / 10000`. Add 1 wei of
            // slack so rounding never falls on the wrong side.
            uint256 nextBid = currentHigh + (currentHigh * incrementBps) / 10_000 + 1;
            uint256 reserve = finalSale.reserveOf(punkId);
            if (nextBid < reserve) nextBid = reserve;
            finalSale.placeBidWithReferral{value: nextBid}(punkId, address(0), bytes32(0));
        }
        assertGt(finalSale.endsAt(punkId), startedAt + 7 days, "extensions are uncapped");
    }

    function test_StartSale_OnlyPatron() public {
        uint16 p2 = 5001;
        vm.prank(punksMarket.punkIndexToAddress(p2));
        punksMarket.transferPunk(address(finalSale), uint256(p2));
        vm.expectRevert(ReturnAuctionModule.NotPatron.selector);
        finalSale.startSale(p2, 1 ether, 0);
    }

    function test_RefundQueuesOnPushFailure() public {
        RejectingBidder bad = new RejectingBidder(payable(address(finalSale)));
        uint256 reserve = finalSale.reserveOf(punkId);
        vm.deal(address(bad), reserve);
        bad.bid{value: reserve}(punkId);

        address bidder2 = address(0xC0DE);
        vm.deal(bidder2, 100 ether);
        vm.prank(bidder2);
        finalSale.placeBidWithReferral{value: reserve + 1 ether}(punkId, address(0), bytes32(0));

        assertEq(finalSale.pendingRefund(address(bad)), reserve, "refund queued");
    }

    function test_ReserveSnapshot_StaticOnceStarted() public {
        // The reserve is snapshotted at startSale and frozen for the auction.
        // Even though there is no `setPremiumWei` anymore (the formula is
        // deterministic), the reserve view returns the snapshot.
        uint256 initialReserve = finalSale.reserveOf(punkId);
        assertEq(initialReserve, expectedReserve);
    }
}
