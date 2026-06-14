#!/usr/bin/env tsx
/**
 * capture-launch-addresses.ts
 * ---------------------------------------------------------------------------
 * Turns a deploy's `contracts/deployments.json` into the frontend's launch
 * config and (optionally) pushes it straight to Netlify, so the site can be
 * wired against the real contract addresses the instant the coin is live.
 *
 *   1. Reads `contracts/deployments.json` (written by Deploy.s.sol on any
 *      fork or mainnet broadcast).
 *   2. Maps each contract to its runtime `PC_*` env var (recommended — the app
 *      reads these per request, so setting them flips the live site WITHOUT a
 *      rebuild) and prints the build-time `NEXT_PUBLIC_*_ADDRESS` twins (same
 *      mapping `scripts/start-dev-fork.sh` uses for local dev) for reference.
 *   3. Computes the V4 `poolId` the SwapBox trades against
 *      (keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hook))).
 *   4. Prints a ready-to-paste env block.
 *   5. With `--push`, runs `netlify env:set` for each address var on the
 *      linked site (`.netlify/state.json`).
 *   6. Prints a ready-to-paste `fly secrets set` block for the pc-ponder
 *      indexer (same deployments.json source, so both surfaces are configured
 *      from one artifact). Print-only — never pushed.
 *
 * Usage (run from the repo root, where contracts/deployments.json lives):
 *   tsx scripts/capture-launch-addresses.ts            # preview only, no writes
 *   tsx scripts/capture-launch-addresses.ts --push     # also set the Netlify vars
 *   tsx scripts/capture-launch-addresses.ts --push --context production
 *
 * SAFETY
 *   - Only ever touches the PC_*_ADDRESS runtime vars (the build-time
 *     NEXT_PUBLIC_* twins are printed for reference, never written). It never
 *     sets RPC_URL, DEFAULT_REFERRER, or any secret.
 *   - `--push` is opt-in; the default run writes nothing.
 *   - The indexer `fly secrets set` block is PRINT-ONLY; `--push` only ever
 *     touches Netlify, never Fly.
 *
 * DRY-RUN VALUES
 *   A `deployments.json` produced by `pnpm dev:up` holds DEV-FORK addresses
 *   (a fresh factory), not the real launch addresses. Re-run this against the
 *   REAL post-broadcast deployments.json before setting the live `PC_*` vars,
 *   or the live site will point at addresses that don't exist on mainnet.
 */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {encodeAbiParameters, getAddress, isAddress, keccak256, zeroAddress, type Address} from 'viem';
import {CANONICAL_POOL_ID_KEY, INDEXER_ADDRESS_MAP} from './lib/indexer-addresses';

// ── V4 pool key params — must match contracts/script/Deploy.s.sol ──────────
const DYNAMIC_FEE_FLAG = 0x800000; // hook decides the LP fee per swap
const POOL_TICK_SPACING = 200;

// env var → deployments.json key. Mirrors the PAIRS array in
// scripts/start-dev-fork.sh; keep the two in sync.
const ADDRESS_MAP: ReadonlyArray<readonly [string, string]> = [
    ['NEXT_PUBLIC_PERMANENT_COLLECTION_ADDRESS', 'permanentCollection'],
    ['NEXT_PUBLIC_PATRON_ADDRESS', 'patron'],
    ['NEXT_PUBLIC_RETURN_AUCTION_MODULE_ADDRESS', 'returnAuctionModule'],
    ['NEXT_PUBLIC_PUNK_VAULT_ADDRESS', 'punkVault'],
    ['NEXT_PUBLIC_BUYBACK_BURNER_ADDRESS', 'buybackBurner'],
    ['NEXT_PUBLIC_LIVE_BID_ADAPTER_ADDRESS', 'liveBidAdapter'],
    ['NEXT_PUBLIC_VAULT_BURN_POOL_ADDRESS', 'vaultBurnPool'],
    ['NEXT_PUBLIC_PROTOCOL_FEE_PHASE_ADAPTER_ADDRESS', 'protocolFeePhaseAdapter'],
    ['NEXT_PUBLIC_REFERRAL_PAYOUT_ADDRESS', 'referralPayout'],
    ['NEXT_PUBLIC_PC_SWAP_CONTEXT_ADDRESS', 'pcSwapContext'],
    ['NEXT_PUBLIC_RENDERER_ADDRESS', 'renderer'],
    ['NEXT_PUBLIC_TOKEN_ADDRESS', 'token'],
    ['NEXT_PUBLIC_PROTOCOL_ADMIN_ADDRESS', 'protocolAdmin'],
    ['NEXT_PUBLIC_ARTCOINS_HOOK_ADDRESS', 'hook'],
    ['NEXT_PUBLIC_TITLE_AUCTION_ADDRESS', 'titleAuction'],
] as const;

// INDEXER_ADDRESS_MAP (indexer env var → deployments.json key) is shared with
// scripts/sync-indexer-env.ts via ./lib/indexer-addresses. Every key in it is
// also in ADDRESS_MAP above (the indexer tracks a subset of the deployed
// contracts).

// Default Fly app name for the indexer (matches indexer/fly.toml).
const INDEXER_FLY_APP = 'pc-ponder';

function fail(msg: string): never {
    console.error(`\n✗ ${msg}\n`);
    process.exit(1);
}

function computePoolId(token: Address, hook: Address): `0x${string}` {
    // Native-ETH pair: currency0 = address(0) (sorts below any token), token = currency1.
    return keccak256(
        encodeAbiParameters(
            [{type: 'address'}, {type: 'address'}, {type: 'uint24'}, {type: 'int24'}, {type: 'address'}],
            [zeroAddress, token, DYNAMIC_FEE_FLAG, POOL_TICK_SPACING, hook],
        ),
    );
}

/** Runtime-override twin of a build-time `NEXT_PUBLIC_*` name: `PC_` + the name
 *  without the `NEXT_PUBLIC_` prefix. The frontend reads these per request and
 *  injects them into the page, so setting them flips the live site WITHOUT a
 *  rebuild (see `app/lib/config.ts`). */
function pcName(nextPublicName: string): string {
    return `PC_${nextPublicName.replace(/^NEXT_PUBLIC_/, '')}`;
}

function main() {
    const args = process.argv.slice(2);
    const push = args.includes('--push');
    const ctxIdx = args.indexOf('--context');
    const context = ctxIdx >= 0 ? args[ctxIdx + 1] : undefined;

    const root = process.cwd();
    const deploymentsPath = join(root, 'contracts', 'deployments.json');
    if (!existsSync(deploymentsPath)) {
        fail(
            `No contracts/deployments.json at ${deploymentsPath}.\n` +
                `  Run a deploy first (e.g. \`pnpm dev:up\` for a fork dry-run, or the real\n` +
                `  mainnet broadcast), then re-run this from the repo root.`,
        );
    }

    const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, unknown>;
    const chainId = deployments.chainId;
    const deployBlock = deployments.deployBlock;

    const resolved: Array<[string, Address]> = [];
    const byKey = new Map<string, Address>();
    const missing: string[] = [];
    for (const [envName, key] of ADDRESS_MAP) {
        const raw = deployments[key];
        if (typeof raw === 'string' && isAddress(raw)) {
            const addr = getAddress(raw);
            resolved.push([envName, addr]);
            byKey.set(key, addr);
        } else {
            missing.push(`${envName} (deployments key: ${key})`);
        }
    }

    const token = resolved.find(([n]) => n === 'NEXT_PUBLIC_TOKEN_ADDRESS')?.[1];
    const hook = resolved.find(([n]) => n === 'NEXT_PUBLIC_ARTCOINS_HOOK_ADDRESS')?.[1];
    if (!token) fail('deployments.json has no `token` — cannot build the pool key.');
    if (!hook) fail('deployments.json has no `hook` — cannot build the pool key.');
    const poolId = computePoolId(token, hook);

    // ── report ────────────────────────────────────────────────────────────
    console.log('\n# ── 111PUNKS launch env — captured from contracts/deployments.json ──');
    console.log(`# chainId=${chainId ?? '?'}  deployBlock=${deployBlock ?? '?'}  (${resolved.length} addresses)`);
    // A fork dry-run forks mainnet, so chainId stays 1 — it can't tell a real
    // broadcast from a fork deploy. Always remind the operator to verify
    // provenance before these go live.
    console.log('# ⚠ These reflect whatever deploy last wrote deployments.json. A `pnpm dev:up`');
    console.log('#   dry-run uses a FRESH factory, so token/hook differ from the real launch.');
    console.log('#   Confirm this is the REAL post-broadcast deployments.json before you set them.');
    console.log('');
    console.log('# RUNTIME vars (PC_*) — recommended. Read per request and injected into the');
    console.log('# page, so setting them flips the live site to trading WITHOUT a rebuild: the');
    console.log('# change applies on the next request after the host restarts the Node runtime');
    console.log('# (sub-second on Vercel/Netlify). isProtocolLive() flips when PC_TOKEN_ADDRESS');
    console.log('# is a real, non-zero address.');
    for (const [envName, addr] of resolved) console.log(`${pcName(envName)}=${addr}`);
    console.log('');
    console.log(`# poolId (V4) — the SwapBox derives this from token+hook; shown for verification:`);
    console.log(`# POOL_ID=${poolId}`);
    console.log('');
    console.log('# Build-time twins (NEXT_PUBLIC_*) also work but require a REBUILD to change, so');
    console.log('# they are NOT the launch-flip path — listed (commented) for reference only:');
    for (const [envName, addr] of resolved) console.log(`#   ${envName}=${addr}`);
    if (missing.length) {
        console.log('\n# skipped (no value in deployments.json):');
        for (const m of missing) console.log(`#   - ${m}`);
    }

    // ── indexer secrets block (print-only — never pushed to Fly) ────────────
    const idxResolved: Array<[string, string]> = [];
    const idxMissing: string[] = [];
    for (const [envName, key] of INDEXER_ADDRESS_MAP) {
        const addr = byKey.get(key);
        if (addr) idxResolved.push([envName, addr]);
        else idxMissing.push(`${envName} (deployments key: ${key})`);
    }
    // Canonical pool id (bytes32, not an address — outside the map). Gates the
    // indexer's SkimSplit volume handler to the canonical pool.
    const idxPoolId = deployments[CANONICAL_POOL_ID_KEY];
    if (typeof idxPoolId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(idxPoolId)) {
        idxResolved.push(['CANONICAL_POOL_ID', idxPoolId]);
    } else {
        idxMissing.push(`CANONICAL_POOL_ID (deployments key: ${CANONICAL_POOL_ID_KEY})`);
    }
    const startBlock =
        typeof deployBlock === 'number' || typeof deployBlock === 'string'
            ? String(deployBlock)
            : '<deploy block>';
    console.log(`\n# ── pc-ponder indexer secrets (Fly) — same deployments.json source ──`);
    console.log('# Copy-paste to configure the indexer. PUNKS_MARKET_START_BLOCK defaults to the');
    console.log('# deploy block for a fast backfill; lower it (a few months earlier) if you want');
    console.log('# pre-launch open-listing history in the home market-reference panel. RPC needs');
    console.log('# no secret — ponder.config.ts defaults to the free Tenderly→drpc chain.');
    const flyLines = [
        `fly secrets set -a ${INDEXER_FLY_APP} \\`,
        `  START_BLOCK=${startBlock} \\`,
        `  PUNKS_MARKET_START_BLOCK=${startBlock}${idxResolved.length ? ' \\' : ''}`,
        ...idxResolved.map(
            ([n, a], i) => `  ${n}=${a}${i === idxResolved.length - 1 ? '' : ' \\'}`,
        ),
    ];
    console.log(flyLines.join('\n'));
    if (idxMissing.length) {
        console.log('\n# indexer addresses missing from deployments.json:');
        for (const m of idxMissing) console.log(`#   - ${m}`);
    }

    if (!push) {
        console.log('\n(preview only — re-run with `--push` to set the PC_* runtime vars on Netlify)\n');
        return;
    }

    // ── push to Netlify ─────────────────────────────────────────────────────
    if (!existsSync(join(root, '.netlify', 'state.json'))) {
        fail('No .netlify/state.json — link the site first (`netlify link`) or run from the linked repo root.');
    }
    const ctxArgs = context ? ['--context', context] : [];
    // The repo is a monorepo (app/contracts/indexer); without --filter the
    // Netlify CLI prompts to pick a workspace and hangs non-interactively.
    const filterArgs = ['--filter', 'permanent-collection-app'];
    console.log(`\nPushing ${resolved.length} PC_* runtime address vars to Netlify${context ? ` (context: ${context})` : ''}…`);
    for (const [envName, addr] of resolved) {
        const name = pcName(envName);
        try {
            execFileSync('netlify', ['env:set', name, addr, ...ctxArgs, ...filterArgs], {stdio: 'pipe', cwd: root});
            console.log(`  ✓ ${name}`);
        } catch (e) {
            const out = e && typeof e === 'object' && 'stderr' in e ? String((e as {stderr: unknown}).stderr) : String(e);
            fail(`netlify env:set ${name} failed:\n${out}`);
        }
    }
    console.log(
        `\n✓ Done. These are RUNTIME vars — once the host restarts the Node runtime (sub-second,` +
            ` no rebuild) the site reads them on the next request, flipping it from "not launched` +
            ` yet" to live trading.\n`,
    );
}

main();
