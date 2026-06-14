// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {PermanentCollection} from "../src/PermanentCollection.sol";
import {IPunksData} from "../src/interfaces/IPunksData.sol";

/// @title  RarityTableForkTest
/// @notice Verifies the pinned `CARRIER_COUNTS` rarity table and the
///         `canonicalTargetOf` protocol-derived-target rule against the live
///         sealed PunksData dataset. PunksData is the single source of truth;
///         this test recomputes every per-trait carrier count from its 10,000
///         masks and asserts the pinned table matches, then proves the
///         rarest-first rule selects correctly and — critically — never
///         strands a trait (the whole point of #1 / mission-liveness).
///
/// Run:
///   MAINNET_RPC_URL=https://gateway.tenderly.co/public/mainnet \
///     forge test --match-contract RarityTableForkTest -vv
contract RarityTableForkTest is Test {
    address constant PUNKS_DATA = 0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C;
    uint8 constant TRAIT_COUNT = 111;
    uint256 constant N_PUNKS = 10_000;
    uint8 constant SOLE_CARRIER_BIT = 23;
    uint16 constant SOLE_CARRIER_PUNK = 8348;

    PermanentCollection internal pc;
    IPunksData internal punks;
    bool internal onFork;
    uint256[] internal masks; // per-Punk trait masks, cached once in setUp

    function setUp() public {
        // Self-fork (like the other fork suites) so this verification ALWAYS
        // runs and FAILS LOUD if no RPC is reachable — rather than silently
        // skipping (and vacuously passing) when invoked without an ambient
        // `--fork-url`. This is the only on-chain check that the pinned
        // `CARRIER_COUNTS` table matches live PunksData, so it must be
        // load-bearing in a default `forge test` run, not opt-in.
        vm.createSelectFork(vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet")));
        require(PUNKS_DATA.code.length != 0, "RarityTableFork: PunksData has no code on the selected fork");
        onFork = true;
        punks = IPunksData(PUNKS_DATA);
        // `adminContract` is provenance-only inside PermanentCollection (never
        // called), so any non-zero address satisfies the constructor; the
        // datasetHash check pins it to the real sealed dataset.
        pc = new PermanentCollection(PUNKS_DATA, address(this));
        masks = new uint256[](N_PUNKS);
        for (uint256 i = 0; i < N_PUNKS; i++) {
            masks[i] = punks.traitMaskOf(uint16(i));
        }
    }

    /// @notice The pinned `CARRIER_COUNTS` table equals the live popcount of
    ///         every trait bit across all 10,000 Punks. If this fails, the
    ///         pinned constant has drifted from the sealed dataset.
    function test_rarityTable_matchesLivePunksData() public view {
        if (!onFork) return;
        uint256[111] memory cnt;
        for (uint256 i = 0; i < N_PUNKS; i++) {
            uint256 m = masks[i];
            for (uint8 b = 0; b < TRAIT_COUNT; b++) {
                if ((m >> b) & 1 == 1) cnt[b]++;
            }
        }
        for (uint8 b = 0; b < TRAIT_COUNT; b++) {
            assertEq(uint256(pc.traitCarrierCount(b)), cnt[b], "pinned carrier count != live popcount");
            assertGt(cnt[b], 0, "every trait must have >=1 carrier");
        }
        // Anchors: bit 23 "7 Attributes" is the unique rarity-1 trait; bit 3
        // "Male" is the most common.
        assertEq(uint256(pc.traitCarrierCount(SOLE_CARRIER_BIT)), 1, "bit23 must be rarity-1");
        assertEq(uint256(pc.traitCarrierCount(3)), 6039, "bit3 Male must be 6039");
    }

    /// @notice On a fresh collection (nothing collected/pending),
    ///         `canonicalTargetOf` returns the min-carrier-count bit the Punk
    ///         carries (ties → lowest bit index), matching an independent
    ///         recomputation from the verified table.
    function test_canonicalTarget_picksRarest() public view {
        if (!onFork) return;
        for (uint256 s = 0; s < N_PUNKS; s += 137) {
            uint256 m = masks[s];
            uint16 bestCount = type(uint16).max;
            uint256 best = type(uint256).max;
            for (uint8 b = 0; b < TRAIT_COUNT; b++) {
                if ((m >> b) & 1 == 0) continue;
                uint16 c = pc.traitCarrierCount(b);
                if (c < bestCount) {
                    bestCount = c;
                    best = b;
                }
            }
            assertEq(uint256(pc.canonicalTargetOf(uint16(s))), best, "canonical != independently-derived rarest");
        }
    }

    /// @notice Sole-carrier subsumption: #8348 derives to bit 23, agreeing with
    ///         the legacy `soleCarrierConstraint` view.
    function test_canonicalTarget_soleCarrierSubsumed() public view {
        if (!onFork) return;
        assertEq(uint256(pc.canonicalTargetOf(SOLE_CARRIER_PUNK)), SOLE_CARRIER_BIT, "#8348 must derive to bit 23");
        (bool required, uint8 t) = pc.soleCarrierConstraint(SOLE_CARRIER_PUNK);
        assertTrue(required, "sole-carrier constraint active");
        assertEq(uint256(t), SOLE_CARRIER_BIT, "constraint trait == 23");
    }

    /// @notice MISSION-LIVENESS: feeding every Punk through the rarest-first
    ///         rule (each Punk collects the rarest uncollected trait it carries)
    ///         collects all 111 traits — the greedy never strands a trait for
    ///         this sealed dataset. This is the property #1 depends on: the
    ///         protocol-derived target preserves Full-Set reachability.
    function test_rarestFirst_saturatesAll111() public view {
        if (!onFork) return;
        uint256 collected;
        uint256 full = (uint256(1) << TRAIT_COUNT) - 1;
        for (uint256 i = 0; i < N_PUNKS && collected != full; i++) {
            uint256 m = masks[i];
            uint16 bestCount = type(uint16).max;
            uint256 best = type(uint256).max;
            for (uint8 b = 0; b < TRAIT_COUNT; b++) {
                if ((m >> b) & 1 == 0) continue;          // not carried
                if ((collected >> b) & 1 == 1) continue;  // already collected
                uint16 c = pc.traitCarrierCount(b);
                if (c < bestCount) {
                    bestCount = c;
                    best = b;
                }
            }
            if (best != type(uint256).max) {
                collected |= (uint256(1) << uint8(best));
            }
        }
        assertEq(collected, full, "rarest-first stranded a trait (Full Set unreachable)");
    }
}
