// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {BuybackBurner} from "../src/BuybackBurner.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";

interface IERC20SandwichMin {
    function approve(address, uint256) external returns (bool);
}

/// @notice Attacker that owns its ETH + token so `address(this).balance` is
///         unambiguous P&L. Mirrors the mempool sandwich shape:
///         front-run buy, victim burn, back-run sell.
contract SandwichBot {
    TestSwapHelper public immutable swapper;
    IERC20SandwichMin public immutable token;
    BuybackBurner public immutable burner;

    constructor(TestSwapHelper _s, IERC20SandwichMin _t, BuybackBurner _b) {
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

/// @notice Proves the simpler BuybackBurner sandwich posture:
///         `executeStep` may try up to `maxStepWei`, but V4 partial-fills at
///         the fixed `maxSlippageBps` price-impact cap. The burner's own price
///         movement therefore stays below the attacker's measured round-trip
///         fee moat, so sandwiching the buy-and-burn is uneconomic without any
///         rolling EMA oracle or self-heal hook.
contract BuybackBurnerSandwichEconomicsTest is ForkFixtures {
    using StateLibrary for IPoolManager;

    TestSwapHelper internal swapper;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
        adminContract.transferAdmin(address(this));
        swapper =
            new TestSwapHelper(V4_POOL_MANAGER, address(token), hook, DYNAMIC_FEE_FLAG, TICK_SPACING);

        // Steady state: warp past the MEV window so the skim is at the
        // 6% baseline — the lowest-fee, most adversarial case for the
        // "impact cap is enough" claim.
        vm.warp(block.timestamp + 120 minutes);
    }

    function _readSpot() internal view returns (uint160) {
        (uint160 s,,,) = IPoolManager(V4_POOL_MANAGER).getSlot0(burner.poolKey().toId());
        return s;
    }

    function _devBps(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 diff = a > b ? a - b : b - a;
        return (diff * 10_000) / b;
    }

    function _fundBurner(uint256 amt) internal {
        vm.deal(address(this), amt);
        (bool ok,) = address(burner).call{value: amt}("");
        require(ok, "fund");
    }

    /// @dev Measured round-trip cost of a small buy+sell (approximately the
    ///      fee moat at near-zero price impact). Returns bps of ETH lost.
    function _roundTripFeeBps() internal returns (uint256) {
        uint256 s = vm.snapshotState();
        SandwichBot bot = new SandwichBot(swapper, IERC20SandwichMin(address(token)), burner);
        uint256 probe = 0.05 ether;
        vm.deal(address(bot), probe);
        uint256 got = bot.pumpBuy(probe);
        uint256 back = got > 0 ? bot.unwindSell(got) : 0;
        uint256 lost = probe > back ? probe - back : 0;
        uint256 bps = (lost * 10_000) / probe;
        vm.revertToState(s);
        return bps;
    }

    /// @dev Solo burner sqrt-price movement for a given step attempt.
    ///      The fixed price limit should keep this below the fee moat even
    ///      when `maxStepWei` is much larger than active depth.
    function _soloImpactBps(uint256 maxStepWei) internal returns (uint256 bps, bool burned) {
        uint256 s = vm.snapshotState();
        burner.setMaxStepWei(maxStepWei);
        _fundBurner(maxStepWei);
        vm.roll(block.number + burner.minBlocksBetweenSteps());
        uint160 p0 = _readSpot();
        try burner.executeStep(0) {
            burned = true;
        } catch {
            burned = false;
        }
        uint160 p1 = _readSpot();
        bps = burned ? _devBps(p1, p0) : 0;
        vm.revertToState(s);
    }

    function _sandwichOnce(uint256 maxStepWei, uint256 pumpEth)
        internal
        returns (int256 pnl, bool burned)
    {
        burner.setMaxStepWei(maxStepWei);
        _fundBurner(maxStepWei);
        vm.roll(block.number + burner.minBlocksBetweenSteps());

        SandwichBot bot = new SandwichBot(swapper, IERC20SandwichMin(address(token)), burner);
        vm.deal(address(bot), pumpEth);

        uint256 bought = bot.pumpBuy(pumpEth);
        try bot.fireStep(0) {
            burned = true;
        } catch {
            burned = false;
        }
        if (bought > 0) bot.unwindSell(bought);

        pnl = int256(address(bot).balance) - int256(pumpEth);
    }

    /// @dev Best-case attacker P&L for a step size over a sweep of front-runs.
    function _bestSandwichPnl(uint256 maxStepWei)
        internal
        returns (int256 best, uint256 bestPump, bool sawBurn)
    {
        uint256[8] memory pumps = [
            uint256(0.02 ether),
            0.05 ether,
            0.1 ether,
            0.25 ether,
            0.5 ether,
            1 ether,
            2 ether,
            5 ether
        ];
        best = type(int256).min;
        for (uint256 j = 0; j < pumps.length; j++) {
            uint256 s = vm.snapshotState();
            (int256 pnl, bool burned) = _sandwichOnce(maxStepWei, pumps[j]);
            if (burned && pnl > best) {
                sawBurn = true;
                best = pnl;
                bestPump = pumps[j];
            }
            vm.revertToState(s);
        }
    }

    function test_ImpactCap_KeepsBurnerBelowFeeMoat() public {
        uint256 feeBps = _roundTripFeeBps();
        assertEq(burner.maxSlippageBps(), 500, "burner impact cap");
        console2.log("fee moat bps:", feeBps);

        uint256[4] memory steps = [uint256(0.1 ether), 1 ether, 5 ether, 10 ether];
        for (uint256 i = 0; i < steps.length; i++) {
            (uint256 impactBps, bool burned) = _soloImpactBps(steps[i]);
            console2.log("step attempt wei:", steps[i]);
            console2.log("  burned:", burned);
            console2.log("  solo sqrt impact bps:", impactBps);
            assertTrue(burned, "burn should execute via partial fill");
            assertLt(impactBps, feeBps, "burn impact must sit below fee moat");
        }
    }

    function test_ImpactCap_MakesSweptSandwichUnprofitable() public {
        uint256[3] memory steps = [uint256(1 ether), 5 ether, 10 ether];
        for (uint256 i = 0; i < steps.length; i++) {
            (int256 bestPnl, uint256 bestPump, bool sawBurn) = _bestSandwichPnl(steps[i]);
            console2.log("step attempt wei:", steps[i]);
            console2.log("  best attacker front-run wei:", bestPump);
            console2.log("  best attacker net pnl wei:");
            console2.logInt(bestPnl);
            assertTrue(sawBurn, "at least one swept attempt should execute");
            assertLt(bestPnl, 0, "sandwich should be unprofitable under impact cap");
        }
    }
}
