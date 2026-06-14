// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SkimForkFixture} from "./helpers/SkimForkFixture.sol";
import {DeployScript} from "../script/Deploy.s.sol";

/// @notice End-to-end fork dry-run of the production deploy script.
///         Different from `EndToEndVolume.t.sol` in that it runs the actual
///         `DeployScript.run()` entrypoint — verifying the broadcast wrapper,
///         the env-var handling, the JSON-write flow, and the full deployment
///         ordering — not just a re-creation of the same shape inside a fork
///         fixture.
///
///         Uses `SkimForkFixture` to provide the hook-redesign prerequisites:
///         a freshly-deployed `ArtCoinsHookSkimFee`, `ArtCoinsMevLinearSkim`,
///         `ProtocolFeeController`, and conversion locker — allowlisted on
///         the live mainnet factory with env vars exported for the script.
contract DeployScriptForkTest is SkimForkFixture {
    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet")));
    }

    function test_DeployScript_RunsEndToEnd() public {
        // SkimForkFixture handles undeprecation, hook+MEV+controller+locker
        // deployment and allowlisting, env-var export, and runs the deploy.
        _runFullDeploy();

        // If `_runFullDeploy()` returned, the deploy succeeded end-to-end:
        // every wiring landed, the factory call resolved, the burner got
        // token+hook, the allowlist was seeded. The exact addresses are
        // in `deployments.json`.
        string memory path = string.concat(vm.projectRoot(), "/deployments.json");
        string memory json = vm.readFile(path);
        assertGt(bytes(json).length, 100, "deployments.json written and non-trivial");
    }
}
