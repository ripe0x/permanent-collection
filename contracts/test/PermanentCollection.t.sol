// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PermanentCollection} from "../src/PermanentCollection.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

contract PermanentCollectionTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
    }

    function test_DatasetHashPinAtConstruct() public view {
        assertEq(punksData.datasetHash(), collection.EXPECTED_DATASET_HASH());
    }

    function test_RecordAcquisition_DoesNotCollect() public {
        uint16 punkId = 1;
        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 target = collection.canonicalTargetOf(punkId);

        vm.prank(address(patron));
        collection.recordAcquisition(punkId, target, mask, address(this), address(this), 50 ether);

        // collectedMask stays zero — acquisition does not collect.
        assertEq(collection.collectedMask(), 0, "collectedMask untouched");
        assertEq(collection.collectedCount(), 0);
        assertEq(collection.acquisitionCount(), 1);

        // Pending counters were incremented only for the selected target trait.
        uint256 targetBit = uint256(1) << target;
        assertEq(collection.pendingAcquisitionMaskOf(punkId), targetBit);
        for (uint8 i = 0; i < 111; i++) {
            if ((mask >> i) & 1 == 1) {
                assertEq(collection.pendingTraitCount(i), i == target ? 1 : 0, "pending count");
                assertEq(collection.isPending(i), i == target, "trait isPending");
                assertFalse(collection.isCollected(i));
            }
        }

        // First-vaulted attribution is empty — nothing is vaulted yet.
        (uint16 fv, bool exists) = collection.firstVaultedPunk(target);
        assertFalse(exists);
        assertEq(fv, 0);

        assertEq(uint8(collection.custodyOf(punkId)), uint8(IPermanentCollection.Custody.InReturnAuction));
    }

    function test_MarkCustody_ReturnedToMarket_ReleasesPendingNoCollect() public {
        uint16 punkId = 1;
        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 target = collection.canonicalTargetOf(punkId);

        vm.prank(address(patron));
        collection.recordAcquisition(punkId, target, mask, address(this), address(this), 1 ether);

        vm.prank(address(finalSale));
        collection.markCustody(punkId, IPermanentCollection.Custody.ReturnedToMarket);

        // collectedMask still zero — Returned to Market never collects.
        assertEq(collection.collectedMask(), 0);
        assertEq(collection.collectedCount(), 0);

        for (uint8 i = 0; i < 111; i++) {
            if ((mask >> i) & 1 == 1) {
                assertEq(collection.pendingTraitCount(i), 0, "released");
                assertFalse(collection.isPending(i));
                assertFalse(collection.isCollected(i));
            }
        }

        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.ReturnedToMarket)
        );
    }

    function test_MarkCustody_Vaulted_CollectsOnlyTarget() public {
        uint16 punkId = 1;
        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 target = collection.canonicalTargetOf(punkId);

        vm.prank(address(patron));
        collection.recordAcquisition(punkId, target, mask, address(this), address(this), 1 ether);

        vm.prank(address(finalSale));
        collection.markCustody(punkId, IPermanentCollection.Custody.Vaulted);

        // v2: only the recorded target trait collects, NOT every bit on mask.
        assertEq(collection.collectedMask(), uint256(1) << target);
        assertTrue(collection.isCollected(target));

        // Pending counter released for the target bit; non-target bits were
        // never pending under the target-only rule.
        for (uint8 i = 0; i < 111; i++) {
            if ((mask >> i) & 1 == 1) {
                assertEq(collection.pendingTraitCount(i), 0, "released");
                assertFalse(collection.isPending(i));
                if (i != target) {
                    assertFalse(collection.isCollected(i), "non-target not collected");
                }
            }
        }

        // firstVaulted only set for the target trait.
        (uint16 fv, bool exists) = collection.firstVaultedPunk(target);
        assertTrue(exists);
        assertEq(fv, punkId);

        // Non-target bits on the same mask should have no firstVaulted entry.
        for (uint8 i = 0; i < 111; i++) {
            if ((mask >> i) & 1 == 1 && i != target) {
                (, bool ex) = collection.firstVaultedPunk(i);
                assertFalse(ex, "non-target has no firstVaulted");
            }
        }

        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.Vaulted)
        );
    }

    function test_PendingCount_TwoPunksSameTrait() public {
        uint16 punkA = 1;
        uint16 punkB = 2;
        uint256 maskA = punksData.traitMaskOf(punkA);
        uint256 maskB = punksData.traitMaskOf(punkB);
        uint256 shared = maskA & maskB;
        if (shared == 0) return;
        uint8 sharedTrait = uint8(_lsb(shared));

        uint8 targetA = sharedTrait;
        uint8 targetB;
        for (uint8 i = 0; i < 111; i++) {
            if ((maskB >> i) & 1 == 1 && i != sharedTrait) { targetB = i; break; }
        }
        if (targetB == 0 && (maskB >> 0) & 1 == 0) return;

        vm.prank(address(patron));
        collection.recordAcquisition(punkA, targetA, maskA, address(this), address(this), 1 ether);
        vm.prank(address(patron));
        collection.recordAcquisition(punkB, targetB, maskB, address(this), address(this), 1 ether);

        assertEq(collection.pendingTraitCount(sharedTrait), 1, "only targeted claim is pending");

        vm.prank(address(finalSale));
        collection.markCustody(punkA, IPermanentCollection.Custody.Vaulted);
        assertEq(collection.pendingTraitCount(sharedTrait), 0, "released after A");
        assertTrue(collection.isCollected(sharedTrait));

        vm.prank(address(finalSale));
        collection.markCustody(punkB, IPermanentCollection.Custody.ReturnedToMarket);
        assertEq(collection.pendingTraitCount(sharedTrait), 0, "still 0 after B");
        assertTrue(collection.isCollected(sharedTrait), "still collected via A");
        assertFalse(collection.isPending(sharedTrait), "no longer pending");
    }

    function test_RecordAcquisition_RevertIfTraitAlreadyCollected() public {
        uint16 punkA = 1;
        uint16 punkB = 2;
        uint256 maskA = punksData.traitMaskOf(punkA);
        uint256 maskB = punksData.traitMaskOf(punkB);
        uint256 shared = maskA & maskB;
        if (shared == 0) return;
        uint8 sharedTrait = uint8(_lsb(shared));

        vm.prank(address(patron));
        collection.recordAcquisition(punkA, sharedTrait, maskA, address(this), address(this), 1 ether);
        vm.prank(address(finalSale));
        collection.markCustody(punkA, IPermanentCollection.Custody.Vaulted);

        vm.prank(address(patron));
        vm.expectRevert(
            abi.encodeWithSelector(
                PermanentCollection.TargetTraitAlreadyCollected.selector, sharedTrait
            )
        );
        collection.recordAcquisition(punkB, sharedTrait, maskB, address(this), address(this), 1 ether);
    }

    function test_MarkCustody_OnlyFinalSale() public {
        uint16 punkId = 1;
        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 target = collection.canonicalTargetOf(punkId);
        vm.prank(address(patron));
        collection.recordAcquisition(punkId, target, mask, address(this), address(this), 1 ether);

        vm.expectRevert(PermanentCollection.NotReturnAuction.selector);
        collection.markCustody(punkId, IPermanentCollection.Custody.Vaulted);
    }

    function test_RecordAcquisition_OnlyPatron() public {
        uint16 punkId = 1;
        uint256 mask = punksData.traitMaskOf(punkId);
        uint8 target = uint8(_lsb(mask));
        vm.expectRevert(PermanentCollection.NotPatron.selector);
        collection.recordAcquisition(punkId, target, mask, address(this), address(this), 1 ether);
    }

    function test_BytecodeNoMarketWrite() public view {
        bytes memory code = address(collection).code;
        _assertNoSelector(code, bytes4(keccak256("transferPunk(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("buyPunk(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSale(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSaleToAddress(uint256,uint256,address)")));
        _assertNoSelector(code, bytes4(keccak256("acceptBidForPunk(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
        _assertNoSelector(code, bytes4(keccak256("enterBidForPunk(uint256)")));
    }

    function _assertNoSelector(bytes memory code, bytes4 sel) internal pure {
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == sel[0]
                    && code[i + 1] == sel[1]
                    && code[i + 2] == sel[2]
                    && code[i + 3] == sel[3]
            ) {
                revert("bytecode contains forbidden selector");
            }
        }
    }

    function _lsb(uint256 x) internal pure returns (uint256 i) {
        require(x != 0, "no bits");
        while ((x & 1) == 0) { x >>= 1; i++; }
    }
}
