// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SkimForkFixture} from "./helpers/SkimForkFixture.sol";
import {VerifyDeploy} from "../script/VerifyDeploy.s.sol";

/// @title  VerifyDeployForkTest
/// @notice Proves the post-broadcast verifier (`script/VerifyDeploy.s.sol`)
///         passes against a faithfully-launched system, AND fails loud
///         when state is mutated to violate one of the verifier's checks.
///         Replaces the prior PerSwapFeeExtension-based suite — that path
///         is dead under the hook-redesign architecture.
contract VerifyDeployForkTest is SkimForkFixture {
    function setUp() public {
        string memory url =
            vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url);
    }

    /// @notice Faithful launch + verifier passes.
    function test_VerifyDeploy_PassesOnFaithfulLaunch() public {
        _runFullDeploy();
        // Should complete without reverting.
        new VerifyDeploy().run();
    }

    /// @notice Mutate one piece of state the verifier checks and assert
    ///         it reverts. Specifically: write the seller allowlist
    ///         entry for PunkStrategy to `false`, then run.
    function test_VerifyDeploy_FailsLoudWhenAllowlistEntryRemoved() public {
        _runFullDeploy();

        // The Patron's `allowedSellers` is `mapping(address => bool)`.
        // Storage layout: probe candidate slots, write 0 at the PunkStrategy
        // key, verify the getter flips.
        address punkStrategy = 0xc50673EDb3A7b94E8CAD8a7d4E0cD68864E33eDF;
        uint256 base = _findAllowedSellersSlot(punkStrategy);
        bytes32 key = keccak256(abi.encode(punkStrategy, base));
        vm.store(address(patron), key, bytes32(uint256(0)));
        require(!patron.allowedSellers(punkStrategy), "test: allowlist entry not flipped");

        VerifyDeploy verifier = new VerifyDeploy();
        vm.expectRevert(bytes("patron.allowedSellers PunkStrategy seeded"));
        verifier.run();
    }

    /// @dev Probe for the storage slot backing `Patron.allowedSellers`.
    ///      Uses an unrelated probe address (NOT the PunkStrategy seed)
    ///      so the getter starts at `false` — writing sentinel `1` to the
    ///      correct slot flips it to `true`, distinguishing the slot.
    function _findAllowedSellersSlot(address /* unusedSeed */) internal returns (uint256) {
        address probe = address(uint160(uint256(keccak256("allowedSellers-probe"))));
        require(!patron.allowedSellers(probe), "test: probe pre-set in allowlist");
        for (uint256 i = 0; i < 64; i++) {
            bytes32 key = keccak256(abi.encode(probe, i));
            bytes32 original = vm.load(address(patron), key);
            vm.store(address(patron), key, bytes32(uint256(1)));
            bool got = patron.allowedSellers(probe);
            vm.store(address(patron), key, original);
            if (got) return i;
        }
        revert("test: allowedSellers slot not found");
    }
}
