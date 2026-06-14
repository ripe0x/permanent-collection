'use client';

/* Shared react-query hook for an active return auction's bid list.
 *
 * Reads `/api/auction-bids?punkId=N` — a server-cached endpoint backed by the
 * Ponder indexer's `Bid` table. Keyed on `['auction-bids', punkId]` so every
 * consumer on the page (the live "current bid" stat and the bid-history list)
 * shares ONE fetch + cache entry. The connected bidder's own bid invalidates
 * this key from PlaceBidPanel's onSuccess so the current bid updates the moment
 * their tx confirms; a 30s poll catches everyone else's bids.
 */

import {useQuery} from '@tanstack/react-query';
import type {Hex} from 'viem';

export interface BidEntry {
    bidder: string;
    amount: bigint;
    blockNumber: bigint;
    timestamp: bigint;
    txHash: Hex;
}

interface WireBid {
    bidder: string;
    amount: string;
    blockNumber: string;
    timestamp: string;
    txHash: string;
}

/** react-query key for an auction's bid list. Exported so callers can
 *  invalidate it (e.g. on the viewer's own successful bid). */
export function auctionBidsKey(punkId: number): readonly [string, number] {
    return ['auction-bids', punkId];
}

export function useAuctionBids(punkId: number) {
    return useQuery({
        queryKey: auctionBidsKey(punkId),
        queryFn: async (): Promise<BidEntry[]> => {
            const res = await fetch(`/api/auction-bids?punkId=${punkId}`, {
                cache: 'no-store',
            });
            if (!res.ok) {
                throw new Error(`auction-bids: HTTP ${res.status}`);
            }
            const json = (await res.json()) as {bids: WireBid[]};
            return json.bids.map((b) => ({
                bidder: b.bidder,
                amount: BigInt(b.amount),
                blockNumber: BigInt(b.blockNumber),
                timestamp: BigInt(b.timestamp),
                txHash: b.txHash as Hex,
            }));
        },
        // Light client poll so a viewer sees other people's bids without
        // reloading. Server-side cache + POST-tag-bust on the bidder's OWN
        // bid keep upstream cost flat regardless of viewer count.
        refetchInterval: 30_000,
        staleTime: 15_000,
    });
}
