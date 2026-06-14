// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SkimForkFixture} from "./helpers/SkimForkFixture.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Fork verification of the new locker geometry (launch-tick
///         shift to ~$69K FDV + position 0 thickening + tail rebalance).
///         Now runnable after MAX_SKIM_BPS in the artcoins submodule was
///         raised 70_000 -> 90_000 to support PC's 90% anti-sniper start.
///
///         **Goals:**
///           1. Confirm `_runFullDeploy` (via `SkimForkFixture` →
///              `DeployScript.run()`) lands the pool at the expected
///              on-pool launch tick (+172,200 at default ETH=$2,100).
///           2. Measure slippage at 6 buy sizes (0.1, 1, 5, 10, 50, 100
///              ETH) on fresh pool state.
///           3. Report on-pool position upper-bound ticks for offline
///              FDV verification against the artist's spec.
contract LauncherGeometryVerificationTest is SkimForkFixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal constant V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant TICK_SPACING = 200;

    TestSwapHelper internal swapHelper;

    function setUp() public {
        string memory url =
            vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url);

        _runFullDeploy();

        // Warp past the MEV window so the hook no longer blocks
        // `beforeAddLiquidity` and the skim has settled to the 5% baseline.
        vm.warp(block.timestamp + 90 minutes);

        swapHelper = new TestSwapHelper(
            V4_POOL_MANAGER, token, deployedHook, DYNAMIC_FEE_FLAG, TICK_SPACING
        );
    }

    function test_LaunchTickAtExpectedValue() public view {
        PoolKey memory key = _key();
        (uint160 sqrt, int24 tick,,) =
            IPoolManager(V4_POOL_MANAGER).getSlot0(key.toId());

        console2.log("=== LAUNCH-TICK CHECK ===");
        console2.log("On-pool launch tick:        ", int256(tick));
        console2.log("sqrtPriceX96:               ", uint256(sqrt));
        console2.log("Expected on-pool tick:       +172_200 (config -172_200, factory inverts)");

        assertLe(tick, int24(173_000), "tick too high (>173_000)");
        assertGe(tick, int24(171_400), "tick too low (<171_400)");
    }

    function test_SlippageAtSixBuySizes() public {
        uint256[6] memory sizes = [
            uint256(0.1 ether),
            uint256(1 ether),
            uint256(5 ether),
            uint256(10 ether),
            uint256(50 ether),
            uint256(100 ether)
        ];

        PoolKey memory key = _key();
        PoolId pid = key.toId();
        (uint160 launchSqrt, int24 launchTick,,) =
            IPoolManager(V4_POOL_MANAGER).getSlot0(pid);

        console2.log("=== SLIPPAGE PROBE: SIX BUY SIZES ===");
        console2.log("Launch tick:                ", int256(launchTick));
        console2.log("Launch sqrtPriceX96:        ", uint256(launchSqrt));
        console2.log("");
        console2.log("Spot rate at launch = (sqrtPriceX96 / 2^96)^2 (111/ETH, 18-dec wei ratio).");
        console2.log("Effective rate per buy = pctOut(raw)/ethIn(raw) (= whole-111/whole-ETH).");
        console2.log("Slippage% = 1 - effectiveRate/spotRate (compute offline).");
        console2.log("");

        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 ethIn = sizes[i];
            uint256 snap = vm.snapshotState();

            vm.deal(address(this), ethIn);
            uint256 pctOut = swapHelper.buyTokenWithEth{value: ethIn}(ethIn);

            (uint160 postSqrt, int24 postTick,,) =
                IPoolManager(V4_POOL_MANAGER).getSlot0(pid);

            // Effective rate (raw-wei 111 per raw-wei ETH = whole-111 per whole-ETH).
            uint256 effectiveRate = (pctOut * 1) / ethIn;

            console2.log("--- buy size (wei):        ", ethIn);
            console2.log("    111 received (raw):    ", pctOut);
            console2.log("    effective 111/ETH:     ", effectiveRate);
            console2.log("    post-swap tick:        ", int256(postTick));
            console2.log("    tick delta:            ", int256(postTick) - int256(launchTick));
            console2.log("    post-swap sqrtPriceX96:", uint256(postSqrt));
            console2.log("");

            vm.revertToState(snap);
        }
    }

    function test_FdvAtPositionUpperBounds() public view {
        // 14-position geometry: positions 0-11 unchanged; positions 12-13 are
        // the new concentrated high-FDV tails (+72k / +83k offsets).
        int24[14] memory upperOffsets = [
            int24(1_400), 3_400, 6_000, 9_400, 14_000, 19_400,
            26_000, 33_000, 40_000, 47_000, 53_400, 60_000, 72_000, 83_000
        ];

        PoolKey memory key = _key();
        (, int24 launchTick,,) =
            IPoolManager(V4_POOL_MANAGER).getSlot0(key.toId());

        console2.log("=== POSITION UPPER-BOUND TICKS (on-pool) ===");
        console2.log("On-pool launch tick:        ", int256(launchTick));
        console2.log("Position i: on-pool upper = launchTick - upperOffsets[i]");
        console2.log("Implied FDV (offline): supply / 1.0001^(on_pool_upper) * ETH_USD_PRICE");
        console2.log("");

        for (uint256 i = 0; i < 14; i++) {
            int24 onPoolUpper = launchTick - upperOffsets[i];
            console2.log("  pos:                      ", i);
            console2.log("    upper offset:           ", int256(upperOffsets[i]));
            console2.log("    on-pool upper tick:     ", int256(onPoolUpper));
        }

        console2.log("");
        console2.log("Expected USD FDVs at upper bounds (artist spec, ETH=$2,100, supply=999M):");
        console2.log("  0: ~$79K   1: ~$97K   2: ~$126K  3: ~$177K");
        console2.log("  4: ~$280K  5: ~$481K  6: ~$933K  7: ~$1.87M");
        console2.log("  8: ~$3.77M 9: ~$7.60M 10: ~$14.4M 11: ~$27.9M");
        console2.log("  12: ~$103M 13: ~$310M  (NEW concentrated tails)");
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(deployedHook)
        });
    }
}
