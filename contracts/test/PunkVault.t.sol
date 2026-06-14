// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PunkVault} from "../src/PunkVault.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

contract PunkVaultTest is ForkFixtures {
    /// @dev Mirrors the event declaration on PunkVault so vm.expectEmit can
    ///      match against it.
    event ContractURIUpdated();
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        _setUpFork();
        _deployProtocol();
    }

    function test_BytecodeContainsNoMarketWriteSelectors() public view {
        bytes memory code = address(vault).code;
        _assertNoSelector(code, bytes4(keccak256("transferPunk(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("buyPunk(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSale(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSaleToAddress(uint256,uint256,address)")));
        _assertNoSelector(code, bytes4(keccak256("acceptBidForPunk(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("enterBidForPunk(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
    }

    /// @notice The marketplace-owner surface is intentionally minimal. The
    ///         vault exposes ERC-173 `owner()` + a one-way `renounceOwnership()`
    ///         and NOTHING else — no `transferOwnership`, no admin /
    ///         migration / withdrawal selectors. This test asserts the
    ///         allowed selectors are present and forbids every common admin
    ///         selector pattern.
    function test_BytecodeContainsOnlyRenounceOwnershipSelector() public view {
        bytes memory code = address(vault).code;

        // Present:
        _assertHasSelector(code, bytes4(keccak256("owner()")));
        _assertHasSelector(code, bytes4(keccak256("renounceOwnership()")));

        // Forbidden — transferOwnership in any common signature.
        _assertNoSelector(code, bytes4(keccak256("transferOwnership(address)")));
        _assertNoSelector(code, bytes4(keccak256("acceptOwnership()")));
        _assertNoSelector(code, bytes4(keccak256("pendingOwner()")));

        // Forbidden — generic admin / migration / withdrawal patterns.
        _assertNoSelector(code, bytes4(keccak256("rescue(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescueETH(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescueERC20(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescueERC721(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("sweep(address)")));
        _assertNoSelector(code, bytes4(keccak256("migrate(address)")));
        _assertNoSelector(code, bytes4(keccak256("emergencyWithdraw()")));
    }

    // ────────── ERC-173 owner + renounce ──────────

    function test_Owner_DeployerIsInitialOwner() public view {
        // ForkFixtures._deployProtocol calls `new PunkVault(...)` from
        // address(this), so the test contract is the deployer and the
        // initial owner.
        assertEq(vault.owner(), address(this));
    }

    function test_RenounceOwnership_RevertsForNonOwner() public {
        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert(PunkVault.NotOwner.selector);
        vault.renounceOwnership();
    }

    function test_RenounceOwnership_OwnerSucceeds_AndEmits() public {
        vm.expectEmit(true, true, false, false, address(vault));
        emit OwnershipTransferred(address(this), address(0));
        vault.renounceOwnership();
        assertEq(vault.owner(), address(0), "owner zero after renounce");
    }

    function test_RenounceOwnership_IsOneWayRatchet() public {
        vault.renounceOwnership();
        assertEq(vault.owner(), address(0));

        // The previous owner (this) can no longer call renounce — they are
        // no longer the current owner.
        vm.expectRevert(PunkVault.NotOwner.selector);
        vault.renounceOwnership();

        // address(0) cannot originate a tx, so the only way to satisfy
        // `msg.sender == _owner` post-renounce is impossible. Confirm the
        // owner stays zero forever.
        assertEq(vault.owner(), address(0));
    }

    // ────────── ContractURIUpdated emission (ERC-7572) ──────────

    function test_ContractURIUpdated_EmittedOnTitleMint() public {
        // The fixture wires titleAuction; we just need to call mintToAuction
        // as that contract. The function emits ContractURIUpdated alongside
        // MetadataUpdate + TitleMinted.
        vm.expectEmit(false, false, false, false, address(vault));
        emit ContractURIUpdated();
        vm.prank(address(titleAuction));
        vault.mintToAuction();
    }

    function test_ContractURIUpdated_EmittedOnProofMint() public {
        // First land a real Punk in the vault via the canonical settle
        // path — keeps the test honest end-to-end. The fixture's
        // ReturnAuctionModule is the only allowed minter.
        uint16 punkId = 42;
        address currentOwner = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(currentOwner);
        punksMarket.transferPunk(address(vault), uint256(punkId));
        vm.prank(address(finalSale));
        vault.receivePunk(punkId);

        // Mint a Proof directly via the authorized minter (we're unit-
        // testing the event emit, not the full settle flow).
        vm.expectEmit(false, false, false, false, address(vault));
        emit ContractURIUpdated();
        vm.prank(address(finalSale));
        vault.mintProofs(punkId, /* traitId */ 7, makeAddr("seller"), 0, 1);
    }

    function test_ReceivePunk_OnlyFinalSaleModule() public {
        vm.expectRevert(PunkVault.NotReturnAuction.selector);
        vault.receivePunk(0);
    }

    function test_ReceivePunk_RevertsIfNotOwned() public {
        vm.prank(address(finalSale));
        vm.expectRevert(abi.encodeWithSelector(PunkVault.NotOwnedByVault.selector, uint16(1234)));
        vault.receivePunk(1234);
    }

    function test_ReceivePunk_Succeeds() public {
        uint16 punkId = 42;
        address currentOwner = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(currentOwner);
        punksMarket.transferPunk(address(vault), uint256(punkId));

        vm.prank(address(finalSale));
        vault.receivePunk(punkId);

        assertTrue(vault.isLocked(punkId));
        assertEq(vault.lockedPunkCount(), 1);

        vm.prank(address(finalSale));
        vm.expectRevert(abi.encodeWithSelector(PunkVault.AlreadyLocked.selector, punkId));
        vault.receivePunk(punkId);
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

    function _assertHasSelector(bytes memory code, bytes4 sel) internal pure {
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == sel[0]
                    && code[i + 1] == sel[1]
                    && code[i + 2] == sel[2]
                    && code[i + 3] == sel[3]
            ) {
                return;
            }
        }
        revert("bytecode missing required selector");
    }
}
