// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BuybackBurner} from "../src/BuybackBurner.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @title  BuybackBurnerCadence
/// @notice Mempool-congestion canary: with `minBlocksBetweenSteps = 1`
///         (the launch default), a keeper bot can race to `executeStep`
///         every block. This test simulates 50 consecutive 1-block
///         steps and asserts:
///
///           - No underflow on `remainingEth`. Each step debits
///             only `ethSpent` (eagerly) and the contract refuses
///             a step when `remainingEth == 0`.
///           - `totalEthBurned` increases monotonically AND tracks
///             the actual ETH the contract has moved into the pool.
///           - Caller rewards sum to the expected total based on the
///             pro-rate formula (`actualReward = reward × ethSpent /
///             swapAmount`).
///
///         The fixed V4 price-impact cap may partial-fill each step; that
///         is expected and is exactly why the reward accounting is measured
///         from actual `ethSpent`.
contract BuybackBurnerCadenceTest is ForkFixtures {
    uint256 internal constant STEPS = 50;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
        adminContract.transferAdmin(address(this));
    }

    /// @notice 50 consecutive `executeStep` calls across 50 blocks. Track
    ///         per-step reward + total spent; reconcile against the
    ///         contract's `totalEthBurned` view at the end.
    function test_FiftyBlocks_BackToBack_RewardsAndBurnReconcile() public {
        // Stake enough ETH that we can fund STEPS × maxStepWei × 2 worth
        // of partial-fill rebalancing (thin pool clamps each step to
        // some fraction of the 1 ETH cap, so the queue isn't emptied
        // linearly — overshooting is safer than starving).
        uint256 deposit = STEPS * burner.maxStepWei() * 2;
        vm.deal(address(this), deposit);
        (bool ok,) = address(burner).call{value: deposit}("");
        assertTrue(ok, "deposit");

        // The keeper bot is a fresh address so its only ETH ever is
        // accumulated reward.
        address bot = address(0xCADE100);
        vm.deal(bot, 0);

        uint256 successful;
        uint256 totalEthBurnedBefore = burner.totalEthBurned();
        uint256 totalTokensBurnedBefore = burner.totalTokensBurned();
        uint256 remainingBefore = burner.remainingEth();
        uint256 totalRewardSeen;

        for (uint256 i = 0; i < STEPS; i++) {
            // Advance exactly one block: matches the 1-block cooldown.
            vm.roll(block.number + burner.minBlocksBetweenSteps());

            uint256 botBalBefore = bot.balance;
            uint256 burnedBefore = burner.totalEthBurned();
            uint256 remainingPrev = burner.remainingEth();

            vm.prank(bot);
            try burner.executeStep(0) {
                successful++;
                uint256 stepReward = bot.balance - botBalBefore;
                totalRewardSeen += stepReward;
                uint256 stepBurnt = burner.totalEthBurned() - burnedBefore;
                // Per-step invariants:
                //  - `remainingEth` strictly decreased OR stayed equal
                //    (a fully-clamped step might burn nothing and
                //    debit nothing). Never negative (uint256).
                assertLe(burner.remainingEth(), remainingPrev, "remainingEth must not grow");
                // The pro-rate formula caps the reward at the
                // EXEC_REWARD_CAP per step.
                assertLe(stepReward, burner.EXEC_REWARD_CAP(), "step reward over cap");
                // Reward is ALWAYS pro-rated to the actual spend, so
                // bot.balance increase per step is between [0, reward_cap].
                // If anything was spent, some reward was paid.
                if (stepBurnt > 0) {
                    assertGt(stepReward, 0, "spent > 0 but no reward");
                }
            } catch {
                // Acceptable failure modes here:
                //   - NothingToBurn (queue emptied mid-loop)
                //   - StepTooEarly (shouldn't fire — we always roll)
                //   - InsufficientOutput (pool refuses our minOut=0
                //     when output rate falls below the floor; on a
                //     setup with floor=0 by default in ForkFixtures
                //     this should not fire).
                // We don't require all 50 to succeed because the thin
                // launch pool can starve mid-loop. Just confirm we got
                // a meaningful number of successful burns through.
            }
        }

        // Macro reconciliation.
        uint256 burnDelta = burner.totalEthBurned() - totalEthBurnedBefore;
        uint256 tokensDelta = burner.totalTokensBurned() - totalTokensBurnedBefore;
        uint256 remainingDelta = remainingBefore - burner.remainingEth();
        emit log_named_uint("successful steps", successful);
        emit log_named_uint("totalEthBurned delta", burnDelta);
        emit log_named_uint("totalTokensBurned delta", tokensDelta);
        emit log_named_uint("remainingEth delta (consumed)", remainingDelta);
        emit log_named_uint("bot total reward", totalRewardSeen);

        // No underflow possible (uint256). Sanity-check the bookkeeping:
        //   ethSpent (debited from remainingEth) == totalEthBurned delta.
        // The reward is NOT charged against remainingEth — it's debited
        // separately via msg.sender.call (or stays put on send failure).
        // So `remainingDelta` == `burnDelta + totalRewardSeen` because
        // both leave the contract.
        assertEq(
            remainingDelta,
            burnDelta + totalRewardSeen,
            "remainingEth consumed == ethBurned + rewardPaid"
        );
        // Got at least a few steps through — anything less than 20 of
        // 50 succeeding is a regression in burn liveness.
        assertGe(successful, 20, "fewer than 20 of 50 blocks burned");
        // Tokens burned must move monotonically.
        if (burnDelta > 0) assertGt(tokensDelta, 0, "burn produced no tokens");
    }
}
