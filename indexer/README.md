# PERMANENT COLLECTION indexer

Ponder **0.16** indexer for the V4 protocol. Backs the frontend with a queryable
GraphQL surface so the app doesn't hit RPC for every state read. Same Ponder
generation and free-RPC strategy as the sibling `artcoins-indexer` and
`tbam-ponder` Fly apps.

## Local dev

This is a pnpm-workspace member, so install from the repo root (or filtered):

```bash
# from the repo root
pnpm install --filter permanent-collection-indexer

cd indexer
cp .env.example .env.local       # fill in addresses + START_BLOCK (see the file)
pnpm dev                          # ponder dev — hot-reload + GraphQL on :42069
```

Ponder serves its HTTP API (GraphQL) at http://localhost:42069 (mounted at both
`/` and `/graphql` in `src/api/index.ts`). The app's
`app/lib/data/indexer-client.ts` POSTs to the root URL via the `INDEXER_URL`
env var.

Useful scripts: `pnpm codegen` (regenerate `ponder-env.d.ts`), `pnpm typecheck`
(`tsc --noEmit`), `pnpm start` (production mode), `pnpm serve` (API only).

### Local against the anvil e2e fork

```bash
PONDER_NETWORK=anvil PONDER_RPC_URL_31337=http://127.0.0.1:8545 pnpm dev
```

## Deploy (Fly.io)

A standalone Fly app (`pc-ponder`), single always-on shared-cpu machine running
`ponder start` with the DB on a persistent volume — no Postgres cluster. Mirrors
the artcoins-indexer topology.

```bash
cd indexer
fly launch --no-deploy
fly volumes create pc_ponder_data --region iad --size 1
fly secrets set START_BLOCK=… PATRON_ADDRESS=0x… …   # everything in .env.example
fly deploy
```

## RPC strategy

`ponder.config.ts` builds a viem `fallback` chain: Tenderly public gateway
first, drpc free tier second, optional paid Alchemy last (only when
`ALCHEMY_API_KEY` is set). On a healthy steady state it burns **zero paid CU**.
Override the primary by setting `PONDER_RPC_URL_1`. Polls every 5 min by default
(`PONDER_POLL_INTERVAL_MS`).

## What's indexed

Ten contracts on mainnet (config in `ponder.config.ts`, handlers in
`src/index.ts`, tables in `ponder.schema.ts`):

| Source | Key events | Tables (GraphQL fields) |
|---|---|---|
| `Patron` | `BidAccepted`, `ListingAccepted`, `AllowedSellerAdded`, `AllowedSellerRemoved` | `bidEvent`, `allowlistEntry` |
| `LiveBidAdapter` | `BareTopUp`, `Contribution`, `PoolReplenished`, `Swept`, `KeeperReward`, `ParameterChanged` | `bidEvent`, `adapterSweep`, `parameterChange` |
| `VaultBurnPool` | `Swept` | `vaultBurnSweep` |
| `PermanentCollection` | `AcquisitionRecorded`, `TraitsPending`, `TraitsCollected`, `CustodyUpdated` | `acquisition`, `acquisitionHistory`, `traitTrial`, `traitTransition` |
| `ReturnAuctionModule` | `ReturnAuctionStarted`, `BidPlaced`, `ReturnAuctionExtended`, `ReturnAuctionCleared`, `PunkVaulted`, `RefundQueued`, `RefundWithdrawn` | `returnAuction`, `bid`, `refund`, `vaultedPunk` |
| `PunkVault` | `ProofMinted`, `Transfer` | `proof`, `punkVaultTransfer` |
| `PunkVaultTitleAuction` | `Kickoff`, `Bid`, `Extended`, `Settled`, `SettledNoBidder`, `Refund*`, `Proceeds*` | `titleAuctionState`, `titleAuctionBid`, `titleAuctionRefund`, `titleAuctionProceeds` |
| `BuybackBurner` | `BurnEthDeposited`, `TokensBurned`, `ExecutionRewardPaid`, `ParameterChanged` | `burnerDeposit`, `burnStep`, `parameterChange` |
| `CryptoPunksMarket` (2017) | `PunkOffered`, `PunkNoLongerForSale`, `PunkBought`, `PunkTransfer` | `punkListing` |
| `ReferralPayout` | `ReferralCredited`, `ReferralClaimed` | `referrer`, `referralCredit`, `referralClaim` |

Plus a singleton `protocolCounter` (id `"global"`) holding headline aggregates
(collected/acquisition/vaulted/cleared/proofs counts, total ETH+tokens burned,
inflow totals) so the frontend reads them in one query.

GraphQL field names are the camelCase of the table exports, with Ponder's
standard connection shape — `returnAuctions(where:,orderBy:,orderDirection:){items{…}}`,
`protocolCounter(id:"global"){…}`, etc. — which is what `app/lib/data/*` already
queries.

## Read-path contract

The frontend reads **indexer-first, then RPC, then cache forever**. Anything
historical or aggregate (counts, auction history, bid feeds, referrer balances)
comes from here. Live state that needs sub-second freshness (current live-bid
balance, in-flight high bid) still comes from RPC — Ponder is at best one block
behind.

## ABIs

ABIs in `abis/` are generated from the contracts build. To refresh, run the
repo's `scripts/generate-abis.ts` after `forge build` (it writes the TS ABI
modules this config imports).
