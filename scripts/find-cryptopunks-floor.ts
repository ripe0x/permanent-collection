/**
 * Query the live CryptoPunks market to find the cheapest publicly-listed
 * Punks at the current block. Used by Campaign scenario tests to ground
 * `FLOOR_PRICE` in real on-chain state instead of a stipulated constant.
 *
 * Prints the top-N publicly-sellable offers (lowest `minValue` with
 * `onlySellTo == 0x0`). Run:
 *
 *     MAINNET_RPC_URL=... pnpm tsx scripts/find-cryptopunks-floor.ts
 */
import {createPublicClient, formatEther, http, parseAbi} from 'viem';
import {mainnet} from 'viem/chains';

const PUNKS_MARKET = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as const;
const TOTAL_PUNKS = 10_000;
const TOP_N = 10;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const MARKET_ABI = parseAbi([
    'function punksOfferedForSale(uint256 punkIndex) view returns (bool isForSale, uint256 punkIndex_, address seller, uint256 minValue, address onlySellTo)',
]);

async function main() {
    const rpcUrl = process.env.MAINNET_RPC_URL || 'https://ethereum.publicnode.com';
    const client = createPublicClient({
        chain: mainnet,
        // Public RPCs reject huge JSON-RPC batches (503). Use smaller HTTP
        // batches with a short wait to coalesce calls without overwhelming.
        transport: http(rpcUrl, {batch: {batchSize: 50, wait: 16}}),
    });

    const blockNumber = await client.getBlockNumber();
    console.log(`Querying CryptoPunks market at block ${blockNumber}...`);

    const calls = Array.from({length: TOTAL_PUNKS}, (_, i) => ({
        address: PUNKS_MARKET,
        abi: MARKET_ABI,
        functionName: 'punksOfferedForSale' as const,
        args: [BigInt(i)] as const,
    }));

    // Process in chunks to avoid one giant multicall payload.
    const CHUNK = 500;
    const results: readonly unknown[] = [];
    for (let start = 0; start < calls.length; start += CHUNK) {
        const chunk = calls.slice(start, start + CHUNK);
        const chunkResults = await client.multicall({contracts: chunk, allowFailure: false});
        (results as unknown[]).push(...chunkResults);
        process.stdout.write(`\r  fetched ${Math.min(start + CHUNK, calls.length)} / ${calls.length}`);
    }
    process.stdout.write('\n');

    const publicOffers: Array<{id: number; minValue: bigint; seller: `0x${string}`}> = [];
    for (let i = 0; i < TOTAL_PUNKS; i++) {
        const [isForSale, , seller, minValue, onlySellTo] = results[i] as readonly [
            boolean,
            bigint,
            `0x${string}`,
            bigint,
            `0x${string}`,
        ];
        if (!isForSale) continue;
        if (onlySellTo.toLowerCase() !== ZERO_ADDR) continue;
        publicOffers.push({id: i, minValue, seller});
    }

    publicOffers.sort((a, b) => (a.minValue < b.minValue ? -1 : a.minValue > b.minValue ? 1 : 0));

    console.log(`\n${publicOffers.length} publicly-listed Punks (no \`onlySellTo\` restriction)`);
    console.log(`\nTop ${Math.min(TOP_N, publicOffers.length)} cheapest:`);
    console.log('  rank | id    | price (ETH)         | seller');
    console.log('  -----+-------+---------------------+---------------------------------------------');
    publicOffers.slice(0, TOP_N).forEach((o, i) => {
        const ethStr = formatEther(o.minValue).padEnd(19);
        console.log(`  ${String(i + 1).padStart(4)} | ${String(o.id).padStart(5)} | ${ethStr} | ${o.seller}`);
    });

    if (publicOffers.length === 0) {
        console.error('\nNo publicly-listed Punks found at this block. Scenario tests will need to fall back to vm.prank impersonation.');
        process.exit(1);
    }

    const floor = publicOffers[0];
    console.log(`\nFloor: Punk #${floor.id} at ${formatEther(floor.minValue)} ETH (block ${blockNumber})`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
