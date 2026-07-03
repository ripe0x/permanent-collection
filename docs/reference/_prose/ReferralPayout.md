---
contract: ReferralPayout
slug: referral-payout
deploymentsKey: referralPayout
title: ReferralPayout
---

# summary

Pull-based per-referrer ETH ledger for swap referrals on the official pool.
When a swap carries valid attribution hookData (a `PCAttribution` with a
non-zero `referrer`), the artcoins skim hook computes the referral slice,
clamped to at most `min(referralBps, maxReferralBpsOfVolume)` of swap volume
(0.25% at the launch cap of 250, on a 100k denominator) and to the swap's
protocol slice, and forwards it here in the same transaction via
`notify(referrer)`. The contract increments `balances[referrer]` and emits
`ReferralCredited`. Referrers pull their accumulated balance with `claim()`;
anyone can trigger a payout to a referrer with `claimFor(referrer)`.

The contract holds nothing but claimable ETH and the ledger. There is no
admin, no setter, no third-party withdrawal path. The only credit path is
`notify` from the immutable `hook` address; ETH sent directly to `receive()`
is accepted but never credited to any referrer and can never be claimed.

# concepts

### Where credits come from

The referral slice is deducted from the protocol leg of the hook's 6%
baseline skim, never from the live-bid leg. It pays from the first swap:
any swap whose hookData decodes to a valid `PCAttribution` with a non-zero
`referrer` produces a `notify` call within that swap's `_afterSwap` flush.
Per-swap context (sourceId, campaignId, volume) is emitted by the hook's
own attribution events at swap time; this contract's events are pure
balance bookkeeping. See the composability docs for the `PCAttribution`
hookData schema and how to encode it from a frontend.

The path is fail-closed in both directions: a swap with no or invalid
attribution folds the slice back into the protocol leg, and if the in-swap
`notify` call ever fails the hook folds the slice to the protocol escrow
rather than reverting the swap.

### The 35k-gas send budget

`claim` and `claimFor` send with a fixed `CLAIM_GAS` budget of 35,000 gas,
enough for most contract receivers (Safes, splitters) while capping what a
pathological recipient can burn. If the send reverts or runs out of gas the
balance is reinstated in full and the call reverts `TransferFailed`, so a
failed claim loses nothing; the referrer can fix their receive handler and
claim again later. A referrer address that permanently reverts on receive
simply accumulates a balance it can never move, since the only outflow for
a credited balance is the send to the referrer address itself.

### Reading and claiming with viem

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";
import { abi } from "@/lib/abis/ReferralPayout";

const referralPayout = "{{addr:referralPayout}}" as const;
const client = createPublicClient({
  chain: mainnet,
  transport: http("https://ethereum-rpc.publicnode.com"),
});

// Read a referrer's claimable balance (wei)
const balance = await client.readContract({
  address: referralPayout,
  abi,
  functionName: "balances",
  args: ["0xYourReferrerAddress"],
});

// Claim it (from the referrer's own account)
const wallet = createWalletClient({
  chain: mainnet,
  transport: http("https://ethereum-rpc.publicnode.com"),
  account, // the referrer
});
if (balance > 0n) {
  await wallet.writeContract({
    address: referralPayout,
    abi,
    functionName: "claim",
  });
}

// Or push someone else's balance to them from any account
await wallet.writeContract({
  address: referralPayout,
  abi,
  functionName: "claimFor",
  args: ["0xSomeReferrerAddress"],
});
```

Or from the command line:

```bash
cast call {{addr:referralPayout}} "balances(address)(uint256)" 0xYourReferrerAddress \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function claim

access: permissionless

Pays out `balances[msg.sender]` to `msg.sender`. Zeroes the balance, then
sends the full amount with a 35,000-gas budget. Reverts `NothingToClaim` if
the caller's balance is zero. If the send fails (recipient reverts or
exceeds the gas budget) the balance is reinstated and the call reverts
`TransferFailed`, so state is unchanged and the claim can be retried. Emits
`ReferralClaimed` on success.

## function claimFor

access: permissionless

Same payout path as `claim`, but for an arbitrary `referrer`: the ETH
always goes to the referrer address, never to the caller. Useful for
keepers, frontends that sweep house balances, or pushing funds to a
referrer that can't easily initiate transactions. Reverts `NothingToClaim`
for a zero balance and `TransferFailed` (balance reinstated) on a failed
send.

## function notify

access: hook-only (the immutable `hook` address set at construction; every other caller reverts `Unauthorized`)

The single credit path. The skim hook calls this with the swap's referral
slice attached as `msg.value` during the same swap's flush. Credits
`balances[referrer] += msg.value` and emits `ReferralCredited`. A zero
`referrer` or zero `msg.value` is a silent no-op (returns without crediting,
so any attached ETH on the zero-referrer branch would remain in the contract
uncredited). Integrators never call this; they attach attribution hookData
to swaps and the hook does the rest.

## receive

access: permissionless

Stray-ETH catcher. Anyone can send ETH here directly; it increases the
contract's balance but is not credited to any referrer and cannot be
claimed. Intentional: the hook's `notify` is the only authoritative source
of credits, so accidental sends can't be mis-attributed. Don't send ETH
here, it's unrecoverable.

## function CLAIM_GAS

Gas budget for the per-claim send, a constant `35_000`. Generous enough for
most contract receivers, capped so a malicious recipient can't burn
unbounded gas in `claim`/`claimFor`.

## function balances

Claimable ETH (wei) per referrer address. Increases on each hook `notify`
credit, zeroes on a successful `claim`/`claimFor`, reinstated on a failed
one. This is the number to surface in a referrer dashboard.

## function hook

The immutable artcoins skim hook address authorized to call `notify`. Set
at construction, never changes.

## event ReferralClaimed

Emitted on every successful `claim`/`claimFor` with the referrer (indexed)
and the amount paid out. An indexer can pair `ReferralCredited` minus
`ReferralClaimed` totals per referrer to reconstruct the live claimable
balance without a contract read.

## event ReferralCredited

Emitted on every hook `notify` credit with the referrer (indexed) and the
amount added to their balance. One event per attributed swap. For per-swap
context (sourceId, campaignId, volume), join against the hook's attribution
events from the same transaction.

## error NothingToClaim

`claim`/`claimFor` was called for a referrer with a zero balance. Check
`balances(referrer)` before claiming.

## error TransferFailed

The payout send to the referrer reverted or exceeded the 35,000-gas budget.
The balance was reinstated in full; fix the recipient's receive handler and
retry.

## error Unauthorized

`notify` was called by an address other than the bound `hook`. Only the
hook can credit balances.

## error ZeroAddress

Constructor-only: raised when the contract is deployed with a zero hook
address. Never reachable on the live deployment.
