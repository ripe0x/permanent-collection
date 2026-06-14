/* Single source of truth for the protocol-wide lifetime counters that back
 * the /stats page. The ONLY code that talks to the indexer for these
 * numbers — both the cached `/api/stats` route (client polls) and the
 * page's SSR seed call through `fetchProtocolStats()`, so there's exactly
 * one query shape + one resilient-fallback path to maintain.
 *
 * These are append-only lifetime totals from the indexer's `ProtocolCounter`
 * singleton — exactly what that row exists to serve, so this is one GraphQL
 * query and ZERO chain reads. (The current live-bid BALANCE is a different
 * number — it falls on payouts — and lives on /trade via the on-chain
 * reader.)
 *
 * Resilience: the query is issued with `totalContributionVolumeWei` first,
 * then retried without it, so callers don't break if the deployed indexer
 * predates that field (added alongside the `contribute()` handler — now on
 * `LiveBidAdapter` under inflow consolidation).
 *
 * Serialization: GraphQL BigInt scalars arrive as decimal strings and are
 * kept as strings end-to-end (Next's Data Cache + the JSON API response
 * can't carry bigint); the client re-parses with BigInt() at format time.
 */

import {isProtocolLive} from '@/lib/config';
import {getIndexerClient, rethrowIfIndexerMisconfigured} from './indexer-client';

export interface ProtocolCounterSnapshot {
    collectedCount: number;
    acquisitionCount: number;
    vaultedCount: number;
    clearedCount: number;
    proofsMinted: number;
    totalEthBurned: string;
    totalTokensBurned: string;
    totalBountyInflowsWei: string;
    totalVaultBurnSweptWei: string;
    /** Null when the deployed indexer predates this field. */
    totalContributionVolumeWei: string | null;
    lastUpdatedAt: string;
}

export interface ProtocolStatsSnapshot {
    /** False when the indexer was unreachable / returned no row. */
    ok: boolean;
    /** False when the indexer itself was unreachable — distinct from `ok`,
     *  which is also false for a reachable indexer with no counter row yet
     *  ("no activity"). The UI renders the two differently so an outage never
     *  masquerades as a quiet protocol. Optional so cached API payloads from
     *  builds that predate the field stay valid (treat missing as reachable). */
    reachable?: boolean;
    /** False when the indexer schema predates `totalContributionVolumeWei`. */
    hasContributionVolume: boolean;
    counter: ProtocolCounterSnapshot | null;
}

const COUNTER_FIELDS_BASE = `
    collectedCount
    acquisitionCount
    vaultedCount
    clearedCount
    proofsMinted
    totalEthBurned
    totalTokensBurned
    totalBountyInflowsWei
    totalVaultBurnSweptWei
    lastUpdatedAt
`;

const query = (withContribution: boolean) => `{
    protocolCounter(id: "global") {${COUNTER_FIELDS_BASE}${
        withContribution ? '    totalContributionVolumeWei\n' : ''
    }}
}`;

/** Query the indexer's ProtocolCounter singleton. Never throws on an OUTAGE —
 *  returns `{ok: false, reachable: false}` so callers render a degraded state
 *  rather than 500-ing. A misconfigured deploy (live protocol, production
 *  runtime, no INDEXER_URL) throws IndexerUrlMissingError by design. */
export async function fetchProtocolStats(): Promise<ProtocolStatsSnapshot> {
    // Pre-launch there is nothing to index and (legitimately) no indexer —
    // skip the query so /stats renders "no activity yet" instead of probing
    // a dead endpoint and reporting a spurious outage. Same gate every
    // LiveAdapter method applies.
    if (!isProtocolLive()) {
        return {ok: false, reachable: true, hasContributionVolume: false, counter: null};
    }
    const client = getIndexerClient();
    try {
        const {protocolCounter} = await client.request<{
            protocolCounter: ProtocolCounterSnapshot | null;
        }>(query(true));
        return {
            ok: protocolCounter !== null,
            reachable: true,
            hasContributionVolume: true,
            counter: protocolCounter,
        };
    } catch {
        // The full query failed — most likely the deployed indexer doesn't
        // yet know `totalContributionVolumeWei`. Retry without it.
        try {
            const {protocolCounter} = await client.request<{
                protocolCounter: Omit<ProtocolCounterSnapshot, 'totalContributionVolumeWei'> | null;
            }>(query(false));
            return {
                ok: protocolCounter !== null,
                reachable: true,
                hasContributionVolume: false,
                counter: protocolCounter
                    ? {...protocolCounter, totalContributionVolumeWei: null}
                    : null,
            };
        } catch (e) {
            rethrowIfIndexerMisconfigured(e);
            return {ok: false, reachable: false, hasContributionVolume: false, counter: null};
        }
    }
}
