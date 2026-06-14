// Trait rarity helpers, backed by the static `RARITY` table snapshotted from
// PunksData (see scripts/snapshot-punksdata.ts). RARITY[bit] is the number of
// Punks (out of 10,000) that carry that trait — lower is rarer. The dataset
// is sealed (datasetHash pinned in PermanentCollection), so these counts never
// change; we read them from the committed snapshot rather than recomputing on
// chain.
//
// SERVER-SIDE ONLY in practice: importing `RARITY` pulls from `punkMasks.ts`,
// which also exports the 10k-entry `PUNK_MASKS` array (~300KB). Keep this
// module's importers to server code (the data adapters) so that bulk never
// reaches the client bundle.
import {RARITY} from '@/lib/punkMasks';

// Few-carrier tier classifier. Lives in its own data-free module so client
// components can import it without the heavy RARITY/PUNK_MASKS snapshot;
// re-exported here for server callers that already hold the table.
export {
    classifyCarrierTier,
    FEW_CARRIER_MAX,
    type CarrierTier,
    type CarrierTierInfo,
} from '@/lib/carrierTier';

/** On-chain carrier count for a trait bit (lower = rarer). Unknown bits sort
 *  last via a large sentinel rather than 0 (which would mis-rank them rarest). */
export function carrierCount(bit: number): number {
    return RARITY[bit] ?? Number.MAX_SAFE_INTEGER;
}

/** Order trait bits rarest-first: ascending carrier count, breaking ties by
 *  bit index for determinism. Pure — returns a new array, never mutates the
 *  input. The sole carrier of a trait (carrier count 1) always sorts first,
 *  which is why #8348's bit-23 ("7 Attributes") naturally becomes the default
 *  target even before the sole-carrier guard is consulted. */
export function rarestFirst(bits: readonly number[]): number[] {
    return [...bits].sort((a, b) => carrierCount(a) - carrierCount(b) || a - b);
}

/** The protocol-derived target trait for a Punk: the RAREST uncollected,
 *  non-pending trait it carries, ties broken by the lowest bit index. This is
 *  the byte-identical client mirror of `PermanentCollection.canonicalTargetOf`
 *  — the target is no longer caller-chosen, so the UI passes exactly this value
 *  to `acceptBid` / `acceptListing`. Returns `undefined` when no eligible bit
 *  remains (every trait the Punk carries is already permanent or pending); the
 *  on-chain call reverts `NoEligibleTarget` in that case.
 *
 *  `uncollectedBits` is the Punk's bits that are NOT in `collectedMask`;
 *  `pendingBits` is the subset of those with an in-flight return auction. The
 *  canonical target is the rarest of (uncollected MINUS pending). The
 *  `carrierCount`-1 sole carrier (#8348 / bit 23) floats to the front by rarity
 *  alone, so this also satisfies the sole-carrier guard without special-casing. */
export function canonicalTarget(
    uncollectedBits: readonly number[],
    pendingBits: readonly number[],
): number | undefined {
    const pending = new Set(pendingBits);
    const eligible = uncollectedBits.filter((b) => !pending.has(b));
    if (eligible.length === 0) return undefined;
    return rarestFirst(eligible)[0];
}
