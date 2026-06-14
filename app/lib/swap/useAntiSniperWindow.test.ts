import {describe, expect, it} from 'vitest';

import {
    type AntiSniperConfig,
    computeAntiSniperState,
    formatCountdown,
} from '@/lib/swap/useAntiSniperWindow';

// Launch config: 90% -> 6% over 30 min (skim-module bps, 100_000 = 100%).
const START = 1_700_000_000; // arbitrary unix second the pool was initialized
const config: AntiSniperConfig = {
    startingSkimBps: 90_000,
    endingSkimBps: 6_000,
    durationSec: 1_800,
    startTimeSec: START,
};

describe('computeAntiSniperState — decay math', () => {
    it('reports the starting skim and full duration at t=0', () => {
        const s = computeAntiSniperState(config, START);
        expect(s.active).toBe(true);
        expect(s.currentSkimBps).toBe(90_000);
        expect(s.secondsRemaining).toBe(1_800);
    });

    it('decays linearly at the midpoint', () => {
        const s = computeAntiSniperState(config, START + 900);
        expect(s.active).toBe(true);
        // 90_000 - (90_000-6_000)*900/1800 = 90_000 - 42_000 = 48_000
        expect(s.currentSkimBps).toBe(48_000);
        expect(s.secondsRemaining).toBe(900);
    });

    it('clamps to the baseline once the window has elapsed', () => {
        const s = computeAntiSniperState(config, START + 1_800);
        expect(s.active).toBe(false);
        expect(s.currentSkimBps).toBe(6_000);
        expect(s.secondsRemaining).toBe(0);
    });

    it('treats a now before startTime as t=0 (no negative elapsed)', () => {
        const s = computeAntiSniperState(config, START - 10_000);
        expect(s.active).toBe(true);
        expect(s.currentSkimBps).toBe(90_000);
        expect(s.secondsRemaining).toBe(1_800);
    });
});

describe('reload stability (the bug under test)', () => {
    // The hook feeds `now = max(latestBlockTs, wallClock)`, recomputed each
    // render from live sources with NO stored wall-time anchor. So the same
    // wall instant always yields the same state, and later instants yield
    // strictly less remaining — a reload can never jump back to 30 min.

    it('is a deterministic function of now (a reload at the same instant is identical)', () => {
        const before = computeAntiSniperState(config, START + 600);
        // Simulate a reload: recompute from scratch at the same wall instant.
        const afterReload = computeAntiSniperState(config, START + 600);
        expect(afterReload).toEqual(before);
        expect(afterReload.secondsRemaining).toBe(1_200);
    });

    it('decreases monotonically across reloads as real time advances', () => {
        const t0 = computeAntiSniperState(config, START + 300).secondsRemaining;
        const t1 = computeAntiSniperState(config, START + 300 + 120).secondsRemaining; // reload 2 min later
        const t2 = computeAntiSniperState(config, START + 300 + 600).secondsRemaining; // reload 10 min later
        expect(t1).toBe(t0 - 120);
        expect(t2).toBe(t0 - 600);
        expect(t1).toBeLessThan(t0);
        expect(t2).toBeLessThan(t1);
    });
});

describe('frozen vs warped fork regimes (the max() base)', () => {
    // The hook computes nowSec = max(chainLatestSec, wallNowSec). These tests
    // assert the math behaves correctly for the value that max() yields in each
    // environment.

    it('frozen fork: wall clock advances the countdown past the frozen chain head', () => {
        // chain head frozen near startTime; wall clock is 12 min of real time later.
        const frozenChain = START + 1;
        const wallNow = START + 12 * 60;
        const nowSec = Math.max(frozenChain, wallNow);
        const s = computeAntiSniperState(config, nowSec);
        expect(s.active).toBe(true);
        expect(s.secondsRemaining).toBe(1_800 - 12 * 60); // 1080s left, not reset to 1800
    });

    it('warped fork: chain head leading wall clock reads as already decayed', () => {
        // dev +70min warp: chain head is 70 min past startTime; wall clock is fresh.
        const warpedChain = START + 70 * 60;
        const wallNow = START + 30; // dev server just booted
        const nowSec = Math.max(warpedChain, wallNow);
        const s = computeAntiSniperState(config, nowSec);
        expect(s.active).toBe(false);
        expect(s.secondsRemaining).toBe(0);
        expect(s.currentSkimBps).toBe(6_000);
    });
});

describe('formatCountdown', () => {
    it('formats the standard cases', () => {
        expect(formatCountdown(0)).toBe('expired');
        expect(formatCountdown(-5)).toBe('expired');
        expect(formatCountdown(45)).toBe('45s');
        expect(formatCountdown(125)).toBe('2m 5s');
        expect(formatCountdown(3_700)).toBe('1h 1m');
    });
});
