/**
 * `/api/referral-alias` — vanity-slug alias surface.
 *
 *   GET  ?address=0x…  → { slug: string | null }   (reverse lookup; used by
 *                         the dashboard to show a referrer's vanity link)
 *   POST { action, slug, address? }                 (operator-only write)
 *
 * Writes are operator-curated: there is NO public claiming. POST is gated
 * by a server-only `REFERRAL_ADMIN_TOKEN` compared in constant time against
 * the `x-pc-admin-token` header. If the env var is unset, writes are
 * disabled (401) — a missing token is never an open door.
 *
 * Safety: aliases are cosmetic (see `lib/referral/aliases`). A bad write
 * can at worst point a slug at a different address; it can never misroute
 * on-chain funds, which always follow the resolved address.
 */

import {timingSafeEqual} from 'node:crypto';
import {NextResponse} from 'next/server';

import {removeAlias, setAlias, slugForAddress} from '@/lib/referral/aliases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
    const address = new URL(req.url).searchParams.get('address');
    if (!address) {
        return NextResponse.json({error: 'address required'}, {status: 400});
    }
    const slug = await slugForAddress(address);
    return NextResponse.json(
        {slug},
        {
            headers: {
                // Aliases change rarely; let the edge absorb repeat reads.
                'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
            },
        },
    );
}

/** Constant-time bearer check against the configured admin token. */
function authorized(req: Request): boolean {
    const expected = process.env.REFERRAL_ADMIN_TOKEN;
    if (!expected) return false; // no token configured → writes disabled
    const got = req.headers.get('x-pc-admin-token') ?? '';
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
    if (!authorized(req)) {
        return NextResponse.json({error: 'unauthorized'}, {status: 401});
    }
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({error: 'invalid json'}, {status: 400});
    }
    const b = (body ?? {}) as {action?: unknown; slug?: unknown; address?: unknown};
    const slug = typeof b.slug === 'string' ? b.slug : '';

    if (b.action === 'remove') {
        const r = await removeAlias(slug);
        return NextResponse.json(r, {status: r.ok ? 200 : 400});
    }
    if (b.action === 'set') {
        const address = typeof b.address === 'string' ? b.address : '';
        const r = await setAlias(slug, address);
        return NextResponse.json(r, {status: r.ok ? 200 : 400});
    }
    return NextResponse.json({error: "action must be 'set' or 'remove'"}, {status: 400});
}
