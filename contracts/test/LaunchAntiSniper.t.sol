// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ForkFixtures} from "./helpers/ForkFixtures.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";

/// @notice Asserts the 111PUNKS pool launches with the anti-sniper SKIM window:
///         a 90% skim at t=0 linearly decaying ~2.8%/min to the 6% baseline over
///         30 minutes (1_800 s), via `ArtCoinsMevLinearSkim`. The skim-module
///         denominator is 100_000 (= 100%), so 90_000 = 90%, 6_000 = 6%.
///
///         (Rewritten from the legacy linear-FEES module the pre-redesign stack
///         bound — audit H3.)
///
/// @dev    The skim module is compiled against the artcoins-vendored v4-core, so
///         its `PoolId` is a DISTINCT type from PC's `PoolId` (the classic two-
///         v4-core clash). We call it via the ABI signature with the underlying
///         `bytes32` poolId to avoid the type mismatch.
contract LaunchAntiSniperTest is ForkFixtures {
    using PoolIdLibrary for PoolKey;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
    }

    function _poolKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    function _pidBytes() internal view returns (bytes32) {
        return PoolId.unwrap(_poolKey().toId());
    }

    function _currentSkimBps() internal view returns (uint256) {
        (bool ok, bytes memory ret) = address(mevSkimModule).staticcall(
            abi.encodeWithSignature("currentSkimBps(bytes32)", _pidBytes())
        );
        require(ok, "currentSkimBps call failed");
        return uint256(abi.decode(ret, (uint24)));
    }

    function _operational() internal view returns (bool) {
        (bool ok, bytes memory ret) = address(mevSkimModule).staticcall(
            abi.encodeWithSignature("operational(bytes32)", _pidBytes())
        );
        require(ok, "operational call failed");
        return abi.decode(ret, (bool));
    }

    // ─── A. t≈0 → ~90% skim, window live ──────────────────────────────
    function test_anti_sniper_skim_starts_near_90_percent() public view {
        assertTrue(_operational(), "window should be live at launch");
        // 90_000 peak (90%); a few seconds may have elapsed since pool init
        // (1%/min = ~16.7 skim-bps/s), so allow a small band.
        assertApproxEqAbs(_currentSkimBps(), 90_000, 1_000, "expected ~90% skim at launch");
    }

    // ─── B. linear decay at 1%/min ────────────────────────────────────
    function test_anti_sniper_skim_interpolates_linearly() public {
        uint256 startSkim = _currentSkimBps();
        vm.warp(block.timestamp + 600); // +10 min → ~-28% = ~-28_000 skim-bps (~2.8%/min)
        uint256 laterSkim = _currentSkimBps();
        assertApproxEqAbs(startSkim - laterSkim, 28_000, 100, "expected ~28% drop over 10 min");
    }

    // ─── C. past the 30-min window → baseline, closed ─────────────────
    function test_anti_sniper_skim_drops_to_baseline_after_duration() public {
        vm.warp(block.timestamp + 1_900); // > 1_800 s duration
        assertLe(_currentSkimBps(), 6_000, "expected skim at/below 6% baseline past duration");
        assertFalse(_operational(), "window should be closed past duration");
    }

    // ─── D. pool actually bound to the skim module ────────────────────
    function test_pool_is_bound_to_skim_module() public view {
        assertTrue(_operational(), "skim module not bound/operational for pool");
    }
}
