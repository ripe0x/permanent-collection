// Cached, shared read of the protocol's live bid — the "live bid" =
// `Patron.bidBalance()`, native ETH — PLUS the ETH already collected from
// LP fees that's still queued upstream of Patron and will drip in on the next
// sweep ("pending"). EVERY `/trade` viewer polls THIS endpoint instead of
// reading the chain per-client, so upstream load stays flat: N concurrent
// pollers collapse to ~1 chain read per cache window.
//
// `pendingWei` is the in-flight fee that will become live bid on the next
// sweep. Only the bid leg is bid-bound, so only it counts:
//   * `liveBidAdapter` (bid leg): routes to Patron via `sweep()`. Counted.
//   * `protocolFeePhaseAdapter` (protocol leg): a plain forwarder that sweeps
//     to PCController (PC-treasury / LAYER-burn split) from block 1. It NEVER
//     reaches the live bid in any phase, so it is NOT counted here.
//
// `protocolLegPendingWei` is always "0" — the protocol leg is never bid-bound.
// The field is retained in the response shape so older clients don't break;
// the /trade "Sweep now" button reads it and, seeing 0, sweeps only the bid
// adapter.
//
// `pendingWei` is the bid adapter's wei balance. The bid adapter is fed via its
// own `receive()` (the hook's bid leg + the locker's LP-fee share), so it holds
// no escrow slot — its balance IS its pending. LP-position accumulated fees
// aren't counted — they haven't been collected into the protocol yet (they're
// not "in the pool" of fees, they're future). Hook ERC6909 claim balance is
// always 0 between swaps (same-tx flush).
//
// SOURCE — chain-read + cache. The Ponder indexer tracks live-bid inflow
// *events* (still typed `totalBountyInflowsWei` in the indexer schema, pre-
// rename), but NOT the current balance (which also falls on payouts) and it
// lags the chain by an indexed block — so the headline number must come
// straight from chain. This matches `lib/data/live.ts`, which reads
// `liveBidWei` from chain for the same reason.
//
// CACHE — `unstable_cache` stores the read in Next's Data Cache, which is
// shared across server instances and revalidated by time. A module-level
// variable would NOT work: on serverless each lambda has its own module scope,
// so it yields one read per instance and scales with traffic. The Data Cache
// caps upstream reads to ~1 per `revalidate` window regardless of pollers.

import {revalidateTag, unstable_cache} from 'next/cache';
import {NextResponse} from 'next/server';
import {createPublicClient, fallback, http} from 'viem';
import {mainnet} from 'viem/chains';

import {abi as patronAbi} from '@/lib/abis/Patron';
import {getContractAddresses, getRpcUrls} from '@/lib/config';

export const runtime = 'nodejs';
// The route runs per request; upstream dedup happens in the Data Cache below,
// not the route cache — so `force-dynamic` is fine and sidesteps route-cache
// ambiguity. The response itself is not HTTP-cached, so a `revalidateTag`
// (POST, below) takes effect immediately everywhere instead of being shadowed
// by a stale CDN edge entry.
export const dynamic = 'force-dynamic';

// Aligned to mainnet block time. Each cache miss fans out 2 RPC reads;
// a tight TTL would sustain steady reads even with zero chain activity.
// 12s keeps that low without losing any perceived freshness — bidBalance
// only moves when a block is mined.
// The connected wallet's own swap busts the cache via the POST handler,
// so a swapper still sees their post-swap live bid immediately. Must stay
// in lockstep with `POLL_INTERVAL_MS` in lib/data/useLiveBidBalance.ts.
const REVALIDATE_SECONDS = 12;
const CACHE_TAG = 'live-bid';

const readCachedSnapshot = unstable_cache(
    async (): Promise<{liveBidWei: string; pendingWei: string; protocolLegPendingWei: string}> => {
        const addrs = getContractAddresses();
        // Reuse the same server-only upstream(s) as /api/rpc (RPC_URL [+
        // _FALLBACK]). The chain object is just metadata — the transport is
        // RPC_URL, which on the fork is the local anvil. Mirrors lib/data/live.ts.
        const transports = getRpcUrls().map((u) => http(u, {timeout: 30_000}));
        const rpc = createPublicClient({
            chain: mainnet,
            transport: transports.length > 1 ? fallback(transports) : transports[0],
        });
        // Read the live bid + the bid adapter's wei balance in parallel. Only the
        // bid leg is bid-bound — the protocol leg (PFA) forwards to PCController
        // from block 1 and never reaches the live bid, so it isn't read here.
        const [liveBidWei, liveBidAdapterBal] = await Promise.all([
            rpc.readContract({
                address: addrs.patron,
                abi: patronAbi,
                functionName: 'bidBalance',
            }) as Promise<bigint>,
            // The bid adapter is fed via its own receive() (not an escrow claim),
            // so its balance IS its pending — no escrow slot to add.
            rpc.getBalance({address: addrs.liveBidAdapter}),
        ]);
        const pendingWei = liveBidAdapterBal;
        // bigint isn't JSON-serializable (and the Data Cache serializes the
        // return value) — hand back decimal strings; the client re-parses.
        return {
            liveBidWei: liveBidWei.toString(),
            pendingWei: pendingWei.toString(),
            // The protocol leg is never bid-bound, so this is always "0". Kept in
            // the shape so older clients (and the sweep button) don't break.
            protocolLegPendingWei: '0',
        };
    },
    ['live-bid:snapshot'],
    {revalidate: REVALIDATE_SECONDS, tags: [CACHE_TAG]},
);

export async function GET() {
    try {
        const snapshot = await readCachedSnapshot();
        return NextResponse.json(snapshot, {
            headers: {'cache-control': 'no-store'},
        });
    } catch {
        // An upstream hiccup must not blank the live bid — the client keeps its
        // last value / SSR seed on a non-OK response.
        return NextResponse.json({error: 'live-bid unavailable'}, {status: 503});
    }
}

// Fired once after the connected wallet's OWN swap confirms (see
// `useLiveBidBalance.refetch`): busts the shared cache so the swapper — and
// everyone's next poll — sees the post-swap live bid immediately instead of
// waiting out the TTL. Bounded to user-initiated swaps, so upstream reads still
// scale with swaps, not viewers.
export async function POST() {
    revalidateTag(CACHE_TAG);
    return NextResponse.json({revalidated: true});
}
