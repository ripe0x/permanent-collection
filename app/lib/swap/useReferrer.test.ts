/**
 * Unit tests for the `useReferrer` resolution chain.
 *
 * Priority order under test:
 *   1. `?ref=0x...` in URL → wins, persists to localStorage
 *   2. Stored value in localStorage
 *   3. `/api/config` defaultReferrer
 *   4. null
 *
 * Notes on test infrastructure:
 *   - The hook uses a module-level cache for the `/api/config` result.
 *     We reset modules between tests so each renderHook starts with a
 *     fresh cache state.
 *   - jsdom provides window, localStorage, and history; we set
 *     `window.location.href` by replacing the URL via history APIs.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {renderHook, waitFor} from '@testing-library/react';

const SAMPLE_REFERRER = '0x1234567890123456789012345678901234567890' as const;
const RUNTIME_DEFAULT = '0xabcdEFAbCDeFABCDeFAbcdEfaBcDEfaBCDeFabcD' as const;
const STORAGE_KEY = 'pc:referrer';

function setUrl(search: string) {
    window.history.replaceState({}, '', '/trade' + search);
}

function clearStorage() {
    try {
        window.localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore — localStorage may be disabled in some jsdom configs
    }
}

describe('useReferrer', () => {
    beforeEach(() => {
        vi.resetModules();
        clearStorage();
        setUrl('');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns null on first sync render', async () => {
        // No URL, no storage, no /api/config available → null.
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({defaultReferrer: null}), {
                status: 200,
                headers: {'content-type': 'application/json'},
            }),
        ) as never;
        const {useReferrer} = await import('./useReferrer');
        const {result} = renderHook(() => useReferrer());
        // After the effect runs + fetch resolves, should still be null.
        await waitFor(() => expect(result.current).toBe(null));
    });

    it('reads ?ref=0x... from URL and persists to localStorage', async () => {
        setUrl(`?ref=${SAMPLE_REFERRER}`);
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({defaultReferrer: null}), {status: 200}),
        ) as never;
        const {useReferrer} = await import('./useReferrer');
        const {result} = renderHook(() => useReferrer());
        await waitFor(() =>
            expect(result.current?.toLowerCase()).toBe(SAMPLE_REFERRER.toLowerCase()),
        );
        // Storage was populated.
        expect(window.localStorage.getItem(STORAGE_KEY)?.toLowerCase()).toBe(
            SAMPLE_REFERRER.toLowerCase(),
        );
    });

    it('uses stored value when no URL ?ref=', async () => {
        window.localStorage.setItem(STORAGE_KEY, SAMPLE_REFERRER);
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({defaultReferrer: RUNTIME_DEFAULT}), {
                status: 200,
            }),
        ) as never;
        const {useReferrer} = await import('./useReferrer');
        const {result} = renderHook(() => useReferrer());
        await waitFor(() =>
            expect(result.current?.toLowerCase()).toBe(SAMPLE_REFERRER.toLowerCase()),
        );
        // Storage value should win over runtime default.
        expect(result.current?.toLowerCase()).not.toBe(
            RUNTIME_DEFAULT.toLowerCase(),
        );
    });

    it('falls back to /api/config defaultReferrer when URL + storage empty', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({defaultReferrer: RUNTIME_DEFAULT}), {
                status: 200,
            }),
        ) as never;
        const {useReferrer} = await import('./useReferrer');
        const {result} = renderHook(() => useReferrer());
        await waitFor(() =>
            expect(result.current?.toLowerCase()).toBe(RUNTIME_DEFAULT.toLowerCase()),
        );
        // localStorage was NOT polluted by the runtime default.
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe(null);
    });

    it('returns null if /api/config returns null defaultReferrer', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({defaultReferrer: null}), {status: 200}),
        ) as never;
        const {useReferrer} = await import('./useReferrer');
        const {result} = renderHook(() => useReferrer());
        // Give the async fetch time to resolve.
        await new Promise((r) => setTimeout(r, 50));
        expect(result.current).toBe(null);
    });

    it('returns null if /api/config returns an invalid address', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({defaultReferrer: 'not-an-address'}),
                {status: 200},
            ),
        ) as never;
        const {useReferrer} = await import('./useReferrer');
        const {result} = renderHook(() => useReferrer());
        await new Promise((r) => setTimeout(r, 50));
        expect(result.current).toBe(null);
    });

    it('returns null if /api/config fetch fails', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as never;
        const {useReferrer} = await import('./useReferrer');
        const {result} = renderHook(() => useReferrer());
        await new Promise((r) => setTimeout(r, 50));
        expect(result.current).toBe(null);
    });

    it('URL value wins over both storage and runtime default', async () => {
        // Prepopulate storage with a DIFFERENT value than the URL.
        const OTHER_STORAGE = '0xdeaDdEAdDEAdDEadDEaddEadDEadDEAdDeadDEAD' as const;
        window.localStorage.setItem(STORAGE_KEY, OTHER_STORAGE);
        setUrl(`?ref=${SAMPLE_REFERRER}`);
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({defaultReferrer: RUNTIME_DEFAULT}), {
                status: 200,
            }),
        ) as never;
        const {useReferrer} = await import('./useReferrer');
        const {result} = renderHook(() => useReferrer());
        await waitFor(() =>
            expect(result.current?.toLowerCase()).toBe(SAMPLE_REFERRER.toLowerCase()),
        );
        // URL value overwrote storage (sticky for future visits).
        expect(window.localStorage.getItem(STORAGE_KEY)?.toLowerCase()).toBe(
            SAMPLE_REFERRER.toLowerCase(),
        );
    });

    it('treats zero-address /api/config defaultReferrer as null', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    defaultReferrer: '0x0000000000000000000000000000000000000000',
                }),
                {status: 200},
            ),
        ) as never;
        const {useReferrer} = await import('./useReferrer');
        const {result} = renderHook(() => useReferrer());
        await new Promise((r) => setTimeout(r, 50));
        expect(result.current).toBe(null);
    });

    it('accepts mixed-case ?ref= without EIP-55 checksum (permissive parser)', async () => {
        // Lower-cased — would be rejected by viem's strict isAddress.
        const lowercased = SAMPLE_REFERRER.toLowerCase() as `0x${string}`;
        setUrl(`?ref=${lowercased}`);
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({defaultReferrer: null}), {status: 200}),
        ) as never;
        const {useReferrer} = await import('./useReferrer');
        const {result} = renderHook(() => useReferrer());
        await waitFor(() => expect(result.current).not.toBe(null));
        // Normalized via viem's getAddress (checksum may differ from the input).
        expect(result.current?.toLowerCase()).toBe(lowercased.toLowerCase());
    });
});
