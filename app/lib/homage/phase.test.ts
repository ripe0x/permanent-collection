import {describe, expect, it} from 'vitest';

import {currentPhase, demoNext, fmtCountdown, nextTransition, type Schedule} from '@/lib/homage/phase';

// The phase machine mirrors Homage.sol's window gating exactly:
//   claim [claimStart, allowlistStart) → allowlist [allowlistStart, publicStart)
//   → public [publicStart, ∞); all-zero = closed; equal bounds collapse a window.
// These tests pin the boundary semantics (>= opens, < closes) so a port/refactor
// can't silently shift a window edge by one second.

const T0 = 1_800_000_000;
const SCHED: Schedule = {claimStart: T0, allowlistStart: T0 + 100, publicStart: T0 + 200};

describe('currentPhase', () => {
    it('is closed before the first window and for an all-zero schedule', () => {
        expect(currentPhase(SCHED, T0 - 1)).toBe('closed');
        expect(currentPhase({claimStart: 0, allowlistStart: 0, publicStart: 0}, T0)).toBe('closed');
    });

    it('opens each window at its inclusive lower bound', () => {
        expect(currentPhase(SCHED, T0)).toBe('claim');
        expect(currentPhase(SCHED, T0 + 100)).toBe('allowlist');
        expect(currentPhase(SCHED, T0 + 200)).toBe('public');
    });

    it('closes each window at its exclusive upper bound', () => {
        expect(currentPhase(SCHED, T0 + 99)).toBe('claim');
        expect(currentPhase(SCHED, T0 + 199)).toBe('allowlist');
    });

    it('public is open-ended', () => {
        expect(currentPhase(SCHED, T0 + 1_000_000)).toBe('public');
    });

    it('skips a collapsed claim window (claimStart == allowlistStart)', () => {
        const s: Schedule = {claimStart: T0, allowlistStart: T0, publicStart: T0 + 100};
        expect(currentPhase(s, T0)).toBe('allowlist');
    });

    it('an immediate-open schedule (all bounds equal) is public from the start', () => {
        const s: Schedule = {claimStart: T0, allowlistStart: T0, publicStart: T0};
        expect(currentPhase(s, T0)).toBe('public');
    });
});

describe('nextTransition', () => {
    it('ticks toward each upcoming boundary in order', () => {
        expect(nextTransition(SCHED, T0 - 1)).toEqual({to: 'claim', at: T0});
        expect(nextTransition(SCHED, T0)).toEqual({to: 'allowlist', at: T0 + 100});
        expect(nextTransition(SCHED, T0 + 150)).toEqual({to: 'public', at: T0 + 200});
    });

    it('returns null once public opened (nothing ahead) and for an unscheduled contract', () => {
        expect(nextTransition(SCHED, T0 + 200)).toBeNull();
        expect(nextTransition({claimStart: 0, allowlistStart: 0, publicStart: 0}, T0)).toBeNull();
    });

    it('skips collapsed windows so the countdown targets a window that actually opens', () => {
        const s: Schedule = {claimStart: T0, allowlistStart: T0, publicStart: T0 + 100};
        expect(nextTransition(s, T0 - 1)).toEqual({to: 'allowlist', at: T0});
    });
});

describe('demoNext', () => {
    it('walks closed → claim → allowlist → public and is null for public', () => {
        expect(demoNext('closed', T0)?.to).toBe('claim');
        expect(demoNext('claim', T0)?.to).toBe('allowlist');
        expect(demoNext('allowlist', T0)?.to).toBe('public');
        expect(demoNext('public', T0)).toBeNull();
    });

    it('targets the next top-of-hour', () => {
        const at = demoNext('closed', T0)!.at;
        expect(at % 3600).toBe(0);
        expect(at).toBeGreaterThan(T0);
        expect(at - T0).toBeLessThanOrEqual(3600);
    });
});

describe('fmtCountdown', () => {
    it('picks the two most significant units', () => {
        expect(fmtCountdown(2 * 86400 + 4 * 3600 + 30 * 60)).toBe('2d 4h');
        expect(fmtCountdown(3 * 3600 + 12 * 60 + 5)).toBe('3h 12m');
        expect(fmtCountdown(45 * 60 + 9)).toBe('45m 9s');
        expect(fmtCountdown(45)).toBe('45s');
    });

    it('clamps non-positive to 0s', () => {
        expect(fmtCountdown(0)).toBe('0s');
        expect(fmtCountdown(-5)).toBe('0s');
    });
});
