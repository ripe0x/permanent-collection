---
title: AI agents
description: One entry point for agents, indexers, and bots: which files to fetch, which reads to call, which events to watch, and which endpoints exist.
---

# AI agents

This page is the entry point for automated consumers of the protocol: agents,
indexers, keeper bots, and retrieval pipelines. It links out to the full
reference rather than restating it. Everything below is a public read or a
permissionless call; nothing here needs an API key.

The protocol is a set of contracts on Ethereum mainnet (chain id 1). All state
is on-chain. The surfaces on this page are conveniences layered over that
state: a manifest that names every contract, an indexer that mirrors events
into a queryable database, cached JSON endpoints that back the site, and this
documentation itself as a retrieval corpus.

## Machine-readable surfaces

| Surface | URL | What it is |
| --- | --- | --- |
| Protocol manifest | [`/protocol-manifest.json`](/protocol-manifest.json) | Canonical origin, addresses, ABI paths, and docs links per contract |
| Contract ABIs | `/abis/<ContractName>.json` | One plain ABI array per contract |
| LLM orientation | [`/llms.txt`](/llms.txt) | A compact map of the whole reference, with absolute links |
| Docs search index | [`/docs-search-index.json`](/docs-search-index.json) | Every docs section as a retrievable record |
| Indexer | GraphQL, env-configured | Events mirrored into queryable tables ([reference](/docs/offchain/indexer)) |
| REST endpoints | `/api/*` | Cached JSON the site reads ([reference](/docs/offchain/rest-api)) |

Start from [`/protocol-manifest.json`](/protocol-manifest.json): its `origin`
field is the canonical site (`https://permanentcollection.art`), and every
contract entry carries the address, a relative ABI path, and its docs page.

## Recipe 1: read headline protocol state

Cheapest first. The indexer's `protocolCounter(id: "global")` row holds the
running totals in one query:

```graphql
{
  protocolCounter(id: "global") {
    collectedCount
    vaultedCount
    proofsMinted
    totalEthBurned
    totalTokensBurned
    totalSwapVolumeWei
  }
}
```

For the live bid and the count without an indexer, read the chain directly:

```bash
cast call {{addr:permanentCollection}} "collectedCount()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:permanentCollection}} "isComplete()(bool)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:patron}} "bidBalance()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
```

The site also serves [`/api/live-bid`](/docs/offchain/rest-api) and
`/api/stats` (cached JSON) for the same numbers. Full read surface:
[read the collection state](/docs/guides/read-collection-state).

## Recipe 2: check whether a Punk is eligible

A Punk is eligible for the live bid when it carries an uncollected,
not-pending trait. The one call that answers it is
`PermanentCollection.canonicalTargetOf(punkId)`, which returns the
protocol-derived target trait or reverts `NoEligibleTarget`:

```bash
cast call {{addr:permanentCollection}} "canonicalTargetOf(uint16)(uint8)" 6529 --rpc-url https://ethereum-rpc.publicnode.com
```

The [`/api/eligibility?punkId=<id>`](/docs/offchain/rest-api) endpoint resolves
the whole record in one request: `canonicalTargetId`, `uncollectedBits`,
`pendingBits` (in-flight, therefore ineligible), `alreadyRecorded`, and the
`soleCarrier` constraint. Full flow:
[accept the live bid](/docs/guides/accept-the-live-bid).

## Recipe 3: find live return auctions

Every accepted Punk sits in a 72-hour return auction until it clears or is
vaulted. The indexer lists the open ones, soonest-ending first:

```graphql
{
  returnAuctions(where: {settled: false}, orderBy: "endsAt", orderDirection: "asc") {
    items { punkId targetTraitId reserveWei highBidWei highBidder endsAt }
  }
}
```

On-chain, `ReturnAuctionModule.isLive(punkId)`, `getSale(punkId)`, and
`isSettleable(punkId)` answer the same per Punk. See
[ReturnAuctionModule](/docs/contracts/return-auction-module) and
[bid on a return auction](/docs/guides/bid-on-a-return-auction).

## Recipe 4: watch protocol events

Two ways in. For historical or aggregate views, query the
[indexer](/docs/offchain/indexer): each table names the events that feed it.
For live reaction, subscribe to logs with viem. The
[events index](/docs/reference/events) lists every event and its contract.

```ts
import {createPublicClient, webSocket, parseAbiItem} from 'viem';
import {mainnet} from 'viem/chains';

const client = createPublicClient({chain: mainnet, transport: webSocket()});

client.watchEvent({
  address: '{{addr:returnAuctionModule}}',
  event: parseAbiItem(
    'event ReturnAuctionStarted(uint16 indexed punkId, uint128 acquisitionCost, uint128 reserveWei, uint64 startedAt, uint64 endsAt)',
  ),
  onLogs: (logs) => {
    for (const log of logs) console.log('new auction', log.args.punkId);
  },
});
```

Load the exact event signature for any contract from its ABI at
`/abis/<ContractName>.json` rather than hand-writing it.

## Recipe 5: run keeper actions

Four permissionless calls keep the protocol moving; three pay the caller a
bounded reward. Check readiness off-chain, simulate, then send:

- `LiveBidAdapter.sweep()` meters the buffer into the live bid
- `BuybackBurner.executeStep(minOut)` buys and burns $111 in paced steps
- `ReturnAuctionModule.settle(punkId)` closes an auction past its deadline
- `ProtocolFeePhaseAdapter.sweep()` forwards the protocol fee leg

Each call's timing, reward, and readiness reads are in
[run a keeper](/docs/guides/run-a-keeper).

## Recipe 6: load the protocol manifest and ABIs

Fetch the manifest once, then instantiate any contract from it:

```ts
import {createPublicClient, getContract, http} from 'viem';
import {mainnet} from 'viem/chains';

const ORIGIN = 'https://permanentcollection.art';
const manifest = await fetch(`${ORIGIN}/protocol-manifest.json`).then((r) => r.json());
const entry = manifest.contracts.Patron;
const abi = await fetch(`${ORIGIN}${entry.abi}`).then((r) => r.json());

const client = createPublicClient({chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com')});
const patron = getContract({address: entry.address, abi, client});
const liveBidWei = await patron.read.bidBalance();
```

The same pattern works for any contract in the manifest. Details and the full
ABI list: [ABIs and the protocol manifest](/docs/offchain/abis-and-manifest).

## Recipe 7: use the public REST endpoints

The site exposes cached JSON at `/api/*` for the reads its own pages need:
`/api/live-bid`, `/api/stats`, `/api/eligibility`, `/api/auction-bids`,
`/api/punks-with-trait`, and more. These serve the frontend and are not a
versioned API contract; on-chain reads and the indexer are the canonical
interfaces. Response shapes and parameters:
[REST endpoints](/docs/offchain/rest-api).

## Recipe 8: use the docs search index as retrieval context

[`/docs-search-index.json`](/docs-search-index.json) is this reference split
into retrievable records, one per section. Each record is:

```json
{
  "path": "/docs/contracts/patron",
  "page": "Patron",
  "heading": "acceptBid",
  "anchor": "acceptbid",
  "text": "…the first ~300 characters of the section…"
}
```

Embed or keyword-match over `heading` + `text`, then resolve a citation URL as
`${origin}${path}` (append `#${anchor}` when set). For a smaller map of the
same content, [`/llms.txt`](/llms.txt) lists every page with an absolute link
and a one-line description.
