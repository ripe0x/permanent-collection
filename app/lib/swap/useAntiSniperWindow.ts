'use client';

/* Anti-sniper window state hook.
 *
 * PC binds the *skim* MEV module (`ArtCoinsMevLinearSkim`), NOT the legacy
 * linear-*fees* module. The two have completely different surfaces:
 *
 *   linear-fees:  feeConfigs(poolId)  + ppm denom (1_000_000 = 100%)
 *   linear-skim:  skimConfigs(poolId) + currentSkimBps/operational, and the
 *                 skim-module bps denom (100_000 = 100%; e.g. 90_000 = 90%)
 *
 * Reading `feeConfigs` against the skim module reverts, which is why an
 * earlier version of this hook silently reported `active: false` and the
 * notice never rendered even while the chain reported the window live. This
 * version reads the skim module directly.
 *
 * Cost model:
 *   - `mevModule(poolId)` + `skimConfigs(poolId)`: immutable post-init, read
 *     once and cached for an hour. These give the window's `startTime`,
 *     `duration`, and skim endpoints.
 *   - the latest `block.timestamp` is read once (cached, no poll) and combined
 *     with the browser wall clock as `now = max(latestBlockTs, wallClock)`,
 *     recomputed every render via a 1s ticker. This is the same "what will the
 *     next mined block's timestamp be" base that `chainTime.chainDeadlineBaseSeconds`
 *     uses, and it stays correct across page reloads because neither input is a
 *     stored wall-time anchor:
 *       - mainnet: chain and wall agree, either dominates.
 *       - idle fork frozen near pool init: the wall clock advances `now`, so the
 *         countdown ticks down instead of resetting to full duration each reload.
 *       - fork warped ahead of real time (the dev `+70min` MEV-decay warp): the
 *         block timestamp leads the wall clock and wins the max, so the window
 *         correctly reads as already decayed.
 *     Ticking stops once the window expires, so idle/post-window pages cost
 *     nothing.
 *
 * Mirrors `ArtCoinsMevLinearSkim.currentSkimBps` exactly:
 *   skim = startingBps - (startingBps - endingBps) * elapsed / duration
 * clamped to `endingBps` once `elapsed >= duration`.
 *
 * Single consumer: `app/components/SwapBox.tsx`.
 */

import {useEffect, useMemo, useState} from 'react';
import {useBlock, useChainId, useReadContract} from 'wagmi';
import {type Address} from 'viem';

import {getArtcoinsHook} from '@/lib/swap/poolKey';

/** Skim-module denominator: 100_000 = 100% (e.g. 90_000 = 90%, 5_000 = 5%). */
const SKIM_DENOM = 100_000;

/** Minimal IArtCoinsHookV2 view: which MEV module is bound to a pool? */
const hookMevModuleAbi = [
    {
        type: 'function',
        name: 'mevModule',
        inputs: [{type: 'bytes32'}],
        outputs: [{type: 'address'}],
        stateMutability: 'view',
    },
] as const;

/** Minimal IArtCoinsMevSkim view surface (skim module). */
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

export interface AntiSniperWindowState {
    /** True if a config is loaded AND the window hasn't expired. */
    active: boolean;
    /** True while the initial RPC reads are in flight. */
    loading: boolean;
    /** Starting skim in skim-module bps (100_000 = 100%). E.g. 90_000 = 90%. */
    startingSkimBps: number | undefined;
    /** Ending skim in skim-module bps. After expiry the pool runs this baseline. */
    endingSkimBps: number | undefined;
    /** Configured decay duration in seconds. */
    durationSec: number | undefined;
    /** Pool init timestamp (unix seconds). */
    startTimeSec: number | undefined;
    /** Currently-active skim in skim-module bps, recomputed as the chain ticks. */
    currentSkimBps: number | undefined;
    /** Seconds left until the window closes (0 once expired). */
    secondsRemaining: number;
}

/** Immutable per-pool skim config, as read from `skimConfigs(poolId)`. */
export interface AntiSniperConfig {
    startingSkimBps: number;
    endingSkimBps: number;
    durationSec: number;
    startTimeSec: number;
}

/** Decay state derived from a config at a given `now`. */
export interface AntiSniperDerived {
    active: boolean;
    currentSkimBps: number;
    secondsRemaining: number;
}

/**
 * Pure decay math, mirroring `ArtCoinsMevLinearSkim.currentSkimBps`:
 *   skim = startingBps - (startingBps - endingBps) * elapsed / duration
 * clamped to `endingBps` once `elapsed >= duration`.
 *
 * `nowSec` is the caller's estimate of the timestamp the next mined block will
 * carry (the hook passes `max(latestBlockTs, wallClock)`). Because the result
 * is a deterministic function of `(config, nowSec)` with no hidden state, a
 * page reload recomputes the identical value from the same chain + wall inputs
 * — the countdown can't reset to the full duration.
 */
export function computeAntiSniperState(
    config: AntiSniperConfig,
    nowSec: number,
): AntiSniperDerived {
    const elapsed = Math.max(0, nowSec - config.startTimeSec);
    const remaining = Math.max(0, config.durationSec - elapsed);
    if (remaining <= 0) {
        return {active: false, currentSkimBps: config.endingSkimBps, secondsRemaining: 0};
    }
    const range = config.startingSkimBps - config.endingSkimBps;
    return {
        active: true,
        currentSkimBps:
            config.startingSkimBps - Math.floor((range * elapsed) / config.durationSec),
        secondsRemaining: remaining,
    };
}

export function useAntiSniperWindow(poolId: `0x${string}` | undefined): AntiSniperWindowState {
    const chainId = useChainId();

    // Step 1 — which MEV module is bound to this pool? Read from the hook
    // (`mevModule(poolId)` is immutable once the pool is initialized). On
    // mainnet this returns the canonical skim module; on the local fork it
    // returns whatever `Deploy.s.sol` bound. Resolving it dynamically keeps
    // the UI env-agnostic.
    const {data: boundModule, isLoading: moduleLoading} = useReadContract({
        address: getArtcoinsHook(),
        abi: hookMevModuleAbi,
        functionName: 'mevModule',
        args: poolId ? [poolId] : undefined,
        query: {
            enabled: Boolean(poolId),
            staleTime: 60 * 60 * 1000, // immutable post-init
            gcTime: 24 * 60 * 60 * 1000,
        },
    });

    const mevModuleAddress =
        boundModule && boundModule !== '0x0000000000000000000000000000000000000000'
            ? (boundModule as Address)
            : undefined;

    // Step 2 — read the immutable skim config from that module. Same 1h
    // staleTime: skimConfigs is set once at init and never changes.
    const {data, isLoading: configLoading} = useReadContract({
        address: mevModuleAddress,
        abi: skimModuleAbi,
        functionName: 'skimConfigs',
        args: poolId ? [poolId] : undefined,
        query: {
            enabled: Boolean(poolId && mevModuleAddress),
            staleTime: 60 * 60 * 1000,
            gcTime: 24 * 60 * 60 * 1000,
        },
    });
    const isLoading = moduleLoading || (Boolean(mevModuleAddress) && configLoading);

    // `skimConfigs` returns the zero struct for any pool not initialized with
    // this module — i.e. `startTime === 0n`. Treat that as "no window bound"
    // rather than "active window starting at epoch".
    const config = useMemo(() => {
        if (!data) return undefined;
        const [startingBps, endingBps, durationSeconds, startTime] = data as readonly [
            number,
            number,
            number,
            bigint,
        ];
        if (startTime === 0n) return undefined;
        return {
            startingSkimBps: Number(startingBps),
            endingSkimBps: Number(endingBps),
            durationSec: Number(durationSeconds),
            startTimeSec: Number(startTime),
        };
    }, [data]);

    // Step 3 — read the latest block timestamp ONCE (cached, no poll). It only
    // serves as a floor under the wall clock for the warped-fork regime, where
    // the chain leads real time; in every other regime the wall clock advances
    // `now` between renders. `useBlock` caches the result, so this is a single
    // read while the window is open rather than a recurring poll.
    const {data: block} = useBlock({
        chainId,
        query: {
            enabled: Boolean(config),
            staleTime: 60 * 60 * 1000,
            gcTime: 24 * 60 * 60 * 1000,
        },
    });
    const chainLatestSec = block ? Number(block.timestamp) : 0;

    // Drive a 1s re-render while the window is open so the countdown ticks as
    // the wall clock advances. Ticking stops once the window closes (see the
    // effect below), so idle/post-window pages cost nothing.
    const [pollEnabled, setPollEnabled] = useState(true);
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!config || !pollEnabled) return;
        const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 1000);
        return () => clearInterval(id);
    }, [config, pollEnabled]);

    // Derive the live skim + remaining using the exact on-chain linear formula.
    // `now = max(latestBlockTs, wallClock)` predicts the timestamp the next
    // mined block will carry (mirrors `chainTime.chainDeadlineBaseSeconds`):
    // the wall clock advances the countdown on a frozen fork and survives
    // reloads (no stored anchor), while the block timestamp wins the max on a
    // fork warped ahead of real time so the window reads as already decayed.
    let currentSkimBps: number | undefined;
    let secondsRemaining = 0;
    let active = false;
    if (config) {
        const nowSec = Math.max(chainLatestSec, Math.floor(Date.now() / 1000));
        const derived = computeAntiSniperState(config, nowSec);
        active = derived.active;
        currentSkimBps = derived.currentSkimBps;
        secondsRemaining = derived.secondsRemaining;
    }

    // Stop ticking once the window has closed.
    useEffect(() => {
        if (config && secondsRemaining <= 0) {
            setPollEnabled(false);
        }
    }, [config, secondsRemaining]);

    return {
        active,
        loading: isLoading,
        startingSkimBps: config?.startingSkimBps,
        endingSkimBps: config?.endingSkimBps,
        durationSec: config?.durationSec,
        startTimeSec: config?.startTimeSec,
        currentSkimBps,
        secondsRemaining,
    };
}

/** Format skim-module bps as a percentage string (100_000 = 100%). */
export function formatSkimBps(bps: number | undefined): string {
    if (bps === undefined) return '—';
    return `${(bps / (SKIM_DENOM / 100)).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** Format seconds as "Xh Ym" / "Ym Zs" / "Zs". */
export function formatCountdown(sec: number): string {
    if (sec <= 0) return 'expired';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
