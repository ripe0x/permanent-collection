/* Eligible-Punk counting, shared by the live/fork/mock adapters.
 *
 * A Punk is eligible to accept the live bid when it carries at least one
 * trait that is neither collected nor pending (`mask & ~(collected|pending)`
 * has a set bit) AND it isn't already in protocol custody — a Punk in an
 * unsettled return auction or in the vault can't be acquired again. A
 * previously-rescued (ReturnedToMarket) Punk IS eligible again, so settled
 * cleared auctions don't block.
 *
 * Pure function over the static 10,000-mask dataset: ~10k bigint ANDs,
 * single-digit milliseconds, no chain reads. Callers source the masks and
 * the blocked-Punk set from whatever state backend they have (indexer,
 * chain, fixtures).
 */

import {PUNK_MASKS} from '@/lib/punkMasks';

export function countEligiblePunks(
    collectedMask: bigint,
    pendingMask: bigint,
    blockedPunkIds: Iterable<number>,
): number {
    const blockedBits = collectedMask | pendingMask;
    const blockedPunks = new Set(blockedPunkIds);
    let count = 0;
    for (let punkId = 0; punkId < PUNK_MASKS.length; punkId++) {
        if (blockedPunks.has(punkId)) continue;
        if ((PUNK_MASKS[punkId] & ~blockedBits) !== 0n) count++;
    }
    return count;
}

/** Build a trait bitmask from a list of trait ids (0..110). */
export function maskFromTraitIds(traitIds: Iterable<number>): bigint {
    let mask = 0n;
    for (const id of traitIds) mask |= 1n << BigInt(id);
    return mask;
}
