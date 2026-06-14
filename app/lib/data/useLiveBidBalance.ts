'use client';

/* Shared hook for the protocol's live bid — the "live bid" =
 * `Patron.bidBalance()`, native ETH.
 *
 * Reads from our own cached API endpoint `/api/live-bid` (NOT the chain
 * per-client) on a short poll, so the bid stays live for EVERY viewer —
 * reflecting everyone's trades, not just the connected wallet's own swap —
 * while upstream chain reads stay flat no matter how many tabs are open (the
 * endpoint caches; see `app/app/api/live-bid/route.ts`). Fork and mainnet
 * behave identically — both poll the API; no chainId special-case.
 *
 * Both `<LiveBidStat />` (read) and the SwapBox post-swap path (refetch) call
 * this hook, so they share one react-query entry (keyed by `LIVE_BID_QUERY_KEY`).
 *
 * `refetch` (fired by SwapBox after the wallet's OWN swap) first busts the
 * endpoint's shared cache so the swapper sees their just-confirmed trade
 * immediately, then pulls fresh; the interval poll keeps everyone else in sync.
 *
 * `isStale` is true while a fetch is in flight — callers render a subtle
 * "syncing" state without blanking the last value.
 */

import {useQuery} from '@tanstack/react-query';
import {useCallback} from 'react';

export interface UseLiveBidBalanceReturn {
    /** Patron's standing bidBalance (the big "live bid" number). */
    value: bigint | undefined;
    /** In-flight fee ETH not yet at Patron — the LiveBidAdapter (the bid leg)
     *  balance. It's the only fee leg that funds the live bid; the protocol leg
     *  sweeps to PCController and never reaches it. Surfaced as the smaller
     *  "+X ETH pending" counter below the live bid. */
    pending: bigint | undefined;
    /** Always 0 — the protocol leg sweeps to PCController and is never
     *  bid-bound. Retained for client back-compat; the sweep affordance reads
     *  it and, seeing 0, fires only the bid-leg sweep. */
    protocolLegPending: bigint | undefined;
    isStale: boolean;
    refetch: () => Promise<unknown>;
}

const LIVE_BID_QUERY_KEY = ['live-bid'] as const;
// Aligned to mainnet block time (~12s). `bidBalance` only moves when a
// block is mined, so polling sub-block-time is wasted work — the
// /api/live-bid endpoint's cache TTL matches this exactly. Each cache
// miss fans out 2 RPC reads (bidBalance + the bid adapter's balance); at
// 12s that's well under 1 RPC read/sec regardless of viewer count (the
// cache absorbs fan-out). The swap-confirm path busts the cache +
// manually refetches, so a swapper still sees their own tx land
// immediately.
const POLL_INTERVAL_MS = 12_000;

interface LiveBidSnapshot {
    liveBid: bigint;
    pending: bigint;
    protocolLegPending: bigint;
}

async function fetchLiveBidSnapshot(): Promise<LiveBidSnapshot> {
    const res = await fetch('/api/live-bid', {cache: 'no-store'});
    if (!res.ok) throw new Error(`live-bid: HTTP ${res.status}`);
    const json = (await res.json()) as {
        liveBidWei?: unknown;
        pendingWei?: unknown;
        protocolLegPendingWei?: unknown;
    };
    if (typeof json.liveBidWei !== 'string') {
        throw new Error('live-bid: malformed response');
    }
    // `pendingWei` / `protocolLegPendingWei` are newer in the response shape —
    // tolerate them missing (back-compat) by defaulting to 0; an older endpoint
    // or a transient 503-cached body just shows no pending counter rather than
    // crashing.
    const pendingStr = typeof json.pendingWei === 'string' ? json.pendingWei : '0';
    const protocolLegStr =
        typeof json.protocolLegPendingWei === 'string' ? json.protocolLegPendingWei : '0';
    return {
        liveBid: BigInt(json.liveBidWei),
        pending: BigInt(pendingStr),
        protocolLegPending: BigInt(protocolLegStr),
    };
}

export function useLiveBidBalance(): UseLiveBidBalanceReturn {
    const {
        data,
        isFetching,
        refetch: queryRefetch,
    } = useQuery({
        queryKey: LIVE_BID_QUERY_KEY,
        queryFn: fetchLiveBidSnapshot,
        // Poll so the bid reflects ANY trade within a few seconds, for every
        // viewer. The cost is flat: clients poll our cached endpoint, which
        // collapses to ~1 chain read per window upstream.
        refetchInterval: POLL_INTERVAL_MS,
        staleTime: POLL_INTERVAL_MS,
        gcTime: 30 * 60 * 1000,
        refetchOnWindowFocus: true,
    });

    const refetch = useCallback(async () => {
        // Bust the endpoint's shared cache first so this read reflects the
        // just-confirmed swap (not the up-to-window-stale cached value), then
        // pull fresh. Bounded to user-initiated swaps — not polling — so
        // upstream reads still scale with swaps, not viewers.
        try {
            await fetch('/api/live-bid', {method: 'POST'});
        } catch {
            // Best-effort; the interval poll will reconcile regardless.
        }
        return queryRefetch();
    }, [queryRefetch]);

    return {
        value: data?.liveBid,
        pending: data?.pending,
        protocolLegPending: data?.protocolLegPending,
        isStale: isFetching,
        refetch,
    };
}
