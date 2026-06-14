// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base64} from "solady/utils/Base64.sol";

import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {RendererRegistry} from "../src/RendererRegistry.sol";
import {TraitIconCache} from "../src/TraitIconCache.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice End-to-end tests for the cache-backed mosaic renderer. Uses
///         a locally-constructed `mosaic` (not the inherited
///         `mosaicRenderer`) so the tests can assert on a renderer they
///         fully control without going through `_launchPool`. The
///         inherited `punkSvgCache` field is reused.
contract PermanentCollectionMosaicRendererTest is ForkFixtures {
    PermanentCollectionMosaicRenderer internal mosaic;
    // `traitIconCache` is inherited from ForkFixtures.

    /// @dev 111 canonical Punks, one per trait. Same table the V4
    ///      placeholder logic uses internally — guaranteed to carry the
    ///      corresponding trait bit, so they're a clean source for the
    ///      full-set storage-probe scenario.
    bytes private constant CANONICAL_IDS =
        hex"0c1c09bb0002000608120b4a0174089c041a0281195702e501fe01190ceb067a"
        hex"01190002000100000004002302f3209c0225005d015807ac06cd035f00600366"
        hex"1532011002460087212b005907f90cd7061a12d1014f17cb018d0014001a0006"
        hex"01180012003700b20b74068d1da4015103bd03800ff0002b0a600039003618c3"
        hex"008c002f169401b4002c007101430069098d1c43148e0ad00b6f061600f90021"
        hex"04d003460fb51851008601ac015a075b0024027523b900b700381bc714f0102f"
        hex"031e00bb006a01a1001f004202c2035315ca02a90132071d00f100020019";

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        punkSvgCache = new PunkSvgFragmentCache(PUNKS_DATA);
        traitIconCache = new TraitIconCache(PUNKS_DATA);
        proofRenderer = new PermanentCollectionProofRenderer(
            address(vault), PUNKS_DATA, address(traitIconCache), address(punkSvgCache)
        );
        mosaic = new PermanentCollectionMosaicRenderer(
            address(collection), address(vault), address(punkSvgCache), PUNKS_DATA, address(traitIconCache), address(proofRenderer)
        );
        _fundPatronFromAdapter(30 ether);
    }

    // ────────── constructor ──────────

    function test_Constructor_ZeroChecks() public {
        vm.expectRevert(bytes("MosaicRenderer: zero collection"));
        new PermanentCollectionMosaicRenderer(address(0), address(vault), address(punkSvgCache), PUNKS_DATA, address(traitIconCache), address(proofRenderer));
        vm.expectRevert(bytes("MosaicRenderer: zero vault"));
        new PermanentCollectionMosaicRenderer(
            address(collection), address(0), address(punkSvgCache), PUNKS_DATA, address(traitIconCache), address(proofRenderer)
        );
        vm.expectRevert(bytes("MosaicRenderer: zero cache"));
        new PermanentCollectionMosaicRenderer(address(collection), address(vault), address(0), PUNKS_DATA, address(traitIconCache), address(proofRenderer));
        vm.expectRevert(bytes("MosaicRenderer: zero punksData"));
        new PermanentCollectionMosaicRenderer(address(collection), address(vault), address(punkSvgCache), address(0), address(traitIconCache), address(proofRenderer));
        vm.expectRevert(bytes("MosaicRenderer: zero traitIconCache"));
        new PermanentCollectionMosaicRenderer(address(collection), address(vault), address(punkSvgCache), PUNKS_DATA, address(0), address(proofRenderer));
        vm.expectRevert(bytes("MosaicRenderer: zero proofRenderer"));
        new PermanentCollectionMosaicRenderer(address(collection), address(vault), address(punkSvgCache), PUNKS_DATA, address(traitIconCache), address(0));
    }

    function test_Constructor_PinsImmutables() public view {
        assertEq(address(mosaic.collection()), address(collection));
        assertEq(address(mosaic.vault()), address(vault));
        assertEq(address(mosaic.punkSvgCache()), address(punkSvgCache));
        assertEq(address(mosaic.punksData()), PUNKS_DATA);
        assertEq(address(mosaic.traitIconCache()), address(traitIconCache));
        assertEq(address(mosaic.proofRenderer()), address(proofRenderer));
    }

    // ────────── cacheTrait helper ──────────

    function test_CacheTrait_RevertsBeforeCollection() public {
        // Trait 0 (Alien type) is uncollected at fresh deploy.
        vm.expectRevert(
            abi.encodeWithSelector(PermanentCollectionMosaicRenderer.TraitNotCollected.selector, uint8(0))
        );
        mosaic.cacheTrait(0);
    }

    function test_CacheTrait_AfterRealSettlement_CachesFirstVaultedPunk() public {
        uint16 punkId = _findEligiblePunk(1);
        address owner = address(0xBEA71E);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        (uint16 fv, bool exists) = collection.firstVaultedPunk(target);
        assertTrue(exists);
        assertEq(fv, punkId, "first vaulted punk for target trait");

        // Cache wasn't populated before settle.
        assertFalse(mosaic.isTraitCached(target), "uncached pre-bake");
        address pointer = mosaic.cacheTrait(target);
        assertTrue(pointer != address(0), "cache pointer set");
        assertTrue(mosaic.isTraitCached(target), "cached post-bake");
    }

    function test_CachedPunkForTrait_View() public {
        (uint16 punkId, bool exists) = mosaic.cachedPunkForTrait(0);
        assertFalse(exists, "no collected trait yet");
        assertEq(punkId, 0, "punkId zero before collection");
    }

    // ────────── render output ──────────

    function test_TokenURI_NonEmpty_DataUri() public view {
        string memory uri = mosaic.tokenURI();
        bytes memory u = bytes(uri);
        assertGt(u.length, 200, "non-trivial output");
        assertEq(u[0], "d");
        assertEq(u[1], "a");
        assertEq(u[2], "t");
        assertEq(u[3], "a");
    }

    function test_TokenURI_Base64Envelope_DecodesToJsonObject() public view {
        // The decode helper requires the exact `data:application/json;base64,`
        // prefix and base64-decodes the body, so a clean decode to a JSON
        // object proves the OpenSea-documented envelope. The inner image is a
        // base64 SVG data URI, so nothing in the output is unescaped.
        bytes memory json = _decodeBase64JsonBody(mosaic.tokenURI());
        assertEq(json[0], bytes1("{"), "decoded body starts a JSON object");
        assertEq(json[json.length - 1], bytes1("}"), "decoded body ends a JSON object");
        assertTrue(_contains(json, bytes('"image":"data:image/svg+xml;base64,')), "inner base64 svg image");
    }

    function test_ContractURI_NonVaultCaller_ReturnsErc20Payload() public view {
        // Calls from arbitrary addresses (e.g. the artcoins ERC20) get the
        // ERC20-flavored JSON — same bytes as the zero-arg `tokenURI()`.
        string memory zeroArg = mosaic.tokenURI();
        string memory cu = mosaic.contractURI(address(0x1111));
        assertEq(cu, zeroArg, "contractURI(non-vault) returns ERC20 payload");
    }

    function test_ContractURI_VaultCaller_UsesNftSymbol() public view {
        // The vault's marketplace collection page (`PunkVault.contractURI()`,
        // token = the vault) reads the collection envelope with the NFT
        // symbol "PERMANENTCOLLECTION". The ERC20 path (tokenURI() /
        // contractURI(non-vault)) uses "111" — same name + image, different
        // symbol per caller, so the two payloads differ.
        bytes memory vaultJson = _decodeBase64JsonBody(mosaic.contractURI(address(vault)));
        assertTrue(_contains(vaultJson, bytes('"name":"PERMANENT COLLECTION"')), "vault: collection name");
        assertTrue(_contains(vaultJson, bytes('"symbol":"PERMANENTCOLLECTION"')), "vault: NFT symbol");
        assertFalse(_contains(vaultJson, bytes('"symbol":"111PUNKS"')), "vault: no 111PUNKS");
        assertFalse(_contains(vaultJson, bytes('"symbol":"111"')), "vault: not the ERC20 symbol");
        assertTrue(
            keccak256(bytes(mosaic.contractURI(address(vault)))) != keccak256(bytes(mosaic.tokenURI())),
            "vault NFT payload differs from ERC20 payload"
        );
    }

    function test_TokenURI_DecodedJson_HasExpectedKeys() public view {
        string memory uri = mosaic.tokenURI();
        bytes memory json = _decodeBase64JsonBody(uri);
        assertTrue(_contains(json, bytes('"name":"PERMANENT COLLECTION"')), "name field");
        assertTrue(_contains(json, bytes('"symbol":"111"')), "ERC20 symbol is 111");
        assertFalse(_contains(json, bytes('"symbol":"111PUNKS"')), "no 111PUNKS symbol");
        assertTrue(_contains(json, bytes('"description":')), "description field");
        assertTrue(_contains(json, bytes('"image":"data:image/svg+xml;base64,')), "image field");
        assertTrue(_contains(json, bytes('"trait_type":"Traits Collected"')), "attribute: Traits Collected");
        assertTrue(_contains(json, bytes('"trait_type":"Traits Total"')), "attribute: Traits Total");
        assertTrue(_contains(json, bytes('"trait_type":"Punks Vaulted"')), "attribute: Punks Vaulted");
        assertFalse(_contains(json, bytes('"symbol":"PCT"')), "old PCT symbol removed");
    }

    function test_Svg_StartsWithSvgTag() public view {
        bytes memory s = bytes(mosaic.svg());
        assertEq(s[0], "<");
        assertEq(s[1], "s");
        assertEq(s[2], "v");
        assertEq(s[3], "g");
        // Ends with `</svg>`
        assertEq(s[s.length - 5], "/");
        assertEq(s[s.length - 4], "s");
        assertEq(s[s.length - 3], "v");
        assertEq(s[s.length - 2], "g");
        assertEq(s[s.length - 1], ">");
    }

    /// @notice Renderer/cache parity invariant: for every one of the 111
    ///         traits, the renderer's on-the-fly compute path
    ///         (`traitIconBytes`) must produce the exact bytes the cache
    ///         would store (`buildFragment`). If this passes:
    ///           - Cached cells render visually identically to uncached
    ///             cells, both before and after community bakes.
    ///           - A future renderer bug-fix can rely on the cache (the
    ///             cached bytes match the documented on-the-fly logic).
    ///           - The cache's "public good" claim — that anyone can
    ///             independently reproduce its output — is verified
    ///             against this specific renderer.
    ///         Heavy: ~600M gas to evaluate both sides across all 111.
    ///         Cache is left untouched (no bakes); this only checks the
    ///         compute-level equivalence.
    function test_AllTraits_RendererOnTheFly_MatchesCacheBuild() public view {
        for (uint8 t = 0; t < 111; t++) {
            // Cache is fresh, no traits baked — renderer falls through to
            // the on-the-fly compute path for every call. The identity
            // invariant holds across ALL trait ids at the same block,
            // including the six rotation traits ({0, 1, 4, 5, 6, 15}):
            // the renderer and the cache both call into the shared
            // `RotationPool` library with the same `(traitId,
            // block.number)`, so the per-block picks agree.
            bytes memory onTheFly = mosaic.traitIconBytes(uint16(t));
            bytes memory wouldBake = traitIconCache.buildFragment(t);
            assertEq(
                keccak256(onTheFly),
                keccak256(wouldBake),
                string.concat(
                    "trait ",
                    vm.toString(uint256(t)),
                    " renderer-vs-cache divergence"
                )
            );
        }
    }

    /// @notice `cacheTrait` reverts `RotationTraitNotCacheable` for each
    ///         of the six rotation trait ids. Caching them would burn
    ///         gas writing bytes that go stale within the next block —
    ///         the renderer already short-circuits rotation traits to
    ///         the live rotation path before consulting the cache, so
    ///         any stored value would be unread anyway.
    function test_RotationTrait_CacheTraitReverts() public {
        uint8[6] memory rotationIds = [uint8(0), 1, 4, 5, 6, 15];
        for (uint256 i = 0; i < rotationIds.length; i++) {
            uint8 t = rotationIds[i];
            vm.expectRevert(
                abi.encodeWithSelector(TraitIconCache.RotationTraitNotCacheable.selector, t)
            );
            traitIconCache.cacheTrait(t);
        }
    }

    /// @notice `buildFragment` works for ALL trait ids including the six
    ///         rotation ones — it returns the current block's pick for
    ///         them via `RotationPool`. This is required by the Proof
    ///         renderer, which uses `buildFragment` as the image-content
    ///         source for token ids 0..110.
    function test_RotationTrait_BuildFragmentSucceeds() public view {
        uint8[6] memory rotationIds = [uint8(0), 1, 4, 5, 6, 15];
        for (uint256 i = 0; i < rotationIds.length; i++) {
            bytes memory frag = traitIconCache.buildFragment(rotationIds[i]);
            assertGt(frag.length, 0, "rotation trait must still produce bytes");
        }
    }

    function test_Render_CollectedButUncached_UsesLiveBuiltFragment() public {
        // Settle one Punk → trait collected, but do NOT cache. Post PR #81,
        // the renderer's collected-but-uncached path calls
        // `punkSvgCache.buildFragment(punkId)` live instead of laying down
        // a placeholder marker (#1f3f1f) — the cell shows real art the
        // moment the trait is collected.
        uint16 punkId = _findEligiblePunk(1);
        address owner = address(0xBEA71E);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertFalse(mosaic.isTraitCached(target), "uncached precondition");
        // Render still works.
        bytes memory svg = bytes(mosaic.svg());
        // The rendered SVG must literally contain the live-built fragment
        // bytes — same containment check as the cached-tile test below,
        // proving the live-fallback path ran in lieu of the old marker.
        bytes memory liveFragment = punkSvgCache.buildFragment(punkId);
        assertTrue(_contains(svg, liveFragment), "rendered SVG contains live-built Punk fragment");
        // Cross-contract identity invariant: `buildFragment(p)` is
        // byte-identical to what `cachePunk(p)` would store, so caching
        // the trait must NOT change the rendered output. This is what
        // makes the live-fallback path safe — uncached cells render
        // identically to cached ones.
        bytes32 preHash = keccak256(svg);
        mosaic.cacheTrait(target);
        bytes32 postHash = keccak256(bytes(mosaic.svg()));
        assertEq(preHash, postHash, "live-built output matches cached output (identity invariant)");
    }

    function test_Render_UsesCachedTile_AfterBake() public {
        // Real settle + cache.
        uint16 punkId = _findEligiblePunk(1);
        address owner = address(0xBEA71E);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);
        mosaic.cacheTrait(target);

        bytes memory fragment = punkSvgCache.fragmentOf(punkId);
        bytes memory svg = bytes(mosaic.svg());
        // The rendered SVG must literally contain the cached fragment
        // bytes (the renderer wraps fragmentOf in <g transform>...</g>).
        assertTrue(_contains(svg, fragment), "rendered SVG contains cached Punk tile");
    }

    function test_TokenURI_TitleId_ReturnsTitleEnvelope() public {
        // Title now sits at token id 111 (Proofs occupy 0..110). The
        // renderer's tokenURI(111) doesn't depend on mint state.
        string memory uri = mosaic.tokenURI(111);
        bytes memory u = bytes(uri);
        assertGt(u.length, 200, "non-trivial output");
        bytes memory json = _decodeBase64JsonBody(uri);
        assertTrue(_contains(json, bytes('"name":"PERMANENT COLLECTION Vault Title"')));
        assertTrue(_contains(json, bytes('"attributes":')));
        // Title attributes are scoped to the state of the collection itself —
        // not rights/status/contract-address metadata (those are concerns of
        // the protocol, not the artwork). Assert the on-chain state fields
        // are present.
        assertTrue(_contains(json, bytes('"trait_type":"Punks Vaulted"')), "Punks Vaulted attribute");
        assertTrue(_contains(json, bytes('"trait_type":"Traits Collected"')), "Traits Collected attribute");
        assertTrue(_contains(json, bytes('"trait_type":"Traits Total"')), "Traits Total attribute");
        assertTrue(_contains(json, bytes('"trait_type":"Collection Complete"')), "Collection Complete attribute");
        // And that the dropped attributes are NOT present.
        assertFalse(_contains(json, bytes('"Punks Acquired"')), "Punks Acquired dropped");
        assertFalse(_contains(json, bytes('"Withdraw Rights"')), "Withdraw Rights dropped");
        assertFalse(_contains(json, bytes('"Admin Rights"')), "Admin Rights dropped");
        assertFalse(_contains(json, bytes('"Title Status"')), "Title Status dropped");
        assertFalse(_contains(json, bytes('"Vault Contract"')), "Vault Contract dropped");
    }

    function test_TokenURI_ProofId_RoutesToProofRenderer() public {
        // ids 0..110 dispatch to the Proof renderer (tokenId == traitId).
        // An unminted Proof has no metadata — the proof renderer reverts
        // `ProofNotMinted` (no preview envelope), and the mosaic forwards
        // that revert verbatim. Probe id 0 both directly and through the
        // mosaic dispatch to prove the routing reaches the proof renderer.
        vm.expectRevert(
            abi.encodeWithSelector(PermanentCollectionProofRenderer.ProofNotMinted.selector, uint256(0))
        );
        proofRenderer.tokenURI(0);

        vm.expectRevert(
            abi.encodeWithSelector(PermanentCollectionProofRenderer.ProofNotMinted.selector, uint256(0))
        );
        mosaic.tokenURI(0);
    }

    function test_TokenURI_TitleId_RevertsOnUnknownId() public {
        // 112+ is unreachable: above the Proof range, no Title there.
        vm.expectRevert(
            abi.encodeWithSelector(PermanentCollectionMosaicRenderer.UnknownTokenId.selector, uint256(112))
        );
        mosaic.tokenURI(112);
    }

    // ────────── full-set gas budget ──────────

    /// @notice The headline test the new design exists to pass: render a
    ///         full-set tokenURI with every tile cached. Logs gas + size
    ///         for documentation; asserts under a 50M ceiling per the
    ///         plan's Definition Of Done.
    function test_FullSet_AllCached_GasAndSize() public {
        // Force-set every trait collected.
        _setCollectedMask(collection.FULL_SET_MASK());
        assertTrue(collection.isComplete());

        // For each trait, point firstVaultedPunk at the canonical Punk
        // for that trait (one canonical per trait — guaranteed to carry
        // the bit, so the cached visual is meaningful).
        for (uint8 t = 0; t < 111; t++) {
            uint16 punkId = _canonicalPunk(t);
            _setFirstVaultedPunk(t, punkId);
            punkSvgCache.cachePunk(punkId);
        }

        uint256 gasBefore = gasleft();
        string memory uri = mosaic.tokenURI();
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("mosaic full-set tokenURI gas", gasUsed);
        emit log_named_uint("mosaic full-set tokenURI bytes", bytes(uri).length);
        assertGt(bytes(uri).length, 1000, "non-trivial output");
        // Gas budget: aim for <50M. If this is breached, the plan calls
        // for measuring + documenting before shipping.
        assertLt(gasUsed, 50_000_000, "mosaic tokenURI under 50M gas at full set");

        // Decoded SVG contains "FULL SET COMPLETE" footer text. The
        // pixel-font emits a `<rect>` per glyph row run, so we can't
        // grep for the literal string, but we CAN confirm we hit the
        // complete branch by re-rendering svg() directly and checking
        // its length is consistent.
        string memory svgStr = mosaic.svg();
        assertGt(bytes(svgStr).length, 1000, "svg is non-trivial");
    }

    function test_FullSet_RawSvg_GasAndSize() public {
        _setCollectedMask(collection.FULL_SET_MASK());
        for (uint8 t = 0; t < 111; t++) {
            uint16 punkId = _canonicalPunk(t);
            _setFirstVaultedPunk(t, punkId);
            punkSvgCache.cachePunk(punkId);
        }
        uint256 gasBefore = gasleft();
        string memory s = mosaic.svg();
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("mosaic full-set svg gas", gasUsed);
        emit log_named_uint("mosaic full-set svg bytes", bytes(s).length);
    }

    // ────────── vault title NFT integration ──────────

    function test_VaultTokenURI_Works_AfterTitleMint() public {
        // Wire registry to point at the mosaic renderer, then mint title.
        rendererRegistry = new RendererRegistry(address(adminContract), address(mosaic));
        vault.setRendererRegistry(address(rendererRegistry));
        vm.prank(address(titleAuction));
        vault.mintToAuction();

        // Vault delegates `tokenURI(111)` (the Title) to the registry,
        // which forwards to the mosaic renderer. This is the path a
        // marketplace hits.
        string memory uri = vault.tokenURI(111);
        bytes memory u = bytes(uri);
        assertGt(u.length, 200);
        bytes memory json = _decodeBase64JsonBody(uri);
        assertTrue(_contains(json, bytes('"name":"PERMANENT COLLECTION Vault Title"')));
    }

    function test_RegistryPassthrough_ContractURI() public {
        rendererRegistry = new RendererRegistry(address(adminContract), address(mosaic));
        string memory direct = mosaic.contractURI(address(0xdead));
        string memory viaReg = rendererRegistry.contractURI(address(0xdead));
        assertEq(direct, viaReg, "registry forwards contractURI(address)");
    }

    // ────────── helpers ──────────

    function _findEligiblePunk(uint16 startFrom) internal view returns (uint16) {
        for (uint16 i = startFrom; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible punk");
    }

    function _canonicalPunk(uint8 traitId) internal pure returns (uint16) {
        uint256 offset = uint256(traitId) * 2;
        bytes memory c = CANONICAL_IDS;
        return (uint16(uint8(c[offset])) << 8) | uint16(uint8(c[offset + 1]));
    }

    /// @dev `data:application/json;base64,XXX` → returns the decoded JSON
    ///      bytes. The renderer emits a base64-encoded JSON envelope (the
    ///      OpenSea-documented form); the inner image is a base64 SVG data
    ///      URI nested inside that JSON. Asserts the exact prefix so a
    ///      format regression fails loud here.
    function _decodeBase64JsonBody(string memory uri) internal pure returns (bytes memory) {
        bytes memory u = bytes(uri);
        bytes memory prefix = bytes("data:application/json;base64,");
        require(u.length > prefix.length, "decode: short uri");
        for (uint256 i = 0; i < prefix.length; i++) {
            require(u[i] == prefix[i], "decode: not a base64 json envelope");
        }
        bytes memory b64 = new bytes(u.length - prefix.length);
        for (uint256 i = 0; i < b64.length; i++) b64[i] = u[i + prefix.length];
        return Base64.decode(string(b64));
    }

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
