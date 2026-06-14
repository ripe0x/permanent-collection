// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  RotationPool
/// @notice Shared rotation-trait logic for the six "rare type" cells —
///         the three rare NormalizedTypes (Alien, Ape, Zombie) and their
///         matching single-member head variants. Trait ids 0, 1, 4, 5, 6,
///         and 15.
///
///         For these traits, *every* Punk in the dataset carries at least
///         one accessory — there is no on-chain "bare head" to pull.
///         Instead of pinning a single canonical Punk with whatever
///         accessory the artist happened to pick, the uncollected cell
///         rotates per block through all members of the type. The
///         placeholder identity transfers from a specific Punk to the
///         type itself.
///
///         Single source of truth for both the Mosaic renderer's on-the-fly
///         rotation path and TraitIconCache's rotation-aware
///         `buildFragment`. Keeping the pools and rotation algorithm in
///         one library prevents the two contracts from silently drifting on
///         the pool data or the rotation seed.
library RotationPool {
    /// @dev Bitmap of rotation trait ids: bits set for {0, 1, 4, 5, 6, 15}.
    uint256 internal constant ROTATION_TRAIT_MASK = 0x8073;

    /// @dev Rotation pool ids, packed big-endian uint16, sorted ascending.
    ///      Derived from PunksData via `scripts/emit-rotation-pools.ts` and
    ///      frozen at deploy. Sizes: 9 Aliens (18B), 24 Apes (48B), 88
    ///      Zombies (176B); total 242B in this library.
    bytes private constant ALIEN_IDS =
        hex"027b0b4a0c1c0d7316be171117c91d631e7c";
    bytes private constant APE_IDS =
        hex"017403fd085c08c30952099c09bb0a970b6c103c10521170146114c215c916a3"
        hex"18011b031b351c17201b213224312440";
    bytes private constant ZOMBIE_IDS =
        hex"007503db045f04a6055e05c605f6067a06d4075e078f0812085408c909020919"
        hex"0922097809b40a000a060a790a940b7a0b970c8b0d000d410da10da50e190e34"
        hex"0ef7117811a111cf128b12de12f2130a13ca1472148514b314c014d815241571"
        hex"15c5166e168117381883189918a0195b197319ba19f91a301a801b661bd11bd7"
        hex"1c541ca91d221dec1e4c1eea1fbf207320c2211821532169224c229922cd22fd"
        hex"23f324982502264c266e26b526e3270d";

    /// @notice Whether `traitId` is one of the six rotation trait ids.
    ///         Cheap pure check usable as a fast-path gate before pool
    ///         lookups. Accepts `uint16` to match the renderer's call
    ///         sites; the cache's `uint8` traits pass through trivially.
    function isRotation(uint16 traitId) internal pure returns (bool) {
        return traitId < 16 && ((ROTATION_TRAIT_MASK >> traitId) & 1) == 1;
    }

    /// @notice Pick the Punk id this rotation trait displays at the given
    ///         block number. Deterministic per `(traitId, blockNumber)`;
    ///         two readers at the same block always agree, and a future
    ///         block produces an independent pick. Caller MUST first check
    ///         `isRotation(traitId)` — passing a non-rotation id is
    ///         undefined behavior.
    /// @dev    Pool selection: traits 0 and 5 share ALIEN_IDS, 1 and 6
    ///         share APE_IDS, 4 and 15 share ZOMBIE_IDS. Pool length is
    ///         encoded by `bytes.length / 2`.
    function pick(uint16 traitId, uint256 blockNumber) internal pure returns (uint16) {
        bytes memory pool;
        if (traitId == 0 || traitId == 5) {
            pool = ALIEN_IDS;
        } else if (traitId == 1 || traitId == 6) {
            pool = APE_IDS;
        } else {
            // traitId == 4 || traitId == 15 — Zombie pool.
            pool = ZOMBIE_IDS;
        }
        uint256 length = pool.length / 2;
        uint256 idx = uint256(keccak256(abi.encode(blockNumber, traitId))) % length;
        uint256 offset = idx * 2;
        return (uint16(uint8(pool[offset])) << 8) | uint16(uint8(pool[offset + 1]));
    }
}
