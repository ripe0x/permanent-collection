// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {LocalSwapper} from "./sim/LocalSwapper.sol";

interface IArtcoinsLocker {
    function collectRewards(address token) external;
}

interface ILiveBidAdapter {
    function sweep() external returns (uint256);
}

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Simulate trading on the V4 native-ETH-paired 111 pool.
///         Generates fee revenue; with the per-swap flywheel each trade
///         self-drives the collect → convert → sweep cycle. The
///         post-loop manual `collectRewards` + `sweep` is belt-and-
///         suspenders (drains anything the flywheel skipped on a tight
///         budget). Designed for local-fork use only.
///
///         Pre-funded anvil accounts 0–4 act as traders. Each does a warmup
///         buy, then alternates buy/sell with varied sizes.
///
///         Run after Deploy.s.sol:
///
///           forge script script/SimulateTrading.s.sol:SimulateTrading \
///               --rpc-url http://127.0.0.1:8545 \
///               --broadcast --slow --skip-simulation \
///               --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///
/// @dev Per 1 ETH of swap volume the bounty receives ~3.465% (6930 bps of
///      the 5% LP fee = 0.05 × 0.693). To reach ~30 ETH of bounty (mainnet
///      floor scale) you need ~870 ETH of total swap volume. With 100
///      round-trip trades averaging ~8 ETH and a 5 ETH warmup per trader,
///      one batch ≈ 30 ETH bounty:
///
///        N_TRADES=100 \
///        WARMUP_BUY_WEI=5000000000000000000 \
///        MIN_BUY_WEI=1000000000000000000 \
///        MAX_BUY_WEI=15000000000000000000 \
///        forge script script/SimulateTrading.s.sol:SimulateTrading ...
contract SimulateTrading is Script {
    // External mainnet addresses (same as Deploy.s.sol).
    address constant V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    int24 constant TICK_SPACING = 200;
    uint24 constant DYNAMIC_FEE_FLAG = 0x800000;

    // Anvil's pre-funded private keys (first 5).
    uint256[5] PRIVATE_KEYS = [
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80,
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d,
        0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a,
        0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6,
        0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
    ];

    // Live config (set in run()), held as storage to keep local stack small.
    LocalSwapper swapper;
    address tokenAddr;
    address patronAddr;
    address bountyAdapterAddr;
    address lockerAddr;
    address hookAddr;
    uint256 minBuy;
    uint256 maxBuy;

    function run() external {
        uint256 nTrades = vm.envOr("N_TRADES", uint256(60));
        uint256 sweepEvery = vm.envOr("SWEEP_EVERY", uint256(15));
        uint256 warmupBuy = vm.envOr("WARMUP_BUY_WEI", uint256(0.5 ether));
        minBuy = vm.envOr("MIN_BUY_WEI", uint256(0.05 ether));
        maxBuy = vm.envOr("MAX_BUY_WEI", uint256(0.5 ether));
        require(maxBuy >= minBuy, "MAX < MIN");

        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments.json"));
        tokenAddr = vm.parseJsonAddress(json, ".token");
        patronAddr = vm.parseJsonAddress(json, ".patron");
        bountyAdapterAddr = vm.parseJsonAddress(json, ".liveBidAdapter");
        lockerAddr = vm.parseJsonAddress(json, ".locker");
        // Read the active hook from deployments.json so this script tracks
        // whichever skim hook the most recent Deploy.s.sol broadcast bound.
        // Hardcoding the hook address regressed historically: each time the
        // hook changes, the constant stales out and swaps revert with
        // PoolNotInitialized() because the PoolKey points at a non-existent
        // pool. Reading from disk keeps script and deploy in lockstep.
        hookAddr = vm.parseJsonAddress(json, ".hook");

        console2.log("=== Trading simulator ===");
        console2.log("N_TRADES         ", nTrades);
        console2.log("WARMUP_BUY_WEI   ", warmupBuy);
        console2.log("MIN..MAX_BUY_WEI ", minBuy, maxBuy);
        console2.log("SWEEP_EVERY      ", sweepEvery);
        console2.log("patron        ", patronAddr);
        console2.log("starting bidBalance (wei):", patronAddr.balance);

        // 1) Deploy LocalSwapper.
        vm.startBroadcast(PRIVATE_KEYS[0]);
        swapper = new LocalSwapper(
            V4_POOL_MANAGER, tokenAddr, hookAddr, TICK_SPACING, DYNAMIC_FEE_FLAG
        );
        vm.stopBroadcast();
        console2.log("swapper       ", address(swapper));

        // 2) Warmup buys — each trader gets some 111 to sell later.
        for (uint256 i = 0; i < PRIVATE_KEYS.length; i++) {
            vm.startBroadcast(PRIVATE_KEYS[i]);
            uint256 pctOut = swapper.buy{value: warmupBuy}(0);
            vm.stopBroadcast();
            console2.log("warmup buy trader", i, "111 out:", pctOut);
        }

        // 3) Main loop.
        for (uint256 i = 0; i < nTrades; i++) {
            _oneTrade(i);
            if ((i + 1) % sweepEvery == 0) _sweep(i + 1);
        }

        // 4) Final sweep.
        vm.startBroadcast(PRIVATE_KEYS[0]);
        IArtcoinsLocker(lockerAddr).collectRewards(tokenAddr);
        uint256 finalSwept = ILiveBidAdapter(bountyAdapterAddr).sweep();
        vm.stopBroadcast();

        console2.log("=== Simulation complete ===");
        console2.log("final sweep forwarded (wei):", finalSwept);
        console2.log("final bidBalance   (wei):", patronAddr.balance);
    }

    /// @dev Stack-isolation helper. Picks trader + direction + size and broadcasts one swap.
    function _oneTrade(uint256 i) internal {
        uint256 traderIdx = uint256(keccak256(abi.encode(i, block.timestamp, "trader"))) % PRIVATE_KEYS.length;
        uint256 pk = PRIVATE_KEYS[traderIdx];
        address trader = vm.addr(pk);
        uint256 rnd = uint256(keccak256(abi.encode(i, block.timestamp, "rnd")));
        bool isBuy = rnd % 2 == 0;

        if (isBuy) {
            uint256 amount = minBuy + (rnd % (maxBuy - minBuy + 1));
            vm.startBroadcast(pk);
            try swapper.buy{value: amount}(0) returns (uint256 pctOut) {
                console2.log("trade", i, "BUY  ETH wei:", amount);
                console2.log("        trader:", trader, "111 out:", pctOut);
            } catch {
                console2.log("trade", i, "BUY  reverted (skipping)");
            }
            vm.stopBroadcast();
            return;
        }

        uint256 bal = IERC20(tokenAddr).balanceOf(trader);
        if (bal == 0) {
            uint256 amount = (minBuy + maxBuy) / 2;
            vm.startBroadcast(pk);
            try swapper.buy{value: amount}(0) returns (uint256 pctOut) {
                console2.log("trade", i, "BUY  (fallback) ETH wei:", amount);
                console2.log("        trader:", trader, "111 out:", pctOut);
            } catch {
                console2.log("trade", i, "BUY  fallback reverted");
            }
            vm.stopBroadcast();
            return;
        }

        uint256 pctIn = (bal * (10 + (rnd % 41))) / 100;
        if (pctIn == 0) pctIn = bal;
        vm.startBroadcast(pk);
        IERC20(tokenAddr).approve(address(swapper), pctIn);
        try swapper.sell(pctIn, 0) returns (uint256 ethOut) {
            console2.log("trade", i, "SELL 111 in:", pctIn);
            console2.log("        trader:", trader, "ETH out:", ethOut);
        } catch {
            console2.log("trade", i, "SELL reverted (skipping)");
        }
        vm.stopBroadcast();
    }

    function _sweep(uint256 nextI) internal {
        uint256 bountyBefore = patronAddr.balance;
        vm.startBroadcast(PRIVATE_KEYS[0]);
        IArtcoinsLocker(lockerAddr).collectRewards(tokenAddr);
        uint256 swept = ILiveBidAdapter(bountyAdapterAddr).sweep();
        vm.stopBroadcast();
        console2.log("--- sweep after trade", nextI, "wei forwarded:", swept);
        console2.log("    bounty before (wei):", bountyBefore);
        console2.log("    bounty after  (wei):", patronAddr.balance);
    }
}
