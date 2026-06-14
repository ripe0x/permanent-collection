/**
 * seed-acquisitions.ts — local-fork helper to drive the protocol to an exact
 * number of VAULTED Punks (collected traits), so you can test the frontend at
 * different collection-progress states: 1 acquired, 10, 100, the full 111.
 *
 * For each Punk it runs the real on-chain acceptBid → silenced return-auction →
 * settle flow (the same path the UI drives), so the resulting state is genuine,
 * not faked:
 *   1) Fund the live bid once so acceptBid has ETH to pay each listing. By
 *      default this RUNS REAL SWAPS (SimulateTrading) so the bid accrues
 *      organically and the volume / fee / anti-sniper UI state is genuine; on a
 *      fork already above the activation threshold the swap path falls back to
 *      minting (see fundBid). FAST=1 skips trading and mints directly.
 *   2) Walk Punk ids, skipping already-recorded ones and any whose
 *      `canonicalTargetOf` reverts (no eligible trait). For each kept Punk:
 *      impersonate its owner → list it EXCLUSIVELY to Patron at a small positive
 *      price (the current contract rejects a zero-price listing) → `acceptBid`
 *      with the PROTOCOL-DERIVED target (`canonicalTargetOf`, re-read fresh each
 *      iteration so the rarest-first targets stay distinct as traits go pending).
 *      Each acceptBid opens a 72h return auction.
 *   3) Warp `evm_increaseTime` past 72h, mine a block.
 *   4) `settle` each auction with no rescue bid → Punk vaulted, target trait
 *      permanent. Settle is permissionless.
 *
 * Idempotent: targets a TOTAL collected count, so re-running tops up to the
 * target and exits early if already there.
 *
 * Usage:
 *   pnpm seed:acquisitions 10                 # 10 total vaulted Punks
 *   COUNT=100 pnpm seed:acquisitions          # 100
 *   RESCUE=2 pnpm seed:acquisitions 10        # 10 vaulted + 2 RESCUED auctions
 *   RPC_URL=http://127.0.0.1:8545 COUNT=1 pnpm tsx scripts/seed-acquisitions.ts
 *
 * RESCUE=N: also open N auctions that get RESCUED (a bid = reserve, then cleared)
 * rather than silenced — this is the ONLY path that funds VaultBurnPool +
 * BuybackBurner (and replenishes the live bid). Rescued Punks are NOT vaulted
 * (custody → ReturnedToMarket), so they're extra, on top of the COUNT vaulted.
 *
 * Local fork only — impersonates Punk owners and warps the chain clock.
 */
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    http,
    parseAbi,
    parseEther,
    type Address,
} from 'viem';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ANVIL = defineChain({
    id: 31337,
    name: 'Anvil',
    nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
    rpcUrls: {default: {http: ['http://127.0.0.1:8545']}},
    contracts: {multicall3: {address: '0xcA11bde05977b3631167028862bE2a173976CA11'}},
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const PUNKS_MARKET = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as const;

// Per-listing price. Small + fixed so a single bid funding covers many
// acquisitions; must be > 0 (the contract rejects a zero-price listing) and
// <= the live bid.
const LIST_WEI = parseEther('0.01');
const MARKET_ABI = parseAbi([
    'function offerPunkForSaleToAddress(uint256, uint256, address)',
    'function punkIndexToAddress(uint256) view returns (address)',
]);
const PATRON_ABI = parseAbi([
    'function acceptBid(uint16 punkId, uint8 targetTraitId, uint256 expectedListingWei)',
    'function bidBalance() view returns (uint256)',
]);
const PC_ABI = parseAbi([
    'function canonicalTargetOf(uint16) view returns (uint8)',
    'function collectedCount() view returns (uint256)',
    'function isRecorded(uint16) view returns (bool)',
]);
const RAM_ABI = parseAbi([
    'function settle(uint16 punkId)',
    'function placeBid(uint16 punkId) payable',
    'function reserveOf(uint16 punkId) view returns (uint256)',
]);
const ADAPTER_ABI = parseAbi(['function sweep()']);
const ERC20_ABI = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
]);

const deployments = JSON.parse(
    readFileSync(join(ROOT, 'contracts', 'deployments.json'), 'utf8'),
) as Record<string, Address>;

const pub = createPublicClient({chain: ANVIL, transport: http(RPC_URL)});

async function rpc(method: string, params: unknown[]) {
    const r = await fetch(RPC_URL, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
}

async function setBalance(addr: Address, wei: bigint) {
    await rpc('anvil_setBalance', [addr, '0x' + wei.toString(16)]);
}

async function impersonate(addr: Address) {
    await rpc('anvil_impersonateAccount', [addr]);
}
async function stopImpersonate(addr: Address) {
    await rpc('anvil_stopImpersonatingAccount', [addr]);
}

async function bidBalance(): Promise<bigint> {
    return (await pub.readContract({
        address: deployments.patron, abi: PATRON_ABI, functionName: 'bidBalance',
    })) as bigint;
}

async function token111(fn: 'balanceOf' | 'totalSupply', arg?: Address): Promise<bigint> {
    return (await pub.readContract({
        address: deployments.token, abi: ERC20_ABI, functionName: fn, args: arg ? [arg] : [],
    })) as bigint;
}
const whole = (w: bigint) => (w / 10n ** 18n).toLocaleString();

/** Run one batch of real V4 pool swaps via SimulateTrading.s.sol. The bid leg
 *  (~3.465% of volume) accrues in the LiveBidAdapter and streams into the live
 *  bid. `--slow` advances a block per tx so the per-swap stream can fire. */
function runSimulateTrading(nTrades: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'forge',
            [
                'script', 'script/SimulateTrading.s.sol:SimulateTrading',
                '--rpc-url', RPC_URL, '--broadcast', '--slow', '--skip-simulation',
                '--private-key', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            ],
            {
                cwd: join(ROOT, 'contracts'),
                stdio: ['ignore', 'ignore', 'inherit'],
                env: {...process.env, N_TRADES: String(nTrades), FLUSH_EVERY: '1000'},
            },
        );
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`SimulateTrading exited ${code}`))));
        child.on('error', reject);
    });
}

/** Run real V2 + V3 + V4 SIDE-pool trading via SimulateSidePoolTrading.s.sol.
 *  Each side-pool buy is taxed (venue→non-exempt 111 outflow), so 111 accrues
 *  in VaultBurnPool — to be burned on the next vault-path settle. `nSwaps` buys
 *  per venue. stdout is inherited so its accrued-tax report prints inline. */
function runSidePoolTrading(nSwaps: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'forge',
            [
                'script', 'script/SimulateSidePoolTrading.s.sol:SimulateSidePoolTrading',
                '--rpc-url', RPC_URL, '--broadcast', '--slow', '--skip-simulation',
                '--private-key', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            ],
            {
                cwd: join(ROOT, 'contracts'),
                stdio: ['ignore', 'inherit', 'inherit'],
                env: {...process.env, SIDE_SWAPS: String(nSwaps)},
            },
        );
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`SimulateSidePoolTrading exited ${code}`))));
        child.on('error', reject);
    });
}

/** Open ONE silenced return auction on the next eligible Punk: impersonate its
 *  owner → list EXCLUSIVELY to Patron at LIST_WEI → acceptBid with the
 *  protocol-derived target. Returns the Punk id, or null if none eligible.
 *  Caller must have funded the live bid for one more LIST_WEI listing. */
async function openOneAuction(): Promise<{punkId: number; trait: number} | null> {
    for (let punkId = 0; punkId < 10_000; punkId++) {
        const recorded = await pub.readContract({
            address: deployments.permanentCollection, abi: PC_ABI, functionName: 'isRecorded', args: [punkId],
        });
        if (recorded) continue;
        let trait: number;
        try {
            trait = Number(await pub.readContract({
                address: deployments.permanentCollection, abi: PC_ABI, functionName: 'canonicalTargetOf', args: [punkId],
            }));
        } catch {
            continue;
        }
        const owner = (await pub.readContract({
            address: PUNKS_MARKET, abi: MARKET_ABI, functionName: 'punkIndexToAddress', args: [BigInt(punkId)],
        })) as Address;
        if (!owner || owner === '0x0000000000000000000000000000000000000000') continue;
        try {
            await impersonate(owner);
            await setBalance(owner, parseEther('1'));
            const w = createWalletClient({account: owner, chain: ANVIL, transport: http(RPC_URL)});
            await pub.waitForTransactionReceipt({
                hash: await w.writeContract({
                    address: PUNKS_MARKET, abi: MARKET_ABI, functionName: 'offerPunkForSaleToAddress',
                    args: [BigInt(punkId), LIST_WEI, deployments.patron],
                }),
            });
            await pub.waitForTransactionReceipt({
                hash: await w.writeContract({
                    address: deployments.patron, abi: PATRON_ABI, functionName: 'acceptBid', args: [punkId, trait, LIST_WEI],
                }),
            });
            await stopImpersonate(owner);
            return {punkId, trait};
        } catch {
            await stopImpersonate(owner).catch(() => {});
        }
    }
    return null;
}

/** Mint the bid: set the adapter's balance and sweep it into Patron. Instant,
 *  no trades. Funds ONCE before any acceptBid while the activation threshold is
 *  still at its 30-ETH seed, so the adapter fast-fills the whole buffer. */
async function mintBid(needed: bigint, dev: Address) {
    await setBalance(deployments.liveBidAdapter, needed + parseEther('0.5'));
    await impersonate(dev);
    const w = createWalletClient({account: dev, chain: ANVIL, transport: http(RPC_URL)});
    await pub.waitForTransactionReceipt({
        hash: await w.writeContract({address: deployments.liveBidAdapter, abi: ADAPTER_ABI, functionName: 'sweep'}),
    });
    await stopImpersonate(dev);
}

/** Fund the live bid to at least `needed` wei.
 *
 *  Default ("run the trades"): real V4 swaps via SimulateTrading, so the bid
 *  accrues organically and the volume / fee / anti-sniper UI state is genuine.
 *  This works cleanly on a FRESH fork (bid below the 30-ETH activation
 *  threshold → the adapter fast-fills with no cooldown). On a fork already
 *  ABOVE the threshold (e.g. after a prior acquisition dropped it), the
 *  throttle's sweep cooldown rejects SimulateTrading's periodic sweeps
 *  (SweepTooEarly) — so on any failure (or if swaps can't reach the target)
 *  we fall back to minting the bid, and the seed still completes.
 *
 *  FAST=1 skips trading entirely and mints — for quick frontend iteration
 *  where only the collected count matters. */
async function fundBid(needed: bigint, dev: Address) {
    await setBalance(dev, parseEther('100'));

    if (process.env.FAST === '1') {
        await mintBid(needed, dev);
        console.log(`  [FAST] bid funded: ${(Number(await bidBalance()) / 1e18).toFixed(3)} ETH (minted, no trades)`);
        return;
    }

    if ((await bidBalance()) >= needed) {
        console.log(`  bid already covers ${(Number(needed) / 1e18).toFixed(3)} ETH — no trades needed`);
        return;
    }

    console.log('  funding the live bid with real swaps (SimulateTrading)… FAST=1 to skip');
    const MAX_BATCHES = 12;
    try {
        for (let batch = 0; batch < MAX_BATCHES && (await bidBalance()) < needed; batch++) {
            console.log(`  bid ${(Number(await bidBalance()) / 1e18).toFixed(3)} / ${(Number(needed) / 1e18).toFixed(3)} ETH — trading batch ${batch + 1}…`);
            await runSimulateTrading(60);
        }
    } catch (e) {
        console.warn(`  ⚠ real-swap funding failed (${(e as Error).message.split('\n')[0]}) — likely the adapter throttle on a non-fresh fork. Minting the bid instead.`);
    }

    if ((await bidBalance()) < needed) {
        console.warn('  ⚠ swaps did not reach the target — topping up by minting so the seed completes.');
        await mintBid(needed, dev);
    }
    console.log(`  live bid funded: ${(Number(await bidBalance()) / 1e18).toFixed(3)} ETH`);
}

function parseCount(): number {
    const raw = process.argv[2] ?? process.env.COUNT;
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n < 1 || n > 111) {
        throw new Error(
            `Specify a target count 1..111: \`pnpm seed:acquisitions 10\` or \`COUNT=10 ...\` (got: ${raw ?? 'unset'})`,
        );
    }
    return n;
}

async function main() {
    const target = parseCount();
    const dev = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address; // anvil acct 0

    // RESCUE=N: additionally open N auctions that get RESCUED (cleared) rather
    // than silenced — funding VaultBurnPool + BuybackBurner + replenishing the
    // bid. Rescued Punks are NOT vaulted (custody → ReturnedToMarket, trait not
    // collected), so they're EXTRA acquisitions beyond the `collected` target.
    const rescueN = Math.max(0, Number(process.env.RESCUE ?? 0) | 0);
    // DEMO (default on): also run real V2/V3/V4 SIDE-pool trading — accruing 111
    // tax in VaultBurnPool — and leave ONE ENDED-but-UNSETTLED silenced auction,
    // so you can settle it via the frontend and watch the accrued tax burn.
    // DEMO=0 skips it; SIDE_SWAPS=N sets buys per venue (0 = skip side trading).
    const wantDemo = process.env.DEMO !== '0';
    const sideSwaps = Math.max(0, Number(process.env.SIDE_SWAPS ?? 8) | 0);

    const collected = Number(
        await pub.readContract({address: deployments.permanentCollection, abi: PC_ABI, functionName: 'collectedCount'}),
    );
    const need = Math.max(0, target - collected);
    const totalOpen = need + rescueN;
    if (totalOpen === 0 && !wantDemo) {
        console.log(`Already at ${collected} collected (>= ${target}), RESCUE=0, DEMO=0. Nothing to do.`);
        return;
    }
    console.log(
        `Collected ${collected} → target ${target}: ${need} to vault` +
        (rescueN ? ` + ${rescueN} to rescue (funds VaultBurnPool/BuybackBurner)` : '') +
        (wantDemo ? ' + side-pool trading + 1 ended-but-unsettled demo auction' : '') + '.',
    );

    // ── Fund the live bid before any acceptBid (each acceptBid drains LIST_WEI).
    //    Default path runs real swaps; FAST=1 mints it. One LIST_WEI per
    //    count/rescue auction + one for the demo listing, all <= the live bid.
    const listings = totalOpen + (wantDemo ? 1 : 0);
    await fundBid(LIST_WEI * BigInt(listings) + parseEther('0.2'), dev);

    if (totalOpen > 0) {
    // ── Open `totalOpen` return auctions. Re-read canonicalTargetOf fresh per
    //    Punk so each target is distinct (a just-accepted trait is pending →
    //    skipped). The first `rescueN` opened are designated for rescue.
    const opened: number[] = [];
    for (let punkId = 0; punkId < 10_000 && opened.length < totalOpen; punkId++) {
        const recorded = await pub.readContract({
            address: deployments.permanentCollection, abi: PC_ABI, functionName: 'isRecorded', args: [punkId],
        });
        if (recorded) continue;

        let target8: number;
        try {
            target8 = Number(
                await pub.readContract({
                    address: deployments.permanentCollection, abi: PC_ABI, functionName: 'canonicalTargetOf', args: [punkId],
                }),
            );
        } catch {
            continue; // NoEligibleTarget — every trait collected/pending
        }

        const owner = (await pub.readContract({
            address: PUNKS_MARKET, abi: MARKET_ABI, functionName: 'punkIndexToAddress', args: [BigInt(punkId)],
        })) as Address;
        if (!owner || owner === '0x0000000000000000000000000000000000000000') continue;

        try {
            await impersonate(owner);
            await setBalance(owner, parseEther('1')); // gas
            const w = createWalletClient({account: owner, chain: ANVIL, transport: http(RPC_URL)});
            const listHash = await w.writeContract({
                address: PUNKS_MARKET, abi: MARKET_ABI, functionName: 'offerPunkForSaleToAddress',
                args: [BigInt(punkId), LIST_WEI, deployments.patron],
            });
            await pub.waitForTransactionReceipt({hash: listHash});
            const acceptHash = await w.writeContract({
                address: deployments.patron, abi: PATRON_ABI, functionName: 'acceptBid',
                args: [punkId, target8, LIST_WEI],
            });
            await pub.waitForTransactionReceipt({hash: acceptHash});
            opened.push(punkId);
            await stopImpersonate(owner);
            if (opened.length % 10 === 0 || opened.length === totalOpen) {
                console.log(`  opened ${opened.length}/${totalOpen} (punk #${punkId}, trait ${target8})`);
            }
        } catch (e) {
            await stopImpersonate(owner).catch(() => {});
            console.log(`  ✗ punk #${punkId} skipped: ${(e as Error).message.split('\n')[0]}`);
        }
    }

    if (opened.length < totalOpen) {
        throw new Error(`Only opened ${opened.length}/${totalOpen} auctions — ran out of eligible Punks before the target.`);
    }

    // The first `rescueN` opened are rescued (bid ≥ reserve before the warp); the
    // rest are silenced (no bid → vaulted).
    const rescueIds = opened.slice(0, rescueN);
    const vaultIds = opened.slice(rescueN);

    // ── Place a winning bid (= reserve) on each rescue auction, from `dev`.
    if (rescueIds.length) {
        console.log(`  bidding reserve on ${rescueIds.length} auction(s) to rescue…`);
        await impersonate(dev);
        const bidder = createWalletClient({account: dev, chain: ANVIL, transport: http(RPC_URL)});
        for (const punkId of rescueIds) {
            const reserve = (await pub.readContract({
                address: deployments.returnAuctionModule, abi: RAM_ABI, functionName: 'reserveOf', args: [punkId],
            })) as bigint;
            const h = await bidder.writeContract({
                address: deployments.returnAuctionModule, abi: RAM_ABI, functionName: 'placeBid',
                args: [punkId], value: reserve,
            });
            await pub.waitForTransactionReceipt({hash: h});
        }
        await stopImpersonate(dev);
    }

    // ── Warp past 72h, settle. Order matters: settle the SILENCED (vault)
    //    auctions FIRST, the RESCUED ones LAST. The vault-path settle sweeps
    //    VaultBurnPool → BuybackBurner, so a silenced settle after a rescue
    //    would drain the pool the rescue just funded back to 0. Rescues last =
    //    VaultBurnPool ends funded.
    console.log('  warping 72h + settling…');
    await rpc('evm_increaseTime', [72 * 60 * 60 + 5 * 60]);
    await rpc('evm_mine', []);
    await impersonate(dev);
    const settler = createWalletClient({account: dev, chain: ANVIL, transport: http(RPC_URL)});
    let settled = 0;
    for (const punkId of [...vaultIds, ...rescueIds]) {
        const h = await settler.writeContract({
            address: deployments.returnAuctionModule, abi: RAM_ABI, functionName: 'settle', args: [punkId],
        });
        await pub.waitForTransactionReceipt({hash: h});
        settled++;
        if (settled % 10 === 0 || settled === opened.length) console.log(`  settled ${settled}/${opened.length}`);
    }
    await stopImpersonate(dev);
    } // end if (totalOpen > 0)

    // ── Side-pool trading + ended-but-unsettled demo auction ──
    //    Runs AFTER the count/rescue vault settles, so those settles don't burn
    //    the side-pool tax — it sits in VaultBurnPool for the demo settle.
    let demo: {punkId: number; trait: number} | null = null;
    if (wantDemo) {
        if (sideSwaps > 0) {
            console.log(`\n  side-pool trading: real V2/V3/V4 buys (${sideSwaps} each) → accruing 111 tax in VaultBurnPool…`);
            try {
                await runSidePoolTrading(sideSwaps);
            } catch (e) {
                console.warn(`  ⚠ side-pool trading failed (${(e as Error).message.split('\n')[0]}) — continuing.`);
            }
        }
        console.log('  opening the demo auction (silenced; left ENDED + UNSETTLED for you)…');
        demo = await openOneAuction();
        if (demo) {
            // Warp past 72h so the demo auction is ENDED (settle-able) — but DON'T settle it.
            await rpc('evm_increaseTime', [72 * 60 * 60 + 5 * 60]);
            await rpc('evm_mine', []);
        } else {
            console.warn('  ⚠ no eligible Punk left for the demo auction.');
        }
    }

    const final = Number(
        await pub.readContract({address: deployments.permanentCollection, abi: PC_ABI, functionName: 'collectedCount'}),
    );
    const eth = (w: bigint) => (Number(w) / 1e18).toFixed(4);
    const vbpEth = await pub.getBalance({address: deployments.vaultBurnPool});
    const bbb = await pub.getBalance({address: deployments.buybackBurner});
    console.log(`\n✓ collectedCount = ${final} (target ${target}).`);
    if (rescueN) {
        console.log(`  rescued ${rescueN} → VaultBurnPool ${eth(vbpEth)} ETH, BuybackBurner ${eth(bbb)} ETH`);
    }
    if (demo) {
        const vbp111 = await token111('balanceOf', deployments.vaultBurnPool);
        console.log('\n──────────── DEMO: settle this via the frontend ────────────');
        console.log(`  Punk #${demo.punkId} (trait ${demo.trait}) — auction ENDED (72h elapsed), NOT settled.`);
        console.log(`  VaultBurnPool holds ${whole(vbp111)} of 111 (accrued side-pool tax) + ${eth(vbpEth)} ETH.`);
        console.log(`  → Settle Punk #${demo.punkId} via the frontend: it vaults the Punk, BURNS that 111`);
        console.log(`    (totalSupply drops by it), and sweeps the ETH to BuybackBurner.`);
        console.log('────────────────────────────────────────────────────────────');
    }
    if (final < target) throw new Error(`Ended at ${final}, below target ${target}.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
