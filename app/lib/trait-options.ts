// Trait-first aggregation: invert a set of Punks into the traits they can
// validly make permanent. Shared by all three data adapters so the
// owned-Punk (acceptBid) and listed-Punk (acceptListing) flows agree exactly.
//
// The sole-carrier guard (hard invariant #22) lives HERE, in the data: a Punk
// that is the unique carrier of an uncollected trait can only ever deliver
// that trait, so it contributes to that trait alone and never appears under a
// common trait it would strand. The trait-first UI therefore cannot pre-select
// a (trait, Punk) pairing that the contract would revert — the warning the
// punk-first flow needed mostly evaporates because the structure is correct by
// construction.
//
// Pure (no I/O): the adapters gather per-Punk masks + sole-carrier constraints
// their own way (multicall on chain, fixtures in mock) and hand them here.
import {CATEGORIES} from '@/lib/categories';
import {carrierCount} from '@/lib/rarity';
import type {
    ListedTraitListing,
    ListedTraitOption,
    PunkStrategyListing,
    SoleCarrierConstraint,
    TraitGroup,
    TraitOption,
} from '@/lib/data/types';

/** Per-Punk input to the aggregation. */
export interface TraitOptionEntry {
    punkId: number;
    /** PunksData trait bitmask for the Punk. */
    mask: bigint;
    /** Sole-carrier constraint for the Punk (hard invariant #22). */
    soleCarrier: SoleCarrierConstraint;
}

const GROUP_FALLBACK: TraitGroup = 'accessory';

/** Build the rarest-first list of selectable traits from a set of Punks.
 *
 *  A trait bit is offered for a Punk when it is set on the Punk's mask, NOT in
 *  `collectedMask`, and NOT in `pendingBits`. A Punk with
 *  `soleCarrier.required` contributes to its `requiredTraitId` only. Result is
 *  ordered rarest-first (ascending carrier count, ties by traitId). */
export function buildTraitOptions(
    entries: readonly TraitOptionEntry[],
    collectedMask: bigint,
    pendingBits: ReadonlySet<number>,
): TraitOption[] {
    const traitToPunks = new Map<number, number[]>();
    const offer = (bit: number, punkId: number) => {
        const arr = traitToPunks.get(bit);
        if (!arr) traitToPunks.set(bit, [punkId]);
        else if (!arr.includes(punkId)) arr.push(punkId);
    };
    const isOffered = (mask: bigint, bit: number): boolean => {
        const b = BigInt(bit);
        return (
            ((mask >> b) & 1n) === 1n &&
            ((collectedMask >> b) & 1n) === 0n &&
            !pendingBits.has(bit)
        );
    };

    for (const {punkId, mask, soleCarrier} of entries) {
        if (soleCarrier.required) {
            // Reserved: this Punk can only target its required trait, so it is
            // the sole contributor (or not offered at all if that trait became
            // collected/pending).
            if (isOffered(mask, soleCarrier.requiredTraitId)) {
                offer(soleCarrier.requiredTraitId, punkId);
            }
            continue;
        }
        for (let bit = 0; bit < 111; bit++) {
            if (isOffered(mask, bit)) offer(bit, punkId);
        }
    }

    const options: TraitOption[] = [];
    for (const [traitId, punkIds] of traitToPunks) {
        const count = carrierCount(traitId);
        options.push({
            traitId,
            carrierCount: count,
            group: (CATEGORIES[traitId]?.group as TraitGroup | undefined) ?? GROUP_FALLBACK,
            punkIds: punkIds.sort((a, b) => a - b),
            uniqueCarrier: count === 1,
        });
    }
    return options.sort((a, b) => a.carrierCount - b.carrierCount || a.traitId - b.traitId);
}

/** Invert public listings into the traits they can make permanent, rarest-
 *  first, each with the listed Punks that can deliver it (cheapest-first).
 *
 *  Each listing contributes to EXACTLY ONE group — its protocol-derived
 *  canonical target (`suggestedTraitId`, the rarest uncollected non-pending
 *  trait it carries, or the sole-carrier-required trait). The on-chain target
 *  is no longer caller-chosen: `acceptListing` reverts `NotCanonicalTarget` for
 *  anything but `canonicalTargetOf(punkId)`, so listing a Punk under its other
 *  eligible traits would only offer reverting actions. Grouping by the
 *  canonical target keeps every row's `traitId` equal to the value
 *  `acceptListing` requires. Pure; the per-listing eligibility (price ≤ bid,
 *  active seller, uncollected + non-pending) was already applied upstream in
 *  `getPunkStrategyListings`, where `suggestedTraitId` is computed. */
export function buildListedTraitOptions(
    listings: readonly PunkStrategyListing[],
): ListedTraitOption[] {
    const byTrait = new Map<number, ListedTraitListing[]>();
    for (const l of listings) {
        // The canonical (sole acceptable) target: the sole-carrier-required
        // trait when constrained, else the rarest eligible trait. Defence in
        // depth: skip any listing whose canonical target isn't genuinely
        // eligible (e.g. a stale sole-carrier hint).
        const canonical = l.soleCarrier.required ? l.soleCarrier.requiredTraitId : l.suggestedTraitId;
        if (!l.eligibleTraitIds.includes(canonical)) continue;
        const entry: ListedTraitListing = {
            punkId: l.punkId,
            seller: l.seller,
            minValueWei: l.minValueWei,
            finderFeeWei: l.finderFeeWei,
            bountyCostWei: l.bountyCostWei,
            listedAt: l.listedAt,
        };
        const arr = byTrait.get(canonical);
        if (!arr) byTrait.set(canonical, [entry]);
        else arr.push(entry);
    }

    const out: ListedTraitOption[] = [];
    for (const [traitId, ls] of byTrait) {
        const count = carrierCount(traitId);
        out.push({
            traitId,
            carrierCount: count,
            group: (CATEGORIES[traitId]?.group as TraitGroup | undefined) ?? GROUP_FALLBACK,
            uniqueCarrier: count === 1,
            listings: ls.sort((a, b) => (a.minValueWei < b.minValueWei ? -1 : 1)),
        });
    }
    return out.sort((a, b) => a.carrierCount - b.carrierCount || a.traitId - b.traitId);
}
