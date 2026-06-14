import {onchainTable} from 'ponder';

// Ponder 0.16 schema. Each table is a named `onchainTable` export; the export
// name is what Ponder's GraphQL middleware uses for the query fields (singular
// by primary key + pluralized connection), so the names here are the camelCase
// of the pre-0.16 table keys to keep the app's existing GraphQL queries
// (`returnAuctions`, `bidEvents`, `protocolCounter(id:)`) working unchanged.
// Column names are preserved verbatim for the same reason.

// ──────────────── Patron (live-bid entry-point + ETH pool) ────────────────

export const bidEvent = onchainTable('bid_event', (t) => ({
    // <txHash>-<logIndex>
    id: t.text().primaryKey(),
    kind: t.text().notNull(), // "Accepted" | "ListingAccepted" | "BareTopUp" | "Contribution" | "PoolReplenished"
    punkId: t.integer(),
    seller: t.hex(),
    caller: t.hex(),
    amount: t.bigint().notNull(),
    finderFee: t.bigint(),
    // Set on "Contribution" rows (LiveBidAdapter.contribute): the attributed
    // referrer, the caller-supplied tag, and the ≤5% slice forwarded to the
    // referrer. The bid-growing remainder is `amount - referrerShare`.
    referrer: t.hex(),
    tag: t.hex(),
    referrerShare: t.bigint(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

export const allowlistEntry = onchainTable('allowlist_entry', (t) => ({
    id: t.hex().primaryKey(), // seller address
    seller: t.hex().notNull(),
    active: t.boolean().notNull(),
    addedAt: t.bigint().notNull(),
    removedAt: t.bigint(),
}));

export const parameterChange = onchainTable('parameter_change', (t) => ({
    id: t.text().primaryKey(), // <txHash>-<logIndex>
    contract: t.text().notNull(), // "LiveBidAdapter" | "BuybackBurner"
    key: t.text().notNull(),
    oldValue: t.bigint().notNull(),
    newValue: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// ──────────────── Fee plumbing (adapter sweeps) ────────────────

export const adapterSweep = onchainTable('adapter_sweep', (t) => ({
    id: t.text().primaryKey(),
    adapter: t.text().notNull(), // "LiveBidAdapter"
    ethSwept: t.bigint().notNull(),
    ethForwarded: t.bigint().notNull(),
    ethBuffered: t.bigint(),
    keeper: t.hex(),
    keeperReward: t.bigint(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// ──────────────── VaultBurnPool sweeps ────────────────

export const vaultBurnSweep = onchainTable('vault_burn_sweep', (t) => ({
    id: t.text().primaryKey(), // <txHash>-<logIndex>
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// ──────────────── PermanentCollection (per-Punk acquisition record) ────

// Per-Punk acquisition record. Keyed by `punkId` and latest-wins — mirrors the
// on-chain per-Punk readers (`getAcquisitionFor`, `originalSellerOf`,
// `custodyOf`, `_acquisitionIndexOf`), which always return the most recent
// acquisition. A rescued (ReturnedToMarket) Punk can be re-acquired, which
// overwrites this row with the new acquisition and bumps `acquisitionCount`.
// The full append-only history (one row per acquisition, never overwritten)
// lives in `acquisitionHistory`. See docs/RE_AUCTION_REDESIGN.md.
export const acquisition = onchainTable('acquisition', (t) => ({
    id: t.integer().primaryKey(), // punkId
    punkId: t.integer().notNull(),
    targetTraitId: t.integer().notNull(),
    mask: t.bigint().notNull(),
    pendingMaskAtAcquisition: t.bigint().notNull(),
    // The address credited for the acquisition. For `acceptBid` this is the
    // previous Punk owner; for `acceptListing` this is the caller (who also
    // receives the finder fee).
    acquirer: t.hex().notNull(),
    // The address that gave up the Punk to the protocol (the recipient of any
    // future Proof NFT at vault-settle). For `acceptBid` this equals
    // `acquirer`; for `acceptListing` this is the public-listing seller
    // (distinct from the caller / finder).
    originalSeller: t.hex().notNull(),
    priceWei: t.bigint().notNull(),
    acquiredAtBlock: t.bigint().notNull(),
    // Custody lifecycle: "InReturnAuction" → "ReturnedToMarket" | "Vaulted";
    // a ReturnedToMarket Punk can re-enter "InReturnAuction" on re-acquisition.
    // "Vaulted" is terminal.
    custody: t.text().notNull(),
    custodyUpdatedAt: t.bigint(),
    // How many times this Punk has been acquired (1 on first acquisition,
    // incremented on each re-acquisition of a rescued Punk).
    acquisitionCount: t.integer().notNull(),
    // 0-based index of the latest acquisition in the append-only
    // `acquisitionHistory` (= acquisitionCount - 1).
    latestHistoryIndex: t.integer().notNull(),
    // `acquisitionHistory.id` of the latest acquisition, so the CustodyUpdated
    // handler can patch the matching history row's terminal custody.
    latestHistoryId: t.text().notNull(),
}));

// Append-only log of EVERY acquisition (never overwritten). One row per
// `AcquisitionRecorded` event. `seq` is the 0-based per-Punk acquisition index.
export const acquisitionHistory = onchainTable('acquisition_history', (t) => ({
    id: t.text().primaryKey(), // <txHash>-<logIndex>
    punkId: t.integer().notNull(),
    seq: t.integer().notNull(), // 0-based per-Punk acquisition index
    targetTraitId: t.integer().notNull(),
    mask: t.bigint().notNull(),
    pendingMaskAtAcquisition: t.bigint().notNull(),
    acquirer: t.hex().notNull(),
    originalSeller: t.hex().notNull(),
    priceWei: t.bigint().notNull(),
    acquiredAtBlock: t.bigint().notNull(),
    // Terminal custody of THIS acquisition's auction once settled
    // ("ReturnedToMarket" | "Vaulted"); "InReturnAuction" until then.
    custody: t.text().notNull(),
    custodyUpdatedAt: t.bigint(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// Per-trait counter of how many acquisitions have ever targeted this trait.
// Drives the reserve formula. Bumped on every recordAcquisition; never
// decremented.
export const traitTrial = onchainTable('trait_trial', (t) => ({
    id: t.integer().primaryKey(), // traitId (0..110)
    traitId: t.integer().notNull(),
    count: t.integer().notNull(),
    lastPunkId: t.integer(),
    lastUpdatedAt: t.bigint().notNull(),
}));

export const traitTransition = onchainTable('trait_transition', (t) => ({
    id: t.text().primaryKey(), // <txHash>-<logIndex>
    kind: t.text().notNull(), // "Pending" | "Collected"
    punkId: t.integer().notNull(),
    // For "Collected" events this is the single target trait bit
    // (1 << targetTraitId); preserved as bigint for historical reads.
    bits: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// ──────────────── Return auction ────────────────

export const returnAuction = onchainTable('return_auction', (t) => ({
    id: t.integer().primaryKey(), // punkId
    punkId: t.integer().notNull(),
    targetTraitId: t.integer().notNull(),
    acquisitionCost: t.bigint().notNull(),
    reserveWei: t.bigint().notNull(),
    startedAt: t.bigint().notNull(),
    endsAt: t.bigint().notNull(),
    highBidWei: t.bigint().notNull(),
    highBidder: t.hex(),
    extensions: t.integer().notNull(), // count of anti-snipe extensions fired
    settled: t.boolean().notNull(),
    outcome: t.text(), // "Cleared" | "Vaulted"
    bountyShareWei: t.bigint(),
    burnShareWei: t.bigint(),
    settleKeeperReward: t.bigint(),
}));

export const bid = onchainTable('bid', (t) => ({
    id: t.text().primaryKey(), // <txHash>-<logIndex>
    punkId: t.integer().notNull(),
    bidder: t.hex().notNull(),
    amount: t.bigint().notNull(),
    endsAt: t.bigint().notNull(),
    // True if this bid triggered an anti-snipe extension.
    extended: t.boolean().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

export const refund = onchainTable('refund', (t) => ({
    id: t.text().primaryKey(),
    kind: t.text().notNull(), // "Queued" | "Withdrawn"
    bidder: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// ──────────────── PunkVault (terminal sink) ────────────────

export const vaultedPunk = onchainTable('vaulted_punk', (t) => ({
    id: t.integer().primaryKey(), // punkId
    punkId: t.integer().notNull(),
    collectedTraitId: t.integer().notNull(), // the single trait this vault collected
    vaultedAtBlock: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// ──────────────── PunkVault: Proof NFTs (token ids 0..110, tokenId == traitId) ────────────────
// One row per first-vaulting of a previously-uncollected trait. Capped at 111
// forever. Append-only — the contribution event is immutable even as the Proof
// is transferred. The current holder is patched by the Transfer handler.
export const proof = onchainTable('proof', (t) => ({
    id: t.integer().primaryKey(), // tokenId (0..110) — equal to traitId
    tokenId: t.integer().notNull(),
    traitId: t.integer().notNull(), // = tokenId (1:1 with PunksData taxonomy)
    punkId: t.integer().notNull(), // Punk whose vaulting produced this Proof
    recipient: t.hex().notNull(), // originalSeller at mint time
    currentOwner: t.hex().notNull(), // patched by Transfer handler
    acquisitionId: t.bigint().notNull(), // 0-based index into Acquisition[]
    sequence: t.integer().notNull(), // 1-based collection order at mint time (1..111)
    mintedAtBlock: t.bigint().notNull(),
    mintedAt: t.bigint().notNull(), // timestamp
    mintedTxHash: t.hex().notNull(),
    lastTransferAtBlock: t.bigint(),
    lastTransferAt: t.bigint(),
}));

// Append-only ERC721 transfer log for PunkVault tokens (Title + Proofs).
export const punkVaultTransfer = onchainTable('punk_vault_transfer', (t) => ({
    id: t.text().primaryKey(), // <txHash>-<logIndex>
    tokenId: t.integer().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// ──────────────── BuybackBurner (111PUNKS burns) ────────────────

export const burnerDeposit = onchainTable('burner_deposit', (t) => ({
    id: t.text().primaryKey(),
    source: t.hex().notNull(), // ReturnAuctionModule (cleared) or VaultBurnPool (vault)
    amount: t.bigint().notNull(),
    remainingEth: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

export const burnStep = onchainTable('burn_step', (t) => ({
    id: t.text().primaryKey(), // <txHash>-<logIndex> of TokensBurned
    ethSpent: t.bigint().notNull(),
    tokensBurned: t.bigint().notNull(),
    remainingEth: t.bigint().notNull(),
    executionReward: t.bigint().notNull(),
    caller: t.hex(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// ──────────────── PunkVaultTitleAuction (Title NFT, one-shot english auction) ────────────────
// Singleton row (id = "global") tracking the auction's lifecycle.
export const titleAuctionState = onchainTable('title_auction_state', (t) => ({
    id: t.text().primaryKey(), // "global"
    kickedOff: t.boolean().notNull(),
    settled: t.boolean().notNull(),
    endsAt: t.bigint().notNull(),
    highBidWei: t.bigint().notNull(),
    highBidder: t.hex(),
    clearedAt: t.bigint(),
    winner: t.hex(),
    finalHighBidWei: t.bigint(),
    // Count of no-bidder restarts the auction has gone through.
    restartCount: t.integer().notNull(),
    // Total anti-snipe extensions the current round has accumulated; reset on
    // each Kickoff event (initial OR no-bidder restart).
    extensionsThisRound: t.integer().notNull(),
    lastUpdatedAt: t.bigint().notNull(),
}));

// Append-only bid log. One row per `Bid` event.
export const titleAuctionBid = onchainTable('title_auction_bid', (t) => ({
    id: t.text().primaryKey(), // <txHash>-<logIndex>
    bidder: t.hex().notNull(),
    amount: t.bigint().notNull(),
    endsAt: t.bigint().notNull(),
    extended: t.boolean().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// Pull-pattern refund queue events.
export const titleAuctionRefund = onchainTable('title_auction_refund', (t) => ({
    id: t.text().primaryKey(),
    kind: t.text().notNull(), // "Queued" | "Withdrawn"
    bidder: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// Pull-pattern proceeds queue events.
export const titleAuctionProceeds = onchainTable('title_auction_proceeds', (t) => ({
    id: t.text().primaryKey(),
    kind: t.text().notNull(), // "Queued" | "Withdrawn"
    recipient: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// ──────────────── ReferralPayout (per-referrer ledger) ────────────────
// Per-referrer aggregate. `balance` is the running claimable ETH — credited
// inflows from attributed swaps minus user-initiated claims. Mirrors
// `ReferralPayout.balances(referrer)` on chain.
export const referrer = onchainTable('referrer', (t) => ({
    id: t.hex().primaryKey(), // referrer address
    referrer: t.hex().notNull(),
    balance: t.bigint().notNull(), // = totalCredited - totalClaimed
    totalCredited: t.bigint().notNull(),
    totalClaimed: t.bigint().notNull(),
    lastCreditedAt: t.bigint(),
    lastClaimedAt: t.bigint(),
    lastUpdatedAt: t.bigint().notNull(),
}));

// Append-only log of `ReferralCredited(referrer, amount)`.
export const referralCredit = onchainTable('referral_credit', (t) => ({
    id: t.text().primaryKey(), // <txHash>-<logIndex>
    referrer: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// Append-only log of `ReferralClaimed(referrer, amount)`.
export const referralClaim = onchainTable('referral_claim', (t) => ({
    id: t.text().primaryKey(), // <txHash>-<logIndex>
    referrer: t.hex().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
}));

// ──────────────── Singleton: protocol-wide counters ────────────────
// One row, id = "global". Cheaper than aggregating across event tables for the
// frontend's headline numbers.
export const protocolCounter = onchainTable('protocol_counter', (t) => ({
    id: t.text().primaryKey(), // "global"
    collectedCount: t.integer().notNull(),
    acquisitionCount: t.integer().notNull(),
    vaultedCount: t.integer().notNull(),
    clearedCount: t.integer().notNull(),
    proofsMinted: t.integer().notNull(),
    totalEthBurned: t.bigint().notNull(),
    totalTokensBurned: t.bigint().notNull(),
    totalBountyInflowsWei: t.bigint().notNull(),
    totalVaultBurnSweptWei: t.bigint().notNull(),
    // Gross ETH routed through contribute(), referrer share INCLUDED. The
    // volume metric for the contribute() integration surface, before referrer
    // payouts. Differs from totalBountyInflowsWei (net `amount - referrerShare`
    // that actually grew the live bid).
    totalContributionVolumeWei: t.bigint().notNull(),
    // Lifetime official-pool swap volume (the ETH side of every swap, buys and
    // sells) and swap count, from the skim hook's per-swap `SkimSplit` events
    // filtered to the canonical pool. Exact — unlike dividing bid inflows by
    // the 5% leg share, which the anti-sniper window's elevated skim distorts.
    totalSwapVolumeWei: t.bigint().notNull(),
    swapCount: t.integer().notNull(),
    lastUpdatedAt: t.bigint().notNull(),
}));
