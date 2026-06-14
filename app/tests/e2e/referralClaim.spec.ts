/**
 * Phase 3 spec — ReferralClaim (issue #88).
 *
 * `app/components/ReferralClaim.tsx` is the connected-wallet referrer
 * dashboard at `/referrals`. One write surface:
 *   - "Claim ETH": `ReferralPayout.claim()` — pulls the referrer's
 *     accrued balance to their wallet. (Under the fresh-only settlement
 *     the hook auto-flushes per swap, so there is no separate drain
 *     step — the old `flushReferral` surface was removed.)
 *
 * We seed a non-zero balance via `seedReferralBalance`, which
 * impersonates the hook (the only authorized caller of `notify`) and
 * forwards ETH. This bypasses the production path (referral attribution
 * credited on a real swap that carries a referrer) so the test doesn't
 * need to first route an attributed swap.
 *
 * Two tests:
 *   1. Happy path — seeded 0.5 ETH balance, click Claim, assert UI
 *      shows "Claimed." and `balances(testEoa) == 0`.
 *   2. User rejection — same seed, decline at the wallet, balance still
 *      0.5 ETH on-chain.
 */

import {createPublicClient, http, parseAbi, parseEther} from 'viem';
import type {Address} from 'viem';
import {E2E_ENV} from './fixtures/env';
import {e2eTest, expect} from './fixtures/renderer';
import {seedReferralBalance} from './fixtures/seed';

const REFERRAL_READ_ABI = parseAbi([
    'function balances(address) view returns (uint256)',
]);

function rpc() {
    return createPublicClient({
        transport: http(`http://127.0.0.1:${E2E_ENV.anvilPort}`),
    });
}

async function readReferralBalance(
    referralPayout: Address,
    addr: Address,
): Promise<bigint> {
    return (await rpc().readContract({
        address: referralPayout,
        abi: REFERRAL_READ_ABI,
        functionName: 'balances',
        args: [addr],
    })) as bigint;
}

e2eTest.describe('Phase 3: ReferralClaim', () => {
    e2eTest('happy path — claim drains the ledger balance', async ({page, state}) => {
        const testEoa = E2E_ENV.testAccount.address as Address;
        await seedReferralBalance(
            state.deployments.referralPayout,
            state.deployments.hook,
            testEoa,
            '0.5',
        );

        const balBefore = await readReferralBalance(state.deployments.referralPayout, testEoa);
        expect(balBefore).toBe(parseEther('0.5'));

        await page.goto('/referrals');
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${testEoa}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        // "Ready to claim" row's value reflects the on-chain balance
        // via the /api/referral endpoint (chain-direct on the fork).
        // formatEthBare trims trailing zeros, so 0.5 ETH renders as "0.5".
        await expect(page.getByText(/0\.5/)).toBeVisible({timeout: 30_000});

        // ── Share surface ──────────────────────────────────────────
        // The connected dashboard renders the ReferralShare widget: the
        // referral link plus a copy button. The link's origin varies by
        // env, so assert on the stable `?ref=<address>` tail.
        await expect(
            page.getByText(new RegExp(`/trade\\?ref=${testEoa}`, 'i')),
        ).toBeVisible({timeout: 15_000});

        // Copy writes the link and flips the button to a "Copied" state.
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        const copyBtn = page.getByRole('button', {name: /^copy$/i});
        await copyBtn.click();
        await expect(
            page.getByRole('button', {name: /copied/i}),
        ).toBeVisible({timeout: 5_000});
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toContain(`/trade?ref=${testEoa}`);

        const claimBtn = page.getByRole('button', {name: 'Claim ETH'});
        await expect(claimBtn).toBeEnabled({timeout: 30_000});
        await claimBtn.click();

        // Success line appears with a tx link.
        await expect(page.getByText('Claimed.')).toBeVisible({timeout: 30_000});

        const balAfter = await readReferralBalance(state.deployments.referralPayout, testEoa);
        expect(balAfter).toBe(0n);
    });

    e2eTest('user rejection — decline preserves the ledger balance', async ({page, state}) => {
        const testEoa = E2E_ENV.testAccount.address as Address;
        await seedReferralBalance(
            state.deployments.referralPayout,
            state.deployments.hook,
            testEoa,
            '0.5',
        );

        const balBefore = await readReferralBalance(state.deployments.referralPayout, testEoa);
        expect(balBefore).toBe(parseEther('0.5'));

        await page.goto('/referrals');
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${testEoa}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        const claimBtn = page.getByRole('button', {name: 'Claim ETH'});
        await expect(claimBtn).toBeEnabled({timeout: 30_000});

        await page.evaluate(() => {
            if (!window.__mockProvider) throw new Error('mock provider missing');
            window.__mockProvider.setRejectNextTx(1);
        });

        await claimBtn.click();

        // ReferralClaim's classifyError walks the viem cause chain for
        // shortMessage. EIP-1193 4001 shows up as "User rejected the
        // request." in viem's shortMessage — match a permissive prefix.
        await expect(
            page.getByText(/User rejected|user denied|declined/i),
        ).toBeVisible({timeout: 15_000});

        const balAfter = await readReferralBalance(state.deployments.referralPayout, testEoa);
        expect(balAfter).toBe(balBefore);
    });
});
