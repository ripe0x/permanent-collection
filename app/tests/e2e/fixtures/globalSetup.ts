/**
 * Playwright globalSetup. Runs ONCE for the whole test run:
 *
 *   1. Spawn anvil (via start-dev-fork.sh) + run Deploy.s.sol.
 *   2. Spawn the Next dev server with the right env (chainId 31337,
 *      DATA_ADAPTER=fork, RPC_URL pointing at our anvil port).
 *   3. Write the lifecycle state (PIDs, addresses, ports) to a temp
 *      file so per-test fixtures + globalTeardown can read it back.
 *
 * Phase 1 has one spec; this fixture still scales cleanly to Phase 2+
 * because anvil snapshots/reverts (Phase 2 work) live inside the per-test
 * `renderer.ts` fixture, not here.
 *
 * Fail-loud: anything that doesn't come up cleanly throws and Playwright
 * marks the entire run as failed before any test runs.
 */

import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startAnvilAndDeploy, type Deployments} from './anvil';
import {appBaseUrl, E2E_ENV} from './env';

export interface GlobalState {
    rpcUrl: string;
    chainId: number;
    anvilPort: number;
    appPort: number;
    deployments: Deployments;
    appPid: number;
}

export const STATE_FILE = join(tmpdir(), 'pc-e2e-state.json');

async function globalSetup(): Promise<void> {
    // Belt-and-suspenders: if a previous run left a stale dev server on
    // our app port, free it now. anvil port is handled by start-dev-fork.sh.
    await killOnPort(E2E_ENV.appPort);

    // ── 1. anvil + Deploy.s.sol ─────────────────────────────────────
    const anvil = await startAnvilAndDeploy();

    // ── 2. Next dev server ──────────────────────────────────────────
    // Pass every NEXT_PUBLIC_*_ADDRESS the app's `getContractAddresses()`
    // reads, plus the renderer + V4 + protocol-admin addresses. We hand
    // them through process.env directly rather than relying on
    // `app/.env.local` (which start-dev-fork.sh only updates in place if
    // the file already exists; a fresh worktree has no .env.local yet,
    // so the script's sed-update silently no-ops).
    const d = anvil.deployments;
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Bind the Next dev server to our isolated test port. Next reads
        // PORT directly from env; no need for a CLI flag.
        PORT: String(E2E_ENV.appPort),
        // Fork-mode reads chain state direct from anvil (no indexer).
        NEXT_PUBLIC_DATA_ADAPTER: 'fork',
        NEXT_PUBLIC_CHAIN_ID: String(E2E_ENV.chainId),
        // Server-only RPC. The /api/rpc proxy routes browser reads here;
        // we want them to land on our anvil.
        RPC_URL: anvil.rpcUrl,
        // Skip rate-limiting on the proxy — local anvil bursts past the
        // 300/min default during page render (multicalls + getLogs).
        RPC_RATE_LIMIT_PER_MIN: '0',
        // RainbowKit's WalletConnect needs SOMETHING here; the placeholder
        // is fine because tests never open a real WC session.
        NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: 'LOCAL_DEV_PLACEHOLDER',
        // Make sure no leftover NEXT_PUBLIC_DEV_AUTOSIGN_PK from the
        // developer's shell sneaks in — that would swap RainbowKit's
        // wallet picker for the wagmi mock connector and bypass the
        // injected mock provider entirely.
        NEXT_PUBLIC_DEV_AUTOSIGN_PK: '',
        // Protocol deploy addresses — every NEXT_PUBLIC_* getContractAddresses()
        // and getV4Infrastructure() touch. Sourced from contracts/deployments.json
        // (just written by Deploy.s.sol).
        NEXT_PUBLIC_PERMANENT_COLLECTION_ADDRESS: d.permanentCollection,
        NEXT_PUBLIC_PATRON_ADDRESS: d.patron,
        NEXT_PUBLIC_RETURN_AUCTION_MODULE_ADDRESS: d.returnAuctionModule,
        NEXT_PUBLIC_PUNK_VAULT_ADDRESS: d.punkVault,
        NEXT_PUBLIC_BUYBACK_BURNER_ADDRESS: d.buybackBurner,
        NEXT_PUBLIC_LIVE_BID_ADAPTER_ADDRESS: d.liveBidAdapter,
        NEXT_PUBLIC_VAULT_BURN_POOL_ADDRESS: d.vaultBurnPool,
        NEXT_PUBLIC_PROTOCOL_FEE_PHASE_ADAPTER_ADDRESS: d.protocolFeePhaseAdapter,
        NEXT_PUBLIC_REFERRAL_PAYOUT_ADDRESS: d.referralPayout,
        NEXT_PUBLIC_PC_SWAP_CONTEXT_ADDRESS: d.pcSwapContext,
        NEXT_PUBLIC_TITLE_AUCTION_ADDRESS: d.titleAuction,
        NEXT_PUBLIC_RENDERER_ADDRESS: d.renderer,
        NEXT_PUBLIC_TOKEN_ADDRESS: d.token,
        NEXT_PUBLIC_PROTOCOL_ADMIN_ADDRESS: d.protocolAdmin,
        NEXT_PUBLIC_ARTCOINS_HOOK_ADDRESS: d.hook,
        // Canonical V4 + Permit2 infra (same on mainnet + the fork).
        NEXT_PUBLIC_PUNKS_MARKET_ADDRESS: '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB',
        NEXT_PUBLIC_PUNKS_DATA_ADDRESS: '0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C',
        NEXT_PUBLIC_V4_POOL_MANAGER: '0x000000000004444c5dC75cB358380D2e3dE08A90',
        NEXT_PUBLIC_V4_POSITION_MANAGER: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',
        NEXT_PUBLIC_V4_UNIVERSAL_ROUTER: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
    };

    // Neutralize operator PC_* runtime overrides that may sit in the dev
    // machine's app/.env.local (live-mainnet addresses, synced there by
    // capture-launch-addresses). config.ts resolves PC_<base> ahead of
    // NEXT_PUBLIC_<base>, and Next only loads .env.local keys that are
    // absent from the real environment — so blanking them here pins the
    // dev server to the fork deployment injected above (an empty PC_*
    // deliberately falls through to NEXT_PUBLIC_*). No-op on CI, which
    // has no .env.local.
    for (const key of Object.keys(env)) {
        if (key.startsWith('NEXT_PUBLIC_') && key.endsWith('_ADDRESS')) {
            env[`PC_${key.slice('NEXT_PUBLIC_'.length)}`] = '';
        }
    }
    env.PC_VAULT_BURN_ADAPTER_ADDRESS = '';
    env.PC_PROTOCOL_LIVE = '';

    // `pnpm --filter ./app` matches the worktree's app workspace — the
    // bare-name `--filter app` form is ambiguous and pnpm in this version
    // emits "No projects matched the filters". Mirrors the root scripts'
    // `app:dev` convention.
    const appChild = spawn('pnpm', ['--filter', './app', 'dev'], {
        cwd: E2E_ENV.repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detach so the dev server outlives this globalSetup process
        // and Playwright can drive it from test workers.
        detached: true,
    });
    if (!appChild.pid) {
        await anvil.cleanup();
        throw new Error('e2e: failed to spawn Next dev server');
    }

    // Capture stdout/stderr until we're sure it's bound, then unref so
    // node exits cleanly when globalSetup returns.
    let stderr = '';
    appChild.stdout?.on('data', (chunk: Buffer) => {
        const line = chunk.toString();
        process.stderr.write(`[next] ${line}`);
    });
    appChild.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString();
        stderr += line;
        process.stderr.write(`[next] ${line}`);
    });

    try {
        await waitForServer(appBaseUrl(), 120_000);
    } catch (e) {
        // Surface the dev server's stderr in the failure message —
        // it's the only place "missing env var" / "compile error"
        // diagnostics show up.
        await killPid(appChild.pid);
        await anvil.cleanup();
        throw new Error(
            `e2e: Next dev server failed to bind on ${appBaseUrl()} within 120s.\n--- last 40 lines of stderr ---\n${stderr.split('\n').slice(-40).join('\n')}\n--- end ---\nOriginal error: ${String(e)}`,
        );
    }

    // Warm Turbopack's route + API caches. Cold-compile of /accept and
    // the per-route APIs takes 15-40s on a fresh dev server; the
    // owned-punks API additionally scans 10k slots via Multicall3
    // against anvil, which can take 60-90s on the first cold call
    // (anvil lazily fetches forked state for slot reads not yet in its
    // working set). Without this warmup the first specs eat their
    // entire per-test budget here.
    //
    // 180s budget per warmup is intentionally generous — globalSetup
    // doesn't have a per-test budget, and a stuck compile here is much
    // cheaper to diagnose than a per-test timeout cascade. Errors are
    // non-fatal (logged + continue) so a transient timeout doesn't
    // sink the suite; tests just pay the cold cost on first hit.
    await warmRoute(`${appBaseUrl()}/accept`, 180_000);
    await warmRoute(
        `${appBaseUrl()}/api/owned-punks?address=0x0000000000000000000000000000000000000001`,
        180_000,
    );
    await warmRoute(
        `${appBaseUrl()}/api/eligibility?punkId=0`,
        180_000,
    );

    // ── 3. persist state ────────────────────────────────────────────
    const state: GlobalState = {
        rpcUrl: anvil.rpcUrl,
        chainId: anvil.chainId,
        anvilPort: E2E_ENV.anvilPort,
        appPort: E2E_ENV.appPort,
        deployments: anvil.deployments,
        appPid: appChild.pid,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    process.stderr.write(`[e2e] globalSetup done → ${STATE_FILE}\n`);

    // Detach the dev server so Playwright's globalSetup process can exit.
    appChild.unref();
}

/** Hit a route once with a generous timeout so Turbopack compiles it
 *  inside globalSetup rather than during a test. Non-fatal — logs and
 *  returns on failure. */
async function warmRoute(url: string, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    try {
        const res = await fetch(url, {redirect: 'manual', signal: controller.signal});
        process.stderr.write(`[e2e] warmed ${url} → ${res.status} in ${Date.now() - t0}ms\n`);
    } catch (e) {
        process.stderr.write(`[e2e] warmRoute(${url}) failed after ${Date.now() - t0}ms: ${String(e)}\n`);
    } finally {
        clearTimeout(timer);
    }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    let lastErr: unknown = null;
    while (Date.now() - started < timeoutMs) {
        try {
            const res = await fetch(url, {redirect: 'manual'});
            // Any HTTP status — even 5xx — proves the server is BOUND.
            // We want to be liberal here; full readiness gets verified
            // by the first test's navigation.
            if (res.status > 0) return;
        } catch (e) {
            lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`server at ${url} did not respond. Last error: ${String(lastErr)}`);
}

async function killOnPort(port: number): Promise<void> {
    await new Promise<void>((resolve) => {
        const child = spawn(
            'bash',
            // `-sTCP:LISTEN` so we only kill a stale *server* bound to the
            // port, never a process that merely holds a client connection to
            // it (a bare `lsof -ti tcp:${port}` matches both — see
            // globalTeardown.killOnPort for the full footgun writeup).
            ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true`],
            {stdio: 'ignore'},
        );
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
    });
}

async function killPid(pid: number): Promise<void> {
    await new Promise<void>((resolve) => {
        const child = spawn('bash', ['-c', `kill -9 ${pid} 2>/dev/null || true`], {
            stdio: 'ignore',
        });
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
    });
}

// Silence the unused-import on Phase 1 build — we keep the type imported
// so editors light up references in renderer.ts / globalTeardown.ts.
export type {ChildProcess};

export default globalSetup;
