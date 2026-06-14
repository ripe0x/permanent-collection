/**
 * Daemon: re-run the SimulateTrading.s.sol forge script on an interval so
 * the local-fork live bid keeps growing while you watch the app at
 * http://localhost:3000.
 *
 * Each invocation does ~60 trades + flushes. With DELAY_SECONDS=60, this
 * gives the live bid a steady upward drift that's visible in the homepage's
 * live-bid stat card.
 *
 * Usage:
 *   pnpm tsx scripts/simulate-trading-loop.ts
 *
 * Env:
 *   RPC_URL          default http://127.0.0.1:8545
 *   DELAY_SECONDS    default 60
 *   ITERATIONS       default 999 (effectively infinite; Ctrl-C to stop)
 *   PRIVATE_KEY      default anvil account 0
 */
import {spawn} from 'node:child_process';
import {createPublicClient, http, formatEther, parseAbi} from 'viem';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const DELAY_SECONDS = Number(process.env.DELAY_SECONDS ?? '60');
const ITERATIONS = Number(process.env.ITERATIONS ?? '999');
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const deployments = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments.json'), 'utf8'));

const client = createPublicClient({transport: http(RPC_URL)});

const PATRON_ABI = parseAbi(['function bidBalance() view returns (uint256)']);

async function liveBidBalance(): Promise<bigint> {
    // The live bid is `accountedLiveBidWei` (what `bidBalance()` returns), not
    // Patron's raw balance — forced/unaccounted ETH is excluded from the bid.
    return (await client.readContract({
        address: deployments.patron,
        abi: PATRON_ABI,
        functionName: 'bidBalance',
    })) as bigint;
}

function runForge(): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'forge',
            [
                'script',
                'script/SimulateTrading.s.sol:SimulateTrading',
                '--rpc-url', RPC_URL,
                '--broadcast', '--slow', '--skip-simulation',
                '--private-key', PRIVATE_KEY,
            ],
            {
                cwd: join(ROOT, 'contracts'),
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    N_TRADES: process.env.N_TRADES ?? '40',
                    // One flush at the end of each batch. Intermediate flushes
                    // can hit LiveBidAdapter.minBlocksBetweenFlushes (300 blocks
                    // by default) and revert the whole forge script.
                    FLUSH_EVERY: process.env.FLUSH_EVERY ?? '1000',
                },
            },
        );
        let lastLog = Date.now();
        const stamp = () => `[${new Date().toISOString().slice(11, 19)}]`;
        child.stdout.on('data', (b: Buffer) => {
            const s = b.toString();
            // Print only key lines so the daemon output stays readable.
            for (const line of s.split('\n')) {
                if (/trade \d+ (BUY|SELL)/.test(line) || /flush after/.test(line) || /Simulation complete/.test(line)) {
                    // Trim foundry's leading indent.
                    if (Date.now() - lastLog > 200) {
                        process.stdout.write(`${stamp()} ${line.trim()}\n`);
                        lastLog = Date.now();
                    }
                }
            }
        });
        child.stderr.on('data', (b: Buffer) => {
            process.stderr.write(b);
        });
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`forge script exited ${code}`));
        });
    });
}

async function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    console.log(`PERMANENT COLLECTION — trading simulator daemon`);
    console.log(`  RPC:      ${RPC_URL}`);
    console.log(`  delay:    ${DELAY_SECONDS}s between batches`);
    console.log(`  live bid (Patron): ${deployments.patron}`);
    console.log(`  iterations: ${ITERATIONS}`);
    console.log();

    for (let i = 1; i <= ITERATIONS; i++) {
        const before = await liveBidBalance();
        console.log(`\n— Batch ${i} starting (live bid: ${formatEther(before)} ETH) —`);
        const t0 = Date.now();
        try {
            await runForge();
        } catch (e) {
            console.error(`Batch ${i} failed:`, e);
            await sleep(DELAY_SECONDS * 1000);
            continue;
        }
        const after = await liveBidBalance();
        const delta = after - before;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
            `— Batch ${i} done in ${elapsed}s. live bid=${formatEther(after)} ETH (Δ +${formatEther(delta)}). Sleeping ${DELAY_SECONDS}s.`,
        );
        if (i < ITERATIONS) await sleep(DELAY_SECONDS * 1000);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
