/**
 * Unit tests for `useIncreaseFlash` — the shared "value went up" detector
 * behind the green "+delta" badge on the header live-bid chip and the
 * /trade live-bid stat.
 *
 * Covers: seeding (no flash on the first value / on undefined→defined),
 * flashing on an increase, no flash on equal/decrease, the auto-clear
 * timer, and the latest-delta-wins behaviour on a rapid second increase.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, renderHook} from '@testing-library/react';

import {useIncreaseFlash} from './useIncreaseFlash';

describe('useIncreaseFlash', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not flash on the first defined value (seeds the baseline)', () => {
        const {result} = renderHook(({v}) => useIncreaseFlash(v), {
            initialProps: {v: 100n as bigint | undefined},
        });
        expect(result.current).toBe(0n);
    });

    it('does not flash while the value is undefined, nor when it first loads', () => {
        const {result, rerender} = renderHook(({v}) => useIncreaseFlash(v), {
            initialProps: {v: undefined as bigint | undefined},
        });
        expect(result.current).toBe(0n);
        // First real value landing is a seed, not an increase.
        rerender({v: 50n});
        expect(result.current).toBe(0n);
    });

    it('flashes the delta on an increase', () => {
        const {result, rerender} = renderHook(({v}) => useIncreaseFlash(v), {
            initialProps: {v: 100n as bigint | undefined},
        });
        rerender({v: 175n});
        expect(result.current).toBe(75n);
    });

    it('does not flash on an equal or decreasing value', () => {
        const {result, rerender} = renderHook(({v}) => useIncreaseFlash(v), {
            initialProps: {v: 100n as bigint | undefined},
        });
        rerender({v: 100n}); // equal
        expect(result.current).toBe(0n);
        rerender({v: 80n}); // decrease
        expect(result.current).toBe(0n);
    });

    it('auto-clears the delta after clearMs', () => {
        const {result, rerender} = renderHook(({v}) => useIncreaseFlash(v, 2500), {
            initialProps: {v: 100n as bigint | undefined},
        });
        rerender({v: 200n});
        expect(result.current).toBe(100n);
        act(() => {
            vi.advanceTimersByTime(2499);
        });
        expect(result.current).toBe(100n); // still showing
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(result.current).toBe(0n); // cleared
    });

    it('shows the newest delta when a second increase lands before the clear', () => {
        const {result, rerender} = renderHook(({v}) => useIncreaseFlash(v, 2500), {
            initialProps: {v: 100n as bigint | undefined},
        });
        rerender({v: 150n});
        expect(result.current).toBe(50n);
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        rerender({v: 160n}); // second bump from 150 → 160, before the first cleared
        expect(result.current).toBe(10n);
        // The timer was reset by the second increase, so the original 2500ms
        // mark from the first bump must NOT clear it.
        act(() => {
            vi.advanceTimersByTime(1500); // 2500 since first bump, 1500 since second
        });
        expect(result.current).toBe(10n);
        act(() => {
            vi.advanceTimersByTime(1000); // now 2500 since the second bump
        });
        expect(result.current).toBe(0n);
    });
});
