// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {BuybackBurner} from "../src/BuybackBurner.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";

interface IERC20D {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Adds real concentrated liquidity to PC's pool to simulate a deeper,
///      more mature book. Settles both owed currencies inside the V4 unlock.
contract LiquidityDeepener is IUnlockCallback {
    IPoolManager public immutable pm;
    PoolKey internal key;

    constructor(IPoolManager _pm, PoolKey memory _key) {
        pm = _pm;
        key = _key;
    }

    receive() external payable {}

    function deepen(int24 tickLower, int24 tickUpper, int256 liq) external {
        pm.unlock(abi.encode(tickLower, tickUpper, liq));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "notpm");
        (int24 tl, int24 tu, int256 liq) = abi.decode(data, (int24, int24, int256));
        (BalanceDelta delta,) = pm.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: tl, tickUpper: tu, liquidityDelta: liq, salt: bytes32(0)}), ""
        );
        int128 a0 = delta.amount0(); // ETH owed (negative)
        int128 a1 = delta.amount1(); // token owed (negative)
        if (a1 < 0) {
            pm.sync(key.currency1);
            IERC20D(Currency.unwrap(key.currency1)).transfer(address(pm), uint256(uint128(-a1)));
            pm.settle();
        }
        if (a0 < 0) {
            pm.settle{value: uint256(uint128(-a0))}();
        }
        return "";
    }
}

/// @notice Answers "does the impact-cap solution hold across pool depths?" on
///         PC's OWN pool. Measures a realistic 1-ETH burn attempt's price
///         movement and sandwich profitability at (a) thin launch depth and
///         (b) a deepened book. The fixed V4 price limit should make the
///         sandwich uneconomic when thin; added depth should simply allow more
///         of the attempted step to fill.
contract BuybackBurnerDepthScalingTest is ForkFixtures {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    TestSwapHelper internal swapper;
    LiquidityDeepener internal deepener;
    IPoolManager internal pm;
    PoolId internal pid;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
        adminContract.transferAdmin(address(this));
        pm = IPoolManager(V4_POOL_MANAGER);
        pid = burner.poolKey().toId();

        // Past the MEV window: skim at 5% baseline + public LP adds permitted.
        vm.warp(block.timestamp + 120 minutes);

        swapper = new TestSwapHelper(V4_POOL_MANAGER, address(token), hook, DYNAMIC_FEE_FLAG, TICK_SPACING);
        deepener = new LiquidityDeepener(pm, burner.poolKey());
    }

    function _spot() internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(pid);
    }

    function _devBps(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 d = a > b ? a - b : b - a;
        return (d * 10_000) / b;
    }

    /// @dev 1-ETH burner attempt under the fixed impact cap, isolated via
    ///      snapshot. Returns sqrt-price movement and ETH actually consumed.
    function _oneEthBurnAttempt() internal returns (uint256 bps, uint256 ethSpent) {
        uint256 s = vm.snapshotState();
        burner.setMaxStepWei(1 ether);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(burner).call{value: 1 ether}("");
        require(ok);
        vm.roll(block.number + burner.minBlocksBetweenSteps());
        uint160 p0 = _spot();
        uint256 spentBefore = burner.totalEthBurned();
        burner.executeStep(0);
        bps = _devBps(_spot(), p0);
        ethSpent = burner.totalEthBurned() - spentBefore;
        vm.revertToState(s);
    }

    /// @dev Best-case attacker P&L sandwiching a 1-ETH burn attempt, swept
    ///      over front-run sizes; isolated via snapshot.
    function _bestSandwichPnl() internal returns (int256 best, bool sawBurn) {
        uint256[5] memory pumps =
            [uint256(0.1 ether), 0.5 ether, 1 ether, 3 ether, 10 ether];
        best = type(int256).min;
        for (uint256 i = 0; i < pumps.length; i++) {
            uint256 s = vm.snapshotState();
            burner.setMaxStepWei(1 ether);
            vm.deal(address(this), 1 ether);
            (bool ok,) = address(burner).call{value: 1 ether}("");
            require(ok);
            vm.roll(block.number + burner.minBlocksBetweenSteps());

            uint256 pump = pumps[i];
            vm.deal(address(this), pump); // attacker holds exactly `pump`
            uint256 bought = swapper.buyTokenWithEth{value: pump}(pump); // front-run
            bool burned;
            try burner.executeStep(0) {
                burned = true;
            } catch {}
            IERC20D(address(token)).approve(address(swapper), bought);
            if (bought > 0) swapper.sellTokenForEth(bought); // back-run
            // started with `pump`, spent it on the buy; final balance = sellproceeds + reward
            int256 pnl = int256(address(this).balance) - int256(pump);
            if (burned && pnl > best) {
                sawBurn = true;
                best = pnl;
            }
            vm.revertToState(s);
        }
    }

    function _deepenPool(int256 liq) internal {
        (, int24 tick,,) = pm.getSlot0(pid);
        uint128 curL = pm.getLiquidity(pid);
        console2.log("pre-deepen active L:", uint256(curL));
        int24 sp = TICK_SPACING;
        int24 tl = ((tick - 30000) / sp) * sp;
        int24 tu = ((tick + 30000) / sp) * sp;
        // Fund the deepener generously; it settles only what it owes.
        vm.deal(address(deepener), 5_000_000 ether);
        deal(address(token), address(deepener), 500_000_000_000 ether);
        deepener.deepen(tl, tu, liq);
        console2.log("post-deepen active L:", uint256(pm.getLiquidity(pid)));
    }

    function test_ImpactCapHolds_AcrossDepths() public {
        // ── THIN (as launched) ──
        (uint256 thinImpact, uint256 thinSpent) = _oneEthBurnAttempt();
        (int256 thinSandwich, bool thinSawBurn) = _bestSandwichPnl();
        console2.log("THIN  1-ETH impact (bps):", thinImpact);
        console2.log("THIN  1-ETH spent (wei):", thinSpent);
        console2.log("THIN  best sandwich P&L (wei):");
        console2.logInt(thinSandwich);

        // Thin pool: the fixed price limit partial-fills the 1-ETH attempt
        // before it can clear the ~9.3% fee moat, so the sandwich is already
        // uneconomic without a stale-price gate.
        assertGt(thinImpact, 0, "thin: burn should move price");
        assertGt(thinSpent, 0, "thin: burn should consume ETH");
        assertTrue(thinSawBurn, "thin: swept sandwich should include a burn");
        assertLt(thinImpact, 900, "thin: impact cap should sit below fee moat");
        assertLt(thinSandwich, 0, "thin: sandwich unprofitable under impact cap");

        // ── DEEP (add a large absolute block of liquidity around spot) ──
        _deepenPool(int256(5e23));
        (uint256 deepImpact, uint256 deepSpent) = _oneEthBurnAttempt();
        (int256 deepSandwich, bool deepSawBurn) = _bestSandwichPnl();
        console2.log("DEEP  1-ETH impact (bps):", deepImpact);
        console2.log("DEEP  1-ETH spent (wei):", deepSpent);
        console2.log("DEEP  best sandwich P&L (wei):");
        console2.logInt(deepSandwich);

        // Deep pool: a 1-ETH attempt moves price even less, so the sandwich
        // stays unprofitable and more of the intended step should fill.
        assertTrue(deepSawBurn, "deep: swept sandwich should include a burn");
        assertLt(deepImpact, thinImpact, "deep: impact should fall vs thin");
        assertGt(deepSpent, thinSpent, "deep: more of the capped attempt should fill");
        assertLt(deepSandwich, 0, "deep: sandwich remains unprofitable");

        // With no manipulation a normal burn step proceeds and actually burns.
        {
            burner.setMaxStepWei(1 ether);
            vm.deal(address(this), 1 ether);
            (bool ok,) = address(burner).call{value: 1 ether}("");
            require(ok);
            vm.roll(block.number + burner.minBlocksBetweenSteps());
            uint256 burnedBefore = burner.totalEthBurned();
            burner.executeStep(0); // must NOT revert
            assertGt(burner.totalEthBurned(), burnedBefore, "deep: normal burn should proceed");
        }
    }
}
