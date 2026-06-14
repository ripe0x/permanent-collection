'use client';

/* Client hook for the protocol stats grid. Reads our own cached
 * `/api/stats` endpoint (NOT the indexer per-client) on a slow poll, so the
 * numbers stay live for every viewer while upstream indexer load stays flat
 * — the endpoint caches; see `app/app/api/stats/route.ts`.
 *
 * SSR-seeded: the /stats server component fetches once via the shared
 * `fetchProtocolStats()` and hands the result in as `initialData`, so first
 * paint is fully populated and the poll only takes over thereafter (the
 * `<LiveBidStat />` pattern).
 */

import {useQuery} from '@tanstack/react-query';

import type {ProtocolStatsSnapshot} from './protocolStats';

const PROTOCOL_STATS_QUERY_KEY = ['protocol-stats'] as const;
// In lockstep with `REVALIDATE_SECONDS` in app/app/api/stats/route.ts. The
// counters only move on trades / auctions, so polling sub-30s is wasted
// work — the endpoint's cache TTL matches this exactly.
const POLL_INTERVAL_MS = 30_000;

async function fetchSnapshot(): Promise<ProtocolStatsSnapshot> {
    const res = await fetch('/api/stats', {cache: 'no-store'});
    if (!res.ok) throw new Error(`stats: HTTP ${res.status}`);
    return (await res.json()) as ProtocolStatsSnapshot;
}

export function useProtocolStats(initialData: ProtocolStatsSnapshot): ProtocolStatsSnapshot {
    const {data} = useQuery({
        queryKey: PROTOCOL_STATS_QUERY_KEY,
        queryFn: fetchSnapshot,
        initialData,
        refetchInterval: POLL_INTERVAL_MS,
        staleTime: POLL_INTERVAL_MS,
        gcTime: 30 * 60 * 1000,
        refetchOnWindowFocus: true,
    });
    // initialData guarantees `data` is always defined.
    return data;
}
