/* Protocol stats endpoint. Same-origin JSON surface backing the /stats
 * page — the browser polls THIS, never the indexer directly, so the
 * indexer URL stays server-side and upstream load is flat regardless of
 * viewer count (the Data Cache collapses fan-out to ~1 indexer query per
 * window). Mirrors the /api/live-bid pattern.
 *
 * SOURCE — the indexer's `ProtocolCounter` singleton via
 * `fetchProtocolStats()` (one GraphQL query, zero RPC). CACHE —
 * `unstable_cache` (Next Data Cache), shared across server instances and
 * revalidated by time, so N pollers cost one upstream query per window.
 */

import {unstable_cache} from 'next/cache';
import {NextResponse} from 'next/server';

import {fetchProtocolStats, type ProtocolStatsSnapshot} from '@/lib/data/protocolStats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The counters move at trade / auction cadence; a 30s window is invisible
// to a viewer and keeps upstream indexer load flat. Must stay in lockstep
// with `POLL_INTERVAL_MS` in lib/data/useProtocolStats.ts.
const REVALIDATE_SECONDS = 30;

const readCachedStats = unstable_cache(
    async (): Promise<ProtocolStatsSnapshot> => fetchProtocolStats(),
    ['protocol-stats:snapshot'],
    {revalidate: REVALIDATE_SECONDS, tags: ['protocol-stats']},
);

export async function GET() {
    // fetchProtocolStats never throws on an OUTAGE (it returns
    // {ok: false, reachable: false} for an unreachable indexer), so a normal
    // response always carries a usable shape — the client renders the
    // degraded state off `reachable: false`. A misconfigured deploy (live
    // protocol with no INDEXER_URL) throws by design and 500s this route.
    const snapshot = await readCachedStats();
    return NextResponse.json(snapshot, {headers: {'cache-control': 'no-store'}});
}
