# Permanent Collection — Composability Architecture

**Status:** Locked architecture as of 2026-05-25. This document is the reference for
builders who want to integrate with, route swaps through, or extend the
Permanent Collection protocol.

---

## TL;DR

Permanent Collection's V4 pool is a composable host surface for third-party
builders. There are three building blocks:

1. **Attribution via hookData** — every swap can carry a `(sourceId, referrer,
   campaignId, referralBps)` payload. The official hook emits a
   `SwapAttribution` event for it. Indexers, dashboards, and frontends key
   off this event for organic builder analytics. Permissionless and live
   from day one.
2. **Referral payments from the protocol share** — a small referral fee
   (capped at **0.25% of swap volume**) can flow to a referrer on every
   attributed swap. The payment comes exclusively from the **~16.67% protocol
   slice** of the 6% baseline hook skim. Trait-bid funding (~83.33% of skim)
   is **structurally invariant** — no referral can ever reduce it.
   Permissionless attribution; payouts pulled via `ReferralPayout.claim`.
3. **Synchronous extensions via `PCDispatcher` (Design B)** — a
   permissionless callback dispatcher built and adversarially tested
   pre-launch. **Verified-ready but not bound at launch.** When PC
   eventually binds it via `TokenAdminPoker.bindExtension`, any builder
   can claim one of the bounded slots by paying a fee (which goes to
   Patron — registering grows the live bid). Misbehaving callbacks
   auto-disabled by an on-chain failure counter; anyone re-enables for
   a small fee. No admin, no governance, all economic parameters
   immutable. Builders implement `IPCCallbackExtension.onSwap(...)` and
   run under per-slot gas budgets + try/catch isolation, with reentrancy
   guards on every PC contract via `PCSwapContext`. Spec:
   [DISPATCHER_DESIGN.md](./DISPATCHER_DESIGN.md).

Beyond swap referrals, there are two more permissionless attribution
surfaces that pay independently of the hook path:

- **Auction referral** — `ReturnAuctionModule.placeBidWithReferral(punkId, referrer, tag)`
  routes 5% of the rescue premium to the winning bidder's referrer.
  Fresh external value; never reduces bounty or burn slices.
- **Contribution referral** — `Patron.contribute(referrer, tag)` accepts a
  direct ETH top-up to the live bid and routes 5% to the referrer.
  Designed for NFT launchpads that want a "route X% of mint to
  Permanent Collection" checkbox.

That's three independent attribution surfaces (swap, auction, contribution)
with three independent payment paths. Each one is fail-closed, hard-coded,
and has no admin tunability beyond the swap-path cap.

Bottom line: build attribution + analytics today, prepare your callback
for the day the dispatcher is bound. The architecture preserves both
paths permanently.

---

## The three-leg fee split

Every swap takes a **6% baseline skim** (hundred-thousandths denom; PC's
launch value is `6_000 = 6%`). The hook splits this skim into three legs at
swap time:

```
1 ETH swap (steady state)
  ├─ 0.06 ETH baseline skim taken by hook
  │   ├─ 0.0500 ETH (~83.33%) → LiveBidAdapter      ← live-bid leg
  │   ├─ 0.0100 ETH (~16.67%) split:
  │   │     ├─ ≤ 0.0025 ETH → ReferralPayout (if attributed swap)
  │   │     └─ remainder → ProtocolFeePhaseAdapter ← protocol leg
  ├─ 0.94 ETH continues into swap math
  │   └─ 0.0047 ETH LP fee (0.5%) → in-range LP positions
  └─ Trader receives 111 worth ~0.9353 ETH (~6.47% effective cost)
```

`VaultBurnPool` (111-burn fuel accumulator) is **not fed by trading
fees**. Its only inflow is the cleared-auction proceeds split in
`ReturnAuctionModule.settle`: `(highBid − cost) + 10% × cost` per
successful rescue. The pool sweeps to `BuybackBurner` only on a
vault-path settle, so the 111 burn impulse fires on vault outcomes,
not on every swap.

### The structural invariant

```
For every swap S:
    bountyInflow(S)     == volume(S) × 6% × 83.33% + antiSniperExtra(S)
    protocolInflow(S) + referralPaid(S) == volume(S) × 6% × 16.67%
    referralPaid(S)     <= min(volume(S) × hookData.referralBps / 100_000,
                                volume(S) × maxReferralBpsOfVolume / 100_000)
    maxReferralBpsOfVolume <= MAX_REFERRAL_CAP_OF_VOLUME == 1_000   // hard ceiling, locked forever
    referralPaid(S)     == 0  if no valid referrer is attributed on S
```

Note: `maxReferralBpsOfVolume` is the **live** per-pool cap (250 at
launch; admin-tunable within `[0, 1_000]` via
`TokenAdminPoker.setHookMaxReferralBps` — see "Configurable" section
below). The 1% `MAX_REFERRAL_CAP_OF_VOLUME` is the hook's hardcoded
ceiling and is the only number locked forever.

The live-bid leg (`bountyInflow` — name follows the deployed ABI) is
computed against gross volume. Referrals come exclusively from the
protocol slice and are clamped to its available balance. **A referral
payment cannot reduce live-bid funding.**

### Referral is live from the first swap

The referral leg is enabled from block 1. The hook routes the slice to the
attributed referrer (within the cap) on any swap that carries a valid
referrer; there is no acquisition-count gate. When a swap carries no/invalid
referrer, the slice clamps to zero and the entire protocol slice flows
through `ProtocolFeePhaseAdapter` as usual.

The path is fail-closed: a reverting/OOG `ReferralPayout` recipient folds the
slice back to the protocol escrow, and the swap never reverts on referral
failure.

---

## Venue-scoped buy-side transfer tax (integrators read this)

Separately from the hook skim, the **111 token itself** charges a
venue-scoped, buy-side transfer tax. It is the one place 111 behaves as a
fee-on-transfer token — and it does so ONLY in the DEX-buy context:

- **Taxed:** 111 *leaving* a known trading venue to a non-exempt recipient — a
  buy or pool outflow on a **side** pool (any V4 pool that isn't the canonical
  one, or a precomputed Uniswap V2 / SushiSwap V2 / Uniswap V3 111 pool). The
  recipient receives `amount - tax`; the tax (15% at launch) accrues in `VaultBurnPool` and is burned (`token.burn`) on each vault-path settle.
- **NOT taxed:** buying on the **canonical** pool (hook-attested exemption);
  selling on any pool (111 *into* a pool — taxing this would revert the swap);
  wallet-to-wallet / Safe / ERC-4337 sends; lending deposits/withdrawals;
  bridges; CEX hot-wallet transfers. In all of these the sender is not a venue,
  so 111 is a clean ERC20.

Integration implications:
- **Aggregators / routers (0x, 1inch, UR):** treat 111 as a `buyTax = 15%` token
  (the launch rate) for side-pool routes; canonical-pool buys realize the full
  quote. A split route is handled correctly: the canonical leg is exempt
  (amount-pinned hook budget), only the side leg is skimmed.
- **Two `Transfer` logs per taxed transfer** (net to recipient + skim to
  `VaultBurnPool`, the tax `burnAddress`) plus a `TaxApplied(from, to, gross, tax, net)` event. Allowance debit
  on `transferFrom` totals the full `gross` (matches what the user signed).
- **The rate is bounded `[0, 20%]`** and launches at 15%. It can be tuned
  within that band via the two-key `TokenAdminPoker.setTokenTaxBps` carve-out.
- The tax does NOT affect the hook's four-leg ETH skim, the referral path, or
  Design B callbacks — it's an independent, token-level mechanism. Full design:
  `docs/TRANSFER_TAX_INVESTIGATION.md`.

---

## hookData schema

Every swap on the official pool can carry an attribution payload. The
artcoins parent hook decodes the swap's `hookData` as a `PoolSwapData`
envelope; PC's `poolExtensionSwapData` slot then carries:

```solidity
struct PCSwapData {
    PCAttribution attribution;  // consumed by the hook for routing
    bytes extensionPayload;      // forwarded to a bound extension (Design B)
}

struct PCAttribution {
    bytes32 sourceId;     // builder-chosen identifier (campaign, frontend)
    address referrer;     // address credited with referral (0 = no payment)
    bytes16 campaignId;   // optional sub-attribution under a sourceId
    uint24  referralBps;  // requested referral, in 100k denom; clamped
}
```

### Constructing hookData from a frontend (TypeScript / viem)

```ts
import { encodeAbiParameters } from "viem";

const attribution = {
  sourceId:  "0x" + Buffer.from("my-frontend-v1").toString("hex").padEnd(64, "0"),
  referrer:  "0xBuilderPayoutAddress",
  campaignId: "0x" + "00".repeat(16),
  referralBps: 250n, // 0.25% of volume
};

// Inner: PCSwapData
const pcSwapData = encodeAbiParameters(
  [
    {
      type: "tuple",
      components: [
        { name: "sourceId", type: "bytes32" },
        { name: "referrer", type: "address" },
        { name: "campaignId", type: "bytes16" },
        { name: "referralBps", type: "uint24" },
      ],
    },
    { type: "bytes" },
  ],
  [attribution, "0x"],
);

// Outer: PoolSwapData (artcoins envelope)
const poolSwapData = encodeAbiParameters(
  [
    { type: "bytes", name: "mevModuleSwapData" },
    { type: "bytes", name: "poolExtensionSwapData" },
  ],
  ["0x", pcSwapData],
);

// Pass `poolSwapData` as the swap's `hookData` to PoolManager.swap.
```

### Decode failure tolerance

If the encoding is malformed at any layer, the hook treats the swap as
having no attribution. The swap itself **never** reverts on bad hookData.

---

## Events emitted per swap

```solidity
// Always emitted when a non-zero skim is taken
event SkimSplit(
    PoolId indexed poolId,
    uint256 quoteVolume,
    uint256 bountyAmount,
    uint256 vaultBurnAmount,
    uint256 protocolNet,
    uint256 referralPaid
);

// Emitted when the swap carried valid attribution data
event SwapAttribution(
    PoolId  indexed poolId,
    address indexed swapper,
    address indexed referrer,
    bytes32 sourceId,
    bytes16 campaignId,
    uint256 quoteVolume,
    uint256 referralPaid
);

// Emitted when the requested referral exceeded what the protocol slice could fund
event ReferralUnderpaid(
    PoolId  indexed poolId,
    address indexed referrer,
    uint256 requested,
    uint256 paid
);

// Per-leg forward events (intra-tx flush — fires at end of _afterSwap of the same swap)
event LegForwarded     (PoolId indexed poolId, uint8 indexed leg, address recipient, uint256 amount);
event LegForwardFailed (PoolId indexed poolId, uint8 indexed leg, address recipient, uint256 amount);

// Referral payout flush events
event ReferralForwarded     (PoolId indexed poolId, address indexed referrer, uint256 amount);
event ReferralForwardFailed (PoolId indexed poolId, address indexed referrer, uint256 amount);
```

---

## Claiming referral payments

Referrers (or anyone on their behalf) pull accumulated balances from
`ReferralPayout`:

```solidity
referralPayout.claim();               // claim caller's balance
referralPayout.claimFor(referrer);    // claim someone else's balance to them
```

The hook flushes the credited referrer's accrual **within each swap's
own tx** (end of `_afterSwap`). The referrer's balance appears in
`ReferralPayout` immediately, ready to claim:

```solidity
referralPayout.claim();   // moves balance → referrer's wallet
```

There are no escape hatches and no held state. The flush is fresh-only:
if the in-swap `ReferralPayout.notify` ever fails (it is gas-capped, and a
pull ledger has no reason to revert), the referral amount folds into the
protocol fee escrow rather than being held for retry. So a referrer's
credit either lands in `ReferralPayout` immediately (claimable as above)
or, on a payout failure, becomes protocol revenue. Nothing accrues or
waits in the hook between swaps.

---

## Auction referral

The return auction has its own referral surface. Bid through
`ReturnAuctionModule.placeBidWithReferral` to pass a referrer and a free-form
tag; if your bid wins the auction, your referrer gets a slice of the rescue
premium. Bidders who don't carry a referrer use the simpler `placeBid`.

```solidity
// No referral — the common path.
function placeBid(uint16 punkId) external payable nonReentrant notInSwap;

// With referral attribution.
function placeBidWithReferral(uint16 punkId, address referrer, bytes32 tag)
    external payable nonReentrant notInSwap;
```

### Frontend integration

You don't sign anything new. The referrer + tag are just call args on
the existing bid path. A frontend that wants its house referral credited
sets them at submit time:

```ts
const tx = await returnAuction.write.placeBidWithReferral(
  [punkId, REFERRER_ADDRESS, TAG],
  { value: bidAmount },
);
```

Pass `referrer = address(0)` and `tag = bytes32(0)` if you don't want
attribution; the bid still works, no slice is carved off the premium.

### Economics

The auction's cleared-path settle is now a four-way split. Let `cost`
= the original acquisition price and `highBid` = the winning bid:

```
premium        = highBid - cost
liveBidShare      = cost × 65%                              → Patron (live bid)
vaultBurnFromCost = cost × 10%                              → VaultBurnPool
burnShare         = cost − liveBidShare − vaultBurnFromCost → BuybackBurner (25%)
referrerShare     = premium × 5%  (only if referrer != 0)   → referrer (fail-closed)
vaultBurnShare    = (premium − referrerShare) + vaultBurnFromCost → VaultBurnPool
```

The referrer slice is **5% of the premium**, hard-coded as
`REFERRER_PREMIUM_BPS = 500`. There's no setter, no admin tunability.

Two properties matter for builders:

- **Auction referral comes from fresh external value.** The premium is
  what the rescuer voluntarily overpaid above the protocol's original
  acquisition cost. Carving a referrer slice from it never reduces the
  bounty (70% of cost → Patron) or the burn (30% of cost → Burner). Those
  legs are structurally invariant on this path the same way they are on
  the swap path.
- **The vault-burn pool absorbs anything the referrer doesn't take.** No
  referrer or a reverting referrer means `referrerShare = 0` and the
  full premium goes to the vault-burn pool. Funds don't get stuck and
  the settle never reverts.

### Storage overwrite semantics

There's only ONE referrer slot per Punk:

```solidity
mapping(uint16 => address) public referrerOfHighBid;
```

Every accepted bid overwrites it. If Alice bids with referrer A and
Bob outbids her with referrer B, Alice's referrer A loses attribution
permanently — only B is on the hook when the auction clears. This is
intentional: the slot tracks the CURRENT high bidder's referrer, not
a history. Build your indexer to mirror this — don't try to track
"referrers who briefly held the top bid."

A bid placed without a referrer (`address(0)`) also overwrites the slot,
so if Alice bids with referrer A and Bob outbids her with no referrer,
A loses attribution and the cleared-path settle pays no referrer at all.

### Fail-closed behaviour

The settle path uses a 35k-gas budget (`REFERRER_GAS = 35_000`) on the
outgoing send to the referrer. If the call reverts, OOGs, or just
returns false:

- `referrerShare` resets to `0` BEFORE the vault-burn pool transfer.
- The full premium goes to the vault-burn pool.
- `settle` does NOT revert. The Punk still gets delivered to the buyer
  and the bounty/burn slices still pay out normally.

A reverting referrer just means the referrer loses their slice for that
auction. Build your referrer address as an EOA or as a contract with a
cheap `receive()` — anything heavier than ~35k gas will fail closed.

Vault-path (silenced) settles do NOT pay any auction referrer. There's
no premium when nobody bids, so there's nothing to split.

### Event consumption

```solidity
// Emitted on every accepted bid.
// referrer is indexed so you can filter for "all bids with my referrer".
event BidPlaced(
    uint16  indexed punkId,
    address indexed bidder,
    address indexed referrer,
    uint256 amount,
    bytes32 tag,
    uint64  endsAt
);

// Emitted on the cleared-path settle (rescue). Extended with referrer + referrerShare.
event ReturnAuctionCleared(
    uint16  indexed punkId,
    address indexed buyer,
    address indexed referrer,
    uint256 highBidWei,
    uint256 liveBidShare,
    uint256 burnShare,
    uint256 vaultBurnShare,
    uint256 referrerShare
);
```

Indexer pattern: listen for `BidPlaced` to track which bid ATTEMPTED a
referral, listen for `ReturnAuctionCleared` to confirm which referrer
actually got paid (and how much). Outbid bids show up in `BidPlaced`
but not in any cleared event — that's the storage-overwrite semantic
surfaced as event flow.

---

## Contribution referral

This is the headline integration surface for builders outside the swap
path. `Patron.contribute` is the canonical on-chain destination for
capital flows that want to align with Punks preservation.

```solidity
function contribute(address referrer, bytes32 tag)
    external payable nonReentrant notInSwap;
```

### Primary use case: NFT launchpads

Manifold-style launchpads, mint pages, and creator-tool platforms can
add a "Route X% of mint proceeds to Permanent Collection" checkbox.
When the user opts in, the launchpad calls `Patron.contribute` with the
launchpad's address as `referrer` and a campaign identifier in `tag`.
The launchpad earns 5% of the routed amount; Permanent Collection's
live bid grows by 95%; the user gets a fully-aligned "this mint funded
Punk preservation" badge.

The Schelling-point framing is the point. If you're building anywhere
in the NFT-mint or creator-tool space and you want to surface a
"route to public goods" option, this is the canonical destination
that's verifiable on-chain, has no admin, and won't change.

### Secondary use cases

- **Wallet widgets** — "Round up your swap to the nearest 0.01 ETH and
  contribute the dust." Wallet pays the referrer (itself); user sees
  the contribution land on Patron's live bid.
- **DAO treasuries** — quarterly disbursements to PC's live bid with a
  governance-decided tag tracking the proposal id.
- **Public-goods aggregators** — Gitcoin-style apps that route a
  percentage of donations to PC alongside their other beneficiaries.

### Economics

```solidity
uint256 constant REFERRER_CONTRIB_BPS = 500;  // 5%, hard-coded
uint256 constant REFERRER_GAS         = 35_000;
```

- `msg.value == 0` reverts `ZeroValue()`. The function is for routing
  ETH; a no-value call has no economic effect.
- `referrer != address(0)` carves `msg.value × 5%` and sends it with a
  35k-gas budget. The remainder stays in Patron and grows the live bid.
- `referrer == address(0)` skips the carve entirely. 100% of `msg.value`
  becomes live bid.

### Fail-closed semantics

If the referrer send fails (revert, OOG, returns false), `referrerShare`
is reset to `0` and the call continues. The referrer's slice stays in
Patron as live bid. Because the send didn't actually move ETH, resetting
`referrerShare = 0` is just accurate accounting; nothing's lost.

Practical implication: if you're integrating with a contract referrer,
keep its `receive()` cheap. Anything that can't return inside 35k gas
silently forfeits the referral.

### Event consumption

```solidity
// Emitted on contribute() — the attributed path.
// All three of contributor/referrer/tag are indexed so you can build
// a dashboard keyed off any one of them.
event Contribution(
    address indexed contributor,
    uint256 amount,
    address indexed referrer,
    bytes32 indexed tag,
    uint256 referrerShare
);

// Emitted in Patron.receive() — the unattributed path.
// Replaces the old BidToppedUp event.
event BareTopUp(address indexed sender, uint256 amount);
```

If you want clean indexing of "all ETH that flowed into the live bid
via builder integrations," watch `Contribution`. If you want to also
catch direct sends from EOAs, settlement returns from other PC
contracts, and any other unattributed inflow, watch `BareTopUp` as well.

### Tag semantics

`tag` is a free-form `bytes32`. Use it for campaign identifiers, UTM
markers, A/B test buckets, mint-batch ids — anything you want to slice
your contributions by in an indexer. The contract treats it as opaque;
all it does is index it on the `Contribution` event.

Suggested conventions:
- ASCII-encoded campaign name (e.g. `bytes32("manifold-q4-2026")`).
- Keccak256 of a longer identifier if you need uniqueness guarantees.
- `bytes32(0)` for no campaign — totally fine.

---

## Wash-trading and griefing analysis

**Wash trading is loss-making by construction.** A 0.25% referral payback
against a 6% per-swap skim cost means a round-trip wash trade pays ~13%
in skim + LP fees against ~0.5% in referral earnings — net loss of ~12.5%
per cycle. The attack pays into the protocol.

**Per-recipient gas grief is bounded.** Forward calls to `ReferralPayout`
and to the referrer's address are gas-capped at 35k. A malicious recipient
contract can refuse ETH; the payment falls into a held slot and is
retryable indefinitely without ever blocking swaps.

**Self-referral is allowed and intentional.** Frontends that route their
own users' swaps are exactly the use case being subsidized. The cap +
the wash-trading economics keep this from being exploitable.

---

## Design B — synchronous extensions via `PCDispatcher`

The hook has a single pool-extension slot inherited from the artcoins
parent. At launch the slot is **unbound and unlocked**:

```solidity
hook.poolExtension(poolKey.toId())          == address(0)
hook.poolExtensionLocked(poolKey.toId())    == false
```

`PCDispatcher` is the production
permissionless platform built to occupy that slot when PC decides. The
contract is **verified-ready** — built and adversarially tested
pre-launch — but **not yet bound or deployed**. Binding is a deliberate
post-launch action via `TokenAdminPoker.bindExtension`.

Spec, threat model, gas analysis, and full test-coverage map:
[DISPATCHER_DESIGN.md](./DISPATCHER_DESIGN.md).

### The dispatcher mechanic in one paragraph

Bounded number of slots (the deploy-time `MAX_CALLBACKS`, in `[4, 32]`).
Any builder can claim a slot by paying `register(callback, gasBudget)`
with `msg.value ≥ gasBudget × FEE_PER_GAS_UNIT`. The full fee is
forwarded directly to `Patron` (it grows the live bid). If all slots are
full, the new registrant must outbid the lowest-fee slot by an
`EVICTION_PREMIUM_BPS` premium (default 1.5×); the displaced callback
is evicted with no refund. During every swap, the dispatcher iterates
all enabled slots inside a try/catch, calling each callback under its
per-slot gas budget. Failing callbacks (revert / OOG) increment a
counter; reaching `FAILURE_THRESHOLD` (default 50) auto-disables the
slot. Anyone can `reenable(slotIdx)` a disabled slot by paying
`REENABLE_FEE` (also to Patron). **No admin, no owner, no setters.** All
economic parameters are immutable constructor arguments with hard bounds.

### Reentrancy infrastructure — `PCSwapContext`

PC contracts decorated with the `notInSwap` modifier read a shared
transient-storage flag exposed by `PCSwapContext`. At launch the flag is
permanently false (no extension authorized). When `PCDispatcher` is
later bound and authorized, it flips the flag for the duration of the
callback loop; PC contracts revert if a callback tries to reach into
them.

```solidity
modifier notInSwap() {
    if (address(swapContext) != address(0) && swapContext.inSwap()) revert InSwap();
    _;
}
```

Decorated entry points (7 contracts):

| Contract | Functions |
|---|---|
| `Patron` | `acceptBid`, `acceptListing` |
| `ReturnAuctionModule` | `placeBid`, `placeBidWithReferral`, `settle`, `withdrawRefund` |
| `BuybackBurner` | `executeStep` |
| `LiveBidAdapter` | `contribute`, `poolReplenish`, `sweep`, `streamForward` |
| `ProtocolFeePhaseAdapter` | `sweep` |
| `VaultBurnPool` | `sweep` |
| `ProtocolFeePhaseAdapter` | `sweep` |
| `PunkVaultTitleAuction` | `bid`, `settle`, `withdrawProceeds`, `withdrawRefund` |

The cost: one TLOAD + comparison (~100 gas) per call. Inert at launch.

### Callback interface

Builders implement
[`IPCCallbackExtension`](../contracts/src/interfaces/IPCCallbackExtension.sol):

```solidity
interface IPCCallbackExtension {
    /// Pure side-effect callback. MUST NOT call any PC contract.
    /// MUST complete within the dispatcher's per-slot gas budget.
    function onSwap(
        PoolKey calldata poolKey,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata attribution  // raw poolExtensionSwapData bytes
    ) external returns (bytes32 result);
}
```

Callbacks are isolated by:
- **Try/catch wrapper** — extension reverts don't break swaps or other callbacks.
- **Per-slot gas budget** — enforced by the dispatcher (`gas: budget` on the call).
- **No fund custody** — callbacks never receive ETH; the dispatcher holds none either (registration fees pass-through to Patron).
- **No reentry path** — `notInSwap` modifier on every reachable PC contract.
- **Failure counter** — persistent reverts auto-disable the slot at `FAILURE_THRESHOLD`.

### Builder guide — writing a callback

A minimal callback that mints an NFT for every attributed swap:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPCCallbackExtension} from "permanent-collection/src/interfaces/IPCCallbackExtension.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

// PC's attribution payload is forwarded as the `attribution` bytes.
// Decode if you care about the referrer / sourceId; defaults are safe.
struct PCSwapData {
    PCAttribution attribution;
    bytes extensionPayload;
}
struct PCAttribution {
    bytes32 sourceId;
    address referrer;
    bytes16 campaignId;
    uint24  referralBps;
}

contract MyMinter is IPCCallbackExtension {
    address public immutable dispatcher;
    // ... your NFT state ...

    constructor(address _dispatcher) { dispatcher = _dispatcher; }

    function onSwap(
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata attribution
    ) external returns (bytes32) {
        // Only honor calls from the dispatcher (defense in depth — the
        // dispatcher is the only caller, but this guards against anyone
        // calling the callback directly).
        require(msg.sender == dispatcher, "not dispatcher");

        // Defensive decode — `attribution` can be empty or malformed.
        if (attribution.length == 0) return bytes32(0);
        // ... abi.decode in a try/catch pattern if you need the struct ...

        // Do your thing — mint an NFT, update a counter, emit an event.
        // Constraints:
        //   - Stay within your registered gas budget (default suggested 100k).
        //   - Don't call any PC contract — Patron/ReturnAuctionModule/etc revert
        //     `PCNoReentry.InSwap` while the dispatcher is iterating.
        //   - Don't expect to receive ETH from the dispatcher.

        return bytes32(uint256(1)); // opaque "we did something" indicator
    }
}
```

To register your callback once the dispatcher is bound:

```solidity
PCDispatcher d = PCDispatcher(DISPATCHER_ADDRESS);

// What fee do you need to bid?
(uint256 idx, uint128 lowFee, bool isEmpty) = d.findLowestFeeSlot();
uint256 fee = isEmpty
    ? uint256(uint32(20_000)) * d.FEE_PER_GAS_UNIT()         // min fee for your gas budget
    : d.requiredOutbid();                                    // 1.5× the lowest occupant

d.register{value: fee}(address(myCallback), 20_000);         // 20k gas budget
```

To re-enable your slot after it gets auto-disabled (e.g. an upstream
dependency went down and you've now fixed the callback):

```solidity
d.reenable{value: d.REENABLE_FEE()}(myCallbackSlotIdx);     // 0.001 ETH default
```

### What a callback CANNOT do

| Attempt | Outcome |
|---|---|
| Call `Patron.acceptBid` / `acceptListing` / etc. | Reverts `PCNoReentry.InSwap`; caught by dispatcher; failure counter +1 |
| Call `pcSwapContext.exitSwap()` to disarm the guard | Reverts `NotAuthorizedExtension` (the dispatcher is the authorized extension, not the callback) |
| Call `dispatcher.afterSwap(...)` recursively | Reverts `OnlyHook` |
| Call `dispatcher.register(...)` to add more slots | Reverts `PCNoReentry.InSwap` — register/reenable are themselves decorated |
| Selfdestruct | Solidity 0.8.x's `extcodesize` check causes subsequent calls to revert → failure counter +1 → eventually auto-disabled |
| Consume entire gas budget without reverting | Allowed. You paid for it. The dispatcher continues to the next slot. |

### What the dispatcher CANNOT do

- It cannot withdraw funds — there is no `withdraw` / `rescue` / admin path.
- It cannot promote any slot's fee after registration — the only way `feePaid` changes is via a new registration overwriting that slot.
- It cannot deregister a slot — the only way out is eviction by an outbidder.
- Its owner cannot censor a callback — there is no owner.

### Lock + binding flow (operator side)

When PC is ready to bind the dispatcher (post-launch, deliberate):

1. **Authorize the dispatcher on PCSwapContext:**
   `pcSwapContext.setAuthorizedExtension(dispatcher)` — called by
   `PCSwapContext.owner`. Reversible until lock.
2. **Allowlist the dispatcher on the artcoins hook:**
   `hook.poolExtensionAllowlist().setPoolExtension(dispatcher, true)` —
   called by the artcoins-side allowlist owner.
3. **Bind the dispatcher to the pool's extension slot:**
   `tokenAdminPoker.bindExtension(dispatcher)` — called by
   `TokenAdminPoker.owner`. The hook now calls `dispatcher.afterSwap(...)`
   on every swap.
4. **(Optional, irreversible) Lock the binding:**
   `tokenAdminPoker.lockExtension()` AND
   `pcSwapContext.lockAuthorizedExtension()`. Permanent after both.

---

## Contract addresses (post-deploy)

After running `Deploy.s.sol`, `deployments.json` contains:

| Field | Role |
|---|---|
| `permanentCollection` | Records-only core |
| `patron` | V4 entry-point hub, holds the live bid |
| `punkVault` | Immutable terminal Punk custodian |
| `returnAuctionModule` | 72h return auction (contract name follows the deployed ABI) |
| `buybackBurner` | ETH → 111 → 0xdead |
| `liveBidAdapter` | ~83.33% live-bid leg (contract name follows the deployed ABI) |
| `vaultBurnPool` | Accumulator (fed by cleared-auction proceeds) → BuybackBurner on vault settle |
| `protocolFeePhaseAdapter` | ~16.67% protocol leg → PCController |
| `polDepositor` | Permanent depth bootstrap LP |
| `titleAuction` | Vault Title NFT auction |
| `protocolAdmin` | 1y auto-locking admin role |
| `tokenAdminPoker` | 111 token-admin holder + extension bind |
| `pcSwapContext` | Design B reentrancy registry (dormant) |
| `referralPayout` | Per-referrer payout ledger |
| `hook` | `ArtCoinsHookSkimFee` instance |
| `locker` | Conversion-aware LP locker |
| `token` | 111 ERC20 |

---

## Configuration matrix

### Immutable at deploy (permanent)

| Constant | Value | Where |
|---|---|---|
| Baseline skim | 6% | hook config `baselineSkimBps = 6_000` |
| Live-bid leg share of skim | ~83.33% | hook config `bountyBps = 8_333` (key follows the deployed ABI) |
| Protocol leg share (derived) | ~16.67% | `10_000 − bountyBps` |
| Hook hard cap on referral (permanent) | 1% of volume | `MAX_REFERRAL_CAP_OF_VOLUME = 1_000` — the ACTUAL invariant |
| Current referral cap (tunable) | 0.25% | hook storage `_skimConfig[pid].maxReferralBpsOfVolume = 250` at launch; admin-tunable within `[0, 1_000]` via `TokenAdminPoker.setHookMaxReferralBps` — forever-tunable carve-out (callable by EITHER TokenAdminPoker.owner OR ProtocolAdmin.admin EOA) |
| LP fee | 0.5% | hook config `lpFee = 5_000` ppm |
| Hook hard cap on skim | 90% | `MAX_SKIM_BPS = 90_000` |
| Hook hard cap on referral | 1% of volume | `MAX_REFERRAL_CAP_OF_VOLUME = 1_000` |
| Cleared return-auction split | 65/25/10 | `CLEARED_BID_BPS = 6_500` (bid) + residual 25% (burn) + `CLEARED_VAULT_BURN_BPS = 1_000` (vault-burn) |

### Configurable until 1y `ProtocolAdmin` auto-lock

- `LiveBidAdapter.maxSweepWei`, `minBlocksBetweenSweeps` (the two knobs of the
  adapter's throttled-mode rate cap; no carve-out, both lock at 1y.
  `setActivationThreshold` is the adapter's one lifetime carve-out — see below.)
- `Patron.allowedSellers` (also editable indefinitely)
- `BuybackBurner` parameters
- Renderer impl swap (until `freeze()`)

(`Patron.finderFeeCapBps` / `finderFeeFixedCap` and
`ReturnAuctionModule.minBidIncrementBps` were here previously but are now
protocol constants — no setter.)
- `LiveBidAdapter.setActivationThreshold` — the metering threshold that
  separates fast mode from throttled mode. Bounded `[0, 100 ether]`, gated by
  `ProtocolAdmin.admin()` alone (`onlyAdminEvenIfLocked`) — the adapter's one
  forever-tunable carve-out, surviving the 1y lock until the admin EOA is burned.
  It otherwise self-syncs to 75% of the latest `acceptBid` clearing price, so a
  builder need not touch it.
- `TokenAdminPoker.setHookMaxReferralBps` — referral cap on the skim
  hook. Two-key authorization (EITHER `TokenAdminPoker.owner` OR
  `ProtocolAdmin.admin()` EOA) — forever-tunable carve-out within
  `[0, 1_000]` bps. Build assuming the cap MAY change over the
  protocol's lifetime; the hook clamps your requested `referralBps`
  against the live value at swap time.

### Owner of `TokenAdminPoker` (no auto-lock)

- `bindExtension(dispatcher)` — bind/re-bind extension
- `lockExtension()` — permanently freeze the binding

### Owner of `PCSwapContext` (no auto-lock)

- `setAuthorizedExtension(addr)` — authorize the dispatcher to set the
  in-swap flag
- `lockAuthorizedExtension()` — permanently freeze the authorization

---

## Building on top of Permanent Collection

| You want to build... | Use |
|---|---|
| A frontend that gets credit for swap volume | hookData attribution (`sourceId` + `referrer`) — live now |
| A campaign with sub-attribution | `sourceId` + `campaignId` per swap — live now |
| An indexer / analytics dashboard | Listen for `SwapAttribution`, `BidPlaced`, `ReturnAuctionCleared`, `Contribution`, `BareTopUp` — live now |
| A trait-funding receipt NFT minter | Off-chain relayer triggered by `SwapAttribution` (Design A) — live now |
| A frontend that earns on return-auction bids | `ReturnAuctionModule.placeBidWithReferral(punkId, referrer, tag)` — live now; pays 5% of premium |
| An NFT launchpad that routes mint proceeds to PC | `Patron.contribute(referrer, tag)` — live now; pays 5% to referrer |
| A wallet widget / DAO / public-goods aggregator routing ETH to PC | `Patron.contribute(referrer, tag)` — live now |
| Synchronous on-chain art / NFT minter / state-recorder | Implement `IPCCallbackExtension`, register on `PCDispatcher` once bound (Design B) — interface is canonical; dispatcher is built but not yet bound |
| A side pool routing fees to PC | Deploy a new pool with same hook + same recipient configuration |

### Three attribution surfaces, three independent payments

There are now three permissionless referral surfaces. Each pays from a
different source, on a different trigger, with a different cap. They
do NOT aggregate on-chain; a referrer who shows up across all three
gets paid through three separate paths.

| Surface | Trigger | Cap | Source | Where it lands |
|---|---|---|---|---|
| Swap referral | Swap on the official pool with `hookData` attribution | `maxReferralBpsOfVolume` (live: 0.25%; hard ceiling 1%) | ~16.67% protocol slice of the 6% skim | `ReferralPayout` balance — pull via `claim` |
| Auction referral | Winning bid on `ReturnAuctionModule.placeBidWithReferral` | 5% of rescue premium (hard-coded) | Premium = `highBid − cost` (fresh value from the rescuer) | Direct send at cleared-path settle |
| Contribution referral | Caller of `Patron.contribute` | 5% of `msg.value` (hard-coded) | Caller's `msg.value` (fresh value from the contributor) | Direct send within `contribute()` |

A swap-path referrer accumulates a pulled balance; an auction-path or
contribution-path referrer gets paid synchronously on the trigger
transaction. Build your indexer to query all three independently.

---

## What NOT to build

- **Anything that requires `PCDispatcher` to be bound TODAY.** The
  dispatcher is built and verified; binding is a deliberate post-launch
  operator action with no committed date. Write your callback against
  the canonical `IPCCallbackExtension` interface now, deploy when the
  dispatcher is bound.
- **Anything that assumes referrer ≠ swapper** — self-referral is allowed
  and intentional. Build to expect it.
- **Anything that takes funds from the live-bid leg.**
  Structurally protected — the hook math doesn't permit a path to it.
  Don't design as if it does.
- **A callback that calls PC contracts during `onSwap`.** Patron,
  ReturnAuctionModule, LiveBidAdapter, BuybackBurner, and the other decorated
  PC contracts all revert `PCNoReentry.InSwap` while the dispatcher is
  iterating. Plan around that constraint; read-only views on
  `PermanentCollection` are fine.
- **A generic "claim all my referral earnings" aggregator that hides the
  three sources.** Swap, auction, and contribution referrals pay through
  three different mechanisms (pull-based ledger, synchronous send on
  cleared settle, synchronous send on contribute). A naive
  cross-surface aggregator can give referrers the wrong mental model of
  when their money lands and what can fail. If you do build an
  aggregator dashboard, expose the three sources as separate ledgers
  with their own status (claimable, paid-synchronously, fail-closed
  rebounded) so referrers see each path's actual behaviour.
- **Auction-path or contribution-path referrer contracts heavier than
  ~35k gas.** Both surfaces enforce a 35k budget on the outgoing send.
  Anything heavier silently forfeits the referral. Keep `receive()`
  cheap or use an EOA.
- **An indexer that treats `referrerOfHighBid` as a history.** It's a
  single overwritten slot. Outbid bidders' referrers lose attribution
  permanently. Mirror the overwrite in your data model.

---

## See also

- [DISPATCHER_DESIGN.md](./DISPATCHER_DESIGN.md) — `PCDispatcher` mechanic spec, threat model, audit scope
- [SYSTEM.md](./SYSTEM.md) — system overview + complete deploy settings
- [PROTOCOL.md](./PROTOCOL.md) — protocol mechanics (PC core)
- Source: [`contracts/src/interfaces/IPCCallbackExtension.sol`](../contracts/src/interfaces/IPCCallbackExtension.sol)
- Source: [`contracts/lib/artcoins/src/hooks/ArtCoinsHookSkimFee.sol`](../contracts/lib/artcoins/src/hooks/ArtCoinsHookSkimFee.sol)
- Source: [`contracts/src/ReferralPayout.sol`](../contracts/src/ReferralPayout.sol)
- Source: [`contracts/src/PCSwapContext.sol`](../contracts/src/PCSwapContext.sol)
- Source: [`contracts/src/libraries/PCNoReentry.sol`](../contracts/src/libraries/PCNoReentry.sol)
- Source: [`contracts/src/ReturnAuctionModule.sol`](../contracts/src/ReturnAuctionModule.sol) (auction referral path)
- Source: [`contracts/src/Patron.sol`](../contracts/src/Patron.sol) (contribution referral path)
- Source: [`contracts/src/interfaces/IPatron.sol`](../contracts/src/interfaces/IPatron.sol)
