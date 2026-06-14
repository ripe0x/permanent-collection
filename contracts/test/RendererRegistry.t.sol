// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RendererRegistry} from "../src/RendererRegistry.sol";
import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {TraitIconCache} from "../src/TraitIconCache.sol";
import {PunkVault} from "../src/PunkVault.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Tests for `RendererRegistry`:
///         - Admin gating on `setImplementation` and `freeze`.
///         - One-way `freeze()` lock.
///         - 1-year `ProtocolAdmin` timer auto-locks the registry.
///         - Pass-through views forward to current implementation.
///         - `isLocked` reflects both freeze and timer states.
contract RendererRegistryTest is ForkFixtures {
    PermanentCollectionMosaicRenderer internal renderer;
    PermanentCollectionMosaicRenderer internal renderer2;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        punkSvgCache = new PunkSvgFragmentCache(PUNKS_DATA);
        traitIconCache = new TraitIconCache(PUNKS_DATA);
        proofRenderer = new PermanentCollectionProofRenderer(
            address(vault), PUNKS_DATA, address(traitIconCache), address(punkSvgCache)
        );
        renderer = _newRenderer();
        rendererRegistry = new RendererRegistry(address(adminContract), address(renderer));
        vault.setRendererRegistry(address(rendererRegistry));

        // Mint title so tokenURI(111) doesn't revert before passing through.
        // (Title now sits at id 111, just past the Proof range 0..110.)
        vm.prank(address(titleAuction));
        vault.mintToAuction();
    }

    function _newRenderer() internal returns (PermanentCollectionMosaicRenderer) {
        return new PermanentCollectionMosaicRenderer(
            address(collection), address(vault), address(punkSvgCache), PUNKS_DATA, address(traitIconCache), address(proofRenderer)
        );
    }

    // ────────── construction ──────────

    function test_InitialState() public view {
        assertEq(rendererRegistry.implementation(), address(renderer));
        assertFalse(rendererRegistry.frozen());
        assertEq(address(rendererRegistry.adminContract()), address(adminContract));
    }

    function test_Constructor_ZeroAddress_Reverts() public {
        vm.expectRevert(RendererRegistry.ZeroAddress.selector);
        new RendererRegistry(address(0), address(renderer));
        vm.expectRevert(RendererRegistry.ZeroAddress.selector);
        new RendererRegistry(address(adminContract), address(0));
    }

    // ────────── setImplementation ──────────

    function test_SetImplementation_FromAdmin_Succeeds() public {
        PermanentCollectionMosaicRenderer r2 = _newRenderer();
        rendererRegistry.setImplementation(address(r2));
        assertEq(rendererRegistry.implementation(), address(r2));
    }

    function test_SetImplementation_NotAdmin_Reverts() public {
        PermanentCollectionMosaicRenderer r2 = _newRenderer();
        address notAdmin = makeAddr("notAdmin");
        vm.prank(notAdmin);
        vm.expectRevert(RendererRegistry.NotAdmin.selector);
        rendererRegistry.setImplementation(address(r2));
    }

    function test_SetImplementation_Zero_Reverts() public {
        vm.expectRevert(RendererRegistry.ZeroAddress.selector);
        rendererRegistry.setImplementation(address(0));
    }

    function test_SetImplementation_EOA_Reverts() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(RendererRegistry.NotAContract.selector);
        rendererRegistry.setImplementation(eoa);
    }

    function test_SetImplementation_BadImpl_Recoverable() public {
        // No interface probe: a contract that has code but doesn't render
        // installs without reverting. The registry moves no value, so the
        // only consequence is that the forwarded views revert until a
        // corrected implementation is set. Recoverability, not a
        // deploy-time probe, is the bound on a bad install.
        BogusRenderer bogus = new BogusRenderer();
        rendererRegistry.setImplementation(address(bogus));
        assertEq(rendererRegistry.implementation(), address(bogus));

        // Forwarded view reverts while the bad impl is installed...
        vm.expectRevert();
        rendererRegistry.tokenURI();

        // ...and a subsequent good implementation fully restores it.
        PermanentCollectionMosaicRenderer good = _newRenderer();
        rendererRegistry.setImplementation(address(good));
        assertEq(rendererRegistry.implementation(), address(good));
        assertEq(rendererRegistry.tokenURI(), good.tokenURI());
    }

    // ────────── freeze ──────────

    function test_Freeze_FromAdmin_Succeeds() public {
        rendererRegistry.freeze();
        assertTrue(rendererRegistry.frozen());
        assertTrue(rendererRegistry.isLocked());
    }

    function test_Freeze_NotAdmin_Reverts() public {
        address notAdmin = makeAddr("notAdmin");
        vm.prank(notAdmin);
        vm.expectRevert(RendererRegistry.NotAdmin.selector);
        rendererRegistry.freeze();
    }

    function test_Freeze_BlocksSetImplementation() public {
        rendererRegistry.freeze();
        PermanentCollectionMosaicRenderer r2 = _newRenderer();
        vm.expectRevert(RendererRegistry.AlreadyFrozen.selector);
        rendererRegistry.setImplementation(address(r2));
    }

    function test_Freeze_OneShot() public {
        rendererRegistry.freeze();
        vm.expectRevert(RendererRegistry.AlreadyFrozen.selector);
        rendererRegistry.freeze();
    }

    // ────────── admin timer expiry ──────────

    function test_AdminTimerExpiry_LocksRegistry() public {
        vm.warp(block.timestamp + 366 days);
        assertTrue(rendererRegistry.isLocked());

        PermanentCollectionMosaicRenderer r2 = _newRenderer();
        vm.expectRevert(RendererRegistry.NotAdmin.selector);
        rendererRegistry.setImplementation(address(r2));
    }

    function test_AdminBurn_LocksRegistry() public {
        adminContract.transferAdmin(address(0));
        assertTrue(rendererRegistry.isLocked());

        PermanentCollectionMosaicRenderer r2 = _newRenderer();
        vm.expectRevert(RendererRegistry.NotAdmin.selector);
        rendererRegistry.setImplementation(address(r2));
    }

    function test_AdminRenewal_PreservesAccess() public {
        // Right before expiry, renew with a self-transfer.
        vm.warp(block.timestamp + 364 days);
        adminContract.transferAdmin(address(this)); // resets timer
        vm.warp(block.timestamp + 200 days);
        // Still within the renewed window.
        assertFalse(rendererRegistry.isLocked());
        PermanentCollectionMosaicRenderer r2 = _newRenderer();
        rendererRegistry.setImplementation(address(r2));
        assertEq(rendererRegistry.implementation(), address(r2));
    }

    // ────────── pass-through views ──────────

    function test_PassThrough_TokenURI_ZeroArg() public view {
        string memory direct = renderer.tokenURI();
        string memory viaRegistry = rendererRegistry.tokenURI();
        assertEq(direct, viaRegistry);
    }

    function test_PassThrough_TokenURI_Id() public view {
        // Title now sits at token id 111 (Proofs occupy 0..110 with
        // tokenId == traitId directly).
        string memory direct = renderer.tokenURI(111);
        string memory viaRegistry = rendererRegistry.tokenURI(111);
        assertEq(direct, viaRegistry);
    }

    function test_PassThrough_Svg() public view {
        string memory direct = renderer.svg();
        string memory viaRegistry = rendererRegistry.svg();
        assertEq(direct, viaRegistry);
    }

    function test_PassThrough_RoutedAfterUpdate() public {
        PermanentCollectionMosaicRenderer r2 = _newRenderer();
        rendererRegistry.setImplementation(address(r2));
        // After update, registry forwards to r2 — same output since both
        // read identical state, but exercises the post-update path.
        string memory viaRegistry = rendererRegistry.tokenURI();
        string memory direct = r2.tokenURI();
        assertEq(viaRegistry, direct);
    }

    // ────────── ImplementationUpdated event ──────────

    function test_ImplementationUpdated_Emit() public {
        PermanentCollectionMosaicRenderer r2 = _newRenderer();
        vm.expectEmit(true, true, false, false, address(rendererRegistry));
        emit RendererRegistry.ImplementationUpdated(address(renderer), address(r2));
        rendererRegistry.setImplementation(address(r2));
    }
}

/// @dev A contract with code but no renderer-interface methods. Used to
///      prove a bad implementation install is recoverable (the registry
///      no longer probes the interface at install time).
contract BogusRenderer {
    function someOtherFn() external pure returns (uint256) { return 42; }
}
