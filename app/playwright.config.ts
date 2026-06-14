/**
 * Playwright configuration for the Layer 2 e2e harness (issue #88).
 *
 * Scope of Phase 1:
 *   - Chromium only. The frontend's wallet path is browser-API-heavy
 *     (window.ethereum, EIP-6963 events, EIP-5792 wallet_sendCalls) — we
 *     verify behavior in one engine. WebKit / Firefox can be added in a
 *     future phase if we end up shipping wallet code that meaningfully
 *     diverges per engine.
 *   - parallel: false. Every test shares one anvil fork; running specs
 *     in parallel against shared chain state would race on nonces +
 *     custody + bid balance. Cheaper than per-spec snapshot/revert
 *     bookkeeping at Phase 1 scale.
 *   - Tests live under `tests/e2e/`. The Next app's tsconfig already
 *     globs `**\/*.ts` so they typecheck under `pnpm typecheck` without
 *     extra config.
 *
 * Decisions locked in `docs/E2E_TESTING.md`:
 *   - FORK_BLOCK pinned (defaults to .env.example's 25133816). Bump
 *     in a dedicated PR every ~4 weeks.
 *   - Anvil on E2E_ANVIL_PORT (default 8645) — separate from dev's 8545.
 *   - Next dev server on E2E_APP_PORT (default 3100) — separate from 3000.
 *   - Fork upstream is the Tenderly public gateway (no paid keys in CI).
 */

import {defineConfig, devices} from '@playwright/test';

const APP_PORT = Number(process.env.E2E_APP_PORT ?? '3100');

export default defineConfig({
    testDir: './tests/e2e',
    testMatch: /.*\.spec\.ts$/,
    // Bring up the anvil fork once, share it across the (currently single)
    // smoke spec. The Next dev server is started here so Playwright owns
    // its lifecycle and tears it down cleanly on test failure / Ctrl-C.
    globalSetup: './tests/e2e/fixtures/globalSetup.ts',
    globalTeardown: './tests/e2e/fixtures/globalTeardown.ts',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: !!process.env.CI,
    // Cold anvil + Deploy.s.sol + Next compile ≈ 60s on a warm cache; CI
    // pays an extra ~30s on the first run while the Foundry RPC cache
    // populates. Per-test budget needs headroom for the /api/owned-punks
    // 10k-slot Multicall3 scan against anvil — 30-90s on a cold working
    // set, ~1-5s warm. 240s per test gives room for cold + UI + receipt
    // without hiding genuine hangs.
    timeout: 240_000,
    expect: {
        timeout: 15_000,
    },
    reporter: process.env.CI
        ? [['list'], ['html', {open: 'never', outputFolder: 'playwright-report'}]]
        : [['list']],
    use: {
        baseURL: `http://127.0.0.1:${APP_PORT}`,
        // Trace on first retry — Phase 1 has retries=0, so this is functionally
        // "trace on failure" without paying the cost on every run.
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off',
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
    },
    projects: [
        {
            name: 'chromium',
            use: {...devices['Desktop Chrome']},
        },
    ],
});
