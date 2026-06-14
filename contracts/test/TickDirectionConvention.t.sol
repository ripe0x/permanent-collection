// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ForkFixtures} from "./helpers/ForkFixtures.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Empirical verification of the V4 tick-direction convention for the
///         111PUNKS pool. Critical sanity check: the locker's 12-position
///         geometry (configured as ticks -190_400 .. -130_400, BPS-weighted
///         to a thin-floor taper) only makes sense under one specific
///         tick-direction convention. The factory may or may not invert the
///         configured ticks before passing them to V4 (depends on which side
///         of the pair the art coin lands on by address). Until this is
///         confirmed empirically, ALL claims about "where the locker depth
///         is" are speculative.
///
///         Probe: read pool current tick + sqrtPriceX96, execute a 0.1 ETH
///         → 111 buy via the standard TestSwapHelper, read the tick again,
///         log both values + delta + the 111 received.
///
///         **Interpretation rule** (per the artist's spec):
///           - If post-swap tick DECREASED on a 111 buy → standard V4
///             convention (price = token1/token0 = 111/ETH; buying 111
///             consumes the token1 side, lowering the ratio). The locker
///             positions span the tick range in the direction 111
///             appreciation moves the price.
///           - If post-swap tick INCREASED on a 111 buy → non-standard
///             convention (either V4 has been customized, the factory is
///             doing something unusual, or my mental model is wrong).
///             STOP all tick-related work until clarified.
///
///         The test does not hard-assert direction. It logs the result
///         verbosely and asserts only that a swap actually happened (111
///         received > 0, tick changed). The interpretation is for the
///         operator reading the test output.
contract TickDirectionConventionTest is ForkFixtures {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    TestSwapHelper internal swapHelper;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();

        // Warp past the MEV window so the hook doesn't reject anything else
        // we want to do (the swap path itself isn't gated by the window,
        // but other tests in the suite assume post-window state).
        vm.warp(block.timestamp + 90 minutes);

        swapHelper = new TestSwapHelper(
            V4_POOL_MANAGER, address(token), hook, DYNAMIC_FEE_FLAG, TICK_SPACING
        );
    }

    /// @notice The probe. Read tick, buy 0.1 ETH of 111, read tick again.
    ///         Log everything. Assert only that the swap happened — leave
    ///         direction interpretation to the reader.
    function test_BuyingPctMovesTickInExpectedDirection() public {
        PoolKey memory key = _key();
        PoolId pid = key.toId();

        // ── 1. pre-swap state ────────────────────────────────────────
        (uint160 preSqrt, int24 preTick,,) =
            IPoolManager(V4_POOL_MANAGER).getSlot0(pid);

        console2.log("=== TICK DIRECTION CONVENTION PROBE ===");
        console2.log("Pre-swap tick:           ", int256(preTick));
        console2.log("Pre-swap sqrtPriceX96:   ", uint256(preSqrt));
        console2.log("Configured STARTING_TICK in Deploy.s.sol: -190400");
        console2.log("(If pre-swap tick matches -190400, factory did NOT invert.)");
        console2.log("(If pre-swap tick matches +190400, factory inverted.)");
        console2.log("");

        // ── 2. probe swap: 0.1 ETH -> 111 ────────────────────────────
        uint256 ethIn = 0.1 ether;
        vm.deal(address(this), ethIn);
        uint256 pctOut = swapHelper.buyTokenWithEth{value: ethIn}(ethIn);

        // ── 3. post-swap state ───────────────────────────────────────
        (uint160 postSqrt, int24 postTick,,) =
            IPoolManager(V4_POOL_MANAGER).getSlot0(pid);

        int256 tickDelta = int256(postTick) - int256(preTick);

        console2.log("Post-swap tick:          ", int256(postTick));
        console2.log("Post-swap sqrtPriceX96:  ", uint256(postSqrt));
        console2.log("Tick delta (signed):     ", tickDelta);
        console2.log("ETH spent (wei):         ", ethIn);
        console2.log("111 received (raw):      ", pctOut);
        console2.log("");

        // ── 4. direction interpretation (informational) ──────────────
        if (postTick < preTick) {
            console2.log("DIRECTION: tick DECREASED.");
            console2.log("Interpretation: STANDARD V4 convention.");
            console2.log("  price = token1/token0 = 111/ETH.");
            console2.log("  Buying 111 consumes the token1 side, lowering the");
            console2.log("  111/ETH ratio. Tick goes DOWN.");
            console2.log("  111 appreciation -> further-DOWN ticks.");
            console2.log("Locker positions (configured -190_400..-130_400)");
            console2.log("must be analyzed under the actual post-factory placement");
            console2.log("(compare 'Pre-swap tick' above to -190_400 vs +190_400).");
        } else if (postTick > preTick) {
            console2.log("DIRECTION: tick INCREASED.");
            console2.log("Interpretation: NON-STANDARD or unexpected.");
            console2.log("  Could be: factory applies a custom tick transform,");
            console2.log("  pair ordering not as expected, or different price");
            console2.log("  convention.");
            console2.log("STOP all locker-geometry work pending clarification.");
        } else {
            console2.log("DIRECTION: tick UNCHANGED.");
            console2.log("Anomaly: a non-zero swap on a non-empty pool should");
            console2.log("always move the tick. Investigate the test setup.");
        }

        // ── 5. assertions (sanity only — don't bake in direction) ────
        assertGt(pctOut, 0, "swap returned zero 111 (no fill)");
        assertTrue(preTick != postTick, "tick did not change");
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }
}
