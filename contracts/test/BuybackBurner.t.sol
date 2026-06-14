// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BuybackBurner} from "../src/BuybackBurner.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice BuybackBurner tests focused on the V4 caller-reward addition.
///         The pool-managed swap itself is well-covered by the existing
///         integration flow; we exercise the reward gating here.
contract BuybackBurnerTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
        adminContract.transferAdmin(address(this));
    }

    function test_ExecuteStep_PaysCallerReward() public {
        // On the freshly-launched pool the spot liquidity is too thin to
        // fully absorb a 1 ETH swap even at the upper slippage bound, so
        // verify the pro-rated reward invariant: reward / fullReward ==
        // ethSpent / swapAmount. The caller is always paid SOMETHING for
        // a non-zero burn.

        vm.deal(address(this), 100 ether);
        (bool ok,) = address(burner).call{value: 50 ether}("");
        assertTrue(ok);
        uint256 step = burner.quoteStepAmount();
        assertGt(step, 0, "step computable");

        uint256 fullReward = (step * burner.EXEC_REWARD_BPS()) / 10_000;
        if (fullReward > burner.EXEC_REWARD_CAP()) fullReward = burner.EXEC_REWARD_CAP();
        uint256 swapAmount = step - fullReward;

        vm.roll(block.number + burner.minBlocksBetweenSteps());

        address bot = address(0xB07);
        vm.deal(bot, 0);

        vm.prank(bot);
        burner.executeStep(0);

        // Bot was rewarded.
        assertGt(bot.balance, 0, "caller earned a reward");
        // Pro-rated invariant.
        uint256 ethSpent = burner.totalEthBurned();
        uint256 expectedReward = (fullReward * ethSpent) / swapAmount;
        assertEq(bot.balance, expectedReward, "reward pro-rated to ethSpent");
    }

    function test_ExecuteStep_RevertsBeforeWindow() public {
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(burner).call{value: 10 ether}("");
        assertTrue(ok);
        // First call lands lastStepBlock; second call before window reverts.
        vm.roll(block.number + burner.minBlocksBetweenSteps());
        burner.executeStep(0);

        vm.expectRevert();
        burner.executeStep(0);
    }

    function test_ExecuteStep_RevertsIfNothingToBurn() public {
        vm.roll(block.number + burner.minBlocksBetweenSteps());
        vm.expectRevert(BuybackBurner.NothingToBurn.selector);
        burner.executeStep(0);
    }

    function test_ExecuteStep_RewardCappedAtFixedCap() public {
        // Verifies the fullReward cap: when bps × step > EXEC_REWARD_CAP,
        // fullReward = cap. Then reward pro-rates from the capped base, not
        // from the (higher) uncapped rate. We check the *cap binding*, not
        // the absolute reward (the thin launch pool can't full-fill 5 ETH).
        burner.setMaxStepWei(5 ether);

        vm.deal(address(this), 10 ether);
        (bool ok,) = address(burner).call{value: 10 ether}("");
        assertTrue(ok);

        vm.roll(block.number + burner.minBlocksBetweenSteps());

        address bot = address(0xB07);
        vm.deal(bot, 0);
        vm.prank(bot);
        burner.executeStep(0);

        // bps × step = 50 × 5 / 10_000 = 0.025 ETH which exceeds the 0.01
        // ETH absolute cap, so fullReward = cap. The actual paid reward is
        // (cap × ethSpent / swapAmount). Assert ≤ cap (sanity) and that the
        // ratio matches the cap-based rate, not the uncapped 0.5%.
        uint256 step = 5 ether;
        uint256 fullReward = burner.EXEC_REWARD_CAP();
        uint256 swapAmount = step - fullReward;
        uint256 ethSpent = burner.totalEthBurned();
        uint256 expectedReward = (fullReward * ethSpent) / swapAmount;
        assertEq(bot.balance, expectedReward, "reward = capped base * pro-rate");
        assertLe(bot.balance, burner.EXEC_REWARD_CAP(), "never exceeds cap");
    }

    // REMOVED: 5 tests that exercised admin-tunable `maxSlippageBps` /
    // `minTokensPerEthFloor` at runtime. `maxSlippageBps` is now a
    // compile-time constant (500) and the static `minTokensPerEthFloor` was
    // removed entirely (audit H-1: a static tokens-per-ETH floor is the wrong
    // shape for an appreciating ETH→111 pool — it only tightens as 111 rises).
    // The remaining slippage protection is the fixed V4 price-impact clamp
    // plus partial-fill reward pro-rating.

    function test_maxSlippageBps_isConstantImpactCap() public view {
        // Primary sandwich guard — compile-time constant, not tunable.
        assertEq(burner.maxSlippageBps(), 500, "price-impact cap");
    }

    function test_ExecuteStep_FailedRewardCreditsRemaining() public {
        // Caller is a contract that rejects ETH on its fallback. Reward send
        // fails; the contract should credit the (pro-rated) reward back to
        // `remainingEth` so nothing drifts off the ledger. Hold for both
        // full and partial fills via the same invariant:
        //   `remainingEth dropped == ethSpent` (only the actually-swapped
        //   ETH leaves the queue; the would-be reward is recycled).

        vm.deal(address(this), 5 ether);
        (bool ok,) = address(burner).call{value: 5 ether}("");
        assertTrue(ok);

        vm.roll(block.number + burner.minBlocksBetweenSteps());

        uint256 preRemaining = burner.remainingEth();
        RejectsEthCaller bot = new RejectsEthCaller(address(burner));
        bot.fire();

        uint256 ethSpent = burner.totalEthBurned();
        assertEq(
            preRemaining - burner.remainingEth(),
            ethSpent,
            "remainingEth dropped only by ethSpent (reward credited back)"
        );
        // Caller got nothing.
        assertEq(address(bot).balance, 0, "rejector caller has no balance");
        // Contract balance still matches remainingEth (no ETH stranded).
        assertEq(address(burner).balance, burner.remainingEth(), "balance == remainingEth");
    }
}

/// @notice Test helper — a contract that rejects ETH via a reverting receive.
///         Used to exercise the failed-reward path on BuybackBurner.
contract RejectsEthCaller {
    BuybackBurner immutable b;
    constructor(address _b) { b = BuybackBurner(payable(_b)); }
    function fire() external { b.executeStep(0); }
    // Reject any inbound ETH.
    receive() external payable { revert("no eth"); }
}
