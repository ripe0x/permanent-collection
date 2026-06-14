// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {TestSwapHelper} from "../test/helpers/TestSwapHelper.sol";

interface IERC6909Lite {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
}

/// @notice One-shot verification script for the same-tx flush behavior on
///         the live dev fork. Reads token+hook+adapters from deployments.json,
///         deploys a TestSwapHelper, executes a small ETH→token buy, then
///         prints the adapter balances + the hook's ERC6909 claim balance
///         so you can confirm same-tx flush worked end-to-end.
contract VerifyFlush is Script {
    function run() external {
        string memory path = string.concat(vm.projectRoot(), "/deployments.json");
        string memory json = vm.readFile(path);
        address token = vm.parseJsonAddress(json, ".token");
        address hook = vm.parseJsonAddress(json, ".hook");
        address liveBidAdapter = vm.parseJsonAddress(json, ".liveBidAdapter");
        address protocolFeePhaseAdapter = vm.parseJsonAddress(json, ".protocolFeePhaseAdapter");
        address poolManager = 0x000000000004444c5dc75cB358380D2e3dE08A90;

        console2.log("--- BEFORE swap ---");
        console2.log("LiveBidAdapter            ", liveBidAdapter.balance);
        console2.log("ProtocolFeePhaseAdapter  ", protocolFeePhaseAdapter.balance);
        console2.log("Hook ERC6909(ETH)        ", IERC6909Lite(poolManager).balanceOf(hook, 0));

        uint256 ethIn = 0.5 ether;
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        // poolFee = DYNAMIC_FEE_FLAG (0x800000), tickSpacing = 200
        TestSwapHelper swapper = new TestSwapHelper(poolManager, token, hook, 0x800000, 200);
        swapper.buyTokenWithEth{value: ethIn}(ethIn);
        vm.stopBroadcast();

        console2.log("--- AFTER swap of 0.5 ETH ---");
        console2.log("LiveBidAdapter            ", liveBidAdapter.balance);
        console2.log("ProtocolFeePhaseAdapter  ", protocolFeePhaseAdapter.balance);
        console2.log("Hook ERC6909(ETH)        ", IERC6909Lite(poolManager).balanceOf(hook, 0));
        console2.log("  Expected: both adapter balances increased by 6% x 0.5 ETH split 83.33/16.67.");
        console2.log("  Expected: hook ERC6909 stays 0 (same-tx flush, no leftover claim balance).");
    }
}
