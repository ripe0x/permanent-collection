---
contract: PunkVaultTitleAuction
slug: title-auction
deploymentsKey: titleAuction
title: PunkVaultTitleAuction
---

# summary

One-shot, permissionless English auction that sells the Vault Title, ERC721
token id 111 on `PunkVault`. The Title sits just past the 111 Proofs (token
ids 0..110) and is a single one-of-one. The auction contract holds the Title
in escrow from launch and delivers it to the highest bidder at settle; 100%
of the winning bid is credited to the immutable `payoutRecipient` through a
pull queue. The live bid receives nothing from this path.

There are no admin functions, no setters, and no fund-recovery path. Every
parameter is a compile-time constant (`KICKOFF_THRESHOLD = 22` traits,
`AUCTION_DURATION = 24 hours`, `MIN_INCREASE_BPS = 500`,
`SNIPE_TRIGGER_WINDOW = 15 minutes`, `SNIPE_EXTENSION = 1 hours`) or an
immutable bound at construction (`collection`, `vault`, `payoutRecipient`).
Every entry point is permissionless or pull-based.

Deployed at [{{addr:titleAuction}}](https://evm.now/address/{{addr:titleAuction}}?chainId=1).

# concepts

### Title mint is decoupled from the auction

The Title is minted into this contract's escrow at launch by the
permissionless, idempotent `mintTitle()` (a no-op once `titleMinted` is
set), so token id 111 exists and its `tokenURI` and marketplace page resolve
from the start. Minting does NOT open bidding. The auction opens separately
via `kickoff()`, which also re-calls the mint internally as an idempotent
fallback so `settle` always has a Title to transfer.

### Lifecycle

1. **Pre-kickoff.** The Title sits in escrow here. Bidding is closed;
   `bid()` reverts `AuctionNotLive`. `kickoff()` becomes callable once
   `collection.collectedCount() >= KICKOFF_THRESHOLD` (22 collected traits;
   each vaulted Punk collects exactly one trait, so this is also 22 Punks
   vaulted). `isKickoffReady()` reports the gate
2. **Live.** Anyone can `bid()`. There is no reserve: the first bid only
   needs to be non-zero. Each subsequent bid must be strictly greater than
   the current high AND at least 5% above it (`MIN_INCREASE_BPS = 500` on a
   10,000 denominator). A bid landing inside the final 15 minutes
   (`SNIPE_TRIGGER_WINDOW`) pushes `endsAt` to `block.timestamp + 1 hour`
   (`SNIPE_EXTENSION`), uncapped, any number of times
3. **Settle.** After `endsAt`, anyone can call `settle()`. With a winner,
   the Title transfers via `transferFrom` (not `safeTransferFrom`, so a
   non-receiver-aware winner contract can't strand it) and the full high bid
   is credited to `pendingProceeds[payoutRecipient]`. With no bidder, the
   auction does NOT finalize: `endsAt` extends by another
   `AUCTION_DURATION` and `Kickoff` re-emits, looping indefinitely until
   someone bids

### Pull-based ETH movement

The contract never lets an unwilling recipient block state transitions:

- **Outbid refunds** are pushed with a 30,000-gas `call`; if the push
  fails, the amount accrues in `pendingRefund[bidder]` for later
  `withdrawRefund()`
- **Settle proceeds** are never pushed. `settle` only credits
  `pendingProceeds[payoutRecipient]`; the ETH moves later via
  `withdrawProceeds`, which anyone may trigger for the credited recipient.
  A `payoutRecipient` that reverts on `receive` cannot block the Title
  transfer

### Reading the auction state

```bash
ADDR={{addr:titleAuction}}
RPC=https://ethereum-rpc.publicnode.com

cast call $ADDR "isKickoffReady()(bool)"  --rpc-url $RPC
cast call $ADDR "isLive()(bool)"          --rpc-url $RPC
cast call $ADDR "isSettleable()(bool)"    --rpc-url $RPC
cast call $ADDR "endsAt()(uint64)"        --rpc-url $RPC
cast call $ADDR "highBidWei()(uint128)"   --rpc-url $RPC
cast call $ADDR "highBidder()(address)"   --rpc-url $RPC
cast call $ADDR "minNextBid()(uint256)"   --rpc-url $RPC
```

## function bid

access: permissionless (payable)

Place a bid of `msg.value` wei. Reverts `AuctionNotLive` before `kickoff()`
or after a winning settle, `AuctionEnded` at or past `endsAt`, and `ZeroBid`
for a zero-value call. The bid must be strictly greater than `highBidWei`
(`BidNotHigherThanCurrent`) AND at least
`highBidWei * 10_500 / 10_000` (`BidBelowMinimumIncrease`); the strict
check handles the rounding edge case for sub-20-wei highs. Read
`minNextBid()` first and bid at least that (and more than zero on the first
bid).

On acceptance the caller becomes `highBidder`. If fewer than
`SNIPE_TRIGGER_WINDOW` (15 minutes) remain, `endsAt` extends to
`block.timestamp + SNIPE_EXTENSION` (1 hour) and `Extended` is emitted; the
extension is uncapped. The previous high bidder is refunded with a
30,000-gas push; a failed push queues the amount in `pendingRefund` and
emits `RefundQueued`. Guarded `nonReentrant` and `notInSwap`.

```ts
import {createWalletClient, http, parseAbi, publicActions} from 'viem';
import {mainnet} from 'viem/chains';

const abi = parseAbi([
  'function bid() payable',
  'function minNextBid() view returns (uint256)',
  'function isLive() view returns (bool)',
]);
const titleAuction = '{{addr:titleAuction}}';

const client = createWalletClient({
  account, // your viem account
  chain: mainnet,
  transport: http(),
}).extend(publicActions);

const live = await client.readContract({address: titleAuction, abi, functionName: 'isLive'});
if (!live) throw new Error('auction is not accepting bids');

const min = await client.readContract({address: titleAuction, abi, functionName: 'minNextBid'});
const value = min === 0n ? 10n ** 17n : min; // first bid: any non-zero amount

const hash = await client.writeContract({
  address: titleAuction,
  abi,
  functionName: 'bid',
  value,
});
console.log(`https://evm.now/tx/${hash}?chainId=1`);
```

## function settle

access: permissionless

Finalize (or restart) the auction once `block.timestamp >= endsAt`. Reverts
`AuctionNotLive` before kickoff, `AlreadySettled` after a winning settle,
and `AuctionLive` while the clock is still running.

With a high bidder: sets `settled`, credits 100% of `highBidWei` to
`pendingProceeds[payoutRecipient]` (emitting `ProceedsQueued`), then
transfers the Title (token id 111) from escrow to the winner via
`transferFrom` and emits `Settled`. No ETH is pushed during settle, so the
payout recipient cannot block it.

With no bidder: does NOT flip `settled`. Extends `endsAt` by another
`AUCTION_DURATION` (24 hours), emits `SettledNoBidder` then `Kickoff` with
the new deadline, and returns; the auction loops until someone bids.
Guarded `nonReentrant` and `notInSwap`.

## function kickoff

access: permissionless, gated on the collected-trait threshold

Start the 24-hour auction clock. Reverts `AlreadyKickedOff` on a repeat
call and `ThresholdNotReached` while
`collection.collectedCount() < KICKOFF_THRESHOLD` (22). Sets `kickedOff`,
sets `endsAt = block.timestamp + AUCTION_DURATION`, mints the Title into
escrow as an idempotent fallback (it is normally minted at launch), and
emits `Kickoff(block.number, endsAt)`. Check `isKickoffReady()` before
calling.

## function mintTitle

access: permissionless, idempotent

Mint the Title (token id 111) from `PunkVault` into this auction's escrow.
Called once at launch so the Title exists and its `tokenURI` and
marketplace page resolve from the start, independent of the auction. A
no-op if `titleMinted` is already set, so repeat calls succeed without
effect. Minting does NOT open bidding: the auction stays closed until
`kickoff()` past `KICKOFF_THRESHOLD`. On mainnet the Title is already
minted (`titleMinted()` returns true).

## function withdrawRefund

access: permissionless, pays msg.sender's own queued refund

Pull the caller's queued outbid refund (amounts that failed the 30,000-gas
push during `bid`). Zeroes `pendingRefund[msg.sender]` before sending the
full balance with an unbounded `call`. Reverts `NothingToWithdraw` on a
zero balance and `TransferFailed` (balance reinstated by the revert) if the
send fails. Emits `RefundWithdrawn`. Guarded `nonReentrant` and
`notInSwap`.

## function withdrawProceeds(address)

access: permissionless, funds always go to the credited recipient

Pull queued settle proceeds for `recipient` (in practice the immutable
`payoutRecipient`, credited 100% of the high bid at settle). Anyone may
trigger the transfer; the ETH always goes to the credited address, so
proceeds stay claimable even if `payoutRecipient` has no generic
outbound-call surface. Zeroes the balance before sending; reverts
`NothingToWithdraw` on a zero balance and `TransferFailed` if the send
fails. Emits `ProceedsWithdrawn`. Guarded `nonReentrant` and `notInSwap`.

## function withdrawProceeds()

access: permissionless, pays msg.sender's own credit

Convenience wrapper equivalent to `withdrawProceeds(msg.sender)`. Use the
`withdrawProceeds(address)` overload to pull on behalf of another credited
recipient.

## function AUCTION_DURATION

Constant `24 hours` (86,400 seconds). The span from `kickoff` to the initial
`endsAt`, and the length of each no-bid restart extension.

## function KICKOFF_THRESHOLD

Constant `22`. Number of collected traits required before `kickoff()` is
callable. Each vaulted Punk collects exactly one trait, so this equals 22
Punks vaulted.

## function MIN_INCREASE_BPS

Constant `500` (5% on a 10,000 denominator). Minimum increment a new bid
must clear over the current high; the bid must also be strictly greater in
wei terms.

## function SNIPE_EXTENSION

Constant `1 hours` (3,600 seconds). How far past `block.timestamp` the
deadline moves when a bid lands inside the trigger window.

## function SNIPE_TRIGGER_WINDOW

Constant `15 minutes` (900 seconds). A bid with less than this remaining
before `endsAt` triggers the anti-snipe extension.

## function TITLE_TOKEN_ID

Constant `111`. Token id of the Vault Title on `PunkVault`, just past the
111 Proofs (ids 0..110). Mirrors `PunkVault.TITLE_TOKEN_ID`.

## function TRAIT_COUNT

Constant `111`. Total trait bits; matches `PermanentCollection.TRAIT_COUNT`.

## function collection

The immutable `PermanentCollection` records core, read for
`collectedCount()` in the kickoff gate.

## function endsAt

Current auction deadline as a unix timestamp (`uint64`). Zero before
kickoff. Moves forward on anti-snipe extensions and on no-bid `settle`
restarts.

## function highBidWei

Current high bid in wei (`uint128`). Zero before the first bid.

## function highBidder

Address of the current high bidder. `address(0)` before the first bid.

## function isKickoffReady

True iff `kickoff()` would succeed right now: not yet kicked off and
`collection.collectedCount() >= 22`.

## function isLive

True iff the auction is currently accepting bids: kicked off, not settled,
and `block.timestamp < endsAt`.

## function isSettleable

True iff `settle()` would succeed right now: kicked off, not settled, and
`block.timestamp >= endsAt`. Note the no-bidder case is still "settleable";
that call restarts the clock rather than finalizing.

## function kickedOff

True once `kickoff()` has run. Never resets.

## function minNextBid

Minimum acceptable bid right now: `highBidWei * 10_500 / 10_000`, rounded
down by integer division. Returns 0 before any bids; the first bid only
needs to be non-zero. Because `bid()` also requires strict wei superiority,
send at least `max(minNextBid(), highBidWei() + 1)`.

## function payoutRecipient

The immutable address credited 100% of the winning bid at settle. Set once
at construction; no rotation path, no admin path. It is a payout
destination chosen at deploy time (any EOA, multisig, or splitter).

## function pendingProceeds

Per-address pull-queue balance for settle proceeds, in wei. Nonzero for
`payoutRecipient` between a winning settle and the corresponding
`withdrawProceeds` claim.

## function pendingRefund

Per-address pull-queue balance for outbid refunds whose 30,000-gas push
failed, in wei. Claimed by the bidder via `withdrawRefund()`.

## function settled

True once a winning `settle()` has run. Stays false through no-bid
restarts.

## function titleMinted

True once the Title (token id 111) has been minted into this auction's
escrow via `mintTitle()` (or the fallback mint inside `kickoff()`). Never
resets. Independent of the auction state: true does not imply bidding is
open.

## function vault

The immutable `PunkVault` that mints the Title into this contract's escrow
and from which the Title transfers to the winner at settle.

## event Bid

Emitted on every accepted bid. `endsAt` reflects the deadline AFTER any
anti-snipe extension this bid triggered, so an indexer can drive its
countdown from this event alone.

## event Extended

Emitted when an anti-snipe extension moved `endsAt` further into the
future, alongside the `Bid` event that triggered it.

## event Kickoff

Emitted when the auction clock (re)starts: once from `kickoff()`, and again
from every no-bid `settle()` restart. Indexers should treat each `Kickoff`
as a deadline refresh, not assume it fires once.

## event ProceedsQueued

Emitted at a winning settle when 100% of the high bid is credited to
`payoutRecipient` in the pull queue. The ETH has not moved yet.

## event ProceedsWithdrawn

Emitted when a queued proceeds credit was successfully pulled via
`withdrawProceeds`.

## event RefundQueued

Emitted during `bid()` when the 30,000-gas refund push to the outbid bidder
failed and the amount was queued in `pendingRefund` instead.

## event RefundWithdrawn

Emitted when a queued refund was successfully pulled via
`withdrawRefund()`.

## event Settled

Emitted on the winning settle path: the Title transferred to `winner` and
`highBid` was credited to `payoutRecipient`. Terminal; at most one per
deployment.

## event SettledNoBidder

Emitted on the no-bidder settle path. The auction did not finalize; it
extended by another `AUCTION_DURATION` and re-emitted `Kickoff`.

## error AlreadyKickedOff

`kickoff()` was called after the auction clock already started. Nothing to
do; read `endsAt` for the current deadline.

## error AlreadySettled

`settle()` was called after a winning settle. The auction is over.

## error AuctionEnded

`bid()` was called at or after `endsAt`. Call `settle()` instead (or wait
for a no-bid restart).

## error AuctionLive

`settle()` was called before `endsAt`. Wait for the deadline; check
`isSettleable()`.

## error AuctionNotLive

`bid()` or `settle()` was called before `kickoff()`, or `bid()` after a
winning settle. Check `isLive()` / `isKickoffReady()` first.

## error BidBelowMinimumIncrease

The bid beat the current high but by less than 5%. Carries the failing
`bid` and the `minRequired` amount; re-bid at `minRequired` or read
`minNextBid()`.

## error BidNotHigherThanCurrent

The bid was less than or equal to the current high. Carries the failing
`bid` and `currentHigh`; re-bid strictly above it.

## error InSwap

A decorated entry point was called during an official-pool swap while a
swap-context extension is bound. Retry outside the swap.

## error NothingToWithdraw

`withdrawRefund()` or `withdrawProceeds` found a zero balance for the
target address. Nothing is owed.

## error Reentrant

A `nonReentrant` entry point was re-entered within the same transaction,
typically from a refund or payout `call`. The outer call must complete
first.

## error ThresholdNotReached

`kickoff()` was called with fewer than 22 traits collected. Wait for the
collection to reach `KICKOFF_THRESHOLD`; check `isKickoffReady()`.

## error TransferFailed

An outbound ETH send in `withdrawRefund()` or `withdrawProceeds` reverted.
The balance is reinstated by the revert; fix the recipient's `receive` path
and retry.

## error ZeroAddress

Constructor guard: `collection`, `vault`, and `payoutRecipient` must all be
non-zero at deploy time. Never reachable post-deploy.

## error ZeroBid

`bid()` was called with zero `msg.value`. The first bid has no reserve but
must be non-zero.
