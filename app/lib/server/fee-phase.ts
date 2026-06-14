// Server-side phase reader. Returns the current FeePhase via:
//   - the indexer's ProtocolCounter singleton for acquisitionCount +
//     collectedCount (zero RPC cost per call — N viewers per cache
//     window collapse to one indexer read);
//   - one immutable RPC read for the MEV anti-sniper window (poolId →
//     module → skimConfigs(poolId)), cached for an hour because the
//     config is set once at pool init and never changes.
//
// All wrapped in `unstable_cache` so the read fans out at most once per
// REVALIDATE_SECONDS regardless of viewer count. Per CLAUDE.md RPC
// discipline: indexer first, cache always, RPC last.
//
// Server-only. Do NOT import from a `'use client'` file — `unstable_cache`
// is not available there.

import {unstable_cache} from 'next/cache';
import {createPublicClient, fallback, http} from 'viem';
import {mainnet} from 'viem/chains';

import {getContractAddresses, getRpcUrls, isProtocolLive} from '@/lib/config';
import {getIndexerClient, rethrowIfIndexerMisconfigured} from '@/lib/data/indexer-client';
import {buildPoolKey, computePoolId, getArtcoinsHook} from '@/lib/swap/poolKey';
import type {FeePhase} from '@/lib/fees-types';

/** Minimal hook view: which MEV module is bound to this pool? */
const hookMevModuleAbi = [
    {
        type: 'function',
        name: 'mevModule',
        inputs: [{type: 'bytes32'}],
        outputs: [{type: 'address'}],
        stateMutability: 'view',
    },
] as const;

/** Minimal skim-module view. PC binds `ArtCoinsMevLinearSkim`, NOT the legacy
 *  linear-*fees* module: its surface is `skimConfigs(poolId)` (skim bps denom,
 *  100_000 = 100%), and `feeConfigs` reverts against it. We only need the
 *  window bounds (startTime + duration) for the active check below — the same
 *  positions 2/3 the legacy `feeConfigs` exposed — so the bps fields are read
 *  but unused. Mirrors the client-side rewire in `useAntiSniperWindow`. */
const skimModuleAbi = [
    {
        type: 'function',
        name: 'skimConfigs',
        inputs: [{type: 'bytes32'}],
        outputs: [
            {name: 'startingBps', type: 'uint24'},
            {name: 'endingBps', type: 'uint24'},
            {name: 'durationSeconds', type: 'uint32'},
            {name: 'startTime', type: 'uint256'},
        ],
        stateMutability: 'view',
    },
] as const;

const ZERO = '0x0000000000000000000000000000000000000000' as const;

/** TTL for the cached phase read. Phase transitions are monotonic and
 *  one-way; a stale flag of "pre-acquisition" for 60s after the first
 *  acquisition is the only failure mode and it's harmless (the fee
 *  breakdown will catch up on the next revalidation). 60s keeps upstream
 *  load flat under load and lines up with the existing indexer-backed
 *  cache windows in /api/live-bid. */
const PHASE_REVALIDATE_SECONDS = 60;

/** TTL for the cached MEV-window snapshot. The config is immutable
 *  post-init so we can cache aggressively; the boundary check is
 *  recomputed every read from `Date.now()` so the window can close
 *  between two cached reads without forcing a fresh upstream call. */
const MEV_REVALIDATE_SECONDS = 60 * 60; // 1h

interface MevSnapshot {
    /** Pool init unix timestamp; 0 if no module is bound (treated as
     *  no-window). */
    startTimeSec: number;
    /** Configured decay duration in seconds. */
    durationSec: number;
}

const readMevSnapshot = unstable_cache(
    async (): Promise<MevSnapshot> => {
        try {
            const addrs = getContractAddresses();
            const transports = getRpcUrls().map((u) => http(u, {timeout: 30_000}));
            const rpc = createPublicClient({
                chain: mainnet,
                transport: transports.length > 1 ? fallback(transports) : transports[0],
            });
            const poolKey = buildPoolKey(addrs.token);
            const poolId = computePoolId(poolKey);

            const boundModule = (await rpc
                .readContract({
                    address: getArtcoinsHook(),
                    abi: hookMevModuleAbi,
                    functionName: 'mevModule',
                    args: [poolId],
                })
                .catch(() => ZERO)) as string;
            if (!boundModule || boundModule.toLowerCase() === ZERO) {
                return {startTimeSec: 0, durationSec: 0};
            }
            const cfg = (await rpc
                .readContract({
                    address: boundModule as `0x${string}`,
                    abi: skimModuleAbi,
                    functionName: 'skimConfigs',
                    args: [poolId],
                })
                .catch(() => null)) as readonly [number, number, number, bigint] | null;
            if (!cfg) return {startTimeSec: 0, durationSec: 0};
            // skimConfigs => [startingBps, endingBps, durationSeconds, startTime];
            // we only need the window bounds (positions 2/3).
            const [, , duration, startTime] = cfg;
            return {startTimeSec: Number(startTime), durationSec: Number(duration)};
        } catch {
            // Treat any upstream hiccup as "no window bound" — the
            // breakdown will just render the steady-state phase, which
            // is the correct fallback once the pool's running.
            return {startTimeSec: 0, durationSec: 0};
        }
    },
    ['fee-phase:mev-snapshot'],
    {revalidate: MEV_REVALIDATE_SECONDS, tags: ['fee-phase:mev']},
);

interface PhaseCounts {
    acquisitionCount: number;
    collectedCount: number;
}

const readPhaseCounts = unstable_cache(
    async (): Promise<PhaseCounts> => {
        // Pre-launch: nothing indexed, no indexer to ask. Pre-everything is
        // the correct phase, and skipping the query keeps a legitimately
        // indexer-less deploy from logging spurious outage noise.
        if (!isProtocolLive()) return {acquisitionCount: 0, collectedCount: 0};
        try {
            const {protocolCounter} = await getIndexerClient().request<{
                protocolCounter: {
                    acquisitionCount: number;
                    collectedCount: number;
                } | null;
            }>(`{ protocolCounter(id: "global") { acquisitionCount collectedCount } }`);
            return {
                acquisitionCount: protocolCounter?.acquisitionCount ?? 0,
                collectedCount: protocolCounter?.collectedCount ?? 0,
            };
        } catch (e) {
            rethrowIfIndexerMisconfigured(e);
            // Indexer down — treat as pre-everything. The display
            // labels stay informative ("boosts the bid") and the
            // routed destinations are still correct for a freshly
            // launched protocol.
            return {acquisitionCount: 0, collectedCount: 0};
        }
    },
    ['fee-phase:counts'],
    {revalidate: PHASE_REVALIDATE_SECONDS, tags: ['fee-phase:counts']},
);

/** Resolve the protocol's current FeePhase. Cached server-side; safe to
 *  call from any server component without burning RPC per render. */
export async function getCurrentFeePhase(): Promise<FeePhase> {
    const [counts, mev] = await Promise.all([readPhaseCounts(), readMevSnapshot()]);
    const nowSec = Math.floor(Date.now() / 1000);
    const mevWindowActive =
        mev.startTimeSec > 0 && nowSec < mev.startTimeSec + mev.durationSec;
    return {
        postFirstAcquisition: counts.acquisitionCount > 0,
        postFirstVault: counts.collectedCount > 0,
        mevWindowActive,
    };
}

/** Parse an override map (from URL search params) into a FeePhase. Used
 *  by /debug/fees so anyone can walk through every phase visually
 *  without needing the chain to be in that state. Unset keys fall back
 *  to the provided default (typically the current phase). */
export function applyPhaseOverride(
    base: FeePhase,
    search: Record<string, string | string[] | undefined>,
): FeePhase {
    const flag = (k: string): boolean | undefined => {
        const raw = Array.isArray(search[k]) ? search[k]?.[0] : search[k];
        if (raw === undefined) return undefined;
        if (raw === '1' || raw === 'true' || raw === 'yes') return true;
        if (raw === '0' || raw === 'false' || raw === 'no') return false;
        return undefined;
    };
    return {
        postFirstAcquisition: flag('acq') ?? base.postFirstAcquisition,
        postFirstVault: flag('vault') ?? base.postFirstVault,
        mevWindowActive: flag('mev') ?? base.mevWindowActive,
    };
}
