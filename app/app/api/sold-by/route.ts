// Per-wallet "Punks you've sold to the protocol" history for the /bid page's
// claim section. A seller who accepted the bid, then reloaded the page, has no
// in-component state left to find their withdrawable proceeds — this backs the
// history table + withdraw affordance that closes that gap.
//
// SOURCE — `getRecentAcceptedBids` (the indexer's accepted-bid events on the
// live adapter; chain-direct logs on the fork adapter). We pull a generous
// window and filter to `bidAccepted` events whose `actor` is the seller (for an
// acceptBid the actor IS the seller/lister; `listingAccepted` actor is the
// finder, not the seller, so those are excluded). The withdraw amount itself is
// the aggregate `pendingWithdrawals[seller]` read client-side — the 2017 market
// pools all proceeds into one balance, so it isn't per-Punk.

import {NextResponse} from 'next/server';
import {isAddress, getAddress} from 'viem';

import {getDataAdapter} from '@/lib/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Window of recent accepted bids to scan. Plenty for a fork/dev loop and the
// early protocol; if a single wallet's accept history ever outgrows this, the
// fix is a seller-filtered indexer query, not a bigger scan.
const SCAN_LIMIT = 500;

export async function GET(req: Request) {
    const url = new URL(req.url);
    const raw = url.searchParams.get('seller');
    if (!raw || !isAddress(raw)) {
        return NextResponse.json({error: 'bad or missing seller'}, {status: 400});
    }
    const seller = getAddress(raw);

    try {
        const events = await getDataAdapter().getRecentAcceptedBids(SCAN_LIMIT);
        const sold = events
            .filter((e) => e.kind === 'bidAccepted' && getAddress(e.actor) === seller)
            .map((e) => ({
                punkId: e.punkId,
                amountWei: e.amountWei.toString(),
                blockNumber: e.blockNumber.toString(),
                timestamp: e.timestamp.toString(),
                txHash: e.txHash,
            }));
        return NextResponse.json({sold});
    } catch (err) {
        // Degrade gracefully — the claim section still shows the aggregate
        // pendingWithdrawals (read client-side) even if the history is empty.
        return NextResponse.json(
            {sold: [], error: err instanceof Error ? err.message : 'lookup failed'},
            {status: 200},
        );
    }
}
