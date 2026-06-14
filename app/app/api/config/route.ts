import {NextResponse} from 'next/server';
import {getAddress, isAddress} from 'viem';

/**
 * Public runtime config endpoint. Returns settings the frontend needs at
 * runtime but that the operator wants to be able to change without
 * triggering a frontend rebuild.
 *
 * Currently surfaces:
 *   - `defaultReferrer` — the address credited as the swap referrer when
 *     the visitor has no `?ref=0x...` in the URL and no prior stored
 *     value. Sourced from the server-only `DEFAULT_REFERRER` env var,
 *     falling back to the hard-coded team address (`TEAM_REFERRER`) so
 *     the referral slice routes to the team by default rather than
 *     staying in the pool's protocol leg.
 *
 * The endpoint is intentionally TINY so it's cheap to fetch on every
 * page load. We set a 60s cache header so the CDN absorbs the load.
 *
 * To change the default referrer at runtime: update the `DEFAULT_REFERRER`
 * env var on the host (Vercel/Netlify/etc.) and trigger a redeploy of
 * the runtime config (no frontend rebuild needed — the deployment
 * platform restarts the Node runtime, which is sub-second). On Vercel
 * specifically, env-var changes are picked up by the next request.
 */
export const runtime = 'nodejs';

/**
 * Team referrer address — the protocol payout recipient
 * (`PAYOUT_RECIPIENT_DEFAULT` in `contracts/script/Deploy.s.sol`). Used as
 * the swap referrer by default so the referral fee slice routes to the
 * team rather than staying in the pool's protocol leg. Override at runtime
 * with the `DEFAULT_REFERRER` env var (no rebuild needed).
 */
const TEAM_REFERRER = '0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4';

function parseAddress(raw: string | undefined): `0x${string}` | null {
    if (!raw) return null;
    if (!isAddress(raw, {strict: false})) return null;
    try {
        const checksummed = getAddress(raw);
        if (checksummed === '0x0000000000000000000000000000000000000000') return null;
        return checksummed;
    } catch {
        return null;
    }
}

export async function GET() {
    const defaultReferrer =
        parseAddress(process.env.DEFAULT_REFERRER) ?? parseAddress(TEAM_REFERRER);
    return NextResponse.json(
        {defaultReferrer},
        {
            headers: {
                // Edge cache 60s, stale-while-revalidate another 5min.
                // Trades off "how fast does an operator's env-var change
                // propagate" against "do not hammer the edge function".
                'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
            },
        },
    );
}
