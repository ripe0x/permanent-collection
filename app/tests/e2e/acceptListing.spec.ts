/**
 * Phase 3 spec — PunkStrategyListings (issue #88).
 *
 * `PunkStrategyListings` (`app/components/PunkStrategyListings.tsx`)
 * surfaces public 2017-market listings by allowlisted sellers
 * (PunkStrategy at launch). Visitors accept a listing into the protocol
 * via `Patron.acceptListing(punkId, targetTraitId)` — caller earns the
 * finder fee.
 *
 * Setup: PunkStrategy (0xc50673…64E33eDF) is allowlisted at
 * `Deploy.s.sol:172` and its allowlist activeAt was set 24h after the
 * deploy block. Since the fork is at block 25133816 (~7 days ago wall
 * time), wall-time NOW is well past activeAt — the fork adapter
 * surfaces the seller as active. We impersonate PunkStrategy, transfer
 * a Punk in, then `offerPunkForSale` for a price ≤ Patron's live bid.
 *
 * Two tests:
 *   1. Happy path — click accept on the rendered row, assert
 *      `acquisitionCount` bumped and `custodyOf == InReturnAuction`.
 *   2. User rejection — decline at the wallet, no chain state change.
 */

import {createPublicClient, http, parseAbi} from 'viem';
import type {Address} from 'viem';
import {E2E_ENV} from './fixtures/env';
import {e2eTest, expect} from './fixtures/renderer';
import {
    advanceTime,
    publicListPunk,
    topUpPatron,
    transferPunkToRecipient,
} from './fixtures/seed';

// PunkStrategy mainnet address — also hard-coded in
// `contracts/script/Deploy.s.sol:172` as the launch allowlisted seller.
const PUNK_STRATEGY = '0xc50673EDb3A7b94E8CAD8a7d4E0cD68864E33eDF' as Address;

// Distinct Punks per test — Phase 2 pattern.
const PUNK_LIST_HAPPY = 3000;
const PUNK_LIST_REJECT = 3001;

const PC_READ_ABI = parseAbi([
    'function acquisitionCount() view returns (uint256)',
    'function custodyOf(uint16) view returns (uint8)',
]);

const CUSTODY_IN_RETURN_AUCTION = 1;

function rpc() {
    return createPublicClient({
        transport: http(`http://127.0.0.1:${E2E_ENV.anvilPort}`),
    });
}

async function readAcquisitionCount(pc: Address): Promise<bigint> {
    return (await rpc().readContract({
        address: pc,
        abi: PC_READ_ABI,
        functionName: 'acquisitionCount',
    })) as bigint;
}

async function readCustody(pc: Address, punkId: number): Promise<number> {
    return (await rpc().readContract({
        address: pc,
        abi: PC_READ_ABI,
        functionName: 'custodyOf',
        args: [punkId],
    })) as number;
}

async function seedListing(state: {deployments: {patron: Address}}, punkId: number) {
    // Stage a public listing from PunkStrategy at 5 ETH. Patron sits at
    // 30 ETH per beforeEach, so the listing is well below the live bid
    // (a precondition for the fork adapter to surface it).
    await transferPunkToRecipient(punkId, PUNK_STRATEGY);
    await publicListPunk(PUNK_STRATEGY, punkId, '5');
}

e2eTest.describe('Phase 3: PunkStrategyListings', () => {
    e2eTest.beforeAll(async () => {
        // Patron.allowedSellerActiveAt for PunkStrategy was set at
        // deploy time to (chainTimestamp + 24h). The fork's chain time
        // is ~7d behind wall time, so activeAt sits ~6d in the future
        // relative to current chain time (block.timestamp). Without
        // advancing chain time past activeAt, on-chain acceptListing
        // reverts even though the fork data adapter (which uses
        // wall-time for the same gate, a known fork-adapter
        // approximation) happily surfaces the listing. One-shot
        // advance for the whole describe block — subsequent tests
        // inherit the warmed-forward clock.
        await advanceTime(25 * 60 * 60);
    });

    e2eTest.beforeEach(async ({state}) => {
        await topUpPatron(state.deployments.patron, '30');
    });

    e2eTest('happy path — accept listing records acquisition + flips custody', async ({page, state}) => {
        await seedListing(state, PUNK_LIST_HAPPY);
        const before = {
            acquisitionCount: await readAcquisitionCount(state.deployments.permanentCollection),
            custody: await readCustody(state.deployments.permanentCollection, PUNK_LIST_HAPPY),
        };

        await page.goto('/');
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${E2E_ENV.testAccount.address}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        // Listings panel + a row for our Punk. A listed Punk now appears under
        // exactly ONE trait group — its protocol-derived canonical target (the
        // rarest uncollected, non-pending trait it carries) — since
        // `acceptListing` reverts `TargetNotCanonical` for anything else. So
        // there's a single row; the group's traitId is the canonical target the
        // accept button sends.
        const panel = page.getByRole('region', {name: 'Traits from public listings'});
        await expect(panel).toBeVisible({timeout: 30_000});
        const row = panel.locator('.ps-listings-row').filter({hasText: `#${PUNK_LIST_HAPPY}`}).first();
        await expect(row).toBeVisible({timeout: 30_000});

        // The accept button text is lowercase "accept" in idle.
        await row.getByRole('button', {name: 'accept'}).click();

        // "accepted" button text replaces "accept" / "confirming…" on
        // receipt success.
        await expect(row.getByRole('button', {name: 'accepted'})).toBeVisible({
            timeout: 30_000,
        });

        const after = {
            acquisitionCount: await readAcquisitionCount(state.deployments.permanentCollection),
            custody: await readCustody(state.deployments.permanentCollection, PUNK_LIST_HAPPY),
        };
        expect(after.acquisitionCount).toBe(before.acquisitionCount + 1n);
        expect(after.custody).toBe(CUSTODY_IN_RETURN_AUCTION);
    });

    e2eTest('user rejection — decline leaves listing in place, no acquisition recorded', async ({page, state}) => {
        await seedListing(state, PUNK_LIST_REJECT);
        const before = {
            acquisitionCount: await readAcquisitionCount(state.deployments.permanentCollection),
            custody: await readCustody(state.deployments.permanentCollection, PUNK_LIST_REJECT),
        };

        await page.goto('/');
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${E2E_ENV.testAccount.address}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        const panel = page.getByRole('region', {name: 'Traits from public listings'});
        await expect(panel).toBeVisible({timeout: 30_000});
        const row = panel.locator('.ps-listings-row').filter({hasText: `#${PUNK_LIST_REJECT}`}).first();
        await expect(row).toBeVisible({timeout: 30_000});

        await page.evaluate(() => {
            if (!window.__mockProvider) throw new Error('mock provider missing');
            window.__mockProvider.setRejectNextTx(1);
        });

        await row.getByRole('button', {name: 'accept'}).click();

        // The error message gets truncated to 220px max-width in the
        // row's error span; just confirm the failure state surfaced
        // SOMETHING and the button didn't transition to "accepted".
        await expect(row.locator('.ps-listings-error')).toBeVisible({timeout: 15_000});
        await expect(row.getByRole('button', {name: 'accepted'})).toHaveCount(0);

        const after = {
            acquisitionCount: await readAcquisitionCount(state.deployments.permanentCollection),
            custody: await readCustody(state.deployments.permanentCollection, PUNK_LIST_REJECT),
        };
        expect(after.acquisitionCount).toBe(before.acquisitionCount);
        expect(after.custody).toBe(before.custody);
    });
});
