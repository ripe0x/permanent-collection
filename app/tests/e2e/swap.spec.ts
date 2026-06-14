/**
 * Phase 3 spec — SwapBox (issue #88).
 *
 * `SwapBox` (`app/components/SwapBox.tsx`) drives the V4 pool through
 * Uniswap's Universal Router + Permit2. Two flows:
 *   - Buy: 1 tx — pays ETH, receives $111 (no Permit2 sig needed).
 *   - Sell: 2 tx (1 sig + 1 tx) — Permit2 typed-data sig + Router exec.
 *
 * Scope of this spec: BUY only. The sell path adds Permit2 typed-data
 * signing + token-allowance handling and warrants its own pass once
 * Phase 2's mock provider is exercised against a typed-data signing
 * call (currently personal_sign / eth_signTypedData_v4 are pass-through
 * to anvil but untested end-to-end with the swap path).
 *
 * Two tests:
 *   1. Happy path — buy 0.1 ETH of $111, assert the success card
 *      appears and `IERC20.balanceOf(testEoa)` increased on-chain.
 *   2. User rejection — decline the wallet send, assert error notice
 *      surfaces and token balance unchanged.
 */

import {createPublicClient, http, parseAbi} from 'viem';
import type {Address} from 'viem';
import {E2E_ENV} from './fixtures/env';
import {e2eTest, expect} from './fixtures/renderer';

const ERC20_READ_ABI = parseAbi([
    'function balanceOf(address) view returns (uint256)',
]);

function rpc() {
    return createPublicClient({
        transport: http(`http://127.0.0.1:${E2E_ENV.anvilPort}`),
    });
}

async function readTokenBalance(token: Address, holder: Address): Promise<bigint> {
    return (await rpc().readContract({
        address: token,
        abi: ERC20_READ_ABI,
        functionName: 'balanceOf',
        args: [holder],
    })) as bigint;
}

e2eTest.describe('Phase 3: SwapBox', () => {
    e2eTest('happy path — buy 0.1 ETH of $111 lands tokens in the test EOA', async ({page, state}) => {
        const testEoa = E2E_ENV.testAccount.address as Address;
        const before = await readTokenBalance(state.deployments.token, testEoa);

        await page.goto('/trade');
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${testEoa}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        // Default to the buy tab (it's the first tab in DOM order).
        await expect(page.getByRole('tab', {name: /Buy/})).toHaveAttribute(
            'aria-selected',
            'true',
        );

        // Enter 0.1 ETH and wait for the quote to populate the readonly
        // "You receive" line. The amount input is labelled "You pay".
        await page.getByLabel('You pay').fill('0.1');

        // Wait for the primary button to flip out of "Quoting…" into
        // "Buy $111" — that gates the Submit click.
        const submit = page.getByRole('button', {name: /^Buy\s/});
        await expect(submit).toBeEnabled({timeout: 30_000});
        await submit.click();

        // Success card has role="status" and contains "Swap successful".
        await expect(
            page.getByRole('status').filter({hasText: 'Swap successful'}),
        ).toBeVisible({timeout: 60_000});

        const after = await readTokenBalance(state.deployments.token, testEoa);
        expect(after).toBeGreaterThan(before);
    });

    e2eTest('user rejection — decline aborts the swap, token balance unchanged', async ({page, state}) => {
        const testEoa = E2E_ENV.testAccount.address as Address;
        const before = await readTokenBalance(state.deployments.token, testEoa);

        await page.goto('/trade');
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${testEoa}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        await page.getByLabel('You pay').fill('0.05');
        const submit = page.getByRole('button', {name: /^Buy\s/});
        await expect(submit).toBeEnabled({timeout: 30_000});

        await page.evaluate(() => {
            if (!window.__mockProvider) throw new Error('mock provider missing');
            window.__mockProvider.setRejectNextTx(1);
        });

        await submit.click();

        // The error notice (SwapErrorNotice) appears in the status div.
        // viem surfaces user-rejected as "User rejected the request" in
        // shortMessage; the notice text may be wrapped or summarized,
        // so match either phrasing.
        await expect(
            page.getByText(/User rejected|declined|denied/i).first(),
        ).toBeVisible({timeout: 15_000});

        // Success card MUST NOT appear.
        await expect(
            page.getByRole('status').filter({hasText: 'Swap successful'}),
        ).toHaveCount(0);

        const after = await readTokenBalance(state.deployments.token, testEoa);
        expect(after).toBe(before);
    });
});
