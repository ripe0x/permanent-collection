import {NextResponse} from 'next/server';
import {getPunksSdk} from '@/lib/punks-sdk';
import {renderPunkTileContent} from '@/lib/trait-tile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 120;

/**
 * GET /api/punks-with-trait?traitId=N&offset=0&limit=60
 *
 * Returns a page of the Punk ids carrying trait N (ordered rarest-first),
 * each with its pre-rendered tile SVG inner content. Backs the trait
 * gallery's "Load more" so the page can show every matching Punk without
 * shipping the ~2.4 MB punks-sdk pixel bundle to the client or dumping
 * thousands of tiles into one server render. All data is local/in-memory
 * (no RPC, no external API), so paging here is purely a payload bound.
 */
export async function GET(req: Request) {
    const u = new URL(req.url);
    const traitId = Number.parseInt(u.searchParams.get('traitId') ?? '', 10);
    if (!Number.isInteger(traitId) || traitId < 0 || traitId > 110) {
        return NextResponse.json({error: 'traitId must be 0–110'}, {status: 400});
    }
    const offset = Math.max(0, Number.parseInt(u.searchParams.get('offset') ?? '0', 10) || 0);
    const limitRaw = Number.parseInt(u.searchParams.get('limit') ?? '60', 10) || 60;
    const limit = Math.min(MAX_LIMIT, Math.max(1, limitRaw));

    const sdk = getPunksSdk();
    const all = sdk.search({attributes: {required: [traitId]}, sort: 'rarity'});
    const slice = all.slice(offset, offset + limit);
    const svgsByPunkId: Record<number, string> = {};
    for (const id of slice) svgsByPunkId[id] = renderPunkTileContent(id);

    return NextResponse.json({punkIds: slice, svgsByPunkId, total: all.length});
}
