/**
 * Phase 3 spec — LiveBidSweepMover (issue #88).
 *
 * `LiveBidSweepMover` (lives inside `app/components/LiveBidStat.tsx`) is
 * the permissionless "move pending → live" affordance on `/trade`. Calls
 * `LiveBidAdapter.sweep()` to forward accumulated fee ETH up to Patron
 * (caller earns a small keeper reward, capped per spec).
 *
 * Two tests:
 *   1. Happy path — seed `LiveBidAdapter`'s balance via anvil's
 *      `setBalance`, navigate to `/trade`, click "↓ Sweep now", wait for
 *      "✓ Swept", assert Patron's `bidBalance` increased and the adapter
 *      drained (modulo the keeper reward kept by the test EOA).
 *   2. User rejection — same setup, arm `setRejectNextTx(1)`, click
 *      sweep, expect "You declined in your wallet." in the error chip.
 *
 * Note on test ordering: `LiveBidAdapter.sweep()` engages a
 * `minBlocksBetweenSweeps` cooldown the moment a successful sweep
 * lands. Running the happy-path test FIRST would cool down the next
 * test's sweep. We run rejection FIRST so the cooldown only kicks in
 * after the happy path; if Phase 3 ever adds a third sweep test, it
 * will need `anvil_mine` to step past the cooldown.
 */

import {createPublicClient, http, parseAbi, parseEther} from 'viem';
import type {Address} from 'viem';
import {E2E_ENV} from './fixtures/env';
import {e2eTest, expect} from './fixtures/renderer';
import {setBalance, topUpPatron} from './fixtures/seed';

const PATRON_READ_ABI = parseAbi([
    'function bidBalance() view returns (uint256)',
]);

function rpc() {
    return createPublicClient({
        transport: http(`http://127.0.0.1:${E2E_ENV.anvilPort}`),
    });
}

async function readBidBalance(patron: Address): Promise<bigint> {
    return (await rpc().readContract({
        address: patron,
        abi: PATRON_READ_ABI,
        functionName: 'bidBalance',
    })) as bigint;
}

async function readAdapterBalance(adapter: Address): Promise<bigint> {
    return rpc().getBalance({address: adapter});
}

e2eTest.describe('Phase 3: LiveBidSweepMover', () => {
    e2eTest.beforeEach(async ({state}) => {
        // Seed Patron's live bid so the sweep meters a fresh buffer on top of
        // an established bid (the production path). The adapter throttles every
        // sweep at the fixed rate cap regardless of the current bid level.
        await topUpPatron(state.deployments.patron, '30');
    });

    e2eTest('rejection — decline keeps pending ETH on the adapter', async ({page, state}) => {
        // Seed a known pending balance on the adapter so the mover renders.
        await setBalance(state.deployments.liveBidAdapter, '1');
        const adapterBefore = await readAdapterBalance(state.deployments.liveBidAdapter);
        expect(adapterBefore).toBe(parseEther('1'));

        await page.goto('/trade');
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${E2E_ENV.testAccount.address}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        // The mover is an aside labelled "Pending vs. live bid"; its
        // primary action is the "↓ Sweep now" button when pending > 0.
        const mover = page.getByRole('complementary', {name: 'Pending vs. live bid'});
        await expect(mover).toBeVisible({timeout: 30_000});

        await page.evaluate(() => {
            if (!window.__mockProvider) throw new Error('mock provider missing');
            window.__mockProvider.setRejectNextTx(1);
        });

        await page.getByRole('button', {name: '↓ Sweep now'}).click();

        // The mover's error chip surfaces the classifyError() output.
        // The 48-char truncation in the component cuts the message tail,
        // so match on the leading "You declined" prefix.
        await expect(mover.getByText(/You declined in your wallet\./)).toBeVisible({
            timeout: 15_000,
        });

        const adapterAfter = await readAdapterBalance(state.deployments.liveBidAdapter);
        expect(adapterAfter).toBe(adapterBefore);
    });

    e2eTest('happy path — sweep moves pending into Patron', async ({state, page}) => {
        // Top up adapter again — prior test left adapter at 1 ETH but
        // also may have run side effects.
        await setBalance(state.deployments.liveBidAdapter, '1');
        const adapterBefore = await readAdapterBalance(state.deployments.liveBidAdapter);
        const patronBefore = await readBidBalance(state.deployments.patron);

        await page.goto('/trade');
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${E2E_ENV.testAccount.address}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        const mover = page.getByRole('complementary', {name: 'Pending vs. live bid'});
        await expect(mover).toBeVisible({timeout: 30_000});
        await page.getByRole('button', {name: '↓ Sweep now'}).click();

        // Successful sweep flips the action area to "✓ Swept" + view-tx
        // link. The button is reused (text becomes "↓ Sweep now" again
        // once pending=0 after refetch), so anchor on the success badge.
        await expect(mover.getByText('✓ Swept', {exact: false})).toBeVisible({
            timeout: 30_000,
        });

        const adapterAfter = await readAdapterBalance(state.deployments.liveBidAdapter);
        const patronAfter = await readBidBalance(state.deployments.patron);

        // Adapter drained (POL diversion + keeper reward may leave a
        // small dust amount but the bulk of the 1 ETH moved out).
        expect(adapterAfter).toBeLessThan(adapterBefore);
        // Patron received the bulk of the inflow.
        expect(patronAfter).toBeGreaterThan(patronBefore);
    });
});
