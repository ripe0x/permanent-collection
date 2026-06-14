// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SkimForkFixture} from "./helpers/SkimForkFixture.sol";
import {VerifyDeploy} from "../script/VerifyDeploy.s.sol";
import {DeployArtcoinsLaunchStack} from "../script/DeployArtcoinsLaunchStack.s.sol";

/// @title  DeployRehearsalForkTest
/// @notice Production-launch DRESS REHEARSAL on a mainnet fork. It runs the full
///         launch sequence end to end with the SAME code the mainnet broadcast
///         runs:
///           1. the artcoins owner-ops fresh-stack deploy (the shared
///              `PCLaunchStackDeployer`, the exact code `DeployArtcoinsLaunchStack`
///              broadcasts) — driven here by `SkimForkFixture._runFullDeploy`,
///           2. PC's production Phase-2 SPLIT via `SkimForkFixture._runSplitDeploy`:
///              `runContracts()` (Phase 2a, PC contracts dormant, token/hook/
///              locker = 0) then a FRESH instance's `runToken()` (Phase 2b,
///              token + pool + LP + setup) — the EXACT two `forge --sig`
///              broadcasts, communicating only via `deployments.json`. NOT the
///              legacy combined `run()`: we rehearse what we ship.
///           3. `VerifyDeploy` (asserts the H-1 escrow-depositor + every wiring),
///           4. a live `acceptBid` smoke against the deployed system.
///         Plus a direct test that the production owner-ops SCRIPT itself
///         deploys a correctly-wired stack. If this suite is green, the mainnet
///         broadcast runs the same bytes against the same state — the hard
///         pre-broadcast gate.
///
///         (Swap-direction skim + the full acquisition state machine are
///         exercised against this same deploy path by `LaunchInvariantForkTest`;
///         this suite focuses on the deploy + verify + a single smoke.)
contract DeployRehearsalForkTest is SkimForkFixture {
    function setUp() public {
        string memory url =
            vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url);
        // Rehearse the PRODUCTION Phase-2 SPLIT (runContracts → verify-dormant →
        // runToken), not the legacy combined run(). See `_runFullDeploySplit`.
        _runFullDeploySplit();
    }

    /// @notice The deployed protocol passes `VerifyDeploy`, INCLUDING the H-1
    ///         assertion that the skim hook is an escrow depositor (without
    ///         which the first and every swap reverts).
    function test_rehearsal_deployPassesVerifyDeploy() public {
        new VerifyDeploy().run();
    }

    /// @notice Smoke: the live deployed system records an acquisition end to end
    ///         via the production `acceptBid` flow.
    function test_rehearsal_acceptBidSmoke() public {
        _fundPatronFromAdapter(100 ether);

        // Any seller works: acceptBid pays the seller via the market
        // (pendingWithdrawals), so there is no push to a `receive()` to revert.
        address seller = makeAddr("rehearsal-seller");

        // #8348 carries the rarity-1 sole-carrier trait (bit 23); its canonical
        // target is deterministic. Any owned Punk works — this one also
        // exercises the sole-carrier guard path.
        uint16 punkId = 8348;
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);

        // acceptBid is permissionless; expectedListingWei caps the price the
        // protocol will pay (max here — the seller listed at the live bid).
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);
        assertEq(pc.acquisitionCount(), 1, "rehearsal: acquisition recorded");
    }

    /// @notice The PRODUCTION owner-ops script itself deploys a correctly-wired
    ///         stack — `run()` reverts if the hook CREATE2 address doesn't match
    ///         or the wiring fails, so a clean run proves the broadcast artifact.
    function test_rehearsal_productionOwnerOpsScript() public {
        vm.setEnv("PRIVATE_KEY", vm.toString(DEV_PK));
        vm.setEnv("PC_TREASURY", vm.toString(makeAddr("pc-treasury")));
        vm.setEnv("LAYER_BURN_ROUTER", vm.toString(makeAddr("layer-burn-router")));
        vm.deal(vm.addr(DEV_PK), 5 ether);

        new DeployArtcoinsLaunchStack().run();
    }

    /// @notice The split rehearsal (run in `setUp` via `_runSplitDeploy`) ends
    ///         with Phase 2b having launched the token, pool, and locker. The
    ///         2a→2b transition is proven end to end: `_assertPhase2aDormant`
    ///         (at the split boundary in the fixture) would have reverted `setUp`
    ///         if Phase 2a left a non-zero token/hook/locker, and this asserts
    ///         Phase 2b then filled them via the exact production `runToken()`
    ///         broadcast. So the rehearsed deploy is the two-broadcast sequence
    ///         we ship, not the legacy combined `run()`.
    function test_rehearsal_phase2SplitLaunchesTokenPoolLocker() public view {
        assertTrue(token != address(0), "phase2b: token launched");
        assertTrue(deployedHook != address(0), "phase2b: pool hook bound");
        assertTrue(deployedLocker != address(0), "phase2b: conversion locker live");
    }
}
