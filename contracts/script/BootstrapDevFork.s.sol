// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {PCLaunchStackDeployer} from "../test/helpers/PCLaunchStackDeployer.sol";

/// @notice Minimal ETH sink — accepts ETH via receive() and exposes
///         layerToken() so it can stand in as the burn-router param to
///         ProtocolFeeController's constructor on a dev fork (the constructor
///         only stores the address; setBurnRouter, which calls layerToken, is
///         never exercised in dev-fork flow).
contract DevSink {
    receive() external payable {}

    function layerToken() external pure returns (address) {
        return address(0xdeaDDeADDEaDdeaDdEAddEADDEAdDeadDEADDEaD);
    }
}

/// @notice Dev-fork bootstrap for the skim-hook architecture. On a local anvil
///         fork this deploys, in one broadcast, the fresh artcoins stack PC's
///         launch ships — a tax-aware factory, a fresh fee escrow, the skim
///         hook, the skim MEV module, a PC-dedicated ProtocolFeeController, and
///         a conversion locker — then exports the six addresses on stdout (the
///         dev-up bash script greps them and feeds them to `Deploy.s.sol`).
///
///         The deploy + wiring is the SHARED `PCLaunchStackDeployer` — the SAME
///         code the fork-test fixture (`FreshArtcoinsStack`) and the production
///         owner-ops script (`DeployArtcoinsLaunchStack`) run, so the dev fork
///         can't drift from what's tested or what's broadcast on mainnet. See
///         that contract for WHY the factory + escrow are fresh (the tax feature
///         forces a factory redeploy; the old escrow is not reused).
contract BootstrapDevForkScript is Script, PCLaunchStackDeployer {
    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        vm.startBroadcast(deployerPk);

        // Dev-fork sinks (production passes real recipients). Under broadcast,
        // foundry routes salted CREATE2 through the canonical proxy, so the hook
        // is mined against `CREATE2_FACTORY` (forge-std's inherited constant),
        // not the EOA.
        DevSink feeSink = new DevSink();
        DevSink treasury = new DevSink();
        DevSink burnRouter = new DevSink();

        PCLaunchStack memory s = _deployPCLaunchStack(
            deployer, CREATE2_FACTORY, address(feeSink), address(treasury), address(burnRouter)
        );

        vm.stopBroadcast();

        // The dev-up bash wrapper greps these labels out of stdout — don't
        // change the prefixes without updating `start-dev-fork.sh`.
        console2.log("BOOTSTRAP factory", address(s.factory));
        console2.log("BOOTSTRAP feeEscrow", address(s.escrow));
        console2.log("BOOTSTRAP skimHook", address(s.hook));
        console2.log("BOOTSTRAP mevSkim", address(s.mev));
        console2.log("BOOTSTRAP pcController", address(s.controller));
        console2.log("BOOTSTRAP conversionLocker", address(s.locker));
    }
}
