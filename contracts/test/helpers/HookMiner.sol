// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "v4-core/libraries/Hooks.sol";

/// @notice Off-chain (or in-test) CREATE2 salt miner for V4 hook addresses.
/// @dev    V4 encodes hook permissions in the bottom 14 bits of the hook's
///         deployment address (see Hooks.sol). To deploy a hook with a given
///         permission set you must find a CREATE2 salt that yields an address
///         whose low bits match the required flag bits exactly.
library HookMiner {
    uint160 internal constant FLAG_MASK = 0x3FFF;

    function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        pure
        returns (address hookAddress, bytes32 salt)
    {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));
        for (uint256 i = 0; i < 200_000; ++i) {
            salt = bytes32(i);
            hookAddress = _compute(deployer, salt, initCodeHash);
            if (uint160(hookAddress) & FLAG_MASK == flags) {
                return (hookAddress, salt);
            }
        }
        revert("HookMiner: no salt found");
    }

    function _compute(address deployer, bytes32 salt, bytes32 initCodeHash) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xFF), deployer, salt, initCodeHash)))));
    }
}
