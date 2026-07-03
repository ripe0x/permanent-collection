---
title: Skim hook (ArtCoinsHookSkimFee)
description: The V4 hook on the official pool. Takes the 6% skim on swap volume, splits it three ways at swap time, and attests official-pool buys tax-exempt.
---

# Skim hook (ArtCoinsHookSkimFee)

`{{addr:hook}}` · [view on evm.now](https://evm.now/address/{{addr:hook}}?chainId=1)

The Uniswap V4 hook attached to the official $111/ETH pool (pool id
`{{addr:canonicalPoolId}}`). It takes the protocol's skim on every swap,
splits it three ways inside the same transaction, and attests official-pool
buys as exempt from [the $111 token's](/docs/contracts/the-111-token)
venue-scoped transfer tax.

The hook is launch infrastructure from the artcoins stack, so this page is
not an exhaustive per-function reference. It documents what an integrator
touching the pool needs: the fee taken, where it goes, and the two behaviors
(intra-swap flush, canonical-budget attestation) that affect routing and
accounting. The full ABI is served at
[`/abis/ArtCoinsHookSkimFee.json`](/abis/ArtCoinsHookSkimFee.json). The hook
can host other pools via `initializePoolOpen`; every number below is the
official pool's configuration, readable on-chain via `skimConfig(poolId)`.

## The 6% baseline skim

Every swap on the official pool pays a **6% skim on the ETH side of the swap
volume** (`baselineSkimBps = 6_000` in the hook's 100,000 denominator),
taken by the hook itself. This is separate from the pool's 0.5% LP fee
(`lpFee = 5_000` ppm), which flows to in-range liquidity positions per
standard V4 mechanics.

The skim splits into three legs at swap time:

| Leg | Share of baseline | Per 1 ETH of volume | Recipient |
| --- | --- | --- | --- |
| live bid | `bountyBps = 8_333` (~83.33%) | 0.0500 ETH | [LiveBidAdapter](/docs/contracts/live-bid-adapter), which meters it into [Patron](/docs/contracts/patron)'s live bid |
| protocol | remainder (~16.67%) | 0.0100 ETH | fee escrow, swept by [ProtocolFeePhaseAdapter](/docs/contracts/protocol-fee-phase-adapter) |
| referral | ≤ `maxReferralBpsOfVolume = 250` of volume | ≤ 0.0025 ETH | [ReferralPayout](/docs/contracts/referral-payout), per-referrer ledger |

The referral slice is **deducted from the protocol leg**, never from the
live-bid leg. It pays only when the swap carries valid attribution hookData
naming a referrer (see the
[swap-with-attribution guide](/docs/guides/swap-with-attribution)); with no
or invalid attribution the full protocol slice flows to the fee escrow. The
per-swap referral is clamped to
`min(requested referralBps, maxReferralBpsOfVolume)` of volume AND to the
available protocol slice. The cap launches at 250 (0.25% of volume, 100k
denominator) and is tunable within `[0, 1_000]` via
[TokenAdminPoker](/docs/contracts/token-admin-poker)'s
`setHookMaxReferralBps`, which forwards to the hook's
`setMaxReferralBpsOfVolume`; the hook's compiled ceiling is
`MAX_REFERRAL_CAP_OF_VOLUME = 1_000` (1% of volume), unreachable by any
admin.

## Intra-swap flush: the hook holds no balance

The split is computed in `beforeSwap` (exact-input swaps) or `afterSwap`
(exact-output swaps). At the end of `afterSwap` of the **same swap**, the
hook burns its ERC-6909 claim tokens, takes native ETH from the pool
manager, and forwards every leg to its recipient:

- the live-bid leg forwards to LiveBidAdapter; a failed forward reverts the
  whole swap (`BidForwardFailed`)
- the protocol leg deposits into the launch stack's fee escrow under
  ProtocolFeePhaseAdapter's balance, pulled later via its `sweep()`
- the referral leg pays `ReferralPayout.notify(referrer)` under a gas cap; a
  failed payout folds the slice into the protocol leg instead
  (`ReferralFoldedToProtocol`), and the swap proceeds

There is no held or retried balance: between swaps the hook's claim balance
is zero, so nothing accrues on the hook itself and there is nothing for a
keeper to flush.

## Anti-sniper window (expired)

For the first 30 minutes after pool initialization, the MEV module
(`ArtCoinsMevLinearSkim` at
[`{{addr:mevModule}}`](https://evm.now/address/{{addr:mevModule}}?chainId=1))
reported an elevated skim that decayed linearly from 90% down to the 6%
baseline (roughly 2.8 percentage points per minute). The overage above
baseline (`antiSniperExtra` in the hook's accounting) routed **100% to the
live-bid leg**; the baseline portion split as in the table above.

That window has expired and the module has self-disabled. The pool runs the
static 6% baseline; `currentSniperExtraFeePpm(poolId)` returns 0.

## Canonical-budget attestation (tax exemption)

The $111 token charges a venue-scoped, buy-side transfer tax on $111 leaving
a known trading venue. Buys on the **official pool are exempt**, and this
hook is what makes them exempt: in `afterSwap` (buys) and
`afterRemoveLiquidity` (public LP exits) it attests the realized $111 output
into an amount-pinned, transient (EIP-1153) exemption budget on the token
(`attestCanonicalBudget`). The token accepts the attestation only from this
hook and only for the official pool id, so no side pool can earn a budget.
The budget clears at the end of the transaction. Details on the tax itself:
[the $111 token](/docs/contracts/the-111-token).

For routers and aggregators: official-pool buys realize the full quote; only
side-pool routes see the token's buy-side tax.

## Reading the config

```bash
cast call {{addr:hook}} \
  "skimConfig(bytes32)(uint24,uint16,uint24,uint24,address,address,address,address)" \
  {{addr:canonicalPoolId}} \
  --rpc-url https://ethereum-rpc.publicnode.com
```

Returns `(baselineSkimBps, bountyBps, maxReferralBpsOfVolume, lpFee,
bountyRecipient, protocolRecipient, referralPayout, quoteToken)`. On the
official pool: `bountyRecipient` is LiveBidAdapter, `protocolRecipient` is
ProtocolFeePhaseAdapter, `referralPayout` is ReferralPayout, and `quoteToken`
is `address(0)` (the pool is native-ETH paired).

## Events an indexer should watch

| Event | Fired |
| --- | --- |
| `SkimSplit(poolId, quoteVolume, bountyAmount, protocolNet, referralPaid)` | once per swap, with the swap's ETH volume and the realized split |
| `SwapAttribution(poolId, swapper, referrer, sourceId, campaignId, quoteVolume, referralPaid)` | when the swap carried valid attribution hookData |
| `LegForwarded(poolId, leg, recipient, amount)` | per leg forwarded in the intra-swap flush |
| `ReferralForwarded(poolId, referrer, amount)` | referral slice credited to ReferralPayout |
| `ReferralFoldedToProtocol(poolId, referrer, amount)` | referral payout failed; slice folded into the protocol leg |
| `MaxReferralBpsUpdated(poolId, newCap)` | referral cap retuned via TokenAdminPoker |

The protocol's own indexer consumes `SkimSplit` for its lifetime swap-volume
counters; see [the indexer page](/docs/offchain/indexer).
