import {createConfig, rateLimit} from 'ponder';
import {fallback, http, type Transport} from 'viem';

import {abi as PatronAbi} from './abis/Patron';
import {abi as ArtCoinsHookSkimFeeAbi} from './abis/ArtCoinsHookSkimFee';
import {abi as LiveBidAdapterAbi} from './abis/LiveBidAdapter';
import {abi as VaultBurnPoolAbi} from './abis/VaultBurnPool';
import {abi as PermanentCollectionAbi} from './abis/PermanentCollection';
import {abi as ReturnAuctionModuleAbi} from './abis/ReturnAuctionModule';
import {abi as PunkVaultAbi} from './abis/PunkVault';
import {abi as PunkVaultTitleAuctionAbi} from './abis/PunkVaultTitleAuction';
import {abi as BuybackBurnerAbi} from './abis/BuybackBurner';
import {abi as ReferralPayoutAbi} from './abis/ReferralPayout';
import {abi as HomageAbi} from './abis/Homage';

// Network is selectable so the same indexer code runs against the local anvil
// fork (chainId 31337, used by the Playwright e2e harness) and the mainnet
// deploy. Configure via:
//   PONDER_NETWORK=anvil    PONDER_RPC_URL_31337=http://127.0.0.1:8545
//   PONDER_NETWORK=mainnet  (defaults to the free public chain below)
const network = (process.env.PONDER_NETWORK ?? 'mainnet') as 'mainnet' | 'anvil';
const startBlock = Number(process.env.START_BLOCK ?? 0);

const env = (k: string): `0x${string}` => {
    const v = process.env[k];
    if (!v) throw new Error(`indexer: missing env ${k}`);
    return v as `0x${string}`;
};

// The skim hook (per-swap volume source via SkimSplit) is optional so a deploy
// that predates the env keeps running: unset → the zero address, which matches
// no logs, and the swap-volume counters simply stay 0. The frontend hides a
// zero/absent volume figure, so a missing env degrades to "not shown", never
// to a wrong number. Set SKIM_HOOK_ADDRESS (+ CANONICAL_POOL_ID, see
// src/index.ts) to activate.
const skimHookAddress = (process.env.SKIM_HOOK_ADDRESS ??
    '0x0000000000000000000000000000000000000000') as `0x${string}`;

// Homage to the Punk (satellite ERC721, tokenId == punkId) is optional for
// the same reason as the skim hook: it deploys AFTER the protocol, so an
// indexer deploy that predates the env keeps running. Unset → the zero
// address matches no logs and the homage tables stay empty; the app's
// /api/homage/owned route detects the absent homageStats row and 503s, and
// the frontend falls back to its own chunked log scan. Set HOMAGE_ADDRESS +
// HOMAGE_START_BLOCK (the Homage deploy block — much later than START_BLOCK,
// so the backfill skips pre-deploy ranges) to activate.
const homageAddress = (process.env.HOMAGE_ADDRESS ??
    '0x0000000000000000000000000000000000000000') as `0x${string}`;
const homageStartBlock = Number(process.env.HOMAGE_START_BLOCK ?? startBlock);

// How often Ponder polls for a new block over HTTP. The default (~1s) is ~86K
// calls/day of poll overhead alone. For a low-traffic art protocol where
// headline numbers update on the order of minutes, 5 minutes is plenty fresh
// and keeps poll volume inside free-tier RPC limits. Tune via
// PONDER_POLL_INTERVAL_MS. A `wss://` primary makes this moot (subscribe).
const POLL_INTERVAL_MS = Number(process.env.PONDER_POLL_INTERVAL_MS ?? 5 * 60_000);

// eth_getLogs block range per call. drpc free tier handles 10K comfortably;
// 5000 leaves headroom for retry. Lower to 10 if PONDER_RPC_URL_1 points at
// Alchemy free tier (10-block cap).
const ETH_GETLOGS_BLOCK_RANGE = Number(process.env.PONDER_ETH_GETLOGS_BLOCK_RANGE ?? 5_000);

// Free public mainnet RPCs for the fallback chain. Tenderly leads per the
// standing RPC strategy (~/.claude/CLAUDE.md): archive-capable, survives the
// historical-sync request burst, no key. drpc is the documented-good backstop
// for the multi-address eth_getLogs shape this indexer issues. Paid Alchemy is
// a last-resort backstop, only appended when ALCHEMY_API_KEY is set — so on a
// healthy steady state it burns zero CU. Override the primary by setting
// PONDER_RPC_URL_1 to lead with your own paid plan.
const TENDERLY_URL = 'https://gateway.tenderly.co/public/mainnet';
const DRPC_URL = 'https://eth.drpc.org';

function buildMainnetTransport(): Transport {
    const requestsPerSecond = Number(process.env.PONDER_PRIMARY_RPS ?? 25);
    const opts = {timeout: 8_000} as const;

    const primaryUrl = process.env.PONDER_RPC_URL_1?.trim() || TENDERLY_URL;
    const urls: string[] = [primaryUrl];
    if (!urls.includes(DRPC_URL)) urls.push(DRPC_URL);

    const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
    if (alchemyKey && !alchemyKey.startsWith('set-')) {
        const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`;
        if (!urls.includes(alchemyUrl)) urls.push(alchemyUrl);
    }

    const transports = urls.map((url) => rateLimit(http(url, opts), {requestsPerSecond}));
    if (transports.length === 1) return transports[0]!;
    // viem `fallback` is primary-first, not round-robin. retryCount:1 gives each
    // transport one retry before failing over; retryDelay:200 keeps backfill
    // from stalling on a slow upstream.
    return fallback(transports, {retryCount: 1, retryDelay: 200});
}

const chainConfig =
    network === 'anvil'
        ? {
              id: 31_337,
              // A cold anvil fork proxies every uncached block/log read to its
              // upstream archive RPC, which can take many seconds during the
              // first sync. viem's default HTTP timeout (~10s) trips and
              // ponder's realtime sync stalls, so give the fork transport 30s.
              rpc: http(process.env.PONDER_RPC_URL_31337 ?? 'http://127.0.0.1:8545', {timeout: 30_000}),
              pollingInterval: Number(process.env.PONDER_POLL_INTERVAL_MS ?? 1_000),
          }
        : {
              id: 1,
              rpc: buildMainnetTransport(),
              pollingInterval: POLL_INTERVAL_MS,
              ethGetLogsBlockRange: ETH_GETLOGS_BLOCK_RANGE,
          };

export default createConfig({
    chains: {
        [network]: chainConfig,
    },
    contracts: {
        Patron: {
            chain: network,
            abi: PatronAbi,
            address: env('PATRON_ADDRESS'),
            startBlock,
        },
        LiveBidAdapter: {
            chain: network,
            abi: LiveBidAdapterAbi,
            address: env('LIVE_BID_ADAPTER_ADDRESS'),
            startBlock,
        },
        VaultBurnPool: {
            chain: network,
            abi: VaultBurnPoolAbi,
            address: env('VAULT_BURN_POOL_ADDRESS'),
            startBlock,
        },
        PermanentCollection: {
            chain: network,
            abi: PermanentCollectionAbi,
            address: env('PERMANENT_COLLECTION_ADDRESS'),
            startBlock,
        },
        ReturnAuctionModule: {
            chain: network,
            abi: ReturnAuctionModuleAbi,
            address: env('RETURN_AUCTION_MODULE_ADDRESS'),
            startBlock,
        },
        PunkVault: {
            chain: network,
            abi: PunkVaultAbi,
            address: env('PUNK_VAULT_ADDRESS'),
            startBlock,
        },
        PunkVaultTitleAuction: {
            chain: network,
            abi: PunkVaultTitleAuctionAbi,
            address: env('TITLE_AUCTION_ADDRESS'),
            startBlock,
        },
        BuybackBurner: {
            chain: network,
            abi: BuybackBurnerAbi,
            address: env('BUYBACK_BURNER_ADDRESS'),
            startBlock,
        },
        ReferralPayout: {
            chain: network,
            abi: ReferralPayoutAbi,
            address: env('REFERRAL_PAYOUT_ADDRESS'),
            startBlock,
        },
        SkimHook: {
            chain: network,
            abi: ArtCoinsHookSkimFeeAbi,
            address: skimHookAddress,
            startBlock,
        },
        Homage: {
            chain: network,
            abi: HomageAbi,
            address: homageAddress,
            startBlock: homageStartBlock,
        },
    },
});
