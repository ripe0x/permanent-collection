// Cached per-referrer status for the /referral dashboard. Replaces the
// three `useReadContract` polls in ReferralClaim.tsx that fanned out chain
// reads linearly per connected wallet — three reads × every-30s × every
// tab open. Now N viewers per address collapse to ~1 read per cache window.
//
// SOURCE — the Ponder indexer's `Referrer` aggregate table (populated by
// the `ReferralPayout:ReferralCredited` and `:ReferralClaimed` handlers)
// for the headline balance + lifetime totals, plus a chain read for the
// hook's `accruedReferral` (a transient within-swap accrual, state-only with
// no event we could index). Composed in `getDataAdapter().getReferralStatus(addr)`.
//
// CACHE — `unstable_cache` keyed by lowercased address. Mirrors the
// `/api/auction-bids` and `/api/title-auction/bids` pattern. The
// connected wallet busts the cache via POST after its OWN claim or
// flush tx confirms.

import {revalidateTag, unstable_cache} from 'next/cache';
import {NextResponse} from 'next/server';

import {getDataAdapter} from '@/lib/data';
import type {Address} from '@/lib/data/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Half-life relative to the client poll (60s in ReferralClaim post-refactor)
// so a polling viewer hits a warm cache most cycles. Per-address keying
// means the indexer cost scales with unique referrers viewing pages, not
// with tabs.
const REVALIDATE_SECONDS = 30;
const CACHE_TAG = 'referral';

const readCachedStatus = unstable_cache(
    async (addressLc: string) => {
        const status = await getDataAdapter().getReferralStatus(addressLc as Address);
        return {
            referrer: status.referrer,
            balance: status.balance.toString(),
            totalCredited: status.totalCredited.toString(),
            totalClaimed: status.totalClaimed.toString(),
            stuckOnHookWei: status.stuckOnHookWei.toString(),
            lastUpdatedAt: status.lastUpdatedAt?.toString() ?? null,
        };
    },
    ['referral:status'],
    {revalidate: REVALIDATE_SECONDS, tags: [CACHE_TAG]},
);

function parseAddress(req: Request): string | null {
    const url = new URL(req.url);
    const raw = url.searchParams.get('address');
    if (!raw) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
    return raw.toLowerCase();
}

export async function GET(req: Request) {
    const addressLc = parseAddress(req);
    if (!addressLc) {
        return NextResponse.json({error: 'invalid address'}, {status: 400});
    }
    try {
        const status = await readCachedStatus(addressLc);
        return NextResponse.json(status, {headers: {'cache-control': 'no-store'}});
    } catch {
        // A blank response would suggest "no credits ever" — wrong on an
        // indexer hiccup. Surface 503 so the client keeps its last-known
        // value instead of zeroing the UI.
        return NextResponse.json({error: 'referral status unavailable'}, {status: 503});
    }
}

// Fired by ReferralClaim right after the connected wallet's OWN claim tx
// confirms: busts the shared cache so the user sees their post-claim
// balance immediately instead of waiting out the TTL. Bounded to user-
// initiated txs — upstream reads still scale with actions, not viewers.
// The whole tag is invalidated; the next poll for any other address pays
// one extra indexer hit, which is negligible relative to the savings.
export async function POST() {
    revalidateTag(CACHE_TAG);
    return NextResponse.json({revalidated: true});
}
