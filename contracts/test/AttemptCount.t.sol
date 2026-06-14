// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PermanentCollection} from "../src/PermanentCollection.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Verifies the v2 trial counter + reserve formula. Every acquisition
///         targeting trait `t` bumps `attemptCount[t]`. The next return auction's
///         reserve is `paid x (100 + attemptCount[t]) / 100` (with the count
///         INCLUDING this acquisition — first trial → 1.01x, second → 1.02x).
contract TrialCountTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
    }

    function test_TrialCount_BumpsOnRecordAcquisition() public {
        uint16 punkId = 100;
        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 target = collection.canonicalTargetOf(punkId);
        assertEq(collection.attemptCount(target), 0, "starts at 0");
        vm.prank(address(patron));
        collection.recordAcquisition(punkId, target, mask, address(this), address(this), 1 ether);
        assertEq(collection.attemptCount(target), 1, "bumps to 1 on record");
    }

    function test_TrialCount_Monotonic_AcrossClearedAndVault() public {
        // attemptCount escalates per re-acquisition of the SAME Punk: a cleared
        // (ReturnedToMarket) Punk re-enters the return auction and targets the
        // same still-uncollected trait (its canonical target is unchanged once
        // the prior auction released the pending claim). Using one Punk keeps
        // the canonical target stable across both trials.
        uint16 punkA = 100;
        uint256 maskA = punksData.traitMaskOf(punkA);
        uint8 sharedTrait = collection.canonicalTargetOf(punkA);

        // Record A (trial 1).
        vm.prank(address(patron));
        collection.recordAcquisition(punkA, sharedTrait, maskA, address(this), address(this), 1 ether);
        assertEq(collection.attemptCount(sharedTrait), 1);

        // Cleared path on A: ReturnedToMarket. Counter must NOT decrement.
        vm.prank(address(finalSale));
        collection.markCustody(punkA, IPermanentCollection.Custody.ReturnedToMarket);
        assertEq(collection.attemptCount(sharedTrait), 1, "no decrement on cleared");

        // Re-acquiring the SAME Punk targets the same (still uncollected,
        // no-longer-pending) trait — canonical is unchanged.
        assertEq(collection.canonicalTargetOf(punkA), sharedTrait, "canonical unchanged on re-acquire");
        vm.prank(address(patron));
        collection.recordAcquisition(punkA, sharedTrait, maskA, address(this), address(this), 1 ether);
        assertEq(collection.attemptCount(sharedTrait), 2, "second trial");

        // Vault path on the re-acquisition: counter still doesn't decrement.
        vm.prank(address(finalSale));
        collection.markCustody(punkA, IPermanentCollection.Custody.Vaulted);
        assertEq(collection.attemptCount(sharedTrait), 2, "monotonic after vault");
    }

    function test_ReserveFormula_FirstTrial_IsOnePointZeroOne() public {
        uint16 punkId = 200;
        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 target = collection.canonicalTargetOf(punkId);

        // Move Punk into finalSale custody.
        vm.prank(punksMarket.punkIndexToAddress(punkId));
        punksMarket.transferPunk(address(finalSale), uint256(punkId));

        uint128 paid = 7 ether;
        vm.prank(address(patron));
        finalSale.startSale(punkId, paid, target);
        vm.prank(address(patron));
        collection.recordAcquisition(punkId, target, mask, address(this), address(this), paid);

        assertEq(finalSale.reserveOf(punkId), (uint256(paid) * 101) / 100, "1.01x paid");
    }

    function test_ReserveFormula_SecondTrial_IsOnePointZeroTwo() public {
        // attemptCount escalation is per-trait and accrues across re-acquisitions
        // of the SAME Punk (the canonical target stays fixed once the prior
        // auction released its pending claim). Trial 1 bumps the counter via a
        // records-only acquisition + cleared (ReturnedToMarket) settle; trial 2
        // opens a real sale whose reserve reads attemptCount == 1 → paid x 102/100.
        uint16 punkId = 200;
        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 target = collection.canonicalTargetOf(punkId);

        // Trial 1: record + cleared. attemptCount[target] = 1, trait NOT collected.
        vm.prank(address(patron));
        collection.recordAcquisition(punkId, target, mask, address(this), address(this), 1 ether);
        vm.prank(address(finalSale));
        collection.markCustody(punkId, IPermanentCollection.Custody.ReturnedToMarket);
        assertEq(collection.attemptCount(target), 1, "trial 1 bumped");
        // Canonical is unchanged on re-acquire (uncollected + no longer pending).
        assertEq(collection.canonicalTargetOf(punkId), target, "canonical stable");

        // Trial 2: open a real sale on the SAME Punk. startSale reads attemptCount
        // (== 1) BEFORE recordAcquisition bumps it; reserve formula adds 1 → 102/100.
        vm.prank(punksMarket.punkIndexToAddress(punkId));
        punksMarket.transferPunk(address(finalSale), uint256(punkId));

        uint128 paid = 10 ether;
        vm.prank(address(patron));
        finalSale.startSale(punkId, paid, target);
        vm.prank(address(patron));
        collection.recordAcquisition(punkId, target, mask, address(this), address(this), paid);

        assertEq(finalSale.reserveOf(punkId), (uint256(paid) * 102) / 100, "1.02x on 2nd trial");
        assertEq(collection.attemptCount(target), 2);
    }
}
