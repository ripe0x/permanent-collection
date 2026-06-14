'use client';

/**
 * Resolves the referrer address for a swap, in priority order:
 *
 *   1. `?ref=0x...` in the URL (current visit). Persisted to localStorage.
 *   2. Previously stored value in localStorage (sticky from a prior `?ref`).
 *   3. `defaultReferrer` from `/api/config` — the protocol-operator
 *      fallback. Runtime-tunable: the operator changes the server's
 *      `DEFAULT_REFERRER` env var to swap the default without a frontend
 *      rebuild. Fetched once per session, cached at the edge for 60s
 *      and in module memory thereafter. NOT written to localStorage.
 *   4. `null` — no attribution. Hook leaves the referral slice in the
 *      protocol leg.
 *
 * Async note: the runtime default arrives a fraction of a second after
 * mount. A swap that fires before `/api/config` resolves uses URL/storage
 * if available, else `null` — i.e. no operator-default. This is
 * acceptable because (a) the fetch is fast (<300ms typical, served from
 * the edge cache), (b) it only matters for sessions with no `?ref=`
 * AND no stored value AND a swap submitted in the first few hundred ms,
 * which is rare in practice.
 *
 * Behavior summary:
 *  - First visit with `?ref=0xVALID` stores it and returns it.
 *  - Subsequent visits without `?ref` return the stored value.
 *  - A new `?ref=0xVALID` overwrites the stored value.
 *  - `?ref=0x` or invalid address clears the stored value; falls through
 *    to runtime default if available, else null.
 *  - During SSR / first client render before useEffect runs, returns null.
 *
 * Privacy note: the stored value is an Ethereum address (public by
 * design once a swap goes through). Nothing identifying.
 */

import {useEffect, useState} from 'react';
import {getAddress, isAddress} from 'viem';

const STORAGE_KEY = 'pc:referrer';

/** Module-level cache for the runtime `defaultReferrer`. Populated on
 *  first fetch; subsequent useReferrer mounts read it synchronously. */
let runtimeDefault: `0x${string}` | null = null;
let runtimeFetchPromise: Promise<`0x${string}` | null> | null = null;

function fetchRuntimeDefault(): Promise<`0x${string}` | null> {
    if (runtimeDefault !== null) return Promise.resolve(runtimeDefault);
    if (runtimeFetchPromise) return runtimeFetchPromise;
    runtimeFetchPromise = (async () => {
        try {
            const res = await fetch('/api/config', {cache: 'force-cache'});
            if (!res.ok) return null;
            const data = (await res.json()) as {defaultReferrer?: unknown};
            const raw = data?.defaultReferrer;
            if (typeof raw !== 'string') return null;
            if (!isAddress(raw, {strict: false})) return null;
            try {
                const checksummed = getAddress(raw);
                if (checksummed === '0x0000000000000000000000000000000000000000') {
                    return null;
                }
                runtimeDefault = checksummed;
                return checksummed;
            } catch {
                return null;
            }
        } catch {
            return null;
        } finally {
            runtimeFetchPromise = null;
        }
    })();
    return runtimeFetchPromise;
}

/** Normalize an address. Returns `null` if not a valid 0x-prefixed 20-byte
 *  hex string. Accepts any case (lowercase, uppercase, mixed) — viem's
 *  default `isAddress` rejects mixed-case addresses with bad EIP-55
 *  checksums, which would silently drop most user-typed referral links.
 *  We accept ANY valid format and let `getAddress` normalize to
 *  checksummed form. */
function normalize(raw: string | null): `0x${string}` | null {
    if (!raw) return null;
    if (!isAddress(raw, {strict: false})) return null;
    try {
        return getAddress(raw);
    } catch {
        return null;
    }
}

function readStorage(): `0x${string}` | null {
    if (typeof window === 'undefined') return null;
    try {
        return normalize(window.localStorage.getItem(STORAGE_KEY));
    } catch {
        return null;
    }
}

function writeStorage(value: `0x${string}` | null) {
    if (typeof window === 'undefined') return;
    try {
        if (value) window.localStorage.setItem(STORAGE_KEY, value);
        else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
        // localStorage may be disabled (private browsing). Best-effort only.
    }
}

/**
 * Hook to retrieve the active referrer for the current session.
 * Returns `null` until the client has mounted AND any `?ref=` query
 * has been resolved.
 *
 * Reads directly from `window.location.search` inside `useEffect` rather
 * than via `useSearchParams()` — that hook can return null on first
 * client render under some Suspense configurations, which makes the
 * indicator silently miss. The direct read runs once on mount and again
 * if the URL changes via SPA navigation (detected through popstate +
 * pushState/replaceState patching).
 */
export function useReferrer(): `0x${string}` | null {
    const [ref, setRef] = useState<`0x${string}` | null>(null);

    useEffect(() => {
        let cancelled = false;
        const resolve = () => {
            if (typeof window === 'undefined') return;
            const params = new URL(window.location.href).searchParams;
            const urlRef = normalize(params.get('ref'));
            if (urlRef) {
                writeStorage(urlRef);
                setRef(urlRef);
                return;
            }
            // No URL value — try stored value first (sync), then await
            // the runtime default from /api/config (async).
            const stored = readStorage();
            if (stored) {
                setRef(stored);
                return;
            }
            // Set whatever we have synchronously (the cached runtime
            // default if a prior mount already populated it, else null),
            // then upgrade asynchronously once the fetch resolves.
            setRef(runtimeDefault);
            void fetchRuntimeDefault().then((v) => {
                if (cancelled) return;
                // Only overwrite if no URL/storage value arrived in the
                // meantime (e.g., from a popstate event after we set null).
                const live = normalize(
                    new URL(window.location.href).searchParams.get('ref'),
                );
                if (live || readStorage()) return;
                setRef(v);
            });
        };

        resolve();

        // SPA navigation listeners. The browser's `popstate` fires on
        // back/forward; client-side `router.push`-style changes also flow
        // through the `History` API, so monkey-patch pushState/replaceState
        // to re-resolve. Clean up on unmount.
        const onPop = () => resolve();
        window.addEventListener('popstate', onPop);
        const origPush = window.history.pushState;
        const origReplace = window.history.replaceState;
        window.history.pushState = function patchedPush(...args) {
            const r = origPush.apply(this, args);
            resolve();
            return r;
        };
        window.history.replaceState = function patchedReplace(...args) {
            const r = origReplace.apply(this, args);
            resolve();
            return r;
        };
        return () => {
            cancelled = true;
            window.removeEventListener('popstate', onPop);
            window.history.pushState = origPush;
            window.history.replaceState = origReplace;
        };
    }, []);

    return ref;
}

/** Imperative read of the stored referrer outside React component tree. */
export function getStoredReferrer(): `0x${string}` | null {
    return readStorage();
}

/** Imperative clear — for a "stop using referrer" UI button. */
export function clearStoredReferrer(): void {
    writeStorage(null);
}
