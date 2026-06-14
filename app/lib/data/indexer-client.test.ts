/* Fail-loud contract for the indexer client (the INDEXER_URL incident of
 * 2026-06-12: the env var was missing in production, every query silently
 * fell back to the dev-default localhost URL, and the per-slice fallbacks
 * rendered empty states indistinguishable from "no activity yet" for days).
 *
 * The rules under test:
 *   - dev / test runtimes default to localhost (unchanged behavior)
 *   - a production runtime serving a LIVE protocol with no INDEXER_URL
 *     throws IndexerUrlMissingError and marks the indexer degraded
 *   - pre-launch production (no token) keeps the quiet default — the
 *     indexer is required exactly when the protocol is live
 *   - `next build` (NEXT_PHASE=phase-production-build) never throws, so CI
 *     builds without runtime env stay green
 *
 * Modules are re-imported per test because the degraded flag is module-level
 * state and the env is read at call time.
 */

import {afterEach, describe, expect, it, vi} from 'vitest';

// A syntactically valid, non-zero token address — isProtocolLive() === true.
const LIVE_TOKEN = '0x61C9d89f7Fd6229da8dD09b1EFA4Bc9B47C0CD70';
const DEFAULT_DEV_URL = 'http://127.0.0.1:42069';

async function importFresh() {
    vi.resetModules();
    return import('./indexer-client');
}

function stubLiveProtocol() {
    // jsdom test env: isProtocolLive() takes the window branch and reads
    // NEXT_PUBLIC_TOKEN_ADDRESS when no runtime config is injected.
    vi.stubEnv('NEXT_PUBLIC_TOKEN_ADDRESS', LIVE_TOKEN);
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('getIndexerUrl', () => {
    it('returns INDEXER_URL verbatim when set', async () => {
        vi.stubEnv('INDEXER_URL', 'https://indexer.example.com');
        const mod = await importFresh();
        expect(mod.getIndexerUrl()).toBe('https://indexer.example.com');
    });

    it('defaults to localhost outside production', async () => {
        const mod = await importFresh();
        expect(mod.getIndexerUrl()).toBe(DEFAULT_DEV_URL);
    });

    it('throws IndexerUrlMissingError in production with a live protocol and no INDEXER_URL', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        stubLiveProtocol();
        const mod = await importFresh();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => mod.getIndexerUrl()).toThrowError(mod.IndexerUrlMissingError);
        // Loud on each call, and the health flag is set so the UI can mark
        // indexer-backed surfaces degraded even if a caller swallows the throw.
        expect(errorSpy).toHaveBeenCalled();
        expect(mod.isIndexerDegraded()).toBe(true);
    });

    it('keeps the quiet localhost default in production pre-launch (protocol not live)', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const mod = await importFresh();
        expect(mod.getIndexerUrl()).toBe(DEFAULT_DEV_URL);
        expect(mod.isIndexerDegraded()).toBe(false);
    });

    it('never throws during next build, even live-without-indexer (CI builds have no runtime env)', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('NEXT_PHASE', 'phase-production-build');
        stubLiveProtocol();
        const mod = await importFresh();
        expect(mod.getIndexerUrl()).toBe(DEFAULT_DEV_URL);
    });
});

describe('assertIndexerConfigured (the instrumentation.ts boot gate)', () => {
    it('throws when production + live + no INDEXER_URL', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        stubLiveProtocol();
        const mod = await importFresh();
        expect(() => mod.assertIndexerConfigured()).toThrowError(mod.IndexerUrlMissingError);
    });

    it('passes when INDEXER_URL is set', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        stubLiveProtocol();
        vi.stubEnv('INDEXER_URL', 'https://indexer.example.com');
        const mod = await importFresh();
        expect(() => mod.assertIndexerConfigured()).not.toThrow();
    });

    it('passes pre-launch and in dev', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const preLaunch = await importFresh();
        expect(() => preLaunch.assertIndexerConfigured()).not.toThrow();

        vi.unstubAllEnvs();
        stubLiveProtocol();
        const dev = await importFresh();
        expect(() => dev.assertIndexerConfigured()).not.toThrow();
    });
});

describe('rethrowIfIndexerMisconfigured', () => {
    it('rethrows only the misconfiguration error, never outage errors', async () => {
        const mod = await importFresh();
        const misconfig = new mod.IndexerUrlMissingError();
        expect(() => mod.rethrowIfIndexerMisconfigured(misconfig)).toThrowError(misconfig);
        expect(() => mod.rethrowIfIndexerMisconfigured(new Error('ECONNREFUSED'))).not.toThrow();
        expect(() => mod.rethrowIfIndexerMisconfigured('not even an error')).not.toThrow();
    });
});

describe('degraded tracking through the wrapped client', () => {
    it('starts healthy', async () => {
        const mod = await importFresh();
        expect(mod.isIndexerDegraded()).toBe(false);
    });

    it('marks degraded + logs when a query fails at the transport level', async () => {
        // Point at a port nothing listens on — a real ECONNREFUSED, the exact
        // failure mode of the incident.
        vi.stubEnv('INDEXER_URL', 'http://127.0.0.1:59999');
        const mod = await importFresh();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(
            mod.getIndexerClient().request('{ protocolCounter(id: "global") { vaultedCount } }'),
        ).rejects.toThrow();
        expect(mod.isIndexerDegraded()).toBe(true);
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('[indexer] query failed'),
        );
    });
});
