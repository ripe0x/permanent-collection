// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PunkVault} from "../src/PunkVault.sol";
import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {TraitIconCache} from "../src/TraitIconCache.sol";
import {RendererRegistry} from "../src/RendererRegistry.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Tests for the ERC721 title surface added to `PunkVault`:
///         - Pre-mint state (no token id 111).
///         - Wiring one-shots (`setTitleAuction`, `setRendererRegistry`).
///         - The auction-gated `mintToAuction` hook.
///         - Standard ERC721 transferability of the minted title.
///         - The hard invariant: ERC721 transfers never affect Punk custody.
///         - Bytecode scan still passes (no CryptoPunks market write
///           selectors leaked in via the ERC721 base).
contract PunkVaultTitleTest is ForkFixtures {
    PermanentCollectionMosaicRenderer internal renderer;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        punkSvgCache = new PunkSvgFragmentCache(PUNKS_DATA);
        traitIconCache = new TraitIconCache(PUNKS_DATA);
        proofRenderer = new PermanentCollectionProofRenderer(
            address(vault), PUNKS_DATA, address(traitIconCache), address(punkSvgCache)
        );
        renderer = new PermanentCollectionMosaicRenderer(
            address(collection), address(vault), address(punkSvgCache), PUNKS_DATA, address(traitIconCache), address(proofRenderer)
        );
        rendererRegistry = new RendererRegistry(address(adminContract), address(renderer));
        vault.setRendererRegistry(address(rendererRegistry));
    }

    // ────────── bytecode scan ──────────

    function test_BytecodeContainsNoMarketWriteSelectors() public view {
        bytes memory code = address(vault).code;
        _assertNoSelector(code, bytes4(keccak256("transferPunk(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("buyPunk(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSale(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSaleToAddress(uint256,uint256,address)")));
        _assertNoSelector(code, bytes4(keccak256("acceptBidForPunk(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("enterBidForPunk(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
    }

    // ────────── pre-mint state ──────────

    function test_TitleOwner_BeforeMint_IsZero() public view {
        assertEq(vault.titleOwner(), address(0));
        assertFalse(vault.titleMinted());
    }

    function test_TokenURI_RevertsBeforeMint() public {
        // Title now sits at token id 111 (just past the 111 Proofs which
        // occupy ids 0..110 with tokenId == traitId directly).
        vm.expectRevert(PunkVault.TitleNotMinted.selector);
        vault.tokenURI(111);
    }

    function test_TokenURI_RevertsForUnknownId_BeforeMint() public {
        // id ≥ 112 is unreachable: above both Proofs (0..110) and Title (111).
        vm.expectRevert(abi.encodeWithSelector(PunkVault.UnknownTokenId.selector, uint256(112)));
        vault.tokenURI(112);
    }

    function test_TokenURI_RevertsForUnmintedProofId() public {
        // Mint Title; valid Proof ids (0..110) still revert until that
        // Proof has been minted by the ReturnAuctionModule. id 0 is now the
        // Proof for trait 0, not the Title.
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        vm.expectRevert(abi.encodeWithSelector(PunkVault.UnknownTokenId.selector, uint256(0)));
        vault.tokenURI(0);
    }

    // ────────── wiring one-shots ──────────

    function test_TitleAuctionWired() public view {
        assertEq(vault.titleAuction(), address(titleAuction));
    }

    function test_RendererRegistryWired() public view {
        assertEq(vault.rendererRegistry(), address(rendererRegistry));
    }

    function test_SetTitleAuction_AlreadySet_Reverts() public {
        vm.expectRevert(PunkVault.TitleAuctionAlreadySet.selector);
        vault.setTitleAuction(address(0x1234));
    }

    function test_SetTitleAuction_NotDeployer_Reverts() public {
        // Deploy a fresh vault so the slot is unset.
        uint64 n = vm.getNonce(address(this));
        address futureFs = vm.computeCreateAddress(address(this), n + 1);
        PunkVault fresh = new PunkVault(PUNKS_MARKET, futureFs);

        address alice = makeAddr("alice");
        vm.prank(alice);
        vm.expectRevert(PunkVault.NotDeployer.selector);
        fresh.setTitleAuction(address(0x1234));
    }

    function test_SetRendererRegistry_AlreadySet_Reverts() public {
        vm.expectRevert(PunkVault.RendererRegistryAlreadySet.selector);
        vault.setRendererRegistry(address(0x1234));
    }

    function test_SetTitleAuction_ZeroAddress_Reverts() public {
        uint64 n = vm.getNonce(address(this));
        address futureFs = vm.computeCreateAddress(address(this), n + 1);
        PunkVault fresh = new PunkVault(PUNKS_MARKET, futureFs);
        vm.expectRevert(PunkVault.ZeroAddress.selector);
        fresh.setTitleAuction(address(0));
    }

    function test_SetRendererRegistry_ZeroAddress_Reverts() public {
        uint64 n = vm.getNonce(address(this));
        address futureFs = vm.computeCreateAddress(address(this), n + 1);
        PunkVault fresh = new PunkVault(PUNKS_MARKET, futureFs);
        vm.expectRevert(PunkVault.ZeroAddress.selector);
        fresh.setRendererRegistry(address(0));
    }

    // ────────── mint hook ──────────

    function test_MintToAuction_NotAuction_Reverts() public {
        vm.expectRevert(PunkVault.NotTitleAuction.selector);
        vault.mintToAuction();
    }

    function test_MintToAuction_FromAuction_Mints() public {
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        assertTrue(vault.titleMinted());
        assertEq(vault.titleOwner(), address(titleAuction));
        assertEq(vault.balanceOf(address(titleAuction)), 1);
    }

    function test_MintToAuction_Twice_Reverts() public {
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        vm.prank(address(titleAuction));
        vm.expectRevert(PunkVault.TitleAlreadyMinted.selector);
        vault.mintToAuction();
    }

    // ────────── tokenURI after mint ──────────

    function test_TokenURI_AfterMint_ReturnsDataUri() public {
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        // Title now sits at token id 111 (Proofs occupy 0..110).
        string memory uri = vault.tokenURI(111);
        bytes memory u = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        require(u.length >= prefix.length, "uri too short");
        for (uint256 i = 0; i < prefix.length; i++) {
            require(u[i] == prefix[i], "wrong prefix");
        }
    }

    function test_TokenURI_UnknownId_Reverts() public {
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        // id ≥ 112 is out of range entirely.
        vm.expectRevert(abi.encodeWithSelector(PunkVault.UnknownTokenId.selector, uint256(112)));
        vault.tokenURI(112);
        // id 0 is a valid Proof id (for trait 0) but no Proof minted yet.
        vm.expectRevert(abi.encodeWithSelector(PunkVault.UnknownTokenId.selector, uint256(0)));
        vault.tokenURI(0);
    }

    // ────────── contractURI ──────────

    function test_ContractURI_DelegatesToRegistry() public view {
        // The vault routes contractURI through the registry, passing its
        // own address. The mosaic renderer branches on `address == vault`
        // and returns title-flavored JSON; V4 (used in this test setUp)
        // returns the same JSON as zero-arg tokenURI(). Either way the
        // call should produce a non-empty data: URI.
        string memory uri = vault.contractURI();
        bytes memory u = bytes(uri);
        assertGt(u.length, 100, "contractURI returns non-trivial output");
        bytes memory prefix = bytes("data:application/json;");
        for (uint256 i = 0; i < prefix.length; i++) {
            require(u[i] == prefix[i], "wrong data URI prefix");
        }
    }

    function test_ContractURI_RevertsBeforeRegistrySet() public {
        // Fresh vault with no registry wired yet.
        PunkVault fresh = new PunkVault(PUNKS_MARKET, address(this));
        vm.expectRevert(PunkVault.RendererRegistryNotSet.selector);
        fresh.contractURI();
    }

    // ────────── totalSupply ──────────

    function test_TotalSupply_BeforeMint_IsZero() public view {
        assertEq(vault.totalSupply(), 0);
    }

    function test_TotalSupply_AfterMint_IsOne() public {
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        assertEq(vault.totalSupply(), 1);
    }

    // ────────── transferability ──────────

    function test_Title_TransferFrom_Succeeds() public {
        uint256 titleId = vault.TITLE_TOKEN_ID();
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        address alice = makeAddr("alice");
        vm.prank(address(titleAuction));
        vault.transferFrom(address(titleAuction), alice, titleId);
        assertEq(vault.titleOwner(), alice);
        assertEq(vault.balanceOf(alice), 1);
        assertEq(vault.balanceOf(address(titleAuction)), 0);
    }

    function test_Title_Approve_And_TransferFrom() public {
        uint256 titleId = vault.TITLE_TOKEN_ID();
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        vm.prank(address(titleAuction));
        vault.approve(alice, titleId);
        vm.prank(alice);
        vault.transferFrom(address(titleAuction), bob, titleId);
        assertEq(vault.titleOwner(), bob);
    }

    // ────────── hard invariant: title transfers don't affect Punks ──────────

    function test_TitleTransfer_DoesNotMovePunks() public {
        uint256 titleId = vault.TITLE_TOKEN_ID();
        uint16 punkId = 42;
        address currentOwner = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(currentOwner);
        punksMarket.transferPunk(address(vault), uint256(punkId));
        vm.prank(address(finalSale));
        vault.receivePunk(punkId);

        vm.prank(address(titleAuction));
        vault.mintToAuction();

        uint256 lockedCountBefore = vault.lockedPunkCount();
        bool lockedBefore = vault.isLocked(punkId);
        address marketOwnerBefore = punksMarket.punkIndexToAddress(uint256(punkId));

        address alice = makeAddr("alice");
        vm.prank(address(titleAuction));
        vault.transferFrom(address(titleAuction), alice, titleId);

        assertEq(vault.lockedPunkCount(), lockedCountBefore);
        assertEq(vault.isLocked(punkId), lockedBefore);
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), marketOwnerBefore);
        assertEq(vault.titleOwner(), alice);
    }

    function test_NewTitleOwner_HasNoPunkAccess() public {
        uint256 titleId = vault.TITLE_TOKEN_ID();
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        address alice = makeAddr("alice");
        vm.prank(address(titleAuction));
        vault.transferFrom(address(titleAuction), alice, titleId);

        // Alice cannot call receivePunk (gated to finalSale).
        vm.prank(alice);
        vm.expectRevert(PunkVault.NotReturnAuction.selector);
        vault.receivePunk(0);

        // Alice cannot call mintToAuction (gated to titleAuction).
        vm.prank(alice);
        vm.expectRevert(PunkVault.NotTitleAuction.selector);
        vault.mintToAuction();
    }

    // ────────── ERC165 ──────────

    function test_SupportsInterface() public view {
        assertTrue(vault.supportsInterface(0x01ffc9a7));  // ERC165
        assertTrue(vault.supportsInterface(0x80ac58cd));  // ERC721
        assertTrue(vault.supportsInterface(0x5b5e139f));  // ERC721Metadata
        assertTrue(vault.supportsInterface(0x49064906));  // EIP-4906 MetadataUpdate
        assertFalse(vault.supportsInterface(0xdeadbeef));
    }

    // ────────── name/symbol ──────────

    function test_NameAndSymbol() public view {
        assertEq(vault.name(), "Title to PERMANENT COLLECTION Vault");
        assertEq(vault.symbol(), "PERMANENTCOLLECTION");
    }

    // ────────── EIP-4906 metadata refresh hint ──────────

    function test_MetadataUpdate_OnMint() public {
        // Title is token id 111 (Proofs occupy 0..110).
        vm.expectEmit(false, false, false, true, address(vault));
        emit PunkVault.MetadataUpdate(vault.TITLE_TOKEN_ID());
        vm.prank(address(titleAuction));
        vault.mintToAuction();
    }

    function test_MetadataUpdate_OnReceivePunk_AfterMint() public {
        vm.prank(address(titleAuction));
        vault.mintToAuction();

        uint16 punkId = 42;
        address currentOwner = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(currentOwner);
        punksMarket.transferPunk(address(vault), uint256(punkId));

        vm.expectEmit(false, false, false, true, address(vault));
        emit PunkVault.MetadataUpdate(vault.TITLE_TOKEN_ID());
        vm.prank(address(finalSale));
        vault.receivePunk(punkId);
    }

    // ────────── helpers ──────────

    function _assertNoSelector(bytes memory code, bytes4 sel) internal pure {
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == sel[0]
                    && code[i + 1] == sel[1]
                    && code[i + 2] == sel[2]
                    && code[i + 3] == sel[3]
            ) {
                revert("bytecode contains forbidden selector");
            }
        }
    }
}
