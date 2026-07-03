---
title: REST endpoints
description: The site's public read endpoints under /api, their parameters, response shapes, and caching behavior.
---

# REST endpoints

The site at `permanentcollection.art` exposes a set of JSON read endpoints
under `/api`. **They exist to serve the site's own frontend and are not a
versioned API contract**: shapes can change with any deploy, there is no
deprecation policy, and rate limits protect the site, not integrators. The
canonical interfaces for building on the protocol are on-chain reads (see
the per-contract references) and [the indexer](/docs/offchain/indexer).
That said, the endpoints are plain unauthenticated GETs and are documented
here so you know what exists.

Conventions: all amounts are decimal wei strings (bigints don't survive
JSON). Several endpoints hold a short server-side shared cache so N
concurrent viewers collapse to about one upstream read per window; the
responses themselves are sent `cache-control: no-store`. A few routes also
accept a POST that the site's own client fires after a confirmed
transaction to invalidate that cache; it isn't useful to external callers.

## Live bid and stats

### GET /api/live-bid

No parameters. The current live bid plus the ETH already collected upstream
of Patron that will enter the bid on the next sweep.

```json
{
  "liveBidWei": "…",
  "pendingWei": "…",
  "protocolLegPendingWei": "0"
}
```

`liveBidWei` is `Patron.bidBalance()`; `pendingWei` is LiveBidAdapter's ETH
balance (its buffer). `protocolLegPendingWei` is always `"0"` (the protocol
leg never funds the bid; the field is kept for older clients). Server cache
window 12 seconds; 503 with `{"error": …}` on an upstream failure.

### GET /api/stats

No parameters. The indexer's `protocolCounter` singleton wrapped in a
health envelope:

```json
{
  "ok": true,
  "reachable": true,
  "hasContributionVolume": true,
  "counter": {
    "collectedCount": 0,
    "acquisitionCount": 0,
    "vaultedCount": 0,
    "clearedCount": 0,
    "proofsMinted": 0,
    "totalEthBurned": "…",
    "totalTokensBurned": "…",
    "totalBountyInflowsWei": "…",
    "totalVaultBurnSweptWei": "…",
    "totalContributionVolumeWei": "…",
    "lastUpdatedAt": "…"
  }
}
```

`reachable: false` means the indexer was down (counter is `null`);
`ok: false` with `reachable: true` means no counter row yet. Server cache
window 30 seconds.

### GET /api/price/{chainId}/{address}

Path params: `chainId` (`1` for mainnet) and a token `address`. A
GeckoTerminal proxy returning
`{"priceUsd": number | null, "change24h": number | null}`. Unrecognized
chain ids return the null shape. Edge-cached:
`s-maxage=60, stale-while-revalidate=600`.

## Accepting the live bid

### GET /api/eligibility

Query params: `punkId` (0..9999, required), `caller` (0x address,
optional). Resolves a Punk against live protocol state for the
accept-the-bid flow. Returns the eligibility record plus pre-rendered
visuals:

- `punkId`, `owner`, `caller`, `isOwnedByCaller`
- `mask` (the Punk's trait bitmask, decimal string)
- `uncollectedBits` (trait ids not yet permanent, rarest first) and
  `pendingBits` (subset with an in-flight return auction, ineligible)
- `canonicalTargetId`: the protocol-derived target trait, mirroring
  `PermanentCollection.canonicalTargetOf(punkId)`; absent when no eligible
  target remains
- `listedToPatron`, `alreadyRecorded`, `soleCarrier` (the sole-carrier
  constraint record)
- `punkSvgInner` and `traitTilesByBit` (server-rendered SVG fragments)

No caching (computed per request). 400 on a bad `punkId`.

### GET /api/owned-punks

Query param: `address` (0x address, required). The Punk ids held by that
address, with per-Punk rendered tiles and 2017-market context:
`{punkIds, svgsByPunkId, bidsByPunkId, listingsByPunkId}`. `bidsByPunkId`
carries the highest standing market bid (`{valueWei, bidder}`);
`listingsByPunkId` carries public listings only (`{minValueWei}`, where
`onlySellTo` is unset).

### GET /api/owned-trait-options

Query param: `owner` (0x address, required). The rarest-first trait options
across the owner's Punks for the accept-the-bid picker:
`{options, punkSilhouettes, listedPunkIds}`, where `listedPunkIds` marks
Punks already listed exclusively to Patron.

### GET /api/sold-by

Query param: `seller` (0x address, required). Recent `acceptBid`
acceptances where this address was the seller, for the proceeds-claim
surface: `{sold: [{punkId, amountWei, blockNumber, timestamp, txHash}]}`.
Scans a recent window (currently the last 500 accepted-bid events), so it
is a convenience view, not an exhaustive ledger.

## Auctions

### GET /api/auction-bids

Query param: `punkId` (0..9999, required). The bid history of that Punk's
return auction, from the indexer:
`{bids: [{bidder, amount, blockNumber, timestamp, txHash}]}`. Server cache
window 30 seconds; 503 on an indexer outage.

### GET /api/title-auction/bids

No parameters. The Vault Title auction's bid history:
`{bids: [{bidder, amount, endsAt, extended, blockNumber, timestamp, txHash}]}`.
Server cache window 30 seconds.

## Traits and referrals

### GET /api/punks-with-trait

Query params: `traitId` (0..110, required), `offset` (default 0), `limit`
(default 60, max 120). A page of the Punk ids carrying that trait, ordered
rarest first, with rendered tiles: `{punkIds, svgsByPunkId, total}`. Served
from in-memory data (no chain or indexer read).

### GET /api/referral

Query param: `address` (0x address, required). The referrer's ledger
status, composed from the indexer's aggregate plus a chain read of the
hook's within-swap accrual:

```json
{
  "referrer": "0x…",
  "balance": "…",
  "totalCredited": "…",
  "totalClaimed": "…",
  "stuckOnHookWei": "…",
  "lastUpdatedAt": "…"
}
```

`balance` mirrors `ReferralPayout.balances(referrer)` (claimable via
[ReferralPayout](/docs/contracts/referral-payout)). Server cache window 30
seconds, keyed per address; 503 on an indexer outage.

## Internal routes

The `/api` namespace also contains internal and operational routes
(`config`, `rpc`, `referral-alias`, `keeper-report`, screenshot helpers for
tests). They exist but are not part of the public surface and aren't
documented here.
