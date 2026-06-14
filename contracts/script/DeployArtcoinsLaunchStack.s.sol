// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {PCLaunchStackDeployer} from "../test/helpers/PCLaunchStackDeployer.sol";

/// @title  DeployArtcoinsLaunchStack
/// @notice PRODUCTION owner-ops broadcast: deploys the fresh artcoins stack PC
///         launches on (tax-aware factory, fee escrow, skim hook, skim MEV
///         module, PC `ProtocolFeeController`, conversion locker) and wires it
///         — including the CRITICAL `escrow.addDepositor(hook)` (without which
///         every swap reverts). Run by the artcoins owner BEFORE PC's
///         `Deploy.s.sol`; its stdout addresses become Deploy's env vars.
///
///         This is the authoritative replacement for the stale
///         `lib/artcoins/script/DeployConversionLockerAndWire.s.sol`, which
///         wired the LEGACY hook/MEV against the existing V3 factory + escrow —
///         the wrong stack. The deploy + wiring here is the SHARED
///         `PCLaunchStackDeployer`, the exact same code the fork-test fixture
///         (`FreshArtcoinsStack`) runs, so what is rehearsed on a fork
///         (`DeployRehearsalForkTest`) is byte-for-byte what is broadcast.
///
///         WHY a fresh stack: the live V3 factory can't produce the
///         venue-scoped-transfer-tax token bytecode, so the factory is
///         redeployed; everything bound to it (hook, locker) is fresh too, and
///         a fresh fee escrow is deployed (the old mainnet escrow is not
///         reused). See `PCLaunchStackDeployer` for the full rationale.
///
/// @dev    Env:
///           PC_TREASURY        — the PC treasury (86.67% of the protocol leg).
///           LAYER_BURN_ROUTER  — the LAYER burn router (13.33% of the protocol
///                                leg).
///           TEAM_FEE_RECIPIENT — optional; the factory team-fee sink (PC routes
///                                0 protocol bps, so this is a placeholder).
///                                Defaults to the deployer.
///           PRIVATE_KEY        — optional; the artcoins owner key. When set, the
///                                script signs with it (the in-process rehearsal
///                                test and hot-key broadcasts use this). When
///                                UNSET, the script falls back to the foundry
///                                CLI signer (`--account` / `--ledger` /
///                                `--sender`) so keystore/hardware signing works
///                                with no key ever materialized; the owner is the
///                                `--sender` address.
///           EXPECTED_OWNER     — optional; if set, the script asserts the
///                                resolved signer equals it (a belt-and-braces
///                                guard against deploying a misowned stack from
///                                the wrong `--sender`).
contract DeployArtcoinsLaunchStack is Script, PCLaunchStackDeployer {
    function run() external {
        address treasury = vm.envOr("PC_TREASURY", address(0));
        address burnRouter = vm.envOr("LAYER_BURN_ROUTER", address(0));
        require(treasury != address(0), "set PC_TREASURY (86.67% protocol-leg recipient)");
        require(burnRouter != address(0), "set LAYER_BURN_ROUTER (13.33% protocol-leg recipient)");

        // Signer source. Both paths deploy IDENTICAL bytecode + wiring; they
        // differ only in how the owner/broadcaster EOA is sourced:
        //   1. PRIVATE_KEY set   -> sign with it; owner = the key's address.
        //   2. PRIVATE_KEY unset -> use the CLI signer (`--account`/`--ledger`/
        //      `--sender`); owner = `msg.sender` (the `--sender` address).
        uint256 deployerPk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = deployerPk != 0 ? vm.addr(deployerPk) : msg.sender;
        address teamFeeRecipient = vm.envOr("TEAM_FEE_RECIPIENT", deployer);

        address expectedOwner = vm.envOr("EXPECTED_OWNER", address(0));
        require(expectedOwner == address(0) || deployer == expectedOwner, "signer != EXPECTED_OWNER");

        // Under broadcast, foundry routes salted CREATE2 through the canonical
        // proxy, so the hook is mined against `CREATE2_FACTORY` (not the EOA).
        if (deployerPk != 0) {
            vm.startBroadcast(deployerPk);
        } else {
            vm.startBroadcast();
        }
        PCLaunchStack memory s =
            _deployPCLaunchStack(deployer, CREATE2_FACTORY, teamFeeRecipient, treasury, burnRouter);
        vm.stopBroadcast();

        // Export for PC's Deploy.s.sol — set each as an env var before running
        // it (the rehearsal test reads them back via this struct directly).
        console2.log("=== artcoins launch stack (set these env vars for Deploy.s.sol) ===");
        console2.log("ARTCOINS_FACTORY   ", address(s.factory));
        console2.log("ARTCOINS_FEE_ESCROW", address(s.escrow));
        console2.log("ARTCOINS_HOOK_SKIM ", address(s.hook));
        console2.log("ARTCOINS_MEV_SKIM  ", address(s.mev));
        console2.log("PC_CONTROLLER      ", address(s.controller));
        console2.log("CONVERSION_LOCKER  ", address(s.locker));
    }
}
