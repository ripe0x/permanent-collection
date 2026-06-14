/**
 * Local-fork seed for V4 testing.
 *
 * Sets up two scenarios in parallel so a local frontend / cast session can
 * exercise both V4 entry points (function names follow the deployed ABI):
 *
 *   1. acceptBid path (live-bid acceptance): takes a real Punk from its
 *      mainnet owner, transfers to a test wallet, lists exclusively to Patron
 *      at price 0. From there, anyone can call `patron.acceptBid(punkId)`.
 *
 *   2. acceptListing path: takes another real Punk from its mainnet owner,
 *      transfers to a *simulated PunkStrategy* address (anvil-impersonated),
 *      publicly lists at 1.2× a notional cost. The deployer must allowlist
 *      this address via `patron.addAllowedSeller(seller)` for the path
 *      to fire. (If you want to test with the real PNKSTR contract, allowlist
 *      0xc50673…eDF directly; that's already done by Deploy.s.sol.)
 *
 * Also tops up Patron with 30 ETH so the live bid has a non-zero balance.
 *
 * Requires anvil running with --fork-url. RPC defaults to http://127.0.0.1:8545.
 */
import {createPublicClient, createWalletClient, http, parseAbi, parseEther} from 'viem';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const DEPLOYMENTS_PATH = join(ROOT, 'contracts', 'deployments.json');

const PUNKS_MARKET = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as const;
// Test seller standing in for PunkStrategy on the local fork. Allowlist this
// address via `patron.addAllowedSeller(...)` if you want to exercise
// `acceptListing` end-to-end.
const TEST_PUNK_STRATEGY = '0x000000000000000000000000000000000000F1F1' as const;

const MARKET_ABI = parseAbi([
    'function punkIndexToAddress(uint256) view returns (address)',
    'function transferPunk(address, uint256)',
    'function offerPunkForSale(uint256, uint256)',
    'function offerPunkForSaleToAddress(uint256, uint256, address)',
]);

const PATRON_ABI = parseAbi(['function liveBidAdapter() view returns (address)']);

interface Deployments {
    patron: `0x${string}`;
    punkVault: `0x${string}`;
}

async function impersonate(pub: ReturnType<typeof createPublicClient>, addr: string) {
    await pub.request({method: 'anvil_impersonateAccount' as any, params: [addr]});
    await pub.request({method: 'anvil_setBalance' as any, params: [addr, '0xDE0B6B3A7640000']}); // 1 ETH gas
}

async function main() {
    const deployments: Deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
    const pub = createPublicClient({transport: http(RPC_URL)});

    // Top up the live bid through the adapter — the only faucet
    // `Patron.receive()` accepts — so `accountedLiveBidWei` is credited. A raw
    // `anvil_setBalance` on Patron is forced ETH, which the accounting excludes
    // from the live bid (acceptBid would then revert PayoutBelowMin).
    const adapter = (await pub.readContract({
        address: deployments.patron,
        abi: PATRON_ABI,
        functionName: 'liveBidAdapter',
    })) as `0x${string}`;
    const adapterBalBefore = await pub.getBalance({address: adapter});
    await impersonate(pub, adapter); // sets adapter to 1 ETH + impersonates
    await pub.request({
        method: 'anvil_setBalance' as any,
        params: [adapter, `0x${(31n * 10n ** 18n).toString(16)}`], // 31 ETH (30 to forward + 1 gas)
    });
    {
        const wallet = createWalletClient({account: adapter, transport: http(RPC_URL)});
        const hash = await wallet.sendTransaction({
            chain: null,
            to: deployments.patron,
            value: 30n * 10n ** 18n, // 30 ETH
        });
        await pub.waitForTransactionReceipt({hash});
    }
    await pub.request({method: 'anvil_stopImpersonatingAccount' as any, params: [adapter]});
    // Restore the adapter's balance so funding leaves no spurious pending buffer
    // (a leftover buffer would trip streamForward on the next swap).
    await pub.request({
        method: 'anvil_setBalance' as any,
        params: [adapter, `0x${adapterBalBefore.toString(16)}`],
    });
    console.log(`topped up live bid via adapter ${adapter} with 30 ETH`);

    // The vault is the terminal custodian for vaulted Punks. anvil_impersonateAccount
    // bypasses the on-chain fact that PunkVault has no `transferPunk` codepath
    // (one of the protocol's hard invariants: no Punk can leave the vault).
    // If this script runs after any vault has been populated and we don't
    // skip vault-owned Punks here, we'd impersonate the vault and pull
    // Punks back out into the test PunkStrategy — leaving the protocol's
    // `collectedMask` set for a trait whose carrying Punk is no longer
    // physically in the vault. That breaks invariant #7 for the test
    // fixture (the protocol code itself is unaffected).
    const vaultAddr = (deployments.punkVault ?? '0x0000000000000000000000000000000000000000').toLowerCase();

    // Scenario 1: acceptBid path — list Punks 0..4 to Patron @ 0.
    const bountyPunks = [0, 1, 2, 3, 4];
    for (const id of bountyPunks) {
        const owner = (await pub.readContract({
            address: PUNKS_MARKET,
            abi: MARKET_ABI,
            functionName: 'punkIndexToAddress',
            args: [BigInt(id)],
        })) as `0x${string}`;

        if (owner === '0x0000000000000000000000000000000000000000') {
            console.log(`skip #${id} (unowned)`);
            continue;
        }
        if (owner.toLowerCase() === vaultAddr) {
            console.log(`skip #${id} (vaulted — would break protocol invariant #7 if pulled out)`);
            continue;
        }

        await impersonate(pub, owner);
        const wallet = createWalletClient({account: owner, transport: http(RPC_URL)});

        const hash = await wallet.writeContract({
            chain: null,
            address: PUNKS_MARKET,
            abi: MARKET_ABI,
            functionName: 'offerPunkForSaleToAddress',
            args: [BigInt(id), 0n, deployments.patron],
        });
        await pub.waitForTransactionReceipt({hash});
        console.log(`#${id} listed to Patron @ 0 (acceptBid ready)`);
    }

    // Scenario 2: acceptListing path — transfer Punks 100..102 to a fake
    // PunkStrategy address, then publicly list at 5 / 7.5 / 10 ETH.
    const listingPunks = [
        {id: 100, priceEth: '5'},
        {id: 101, priceEth: '7.5'},
        {id: 102, priceEth: '10'},
    ];
    await impersonate(pub, TEST_PUNK_STRATEGY);
    for (const {id, priceEth} of listingPunks) {
        const owner = (await pub.readContract({
            address: PUNKS_MARKET,
            abi: MARKET_ABI,
            functionName: 'punkIndexToAddress',
            args: [BigInt(id)],
        })) as `0x${string}`;

        if (owner === '0x0000000000000000000000000000000000000000') {
            console.log(`skip #${id} (unowned)`);
            continue;
        }
        if (owner.toLowerCase() === vaultAddr) {
            console.log(`skip #${id} (vaulted — would break protocol invariant #7 if pulled out)`);
            continue;
        }

        await impersonate(pub, owner);
        const transferWallet = createWalletClient({account: owner, transport: http(RPC_URL)});
        const transferHash = await transferWallet.writeContract({
            chain: null,
            address: PUNKS_MARKET,
            abi: MARKET_ABI,
            functionName: 'transferPunk',
            args: [TEST_PUNK_STRATEGY, BigInt(id)],
        });
        await pub.waitForTransactionReceipt({hash: transferHash});

        const sellerWallet = createWalletClient({account: TEST_PUNK_STRATEGY, transport: http(RPC_URL)});
        const listHash = await sellerWallet.writeContract({
            chain: null,
            address: PUNKS_MARKET,
            abi: MARKET_ABI,
            functionName: 'offerPunkForSale',
            args: [BigInt(id), parseEther(priceEth)],
        });
        await pub.waitForTransactionReceipt({hash: listHash});
        console.log(`#${id} listed publicly by ${TEST_PUNK_STRATEGY} @ ${priceEth} ETH`);
    }

    console.log(`\nTo exercise acceptListing: allowlist the test seller first:`);
    console.log(`  cast send ${deployments.patron} "addAllowedSeller(address)" ${TEST_PUNK_STRATEGY} \\`);
    console.log(`    --rpc-url ${RPC_URL} --private-key <admin_pk>`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
