---
title: Bid on a return auction
description: Find live return auctions, compute the minimum bid, place and settle bids, and collect refunds.
---

# Bid on a return auction

Every Punk the protocol acquires enters a 72-hour return auction on
[ReturnAuctionModule](/docs/contracts/return-auction-module) at
`{{addr:returnAuctionModule}}`. Bid at or above the reserve and win, and the
Punk is yours at settle. If nobody bids by the deadline, the Punk is vaulted
permanently and its target trait becomes a permanent trait. This guide covers
finding auctions, the minimum-bid math, referral attribution, refunds, and
settlement.

## Finding live auctions

Auctions are keyed by `punkId`. To discover them, watch the module's events:

```solidity
event ReturnAuctionStarted(uint16 indexed punkId, uint128 acquisitionCost, uint128 reserveWei, uint64 startedAt, uint64 endsAt);
event BidPlaced(uint16 indexed punkId, address indexed bidder, address indexed referrer, uint256 amount, bytes32 tag, uint64 endsAt);
event ReturnAuctionExtended(uint16 indexed punkId, uint64 newEndsAt);
```

Then confirm state with the read surface:

- `isLive(punkId) -> bool`: true while the auction accepts bids
- `isSettleable(punkId) -> bool`: true once the deadline has passed and
  `settle` would succeed
- `getSale(punkId)` returns the full sale struct:
  `(acquisitionCost, highBidWei, highBidder, startedAt, endsAt, reserveWei, targetTraitId, settled)`.
  A zero-valued struct means no sale has ever started for this Punk
- `reserveOf(punkId) -> uint256`, `highBidOf(punkId) -> uint128`,
  `highBidderOf(punkId) -> address`, `endsAt(punkId) -> uint64`,
  `startedAt(punkId) -> uint64` are the individual fields

```bash
RPC=https://ethereum-rpc.publicnode.com
RAM={{addr:returnAuctionModule}}
PUNK_ID=1234

cast call $RAM "isLive(uint16)(bool)" $PUNK_ID --rpc-url $RPC
cast call $RAM \
  "getSale(uint16)((uint128,uint128,address,uint64,uint64,uint128,uint8,bool))" \
  $PUNK_ID --rpc-url $RPC
```

## Minimum-bid math

Two rules, both enforced on-chain:

**First bid: meet the reserve.** The reserve is snapshotted at auction start
as `acquisitionCost x (101 + previousAttempts) / 100`, rounded up, where
`previousAttempts` counts prior return auctions against the same target trait.
The first attempt against a trait opens at a 1% premium over what the protocol
paid, the second at 2%, and so on. A first bid below `reserveOf(punkId)`
reverts `BidBelowReserve`; a zero first bid reverts `BidNotHigherThanCurrent`.

**Subsequent bids: beat the high by 1%.** `minBidIncrementBps` is the protocol
constant `100` (1%, denominator 10,000). The next valid bid is

```
minNext = currentHigh + (currentHigh * 100) / 10_000
```

with a defensive `minNext = currentHigh + 1` if rounding would leave it equal.
A bid below `minNext` reverts `BidBelowMinIncrement(bid, minNext)`.

```bash
RESERVE=$(cast call $RAM "reserveOf(uint16)(uint256)" $PUNK_ID --rpc-url $RPC | awk '{print $1}')
HIGH=$(cast call $RAM "highBidOf(uint16)(uint128)" $PUNK_ID --rpc-url $RPC | awk '{print $1}')
# first bid: RESERVE. later bids: HIGH + HIGH/100 (rounded down, min +1 wei)
```

## placeBid vs placeBidWithReferral

```solidity
function placeBid(uint16 punkId) external payable
function placeBidWithReferral(uint16 punkId, address referrer, bytes32 tag) external payable
```

`placeBid` is the plain entry point and is exactly
`placeBidWithReferral(punkId, address(0), bytes32(0))`.

`placeBidWithReferral` attaches attribution for frontends and aggregators:

- if this bid is the winning bid at settle, `referrer` earns
  `REFERRER_PREMIUM_BPS = 500` (5%) of the premium, where the premium is
  `highBid - acquisitionCost`. The reserve formula guarantees a positive
  premium on every cleared auction
- the slot is winner-take-all: `referrerOfHighBid[punkId]` is overwritten on
  every accepted bid, so an outbid bidder's referrer loses attribution. Only
  the final winning bid's referrer is paid
- the payment is fail-closed: a zero referrer, or a referrer whose receive
  reverts or runs out of the 35,000-gas send budget, forfeits the share, which
  folds into the vault-burn pool. Settlement never blocks on a referrer
- `tag` is a free-form 32-byte campaign marker emitted in `BidPlaced` for
  off-chain attribution. It is not stored on-chain; pass `bytes32(0)` if
  unused

Bid reverts to know: `SaleMissing` (no sale for this Punk), `AlreadySettled`,
`SaleEnded` (past the deadline), plus the two minimum-bid reverts above.

## Anti-snipe extension

Any accepted bid placed within the final 15 minutes
(`SNIPE_TRIGGER_WINDOW`) moves the deadline to the bid's timestamp plus 1 hour
(`SNIPE_EXTENSION`) and emits `ReturnAuctionExtended`. The extension is
uncapped: an actively contested Punk stays in bidding for as long as bidders
keep escalating, and each round must exceed the last by 1%, so the locked
capital required to keep extending grows geometrically. Always read
`endsAt(punkId)` fresh rather than caching the original deadline.

## Refunds when outbid

When you're outbid, the module pushes your ETH back immediately with a
30,000-gas send. If that push fails (a contract bidder whose receive needs
more gas), the amount is queued in `pendingRefund[bidder]` and `RefundQueued`
is emitted. Pull it any time:

```solidity
function withdrawRefund() external
```

Reverts `NothingToWithdraw` when your balance is zero. Check first with
`pendingRefund(address) -> uint256`.

## Settling after the deadline

```solidity
function settle(uint16 punkId) external
```

Anyone may call once `block.timestamp >= endsAt` (before that it reverts
`SaleLive`; after a settle it reverts `AlreadySettled`). There is no keeper
tip: as the winning bidder your incentive is that you receive the Punk only on
settle.

**Cleared (a winning bid exists).** The Punk is delivered to the winning
bidder through a settlement escrow round-trip that records a real
`PunkBought` at the hammer price on the 2017 market. The proceeds split,
hard-coded with no setter:

- 65% of `acquisitionCost` to [LiveBidAdapter](/docs/contracts/live-bid-adapter),
  refilling the live bid
- 25% of `acquisitionCost` to [BuybackBurner](/docs/contracts/buyback-burner),
  which buys and burns $111
- 10% of `acquisitionCost`, plus the premium (`highBid - acquisitionCost`)
  less any referrer share, to [VaultBurnPool](/docs/contracts/vault-burn-pool)
- 5% of the premium to the winning bid's referrer, if one was attached

`ReturnAuctionCleared(punkId, buyer, referrer, highBidWei, liveBidShare,
burnShare, vaultBurnShare, referrerShare)` is emitted and the Punk's custody
becomes `ReturnedToMarket`. A returned Punk can be acquired again later, and
its next auction's reserve escalates by the per-trait attempt counter.

**Unsold (no bids).** The Punk transfers to
[PunkVault](/docs/contracts/punk-vault) permanently, the recorded target trait
(and only that trait) becomes a permanent trait, `PunkVaulted(punkId)` is
emitted, and, on a trait's first vaulting, the Proof NFT for that trait is
minted to the acquisition's recorded `originalSeller`.

## cast walkthrough

```bash
RPC=https://ethereum-rpc.publicnode.com
RAM={{addr:returnAuctionModule}}
PUNK_ID=1234

# ── State ──
cast call $RAM "isLive(uint16)(bool)" $PUNK_ID --rpc-url $RPC
RESERVE=$(cast call $RAM "reserveOf(uint16)(uint256)" $PUNK_ID --rpc-url $RPC | awk '{print $1}')
HIGH=$(cast call $RAM "highBidOf(uint16)(uint128)" $PUNK_ID --rpc-url $RPC | awk '{print $1}')

# ── First bid at the reserve ──
cast send $RAM "placeBid(uint16)" $PUNK_ID \
  --value $RESERVE --private-key $KEY --rpc-url $RPC

# ── Or a later bid with referral attribution (HIGH + 1%; bc avoids 64-bit
# shell-arithmetic overflow on wei values) ──
BID=$(echo "$HIGH + $HIGH / 100" | bc)
cast send $RAM "placeBidWithReferral(uint16,address,bytes32)" \
  $PUNK_ID $REFERRER 0x0000000000000000000000000000000000000000000000000000000000000000 \
  --value $BID --private-key $KEY --rpc-url $RPC

# ── If outbid and the push refund failed ──
cast call $RAM "pendingRefund(address)(uint256)" $MY_ADDRESS --rpc-url $RPC
cast send $RAM "withdrawRefund()" --private-key $KEY --rpc-url $RPC

# ── After the deadline ──
cast call $RAM "isSettleable(uint16)(bool)" $PUNK_ID --rpc-url $RPC
cast send $RAM "settle(uint16)" $PUNK_ID --private-key $KEY --rpc-url $RPC
```

## viem walkthrough

```ts
import {createPublicClient, createWalletClient, http, parseAbi, zeroHash} from 'viem';
import {mainnet} from 'viem/chains';

const MODULE = '{{addr:returnAuctionModule}}';

const moduleAbi = parseAbi([
  'function isLive(uint16 punkId) view returns (bool)',
  'function isSettleable(uint16 punkId) view returns (bool)',
  'function reserveOf(uint16 punkId) view returns (uint256)',
  'function highBidOf(uint16 punkId) view returns (uint128)',
  'function endsAt(uint16 punkId) view returns (uint64)',
  'function pendingRefund(address bidder) view returns (uint256)',
  'function placeBid(uint16 punkId) payable',
  'function placeBidWithReferral(uint16 punkId, address referrer, bytes32 tag) payable',
  'function withdrawRefund()',
  'function settle(uint16 punkId)',
]);

const client = createPublicClient({chain: mainnet, transport: http()});
const wallet = createWalletClient({chain: mainnet, transport: http(), account});

const punkId = 1234;

if (!(await client.readContract({address: MODULE, abi: moduleAbi, functionName: 'isLive', args: [punkId]}))) {
  throw new Error('No live return auction for this Punk');
}

// Minimum valid bid: reserve on the first bid, high + 1% after
const reserve = await client.readContract({address: MODULE, abi: moduleAbi, functionName: 'reserveOf', args: [punkId]});
const high = await client.readContract({address: MODULE, abi: moduleAbi, functionName: 'highBidOf', args: [punkId]});
let minBid: bigint;
if (high === 0n) {
  minBid = reserve;
} else {
  minBid = high + (high * 100n) / 10_000n;
  if (minBid <= high) minBid = high + 1n;
}

// Bid with referral attribution (use placeBid to skip attribution)
await wallet.writeContract({
  address: MODULE, abi: moduleAbi,
  functionName: 'placeBidWithReferral',
  args: [punkId, referrerAddress, zeroHash],
  value: minBid,
});

// If outbid and the 30k-gas push refund failed, pull it back
const refund = await client.readContract({
  address: MODULE, abi: moduleAbi, functionName: 'pendingRefund', args: [account.address],
});
if (refund > 0n) {
  await wallet.writeContract({address: MODULE, abi: moduleAbi, functionName: 'withdrawRefund'});
}

// After endsAt, anyone can settle. If you won, this delivers the Punk
if (await client.readContract({address: MODULE, abi: moduleAbi, functionName: 'isSettleable', args: [punkId]})) {
  await wallet.writeContract({address: MODULE, abi: moduleAbi, functionName: 'settle', args: [punkId]});
}
```

Contract reference:
[ReturnAuctionModule](/docs/contracts/return-auction-module),
[LiveBidAdapter](/docs/contracts/live-bid-adapter),
[PunkVault](/docs/contracts/punk-vault),
[VaultBurnPool](/docs/contracts/vault-burn-pool).
