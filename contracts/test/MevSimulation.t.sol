// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";

interface IERC20MevMin {
    function approve(address, uint256) external returns (bool);
}

/// @notice Contract attacker with its own ETH and token balances, making P&L
///         measurement unambiguous across front-run / victim / back-run flows.
contract Attacker {
    TestSwapHelper public immutable swapper;
    IERC20MevMin public immutable token;
    BuybackBurner public immutable burner;

    constructor(TestSwapHelper _s, IERC20MevMin _t, BuybackBurner _b) {
        swapper = _s;
        token = _t;
        burner = _b;
    }

    receive() external payable {}

    function pumpBuy(uint256 ethIn) external returns (uint256 tokenOut) {
        return swapper.buyTokenWithEth{value: ethIn}(ethIn);
    }

    function unwindSell(uint256 tokenIn) external returns (uint256 ethOut) {
        token.approve(address(swapper), tokenIn);
        return swapper.sellTokenForEth(tokenIn);
    }

    function fireStep(uint256 minOut) external {
        burner.executeStep(minOut);
    }
}

/// @notice MEV-resistance harness for BuybackBurner's impact-capped burn:
///         sandwich profitability should be negative because the burner's
///         own price movement is capped below the attacker's round-trip fees.
contract MevSimulationTest is ForkFixtures {
    TestSwapHelper internal swapper;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
        adminContract.transferAdmin(address(this));

        swapper = new TestSwapHelper(
            V4_POOL_MANAGER,
            address(token),
            hook,
            DYNAMIC_FEE_FLAG,
            TICK_SPACING
        );
    }

    function _newAttacker(uint256 fundEth) internal returns (Attacker a) {
        a = new Attacker(swapper, IERC20MevMin(address(token)), burner);
        vm.deal(address(a), fundEth);
    }

    function test_SandwichAttempt_LosesUnderImpactCap() public {
        burner.setMaxStepWei(1 ether);
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(burner).call{value: 5 ether}("");
        assertTrue(ok);
        vm.roll(block.number + burner.minBlocksBetweenSteps());

        Attacker attacker = _newAttacker(10 ether);
        uint256 beforeBal = address(attacker).balance;
        uint256 pumpEth = 1 ether;

        uint256 tokenOut = attacker.pumpBuy(pumpEth);
        attacker.fireStep(0);
        if (tokenOut > 0) attacker.unwindSell(tokenOut);

        int256 pnl = int256(address(attacker).balance) - int256(beforeBal);
        console2.log("attacker pnl wei:");
        console2.logInt(pnl);
        assertLt(pnl, 0, "impact-capped sandwich should lose money");
        assertGt(burner.totalTokensBurned(), 0, "burn still delivered tokens");
    }

    /// @notice Even with `minOut=0`, an attacker cannot extract reward ETH
    ///         without delivering a real burn. Reward remains capped and
    ///         pro-rated to actual `ethSpent` after partial fills.
    function test_KeeperRewardNotGriefable() public {
        burner.setMaxStepWei(0.05 ether);
        assertEq(burner.minBlocksBetweenSteps(), 1, "default cooldown");

        vm.deal(address(this), 10 ether);
        (bool ok,) = address(burner).call{value: 10 ether}("");
        assertTrue(ok);

        Attacker grief = _newAttacker(0);
        vm.roll(block.number + 1);

        grief.fireStep(0);
        uint256 firstReward = address(grief).balance;
        console2.log("first call reward:", firstReward);
        assertGt(firstReward, 0, "griefer earned something");
        assertLe(firstReward, burner.EXEC_REWARD_CAP(), "reward never exceeds cap");
        assertGt(burner.totalTokensBurned(), 0, "burn delivered tokens");

        try grief.fireStep(0) {
            revert("expected StepTooEarly revert");
        } catch (bytes memory err) {
            assertEq(bytes4(err), BuybackBurner.StepTooEarly.selector, "cooldown blocks rapid-fire");
        }

        uint256 callsFired = 1;
        uint256 maxCalls = 20;
        while (callsFired < maxCalls && burner.remainingEth() > 0) {
            vm.roll(block.number + 1);
            try grief.fireStep(0) {
                callsFired++;
            } catch {
                break;
            }
        }

        uint256 rewardEarned = address(grief).balance;
        assertLe(rewardEarned, callsFired * burner.EXEC_REWARD_CAP(), "aggregate reward cap");
        assertGt(burner.totalEthBurned(), 0, "reward required real burns");
    }
}
