---
contract: ReturnAuctionEscrow
slug: return-auction-escrow
title: ReturnAuctionEscrow
---

# summary

Transient settlement escrow that makes the 2017 CryptoPunks market record a
real `PunkBought(seller, buyer, price)` for every cleared return auction,
instead of a price-less `PunkTransfer`. During a cleared settle,
`ReturnAuctionModule` transfers the won Punk here, the escrow lists it
exclusively back to the module at the hammer price, the module buys it (so
the canonical market emits `PunkBought` with this escrow as seller of record
and the module as buyer), and the sale proceeds round-trip straight back to
the module via `sweepProceeds`. Net ETH movement through the escrow is zero
per settle, and the whole dance runs atomically inside the module's
`settle()`, so the Punk is never left here across transactions.

The contract is deployed once by `ReturnAuctionModule` in its own
constructor and pinned to that single caller, so it has no entry in the
deployments file. Discover its address on-chain from the module's immutable
`escrow()` view:

```bash
cast call {{addr:returnAuctionModule}} "escrow()(address)" \
  --rpc-url https://ethereum-rpc.publicnode.com
```

Every function is module-only, and `receive()` accepts ETH only from the
Punk market. There is no admin, no withdrawal path, and no way for any third
party to move a Punk or ETH through this contract.

# concepts

### Why the round-trip exists

CryptoPunks provenance tooling reads sale history from `PunkBought` events
on the canonical market. A cleared return auction settles inside the module
(the winner's bid is already escrowed there), so a plain `transferPunk` to
the winner would record no price. The round-trip inserts a genuine
market-recorded sale at the clearing price: module transfers the Punk to
this escrow, escrow calls `offerPunkForSaleToAddress(punkId, hammerWei,
MODULE)`, module calls `buyPunk{value: hammerWei}`, market emits
`PunkBought(escrow, module, hammerWei)`, and `sweepProceeds` pulls the
market credit back to the module for the proceeds split.

One reading note for indexers: the recorded buyer in that `PunkBought` is
the module, a protocol contract, never the human winner. The market records
`msg.sender` of `buyPunk` as the buyer, and the winner isn't paying at
settle time. The winner still receives the Punk as the recipient of the
final `transferPunk` in the same transaction.

## function listForSettlement

access: module-only (`MODULE`, the deploying `ReturnAuctionModule`; any other caller reverts `NotModule`)

Lists the Punk the escrow currently holds for sale exclusively to the module
at the hammer price, via the market's `offerPunkForSaleToAddress`. The
module transfers the Punk in immediately before calling and calls `buyPunk`
immediately after, all within one `settle()` transaction. Not useful in
isolation: the exclusive listing can only be taken by the module itself.

## function sweepProceeds

access: module-only (any other caller reverts `NotModule`)

Pulls the escrow's post-sale credit out of the market
(`punksMarket.withdraw()`, which triggers this contract's market-gated
`receive()`) and forwards the full ETH balance to the module so it can run
the cleared-path proceeds split. Returns silently on a zero balance; reverts
`ProceedsForwardFailed` if the module refuses the ETH, which can't happen on
the live wiring since the module's `receive()` accepts ETH from this escrow.

## receive

access: market-only (only the CryptoPunks market; any other sender reverts `UnexpectedEtherSender`)

Accepts ETH only from the Punk market, which pushes it during the
`withdraw()` call inside `sweepProceeds`. Any other sender reverts, so ETH
can't be parked here from outside and there is nothing for an admin path to
move (none exists).

## function MODULE

The immutable `ReturnAuctionModule` that deployed this escrow and is its
only authorized caller. Captured as `msg.sender` at construction, never
changes.

## function punksMarket

The immutable 2017 CryptoPunks market address the escrow lists on, buys
through, and withdraws from. Set at construction, never changes.

## error NotModule

`listForSettlement` or `sweepProceeds` was called by an address other than
`MODULE`. The escrow acts only on the module's instructions.

## error ProceedsForwardFailed

The ETH forward to the module at the end of `sweepProceeds` failed. Reverts
the call so no proceeds are stranded; unreachable on the live wiring, where
the module accepts ETH from this escrow.

## error UnexpectedEtherSender

`receive()` got ETH from an address other than the Punk market. Direct
sends to the escrow are rejected by design.
