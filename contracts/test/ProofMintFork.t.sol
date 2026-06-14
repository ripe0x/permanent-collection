// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ForkFixtures} from "./helpers/ForkFixtures.sol";
import {PunkVault} from "../src/PunkVault.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {TraitIconCache} from "../src/TraitIconCache.sol";
import {Base64} from "solady/utils/Base64.sol";

/// @title  ProofMintForkTest
/// @notice Adversarial coverage for the Proof NFTs issued from `PunkVault`
///         at vault-settle. One Proof per first-vaulting of a previously-
///         uncollected trait, addressed to the `originalSeller` recorded on
///         the acquisition. **Token id == trait id** (a Proof for trait 20
///         is token id 20, mirroring the PunksData trait taxonomy). The
///         Title sits at token id 111, just past the Proof range.
///         Capped at 111 Proofs forever.
///
///         Coverage map (mirrors the acceptance criteria in the spec):
///           - Proof mints on first-vaulting via `acceptBid`
///           - Proof mints on first-vaulting via `acceptListing` to the
///             LISTING SELLER, not the finder
///           - No Proof on cleared return auction (rescue path)
///           - No Proof when the target trait was already collected before
///             this Punk's vault-settle (defense-in-depth — protocol
///             ordering normally prevents this, but the ReturnAuctionModule
///             still gates on `firstVaultingOfTrait`)
///           - Minter scoping: titleAuction can't `mintProofs`; finalSale
///             can't `mintToAuction`; both revert on out-of-range ids
///           - Double-mint of a Proof reverts `ProofAlreadyMinted`
///           - Minted Proofs are transferable (standard ERC721)
///           - `ownerOf(0)` is the Proof for trait 0 (solmate token id 0
///             sanity check) — distinct from the Title at id 111
///           - PunkVault's bytecode still contains no CryptoPunks
///             market-write selectors after the ERC721 mint surface grew
contract ProofMintForkTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        _fundPatronFromAdapter(30 ether);
    }

    // ────────── helpers ──────────

    function _findEligiblePunk(uint16 start) internal view returns (uint16) {
        for (uint16 i = start; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible punk");
    }

    /// @dev Drive a vault-path settle (no bids) end-to-end via `acceptBid`.
    function _acquireAndVault(address seller, uint16 punkId)
        internal
        returns (uint8 target, uint256 acqId)
    {
        _giveAndOfferToBounty(seller, punkId);
        target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);
        acqId = collection.acquisitionIndexOf(punkId);
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);
    }

    // ────────── (1) acceptBid path — Proof recipient is the seller ──────────

    function test_AcceptBounty_VaultSettle_MintsProofToPreLister() public {
        uint16 punkId = _findEligiblePunk(1);
        address seller = address(0xA11CE);
        (uint8 target, uint256 acqId) = _acquireAndVault(seller, punkId);

        uint256 tokenId = uint256(target);
        assertEq(vault.ownerOf(tokenId), seller, "Proof minted to pre-lister");
        assertEq(vault.balanceOf(seller), 1, "balance reflects Proof");
        assertTrue(vault.isProofMinted(target), "isProofMinted flag set");
        assertEq(vault.totalProofsMinted(), 1, "global Proof count = 1");

        (uint16 mPunk, uint8 mTrait, uint16 mSeq, uint64 mBlock) = vault.proofMeta(tokenId);
        assertEq(mPunk, punkId, "proofMeta records vaulted Punk");
        assertEq(mTrait, target, "proofMeta records trait id");
        assertEq(mSeq, uint16(collection.collectedCount()), "sequence == collectedCount");
        assertEq(mBlock, uint64(block.number), "mintedAtBlock recorded");
        // Defense in depth — the acquisition index returned by the helper
        // matches what ReturnAuctionModule emitted into the Proof.
        assertEq(acqId, collection.acquisitionIndexOf(punkId), "acquisition id stable");
    }

    // ────────── (1b) minted Proof tokenURI renders the minted envelope ──────────

    /// @notice End-to-end: vault a trait, mint its Proof, then decode the
    ///         minted Proof's `tokenURI` JSON and assert the name /
    ///         description / attributes match the minted envelope. The
    ///         unminted path reverts `ProofNotMinted` (covered in the
    ///         renderer suites); this is the only test that decodes a
    ///         MINTED Proof envelope. The outer JSON is a `;base64,` data URI
    ///         (the OpenSea-documented form), so the test base64-decodes it
    ///         before asserting the fields as raw substrings.
    /// @dev    Uses a local proof renderer over the live vault — this fork
    ///         fixture's `_deployProtocol` does not wire the renderer
    ///         triplet onto the vault. The vault→registry→mosaic dispatch
    ///         for Proof ids is covered by the renderer-registry + mosaic
    ///         suites; here we exercise the MINTED envelope itself.
    function test_MintedProof_TokenURI_RendersMintedEnvelope() public {
        uint16 punkId = _findEligiblePunk(1);
        address seller = address(0xB0B);
        (uint8 target,) = _acquireAndVault(seller, punkId);
        uint256 tokenId = uint256(target);

        PermanentCollectionProofRenderer pr = new PermanentCollectionProofRenderer(
            address(vault),
            PUNKS_DATA,
            address(new TraitIconCache(PUNKS_DATA)),
            address(new PunkSvgFragmentCache(PUNKS_DATA))
        );

        // Live values frozen at mint time.
        (uint16 mPunk, , uint16 mSeq, uint64 mBlock) = vault.proofMeta(tokenId);
        string memory traitName = punksData.traitName(uint16(target));

        // Outer envelope is the OpenSea-documented base64 JSON form. Assert
        // the exact prefix, then base64-decode so the fields below are
        // assertable as raw substrings of the decoded JSON.
        bytes memory ub = bytes(pr.tokenURI(tokenId));
        bytes memory prefix = bytes("data:application/json;base64,");
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(ub[i], prefix[i], "base64 JSON envelope");
        }
        bytes memory b64 = new bytes(ub.length - prefix.length);
        for (uint256 i = 0; i < b64.length; i++) b64[i] = ub[i + prefix.length];
        bytes memory u = Base64.decode(string(b64));

        // name: "Permanent Collection Proof <traitId> (<traitName>)" — the
        // Proof number is the trait id (== token id), not the collection
        // sequence.
        assertTrue(
            _contains(
                u,
                bytes(
                    string.concat(
                        '"name":"Permanent Collection Proof ',
                        vm.toString(uint256(target)),
                        ' (', traitName, ')"'
                    )
                )
            ),
            "name = trait id + trait"
        );

        // description: the exact minted copy (note the literal apostrophe).
        assertTrue(
            _contains(
                u,
                bytes(
                    string.concat(
                        '"description":"Proof that CryptoPunk ',
                        vm.toString(uint256(mPunk)),
                        " was added to Permanent Collection's immutable contract for the ",
                        traitName,
                        ' trait."'
                    )
                )
            ),
            "minted description copy"
        );

        // attributes: all five minted entries (no Status entry).
        assertTrue(
            _contains(u, bytes(string.concat('{"trait_type":"Trait","value":"', traitName, '"}'))),
            "Trait attr"
        );
        assertTrue(
            _contains(u, bytes(string.concat('{"trait_type":"Trait ID","value":', vm.toString(uint256(target)), '}'))),
            "Trait ID attr"
        );
        assertTrue(
            _contains(u, bytes(string.concat('{"trait_type":"Punk ID","value":', vm.toString(uint256(mPunk)), '}'))),
            "Punk ID attr"
        );
        assertTrue(
            _contains(u, bytes(string.concat('{"trait_type":"Sequence","value":"', vm.toString(uint256(mSeq)), ' of 111"}'))),
            "Sequence attr"
        );
        assertTrue(
            _contains(u, bytes(string.concat('{"trait_type":"Vaulted at Block","value":', vm.toString(uint256(mBlock)), '}'))),
            "Vaulted at Block attr"
        );
        // Status attribute removed — assert it's gone.
        assertFalse(_contains(u, bytes('"trait_type":"Status"')), "no Status attr");

        // image is a base64-encoded SVG data URI.
        assertTrue(_contains(u, bytes('"image":"data:image/svg+xml;base64,')), "image data URI");
    }

    // ────────── (2) acceptListing path — recipient is LISTING seller, not finder ──────────

    function test_AcceptListing_VaultSettle_MintsProofToListingSeller() public {
        // Allowlist an external seller; the finder is a different EOA.
        uint16 punkId = _findEligiblePunk(2_000);
        address listingSeller = address(0x5E11E2);
        address finder = address(0xF1ADE2);
        _addAllowedSellerImmediate(listingSeller);
        // Patron needs more than MIN_BID_FOR_LISTING to consume the listing.
        _fundPatronFromAdapter(5 ether);
        uint256 listingPrice = 0.5 ether;
        _giveAndPublicList(listingSeller, punkId, listingPrice);

        uint8 target = _pickTarget(punkId);
        vm.prank(finder);
        patron.acceptListing(punkId, target);

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        uint256 tokenId = uint256(target);
        assertEq(vault.ownerOf(tokenId), listingSeller, "Proof goes to LISTING seller");
        assertEq(vault.balanceOf(listingSeller), 1, "listingSeller holds 1 Proof");
        assertEq(vault.balanceOf(finder), 0, "finder holds NO Proof");
    }

    // ────────── (3) cleared return auction path — NO Proof ──────────

    function test_ClearedFinalSale_DoesNotMintProof() public {
        uint16 punkId = _findEligiblePunk(3_000);
        address seller = address(0xC1ABC);
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);

        uint256 reserve = finalSale.reserveOf(punkId);
        address bidder = address(0xB1DDE2);
        vm.deal(bidder, reserve);
        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        uint256 tokenId = uint256(target);
        assertFalse(vault.isProofMinted(target), "no Proof for cleared sale");
        assertEq(vault.totalProofsMinted(), 0, "global count untouched");
        vm.expectRevert();
        vault.ownerOf(tokenId);  // solmate NOT_MINTED
    }

    // ────────── (4) Proof skipped when target trait already collected ──────────

    function test_VaultSettle_SkipsProof_WhenTargetAlreadyCollected() public {
        uint16 punkId = _findEligiblePunk(4_000);
        address seller = address(0xC0FFEE);
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Force-set collectedMask to include `target` BEFORE the vault-
        // settle reads it. Simulates a state the normal protocol flow
        // can't produce (the in-flight invariant + acquire-time guard
        // make it unreachable), but `ReturnAuctionModule.settle` still
        // gates on `firstVaultingOfTrait` defensively.
        uint256 mask = collection.collectedMask() | (uint256(1) << uint256(target));
        _setCollectedMask(mask);

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertFalse(vault.isProofMinted(target), "no Proof when trait pre-collected");
        assertEq(vault.totalProofsMinted(), 0, "global count untouched");
    }

    // ────── (4b) vault-path Proof mint is ATOMIC — failure rolls back ──────

    /// @notice The first-vaulting Proof mint is bound atomically to the
    ///         vaulting, NOT best-effort. If `mintProofs` reverts, the ENTIRE
    ///         settle reverts and rolls back: the Punk is NOT vaulted, the
    ///         trait is NOT collected, and the sale stays settleable so the
    ///         mint is retried on the next `settle`. This is the inverse of
    ///         the old `try/catch`, which would have vaulted the Punk +
    ///         collected the trait while silently dropping the Proof —
    ///         permanently desyncing the collected-trait set from the Proof
    ///         set (hard invariant #19), with no recovery (a Vaulted Punk
    ///         never re-auctions and the lit trait bit is monotonic).
    /// @dev    The real `PunkVault` can't fail a legitimate first-vaulting
    ///         (recipient structurally non-zero, token id structurally
    ///         fresh, `_mint` has no recipient callback), so the only way to
    ///         exercise the failure path is to inject a revert with
    ///         `vm.mockCallRevert` on `mintProofs`.
    function test_VaultSettle_ProofMintRevert_RollsBackAtomically() public {
        uint16 punkId = _findEligiblePunk(6_000);
        address seller = address(0xD00D);
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Pre-state: the module holds the Punk for its return auction, the
        // target trait is uncollected, and no Proof exists.
        assertEq(
            punksMarket.punkIndexToAddress(uint256(punkId)),
            address(finalSale),
            "module holds Punk pre-settle"
        );
        uint256 maskBefore = collection.collectedMask();
        assertEq(maskBefore & (uint256(1) << uint256(target)), 0, "target uncollected pre-settle");
        assertFalse(vault.isProofMinted(target), "no Proof pre-settle");

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);

        // Force the Proof mint to revert for this settle. With the `try/catch`
        // removed, the revert bubbles out of `settle` and unwinds everything.
        vm.mockCallRevert(
            address(vault),
            abi.encodeWithSelector(vault.mintProofs.selector),
            "proof mint boom"
        );
        vm.expectRevert();
        finalSale.settle(punkId);
        vm.clearMockedCalls();

        // Atomic rollback — nothing moved. Punk still in the module, trait
        // still uncollected, no Proof, and the sale is still settleable.
        assertEq(
            punksMarket.punkIndexToAddress(uint256(punkId)),
            address(finalSale),
            "Punk NOT vaulted: transferPunk rolled back"
        );
        assertFalse(vault.isLocked(punkId), "vault did not lock the Punk: receivePunk rolled back");
        assertEq(collection.collectedMask(), maskBefore, "trait NOT collected: markCustody rolled back");
        assertFalse(vault.isProofMinted(target), "no Proof minted");
        assertEq(vault.totalProofsMinted(), 0, "global Proof count untouched");
        assertTrue(finalSale.isSettleable(punkId), "sale stays settleable (retryable)");

        // Retry without the injected failure: settle now succeeds and the
        // Proof mints to the recorded originalSeller. The transient failure
        // cost nothing but a retry — no permanent desync.
        finalSale.settle(punkId);
        assertEq(
            punksMarket.punkIndexToAddress(uint256(punkId)),
            address(vault),
            "Punk vaulted on retry"
        );
        assertTrue(vault.isProofMinted(target), "Proof minted on retry");
        assertEq(vault.ownerOf(uint256(target)), seller, "Proof to originalSeller on retry");
        assertEq(
            collection.collectedMask() & (uint256(1) << uint256(target)),
            uint256(1) << uint256(target),
            "trait collected on retry"
        );
    }

    // ────────── (5) minter scoping — Title minter can't reach Proof range ──────────

    function test_TitleAuction_CannotMintProofs() public {
        vm.prank(address(titleAuction));
        vm.expectRevert(PunkVault.NotReturnAuction.selector);
        vault.mintProofs(uint16(7804), uint8(5), address(0xAB), uint256(0), uint16(1));
    }

    // ────────── (6) minter scoping — Proof minter can't reach Title id 111 ──────────

    function test_FinalSaleModule_CannotMintTitle() public {
        // ReturnAuctionModule has no path to `mintToAuction` — it isn't the
        // `titleAuction` immutable. Confirm by direct call.
        vm.prank(address(finalSale));
        vm.expectRevert(PunkVault.NotTitleAuction.selector);
        vault.mintToAuction();
    }

    // ────────── (7) mintProofs traitId range ──────────

    function test_MintProofs_RevertsOnOutOfRangeTraitId() public {
        vm.prank(address(finalSale));
        vm.expectRevert(abi.encodeWithSelector(PunkVault.InvalidTraitId.selector, uint8(111)));
        vault.mintProofs(uint16(0), uint8(111), address(0xAB), uint256(0), uint16(1));
    }

    function test_MintProofs_RevertsOnZeroRecipient() public {
        vm.prank(address(finalSale));
        vm.expectRevert(PunkVault.InvalidRecipient.selector);
        vault.mintProofs(uint16(0), uint8(0), address(0), uint256(0), uint16(1));
    }

    function test_MintProofs_RevertsFromNonFinalSale() public {
        address attacker = address(0xBAD);
        vm.prank(attacker);
        vm.expectRevert(PunkVault.NotReturnAuction.selector);
        vault.mintProofs(uint16(0), uint8(0), attacker, uint256(0), uint16(1));
    }

    // ────────── (8) double-mint of the same Proof reverts ──────────

    function test_MintProofs_DoubleMintReverts() public {
        // First mint via the normal flow.
        uint16 punkId = _findEligiblePunk(5_000);
        address seller = address(0xD0D0);
        (uint8 target,) = _acquireAndVault(seller, punkId);
        assertTrue(vault.isProofMinted(target));

        // Direct double-mint attempt by ReturnAuctionModule.
        vm.prank(address(finalSale));
        vm.expectRevert(abi.encodeWithSelector(PunkVault.ProofAlreadyMinted.selector, target));
        vault.mintProofs(uint16(0), target, address(0xAB), uint256(0), uint16(1));
    }

    // ────────── (9) Proofs are transferable ──────────

    function test_Proof_TransferableLikeNormalERC721() public {
        uint16 punkId = _findEligiblePunk(6_000);
        address seller = address(0xCABBA6E);
        (uint8 target,) = _acquireAndVault(seller, punkId);
        uint256 tokenId = uint256(target);

        address bob = makeAddr("bob");
        vm.prank(seller);
        vault.transferFrom(seller, bob, tokenId);
        assertEq(vault.ownerOf(tokenId), bob, "Proof transferred");
        assertEq(vault.balanceOf(seller), 0);
        assertEq(vault.balanceOf(bob), 1);

        // proofMeta is frozen on the contribution event — the recipient
        // moved, but the metadata still references the seller's act.
        (uint16 mPunk, , , ) = vault.proofMeta(tokenId);
        assertEq(mPunk, punkId, "proofMeta unchanged across transfer");
    }

    // ────────── (10) Title at id 111, Proof for trait 0 at id 0 ──────────

    function test_TitleAtId111_AndTraitZeroAtId0_SolmateSemantics() public {
        // Pre-mint: ids 0 and 111 both return NOT_MINTED.
        vm.expectRevert(bytes("NOT_MINTED"));
        vault.ownerOf(0);
        vm.expectRevert(bytes("NOT_MINTED"));
        vault.ownerOf(111);

        // Mint the Title. Title lives at id 111 now (just past the Proof
        // range), so token id 0 is still NOT_MINTED until a Proof for
        // trait 0 is issued via vault-settle.
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        assertEq(vault.ownerOf(111), address(titleAuction), "Title at id 111");
        assertEq(vault.titleOwner(), address(titleAuction));
        vm.expectRevert(bytes("NOT_MINTED"));
        vault.ownerOf(0);
    }

    // ────────── (11) totalSupply reflects Title + minted Proofs ──────────

    function test_TotalSupply_TracksTitlePlusProofs() public {
        assertEq(vault.totalSupply(), 0, "fresh: no objects");

        // Mint Title only.
        vm.prank(address(titleAuction));
        vault.mintToAuction();
        assertEq(vault.totalSupply(), 1, "Title only");

        // Mint a Proof via real settle.
        uint16 punkId = _findEligiblePunk(7_000);
        address seller = address(0xCAFE5E11E2);
        _acquireAndVault(seller, punkId);
        assertEq(vault.totalSupply(), 2, "Title + 1 Proof");
    }

    // ────────── (12) bytecode scan — no market write selectors leaked ──────────

    function test_BytecodeContainsNoMarketWriteSelectors_PostProofs() public view {
        bytes memory code = address(vault).code;
        _assertNoSelector(code, bytes4(keccak256("transferPunk(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("buyPunk(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSale(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSaleToAddress(uint256,uint256,address)")));
        _assertNoSelector(code, bytes4(keccak256("acceptBidForPunk(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("enterBidForPunk(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
    }

    /// @notice The vault's owner surface is one-way renounce only — no
    ///         `transferOwnership`, no admin / migration / withdrawal
    ///         selectors. Asserted post-Proofs (alongside the parallel
    ///         market-selector scan above) so the added ERC721 mint surface
    ///         hasn't reintroduced any admin pattern.
    function test_BytecodeContainsOnlyRenounceOwnership_PostProofs() public view {
        bytes memory code = address(vault).code;

        // Present — needed for marketplace recognition (OpenSea ERC-173).
        _assertHasSelector(code, bytes4(keccak256("owner()")));
        _assertHasSelector(code, bytes4(keccak256("renounceOwnership()")));

        // Forbidden — transferOwnership in any common signature.
        _assertNoSelector(code, bytes4(keccak256("transferOwnership(address)")));
        _assertNoSelector(code, bytes4(keccak256("acceptOwnership()")));
        _assertNoSelector(code, bytes4(keccak256("pendingOwner()")));

        // Forbidden — generic admin / migration / withdrawal patterns.
        _assertNoSelector(code, bytes4(keccak256("rescue(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescueETH(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescueERC20(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescueERC721(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("sweep(address)")));
        _assertNoSelector(code, bytes4(keccak256("migrate(address)")));
        _assertNoSelector(code, bytes4(keccak256("emergencyWithdraw()")));
    }

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

    function _assertHasSelector(bytes memory code, bytes4 sel) internal pure {
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == sel[0]
                    && code[i + 1] == sel[1]
                    && code[i + 2] == sel[2]
                    && code[i + 3] == sel[3]
            ) {
                return;
            }
        }
        revert("bytecode missing required selector");
    }

    // ────────── (13) Acquisition.originalSeller plumbed correctly ──────────

    function test_AcceptListing_RecordsListingSellerAsOriginalSeller() public {
        // Mirror of (2) but asserts on the records-only core directly.
        uint16 punkId = _findEligiblePunk(8_000);
        address listingSeller = address(0x011);
        address finder = address(0xF1);
        _addAllowedSellerImmediate(listingSeller);
        _fundPatronFromAdapter(5 ether);
        _giveAndPublicList(listingSeller, punkId, 0.5 ether);
        uint8 target = _pickTarget(punkId);
        vm.prank(finder);
        patron.acceptListing(punkId, target);

        assertEq(collection.originalSellerOf(punkId), listingSeller, "originalSeller = listing seller");
        IPermanentCollection.Custody c = collection.custodyOf(punkId);
        assertEq(uint256(c), uint256(IPermanentCollection.Custody.InReturnAuction));
    }

    function test_AcceptBounty_RecordsPreListerAsOriginalSeller() public {
        uint16 punkId = _findEligiblePunk(9_000);
        address seller = address(0x022);
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);
        assertEq(collection.originalSellerOf(punkId), seller, "originalSeller = pre-lister");
    }

    // ────────── helpers ──────────

    /// @dev Naive substring search over raw bytes. The caller base64-decodes
    ///      the Proof tokenURI's outer JSON first, so this runs over the
    ///      decoded JSON bytes.
    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0) return true;
        if (needle.length > hay.length) return false;
        for (uint256 i = 0; i <= hay.length - needle.length; i++) {
            bool match_ = true;
            for (uint256 k = 0; k < needle.length; k++) {
                if (hay[i + k] != needle[k]) { match_ = false; break; }
            }
            if (match_) return true;
        }
        return false;
    }
}
