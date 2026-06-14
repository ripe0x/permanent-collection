/**
 * Single source of truth for the Ponder indexer's contract addresses:
 * indexer env var → `contracts/deployments.json` key.
 *
 * Consumed by both:
 *   - scripts/sync-indexer-env.ts        (writes indexer/.env.local for local
 *                                          fork dev)
 *   - scripts/capture-launch-addresses.ts (emits the `fly secrets set` block for
 *                                          the production pc-ponder deploy)
 *
 * Keep in sync with indexer/ponder.config.ts + indexer/.env.example. The 2017
 * CryptoPunks market is a constant in ponder.config.ts (not env), so it is
 * intentionally absent here.
 */
export const INDEXER_ADDRESS_MAP: ReadonlyArray<readonly [string, string]> = [
    ['PATRON_ADDRESS', 'patron'],
    ['LIVE_BID_ADAPTER_ADDRESS', 'liveBidAdapter'],
    ['VAULT_BURN_POOL_ADDRESS', 'vaultBurnPool'],
    ['PERMANENT_COLLECTION_ADDRESS', 'permanentCollection'],
    ['RETURN_AUCTION_MODULE_ADDRESS', 'returnAuctionModule'],
    ['PUNK_VAULT_ADDRESS', 'punkVault'],
    ['TITLE_AUCTION_ADDRESS', 'titleAuction'],
    ['BUYBACK_BURNER_ADDRESS', 'buybackBurner'],
    ['REFERRAL_PAYOUT_ADDRESS', 'referralPayout'],
    // The skim hook feeds the official-pool swap-volume counters (SkimSplit).
    // Optional on the indexer side (unset → zero address → counters stay 0);
    // pairs with CANONICAL_POOL_ID, which both env emitters handle separately
    // because it's a bytes32, not an address.
    ['SKIM_HOOK_ADDRESS', 'hook'],
] as const;

/** deployments.json key for the canonical V4 pool id (bytes32). Gates the
 *  indexer's SkimSplit handler to the canonical pool — the hook is shared
 *  infra that could host other pools via `initializePoolOpen`. */
export const CANONICAL_POOL_ID_KEY = 'canonicalPoolId';
