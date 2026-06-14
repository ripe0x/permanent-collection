// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PermanentCollection} from "../src/PermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Stress test for `PermanentCollection.attemptCount[uint8]`.
///         The counter must outlive a permanent protocol, so it is intentionally
///         wider than the 65_535 trials a uint16 could represent.
contract TrialCountOverflowTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
    }

    /// @notice At `type(uint16).max` trials, the reserve premium is +655.36x
    ///         of paid. The formula must not silently overflow into the uint128
    ///         reserve snapshot.
    function test_TrialCount_ReserveFormulaSurvivesNearUint16Max() public pure {
        // Reserve formula: paid × (101 + trials) / 100.
        // At trials = type(uint16).max = 65_535:
        //   reserve = paid × 65_636 / 100
        // Reserve is cast to uint128 inside startSale (`ReserveOverflow`
        // reverts if it doesn't fit). For paid = 1 ETH, reserve = ~656 ETH —
        // safely under uint128.max ≈ 3.4e38.
        uint256 trials = type(uint16).max;
        uint128 paid = 1 ether;
        uint256 expected = (uint256(paid) * (101 + trials)) / 100;
        // Fits in uint128.
        assertLe(expected, type(uint128).max, "reserve exceeds uint128 at uint16-max trials");

        // Stress the formula at the multiplicative edge — what paid value
        // would push the reserve right up to uint128 max with N trials?
        // reserve = paid × (101 + trials) / 100 ≤ uint128.max
        // → paid ≤ uint128.max × 100 / (101 + trials)
        // At trials = uint16.max, max paid = uint128.max × 100 / 65_636 ≈ 5.18e35.
        // Any payment under that should accept; over should `ReserveOverflow`.
        uint256 maxPaidAtTrialsMax = (uint256(type(uint128).max) * 100) / (101 + trials);
        assertGt(maxPaidAtTrialsMax, 1e30, "max paid bound too low: reserve formula too restrictive");
    }

    /// @notice Synthetic test: directly write a post-uint16 `attemptCount`,
    ///         then verify reserve math and the next real acquisition keep the
    ///         full widened value rather than wrapping.
    function test_TrialCount_CanExceedUint16Max_ReserveAndIncrementUseFullValue() public {
        uint16 punkId = 200;
        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 target = collection.canonicalTargetOf(punkId);
        uint256 mappingSlot = _findTrialCountSlot(target);

        uint256 spoofed = uint256(type(uint16).max) + 1;
        bytes32 storageKey = keccak256(abi.encode(uint256(target), mappingSlot));
        vm.store(address(collection), storageKey, bytes32(spoofed));
        assertEq(collection.attemptCount(target), spoofed, "storage poke didn't land");

        vm.prank(punksMarket.punkIndexToAddress(punkId));
        punksMarket.transferPunk(address(finalSale), uint256(punkId));

        uint128 paid = 1 ether;
        uint256 expectedReserve = (uint256(paid) * (101 + spoofed)) / 100;
        vm.prank(address(patron));
        finalSale.startSale(punkId, paid, target);
        assertEq(finalSale.reserveOf(punkId), expectedReserve, "reserve read full widened count");

        vm.prank(address(patron));
        collection.recordAcquisition(punkId, target, mask, address(this), address(this), paid);
        assertEq(collection.attemptCount(target), spoofed + 1, "record increments above uint16 max");
    }

    /// @dev Probe storage to find the slot where `attemptCount[traitId]` lives.
    function _findTrialCountSlot(
        uint8 traitId
    ) internal returns (uint256) {
        // Try slots 0..40. For each slot s, mapping key = keccak256(traitId, s).
        // Write a sentinel, read attemptCount, restore on mismatch.
        uint256 sentinel = uint256(type(uint16).max) + 123;
        for (uint256 s = 0; s < 40; s++) {
            bytes32 key = keccak256(abi.encode(uint256(traitId), s));
            bytes32 original = vm.load(address(collection), key);
            vm.store(address(collection), key, bytes32(sentinel));
            if (collection.attemptCount(traitId) == sentinel) {
                vm.store(address(collection), key, original);
                return s;
            }
            vm.store(address(collection), key, original);
        }
        revert("attemptCount slot not found");
    }
}
