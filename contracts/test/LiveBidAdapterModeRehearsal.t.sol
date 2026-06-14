// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";

import {SkimForkFixture} from "./helpers/SkimForkFixture.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";
import {LiveBidAdapter} from "../src/LiveBidAdapter.sol";

/// @notice Operational rehearsal for the `LiveBidAdapter` two-mode meter,
///         driven against the live-deployed `Deploy.s.sol` bytecode on a
///         mainnet fork. It walks the live bid through multiple FAST↔SLOW
///         toggles using REAL swaps (bid-leg skim), REAL sweeps, and REAL
///         `acceptBid`s (which re-sync the threshold), and emits a step-by-step
///         trace (`forge test -vv`) of threshold / live-bid / buffer / mode at
///         every action. The trace is the source for
///         `docs/ACTIVATION_THRESHOLD_REHEARSAL.md`.
///
///         The threshold / per-sweep cap / cooldown are admin-scaled DOWN from
///         the launch values (30 ETH / 0.5 ETH / 150 blk) to rehearsal values
///         (1 ETH / 0.1 ETH / 10 blk) via the live setters, so a feasible swap
///         volume crosses the threshold and the throttle drip is legible over a
///         few blocks. The metering LOGIC is identical at any scale — only the
///         magnitudes change. Assertions check the mode at each phase, the
///         throttle cap, the −25% re-sync, and that both events fire.
contract LiveBidAdapterModeRehearsalForkTest is SkimForkFixture {
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant TICK_SPACING = 200;

    // Rehearsal-scaled adapter parameters (admin setters; launch = 30/0.5/150).
    uint256 internal constant REH_THRESHOLD = 1 ether;
    uint256 internal constant REH_MAX_SWEEP = 0.1 ether;
    uint256 internal constant REH_COOLDOWN = 10;

    TestSwapHelper internal swapper;
    address internal trader;
    uint16 internal _cursor;
    uint256 internal _step;

    function setUp() public {
        string memory url = vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url);

        _runFullDeploy();

        swapper = new TestSwapHelper(POOL_MANAGER, token, deployedHook, DYNAMIC_FEE_FLAG, TICK_SPACING);
        trader = makeAddr("rehearsal-trader");
        vm.deal(trader, 2000 ether);

        // Past the MEV window: skim at the 6% baseline (simpler reasoning).
        vm.warp(block.timestamp + 90 minutes);

        // Scale the meter down for a legible rehearsal. These are the real
        // admin carve-out / rate-cap setters (the fixture holds the admin EOA).
        liveBidAdapter.setActivationThreshold(REH_THRESHOLD);
        liveBidAdapter.setMaxSweepWei(REH_MAX_SWEEP);
        liveBidAdapter.setMinBlocksBetweenSweeps(REH_COOLDOWN);
    }

    // ─── trace + helpers ─────────────────────────────────────────────────

    function _buy(uint256 ethIn) internal {
        vm.prank(trader);
        swapper.buyTokenWithEth{value: ethIn}(ethIn);
    }

    /// @dev One trace row: step, block, threshold, live bid, buffer, mode, note.
    function _snap(string memory note) internal {
        _step++;
        uint256 thr = liveBidAdapter.activationThreshold();
        uint256 bid = address(patron).balance;
        uint256 buf = liveBidAdapter.bufferedEth();
        console2.log(
            string.concat(
                "[", vm.toString(_step), "] blk=", vm.toString(block.number),
                " | thr=", _eth(thr), " | bid=", _eth(bid), " | buf=", _eth(buf),
                " | ", bid < thr ? "FAST" : "SLOW", " | ", note
            )
        );
    }

    /// @dev wei → "X.YYY" ETH string (3 decimals via milli-ETH).
    function _eth(uint256 w) internal view returns (string memory) {
        uint256 milli = w / 1e15;
        return string.concat(vm.toString(milli / 1000), ".", _pad3(milli % 1000));
    }

    function _pad3(uint256 x) internal view returns (string memory) {
        if (x >= 100) return vm.toString(x);
        if (x >= 10) return string.concat("0", vm.toString(x));
        return string.concat("00", vm.toString(x));
    }

    /// @dev Next un-recorded Punk with an eligible canonical target.
    function _nextEligible() internal returns (uint16 punkId, uint8 target) {
        for (uint16 i = _cursor; i < 10_000; i++) {
            if (pc.isRecorded(i)) continue;
            try pc.canonicalTargetOf(i) returns (uint8 t) {
                _cursor = i + 1;
                return (i, t);
            } catch {
                continue;
            }
        }
        revert("no eligible punk");
    }

    /// @dev Accept the current live bid with a fresh Punk; returns the clearing
    ///      price (== the live bid at accept time). The Punk enters a 72h
    ///      return auction; the acquisition is recorded at the clearing price,
    ///      which the next `sweep()` reads to re-sync the threshold.
    function _acceptCurrentBid(address seller) internal returns (uint256 clearing) {
        clearing = patron.bidBalance();
        (uint16 punkId, uint8 target) = _nextEligible();
        _giveAndOfferToBounty(seller, punkId); // lists EXCLUSIVELY to Patron at the live bid
        patron.acceptBid(punkId, target, type(uint256).max); // permissionless finalize
    }

    // ─── the rehearsal ─────────────────────────────────────────────────────

    function test_rehearsal_fastSlowToggle_withSwapsSweepsAndResets() public {
        vm.recordLogs();
        console2.log("=== LiveBidAdapter two-mode rehearsal (scaled: thr=1 ETH, cap=0.1 ETH, cooldown=10 blk) ===");
        _snap("start: live bid 0, below threshold");

        // ── PHASE 1 — FAST warm-up. Real swaps accrue bid-leg skim; each swap's
        //    hook _beforeSwap auto-streams the prior buffer, and an explicit
        //    sweep meters the rest. Below the threshold every forward is
        //    UNCAPPED (clamped only to land the bid AT the threshold). ──────────
        console2.log("-- PHASE 1: FAST warm-up (uncapped fill toward the threshold) --");
        uint256 g;
        while (address(patron).balance < liveBidAdapter.activationThreshold() && g < 40) {
            _buy(5 ether);
            try liveBidAdapter.sweep() returns (uint256 fwd) {
                _snap(string.concat("swap 5 ETH + sweep (forwarded ", _eth(fwd), ")"));
            } catch {
                _snap("swap 5 ETH (sweep no-op/throttled)");
            }
            g++;
        }
        assertGe(address(patron).balance, liveBidAdapter.activationThreshold(), "P1: warm-up reached the threshold");
        _snap("threshold reached -> mode flips to SLOW (ThresholdCrossed fired)");

        // ── PHASE 2 — SLOW throttle. At/above the threshold a forward is capped
        //    at maxSweepWei per cooldown. Show the drip + the cooldown gate. ────
        console2.log("-- PHASE 2: SLOW throttle (<= maxSweepWei per cooldown) --");
        _buy(10 ether); // more skim buffers; the in-swap auto-stream is throttled now
        _snap("swap 10 ETH (SLOW: skim buffers, bid barely moves)");

        // An immediate second sweep in the same cooldown window reverts.
        vm.expectRevert(); // SweepTooEarly
        liveBidAdapter.sweep();
        _snap("immediate 2nd sweep reverts SweepTooEarly (cooldown active)");

        for (uint256 i = 0; i < 3; i++) {
            vm.roll(block.number + liveBidAdapter.minBlocksBetweenSweeps());
            uint256 fwd = liveBidAdapter.sweep();
            assertLe(fwd, liveBidAdapter.maxSweepWei(), "P2: SLOW forward capped at maxSweepWei");
            _snap(string.concat("warp 10 blk + sweep (forwarded ", _eth(fwd), ", capped <= 0.100)"));
        }

        // ── PHASE 3 — RESET via acceptBid. Accepting the live bid spends it
        //    (Patron drops toward 0) and records the clearing price; the next
        //    sweep re-syncs the threshold to 75% of it, dropping the bid back
        //    BELOW the threshold -> FAST again. ────────────────────────────────
        console2.log("-- PHASE 3: acceptBid reset (live bid spent; threshold re-syncs to 75% of clearing) --");
        uint256 clearing1 = _acceptCurrentBid(makeAddr("reh-seller-1"));
        _snap(string.concat("acceptBid at ", _eth(clearing1), " ETH (bid spent; Punk -> 72h return auction)"));

        uint256 fwdR = liveBidAdapter.sweep(); // runs _syncActivationThreshold first
        _snap(string.concat("sweep: threshold re-synced (forwarded ", _eth(fwdR), ")"));
        assertApproxEqAbs(
            liveBidAdapter.activationThreshold(), (clearing1 * 75) / 100, 1e12, "P3: threshold = 75% of clearing price"
        );
        assertLt(address(patron).balance, liveBidAdapter.activationThreshold(), "P3: bid below new threshold -> FAST");

        // ── PHASE 4 — second cycle. Fast-fill to the NEW (lower) threshold,
        //    cross again, then a second acceptBid re-syncs once more. Proves the
        //    toggle + reset repeat and the threshold tracks the revealed floor. ─
        console2.log("-- PHASE 4: second FAST warm-up -> cross -> second reset --");
        uint256 g2;
        while (address(patron).balance < liveBidAdapter.activationThreshold() && g2 < 40) {
            _buy(5 ether);
            try liveBidAdapter.sweep() returns (uint256 fwd) {
                _snap(string.concat("swap 5 ETH + sweep (forwarded ", _eth(fwd), ")"));
            } catch {
                _snap("swap 5 ETH (sweep no-op/throttled)");
            }
            g2++;
        }
        assertGe(address(patron).balance, liveBidAdapter.activationThreshold(), "P4: second warm-up crossed");
        _snap("second crossing -> SLOW (second ThresholdCrossed)");

        uint256 clearing2 = _acceptCurrentBid(makeAddr("reh-seller-2"));
        _snap(string.concat("second acceptBid at ", _eth(clearing2), " ETH"));
        liveBidAdapter.sweep();
        _snap(string.concat("sweep: threshold re-synced to ", _eth(liveBidAdapter.activationThreshold()), " (75% of clearing)"));
        assertApproxEqAbs(
            liveBidAdapter.activationThreshold(), (clearing2 * 75) / 100, 1e12, "P4: second reset = 75% of clearing"
        );

        // ── Event tally — confirm both toggles + both re-syncs actually fired. ─
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 crossedSig = keccak256("ThresholdCrossed(uint256,uint256)");
        bytes32 syncedSig = keccak256("ActivationThresholdSynced(uint256,uint256,uint256)");
        uint256 crossed;
        uint256 synced;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(liveBidAdapter)) continue;
            if (logs[i].topics[0] == crossedSig) crossed++;
            if (logs[i].topics[0] == syncedSig) synced++;
        }
        console2.log(string.concat("ThresholdCrossed events: ", vm.toString(crossed)));
        console2.log(string.concat("ActivationThresholdSynced events: ", vm.toString(synced)));
        assertGe(crossed, 2, "two upward threshold crossings (FAST->SLOW twice)");
        assertGe(synced, 2, "two acceptBid re-syncs (down-tracking the revealed floor)");
        console2.log("=== rehearsal complete: FAST<->SLOW toggled across 2 cycles, threshold tracked 2 resets ===");
    }
}
