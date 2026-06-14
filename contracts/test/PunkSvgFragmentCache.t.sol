// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {IPunksData} from "../src/interfaces/IPunksData.sol";

/// @notice Mainnet-fork tests for the public Punk SVG fragment cache.
contract PunkSvgFragmentCacheTest is Test {
    address internal constant PUNKS_DATA = 0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C;

    PunkSvgFragmentCache internal cache;

    function setUp() public {
        string memory url = vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url);
        require(PUNKS_DATA.code.length > 0, "PunksData missing on fork");
        cache = new PunkSvgFragmentCache(PUNKS_DATA);
    }

    // ────────── construction ──────────

    function test_Constructor_PinsExpectedDataset() public view {
        assertEq(address(cache.punksData()), PUNKS_DATA, "punksData pinned");
        assertEq(
            cache.EXPECTED_DATASET_HASH(),
            0x92117ce6cb6bb70f9ffb9bf51ebbca6a84eae10e70639295d9c4a07958cd1f68,
            "expected dataset hash matches PC's pinned value"
        );
    }

    function test_Constructor_RejectsBadDataset() public {
        // Deploy a stub PunksData impostor with a different dataset hash.
        BadPunksData bad = new BadPunksData();
        vm.expectRevert(
            abi.encodeWithSelector(
                PunkSvgFragmentCache.UnexpectedDatasetHash.selector,
                cache.EXPECTED_DATASET_HASH(),
                bytes32(uint256(0xdead))
            )
        );
        new PunkSvgFragmentCache(address(bad));
    }

    // ────────── cachePunk ──────────

    function test_CachePunk_StoresAndReturnsPointer() public {
        // Use the alien #7804 — the highest-rarity Punk, well-known.
        address pointer = cache.cachePunk(7804);
        assertTrue(pointer != address(0), "pointer set");
        assertTrue(pointer.code.length > 0, "pointer has bytecode");
        assertTrue(cache.isCached(7804));
        assertEq(cache.pointerOf(7804), pointer);
    }

    function test_CachePunk_EmitsEvent() public {
        // Watch only the punkId topic; pointer is non-deterministic by
        // address-from-CREATE so we leave the address indexed-arg check
        // off, and assert byteLength later.
        vm.recordLogs();
        cache.cachePunk(5217);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == PunkSvgFragmentCache.PunkCached.selector) {
                assertEq(uint256(entries[i].topics[1]), 5217, "punkId topic");
                uint256 byteLen = abi.decode(entries[i].data, (uint256));
                assertGt(byteLen, 100, "fragment is non-trivial");
                assertLt(byteLen, 0x6000, "fragment fits SSTORE2 cap");
                found = true;
                break;
            }
        }
        assertTrue(found, "PunkCached event emitted");
    }

    function test_CachePunk_Idempotent() public {
        address p1 = cache.cachePunk(1234);
        address p2 = cache.cachePunk(1234);
        assertEq(p1, p2, "second call returns existing pointer");
        // Confirm no new SSTORE2 deployment by checking pointer didn't change
        // and the contract still reads the same fragment bytes.
        bytes memory f1 = cache.fragmentOf(1234);
        cache.cachePunk(1234); // third call
        bytes memory f2 = cache.fragmentOf(1234);
        assertEq(keccak256(f1), keccak256(f2), "fragment stable across re-caches");
    }

    function test_CachePunk_RevertsOnOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(PunkSvgFragmentCache.InvalidPunkId.selector, 10_000));
        cache.cachePunk(10_000);
        vm.expectRevert(abi.encodeWithSelector(PunkSvgFragmentCache.InvalidPunkId.selector, type(uint16).max));
        cache.cachePunk(type(uint16).max);
    }

    function test_CachePunk_Permissionless() public {
        // A random address can cache.
        address other = makeAddr("anyone");
        vm.prank(other);
        address p = cache.cachePunk(42);
        assertTrue(p != address(0));
    }

    // ────────── view reverts ──────────

    function test_FragmentOf_RevertsWhenUncached() public {
        vm.expectRevert(abi.encodeWithSelector(PunkSvgFragmentCache.NotCached.selector, 99));
        cache.fragmentOf(99);
    }

    function test_PointerOf_RevertsWhenUncached() public {
        vm.expectRevert(abi.encodeWithSelector(PunkSvgFragmentCache.NotCached.selector, 99));
        cache.pointerOf(99);
    }

    function test_SvgOf_RevertsWhenUncached() public {
        vm.expectRevert(abi.encodeWithSelector(PunkSvgFragmentCache.NotCached.selector, 99));
        cache.svgOf(99);
    }

    function test_IsCached_StartsFalse() public view {
        assertFalse(cache.isCached(0), "uncached starts false");
        assertFalse(cache.isCached(9999), "uncached starts false");
    }

    // ────────── fragment + svg content ──────────

    function test_FragmentOf_ContainsPathMarkers() public {
        cache.cachePunk(0);
        bytes memory frag = cache.fragmentOf(0);
        assertGt(frag.length, 100, "non-trivial bytes");
        // Must be a sequence of <path ... /> elements, one per color.
        assertEq(frag[0], bytes1("<"), "starts with element");
        bool sawPath = _contains(frag, bytes("<path"));
        assertTrue(sawPath, "contains <path> markers");
        bool sawMove = _contains(frag, bytes(' d="M'));
        assertTrue(sawMove, "path has M move command");
        bool sawHLine = _contains(frag, bytes("h"));
        assertTrue(sawHLine, "path has horizontal-line command");
    }

    function test_SvgOf_IsParseableStandalone() public {
        cache.cachePunk(0);
        string memory svg = cache.svgOf(0);
        bytes memory s = bytes(svg);
        // Starts with `<svg` and ends with `</svg>`.
        assertEq(s[0], bytes1("<"));
        assertEq(s[1], bytes1("s"));
        assertEq(s[2], bytes1("v"));
        assertEq(s[3], bytes1("g"));
        assertEq(s[s.length - 6], bytes1("<"));
        assertEq(s[s.length - 5], bytes1("/"));
        assertEq(s[s.length - 4], bytes1("s"));
        assertEq(s[s.length - 3], bytes1("v"));
        assertEq(s[s.length - 2], bytes1("g"));
        assertEq(s[s.length - 1], bytes1(">"));
    }

    function test_CachedFragments_DifferAcrossPunks() public {
        cache.cachePunk(0);
        cache.cachePunk(7804);
        bytes memory a = cache.fragmentOf(0);
        bytes memory b = cache.fragmentOf(7804);
        assertTrue(keccak256(a) != keccak256(b), "distinct Punks produce distinct fragments");
    }

    // ────────── helpers ──────────

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
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

// Imported here only to make the BadPunksData impostor compile-clean.
import {Vm} from "forge-std/Vm.sol";

/// @dev Minimal `IPunksData` impostor used by the constructor-rejection
///      test. Returns a deliberately wrong `datasetHash` so the
///      `PunkSvgFragmentCache` constructor must revert
///      `UnexpectedDatasetHash`.
contract BadPunksData {
    function datasetHash() external pure returns (bytes32) {
        return bytes32(uint256(0xdead));
    }
    // Stubs for the rest of the interface. Never called — construction
    // reverts before reading these.
    function traitMaskOf(uint16) external pure returns (uint256) { return 0; }
    function traitCount() external pure returns (uint16) { return 111; }
    function traitName(uint16) external pure returns (string memory) { return ""; }
    function indexedPixelsOf(uint16) external pure returns (bytes memory) { return ""; }
    function headVariantOf(uint16) external pure returns (uint8) { return 0; }
    function paletteRgbaBytes() external pure returns (bytes memory) { return ""; }
}
