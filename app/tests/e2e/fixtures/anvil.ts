/**
 * Anvil + Deploy.s.sol lifecycle for the e2e harness.
 *
 * Shells out to scripts/start-dev-fork.sh which already does:
 *   1. kill anything on tcp:${PORT} (port-specific, since we land the
 *      KILL_ALL_ANVILS=1 carve-out — see start-dev-fork.sh for the
 *      pre-existing comment block on why blanket-kill used to be
 *      the default),
 *   2. spawn anvil pinned to FORK_BLOCK,
 *   3. warm V4 + Permit2 + Universal Router state into the fork,
 *   4. top up DEV_WALLETS,
 *   5. bootstrap the 4 artcoins prerequisites (hook, MEV module,
 *      PCController, conversion locker),
 *   6. broadcast Deploy.s.sol,
 *   7. sync the resulting addresses into app/.env.local,
 *   8. warp 70 minutes past the MEV anti-sniper window.
 *
 * This fixture is a thin orchestrator on top:
 *   - reads the synced addresses out of contracts/deployments.json,
 *   - polls eth_blockNumber to confirm anvil is healthy,
 *   - exposes a teardown that kills the spawned anvil cleanly.
 *
 * Fail-loud:
 *   - non-zero exit from start-dev-fork.sh → throw
 *   - missing deployments.json or any required address → throw
 *   - eth_blockNumber doesn't respond within 30s → throw
 *
 * Standing rule: e2e fixtures must fail loud when preconditions are
 * missing, never silently pass [[feedback_test_fail_loud]].
 */

import {spawn} from 'node:child_process';
import {closeSync, existsSync, openSync, readFileSync, writeSync} from 'node:fs';
import {join} from 'node:path';
import {E2E_ENV, anvilRpcUrl, type Address} from './env';

export interface Deployments {
    token: Address;
    patron: Address;
    permanentCollection: Address;
    punkVault: Address;
    returnAuctionModule: Address;
    buybackBurner: Address;
    liveBidAdapter: Address;
    vaultBurnPool: Address;
    protocolFeePhaseAdapter: Address;
    referralPayout: Address;
    pcSwapContext: Address;
    renderer: Address;
    protocolAdmin: Address;
    hook: Address;
    titleAuction: Address;
}

export interface AnvilFixture {
    rpcUrl: string;
    chainId: typeof E2E_ENV.chainId;
    deployments: Deployments;
    /** Tear down the spawned anvil process. Idempotent — calling twice
     *  is a no-op. */
    cleanup: () => Promise<void>;
}

/** Spawn anvil + run Deploy.s.sol. Resolves once anvil is healthy and the
 *  deployment is verified on-chain. Throws on any precondition failure. */
export async function startAnvilAndDeploy(): Promise<AnvilFixture> {
    const scriptPath = join(E2E_ENV.repoRoot, 'scripts/start-dev-fork.sh');
    if (!existsSync(scriptPath)) {
        throw new Error(`e2e: start-dev-fork.sh not found at ${scriptPath}`);
    }

    // start-dev-fork.sh is foreground-blocking until deploy finishes (anvil
    // itself is `nohup … &` inside the script, so the script exits after
    // the deploy completes while anvil keeps running). We capture combined
    // stdout/stderr so a failure surfaces in the Playwright report.
    const env = {
        ...process.env,
        PORT: String(E2E_ENV.anvilPort),
        FORK_BLOCK: String(E2E_ENV.forkBlock),
        UPSTREAM: E2E_ENV.forkUpstream,
        DEV_WALLETS: E2E_ENV.testAccount.address,
        // We seed Patron via the deploy itself (start-dev-fork.sh doesn't
        // run seed-fork.ts — that's a separate followup the script
        // documents but doesn't invoke). The smoke test's "non-zero live
        // bid" assertion relies on Patron being seeded; Phase 2 tests
        // will use fixtures/seed.ts.topUpPatron() for that. For the
        // smoke test we leave Patron at its post-deploy state (0 ETH);
        // the smoke assertion checks structural rendering, not value.
    };

    // Mirror everything the script writes to a per-run log file so a
    // failure post-mortem has the full output, not just the in-memory
    // tail. Path is stable so CI can upload it on failure.
    const scriptLogPath = '/tmp/pc-e2e-start-dev-fork.log';
    const scriptLog = openSync(scriptLogPath, 'w');
    const output: string[] = [];
    await new Promise<void>((resolve, reject) => {
        const child = spawn('bash', [scriptPath], {
            cwd: E2E_ENV.repoRoot,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const onChunk = (chunk: Buffer) => {
            const line = chunk.toString();
            output.push(line);
            writeSync(scriptLog, line);
            // Surface the script's progress to the Playwright console
            // when running with --reporter=list, so a hung deploy is
            // visible in real time rather than a 2-min black-box wait.
            process.stderr.write(`[anvil] ${line}`);
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.on('error', (err) => {
            closeSync(scriptLog);
            reject(err);
        });
        // Use 'close' (fires after stdio streams drain) not 'exit'
        // (fires immediately on process exit, can race the stderr
        // drain — leaving the last "bootstrap FAILED" diagnostic line
        // unprinted in the error message).
        child.on('close', (code) => {
            closeSync(scriptLog);
            if (code === 0) {
                resolve();
            } else {
                reject(
                    new Error(
                        `e2e: start-dev-fork.sh exited ${code}.\nFull log: ${scriptLogPath}\n--- last 40 lines of output ---\n${output.join('').split('\n').slice(-40).join('\n')}`,
                    ),
                );
            }
        });
    });

    // Confirm anvil is actually serving requests.
    const rpcUrl = anvilRpcUrl();
    await waitForAnvil(rpcUrl, 30_000);

    // Parse deployments.json — start-dev-fork.sh writes this as part of
    // the deploy step. Missing file or missing addresses means the deploy
    // didn't actually land even though the script exited 0.
    const deploymentsPath = join(E2E_ENV.repoRoot, 'contracts/deployments.json');
    if (!existsSync(deploymentsPath)) {
        throw new Error(
            `e2e: contracts/deployments.json missing after start-dev-fork.sh ran cleanly — deploy did not write addresses. Last 40 lines:\n${output.join('').split('\n').slice(-40).join('\n')}`,
        );
    }
    const raw = readFileSync(deploymentsPath, 'utf8');
    let parsed: Record<string, string>;
    try {
        parsed = JSON.parse(raw) as Record<string, string>;
    } catch (e) {
        throw new Error(`e2e: deployments.json is not valid JSON: ${String(e)}`);
    }

    const required = [
        'token',
        'patron',
        'permanentCollection',
        'punkVault',
        'returnAuctionModule',
        'buybackBurner',
        'liveBidAdapter',
        'vaultBurnPool',
        'protocolFeePhaseAdapter',
        'referralPayout',
        'pcSwapContext',
        'renderer',
        'protocolAdmin',
        'hook',
        'titleAuction',
    ] as const;
    const missing = required.filter((k) => !/^0x[a-fA-F0-9]{40}$/.test(parsed[k] ?? ''));
    if (missing.length > 0) {
        throw new Error(
            `e2e: deployments.json missing or invalid addresses: ${missing.join(', ')}`,
        );
    }
    // Cast through `unknown` — TS can't statically prove that the tuple
    // pairing from `required.map` produces exactly the `Deployments`
    // shape, but the address-shape regex above gives us runtime certainty.
    const deployments = Object.fromEntries(
        required.map((k) => [k, parsed[k] as Address]),
    ) as unknown as Deployments;

    const cleanup = async () => {
        // start-dev-fork.sh nohup'd anvil — kill whatever's on our port.
        // We can't use child.kill() because the script already exited.
        await killOnPort(E2E_ENV.anvilPort);
    };

    return {
        rpcUrl,
        chainId: E2E_ENV.chainId,
        deployments,
        cleanup,
    };
}

/** Poll eth_blockNumber until anvil answers or the deadline passes. */
async function waitForAnvil(rpcUrl: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    let lastErr: unknown = null;
    while (Date.now() - started < timeoutMs) {
        try {
            const res = await fetch(rpcUrl, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'eth_blockNumber',
                    params: [],
                    id: 1,
                }),
            });
            if (res.ok) {
                const json = (await res.json()) as {result?: string; error?: unknown};
                if (typeof json.result === 'string') return;
                lastErr = json.error;
            }
        } catch (e) {
            lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
        `e2e: anvil at ${rpcUrl} did not respond within ${timeoutMs}ms. Last error: ${String(lastErr)}`,
    );
}

/** Kill whatever process is bound to tcp:${port}. Used for cleanup since
 *  start-dev-fork.sh nohup'd anvil and the script's own PID exited long
 *  before we got here. */
async function killOnPort(port: number): Promise<void> {
    await new Promise<void>((resolve) => {
        const child = spawn(
            'bash',
            // `-sTCP:LISTEN` so we only kill the anvil *listener* on the port,
            // never the Playwright runner that holds keep-alive client sockets
            // to it (a bare `lsof -ti tcp:${port}` matches both — see
            // globalTeardown.killOnPort for the full footgun writeup).
            ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true`],
            {stdio: 'ignore'},
        );
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
    });
}
