/**
 * Phase 3 spec — PlaceBidPanel (issue #88).
 *
 * `PlaceBidPanel` (`app/components/PlaceBidPanel.tsx`) is a thin
 * wrapper around the shared `BidComposer` that fires
 * `ReturnAuctionModule.bid(uint16 punkId)` with `value = amount`.
 * Rendered inside `/auction/[punkId]`.
 *
 * To exercise the panel we need an active return auction. Anvil
 * account #2 acts as a Punk owner who pre-lists + acceptBid's into
 * the protocol, starting the 72h auction. The test EOA then bids.
 *
 * Two tests:
 *   1. Happy path — place a bid above reserve, assert `highBidWei` +
 *      `highBidder` updated on-chain.
 *   2. User rejection — decline the wallet signing, assert "You
 *      declined in your wallet." surfaces and `highBidWei` unchanged.
 */

import {createPublicClient, http, parseAbi, parseEther} from 'viem';
import type {Address} from 'viem';
import {E2E_ENV} from './fixtures/env';
import {e2eTest, expect} from './fixtures/renderer';
import {
    callAcceptBidAs,
    canonicalTargetOf,
    fundTestEoa,
    preListToPatron,
    setNextBlockTimestamp,
    topUpPatron,
    transferPunkToRecipient,
} from './fixtures/seed';

// Distinct Punks per test — see Phase 2 acceptBid.spec.ts comment on
// shared-anvil state for the rationale.
const PUNK_BID_HAPPY = 2100;
const PUNK_BID_REJECT = 2101;
const ANVIL_ACCOUNT_2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;

// Mirror of the on-chain `ReturnAuction` struct (see
// `contracts/src/ReturnAuctionModule.sol:206`). Order is load-bearing
// for viem's tuple decode.
const RAM_READ_ABI = [
    {
        type: 'function',
        name: 'getSale',
        stateMutability: 'view',
        inputs: [{name: 'punkId', type: 'uint16'}],
        outputs: [
            {
                type: 'tuple',
                components: [
                    {name: 'acquisitionCost', type: 'uint128'},
                    {name: 'highBidWei', type: 'uint128'},
                    {name: 'highBidder', type: 'address'},
                    {name: 'startedAt', type: 'uint64'},
                    {name: 'endsAt', type: 'uint64'},
                    {name: 'reserveWei', type: 'uint128'},
                    {name: 'targetTraitId', type: 'uint8'},
                    {name: 'settled', type: 'bool'},
                ],
            },
        ],
    },
] as const;

function rpc() {
    return createPublicClient({
        transport: http(`http://127.0.0.1:${E2E_ENV.anvilPort}`),
    });
}

interface SaleSnapshot {
    reserveWei: bigint;
    highBidWei: bigint;
    highBidder: Address;
}

async function readSale(ram: Address, punkId: number): Promise<SaleSnapshot> {
    const res = (await rpc().readContract({
        address: ram,
        abi: RAM_READ_ABI,
        functionName: 'getSale',
        args: [punkId],
    })) as {
        acquisitionCost: bigint;
        highBidWei: bigint;
        highBidder: Address;
        reserveWei: bigint;
    };
    return {
        reserveWei: res.reserveWei,
        highBidWei: res.highBidWei,
        highBidder: res.highBidder,
    };
}

async function seedAuction(state: {
    deployments: {patron: Address; permanentCollection: Address};
}, punkId: number): Promise<void> {
    // Anvil account #2 acts as the Punk owner who accepts the bid,
    // starting the auction. Test EOA then bids against it. The target is
    // protocol-derived: acceptBid reverts NotCanonicalTarget unless it
    // equals `canonicalTargetOf` (the rarest uncollected, non-pending trait
    // the Punk carries), so derive it live rather than picking a trait.
    await transferPunkToRecipient(punkId, ANVIL_ACCOUNT_2);
    const target = await canonicalTargetOf(state.deployments.permanentCollection, punkId);
    if (target === null) {
        throw new Error(
            `PUNK ${punkId} has no canonical target after prior tests — pick a different test Punk.`,
        );
    }
    await preListToPatron(punkId, ANVIL_ACCOUNT_2, state.deployments.patron);
    await callAcceptBidAs(state.deployments.patron, ANVIL_ACCOUNT_2, punkId, target);
}

e2eTest.describe('Phase 3: PlaceBidPanel', () => {
    e2eTest.beforeAll(async () => {
        // Bring anvil's chain time forward to wall-time. The fork is
        // pinned at block 25133816 (~7d behind wall), and
        // `app/app/auction/[punkId]/page.tsx` computes `nowSeconds`
        // as `Date.now() / 1000` (wall time) while the auction's
        // `endsAt` is `chainStartedAt + 72h` — chain time. Without
        // this jump, every fresh auction renders as closed
        // (page's `endsAt <= now` is `chain+72h <= wall-now`, which
        // is always true on a 7-day-behind fork). One-shot advance
        // for the whole describe block.
        await setNextBlockTimestamp(Math.floor(Date.now() / 1000));
    });

    e2eTest.beforeEach(async ({state}) => {
        await topUpPatron(state.deployments.patron, '30');
        // 10000 ETH default in anvil is plenty for a 30+ ETH bid, but
        // explicit reset is cheap and makes the suite robust to a
        // sufficiently expensive sequence of prior bids.
        await fundTestEoa('0');
    });

    e2eTest('happy path — bid above reserve lands as the new high', async ({page, state}) => {
        await seedAuction(state, PUNK_BID_HAPPY);
        const before = await readSale(state.deployments.returnAuctionModule, PUNK_BID_HAPPY);
        expect(before.reserveWei).toBeGreaterThan(0n);
        expect(before.highBidWei).toBe(0n);

        await page.goto(`/auction/${PUNK_BID_HAPPY}`);
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${E2E_ENV.testAccount.address}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        // The bid panel is scoped under "Place a bid" aria-label.
        const panel = page.getByRole('complementary', {name: 'Place a bid'});
        await expect(panel).toBeVisible({timeout: 30_000});

        // Enter slightly above reserve. The reserve is acquisitionCost
        // × 1.01 = 30.3 ETH for a 30 ETH baseline. Bidding 32 ETH stays
        // well clear of any rounding.
        const bidEth = '32';
        const bidWei = parseEther(bidEth);
        expect(bidWei).toBeGreaterThan(before.reserveWei);

        await panel.getByLabel('Your bid').fill(bidEth);
        await panel.getByRole('button', {name: 'Place bid'}).click();

        // BidComposer's success message for return-auction is the
        // default — wait for the "Confirmed" button text + the on-chain
        // state to settle.
        await expect(panel.getByRole('button', {name: 'Confirmed'})).toBeVisible({
            timeout: 30_000,
        });

        const after = await readSale(state.deployments.returnAuctionModule, PUNK_BID_HAPPY);
        expect(after.highBidWei).toBe(bidWei);
        expect(after.highBidder.toLowerCase()).toBe(
            E2E_ENV.testAccount.address.toLowerCase(),
        );
    });

    e2eTest('user rejection — decline surfaces "You declined" and high bid unchanged', async ({page, state}) => {
        await seedAuction(state, PUNK_BID_REJECT);
        const before = await readSale(state.deployments.returnAuctionModule, PUNK_BID_REJECT);

        await page.goto(`/auction/${PUNK_BID_REJECT}`);
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${E2E_ENV.testAccount.address}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        const panel = page.getByRole('complementary', {name: 'Place a bid'});
        await expect(panel).toBeVisible({timeout: 30_000});

        await panel.getByLabel('Your bid').fill('32');

        await page.evaluate(() => {
            if (!window.__mockProvider) throw new Error('mock provider missing');
            window.__mockProvider.setRejectNextTx(1);
        });

        await panel.getByRole('button', {name: 'Place bid'}).click();

        await expect(panel.getByText('You declined in your wallet.')).toBeVisible({
            timeout: 15_000,
        });

        const after = await readSale(state.deployments.returnAuctionModule, PUNK_BID_REJECT);
        expect(after.highBidWei).toBe(before.highBidWei);
        expect(after.highBidder).toBe(before.highBidder);
    });
});
