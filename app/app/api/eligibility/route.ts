import {NextResponse} from 'next/server';
import {getDataAdapter} from '@/lib/data';
import {renderPunkTileContent, renderTraitTileForPunk} from '@/lib/trait-tile';
import type {Address} from '@/lib/data/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    const u = new URL(req.url);
    const punkIdRaw = u.searchParams.get('punkId');
    const callerRaw = u.searchParams.get('caller');
    const punkId = Number.parseInt(punkIdRaw ?? '', 10);

    if (!Number.isInteger(punkId) || punkId < 0 || punkId > 9999) {
        return NextResponse.json({error: 'punkId must be an integer in 0..9999'}, {status: 400});
    }
    const caller = callerRaw && /^0x[0-9a-fA-F]{40}$/.test(callerRaw) ? (callerRaw as Address) : undefined;

    try {
        const e = await getDataAdapter().getPunkEligibility(punkId, caller);
        // Pre-render the visuals the accept-the-bid step 2/3 surface needs:
        //   - punkSvgInner: the picked Punk's silhouette for the context strip
        //   - traitTilesByBit: each uncollected trait tile rendered with the
        //     picked Punk's actual pixels (not a canonical exemplar), so the
        //     picker shows the user *their* mohawk on *their* Punk.
        // Doing this server-side keeps the punks-sdk pixel bundle off the
        // client and means step 2 has the visuals ready the moment the user
        // crosses from step 1.
        const punkSvgInner = renderPunkTileContent(punkId);
        const traitTilesByBit: Record<number, string> = {};
        for (const bit of e.uncollectedBits) {
            traitTilesByBit[bit] = renderTraitTileForPunk(bit, punkId);
        }
        return NextResponse.json({
            ...e,
            mask: e.mask.toString(),
            punkSvgInner,
            traitTilesByBit,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({error: msg}, {status: 500});
    }
}
