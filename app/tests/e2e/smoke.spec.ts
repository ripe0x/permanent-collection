/**
 * Phase 1 smoke test (issue #88).
 *
 * Two load-bearing assertions:
 *
 *   1. Home page renders against fork-mode chain reads — proves anvil
 *      came up, Deploy.s.sol ran, addresses synced into app/.env.local,
 *      ForkAdapter is wired, dev server compiled, and an SSR + client-side
 *      read against Patron.bidBalance() returns the value we just seeded.
 *
 *   2. Connect flow works through the mock provider — proves the provider
 *      injected before React mount, RainbowKit's wallet discovery picked
 *      it up, eth_requestAccounts resolved, and wagmi state propagated to
 *      the ConnectButton's connected-state UI.
 *
 * Tests must FAIL LOUD when preconditions are missing (anvil down, deploy
 * incomplete, provider not injected). Standing rule [[feedback_test_fail_loud]].
 *
 * The run-3x-in-a-row local verification step (see docs/E2E_TESTING.md)
 * shakes out flakes against a shared, persistent fork; the in-suite
 * structure here is deliberately straight-through.
 */

import {E2E_ENV} from './fixtures/env';
import {e2eTest, expect} from './fixtures/renderer';
import {topUpPatron} from './fixtures/seed';

const SEED_PATRON_ETH = '30';

e2eTest.describe('Phase 1 smoke', () => {
    e2eTest('home page renders fork-mode state and connect works', async ({page, state}) => {
        // ── Precondition: top up Patron so the SSR-seeded live bid is
        // non-zero. Doing this BEFORE the navigation means the first
        // server render already reflects the funded value — no race with
        // LiveBidStat's polling refresh.
        await topUpPatron(state.deployments.patron, SEED_PATRON_ETH);

        // ── 1. Home page renders ───────────────────────────────────
        const consoleErrors: string[] = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        await page.goto('/');

        // Both Hero and Footer render a `Live bid` aria-labelled section.
        // Target the Hero one — it's the page's primary headline figure
        // and the first one in DOM order, so .first() is deterministic.
        const liveBidSection = page.getByLabel('Live bid').first();
        await expect(liveBidSection).toBeVisible();

        // The SSR-seeded value is whatever Patron.bidBalance() returned
        // at request time. We funded Patron with exactly 30 ETH right
        // before the navigation; formatEth() renders "30 ETH" at the
        // 3-decimal default. Don't match on the exact whitespace inside
        // the formatted number — the value may render across multiple
        // child spans (LiveBidStat's odometer animation).
        await expect(liveBidSection).toContainText(/30(\.\d+)?\s*ETH/);

        // ── 2. Mock provider was injected before React mount ──────
        // window.ethereum exists and reports our chain. If addInitScript's
        // pre-DOMContentLoaded guarantee broke, this would be undefined
        // because RainbowKit's discovery would have observed an empty
        // window.ethereum during initial bundle eval.
        const mockProviderHealthy = await page.evaluate(() => {
            const eth = (window as unknown as {ethereum?: {isMetaMask?: boolean; chainId?: string}})
                .ethereum;
            return {
                injected: !!eth,
                isMetaMask: !!eth?.isMetaMask,
                chainId: eth?.chainId,
            };
        });
        expect(mockProviderHealthy.injected).toBe(true);
        expect(mockProviderHealthy.isMetaMask).toBe(true);
        expect(mockProviderHealthy.chainId).toBe('0x7a69'); // 31337

        // ── 3. Connect flow ───────────────────────────────────────
        // Wagmi's autoConnect path discovers the injected provider on
        // mount and resolves a connection without any UI click. That's
        // the actual production code path for a wallet that's already
        // approved this dapp — so the test just verifies the END state.
        // (RainbowKit's modal click is the cold-start path; Phase 2's
        // acceptBid spec exercises the connect-modal path explicitly
        // by reloading on a clean storage state.)
        //
        // ConnectButton's connected-state markup carries
        // `aria-label="Connected as 0x..."`.
        const expectedAddr = E2E_ENV.testAccount.address;
        const connectedButton = page.getByRole('button', {
            name: new RegExp(`Connected as ${expectedAddr}`, 'i'),
        });
        await expect(connectedButton).toBeVisible({timeout: 15_000});

        // Belt-and-suspenders: verify no "Connect wallet" button is
        // visible anywhere on the page — i.e. the connected state is
        // canonical, not just present in one location while the header
        // is still showing the disconnected button. A logic bug in the
        // mock provider (e.g. returning [] from eth_accounts instead
        // of [testAddress]) would leave Connect buttons visible.
        await expect(
            page.getByRole('button', {name: 'Connect wallet'}),
        ).toHaveCount(0);

        // No console errors during the whole flow.
        // Allow known-noisy network-fetch logs (the /api/eligibility 404
        // hits before a Punk is picked) but flag anything else.
        const failingErrors = consoleErrors.filter(
            (msg) =>
                !msg.includes('/api/eligibility') &&
                !msg.includes('Failed to load resource'),
        );
        expect(failingErrors).toEqual([]);
    });
});
