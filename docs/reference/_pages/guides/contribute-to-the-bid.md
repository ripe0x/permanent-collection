---
title: Contribute to the live bid
description: Route ETH into the live bid with attributed contributions or bare sends to LiveBidAdapter.
---

# Contribute to the live bid

Any address can grow the live bid by sending ETH to
[LiveBidAdapter](/docs/contracts/live-bid-adapter) at
`{{addr:liveBidAdapter}}`. The adapter is the single faucet into the bid:
[Patron](/docs/contracts/patron) accepts ETH only from it, so every
contribution, fee, and refund enters here, buffers, and meters into the bid
under one rate policy. There is no withdrawal path; the buffer can only exit
toward Patron.

## contribute(referrer, tag): the attributed top-up

```solidity
function contribute(address referrer, bytes32 tag) external payable
```

This is the canonical on-chain destination for capital that wants to align
with the collection. It pays a referrer share and logs a structured event for
indexers:

- `REFERRER_CONTRIB_BPS = 500`: 5% of `msg.value` goes to `referrer`,
  hard-coded with no setter and no admin. The remaining 95% joins the buffer
- passing `referrer = address(0)` skips the share entirely: 100% of the value
  is buffered for the bid
- the referrer send is fail-closed with a 35,000-gas budget
  (`REFERRER_GAS`). If the referrer reverts or runs out of gas, the share
  stays in the buffer as bid funding and the emitted `referrerShare` is 0. A
  failed referrer never blocks a contribution
- `tag` is a free-form, indexed 32-byte campaign marker (`bytes32(0)` if
  unused)
- `msg.value` must be positive, else `ZeroValue`

Every call emits:

```solidity
event Contribution(address indexed contributor, uint256 amount, address indexed referrer, bytes32 indexed tag, uint256 referrerShare);
```

## Bare sends

A plain ETH transfer to the adapter also works: `receive()` accepts from any
sender and emits `BareTopUp(sender, amount)`. The ETH joins the same buffer.
Use `contribute` instead whenever you want attribution; a bare send carries
none.

Never send directly to Patron: its `receive()` reverts `NotAdapter` for any
sender other than the adapter.

## How buffered ETH reaches the bid

Buffered ETH forwards to Patron through the permissionless `sweep()` (which
pays the caller a small keeper reward) and the swap-driven `streamForward()`,
under a two-mode meter keyed on Patron's balance against the adapter's
`activationThreshold`: below the threshold the buffer forwards without
cooldown, clamped to land the bid exactly at the threshold; at or above it,
forwards are capped at `maxSweepWei` per `minBlocksBetweenSweeps` blocks. So
a contribution is not instantly part of `bidBalance()`; it drips in at the
metered rate. Check the queue with `bufferedEth()` and the pacing with
`nextSweepBlock()`. Full mechanics on the
[LiveBidAdapter reference page](/docs/contracts/live-bid-adapter).

```bash
cast call {{addr:liveBidAdapter}} "bufferedEth()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## Integration pattern: launchpads and mints

The primary integration target is a "route X% of proceeds to Permanent
Collection" option on NFT launchpads, mint contracts, wallet widgets, and
treasury flows. The shape:

1. carve the chosen percentage out of the proceeds at your contract or
   backend
2. call `contribute(referrer, tag)` with that ETH. Set `referrer` to your
   platform address to earn the 5% share on every routed contribution, or
   `address(0)` to route 100% to the bid
3. pick a stable `tag` per campaign or collection so indexers can aggregate
   your flow from the `Contribution` event

Because the split is a hard-coded constant on an immutable contract, the 5%
referrer economics can never be changed out from under an integration, and
because the adapter has no withdrawal surface, routed funds can only ever
become live-bid funding.

## viem example

```ts
import {createPublicClient, createWalletClient, http, parseAbi, parseEther, stringToHex} from 'viem';
import {mainnet} from 'viem/chains';

const ADAPTER = '{{addr:liveBidAdapter}}';

const adapterAbi = parseAbi([
  'function contribute(address referrer, bytes32 tag) payable',
  'function bufferedEth() view returns (uint256)',
]);

const client = createPublicClient({chain: mainnet, transport: http()});
const wallet = createWalletClient({chain: mainnet, transport: http(), account});

// Attributed contribution: 5% to the referrer, 95% buffered for the bid.
// Use zeroAddress as referrer to buffer 100%.
await wallet.writeContract({
  address: ADAPTER,
  abi: adapterAbi,
  functionName: 'contribute',
  args: [
    '0xYourPlatformAddress',                    // referrer (or zeroAddress)
    stringToHex('my-mint-campaign', {size: 32}), // tag, bytes32(0) if unused
  ],
  value: parseEther('0.5'),
});

// ETH waiting in the buffer to be metered into the bid
const buffered = await client.readContract({
  address: ADAPTER, abi: adapterAbi, functionName: 'bufferedEth',
});
```

From a Solidity integration, the same call is:

```solidity
ILiveBidAdapter({{addr:liveBidAdapter}}).contribute{value: amount}(
    referrer,
    bytes32("my-mint-campaign")
);
```

Contract reference: [LiveBidAdapter](/docs/contracts/live-bid-adapter),
[Patron](/docs/contracts/patron).
