// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {TraitIconCache} from "../src/TraitIconCache.sol";
import {IPunksData} from "../src/interfaces/IPunksData.sol";

/// @notice Mainnet-fork tests for the public trait-icon cache.
contract TraitIconCacheTest is Test {
    address internal constant PUNKS_DATA = 0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C;

    TraitIconCache internal cache;

    function setUp() public {
        string memory url = vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url);
        require(PUNKS_DATA.code.length > 0, "PunksData missing on fork");
        cache = new TraitIconCache(PUNKS_DATA);
    }

    // ────────── construction ──────────

    function test_Constructor_PinsExpectedDataset() public view {
        assertEq(address(cache.punksData()), PUNKS_DATA, "punksData pinned");
        assertEq(
            cache.EXPECTED_DATASET_HASH(),
            0x92117ce6cb6bb70f9ffb9bf51ebbca6a84eae10e70639295d9c4a07958cd1f68,
            "expected dataset hash matches PC's pinned value"
        );
        assertEq(cache.TOTAL_TRAITS(), 111);
    }

    function test_Constructor_RejectsBadDataset() public {
        BadPunksData bad = new BadPunksData();
        vm.expectRevert(
            abi.encodeWithSelector(
                TraitIconCache.UnexpectedDatasetHash.selector,
                cache.EXPECTED_DATASET_HASH(),
                bytes32(uint256(0xdead))
            )
        );
        new TraitIconCache(address(bad));
    }

    // ────────── cacheTrait — happy paths per trait class ──────────

    function test_CacheTrait_Type_StoresAndReturnsPointer() public {
        // Trait 2 = Female (Type, non-rotation). The renderer pins a
        // single canonical Punk for this trait, so the cache can store
        // it. Trait 0 (Alien) would revert RotationTraitNotCacheable.
        address pointer = cache.cacheTrait(2);
        assertTrue(pointer != address(0));
        assertTrue(cache.isCached(2));
        assertEq(cache.pointerOf(2), pointer);
        bytes memory frag = cache.fragmentOf(2);
        assertGt(frag.length, 0, "fragment non-empty");
    }

    function test_CacheTrait_HeadVariant_StoresFragment() public {
        // Trait 8 = a head variant (non-rotation). Should bake a full Punk RLE.
        address pointer = cache.cacheTrait(8);
        assertTrue(pointer != address(0));
        bytes memory frag = cache.fragmentOf(8);
        assertGt(frag.length, 100, "head variant Punk fragment has substance");
    }

    function test_CacheTrait_AttributeCount_DotStrip() public {
        // Trait 16 = 0 attributes; 20 = 4 attributes; 23 = 7 attributes.
        // All bake as 7-dot strips; never reverts on EmptyFragment.
        for (uint8 t = 16; t <= 23; t++) {
            cache.cacheTrait(t);
            assertTrue(cache.isCached(t));
            bytes memory frag = cache.fragmentOf(t);
            assertGt(frag.length, 100, "dot strip emits 7 rects");
        }
    }

    function test_CacheTrait_Accessory_DiffFragment() public {
        // Trait 24 = first accessory. Bakes as canonical-vs-baseline diff.
        address pointer = cache.cacheTrait(24);
        assertTrue(pointer != address(0));
        bytes memory frag = cache.fragmentOf(24);
        assertGt(frag.length, 20, "accessory diff has at least a few pixels");
    }

    // ────────── cacheTrait — bounds & idempotency ──────────

    function test_CacheTrait_RejectsOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(TraitIconCache.InvalidTraitId.selector, uint8(111)));
        cache.cacheTrait(111);
        vm.expectRevert(abi.encodeWithSelector(TraitIconCache.InvalidTraitId.selector, uint8(200)));
        cache.cacheTrait(200);
    }

    function test_CacheTrait_Idempotent() public {
        address first = cache.cacheTrait(10);
        address second = cache.cacheTrait(10);
        assertEq(first, second, "re-bake returns existing pointer without deploying again");
        // Storage of the SSTORE2 contract is unchanged.
        assertEq(cache.pointerOf(10), first);
    }

    function test_CacheTrait_EmitsEvent() public {
        // Spec: trait 2 (Female, non-rotation) must emit TraitCached on
        // first bake. (Trait 0 would revert RotationTraitNotCacheable.)
        vm.recordLogs();
        cache.cacheTrait(2);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == keccak256("TraitCached(uint8,address,uint256)")) {
                assertEq(uint8(uint256(entries[i].topics[1])), 2);
                found = true;
                break;
            }
        }
        assertTrue(found, "TraitCached event emitted");
    }

    // ────────── cacheTrait — rotation traits ──────────

    function test_CacheTrait_RotationIds_Revert() public {
        // The Mosaic renderer rotates the uncollected cell per block for
        // {0, 1, 4, 5, 6, 15} (three rare types + three single-member
        // head variants whose head shape coincides with a rare type).
        // Any cached bytes would go stale every ~12s, so the cache
        // rejects bakes for them. Asserts both the error selector and
        // that the slot stays uncached.
        uint8[6] memory rotationIds = [uint8(0), 1, 4, 5, 6, 15];
        for (uint256 i = 0; i < rotationIds.length; i++) {
            uint8 t = rotationIds[i];
            assertTrue(cache.isRotationTrait(t), "isRotationTrait taxonomy");
            vm.expectRevert(
                abi.encodeWithSelector(TraitIconCache.RotationTraitNotCacheable.selector, t)
            );
            cache.cacheTrait(t);
            assertFalse(cache.isCached(t), "rotation trait stays uncached");
        }
    }

    function test_IsRotationTrait_FullPartition() public view {
        // Hardcoded check covering every trait id: bits {0, 1, 4, 5, 6, 15}
        // must be rotation, everything else must not. Drift between the
        // cache's mask and the renderer's mask is what would let the
        // PR #123 bug (stale cache vs. per-block render) recur — this
        // pins the cache side. The renderer side is independently pinned
        // by its own ROTATION_TRAIT_MASK constant + the parity test
        // skipping rotation ids in PermanentCollectionMosaicRenderer.t.sol.
        for (uint8 t = 0; t < 111; t++) {
            bool expected = (t == 0 || t == 1 || t == 4 || t == 5 || t == 6 || t == 15);
            assertEq(cache.isRotationTrait(t), expected, "isRotationTrait partition");
        }
    }

    function test_IsRotationTrait_RevertsOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(TraitIconCache.InvalidTraitId.selector, uint8(111)));
        cache.isRotationTrait(111);
    }

    // ────────── read views ──────────

    function test_IsCached_FalseBeforeBake() public view {
        assertFalse(cache.isCached(0));
        assertFalse(cache.isCached(50));
        assertFalse(cache.isCached(110));
    }

    function test_IsCached_RevertsOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(TraitIconCache.InvalidTraitId.selector, uint8(111)));
        cache.isCached(111);
    }

    function test_PointerOf_RevertsBeforeBake() public {
        vm.expectRevert(abi.encodeWithSelector(TraitIconCache.NotCached.selector, uint8(50)));
        cache.pointerOf(50);
    }

    function test_FragmentOf_RevertsBeforeBake() public {
        vm.expectRevert(abi.encodeWithSelector(TraitIconCache.NotCached.selector, uint8(75)));
        cache.fragmentOf(75);
    }

    function test_SvgOf_WrapsFragmentInSvgTag() public {
        // Trait 2 = Female (non-rotation); trait 0 would revert.
        cache.cacheTrait(2);
        string memory svg = cache.svgOf(2);
        bytes memory b = bytes(svg);
        // Starts with `<svg` and ends with `</svg>`.
        assertEq(b[0], "<");
        assertEq(b[1], "s");
        assertEq(b[2], "v");
        assertEq(b[3], "g");
        assertEq(b[b.length - 6], "<");
        assertEq(b[b.length - 5], "/");
        assertEq(b[b.length - 4], "s");
        assertEq(b[b.length - 3], "v");
        assertEq(b[b.length - 2], "g");
        assertEq(b[b.length - 1], ">");
    }

    function test_CanonicalPunkForTrait_BoundaryValues() public view {
        // Trait 0 = Alien type → canonical Punk 0x0c1c = 3100.
        assertEq(cache.canonicalPunkForTrait(0), 0x0c1c);
        // Trait 110 = last accessory.
        uint16 last = cache.canonicalPunkForTrait(110);
        assertLt(last, 10_000, "canonical punks in 0..9999 range");
    }

    function test_CanonicalPunkForTrait_RevertsOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(TraitIconCache.InvalidTraitId.selector, uint8(111)));
        cache.canonicalPunkForTrait(111);
    }

    // ────────── no-admin / public-good properties ──────────

    function test_NoAdminSurface() public view {
        // The cache has no admin role, no owner, no setter. Smoke-test
        // by asserting the bytecode contains no `transferOwnership` /
        // `renounceOwnership` / `setOwner` / `pause` / `unpause` /
        // `selfdestruct` selectors. None of these are in the source.
        bytes memory code = address(cache).code;
        assertFalse(_codeContainsSelector(code, 0xf2fde38b)); // transferOwnership
        assertFalse(_codeContainsSelector(code, 0x715018a6)); // renounceOwnership
        assertFalse(_codeContainsSelector(code, 0x13af4035)); // setOwner
        assertFalse(_codeContainsSelector(code, 0x8456cb59)); // pause
        assertFalse(_codeContainsSelector(code, 0x3f4ba83a)); // unpause
    }

    function test_AnyoneCanBake() public {
        // No access control. Different callers can both bake. Trait 1
        // (Ape, rotation) would revert RotationTraitNotCacheable; use
        // trait 3 (Male) and trait 2 (Female) instead — both non-rotation.
        address alice = address(0xA11CE);
        address bob = address(0xB0B);
        vm.prank(alice);
        cache.cacheTrait(3);
        vm.prank(bob);
        cache.cacheTrait(2);
        assertTrue(cache.isCached(3));
        assertTrue(cache.isCached(2));
    }

    // ────────── determinism ──────────

    function test_FragmentReproducible_AcrossCacheInstances() public {
        // Same input → same fragment bytes, regardless of which cache
        // instance baked it. This is the public-good guarantee: any
        // consumer can independently reproduce the cached bytes. Trait
        // 2 (Female, non-rotation) — trait 0 would revert.
        TraitIconCache other = new TraitIconCache(PUNKS_DATA);
        cache.cacheTrait(2);
        other.cacheTrait(2);
        bytes memory a = cache.fragmentOf(2);
        bytes memory b = other.fragmentOf(2);
        assertEq(keccak256(a), keccak256(b), "deterministic across instances");
    }

    /// @notice Internal-consistency invariant: for every non-rotation
    ///         trait, the cache's pure-compute `buildFragment` output
    ///         must equal the bytes ultimately returned by `fragmentOf`
    ///         after bake. Proves storage round-trips losslessly
    ///         through SSTORE2. The six rotation traits are skipped —
    ///         `cacheTrait` rejects them, so there's no `fragmentOf` to
    ///         compare against (covered by
    ///         `test_CacheTrait_RotationIds_Revert`). Heavy: ~520M
    ///         total gas to bake the 105 cacheable traits.
    function test_AllTraits_BuildFragment_MatchesFragmentOf() public {
        for (uint8 t = 0; t < 111; t++) {
            if (cache.isRotationTrait(t)) continue;
            bytes memory pre = cache.buildFragment(t);
            cache.cacheTrait(t);
            bytes memory post = cache.fragmentOf(t);
            assertEq(
                keccak256(pre),
                keccak256(post),
                string.concat("trait ", vm.toString(uint256(t)), " bytes diverged through storage")
            );
        }
    }

    // ────────── helpers ──────────

    function _codeContainsSelector(bytes memory code, bytes4 selector) internal pure returns (bool) {
        if (code.length < 4) return false;
        for (uint256 i = 0; i <= code.length - 4; i++) {
            if (
                code[i] == selector[0] &&
                code[i + 1] == selector[1] &&
                code[i + 2] == selector[2] &&
                code[i + 3] == selector[3]
            ) return true;
        }
        return false;
    }
}

// Stub PunksData that returns a different datasetHash. Used to verify
// the cache's constructor pin works.
contract BadPunksData {
    function datasetHash() external pure returns (bytes32) {
        return bytes32(uint256(0xdead));
    }
    function indexedPixelsOf(uint16) external pure returns (bytes memory) {
        return new bytes(576);
    }
    function paletteRgbaBytes() external pure returns (bytes memory) {
        return new bytes(1024);
    }
    function headVariantOf(uint16) external pure returns (uint8) {
        return 0;
    }
}

