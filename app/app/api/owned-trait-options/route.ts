import {NextResponse} from 'next/server';
import {getDataAdapter} from '@/lib/data';
import {renderPunkTileContent} from '@/lib/trait-tile';
import type {Address} from '@/lib/data/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Acquire view for a connected wallet: the rarest-first trait options across
// the caller's own Punks (acceptBid). The Punk-first UI inverts this to one row
// per Punk with its protocol-derived target (the rarest option a Punk appears
// under = its canonicalTargetOf). Fetched once when /bid loads — not per render
// — so it stays within RPC discipline despite the force-dynamic.
export async function GET(req: Request) {
    const u = new URL(req.url);
    const owner = u.searchParams.get('owner');
    if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
        return NextResponse.json({error: 'owner must be a 0x address'}, {status: 400});
    }

    try {
        const adapter = getDataAdapter();
        const options = await adapter.getOwnedTraitOptions(owner as Address);
        // Pre-render each candidate Punk's silhouette server-side (keeps the
        // punks-sdk pixel bundle off the client) for the Punk picker / context
        // row. Bounded by the wallet's eligible-Punk count.
        const punkSilhouettes: Record<number, string> = {};
        const candidatePunkIds: number[] = [];
        for (const opt of options) {
            for (const pid of opt.punkIds) {
                if (!(pid in punkSilhouettes)) {
                    punkSilhouettes[pid] = renderPunkTileContent(pid);
                    candidatePunkIds.push(pid);
                }
            }
        }
        // Which of these the caller has already listed to Patron — so the picker
        // can mark a Punk that's mid-flow after a reload (one batched read).
        const listedPunkIds = await adapter.getPunksListedToPatron(candidatePunkIds);
        return NextResponse.json({options, punkSilhouettes, listedPunkIds});
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({error: msg}, {status: 500});
    }
}
