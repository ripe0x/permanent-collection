/**
 * seed-title-threshold.ts — local-fork helper that vaults enough Punks for
 * the Title Auction's `kickoff()` gate to open
 * (`collectedCount >= KICKOFF_THRESHOLD`, =11 at launch per
 * PunkVaultTitleAuction.sol).
 *
 * Drives the acceptBid path TARGET_COLLECTED times in sequence:
 *   1) Pick distinct (punkId, targetTraitId) pairs by walking Punks
 *      0..N and greedy-picking the lowest uncovered trait on each Punk's
 *      mask. Skips Punks already recorded, traits already collected, and
 *      traits with a pending sale.
 *   2) Zero Patron's balance so the first acceptBid doesn't drain
 *      the seeded bounty into one random owner; restored at the end.
 *   3) For each pair: impersonate the current Punk owner → list to
 *      Patron @ 0 → Patron.acceptBid(punk, trait, 0). This opens
 *      a 72h return auction for each.
 *   4) Warp `evm_increaseTime` by 72h + 5min, mine a block.
 *   5) Settle each return auction (no-bid) → Punk vaulted, target trait
 *      collected. Settle is permissionless; any anvil account can call.
 *   6) Restore Patron's balance to `BOUNTY_REFILL_ETH` (or whatever it
 *      held when the script started, whichever is greater).
 *   7) Assert `collectedCount >= TARGET_COLLECTED` and `isKickoffReady() === true`.
 *
 * Default `TARGET_COLLECTED = 11` (matches the contract's KICKOFF_THRESHOLD).
 * Override via `TARGET_COLLECTED_OVERRIDE=N` to push further into the
 * lifecycle — e.g. =56 for half-filled mosaic rendering checks, =111
 * for the full-set complete state.
 *
 * Idempotent — re-running on a partially-seeded fork tops up to the target;
 * re-running on a fully-seeded fork exits early.
 *
 * Usage:
 *   RPC_URL=http://127.0.0.1:8545 pnpm tsx scripts/seed-title-threshold.ts
 *   pnpm seed:title-threshold
 *   TARGET_COLLECTED_OVERRIDE=56 pnpm seed:title-threshold   # half-set render check
 *   SEED_TITLE_THRESHOLD=1 ./scripts/dev-up.sh
 */
import {createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther} from 'viem';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// Local anvil — chainId 31337, paired with the canonical Multicall3 address
// (the mainnet fork carries the same deployment). Required so viem's
// `multicall` knows where to batch reads.
const ANVIL = defineChain({
    id: 31337,
    name: 'Anvil',
    nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
    rpcUrls: {default: {http: ['http://127.0.0.1:8545']}},
    contracts: {
        multicall3: {address: '0xcA11bde05977b3631167028862bE2a173976CA11'},
    },
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DEPLOYMENTS_PATH = join(ROOT, 'contracts', 'deployments.json');
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

const PUNKS_MARKET = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as const;
const PUNKS_DATA = '0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C' as const;

const TRAIT_COUNT = 111;
// PunkVaultTitleAuction.KICKOFF_THRESHOLD = 11. Default to that so the
// script does the minimum work needed to open kickoff. Override via
// `TARGET_COLLECTED_OVERRIDE=N` to drive more vaults (=56 for half-set
// renderer checks, =111 for full-set complete state, etc.).
const TARGET_COLLECTED = Number(process.env.TARGET_COLLECTED_OVERRIDE ?? 11);
const PUNK_SCAN_LIMIT = 400; // how far to walk through Punks looking for distinct traits

// Anvil account #0 — calls settle (no auth needed). Anvil's default funded
// account; the deploy script also uses it.
const SETTLER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SETTLER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

// How much ETH to leave in Patron when we're done. Keeps the dev UI usable
// (acceptBid/acceptListing both need a non-zero bounty to demonstrate).
const BOUNTY_REFILL_ETH = 30n;

const MARKET_ABI = parseAbi([
    'function punkIndexToAddress(uint256) view returns (address)',
    'function offerPunkForSaleToAddress(uint256, uint256, address)',
]);

const PUNKS_DATA_ABI = parseAbi([
    'function traitMaskOf(uint16 punkId) view returns (uint256)',
]);

const PATRON_ABI = parseAbi([
    'function acceptBid(uint16 punkId, uint8 targetTraitId, uint256 minPayoutWei)',
    'function bidBalance() view returns (uint256)',
    'function liveBidAdapter() view returns (address)',
]);

// Each seeded acceptBid pays out the WHOLE accounted bid, so we fund this tiny
// amount through the adapter before each one (the dev fork pays it to an
// impersonated owner — harmless).
const SEED_BID_WEI = 10n ** 15n; // 0.001 ETH

const FINAL_SALE_ABI = parseAbi([
    'function settle(uint16 punkId)',
]);

const PC_ABI = parseAbi([
    'function collectedCount() view returns (uint256)',
    'function collectedMask() view returns (uint256)',
    'function pendingTraitCount(uint8) view returns (uint16)',
    'function isRecorded(uint16) view returns (bool)',
]);

const TITLE_ABI = parseAbi([
    'function isKickoffReady() view returns (bool)',
    'function kickedOff() view returns (bool)',
]);

interface Deployments {
    patron: `0x${string}`;
    permanentCollection: `0x${string}`;
    returnAuctionModule: `0x${string}`;
    titleAuction: `0x${string}`;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function bitsOf(mask: bigint): number[] {
    const out: number[] = [];
    let bit = 0;
    let m = mask;
    while (m !== 0n) {
        if ((m & 1n) === 1n) out.push(bit);
        bit++;
        m >>= 1n;
    }
    return out;
}

function toHexBalance(eth: bigint): `0x${string}` {
    return `0x${(eth * 10n ** 18n).toString(16)}` as `0x${string}`;
}

async function rpc(pub: any, method: string, params: any[]) {
    return pub.request({method, params});
}

async function impersonate(pub: any, addr: string) {
    await rpc(pub, 'anvil_impersonateAccount', [addr]);
}

async function stopImpersonate(pub: any, addr: string) {
    await rpc(pub, 'anvil_stopImpersonatingAccount', [addr]);
}

async function ensureGas(pub: any, addr: string, minWei: bigint = 10n ** 17n) {
    const balHex = (await rpc(pub, 'eth_getBalance', [addr, 'latest'])) as string;
    const bal = BigInt(balHex);
    if (bal < minWei) {
        // Top up to 1 ETH.
        await rpc(pub, 'anvil_setBalance', [addr, toHexBalance(1n)]);
    }
}

async function setBalance(pub: any, addr: string, wei: bigint) {
    await rpc(pub, 'anvil_setBalance', [addr, `0x${wei.toString(16)}`]);
}

/** Fund the live bid by `wei` THROUGH the adapter so `Patron.receive()` credits
 *  `accountedLiveBidWei`. A raw `anvil_setBalance` on Patron is forced ETH that
 *  the accounting excludes from the bid (acceptBid would then revert). */
async function fundBidViaAdapter(pub: any, patron: `0x${string}`, wei: bigint) {
    const adapter = (await pub.readContract({
        address: patron,
        abi: PATRON_ABI,
        functionName: 'liveBidAdapter',
    })) as `0x${string}`;
    const adapterBalBefore = (await pub.getBalance({address: adapter})) as bigint;
    await impersonate(pub, adapter);
    await setBalance(pub, adapter, wei + 10n ** 18n); // wei + 1 ETH gas
    const wallet = createWalletClient({account: adapter, transport: http(RPC_URL)});
    const hash = await wallet.sendTransaction({chain: null, to: patron, value: wei});
    await pub.waitForTransactionReceipt({hash});
    await stopImpersonate(pub, adapter);
    // Restore the adapter's balance so funding leaves no spurious pending buffer.
    await setBalance(pub, adapter, adapterBalBefore);
}


async function main() {
    const deployments: Deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
    if (!deployments.titleAuction) {
        throw new Error('deployments.json missing titleAuction — redeploy first');
    }
    const pub = createPublicClient({chain: ANVIL, transport: http(RPC_URL)});

    // ── Step 1: early-exit if already past the threshold ────────────────
    const startCount = (await pub.readContract({
        address: deployments.permanentCollection,
        abi: PC_ABI,
        functionName: 'collectedCount',
    })) as bigint;
    console.log(`current collectedCount: ${startCount} / ${TRAIT_COUNT}`);
    if (Number(startCount) >= TARGET_COLLECTED) {
        const [ready, kicked] = await Promise.all([
            pub.readContract({
                address: deployments.titleAuction,
                abi: TITLE_ABI,
                functionName: 'isKickoffReady',
            }) as Promise<boolean>,
            pub.readContract({
                address: deployments.titleAuction,
                abi: TITLE_ABI,
                functionName: 'kickedOff',
            }) as Promise<boolean>,
        ]);
        console.log(`already at or past threshold (${startCount} >= ${TARGET_COLLECTED})`);
        console.log(`isKickoffReady = ${ready}, kickedOff = ${kicked}`);
        return;
    }

    // ── Step 2: read state we need to pick (Punk, trait) pairs ─────────
    const collectedMask = (await pub.readContract({
        address: deployments.permanentCollection,
        abi: PC_ABI,
        functionName: 'collectedMask',
    })) as bigint;

    // Multicall traitMaskOf for Punks 0..PUNK_SCAN_LIMIT-1. PunksData
    // doesn't expose a multicall, so use viem's batched provider.
    console.log(`scanning ${PUNK_SCAN_LIMIT} Punks for trait coverage...`);
    const maskCalls = Array.from({length: PUNK_SCAN_LIMIT}, (_, i) => ({
        address: PUNKS_DATA,
        abi: PUNKS_DATA_ABI,
        functionName: 'traitMaskOf' as const,
        args: [i] as const,
    }));
    const masks = (await pub.multicall({contracts: maskCalls, allowFailure: false})) as bigint[];

    // Also pre-fetch owners + isRecorded in batch. isRecorded on already-
    // recorded Punks means we must skip them (a re-run scenario).
    const ownerCalls = Array.from({length: PUNK_SCAN_LIMIT}, (_, i) => ({
        address: PUNKS_MARKET,
        abi: MARKET_ABI,
        functionName: 'punkIndexToAddress' as const,
        args: [BigInt(i)] as const,
    }));
    const owners = (await pub.multicall({contracts: ownerCalls, allowFailure: false})) as `0x${string}`[];

    const recordedCalls = Array.from({length: PUNK_SCAN_LIMIT}, (_, i) => ({
        address: deployments.permanentCollection,
        abi: PC_ABI,
        functionName: 'isRecorded' as const,
        args: [i] as const,
    }));
    const recorded = (await pub.multicall({contracts: recordedCalls, allowFailure: false})) as boolean[];

    // Pending-trait state. Read all 111 in one multicall.
    const pendingCalls = Array.from({length: TRAIT_COUNT}, (_, t) => ({
        address: deployments.permanentCollection,
        abi: PC_ABI,
        functionName: 'pendingTraitCount' as const,
        args: [t] as const,
    }));
    const pending = (await pub.multicall({contracts: pendingCalls, allowFailure: false})) as number[];

    // ── Step 3: greedy-pick (Punk, target) pairs ───────────────────────
    const taken = new Set<number>();
    for (let t = 0; t < TRAIT_COUNT; t++) {
        if ((collectedMask >> BigInt(t)) & 1n) taken.add(t);
        if (pending[t] > 0) taken.add(t);
    }
    const needed = TARGET_COLLECTED - Number(startCount);
    const pairs: {punkId: number; traitId: number; owner: `0x${string}`}[] = [];

    for (let p = 0; p < PUNK_SCAN_LIMIT && pairs.length < needed; p++) {
        if (recorded[p]) continue;
        if (owners[p].toLowerCase() === ZERO_ADDR) continue;
        const bits = bitsOf(masks[p]);
        // Lowest-id trait first — keeps the chosen Punks low-popcount-ish
        // and the chosen traits clustered in the head/variant/attribute
        // tiers, which gives the renderer plenty to draw on /title.
        for (const t of bits) {
            if (taken.has(t)) continue;
            pairs.push({punkId: p, traitId: t, owner: owners[p]});
            taken.add(t);
            break;
        }
    }
    if (pairs.length < needed) {
        throw new Error(
            `picked only ${pairs.length}/${needed} (Punk, trait) pairs from the first ${PUNK_SCAN_LIMIT} Punks — increase PUNK_SCAN_LIMIT`,
        );
    }
    console.log(`picked ${pairs.length} (Punk, trait) pairs`);

    // ── Step 4: snapshot the live bid (for the Step 8 restore) ──────────
    // We can't zero the accounted bid — it only moves via the adapter or an
    // acquisition — and each acceptBid pays out the WHOLE accounted bid, so
    // Step 5 funds a tiny bid per iteration instead. On a dev fork the payouts
    // go to impersonated owners, so the existing bounty being spent is harmless.
    const originalBid = (await pub.readContract({
        address: deployments.patron,
        abi: PATRON_ABI,
        functionName: 'bidBalance',
    })) as bigint;
    console.log(`live bid pre-seed: ${originalBid} wei`);

    // ── Step 5: open 56 Final Sales via acceptBid ───────────────────
    let opened = 0;
    for (const {punkId, traitId, owner} of pairs) {
        // Re-fund a tiny live bid each iteration (acceptBid drains the whole
        // accounted bid), so this acceptBid has a non-zero payout to clear the
        // mandatory `minPayoutWei` floor.
        await fundBidViaAdapter(pub, deployments.patron, SEED_BID_WEI);

        await impersonate(pub, owner);
        await ensureGas(pub, owner);
        const wallet = createWalletClient({account: owner, transport: http(RPC_URL)});

        // List Punk to Patron @ 0.
        const listHash = await wallet.writeContract({
            chain: null,
            address: PUNKS_MARKET,
            abi: MARKET_ABI,
            functionName: 'offerPunkForSaleToAddress',
            args: [BigInt(punkId), 0n, deployments.patron],
        });
        await pub.waitForTransactionReceipt({hash: listHash});

        // Accept the bounty — opens the 72h return auction.
        const acceptHash = await wallet.writeContract({
            chain: null,
            address: deployments.patron,
            abi: PATRON_ABI,
            functionName: 'acceptBid',
            args: [punkId, traitId, SEED_BID_WEI],
        });
        await pub.waitForTransactionReceipt({hash: acceptHash});

        await stopImpersonate(pub, owner);
        opened++;
        if (opened % 10 === 0 || opened === pairs.length) {
            console.log(`  acceptBid ${opened}/${pairs.length} (punk #${punkId}, trait ${traitId})`);
        }
    }

    // ── Step 6: warp past the 72h deadline ─────────────────────────────
    const WARP_SECONDS = 72 * 60 * 60 + 5 * 60; // 72h + 5min cushion
    await rpc(pub, 'evm_increaseTime', [WARP_SECONDS]);
    await rpc(pub, 'evm_mine', []);
    console.log(`warped +${WARP_SECONDS}s past return auction deadlines`);

    // ── Step 7: settle each return auction (vault outcome) ─────────────────
    const settlerWallet = createWalletClient({account: SETTLER_ADDR, transport: http(RPC_URL)});
    let settled = 0;
    for (const {punkId} of pairs) {
        const settleHash = await settlerWallet.writeContract({
            chain: null,
            address: deployments.returnAuctionModule,
            abi: FINAL_SALE_ABI,
            functionName: 'settle',
            args: [punkId],
            account: SETTLER_ADDR,
        });
        await pub.waitForTransactionReceipt({hash: settleHash});
        settled++;
        if (settled % 10 === 0 || settled === pairs.length) {
            console.log(`  settle ${settled}/${pairs.length} (punk #${punkId})`);
        }
    }

    // ── Step 8: restore patron's bounty ────────────────────────────────
    const refillTarget = originalBid > parseEther(BOUNTY_REFILL_ETH.toString())
        ? originalBid
        : parseEther(BOUNTY_REFILL_ETH.toString());
    await fundBidViaAdapter(pub, deployments.patron, refillTarget);
    console.log(`live bid restored to ${refillTarget} wei (~${refillTarget / 10n ** 18n} ETH) via adapter`);

    // Mine a stabilizing block.
    await rpc(pub, 'evm_mine', []);

    // ── Step 9: verify ─────────────────────────────────────────────────
    const [finalCount, ready, kicked] = await Promise.all([
        pub.readContract({
            address: deployments.permanentCollection,
            abi: PC_ABI,
            functionName: 'collectedCount',
        }) as Promise<bigint>,
        pub.readContract({
            address: deployments.titleAuction,
            abi: TITLE_ABI,
            functionName: 'isKickoffReady',
        }) as Promise<boolean>,
        pub.readContract({
            address: deployments.titleAuction,
            abi: TITLE_ABI,
            functionName: 'kickedOff',
        }) as Promise<boolean>,
    ]);
    console.log(`\nfinal collectedCount: ${finalCount} / ${TRAIT_COUNT}`);
    console.log(`isKickoffReady():     ${ready}`);
    console.log(`kickedOff():          ${kicked}`);

    if (Number(finalCount) < TARGET_COLLECTED) {
        throw new Error(`SEED FAILED: collectedCount ${finalCount} < ${TARGET_COLLECTED}`);
    }
    // The threshold gate is opened iff isKickoffReady (auction not yet kicked
    // off but ready to be) OR kickedOff (auction already past kickoff). A
    // fresh fork lands in the first state; a re-run on an already-kicked-off
    // fork lands in the second. Both prove the seed succeeded.
    if (!ready && !kicked) {
        throw new Error('SEED FAILED: kickoff gate neither ready nor already crossed');
    }
    if (ready) {
        console.log('\n✓ Title Auction kickoff gate is now OPEN. Visit /title to call kickoff().');
    } else {
        console.log('\n✓ Title Auction has already been kicked off — bidding is live at /title.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
