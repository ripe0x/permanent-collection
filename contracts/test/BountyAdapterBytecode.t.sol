// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {LiveBidAdapter} from "../src/LiveBidAdapter.sol";
import {ProtocolAdmin} from "../src/ProtocolAdmin.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Bytecode-scan invariants for the LiveBidAdapter. Mirrors the
///         pattern from `Patron.t.sol` and `PunkVault.t.sol` — confirms that
///         the adapter has no function selector matching common admin-
///         withdrawal shapes. Buffered ETH must only exit toward Patron
///         via the permissionless `sweep()`, whose destination is set
///         immutably at construction.
contract BountyAdapterBytecodeTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
    }

    /// @dev Two intentional carve-outs from the forbidden list:
    ///      - `withdraw(uint256)` — too generic to be a high-signal admin hit
    ///        (older WETH-unwrap adapters used it).
    ///      - `sweep()` (no args) — this IS the adapter's core function: a
    ///        permissionless forward of buffered ETH to its IMMUTABLE
    ///        destination (Patron), not an admin withdrawal. The arg'd
    ///        shapes `sweep(address)` / `sweep(uint256)` (redirect to an
    ///        arbitrary recipient/amount) stay forbidden below.
    ///      The remaining high-signal selectors (rescue / withdrawAll /
    ///      emergencyWithdraw / migrate) are unique enough that a hit indicates
    ///      a real function on THIS contract.
    function test_BountyAdapter_NoAdminWithdrawSelectors() public view {
        bytes memory code = address(liveBidAdapter).code;
        _assertNoSelector(code, bytes4(keccak256("rescue(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("sweep(address)")));
        _assertNoSelector(code, bytes4(keccak256("sweep(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("withdraw(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("withdrawAll()")));
        _assertNoSelector(code, bytes4(keccak256("emergencyWithdraw()")));
        _assertNoSelector(code, bytes4(keccak256("emergencyWithdraw(address)")));
        _assertNoSelector(code, bytes4(keccak256("migrate(address)")));
        _assertNoSelector(code, bytes4(keccak256("transferOut(address,uint256)")));
        // Confirm there's no admin path to redirect the patron destination.
        _assertNoSelector(code, bytes4(keccak256("setPatron(address)")));
        _assertNoSelector(code, bytes4(keccak256("changePatron(address)")));
    }

    /// @notice Confirm BuybackBurner also has no admin pull paths. (Patron is
    ///         scanned in Patron.t.sol; PunkVault in PunkVault.t.sol;
    ///         VaultBurnPool in VaultBurnPool.t.sol. This rounds out the
    ///         coverage to every ETH/Punk-holding contract.)
    function test_BuybackBurner_NoAdminWithdrawSelectors() public view {
        bytes memory code = address(burner).code;
        _assertNoSelector(code, bytes4(keccak256("rescue(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("sweep()")));
        _assertNoSelector(code, bytes4(keccak256("sweep(address)")));
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
        _assertNoSelector(code, bytes4(keccak256("withdraw(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("withdrawAll()")));
        _assertNoSelector(code, bytes4(keccak256("emergencyWithdraw()")));
        _assertNoSelector(code, bytes4(keccak256("migrate(address)")));
        _assertNoSelector(code, bytes4(keccak256("transferOut(address,uint256)")));
        // No admin override of pool/token/hook after setup.
        _assertNoSelector(code, bytes4(keccak256("setToken(address)")));
        _assertNoSelector(code, bytes4(keccak256("setHook(address)")));
        _assertNoSelector(code, bytes4(keccak256("setPool(address)")));
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
}
