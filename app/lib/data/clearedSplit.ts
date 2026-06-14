// Cleared-return-auction split.
//
// When a return auction CLEARS (the Punk is returned to circulation), the
// winning bid is split three ways on-chain in `ReturnAuctionModule.settle`:
//   - `liveBidWei`  — the cost share that refills the live bid (→ Patron via
//                     the live-bid adapter), stored as `bountyShareWei`;
//   - `buyBurnWei`  — the cost share bought-and-burned immediately
//                     (→ BuybackBurner), stored as `burnShareWei`; and
//   - `vaultBurnWei`— the remainder routed to the vault-burn pool, which buys
//                     and burns later (`finalBid − liveBidShare − burnShare`).
//
// Vaulted (silenced) settles redistribute no per-cost split, so these
// allocations exist only for cleared auctions.

import type {Hex, PunkProvenanceEvent, TraitId} from './types';

export interface ClearedSplit {
    /** Cost share that refills the live bid (`bountyShareWei`). */
    liveBidWei?: bigint;
    /** Cost share bought-and-burned immediately (`burnShareWei`). */
    buyBurnWei?: bigint;
    /** Remainder routed to the vault-burn pool, burned later. */
    vaultBurnWei?: bigint;
}

/** Derive the three allocations from a cleared auction's event-sourced split.
 *  Returns `null` when the source lacks the split (legacy / fork edge rows
 *  where the shares were never indexed) so callers render nothing rather than
 *  a fabricated zero. */
export function computeClearedSplit(args: {
    finalBidWei: bigint;
    liveBidShareWei?: bigint;
    burnShareWei?: bigint;
}): ClearedSplit | null {
    const {finalBidWei, liveBidShareWei, burnShareWei} = args;
    const liveBidWei = liveBidShareWei ?? undefined;
    const buyBurnWei = burnShareWei ?? undefined;
    // The vault-burn leg is the residual after the live-bid + buy-burn shares,
    // so it needs both to be present (and to actually leave a remainder).
    const vaultBurnWei =
        liveBidShareWei != null &&
        burnShareWei != null &&
        finalBidWei > liveBidShareWei + burnShareWei
            ? finalBidWei - liveBidShareWei - burnShareWei
            : undefined;
    if (liveBidWei === undefined && buyBurnWei === undefined && vaultBurnWei === undefined) {
        return null;
    }
    return {liveBidWei, buyBurnWei, vaultBurnWei};
}

/** Build the cleared-path settlement rows (live-bid refill, token buy+burn,
 *  then vault burn). All carry the settle event's timestamp + tx so a stable
 *  newest-first sort lands them directly beneath the `returned` row they
 *  describe, in the same order as the distribution panel. */
export function clearedSplitProvenanceEvents(args: {
    finalBidWei: bigint;
    liveBidShareWei?: bigint;
    burnShareWei?: bigint;
    traitId?: TraitId;
    timestamp: bigint;
    txHash?: Hex;
}): PunkProvenanceEvent[] {
    const split = computeClearedSplit(args);
    if (!split) return [];
    const out: PunkProvenanceEvent[] = [];
    const base = {
        source: 'protocol' as const,
        traitId: args.traitId,
        timestamp: args.timestamp,
        txHash: args.txHash,
    };
    if (split.liveBidWei !== undefined) {
        out.push({kind: 'bidRefill', amountWei: split.liveBidWei, ...base});
    }
    if (split.buyBurnWei !== undefined) {
        out.push({kind: 'tokenBuyBurn', amountWei: split.buyBurnWei, ...base});
    }
    if (split.vaultBurnWei !== undefined) {
        out.push({kind: 'tokenBurn', amountWei: split.vaultBurnWei, ...base});
    }
    return out;
}
