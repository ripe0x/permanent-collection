/**
 * Phase 3 spec — Title Auction (issue #88).
 *
 * Covers `TitleBidPanel` (`app/components/TitleBidPanel.tsx`) plus the
 * action surfaces in `useTitleAuctionActions` (kickoff, settle,
 * withdrawProceeds, withdrawRefund). The TitleAuctionView at `/title`
 * orchestrates the phase: pre-threshold → kickoff-ready → live →
 * settleable → settled.
 *
 * Precondition for kickoff: `PermanentCollection.collectedCount()
 * >= KICKOFF_THRESHOLD` (22 traits collected). The natural path requires
 * vaulting 22 Punks, which is impractical for an e2e test (each vault
 * needs a 72h auction window to silence-pass). We bypass via anvil's
 * `setStorageAt` on slot 4 of PermanentCollection — `collectedMask`
 * (confirmed via `forge inspect PermanentCollection storage-layout`).
 * Setting a 64-bit pattern gives `collectedCount() == 64`, satisfying
 * the threshold without affecting any other contract state.
 *
 * Two tests:
 *   1. Happy path — kickoff → bid → assert title minted, kickedOff
 *      flipped, highBidWei updated.
 *   2. User rejection — reject the bid signing, no state change on the
 *      auction.
 *
 * Settle / withdrawProceeds / withdrawRefund aren't exercised in this
 * spec — they require waiting out the 24h auction clock, which doubles
 * the spec runtime. `advanceTime(86_400)` works in principle; expand
 * coverage in a later spec if these surfaces start regressing.
 */

import {createPublicClient, http, parseAbi, parseEther} from 'viem';
import type {Address} from 'viem';
import {E2E_ENV} from './fixtures/env';
import {e2eTest, expect} from './fixtures/renderer';
import {setStorageAt, topUpPatron} from './fixtures/seed';

// Storage slot for `PermanentCollection.collectedMask` — confirmed via
// `forge inspect PermanentCollection storage-layout` against the
// current contract bytecode. If the storage layout ever shifts (e.g.
// new state variable added above `collectedMask`), this slot changes;
// the spec then fails loud because `isKickoffReady` stays false.
const COLLECTED_MASK_SLOT = '0x0000000000000000000000000000000000000000000000000000000000000004' as const;
// 64-bit low pattern → popcount 64 → kickoff threshold satisfied
// (needs collectedCount >= KICKOFF_THRESHOLD == 22).
const SIXTY_FOUR_BITS = '0x000000000000000000000000000000000000000000000000ffffffffffffffff' as const;

const TITLE_AUCTION_READ_ABI = parseAbi([
    'function kickedOff() view returns (bool)',
    'function highBidWei() view returns (uint128)',
    'function highBidder() view returns (address)',
]);

function rpc() {
    return createPublicClient({
        transport: http(`http://127.0.0.1:${E2E_ENV.anvilPort}`),
    });
}

interface AuctionSnapshot {
    kickedOff: boolean;
    highBidWei: bigint;
    highBidder: Address;
}

async function readAuctionState(titleAuction: Address): Promise<AuctionSnapshot> {
    const client = rpc();
    const [kickedOff, highBidWei, highBidder] = await Promise.all([
        client.readContract({
            address: titleAuction,
            abi: TITLE_AUCTION_READ_ABI,
            functionName: 'kickedOff',
        }) as Promise<boolean>,
        client.readContract({
            address: titleAuction,
            abi: TITLE_AUCTION_READ_ABI,
            functionName: 'highBidWei',
        }) as Promise<bigint>,
        client.readContract({
            address: titleAuction,
            abi: TITLE_AUCTION_READ_ABI,
            functionName: 'highBidder',
        }) as Promise<Address>,
    ]);
    return {kickedOff, highBidWei, highBidder};
}

e2eTest.describe('Phase 3: TitleAuction', () => {
    e2eTest.beforeEach(async ({state}) => {
        // Patron seed unused by these tests but keeps the suite's
        // shared "Patron at 30 ETH at start" invariant consistent.
        await topUpPatron(state.deployments.patron, '30');
    });

    e2eTest('happy path — kickoff + bid lands on chain', async ({page, state}) => {
        // Bypass the ≥56-traits-collected threshold by writing 64 bits
        // directly into PermanentCollection's collectedMask slot. The
        // contract's isKickoffReady() returns true; the rest of the
        // kickoff path (mintToAuction → ERC721 token id 111) runs
        // unaffected because the missing vaulted Punks are only a
        // PROVENANCE assertion, not a kickoff precondition.
        await setStorageAt(
            state.deployments.permanentCollection,
            COLLECTED_MASK_SLOT,
            SIXTY_FOUR_BITS,
        );

        const before = await readAuctionState(state.deployments.titleAuction);
        expect(before.kickedOff).toBe(false);

        await page.goto('/title');
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${E2E_ENV.testAccount.address}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        // The kickoff panel renders with aria-label "Start the Title Auction".
        const kickoffPanel = page.getByRole('complementary', {name: 'Start the Title Auction'});
        await expect(kickoffPanel).toBeVisible({timeout: 30_000});

        await kickoffPanel.getByRole('button', {name: 'Start the Title Auction'}).click();

        // Wait for the kickoff tx to clear the inline "Confirmed."
        // state line, then verify the on-chain flip before reloading.
        await expect(kickoffPanel.getByText('Confirmed.')).toBeVisible({timeout: 30_000});
        const afterKickoff = await readAuctionState(state.deployments.titleAuction);
        expect(afterKickoff.kickedOff).toBe(true);

        // TitleAuctionView SSRs its phase from the chain at request
        // time; the post-kickoff `live` phase only renders after a
        // fresh navigation. The view doesn't auto-refetch — that's the
        // documented launch behaviour (single page-load → static
        // phase), so a reload here mirrors what a real user would do.
        await page.reload();

        const bidPanel = page.getByRole('complementary', {name: 'Place a bid'});
        await expect(bidPanel).toBeVisible({timeout: 30_000});

        // First bid: any non-zero amount works (no reserve on first bid).
        await bidPanel.getByLabel('Your bid').fill('0.5');
        await bidPanel.getByRole('button', {name: 'Place bid'}).click();
        await expect(bidPanel.getByRole('button', {name: 'Confirmed'})).toBeVisible({
            timeout: 30_000,
        });

        const afterBid = await readAuctionState(state.deployments.titleAuction);
        expect(afterBid.highBidWei).toBe(parseEther('0.5'));
        expect(afterBid.highBidder.toLowerCase()).toBe(
            E2E_ENV.testAccount.address.toLowerCase(),
        );
    });

    e2eTest('user rejection — decline at bid keeps the previous high in place', async ({page, state}) => {
        const before = await readAuctionState(state.deployments.titleAuction);
        // Test 1 left the auction kicked off and with a 0.5 ETH high
        // bid. Without re-kickoff it's still in the live phase, so the
        // bid panel renders and we can exercise the rejection path on
        // top of it.
        expect(before.kickedOff).toBe(true);

        await page.goto('/title');
        await expect(
            page.getByRole('button', {
                name: new RegExp(`Connected as ${E2E_ENV.testAccount.address}`, 'i'),
            }),
        ).toBeVisible({timeout: 15_000});

        const bidPanel = page.getByRole('complementary', {name: 'Place a bid'});
        await expect(bidPanel).toBeVisible({timeout: 30_000});

        // Next bid must be ≥ 5% above the current high (0.5 × 1.05 = 0.525).
        await bidPanel.getByLabel('Your bid').fill('1');

        await page.evaluate(() => {
            if (!window.__mockProvider) throw new Error('mock provider missing');
            window.__mockProvider.setRejectNextTx(1);
        });

        await bidPanel.getByRole('button', {name: 'Place bid'}).click();

        await expect(bidPanel.getByText('You declined in your wallet.')).toBeVisible({
            timeout: 15_000,
        });

        const after = await readAuctionState(state.deployments.titleAuction);
        expect(after.highBidWei).toBe(before.highBidWei);
        expect(after.highBidder).toBe(before.highBidder);
    });
});
