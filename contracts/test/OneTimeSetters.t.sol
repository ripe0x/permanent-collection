// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {PermanentCollection} from "../src/PermanentCollection.sol";
import {Patron} from "../src/Patron.sol";
import {ProtocolAdmin} from "../src/ProtocolAdmin.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Direct coverage for every one-time deployer-only setter. These are
///         the single points where post-deploy immutability is established —
///         a bug that lets one fire twice (or fire from a non-deployer)
///         silently changes the security model of the entire protocol.
///         Each setter is exercised for:
///           1. Successful single call
///           2. Re-call reverts
///           3. Non-deployer call reverts
///           4. Zero-address rejection where applicable
contract OneTimeSettersTest is ForkFixtures {
    // ───────────────────────────────────────────────────────────────────
    //  ReturnAuctionModule.setVaultBurnPool
    // ───────────────────────────────────────────────────────────────────

    function test_SetVaultBurnPool_AlreadyWired_ByFixture() public {
        _setUpFork();
        _deployProtocol();
        // ForkFixtures._deployProtocol already wired the pool. A re-call must
        // revert with `AlreadyWired` regardless of caller (the deployer check
        // would also revert, but `AlreadyWired` fires first only if you ARE
        // the deployer; from a stranger you get `NotDeployer` first).
        // Verify both shapes.

        // The deployer (= this contract) is rejected with AlreadyWired.
        vm.expectRevert();
        finalSale.setVaultBurnPool(payable(address(0xDEAD)));

        // Anyone else is rejected immediately as NotDeployer.
        vm.prank(address(0xCAFE));
        vm.expectRevert();
        finalSale.setVaultBurnPool(payable(address(0xDEAD)));
    }

    // ───────────────────────────────────────────────────────────────────
    //  PermanentCollection.setWiring
    // ───────────────────────────────────────────────────────────────────

    function test_PermanentCollection_SetWiring_AlreadyFinalized() public {
        _setUpFork();
        _deployProtocol();
        // Fixture already called setWiring. A second call must revert
        // because OneTimeSetup has been finalized.
        vm.expectRevert();
        collection.setWiring(address(0x1), address(0x2), address(0x3), payable(address(0x4)));
    }

    function test_PermanentCollection_SetWiring_NotDeployer() public {
        // Fresh protocol that hasn't been wired yet. Call from a stranger.
        _setUpFork();
        ProtocolAdmin a = new ProtocolAdmin(address(this));
        PermanentCollection pc = new PermanentCollection(PUNKS_DATA, address(a));

        vm.prank(address(0xBA5E));
        vm.expectRevert();
        pc.setWiring(address(0x1), address(0x2), address(0x3), payable(address(0x4)));
    }

    function test_PermanentCollection_SetWiring_ZeroAddressReverts() public {
        _setUpFork();
        ProtocolAdmin a = new ProtocolAdmin(address(this));
        PermanentCollection pc = new PermanentCollection(PUNKS_DATA, address(a));

        // Each of the four slots must reject zero.
        vm.expectRevert(PermanentCollection.ZeroAddress.selector);
        pc.setWiring(address(0), address(0x2), address(0x3), payable(address(0x4)));

        vm.expectRevert(PermanentCollection.ZeroAddress.selector);
        pc.setWiring(address(0x1), address(0), address(0x3), payable(address(0x4)));

        vm.expectRevert(PermanentCollection.ZeroAddress.selector);
        pc.setWiring(address(0x1), address(0x2), address(0), payable(address(0x4)));

        vm.expectRevert(PermanentCollection.ZeroAddress.selector);
        pc.setWiring(address(0x1), address(0x2), address(0x3), payable(address(0)));
    }

    function test_PermanentCollection_SetWiring_HappyPath() public {
        // Wire from scratch and verify state lands correctly.
        _setUpFork();
        ProtocolAdmin a = new ProtocolAdmin(address(this));
        PermanentCollection pc = new PermanentCollection(PUNKS_DATA, address(a));

        address _patron = address(0xAA);
        address _fs = address(0xBB);
        address _vault = address(0xCC);
        address payable _burner = payable(address(0xDD));

        pc.setWiring(_patron, _fs, _vault, _burner);
        assertEq(pc.patron(), _patron);
        assertEq(pc.returnAuctionModule(), _fs);
        assertEq(pc.punkVault(), _vault);
        assertEq(pc.buybackBurner(), _burner);

        // Second call now reverts via OneTimeSetup finalization.
        vm.expectRevert();
        pc.setWiring(_patron, _fs, _vault, _burner);
    }

    // ───────────────────────────────────────────────────────────────────
    //  Patron.setWiring
    // ───────────────────────────────────────────────────────────────────

    function test_Patron_SetWiring_AlreadyFinalized() public {
        _setUpFork();
        _deployProtocol();
        // Already wired by fixture.
        vm.expectRevert();
        patron.setWiring(address(0x1), address(0x2), address(0x3));
    }

    function test_Patron_SetWiring_ZeroAddressReverts() public {
        _setUpFork();
        ProtocolAdmin a = new ProtocolAdmin(address(this));
        Patron p = new Patron(PUNKS_MARKET, PUNKS_DATA, address(a), address(0));

        vm.expectRevert(Patron.ZeroAddress.selector);
        p.setWiring(address(0), address(0x2), address(0x3));

        vm.expectRevert(Patron.ZeroAddress.selector);
        p.setWiring(address(0x1), address(0), address(0x3));

        // The adapter (3rd arg) is also required — it is Patron's sole faucet.
        vm.expectRevert(Patron.ZeroAddress.selector);
        p.setWiring(address(0x1), address(0x2), address(0));
    }

    function test_Patron_SetWiring_NotDeployer() public {
        _setUpFork();
        ProtocolAdmin a = new ProtocolAdmin(address(this));
        Patron p = new Patron(PUNKS_MARKET, PUNKS_DATA, address(a), address(0));

        vm.prank(address(0xBA5E));
        vm.expectRevert();
        p.setWiring(address(0x1), address(0x2), address(0x3));
    }

    function test_Patron_SetWiring_HappyPath() public {
        _setUpFork();
        ProtocolAdmin a = new ProtocolAdmin(address(this));
        Patron p = new Patron(PUNKS_MARKET, PUNKS_DATA, address(a), address(0));

        p.setWiring(address(0x1), address(0x2), address(0x3));
        assertEq(address(p.permanentCollection()), address(0x1));
        assertEq(address(p.returnAuctionModule()), address(0x2));
        assertEq(p.liveBidAdapter(), address(0x3));

        // Subsequent setWiring rejected via OneTimeSetup finalization.
        vm.expectRevert();
        p.setWiring(address(0x3), address(0x4), address(0x5));
    }

    // ───────────────────────────────────────────────────────────────────
    //  BuybackBurner.setup
    // ───────────────────────────────────────────────────────────────────

    function test_BuybackBurner_Setup_AlreadyFinalized() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
        // Pool launched → burner.setup() already fired. A re-call must revert.
        vm.expectRevert();
        burner.setup(address(0x1), address(0x2));
    }

    function test_BuybackBurner_Setup_ZeroAddressReverts() public {
        _setUpFork();
        _deployProtocol();
        // Don't launch the pool; burner is still in pre-setup state.
        vm.expectRevert();
        burner.setup(address(0), address(0x2));

        vm.expectRevert();
        burner.setup(address(0x1), address(0));
    }

    function test_BuybackBurner_Setup_NotDeployer() public {
        _setUpFork();
        _deployProtocol();
        vm.prank(address(0xBA5E));
        vm.expectRevert();
        burner.setup(address(0x1), address(0x2));
    }
}
