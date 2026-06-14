// Cached per-Punk bid history for /auction/[punkId]. Replaces the previous
// per-viewer `getLogs` call in AuctionBidHistory.tsx — which fanned out one
// chain read per page open, scaled with viewers, not bids.
//
// SOURCE — the Ponder indexer's `Bid` table (populated by the
// `ReturnAuctionModule:ReturnAuctionBid` handler in indexer/src/index.ts).
// `getDataAdapter().getReturnAuctionBids(punkId)` does the GraphQL read on the
// live adapter; the fork adapter still goes chain-direct for the local
// dev loop.
//
// CACHE — `unstable_cache` keyed by punkId so two viewers of the same
// auction share a single indexer hit. `revalidate` matches the client-
// side 30s poll in AuctionBidHistory so a polling viewer hits a warm
// cache most cycles; a fresh bid by the connected wallet busts the
// cache via the POST handler so the bidder sees their tx land
// immediately.

import {revalidateTag, unstable_cache} from 'next/cache';
import {NextResponse} from 'next/server';

import {getDataAdapter} from '@/lib/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Aligned with the client-side 30s poll in AuctionBidHistory.tsx. Was 15s
// — half-life meant ~50% of polls missed cache and triggered a fresh
// indexer hit.
const REVALIDATE_SECONDS = 30;

const readCachedBids = unstable_cache(
    async (punkId: number) => {
        const bids = await getDataAdapter().getReturnAuctionBids(punkId);
        return bids.map((b) => ({
            bidder: b.bidder,
            amount: b.amount.toString(),
            blockNumber: b.blockNumber.toString(),
            timestamp: b.timestamp.toString(),
            txHash: b.txHash,
        }));
    },
    ['auction-bids'],
    {revalidate: REVALIDATE_SECONDS, tags: ['auction-bids']},
);

function parsePunkId(req: Request): number | null {
    const url = new URL(req.url);
    const raw = url.searchParams.get('punkId');
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 9999) return null;
    return n;
}

export async function GET(req: Request) {
    const punkId = parsePunkId(req);
    if (punkId === null) {
        return NextResponse.json({error: 'invalid punkId'}, {status: 400});
    }
    try {
        const bids = await readCachedBids(punkId);
        return NextResponse.json(
            {bids},
            {headers: {'cache-control': 'no-store'}},
        );
    } catch {
        return NextResponse.json({bids: [], error: 'auction-bids unavailable'}, {status: 503});
    }
}

// Fired by the bid panel right after the connected wallet's OWN bid
// confirms: busts the per-Punk cache so this viewer (and everyone's next
// poll) sees the post-bid history immediately instead of waiting out the
// TTL. Bounded to user-initiated bids — upstream reads still scale with
// bids, not viewers. The whole `auction-bids` tag is invalidated rather
// than per-punkId because unstable_cache scopes tags at registration time;
// the resulting extra indexer hit per non-bid Punk on the next poll is
// negligible relative to the savings.
export async function POST() {
    revalidateTag('auction-bids');
    return NextResponse.json({revalidated: true});
}
