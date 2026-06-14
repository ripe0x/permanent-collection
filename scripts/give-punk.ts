/**
 * Hand a real-mainnet CryptoPunk (carrying an uncollected trait) to the
 * recipient address on the local fork, so the recipient can test the
 * `/accept` (live-bid acceptance) flow as a Punk owner.
 *
 * What it does:
 *   1. Picks a Punk ID (deterministic search or env-specified).
 *   2. Reads its current owner from the 2017 CryptoPunks market.
 *   3. Reads the protocol's collectedMask.
 *   4. Verifies the Punk carries at least one uncollected trait
 *      (eligibility for the live bid).
 *   5. Impersonates the current owner via anvil_impersonateAccount,
 *      funds them with 1 ETH for gas, and calls transferPunk(recipient).
 *   6. Logs the punk ID and recipe for /accept.
 *
 * Usage:
 *   pnpm tsx scripts/give-punk.ts
 *   PUNK_ID=42 pnpm tsx scripts/give-punk.ts
 *   RECIPIENT=0x... pnpm tsx scripts/give-punk.ts
 *
 * Env:
 *   RPC_URL    default http://127.0.0.1:8545
 *   RECIPIENT  default anvil account 0 (0xf39Fd6...92266)
 *   PUNK_ID    if unset, picks the first eligible Punk starting from START
 *   START      scan origin for the auto-pick (default 0; ignored when PUNK_ID
 *              is set). Lets a caller spread N picks across the 10k space —
 *              each START finds the first eligible Punk at-or-after it, so the
 *              result is always eligible (unlike a fixed random PUNK_ID, which
 *              can land on an ineligible/zero-owner Punk and revert).
 */
import {createPublicClient, http, parseAbi, type Address, getAddress} from 'viem';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const RECIPIENT = (process.env.RECIPIENT ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') as Address;

const PUNKS_MARKET = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as const;
const PUNKS_DATA = '0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C' as const;

const MARKET_ABI = parseAbi([
    'function punkIndexToAddress(uint256) view returns (address)',
    'function transferPunk(address, uint256)',
]);
const DATA_ABI = parseAbi([
    'function traitMaskOf(uint16) view returns (uint256)',
]);
const PC_ABI = parseAbi([
    'function collectedMask() view returns (uint256)',
]);

const deployments = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments.json'), 'utf8'));
const patron = getAddress(deployments.patron);
const permanentCollection = getAddress(deployments.permanentCollection);

const client = createPublicClient({transport: http(RPC_URL)});

async function ownerOf(id: number): Promise<Address> {
    return (await client.readContract({
        address: PUNKS_MARKET,
        abi: MARKET_ABI,
        functionName: 'punkIndexToAddress',
        args: [BigInt(id)],
    })) as Address;
}

async function maskOf(id: number): Promise<bigint> {
    return (await client.readContract({
        address: PUNKS_DATA,
        abi: DATA_ABI,
        functionName: 'traitMaskOf',
        args: [id],
    })) as bigint;
}

async function collectedMask(): Promise<bigint> {
    return (await client.readContract({
        address: permanentCollection,
        abi: PC_ABI,
        functionName: 'collectedMask',
    })) as bigint;
}

async function findEligible(startFrom = 0, limit = 200): Promise<number> {
    const collected = await collectedMask();
    for (let i = startFrom; i < startFrom + limit && i < 10_000; i++) {
        const owner = await ownerOf(i);
        if (owner === '0x0000000000000000000000000000000000000000') continue;
        const mask = await maskOf(i);
        const newBits = mask & ~collected;
        if (newBits !== 0n) return i;
    }
    throw new Error(`No eligible Punk found in [${startFrom}, ${startFrom + limit})`);
}

async function rpc(method: string, params: unknown[]) {
    const resp = await fetch(RPC_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', method, params, id: 1}),
    });
    const j = await resp.json();
    if (j.error) throw new Error(`${method} failed: ${JSON.stringify(j.error)}`);
    return j.result;
}

async function main() {
    let punkId: number;
    if (process.env.PUNK_ID) {
        punkId = Number(process.env.PUNK_ID);
    } else {
        // Auto-pick: scan forward from START (default 0) for the first eligible
        // Punk. A wider limit so a high START near a sparse stretch still finds
        // one before the 10k ceiling.
        const start = process.env.START ? Number(process.env.START) : 0;
        punkId = await findEligible(start, 500);
    }
    console.log(`Targeting Punk #${punkId}`);

    const owner = await ownerOf(punkId);
    if (owner === '0x0000000000000000000000000000000000000000') {
        throw new Error(`Punk #${punkId} has no owner on this fork`);
    }
    const mask = await maskOf(punkId);
    const collected = await collectedMask();
    const eligible = (mask & ~collected) !== 0n;
    console.log(`  current owner:  ${owner}`);
    console.log(`  trait mask:     0x${mask.toString(16)}`);
    console.log(`  collected:      0x${collected.toString(16)}`);
    console.log(`  uncollected bits this Punk would contribute: 0x${(mask & ~collected).toString(16)}`);
    if (!eligible) {
        throw new Error(`Punk #${punkId} carries no uncollected trait — not eligible`);
    }

    if (owner.toLowerCase() === RECIPIENT.toLowerCase()) {
        console.log(`\nRecipient already owns Punk #${punkId} — nothing to transfer.`);
    } else {
        console.log(`\nImpersonating ${owner}, funding for gas, transferring to ${RECIPIENT}…`);
        await rpc('anvil_impersonateAccount', [owner]);
        await rpc('anvil_setBalance', [owner, '0xDE0B6B3A7640000']); // 1 ETH

        const txHash = (await rpc('eth_sendTransaction', [
            {
                from: owner,
                to: PUNKS_MARKET,
                data: encodeTransferPunk(RECIPIENT, punkId),
            },
        ])) as string;
        console.log(`  transferPunk tx: ${txHash}`);

        await rpc('anvil_stopImpersonatingAccount', [owner]);

        const newOwner = await ownerOf(punkId);
        if (newOwner.toLowerCase() !== RECIPIENT.toLowerCase()) {
            throw new Error(`Transfer didn't land — current owner is ${newOwner}`);
        }
        console.log(`  ✓ Punk #${punkId} now owned by ${RECIPIENT}`);
    }

    console.log(`\nNext steps to test the /accept flow:`);
    console.log(`  1. Open http://localhost:3000/accept in a wallet connected as ${RECIPIENT}.`);
    console.log(`  2. Pick Punk #${punkId} from the owned-Punks grid.`);
    console.log(`  3. Step 1 → "List to Patron @ 0" (signs offerPunkForSaleToAddress).`);
    console.log(`  4. Step 2 → "Accept the bid" (calls patron.acceptBid(${punkId})).`);
    console.log(`  5. The live bid pays out to you; the Punk enters a 72h return auction.`);
    console.log(`     Open http://localhost:3000/auction/${punkId} to watch it.`);
    console.log(`\nOr without the UI (cast):`);
    console.log(`  cast send ${PUNKS_MARKET} "offerPunkForSaleToAddress(uint256,uint256,address)" ${punkId} 0 ${patron} \\`);
    console.log(`      --rpc-url ${RPC_URL} --from ${RECIPIENT} --unlocked`);
    console.log(`  # Pick a target trait id from the Punk's mask (see PunksData.traitMaskOf).`);
    console.log(`  cast send ${patron} "acceptBid(uint16,uint8,uint256)" ${punkId} <targetTraitId> 0 \\`);
    console.log(`      --rpc-url ${RPC_URL} --from ${RECIPIENT} --unlocked`);
}

/// Encode `transferPunk(address,uint256)` calldata manually.
/// Selector 0x8b72a2ec.
function encodeTransferPunk(to: Address, id: number): `0x${string}` {
    const sel = '8b72a2ec';
    const toPadded = to.slice(2).toLowerCase().padStart(64, '0');
    const idHex = id.toString(16).padStart(64, '0');
    return `0x${sel}${toPadded}${idHex}`;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
