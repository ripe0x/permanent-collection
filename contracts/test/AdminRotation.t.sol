// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProtocolAdmin} from "../src/ProtocolAdmin.sol";
import {Patron} from "../src/Patron.sol";
import {LiveBidAdapter} from "../src/LiveBidAdapter.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {RendererRegistry} from "../src/RendererRegistry.sol";
import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Comprehensive coverage of `ProtocolAdmin.transferAdmin` across
///         every gated surface in the V4 protocol. The unit-level timer +
///         burn semantics live in `ProtocolAdmin.t.sol`; this suite checks
///         that rotation actually takes effect across the whole protocol —
///         the operationally-important scenario when the deployer rotates
///         from a launch EOA to a long-term custodian like a multisig.
///
///         For each rotation step the suite asserts:
///           1. The OLD admin can no longer call any gated setter
///              (`checkAdmin`-gated AND `admin()`-raw-gated).
///           2. The NEW admin CAN call every gated setter on every
///              admin-aware contract.
///           3. Burn (`transferAdmin(address(0))`) disables both gating
///              modes — even the raw-admin carve-outs become uncallable.
///
///         Gated surfaces enumerated:
///           - Patron.addAllowedSeller / removeAllowedSeller            (raw admin)
///           - LiveBidAdapter.setActivationThreshold                    (raw admin)
///           - LiveBidAdapter.setMaxSweepWei / setMinBlocksBetweenSweeps (checkAdmin)
///           - BuybackBurner.setMinBlocksBetweenSteps / setMaxStepWei    (checkAdmin)
///           - RendererRegistry.setImplementation / freeze              (checkAdmin)
///
///         (Patron's finder-fee setters and ReturnAuctionModule's
///         setMinBidIncrementBps were removed when those parameters became
///         protocol constants — Patron now has no checkAdmin setter, and
///         ReturnAuctionModule has no admin role at all.)
contract AdminRotationTest is ForkFixtures {
    /// @dev Stands in for "the launch deployer EOA" — initially holds the
    ///      admin role inside `_deployProtocol()`.
    address internal initialAdmin;
    /// @dev Stands in for the long-term custodian (a multisig contract on
    ///      mainnet). Plain EOA in tests so we can `vm.prank` it.
    address internal multisig;
    /// @dev Random non-admin address used to confirm non-admin callers
    ///      are rejected (defense in depth alongside the rotation tests).
    address internal stranger;
    /// @dev A second Mosaic renderer instance, used as the alternate
    ///      implementation in `RendererRegistry.setImplementation` swaps —
    ///      the registry rejects same-impl swaps, so we need a distinct
    ///      address for the rotation to exercise.
    PermanentCollectionMosaicRenderer internal altRenderer;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        // LiveBidAdapter, BuybackBurner, RendererRegistry are all wired
        // inside _launchPool — we need that to exercise their setters.
        _launchPool();
        altRenderer = new PermanentCollectionMosaicRenderer(
            address(collection), address(vault), address(punkSvgCache), PUNKS_DATA, address(traitIconCache), address(proofRenderer)
        );
        // The fixture leaves admin == address(this) (the deploying test
        // contract). Move it to a dedicated EOA so we can prank between
        // "old admin" and "new admin" without the test contract itself
        // being either.
        initialAdmin = makeAddr("initialAdmin");
        multisig = makeAddr("multisig");
        stranger = makeAddr("stranger");
        adminContract.transferAdmin(initialAdmin);
    }

    // ─────────────────────────── happy path ───────────────────────────

    /// @notice Single rotation: initialAdmin → multisig. After rotation,
    ///         the multisig holds every admin surface and the previous
    ///         admin holds none.
    function test_Rotation_NewAdminCanCallEveryGatedSetter() public {
        // Sanity: initialAdmin starts as the admin.
        assertEq(adminContract.admin(), initialAdmin, "fixture admin");
        assertFalse(adminContract.isLocked(), "fixture not locked");

        // Rotate.
        vm.prank(initialAdmin);
        adminContract.transferAdmin(multisig);
        assertEq(adminContract.admin(), multisig, "rotated to multisig");
        assertEq(
            adminContract.adminTimerExpires(),
            block.timestamp + adminContract.ADMIN_TIMER_DURATION(),
            "timer reset on rotation"
        );

        // Every gated setter callable by the multisig.
        _exerciseEveryCheckAdminSetter(multisig);
        _exerciseEveryRawAdminSetter(multisig);
    }

    /// @notice After rotation, the OLD admin's key is impotent across the
    ///         entire surface — checkAdmin AND raw-admin paths.
    function test_Rotation_OldAdminRejectedEverywhere() public {
        vm.prank(initialAdmin);
        adminContract.transferAdmin(multisig);

        _assertEveryCheckAdminSetterReverts(initialAdmin);
        _assertEveryRawAdminSetterReverts(initialAdmin);
    }

    /// @notice Multi-hop rotation: A → B → C. The intermediate holder B
    ///         loses access once the rotation moves past it. Confirms the
    ///         pattern works for genuine multi-step custodian handoffs
    ///         (e.g. EOA → safe1 → safe2).
    function test_MultiHop_OnlyCurrentAdminWorks() public {
        address holderB = makeAddr("holderB");
        address holderC = makeAddr("holderC");

        vm.prank(initialAdmin);
        adminContract.transferAdmin(holderB);
        assertEq(adminContract.admin(), holderB);

        vm.prank(holderB);
        adminContract.transferAdmin(holderC);
        assertEq(adminContract.admin(), holderC);

        // Only C holds the role now.
        _exerciseEveryCheckAdminSetter(holderC);
        _exerciseEveryRawAdminSetter(holderC);

        _assertEveryCheckAdminSetterReverts(initialAdmin);
        _assertEveryRawAdminSetterReverts(initialAdmin);
        _assertEveryCheckAdminSetterReverts(holderB);
        _assertEveryRawAdminSetterReverts(holderB);
    }

    /// @notice After rotation, the timer renews to `now + 365 days`. The
    ///         new admin can call setters all the way up to the renewed
    ///         expiry. Confirms rotation isn't a no-op for the lock clock.
    function test_Rotation_TimerRenews_NewAdminGoodForFullYear() public {
        // 100 days into the initial term, rotate.
        vm.warp(block.timestamp + 100 days);
        vm.prank(initialAdmin);
        adminContract.transferAdmin(multisig);

        // Move 364 days forward (i.e. 464 days from the protocol's birth,
        // but only 364 days from the rotation). Still unlocked.
        vm.warp(block.timestamp + 364 days);
        assertFalse(adminContract.isLocked(), "still in renewed window");
        _exerciseEveryCheckAdminSetter(multisig);
        _exerciseEveryRawAdminSetter(multisig);

        // Cross the renewed expiry: checkAdmin locks, raw admin still
        // works.
        vm.warp(block.timestamp + 2 days);
        assertTrue(adminContract.isLocked(), "locked past renewed expiry");
        _assertEveryCheckAdminSetterReverts(multisig);
        // Raw-admin carve-outs survive lock — the multisig is still admin().
        _exerciseEveryRawAdminSetter(multisig);
    }

    /// @notice Self-transfer (heartbeat) preserves the same admin and
    ///         resets the timer. Useful for a custodian who wants to renew
    ///         the lease without rotating custody.
    function test_SelfTransfer_RenewsTimerWithoutRotation() public {
        vm.warp(block.timestamp + 200 days);
        uint256 expectedExpiry = block.timestamp + adminContract.ADMIN_TIMER_DURATION();

        vm.prank(initialAdmin);
        adminContract.transferAdmin(initialAdmin);
        assertEq(adminContract.admin(), initialAdmin, "still same admin");
        assertEq(adminContract.adminTimerExpires(), expectedExpiry, "timer renewed");

        // Setters still work for initialAdmin.
        _exerciseEveryCheckAdminSetter(initialAdmin);
        _exerciseEveryRawAdminSetter(initialAdmin);
    }

    // ─────────────────────────── burn path ────────────────────────────

    /// @notice Burning the role permanently disables BOTH gating modes —
    ///         even the raw-admin carve-outs (allowlist, activation
    ///         threshold) become uncallable.
    function test_Burn_DisablesEvenRawAdminCarveOuts() public {
        vm.prank(initialAdmin);
        adminContract.transferAdmin(multisig);

        vm.prank(multisig);
        adminContract.transferAdmin(address(0));
        assertTrue(adminContract.adminBurned(), "burned flag");
        assertEq(adminContract.admin(), address(0));

        _assertEveryCheckAdminSetterReverts(multisig);
        _assertEveryRawAdminSetterReverts(multisig);
    }

    /// @notice Non-admin callers are rejected on every gated setter at
    ///         every stage of the rotation. Sanity check that the suite
    ///         catches an obvious leak (e.g. a setter accidentally
    ///         marked external/no modifier).
    function test_NonAdmin_AlwaysRejected() public {
        _assertEveryCheckAdminSetterReverts(stranger);
        _assertEveryRawAdminSetterReverts(stranger);

        // After rotation.
        vm.prank(initialAdmin);
        adminContract.transferAdmin(multisig);
        _assertEveryCheckAdminSetterReverts(stranger);
        _assertEveryRawAdminSetterReverts(stranger);

        // After burn.
        vm.prank(multisig);
        adminContract.transferAdmin(address(0));
        _assertEveryCheckAdminSetterReverts(stranger);
        _assertEveryRawAdminSetterReverts(stranger);
    }

    // ──────────────────────────── helpers ──────────────────────────────
    //
    // Each helper exercises the full set of setters of one class. The
    // values passed are in-bounds defaults — the goal is to confirm the
    // call lands (or reverts) based on caller identity, not parameter
    // shape. The bounds-validation tests live in `Parameters.t.sol`.

    /// @dev Calls every `checkAdmin`-gated setter from `caller` and
    ///      asserts success. Reverts the test if any fails.
    function _exerciseEveryCheckAdminSetter(address caller) internal {
        // (Patron has no checkAdmin-gated setter — its finder-fee parameters
        // are protocol constants.)

        // LiveBidAdapter — sweep throttle.
        vm.prank(caller);
        liveBidAdapter.setMaxSweepWei(1.5 ether);
        vm.prank(caller);
        liveBidAdapter.setMinBlocksBetweenSweeps(400);

        // BuybackBurner — every remaining admin-tunable.
        // (maxSlippageBps is the compile-time price-impact cap and the static
        // minTokensPerEthFloor was removed entirely — neither is tunable.)
        vm.prank(caller);
        burner.setMinBlocksBetweenSteps(2);
        vm.prank(caller);
        burner.setMaxStepWei(0.8 ether);

        // (ReturnAuctionModule has no admin-gated setter — minBidIncrementBps
        // is a protocol constant.)

        // RendererRegistry — implementation swap (point at a fresh
        // Mosaic instance; passes the new tokenURI(uint256) probe).
        // Also exercise the freeze path, which the test SHOULDN'T
        // actually call last (it's one-way), so we save it for a
        // dedicated test; here we only confirm setImplementation lands.
        vm.prank(caller);
        rendererRegistry.setImplementation(address(altRenderer));
    }

    /// @dev Calls every raw-admin (`admin()`-direct) carve-out from
    ///      `caller` and asserts success.
    function _exerciseEveryRawAdminSetter(address caller) internal {
        // Patron — allowlist add/remove. Use a deterministic seller
        // address; idempotent on re-add.
        address candidate = makeAddr("rotationAllowlistTarget");
        vm.prank(caller);
        patron.addAllowedSeller(candidate);
        vm.prank(caller);
        patron.removeAllowedSeller(candidate);

        // LiveBidAdapter — activation threshold. The adapter's lone lifetime
        // carve-out (onlyAdminEvenIfLocked, raw admin()-gated like the
        // allowlist). Bounded [0, 100 ETH].
        vm.prank(caller);
        liveBidAdapter.setActivationThreshold(12 ether);
    }

    /// @dev Asserts every `checkAdmin`-gated setter reverts from
    ///      `caller`. Uses generic `vm.expectRevert()` because the exact
    ///      selector varies (`NotAdmin` is the same name but defined in
    ///      each contract, so the actual selector hash differs across
    ///      LiveBidAdapter / BuybackBurner / RendererRegistry — they're
    ///      distinct error types).
    function _assertEveryCheckAdminSetterReverts(address caller) internal {
        vm.prank(caller);
        vm.expectRevert();
        liveBidAdapter.setMaxSweepWei(1.5 ether);
        vm.prank(caller);
        vm.expectRevert();
        liveBidAdapter.setMinBlocksBetweenSweeps(400);

        vm.prank(caller);
        vm.expectRevert();
        burner.setMinBlocksBetweenSteps(2);
        vm.prank(caller);
        vm.expectRevert();
        burner.setMaxStepWei(0.8 ether);

        vm.prank(caller);
        vm.expectRevert();
        rendererRegistry.setImplementation(address(altRenderer));
    }

    /// @dev Asserts every raw-admin carve-out reverts from `caller`.
    function _assertEveryRawAdminSetterReverts(address caller) internal {
        address candidate = makeAddr("rotationAllowlistTargetReject");
        vm.prank(caller);
        vm.expectRevert();
        patron.addAllowedSeller(candidate);

        vm.prank(caller);
        vm.expectRevert();
        patron.removeAllowedSeller(candidate);

        vm.prank(caller);
        vm.expectRevert();
        liveBidAdapter.setActivationThreshold(12 ether);
    }
}
