// Bid history for the vault Title Auction. Polled once a minute by
// `TitleBidHistory` on the client side so visitors landing during an
// active round see fresh bids without a hard reload. Goes through the
// active data adapter so the same code path serves live + fork + mock.
//
// Cached via `unstable_cache` — N concurrent viewers of /title collapse
// to ~1 indexer hit per cache window upstream. Previously uncached:
// every viewer's poll triggered a fresh GraphQL request. The connected
// wallet's own bid busts the shared cache via the POST handler so the
// bidder sees their tx land immediately.
//
// The returned amounts/timestamps are decimal strings (bigint isn't
// JSON-serializable). The client re-parses with BigInt.

import {revalidateTag, unstable_cache} from 'next/cache';
import {NextResponse} from 'next/server';
import {getDataAdapter} from '@/lib/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Half the client-side 60s poll so a polling viewer hits a warm cache
// most cycles; the swapper/bidder still sees fresh data via the POST.
const REVALIDATE_SECONDS = 30;
const CACHE_TAG = 'title-auction-bids';

const readCachedBids = unstable_cache(
    async () => {
        const bids = await getDataAdapter().getTitleAuctionBids();
        return bids.map((b) => ({
            bidder: b.bidder,
            amount: b.amount.toString(),
            endsAt: b.endsAt.toString(),
            extended: b.extended,
            blockNumber: b.blockNumber.toString(),
            timestamp: b.timestamp.toString(),
            txHash: b.txHash,
        }));
    },
    ['title-auction:bids'],
    {revalidate: REVALIDATE_SECONDS, tags: [CACHE_TAG]},
);

export async function GET() {
    try {
        const bids = await readCachedBids();
        return NextResponse.json({bids}, {headers: {'cache-control': 'no-store'}});
    } catch {
        return NextResponse.json({bids: []}, {status: 503});
    }
}

// Fired by TitleBidPanel right after the connected wallet's own bid
// confirms: busts the shared cache so this bidder (and everyone's next
// poll) sees the new bid immediately instead of waiting out the TTL.
// Bounded to user-initiated bids — upstream reads still scale with
// bids, not viewers.
export async function POST() {
    revalidateTag(CACHE_TAG);
    return NextResponse.json({revalidated: true});
}
