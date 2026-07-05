/**
 * Phase 2: AcceptBidFlow specs (issue #88).
 *
 * Every Punk-committing signature (Sign list / Sign acceptance / a pre-listed
 * Sign accept) is now gated by an interstitial review modal that shows the
 * Punk, its traits, the market floor, and the exact amount the seller receives;
 * the tx fires only from the modal's Confirm button. `confirmReviewModal` drives
 * that step in each test below.
 *
 * The acceptBid flow is list -> accept -> claim. acceptBid no longer pushes
 * the live bid to the seller: the seller is paid by the 2017 CryptoPunks
 * market (`buyPunk` credits their `pendingWithdrawals`) and collects it with
 * `market.withdraw()` in a third Claim step. So after the accept is signed the
 * UI does NOT jump to "Done" — it flips the confirm stage to "Collect your ETH"
 * with a Claim button, and only reaches the celebratory "Done" heading AFTER
 * the claim tx lands.
 *
 * Seven tests exercise the surface in `app/components/AcceptBidFlow.tsx`:
 *
 *   1. Atomic path — EIP-5792 `wallet_sendCalls` (single signature) lists +
 *      accepts in one prompt. Then the Claim step is clicked. Asserts UI
 *      reaches the "Done" heading after claim + on-chain state matches
 *      (`bidBalance` debited by the listed price ≈ the seed live bid,
 *      `acquisitionCount` incremented, custody transitioned to
 *      `InReturnAuction`, target trait pending, the seller's market
 *      `pendingWithdrawals` collected back to 0).
 *
 *   2. Fallback path — atomic capability flipped to `'unsupported'` so the
 *      UI renders the sequential list/accept flow ("Sign list" then
 *      "Sign accept"), then the Claim step. Same chain assertions.
 *
 *   3. Already pre-listed — the Punk is staged to Patron *before* the test
 *      starts (listed at the live bid by `preListToPatron`), so the list
 *      step renders the "already done" success state and only the accept +
 *      claim legs are actionable. (`useAtomic` is forced false by
 *      `eligibility.listedToPatron`.)
 *
 *   4. User rejection — mock provider is armed via
 *      `window.__mockProvider.setRejectNextTx(1)`; the wallet pop-up
 *      decline throws EIP-1193 code 4001 → UI surfaces the "rejected"
 *      state with a Retry affordance, no on-chain state change. The accept
 *      never succeeds, so the Claim step is never reached.
 *
 *   5. `NotCanonicalTarget` race — between consent and submit, an
 *      independent acceptBid by anvil's account #2 collects/pends the
 *      trait the test EOA's Punk was targeting, which shifts that Punk's
 *      protocol-derived `canonicalTargetOf`. The UI still holds the old
 *      target, so submit reverts `NotCanonicalTarget` and the recovery
 *      panel renders (the accept never succeeds, so no Claim step). Test
 *      uses the **fallback path** because that's where the recovery surface
 *      lives: viem's `walletClient.writeContract` runs `eth_estimateGas`
 *      and throws synchronously when the call would revert, which lets
 *      `classifyAcceptError` decode `NotCanonicalTarget` and surface the
 *      "target shifted — refresh" panel. The atomic path's
 *      `wallet_sendCalls → getCallsStatus` polling reports a generic
 *      "Bundle reverted on-chain." (no decoded error) and the recovery
 *      panel never appears — that's an existing app gap, out of
 *      scope for the harness work.
 *
 *   6. Seller account warning — the connected wallet is delegated (EIP-7702)
 *      so the market's 2300-gas `withdraw()` may not be able to pay it. The
 *      flow reads the account's code and shows the "your wallet may not be
 *      able to collect" banner BEFORE any Punk is picked or signed, while the
 *      Punk is still the seller's to keep.
 *
 *   7. Seller claim recovery — the wallet is delegated to reverting code
 *      (`0xFE`), so list + accept (outbound txs) land but the inbound
 *      `withdraw()` reverts. Asserts the acceptance still succeeded on-chain
 *      (Punk in its return auction, proceeds queued in the market) while the
 *      UI surfaces the claim-failure recovery panel instead of "Done".
 *
 * Target trait is now PROTOCOL-DERIVED (the rarest uncollected, non-pending
 * trait a Punk carries, `PermanentCollection.canonicalTargetOf`). The UI is
 * Punk-first: the caller picks a Punk; the target is read-only. So these specs
 * pick the Punk's card and read/assert the canonical target off-chain rather
 * than choosing a trait.
 *
 * Standing rules respected throughout:
 *   - Fail loud on missing preconditions (no silent passes).
 *   - Don't touch production app code.
 *   - Each test uses a distinct Punk so the shared anvil doesn't need
 *     snapshot/revert plumbing yet (per #88 working notes).
 */

import {createPublicClient, http, parseAbi} from 'viem';
import type {Address} from 'viem';
import {E2E_ENV} from './fixtures/env';
import {e2eTest, expect, type Page} from './fixtures/renderer';
import {
    callAcceptBidAs,
    canonicalTargetOf,
    clearAccountCode,
    delegateAccount,
    delegateToRevertingCode,
    findCanonicalTargetCollision,
    fundTestEoa,
    preListToPatron,
    topUpPatron,
    transferPunkToRecipient,
} from './fixtures/seed';

// Distinct Punks per test — the shared anvil keeps state across tests,
// so each test transfers a different Punk and reads its specific id in
// the assertions. Numbers 1000-1003 are common Male punks on mainnet.
const PUNK_ATOMIC = 1000;
const PUNK_FALLBACK = 1001;
const PUNK_PRELISTED = 1002;
const PUNK_REJECT = 1003;

// Candidate window for the canonical-target race. The target is now
// protocol-derived per Punk, so the race needs TWO Punks that resolve to the
// SAME canonical target under live PC state (not just a shared trait bit) —
// `findCanonicalTargetCollision` scans this window for such a pair. Common Male
// Punks (heavy trait overlap) maximize the odds two share a rarest-trait. Kept
// disjoint from the single-Punk tests above (1000-1003) so a prior test can't
// pre-pend a candidate's target out of the collision.
const RACE_CANDIDATE_PUNKS = Array.from({length: 20}, (_, i) => 1004 + i);

// Seller-account-type tests. Disjoint from the ranges above (1000-1023) so a
// prior test can't have pre-pended their canonical target out of eligibility.
const PUNK_SELLER_WARNING = 1024;
const PUNK_SELLER_CLAIM_FAIL = 1025;

// Permissionless-accept race test. Disjoint from everything above (1000-1025)
// so a prior test can't pre-pend its canonical target out of eligibility.
const PUNK_PERMISSIONLESS_RACE = 1026;

// anvil's prefunded account #2 — used by the race-seed test to call
// acceptBid from a non-test-EOA address. Anvil signs server-side.
const ANVIL_ACCOUNT_2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;

// Seed value for Patron's live bid in each test's beforeEach. 30 ETH is
// the same value the Phase 1 smoke test uses; chosen for visual parity
// in screenshots, not load-bearing.
const PATRON_SEED_ETH = '30';

const PATRON_READ_ABI = parseAbi([
    'function bidBalance() view returns (uint256)',
]);

const PC_READ_ABI = parseAbi([
    'function acquisitionCount() view returns (uint256)',
    'function custodyOf(uint16) view returns (uint8)',
    'function pendingTraitCount(uint8) view returns (uint16)',
]);

// The 2017 CryptoPunks market on the fork. acceptBid pays the seller by
// crediting their `pendingWithdrawals` here (pull-based); the seller collects
// it via the Claim step's `market.withdraw()`. Specs read this to assert the
// proceeds were credited and then collected.
const PUNKS_MARKET = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as Address;
const MARKET_READ_ABI = parseAbi(['function pendingWithdrawals(address) view returns (uint256)']);

const CUSTODY_IN_RETURN_AUCTION = 1;

function rpc() {
    return createPublicClient({
        transport: http(`http://127.0.0.1:${E2E_ENV.anvilPort}`),
    });
}

/** Read the 2017 market's queued proceeds for `addr` — the seller's collectable
 *  ETH after `buyPunk`, drained to 0 once the Claim step's `withdraw()` lands. */
async function marketPendingWithdrawals(addr: Address): Promise<bigint> {
    return rpc().readContract({
        address: PUNKS_MARKET,
        abi: MARKET_READ_ABI,
        functionName: 'pendingWithdrawals',
        args: [addr],
    }) as Promise<bigint>;
}

interface ChainSnapshot {
    bidBalance: bigint;
    acquisitionCount: bigint;
    custody: number;
    pendingForTrait: number;
}

async function readChainSnapshot(
    patron: Address,
    pc: Address,
    punkId: number,
    targetTraitId: number,
): Promise<ChainSnapshot> {
    const client = rpc();
    const [bidBalance, acquisitionCount, custody, pendingForTrait] = await Promise.all([
        client.readContract({
            address: patron,
            abi: PATRON_READ_ABI,
            functionName: 'bidBalance',
        }) as Promise<bigint>,
        client.readContract({
            address: pc,
            abi: PC_READ_ABI,
            functionName: 'acquisitionCount',
        }) as Promise<bigint>,
        client.readContract({
            address: pc,
            abi: PC_READ_ABI,
            functionName: 'custodyOf',
            args: [punkId],
        }) as Promise<number>,
        client.readContract({
            address: pc,
            abi: PC_READ_ABI,
            functionName: 'pendingTraitCount',
            args: [targetTraitId],
        }) as Promise<number>,
    ]);
    return {bidBalance, acquisitionCount, custody, pendingForTrait};
}

/** Wait for the connected-state ConnectButton to settle before driving
 *  the flow. wagmi's autoConnect needs a tick after the page mounts; the
 *  smoke test uses the same selector. */
async function waitForConnected(page: Page) {
    const expectedAddr = E2E_ENV.testAccount.address;
    await expect(
        page.getByRole('button', {
            name: new RegExp(`Connected as ${expectedAddr}`, 'i'),
        }),
    ).toBeVisible({timeout: 15_000});
}

/** Punk-first selection: click the Punk's card in the "Choose a Punk"
 *  radiogroup (matched by the `data-punk-id` hook on `PunkTargetCard`, robust
 *  against the visible Punk-id / trait-name text). The card's protocol-derived
 *  target is read-only — there's no trait row to click anymore. Selecting kicks
 *  off the `/api/eligibility` fetch that mounts the "Confirm and sign" panel.
 *
 *  The grid is fed by /api/owned-trait-options, whose fork-mode ownership read
 *  can take 30-60s on a cold anvil working set, so budget 90s for it to appear
 *  (still well inside Playwright's per-test 240s ceiling). */
async function selectPunk(page: Page, punkId: number) {
    const picker = page.getByRole('radiogroup', {name: 'Choose a Punk'});
    await expect(picker).toBeVisible({timeout: 90_000});
    const punkBtn = picker.locator(`[data-punk-id="${punkId}"]`);
    await expect(punkBtn).toHaveCount(1);
    await expect(punkBtn).toBeEnabled();
    await punkBtn.click();
    // Confirm the click registered: `selectPunk` flips aria-checked and kicks
    // off the eligibility fetch. One bounded re-click absorbs any residual
    // click/commit race without masking a genuine failure to select.
    try {
        await expect(punkBtn).toBeChecked({timeout: 5_000});
    } catch {
        await punkBtn.click();
        await expect(punkBtn).toBeChecked({timeout: 5_000});
    }
}

/** Pick a Punk, then wait for the consent checkbox to mount and acknowledge it.
 *
 *  The consent checkbox lives in the "Confirm and sign" stage, which mounts
 *  only after `/api/eligibility` resolves for the picked Punk. On a loaded
 *  fork that round-trip (chain reads + a server-side silhouette render,
 *  contending with the cold `/api/owned-punks` 10k-slot Multicall3 scan on the
 *  single shared anvil) has a long latency tail that intermittently runs past
 *  the 15s default `actionTimeout` — the documented flake in issue #176, where
 *  a bare `page.getByLabel(...).check()` times out before the box ever exists.
 *
 *  Waiting on the real readiness signal with a generous budget (well inside the
 *  240s per-test cap) absorbs that tail deterministically. We also race the
 *  consent box against `.stage-error` (the shared selector for the options-grid
 *  and eligibility load errors) so an actual eligibility failure — which also
 *  leaves the box unmounted — fails loud with its message instead of timing out
 *  opaquely. Standing rule: fail loud on missing preconditions. */
async function selectPunkAndConsent(page: Page, punkId: number) {
    await selectPunk(page, punkId);
    const consent = page.getByLabel(/I understand\./);
    const stageError = page.locator('p.stage-error');
    await expect(consent.or(stageError)).toBeVisible({timeout: 60_000});
    if (await stageError.isVisible()) {
        const detail = (await stageError.first().textContent())?.trim() ?? '(no text)';
        throw new Error(
            `Confirm panel never mounted for PUNK ${punkId} — eligibility/options lookup errored: ${detail}`,
        );
    }
    await consent.check();
}

/** Read the Punk's protocol-derived target straight off the deployed
 *  `canonicalTargetOf` — the trait the UI shows read-only and the value
 *  `acceptBid` accepts at inclusion. Fails loud if the Punk has no eligible
 *  target (every trait collected/pending), which would also leave it out of
 *  the picker entirely. Standing rule: fail loud on missing preconditions. */
async function resolveCanonicalTarget(pcAddr: Address, punkId: number): Promise<number> {
    const target = await canonicalTargetOf(pcAddr, punkId);
    if (target === null) {
        throw new Error(
            `PUNK ${punkId} has no canonical target (every trait it carries is collected or pending). ` +
                `Pick a different test Punk or reset anvil state.`,
        );
    }
    return target;
}

/** The interstitial review modal now gates every Punk-committing signature.
 *  Each commit button (Sign list / Sign acceptance / pre-listed Sign accept)
 *  opens it; this waits for the modal and clicks its Confirm button. The label
 *  varies by path: a fresh listing is "List to the protocol", the atomic batch
 *  is "List and accept", and the pre-listed accept is "Accept the bid". The
 *  Confirm button reads the price (and, for accept, runs the preflight) before
 *  it enables, so we wait on it being enabled before clicking. */
async function confirmReviewModal(page: Page, label: RegExp) {
    const dialog = page.getByRole('dialog', {name: /Review before you sign/i});
    await expect(dialog).toBeVisible({timeout: 20_000});
    const confirm = dialog.getByRole('button', {name: label});
    await expect(confirm).toBeEnabled({timeout: 30_000});
    await confirm.click();
    await expect(dialog).toBeHidden({timeout: 20_000});
}

e2eTest.describe('Phase 2: AcceptBidFlow', () => {
    e2eTest.beforeEach(async ({state}) => {
        // Each test starts with Patron holding the seed live bid. anvil's
        // `setBalance` is idempotent — this resets to 30 ETH even after a
        // prior test drained Patron via acceptBid.
        await topUpPatron(state.deployments.patron, PATRON_SEED_ETH);
        // Ensure the test EOA has gas headroom for any combination of
        // sequential signing + estimate-gas overheads, in case anvil's
        // default 10000 ETH was dented by prior runs.
        await fundTestEoa('0');
        // Strip the EIP-7702 delegation the forked mainnet state carries on
        // anvil's well-known default accounts. Without this, the Claim step's
        // `market.withdraw()` (which pays the seller via a 2300-gas `.transfer`)
        // reverts `InvalidFEOpcode` when it invokes the delegated code on the
        // seller EOA. See `clearAccountCode` for the full writeup. Account #2 is
        // the race test's competing seller; clear it too so its acceptBid
        // proceeds aren't stranded behind the same delegation.
        await clearAccountCode(E2E_ENV.testAccount.address as Address);
        await clearAccountCode(ANVIL_ACCOUNT_2);
    });

    // Restore the default accounts to clean EOAs after each test. The seller
    // tests below delegate the test EOA (the recovery test points it at reverting
    // 0xFE code), and the suite runs serially on a SHARED anvil. Without this the
    // delegation would leak into the later Phase-3 specs that pay the test EOA
    // (acceptListing's finder fee, referralClaim's claim) and revert their sends.
    // Mirrors the beforeEach clear so the suite leaves state as clean as it found
    // it. Runs even when a test fails.
    e2eTest.afterEach(async () => {
        await clearAccountCode(E2E_ENV.testAccount.address as Address);
        await clearAccountCode(ANVIL_ACCOUNT_2);
    });

    e2eTest('atomic path — single-signature acceptBid succeeds', async ({page, state}) => {
        await transferPunkToRecipient(PUNK_ATOMIC, E2E_ENV.testAccount.address as Address);
        // The target is protocol-derived: the rarest uncollected, non-pending
        // trait this Punk carries (`canonicalTargetOf`). The shared anvil means
        // prior tests can have flipped bits to pending, which shifts the
        // canonical target; reading it live is exactly what the UI shows and
        // what acceptBid accepts, so it matches what we assert on-chain.
        const targetBit = await resolveCanonicalTarget(
            state.deployments.permanentCollection,
            PUNK_ATOMIC,
        );
        const before = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_ATOMIC,
            targetBit,
        );

        await page.goto('/accept');
        await waitForConnected(page);

        // Pick the Punk, consent, then atomic submit.
        await selectPunkAndConsent(page, PUNK_ATOMIC);
        // The atomic-path button label is literal "Sign acceptance"; the
        // hint copy explicitly mentions "single signing prompt".
        const signBtn = page.getByRole('button', {name: 'Sign acceptance'});
        await expect(signBtn).toBeEnabled();
        await signBtn.click();
        // The atomic commit opens the review modal first; confirm it to fire
        // the single-signature list+accept bundle.
        await confirmReviewModal(page, /List and accept/);

        // Regression guard: accepting debits the live bid to 0, which is below
        // the 5 ETH UI minimum, so `belowMinBid` flips true once the headline
        // refetches. The min-bid gate must NOT tear down an in-progress flow —
        // the Claim step has to stay reachable. Wait for the headline to reach
        // its post-accept value (proving the gate is now active), then assert
        // the confirm stage — and the Claim step inside it — survived.
        await expect(page.locator('.summary-value')).toHaveText('0 ETH', {timeout: 30_000});
        await expect(
            page.getByRole('heading', {name: 'Collect your ETH'}),
        ).toBeVisible();

        // After the bundle confirms, the UI flips the confirm stage to
        // "Collect your ETH" — NOT "Done" yet — and surfaces the Claim step.
        // The seller is paid by the market (`pendingWithdrawals`), so the Claim
        // button enables once the proceeds land; click it to collect.
        const claimBtn = page.getByRole('button', {name: /^Claim .* ETH$/});
        await expect(claimBtn).toBeEnabled({timeout: 30_000});
        await claimBtn.click();

        // Only AFTER the claim tx succeeds does the celebratory Done stage show.
        await expect(
            page.getByRole('heading', {name: 'Done'}),
        ).toBeVisible({timeout: 30_000});
        await expect(
            page.getByRole('link', {name: 'View the auction'}),
        ).toBeVisible();

        const after = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_ATOMIC,
            targetBit,
        );
        // The bid is debited by the listed price (the UI lists at the full live
        // bid, ≈ the 30 ETH seed), so the accounted bid still drops to 0. The
        // seller is paid by the market and collects it in the Claim step.
        expect(after.bidBalance).toBe(0n);
        // Append-only acquisition log advanced by exactly 1.
        expect(after.acquisitionCount).toBe(before.acquisitionCount + 1n);
        // Custody transitioned to InReturnAuction (= 1) per Custody enum.
        expect(after.custody).toBe(CUSTODY_IN_RETURN_AUCTION);
        // Target trait now pending; one Punk is in flight on this bit.
        expect(after.pendingForTrait).toBe(before.pendingForTrait + 1);
        // The seller pulled their proceeds out of the market in the Claim step.
        expect(await marketPendingWithdrawals(E2E_ENV.testAccount.address as Address)).toBe(0n);
    });

    e2eTest('fallback path — sequential list/accept then claim succeeds', async ({page, state}) => {
        // Override atomic capability to 'unsupported' BEFORE the first
        // navigation, so wagmi's getCapabilities effect sees the
        // downgraded value and the UI renders the sequential list -> accept
        // flow (steps "2a"/"2b", buttons "Sign list"/"Sign accept"), followed
        // by the Claim step. addInitScript runs after the mockProvider script
        // (added by the renderer fixture), so window.__mockProvider exists.
        await page.addInitScript(() => {
            window.__mockProvider?.setAtomicCapability('unsupported');
        });

        await transferPunkToRecipient(PUNK_FALLBACK, E2E_ENV.testAccount.address as Address);
        const targetBit = await resolveCanonicalTarget(
            state.deployments.permanentCollection,
            PUNK_FALLBACK,
        );
        const before = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_FALLBACK,
            targetBit,
        );

        await page.goto('/accept');
        await waitForConnected(page);

        await selectPunkAndConsent(page, PUNK_FALLBACK);

        // Sequential flow: button labels are "Sign list" then "Sign accept".
        // The atomic single-button "Sign acceptance" must NOT be present.
        await expect(
            page.getByRole('button', {name: 'Sign acceptance'}),
        ).toHaveCount(0);

        const signList = page.getByRole('button', {name: 'Sign list'});
        await expect(signList).toBeEnabled();
        await signList.click();
        // The list commit opens the review modal; confirm it to fire the listing.
        await confirmReviewModal(page, /List to the protocol/);
        // Wait for the list step to flip to its 'Signed' label before accept enables.
        await expect(
            page.getByRole('button', {name: 'Signed'}).first(),
        ).toBeVisible({timeout: 20_000});

        // The follow-up accept fires directly — the Punk was already reviewed at
        // list time, so its accept does NOT re-open the modal.
        const signAccept = page.getByRole('button', {name: 'Sign accept'});
        await expect(signAccept).toBeEnabled({timeout: 20_000});
        await signAccept.click();

        // Accept landed — the stage flips to "Collect your ETH" with the Claim
        // step, NOT straight to "Done". Collect the market-held proceeds.
        const claimBtn = page.getByRole('button', {name: /^Claim .* ETH$/});
        await expect(claimBtn).toBeEnabled({timeout: 30_000});
        await claimBtn.click();

        await expect(
            page.getByRole('heading', {name: 'Done'}),
        ).toBeVisible({timeout: 30_000});

        const after = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_FALLBACK,
            targetBit,
        );
        // Bid debited by the listed price (≈ the seed live bid); seller paid by
        // the market and collected via Claim.
        expect(after.bidBalance).toBe(0n);
        expect(after.acquisitionCount).toBe(before.acquisitionCount + 1n);
        expect(after.custody).toBe(CUSTODY_IN_RETURN_AUCTION);
        expect(after.pendingForTrait).toBe(before.pendingForTrait + 1);
        expect(await marketPendingWithdrawals(E2E_ENV.testAccount.address as Address)).toBe(0n);
    });

    e2eTest('permissionless race — someone else finalizes the listed Punk, UI shows success + claim', async ({page, state}) => {
        // acceptBid is permissionless: once a Punk is listed exclusively to
        // Patron, ANYONE can finalize it. This proves the UI treats an external
        // finalize as success (not a confusing error): after the user lists,
        // anvil #2 finalizes the SAME Punk, and the flow flips to the "someone
        // finalized it for you" state with the Claim step still reachable — the
        // seller is paid by the market regardless of who pushed accept.
        await page.addInitScript(() => {
            window.__mockProvider?.setAtomicCapability('unsupported');
        });

        await transferPunkToRecipient(PUNK_PERMISSIONLESS_RACE, E2E_ENV.testAccount.address as Address);
        const targetBit = await resolveCanonicalTarget(
            state.deployments.permanentCollection,
            PUNK_PERMISSIONLESS_RACE,
        );
        const before = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_PERMISSIONLESS_RACE,
            targetBit,
        );

        await page.goto('/accept');
        await waitForConnected(page);

        await selectPunkAndConsent(page, PUNK_PERMISSIONLESS_RACE);

        // Step 2a: the user lists their own Punk to Patron. After this, the
        // listed Punk is finalizable by anyone.
        const signList = page.getByRole('button', {name: 'Sign list'});
        await expect(signList).toBeEnabled();
        await signList.click();
        await confirmReviewModal(page, /List to the protocol/);
        await expect(
            page.getByRole('button', {name: 'Signed'}).first(),
        ).toBeVisible({timeout: 20_000});

        // Someone else finalizes the user's listed Punk before the user clicks
        // their own Accept. anvil #2 calls acceptBid on the SAME Punk.
        await callAcceptBidAs(
            state.deployments.patron,
            ANVIL_ACCOUNT_2,
            PUNK_PERMISSIONLESS_RACE,
            targetBit,
        );

        // The race-detection effect re-checks custody on tab focus. Fire a
        // focus event so detection is immediate rather than waiting on the
        // background interval — this exercises the same code path.
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));

        // The flow surfaces the "finalized for you" success copy, NOT an error.
        await expect(
            page.getByText(/Someone finalized the bid for you/i),
        ).toBeVisible({timeout: 20_000});

        // And the Claim step is reachable — the seller (the lister) is paid by
        // the market regardless of who finalized. Collect the proceeds.
        const claimBtn = page.getByRole('button', {name: /^Claim .* ETH$/});
        await expect(claimBtn).toBeEnabled({timeout: 30_000});
        await claimBtn.click();

        await expect(
            page.getByRole('heading', {name: 'Done'}),
        ).toBeVisible({timeout: 30_000});

        const after = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_PERMISSIONLESS_RACE,
            targetBit,
        );
        // The external accept recorded the acquisition and debited the bid; the
        // user collected their market-held proceeds via Claim.
        expect(after.acquisitionCount).toBe(before.acquisitionCount + 1n);
        expect(after.custody).toBe(CUSTODY_IN_RETURN_AUCTION);
        expect(after.pendingForTrait).toBe(before.pendingForTrait + 1);
        expect(await marketPendingWithdrawals(E2E_ENV.testAccount.address as Address)).toBe(0n);
    });

    e2eTest('already pre-listed — list step shows success state from the start', async ({page, state}) => {
        const testEoa = E2E_ENV.testAccount.address as Address;
        await transferPunkToRecipient(PUNK_PRELISTED, testEoa);
        // Pre-list to Patron BEFORE the test EOA navigates. preListToPatron
        // lists at the live bid (`bidBalance()`), so the eligibility API
        // returns listedToPatron=true on the first resolution; AcceptBidFlow
        // drops the atomic option (useAtomic requires !listedToPatron) and the
        // list step renders the "Listed to the protocol (already done)" badge.
        await preListToPatron(PUNK_PRELISTED, testEoa, state.deployments.patron);

        const targetBit = await resolveCanonicalTarget(
            state.deployments.permanentCollection,
            PUNK_PRELISTED,
        );
        const before = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_PRELISTED,
            targetBit,
        );

        await page.goto('/accept');
        await waitForConnected(page);

        await selectPunkAndConsent(page, PUNK_PRELISTED);

        // Atomic single-button MUST NOT render (listedToPatron disables it).
        await expect(
            page.getByRole('button', {name: 'Sign acceptance'}),
        ).toHaveCount(0);

        // The list step's label flips to the already-done copy.
        await expect(
            page.getByText('Listed to the protocol (already done)'),
        ).toBeVisible();

        // The list step's button is disabled and labelled 'Signed' (the
        // success-state buttonLabelFor return value). The accept step's "Sign
        // accept" is the only actionable signing button on the page.
        const alreadySigned = page.getByRole('button', {name: 'Signed'});
        await expect(alreadySigned).toBeVisible();
        await expect(alreadySigned).toBeDisabled();

        const signAccept = page.getByRole('button', {name: 'Sign accept'});
        await expect(signAccept).toBeEnabled();
        await signAccept.click();
        // This Punk was listed in a prior session (pre-listed), so its accept
        // DOES open the review modal; confirm it to fire acceptBid.
        await confirmReviewModal(page, /Accept the bid/);

        // Accept landed — collect the market-held proceeds before Done.
        const claimBtn = page.getByRole('button', {name: /^Claim .* ETH$/});
        await expect(claimBtn).toBeEnabled({timeout: 30_000});
        await claimBtn.click();

        await expect(
            page.getByRole('heading', {name: 'Done'}),
        ).toBeVisible({timeout: 30_000});

        const after = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_PRELISTED,
            targetBit,
        );
        // Bid debited by the listed price (≈ the seed live bid); seller paid by
        // the market and collected via Claim.
        expect(after.bidBalance).toBe(0n);
        expect(after.acquisitionCount).toBe(before.acquisitionCount + 1n);
        expect(after.custody).toBe(CUSTODY_IN_RETURN_AUCTION);
        expect(after.pendingForTrait).toBe(before.pendingForTrait + 1);
        expect(await marketPendingWithdrawals(testEoa)).toBe(0n);
    });

    e2eTest('user rejection — wallet decline surfaces "rejected" UI, no on-chain change', async ({page, state}) => {
        const testEoa = E2E_ENV.testAccount.address as Address;
        await transferPunkToRecipient(PUNK_REJECT, testEoa);

        const targetBit = await resolveCanonicalTarget(
            state.deployments.permanentCollection,
            PUNK_REJECT,
        );
        const before = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_REJECT,
            targetBit,
        );

        await page.goto('/accept');
        await waitForConnected(page);

        await selectPunkAndConsent(page, PUNK_REJECT);

        // Arm the wallet pop-up to decline the next signing attempt.
        // Arming AFTER consent so the surrounding reads (capability
        // check, etc.) aren't accidentally caught by the rejection.
        await page.evaluate(() => {
            if (!window.__mockProvider) throw new Error('mock provider missing');
            window.__mockProvider.setRejectNextTx(1);
        });

        const signBtn = page.getByRole('button', {name: 'Sign acceptance'});
        await expect(signBtn).toBeEnabled();
        await signBtn.click();
        // The review modal's bid read goes through the public client (not the
        // armed wallet mock), so confirming it fires the wallet bundle — which
        // is the tx the rejection is armed against.
        await confirmReviewModal(page, /List and accept/);

        // classifyAcceptError translates EIP-1193 code 4001 → this string.
        // Surfaced under the atomic-batch tx's status line on rejection.
        await expect(
            page.getByText('You declined in your wallet.'),
        ).toBeVisible({timeout: 15_000});

        // Button relabels to 'Retry' once the rejected state is committed.
        await expect(
            page.getByRole('button', {name: 'Retry'}),
        ).toBeVisible();

        // Chain state must not have moved: no buyPunk, no record.
        const after = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_REJECT,
            targetBit,
        );
        expect(after.bidBalance).toBe(before.bidBalance);
        expect(after.acquisitionCount).toBe(before.acquisitionCount);
        expect(after.custody).toBe(before.custody);
        expect(after.pendingForTrait).toBe(before.pendingForTrait);
    });

    e2eTest('NotCanonicalTarget race — UI surfaces the target-shift recovery panel', async ({page, state}) => {
        // The recovery panel is wired into the SEQUENTIAL submit path
        // (submitAcceptTx's catch block). viem's `walletClient.writeContract`
        // runs `eth_estimateGas` which throws on a would-revert call,
        // letting `classifyAcceptError` decode `NotCanonicalTarget` into
        // the "target trait shifted before your transaction landed" message
        // that triggers the panel. The atomic path's getCallsStatus polling
        // reports a generic "Bundle reverted on-chain." and doesn't trigger
        // the panel — that's an existing app behaviour; not regressed here.
        await page.addInitScript(() => {
            window.__mockProvider?.setAtomicCapability('unsupported');
        });

        const testEoa = E2E_ENV.testAccount.address as Address;

        // The target is protocol-derived per Punk (`canonicalTargetOf` =
        // rarest uncollected, non-pending trait it carries). To race it, a
        // SECOND Punk must resolve to the SAME canonical target so anvil #2's
        // acceptBid legitimately pends it — which then shifts the test Punk's
        // canonical target out from under the UI's held value, reverting the
        // test EOA's submit with `NotCanonicalTarget`. Scan a window of common
        // Male Punks (heavy trait overlap) for two that collide on their live
        // canonical target. Reading the contract live keeps this robust to
        // whatever prior tests pended. Fail loud if the window has no collision.
        const collision = await findCanonicalTargetCollision(
            state.deployments.permanentCollection,
            RACE_CANDIDATE_PUNKS,
        );
        if (collision === null) {
            throw new Error(
                `No two Punks in ${JSON.stringify(RACE_CANDIDATE_PUNKS)} share a canonical ` +
                    `target under current PC state. Race seed cannot run; widen the ` +
                    `candidate window or reset anvil state.`,
            );
        }
        const {punkId: racePunk, seedPunkId: raceSeed, target: sharedTarget} = collision;

        await transferPunkToRecipient(racePunk, testEoa);
        await transferPunkToRecipient(raceSeed, ANVIL_ACCOUNT_2);

        // Satisfy the 20 ETH accept gate BEFORE loading /accept. Earlier
        // tests' accepts drain the live bid, and below the gate the page
        // renders the "Accepting isn't open yet" panel instead of the Punk
        // picker (this test ran with the gate at 0 when it was written).
        // Idempotent: tops up only if the bid sits below the seed.
        await topUpPatron(state.deployments.patron, PATRON_SEED_ETH);

        await page.goto('/accept');
        await waitForConnected(page);

        await selectPunkAndConsent(page, racePunk);

        // List the test EOA's Punk first (step 2a) — this leg succeeds
        // regardless of trait state since pre-listing has no protocol checks.
        const signList = page.getByRole('button', {name: 'Sign list'});
        await expect(signList).toBeEnabled();
        await signList.click();
        // Confirm the review modal to fire the listing.
        await confirmReviewModal(page, /List to the protocol/);
        await expect(
            page.getByRole('button', {name: 'Signed'}).first(),
        ).toBeVisible({timeout: 20_000});

        // Wait for the accept preflight to ARM "Sign accept" BEFORE racing in
        // the competing acquisition. Once the listing confirms, the UI
        // `eth_call`-simulates acceptBid against the pinned (pre-race) target
        // and only enables the button when that simulate passes. Blocking on
        // the armed button makes "the preflight passed against the pre-race
        // target" a deterministic PRECONDITION rather than a race the test can
        // lose. The previous ordering (list → race → click, with no wait here)
        // let the competing acceptBid land before the preflight's first simulate
        // attempt on a loaded CI runner, so every attempt saw the ALREADY-
        // shifted target, the button never armed, and the `toBeEnabled` below
        // timed out — the CI-only flake this test kept hitting (the review-modal
        // rewrite reintroduced the racy ordering an earlier de-flake had
        // removed). The preflight effect does not re-run on an external chain
        // change, so this 'ready' state persists across the race that follows —
        // which is exactly the production window under test: the target shifts
        // AFTER the preflight armed the button but BEFORE the user clicks it.
        const signAccept = page.getByRole('button', {name: 'Sign accept'});
        await expect(signAccept).toBeEnabled({timeout: 30_000});

        // Race the second acquisition through, now that "Sign accept" is armed.
        // From anvil account #2: pre-list raceSeed to Patron, then acceptBid the
        // shared target. After this pendingTraitCount[sharedTarget] is 1, so the
        // test Punk's canonicalTargetOf shifts to its next-rarest trait while
        // the UI (and the armed button) still hold sharedTarget.
        await preListToPatron(raceSeed, ANVIL_ACCOUNT_2, state.deployments.patron);
        await callAcceptBidAs(
            state.deployments.patron,
            ANVIL_ACCOUNT_2,
            raceSeed,
            sharedTarget,
        );

        // The competing acceptBid above paid out the live bid, draining Patron.
        // The test EOA already listed its Punk at the pre-race live bid, so
        // unless we refill the bid, the EOA's accept would revert
        // `ListingExceedsBid` (listing > current bid) BEFORE reaching the
        // `NotCanonicalTarget` check this test is about. Restore the seed bid so
        // the listing is still covered and the target-shift is the binding
        // revert. (The bid only needs to be ≥ the listing price; the seed value
        // is what the Punk was listed at.)
        await topUpPatron(state.deployments.patron, PATRON_SEED_ETH);

        // Sanity-check the race actually landed before driving the UI —
        // a silent failure here would manifest as the test EOA's
        // acceptBid succeeding (no recovery panel) and we'd waste an
        // assertion budget. Standing rule: fail loud, not silent.
        const racePending = await rpc().readContract({
            address: state.deployments.permanentCollection,
            abi: PC_READ_ABI,
            functionName: 'pendingTraitCount',
            args: [sharedTarget],
        });
        expect(racePending).toBe(1);
        // And the test Punk's canonical target must now differ from the value
        // the UI still holds — that's the precondition for NotCanonicalTarget.
        const shiftedTarget = await canonicalTargetOf(
            state.deployments.permanentCollection,
            racePunk,
        );
        expect(shiftedTarget).not.toBe(sharedTarget);

        // Submit — the button is still armed (the preflight does not re-run on
        // the external shift), but the wallet's fresh gas estimate now reverts
        // NotCanonicalTarget. classifyAcceptError decodes it,
        // isTargetShiftMessage matches, and the .trait-busy panel renders.
        await signAccept.click();

        const recovery = page.locator('.trait-busy');
        await expect(recovery).toBeVisible({timeout: 20_000});
        await expect(recovery).toContainText('target trait for this Punk shifted');

        // Recovery affordance re-reads the canonical targets from fresh state
        // and drops the in-flight selection, back to the Punk picker.
        const refreshBtn = recovery.getByRole('button', {name: 'Refresh and start over'});
        await expect(refreshBtn).toBeVisible();
        await refreshBtn.click();

        // After the recovery click we're back on the Punk picker with nothing
        // selected: the "Choose a Punk" radiogroup is visible again and the
        // inline confirm panel (its Sign buttons) is gone.
        await expect(
            page.getByRole('radiogroup', {name: 'Choose a Punk'}),
        ).toBeVisible();
        await expect(page.getByRole('button', {name: 'Sign accept'})).toHaveCount(0);
    });

    e2eTest('seller account warning — delegated wallet sees the collect-risk banner', async ({page}) => {
        const testEoa = E2E_ENV.testAccount.address as Address;
        await transferPunkToRecipient(PUNK_SELLER_WARNING, testEoa);
        // Re-delegate the test EOA AFTER the beforeEach cleared it — this is the
        // exact account state the warning guards against: a 7702-delegated seller
        // the market's 2300-gas withdraw() can't pay. The delegate address is
        // arbitrary; the warning keys on the account HAVING delegation code.
        await delegateAccount(testEoa, ANVIL_ACCOUNT_2);

        await page.goto('/accept');
        await waitForConnected(page);

        // The warning fires off the connected wallet's code, before any Punk is
        // picked or signed — the seller is told up front, while the Punk is still
        // theirs to keep.
        const warning = page.locator('.seller-warning');
        await expect(warning).toBeVisible({timeout: 15_000});
        await expect(warning).toContainText('may not be able to collect');
        await expect(warning).toContainText('EIP-7702 delegated account');
    });

    e2eTest('seller claim recovery — delegated wallet, withdraw fails, recovery panel shown', async ({page, state}) => {
        // Force the sequential path so list + accept are plain OUTBOUND txs from
        // the delegated EOA (which succeed); the failure is isolated to the
        // INBOUND withdraw the market does to pay the seller.
        await page.addInitScript(() => {
            window.__mockProvider?.setAtomicCapability('unsupported');
        });

        const testEoa = E2E_ENV.testAccount.address as Address;
        await transferPunkToRecipient(PUNK_SELLER_CLAIM_FAIL, testEoa);
        const targetBit = await resolveCanonicalTarget(
            state.deployments.permanentCollection,
            PUNK_SELLER_CLAIM_FAIL,
        );

        // Delegate the seller to reverting code AFTER the beforeEach clear: list
        // + accept still land, but the market's 2300-gas withdraw() into the
        // seller hits the delegate's INVALID (0xFE) opcode and reverts — the exact
        // mainnet trap, reproduced deterministically.
        await delegateToRevertingCode(testEoa);

        await page.goto('/accept');
        await waitForConnected(page);

        // Early warning is up before anything is signed.
        await expect(page.locator('.seller-warning')).toContainText('may not be able to collect', {
            timeout: 15_000,
        });

        await selectPunkAndConsent(page, PUNK_SELLER_CLAIM_FAIL);

        const signList = page.getByRole('button', {name: 'Sign list'});
        await expect(signList).toBeEnabled();
        await signList.click();
        // Confirm the review modal to fire the listing.
        await confirmReviewModal(page, /List to the protocol/);
        await expect(page.getByRole('button', {name: 'Signed'}).first()).toBeVisible({timeout: 20_000});

        const signAccept = page.getByRole('button', {name: 'Sign accept'});
        await expect(signAccept).toBeEnabled({timeout: 20_000});
        await signAccept.click();

        // acceptBid lands (outbound) — the market queues the seller's proceeds,
        // so the Claim step enables.
        const claimBtn = page.getByRole('button', {name: /^Claim .* ETH$/});
        await expect(claimBtn).toBeEnabled({timeout: 30_000});
        await claimBtn.click();

        // withdraw() reverts into the delegate's 0xFE — the recovery panel shows
        // and the celebratory Done heading never appears.
        const recovery = page.locator('.seller-warning').filter({hasText: 'go through'});
        await expect(recovery).toBeVisible({timeout: 30_000});
        await expect(recovery).toContainText('EIP-7702 delegation');
        await expect(page.getByRole('heading', {name: 'Done'})).toHaveCount(0);

        // The acceptance itself still landed — only the withdraw failed. The Punk
        // is in its return auction and the proceeds are still queued for the
        // seller in the market (recoverable once they un-delegate).
        const after = await readChainSnapshot(
            state.deployments.patron,
            state.deployments.permanentCollection,
            PUNK_SELLER_CLAIM_FAIL,
            targetBit,
        );
        expect(after.custody).toBe(CUSTODY_IN_RETURN_AUCTION);
        expect(await marketPendingWithdrawals(testEoa)).toBeGreaterThan(0n);
    });
});
