// Few-carrier tier classifier for acceptance-target traits.
//
// Pure and data-free on purpose: it takes the `carrierCount` + `group` that
// the data adapters already compute (from the RARITY table) and pass through
// on `TraitOption` / `ListedTraitOption`, so it can be imported by client
// components WITHOUT dragging the ~300KB `RARITY` / `PUNK_MASKS` snapshot into
// the browser bundle. `lib/rarity.ts` re-exports it for server callers that
// already hold the heavy table.
//
// Background: the on-chain protocol guards only the single rarity-1 pair
// (the unique carrier of "7 Attributes", carrierCount 1) with a hard target
// constraint. The next-rarest traits have no on-chain mechanic guard, so a
// silenced vaulting against a common target permanently forgoes one of their
// scarce slots. This classifier flags that tier for a non-blocking UI warning.
//
//   Few-carrier tier (more than one carrier, at most FEW_CARRIER_MAX):
//     0 Attributes (8), Alien type (9), Alien head (9),
//     6 Attributes (11), Ape type (24), Ape head (24).
//
//   Doubly-rare clusters (Alien / Ape): the type bit and the head bit share
//   the same carriers, so a single Alien or Ape Punk is the only way to bring
//   in BOTH its type slot and its head slot. Spending one of those Punks on a
//   common target burns two scarce slots at once, not one. Any `normalizedType`
//   or `headVariant` trait inside the few-carrier band is necessarily Alien or
//   Ape (every Female / Male / Zombie type and head has hundreds to thousands
//   of carriers), so the group test alone isolates the doubly-rare set.

import type {TraitGroup} from '@/lib/data/types';

/** Inclusive upper bound (in carriers out of 10,000) for the few-carrier tier.
 *  Set at Ape's 24 so the band is exactly {0 Attributes, Alien, 6 Attributes,
 *  Ape}; the next trait up (Zombie, 88) sits well clear. The sole-carrier
 *  (carrierCount 1) is excluded: it has its own on-chain guard and its own
 *  "only carrier" affirmation in the UI. */
export const FEW_CARRIER_MAX = 24;

/** How scarce the chosen acceptance target is. `sole` = the on-chain-guarded
 *  unique carrier; `few` = the unguarded few-carrier tier; `common` =
 *  everything else (no warning needed). */
export type CarrierTier = 'sole' | 'few' | 'common';

export interface CarrierTierInfo {
    tier: CarrierTier;
    /** True only for the Alien / Ape clusters, where type and head share
     *  carriers so a wrong target forgoes two scarce slots, not one. */
    doublyRare: boolean;
}

/** Classify an acceptance target by how many Punks carry it (and which trait
 *  group it belongs to, to flag the doubly-rare Alien / Ape clusters). Pure:
 *  no I/O, no data import, deterministic on its arguments. */
export function classifyCarrierTier(
    carrierCount: number,
    group: TraitGroup,
): CarrierTierInfo {
    if (carrierCount <= 1) return {tier: 'sole', doublyRare: false};
    if (carrierCount <= FEW_CARRIER_MAX) {
        const doublyRare = group === 'normalizedType' || group === 'headVariant';
        return {tier: 'few', doublyRare};
    }
    return {tier: 'common', doublyRare: false};
}
