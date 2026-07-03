---
contract: LiveBidAdapter
slug: live-bid-adapter
deploymentsKey: liveBidAdapter
title: LiveBidAdapter
---

# summary

LiveBidAdapter is the single inflow governor for the live bid. Every ETH source
that funds the bid enters this contract first: the hook's bid-leg skim (plus
100% of the anti-sniper overage during the launch window), the conversion
locker's LP-fee share, attributed `contribute()` top-ups, bare `receive()`
sends, and the cleared return auction's live-bid share via the module-only
`poolReplenish()`. `Patron.receive()` accepts ETH only from this adapter, so
the buffer here is the sole faucet into the live bid.

The buffer drains toward Patron through two paths, the keeper/UI `sweep()` and
the hook-called `streamForward()`, under a two-mode meter keyed on Patron's
balance versus `activationThreshold`. Below the threshold the buffer forwards
uncapped with no cooldown, clamped to land the bid exactly at the threshold
(the launch warm-up). At or above it, each forward is capped at `maxSweepWei`
and paced by `minBlocksBetweenSweeps`, so a burst of inflow drips into the
standing offer rather than lurching it past realistic Punk prices in one
block. There is no withdrawal path: buffered ETH can only exit toward Patron.

Deployed at [{{addr:liveBidAdapter}}](https://evm.now/address/{{addr:liveBidAdapter}}?chainId=1).

# concepts

### Two forwarding modes

Every forward (from `sweep()` or `streamForward()`) reads Patron's balance and
compares it to `activationThreshold`:

- **Fast mode (Patron balance below the threshold).** No cooldown, no per-call
  cap. The forward is clamped so the bid lands exactly at the threshold; any
  remainder stays buffered and drips in under the throttle on later calls.
  This is not a bid cap, only a per-forward clamp: once the bid reaches the
  threshold the throttle engages and the bid keeps growing past it at the drip
  rate
- **Throttled mode (Patron balance at or above the threshold).** Each forward
  moves at most `maxSweepWei` and must wait `minBlocksBetweenSweeps` blocks
  since the last throttled forward. `sweep()` reverts `SweepTooEarly` inside
  the cooldown; `streamForward()` returns 0 instead (a revert there would
  brick the swap that called it)

In fast mode the exact landing is load-bearing: on a fill-to-threshold sweep
the full clamped amount goes to Patron and the keeper reward is paid out of
the buffered remainder, so the bid actually reaches the threshold and the
throttle can engage on the next call.

### One shared cooldown clock

`sweep()` and `streamForward()` share a single `lastSweepBlock`. A throttled
forward through either path arms the clock, so the combined rate of live-bid
growth is bounded at `maxSweepWei` per `minBlocksBetweenSweeps` blocks no
matter which path fires. Fast-mode forwards do not update `lastSweepBlock`:
the throttle engages fresh from the first at-or-above-threshold forward
rather than being pre-armed by warm-up activity. No-op calls (empty buffer,
below the stream dust floor, or a stream inside the cooldown) never consume
the cooldown slot.

### streamForward: the pre-swap path

The adapter implements `IPreSwapStream`. The official pool's hook calls
`streamForward()` in `_beforeSwap`, so each swap advances the live bid with
the buffered proceeds of prior swaps (the current swap's own skim arrives
later, in `_afterSwap`). The stream path is deliberately leaner than
`sweep()`:

- forwards buffered native ETH only, no escrow claim
- pays no keeper reward, the caller is the hook
- no-ops below `MIN_STREAM_WEI` (0.01 ETH) so tiny swaps don't trigger a
  forward
- does not refresh `activationThreshold`; it reads whatever the last
  `sweep()` set
- never reverts on cooldown, it returns 0 so the swap always completes

### Keeper reward on sweep

`sweep()` pays its caller a reward of `KEEPER_REWARD_BPS` (0.5%) of the
forwarded amount, capped at `KEEPER_REWARD_CAP` (0.01 ETH). On a
fill-to-threshold fast-mode sweep the reward comes from the buffered
remainder (capped at whatever remains); otherwise it is carved off the
forward. If the reward send fails the sweep still succeeds, the reward ETH
stays buffered, and `KeeperRewardFailed` is emitted.

### activationThreshold self-tracking

`sweep()` first runs an internal sync that reads the records core
(`permanentCollection`, an `IPCAcquisitionReader`). When a new acquisition has
been recorded since the last sync, and that acquisition has the `acceptBid`
shape (its `acquirer` equals its `originalSeller`), the threshold is
overwritten with 75% of the recorded clearing price (a minus-25% band),
clamped to `ACTIVATION_THRESHOLD_HI` (100 ETH). `acceptListing` rows are
skipped: they record a distinct finder as `acquirer`, and a cheap aligned
listing must not drag the warm-up ceiling below the real floor. The sync is
fail-open: a reverting reader, or `permanentCollection == address(0)`, never
blocks the sweep, it just leaves the threshold at its prior value.
`streamForward()` never syncs. A manual `setActivationThreshold` write
persists until the next qualifying `acceptBid` re-syncs the slot
(last-writer-wins).

### contribute referral split

`contribute(referrer, tag)` is the canonical attributed top-up surface. With a
non-zero referrer, `REFERRER_CONTRIB_BPS` (500, 5%) of `msg.value` is sent to
the referrer under a `REFERRER_GAS` (35,000) gas budget; the remainder joins
the buffer and meters into the live bid on the next forward. The split is
fail-closed in both directions: `referrer == address(0)` buffers 100%, and a
reverting or out-of-gas referrer resets the share to 0 and buffers 100% (the
failed send never moved ETH out of the adapter). The bps value is a constant
with no setter.

### Reading sweep readiness

```bash
# ETH waiting in the buffer
cast call {{addr:liveBidAdapter}} "bufferedEth()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# first block at which the next THROTTLED forward is allowed
cast call {{addr:liveBidAdapter}} "nextSweepBlock()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# the fast/throttled boundary and the current throttle parameters
cast call {{addr:liveBidAdapter}} "activationThreshold()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:liveBidAdapter}} "maxSweepWei()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:liveBidAdapter}} "minBlocksBetweenSweeps()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# Patron's balance decides the mode: below activationThreshold = fast mode
cast balance $(cast call {{addr:liveBidAdapter}} "patron()(address)" \
  --rpc-url https://ethereum-rpc.publicnode.com) \
  --rpc-url https://ethereum-rpc.publicnode.com
```

A sweep is worth sending when `bufferedEth() > 0` and either Patron's balance
is below `activationThreshold()` (fast mode, no cooldown) or the current
block is at or past `nextSweepBlock()`.

## function sweep

access: permissionless

Forwards buffered native ETH to Patron and pays the caller a keeper reward.
Step by step:

1. Syncs `activationThreshold` from the latest `acceptBid` clearing price
   (fail-open, no-op when nothing changed or auto-tracking is disabled)
2. Returns 0 if the buffer is empty (without consuming the cooldown)
3. Reads Patron's balance. At or above the threshold: reverts
   `SweepTooEarly(nextBlock)` inside the cooldown, otherwise forwards
   `min(buffer, maxSweepWei)` and arms `lastSweepBlock`. Below the threshold:
   forwards uncapped, clamped so the bid lands exactly at the threshold, and
   does not arm the cooldown clock
4. Pays the caller `min(0.5% of the forward, 0.01 ETH)`. On a
   fill-to-threshold forward the reward comes from the buffered remainder so
   the bid still lands at the threshold; otherwise it is carved off the
   forward
5. Reverts `ForwardFailed` if Patron rejects the transfer (structurally
   impossible in production, where Patron accepts the adapter as its sole
   sender). A failed reward send does not revert; the reward stays buffered
   and `KeeperRewardFailed` fires

Emits `ThresholdCrossed` when the forward takes Patron's balance from below
the threshold to at or above it, then `Swept`. Guarded `notInSwap` +
`nonReentrant`; the reward recipient cannot re-enter.

Returns `ethForwarded`, the ETH delivered to Patron this call.

## function streamForward

access: permissionless (implements `IPreSwapStream`; designed to be called by the official pool's hook in `_beforeSwap`, but anyone may call)

Lean forward of already-buffered native ETH into the live bid. No threshold
sync, no keeper reward, no escrow interaction. Returns 0 without reverting
when the buffer is below `MIN_STREAM_WEI` (0.01 ETH) or, in throttled mode,
when called inside the cooldown, so it can never brick the swap that invoked
it. Applies the same fast-mode clamp and throttle bounds as `sweep()` and
shares the same `lastSweepBlock` cooldown clock (a throttled stream forward
arms it). Reverts `ForwardFailed` only if Patron rejects the transfer. Emits
`ThresholdCrossed` on a crossing and `Swept` on every non-zero forward.
Returns `ethForwarded` (0 on a no-op).

## function contribute

access: permissionless, payable

Attributed top-up into the live bid. Reverts `ZeroValue` when `msg.value` is
0. With `referrer != address(0)`, sends 5% of `msg.value`
(`REFERRER_CONTRIB_BPS = 500`) to the referrer with a 35,000-gas budget; if
the send fails the share folds back into the buffer (fail-closed, the ETH
never left the adapter). The remainder buffers here and meters into Patron on
the next `sweep()` / `streamForward()`. `tag` is a free-form 32-byte campaign
marker, indexed on the `Contribution` event; pass `bytes32(0)` if unused.
Guarded `nonReentrant` + `notInSwap`.

Primary integration target: launchpads and treasuries routing a share of
proceeds to the protocol with on-chain attribution.

```ts
import {createWalletClient, custom, parseEther, stringToHex} from 'viem'
import {mainnet} from 'viem/chains'
import {abi} from '@/lib/abis/LiveBidAdapter'

const wallet = createWalletClient({chain: mainnet, transport: custom(window.ethereum)})

const hash = await wallet.writeContract({
  address: '{{addr:liveBidAdapter}}',
  abi,
  functionName: 'contribute',
  args: [
    '0xYourReferrerAddress',                       // or zeroAddress to skip
    stringToHex('my-campaign', {size: 32}),        // bytes32 tag
  ],
  value: parseEther('0.5'),
  account,
})
// tx: https://evm.now/tx/<hash>?chainId=1
```

## function poolReplenish

access: module-only (`msg.sender` must equal `returnAuctionModule`; anyone else reverts `NotReturnAuction`)

Payable entry for the live-bid share of a cleared return auction (65% of the
acquisition cost, plus any rerouted settle keeper reward). Gated to the
module so the punk-keyed `PoolReplenished` event can't be spoofed. The ETH
joins the buffer and meters into Patron via the two-mode forward: a large
refund fast-fills a low bid but drips in once the bid is at or above the
activation threshold. Guarded `nonReentrant` + `notInSwap`. When the adapter
was constructed with `returnAuctionModule == address(0)` this function is
permanently uncallable.

## function setMaxSweepWei

access: admin-only (`ProtocolAdmin.checkAdmin`; subject to the 1-year auto-lock, no carve-out)

Sets the per-forward ETH ceiling used in throttled mode. Bounded to
`[MAX_SWEEP_WEI_LO, MAX_SWEEP_WEI_HI]` (0.01 to 5 ETH); out-of-range values
revert `OutOfBounds`. Emits `ParameterChanged("maxSweepWei", old, new)`.
Freezes at its last value once the admin timer lapses or the role is burned.

## function setMinBlocksBetweenSweeps

access: admin-only (`ProtocolAdmin.checkAdmin`; subject to the 1-year auto-lock, no carve-out)

Sets the cooldown, in blocks, between throttled forwards. Bounded to
`[MIN_BLOCKS_LO, MIN_BLOCKS_HI]` (1 to 7,200 blocks, roughly every block up
to about a day); out-of-range values revert `OutOfBounds`. Emits
`ParameterChanged("minBlocksBetweenSweeps", old, new)`. Freezes at its last
value once the admin timer lapses or the role is burned.

## function setActivationThreshold

access: admin-only carve-out (raw `ProtocolAdmin.admin()`, ignoring the 1-year timer; live until the role is burned via `transferAdmin(address(0))`)

Manual override for the fast/throttled boundary. Bounded to
`[ACTIVATION_THRESHOLD_LO, ACTIVATION_THRESHOLD_HI]` (0 to 100 ETH); above
the cap reverts `OutOfBounds`. Set higher to keep the fast-fill warm-up
active longer, or to 0 to always throttle. This is an anomaly-correction
valve, not a maintained constant: the written value persists only until the
next qualifying `acceptBid` re-syncs the slot (last-writer-wins). Emits
`ParameterChanged("activationThreshold", old, new)`.

## receive

access: permissionless

Accepts native ETH into the buffer from any sender: the hook's bid-leg skim,
the conversion locker's LP-fee forwards, and bare top-ups from anyone. Every
inflow emits `BareTopUp` and meters into Patron on the next `sweep()` /
`streamForward()`. Use `contribute(referrer, tag)` instead when you want
on-chain attribution.

## function ACTIVATION_THRESHOLD_HI

Upper bound on `activationThreshold`: 100 ETH (`100e18`). Both the setter and
the auto-sync clamp to it.

## function ACTIVATION_THRESHOLD_LO

Lower bound on `activationThreshold`: 0. A zero threshold pins the adapter
into throttled mode (every forward is rate-limited).

## function BPS

Bps denominator, 10,000. Used by the keeper-reward and contribution-referrer
splits.

## function KEEPER_REWARD_BPS

Keeper reward on `sweep()` as bps of the forwarded amount: 50 (0.5%).

## function KEEPER_REWARD_CAP

Absolute cap on the keeper reward per `sweep()`: 0.01 ETH (`1e16` wei). The
reward is `min(forward × 0.5%, 0.01 ETH)`.

## function MAX_SWEEP_WEI_HI

Upper bound on `maxSweepWei`: 5 ETH.

## function MAX_SWEEP_WEI_LO

Lower bound on `maxSweepWei`: 0.01 ETH.

## function MIN_BLOCKS_HI

Upper bound on `minBlocksBetweenSweeps`: 7,200 blocks (roughly one day).

## function MIN_BLOCKS_LO

Lower bound on `minBlocksBetweenSweeps`: 1 block (essentially no cooldown).

## function MIN_STREAM_WEI

Dust floor for `streamForward()`: 0.01 ETH. Below it the stream path no-ops
so tiny swaps don't trigger a forward. A fixed floor, not an admin knob.

## function REFERRER_CONTRIB_BPS

Referrer share of an attributed `contribute()` call, as bps of `msg.value`:
500 (5%). Hard-coded, no setter.

## function REFERRER_GAS

Gas budget for the outgoing send to the contribution referrer: 35,000.

## function activationThreshold

The Patron-balance level separating fast mode (below) from the throttle (at
or above). Self-managed: each `sweep()` re-syncs it to 75% of the most
recent `acceptBid` clearing price, clamped to 100 ETH, with
`setActivationThreshold` as a bounded manual override in between syncs.

## function adminContract

The immutable `ProtocolAdmin` instance gating the setters.

## function bufferedEth

ETH currently buffered in the adapter (its raw balance), waiting to be
forwarded to Patron over future `sweep()` / `streamForward()` calls.

## function lastSweepBlock

Block of the most recent throttled forward, from either `sweep()` or
`streamForward()` (the two paths share this one clock). Fast-mode forwards
don't update it.

## function lastSyncedAcquisitionCount

High-water mark of `permanentCollection.acquisitionCount()` already examined
by the threshold auto-sync. Advances on every successfully-read new
acquisition, including skipped `acceptListing` rows, so a row is never
re-examined. Never decreases.

## function maxSweepWei

Current per-forward ETH ceiling in throttled mode. Excess buffer stays here
for later calls. Not enforced below the activation threshold.

## function minBlocksBetweenSweeps

Current cooldown, in blocks, between throttled forwards. Not enforced below
the activation threshold.

## function nextSweepBlock

`lastSweepBlock + minBlocksBetweenSweeps`: the first block at which the next
throttled forward is allowed. Fast-mode forwards and no-op calls are allowed
at any block regardless of this value.

## function patron

The immutable `Patron` hub address. All forwarded ETH goes here; Patron's
`receive()` accepts ETH only from this adapter.

## function permanentCollection

The records core, as an `IPCAcquisitionReader`. Read-only source for the
threshold auto-sync. `address(0)` disables auto-tracking (the threshold is
then the constructor seed plus manual sets).

## function returnAuctionModule

The immutable return-auction module address, the only authorized caller of
`poolReplenish`. `address(0)` leaves `poolReplenish` permanently uncallable.

## event ActivationThresholdSynced

Emitted when the auto-sync inside `sweep()` processes a new `acceptBid`
acquisition. `clearingPrice` is the raw recorded acquisition price, `applied`
is the value written to `activationThreshold` (75% of the price, clamped to
100 ETH), and `acquisitionCount` is the records core's count at sync time.
`acceptListing` acquisitions never emit this. Indexers can chart the
fast/throttled boundary directly from this event.

## event BareTopUp

Emitted on every direct ETH send into `receive()`: the hook's bid-leg skim,
the locker's LP-fee forwards, and unattributed top-ups. `sender` is indexed;
`amount` is the wei received. The ETH joins the buffer and appears in a later
`Swept`.

## event Contribution

Emitted on every `contribute()` call. `contributor`, `referrer`, and `tag`
are indexed; `amount` is the full `msg.value`; `referrerShare` is the wei
actually paid to the referrer (0 on a no-referrer call or when the
referrer's send failed and the share stayed buffered). Read `referrerShare`
rather than recomputing the 5%: it records the actual outcome.

## event KeeperReward

Emitted when the `sweep()` caller's reward send succeeds. `caller` is
indexed; `amount` is the reward paid.

## event KeeperRewardFailed

Emitted when the reward send fails (the caller can't receive ETH). The sweep
itself succeeded; the reward ETH stays buffered for the next sweep.

## event ParameterChanged

Emitted by the three setters. `key` (indexed) is the parameter name as a
short bytes32 string (`"maxSweepWei"`, `"minBlocksBetweenSweeps"`,
`"activationThreshold"`), with `oldValue` and `newValue`.

## event PoolReplenished

Emitted when the return-auction module routes a cleared auction's live-bid
share into the buffer via `poolReplenish`. `punkId` (indexed) keys the event
to the settled auction; `amount` is the wei received. Unspoofable: only the
module can call the emitting function.

## event Swept

Emitted on every non-zero forward, from `sweep()` and `streamForward()`
alike. `ethSwept` is the buffer at call time, `ethForwarded` is what reached
Patron, `ethBuffered` is what remains after the forward and any keeper
reward. `ethSwept - ethForwarded - ethBuffered` deltas reveal the reward paid
on a sweep; stream forwards never pay one.

## event ThresholdCrossed

Emitted exactly when a forward takes Patron's balance from below
`activationThreshold` to at or above it. Fires at most once per crossing;
it can fire again only after the live bid drops back below (for example,
spent by `acceptBid`) and crosses again. Useful for "the live bid has entered
realistic Punk-price territory" alerts.

## error ForwardFailed

The ETH forward to Patron failed. Structurally unreachable in production
(Patron accepts the adapter as its sole permitted sender); if it surfaces,
the wiring is wrong.

## error InSwap

The call arrived during an authorized extension's swap window
(`PCSwapContext.inSwap` is set). Dormant at launch: with no authorized
extension bound, the flag is permanently false and this error is
unreachable. Retry outside the swap.

## error NotAdmin

The caller failed the setter's admin gate: `checkAdmin` for the two throttle
setters (admin plus unexpired timer), or the raw `admin()` for
`setActivationThreshold`.

## error NotReturnAuction

`poolReplenish` was called by an address other than the bound
`returnAuctionModule`. Only the module may use this entry; send plain ETH via
`receive()` or `contribute()` instead.

## error OutOfBounds

A setter value fell outside its hard bounds. Carries the rejected `value`
and the accepted `[lo, hi]` range; resubmit within it.

## error Reentrant

A `nonReentrant` function was re-entered within the same transaction (for
example, by the keeper-reward recipient or a contribution referrer calling
back in). The outer call is still in flight; there is nothing to retry.

## error SweepTooEarly

A throttled `sweep()` was called before the cooldown elapsed. Carries
`nextBlock`, the first block at which the sweep will be accepted; wait and
resubmit. `streamForward()` never raises this, it returns 0 instead.

## error ZeroValue

`contribute()` was called with `msg.value == 0`. A contribution must move
ETH; attach a non-zero value.
