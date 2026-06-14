# PCDispatcher — design spec

Production permissionless dispatcher for Design B. Bound (if at all) post-launch.
Companion contract: [`UnipegDispatcher`](../contracts/test/mocks/UnipegDispatcher.sol)
(a demo with owner-controlled registration; stays as the worked example for
documentation, not as the production platform).

## Goals

1. **Permissionless registration forever.** Any builder can plug a callback into PC's
   swap stream by paying a fee. No admin, no owner, no setters, no governance.
2. **Bounded swap-time cost.** A fixed maximum number of callback slots, each with
   a bounded per-call gas budget, so the dispatcher's overhead on every swap is
   predictable and capped.
3. **Self-policing.** A misbehaving callback gets auto-disabled by an on-chain
   failure counter. Anyone can re-enable a disabled slot by paying a small fee
   (signaling that they vouch for it).
4. **Economic alignment.** Every fee flows directly to `Patron`. Registration is
   literally trading "I want a slot" for "the live bid grows."
5. **Audit-once, configure-at-deploy.** All economic parameters are immutable
   constructor arguments bounded by hard ranges in the constructor. The
   *mechanic* is what gets audited; the specific values are a deploy-time
   tuning question.
6. **Verified-ready, not necessarily deployed at launch.** The pre-launch
   deliverable is a contract + an adversarial test suite proving the mechanic
   works for any sensible parameter set. Actual binding (and eventual `lockExtension`)
   is a deliberate post-launch operation.

## Non-goals

- Not a governance system. No voting, no admin, no setters.
- Not a callback marketplace. Slots are bid on but the dispatcher doesn't
  arbitrate which callback is "good." That's up to swap-callers via attribution
  hookData and to the failure counter for runtime hygiene.
- Not WETH-aware. PC's pool is native-ETH-paired. Fees in/out are native ETH.
- No refunds on eviction. If you're outbid, the fee you paid is gone (it went
  to Patron, not held in escrow).
- No "deregister my own slot" function. Once registered, the only way out is
  eviction. (Predictability > convenience here.)

## Architecture overview

```
swap on artcoins pool (4-leg skim split happens in hook)
   ↓
hook._afterSwap → tries to call pool extension if bound
   ↓
PCDispatcher.afterSwap(poolKey, swapParams, delta, artCoinIsToken0, hookData)
   ↓
   1. swapContext.enterSwap()   // flips PCSwapContext.inSwap to true
   2. for each registered, non-disabled slot:
        try callback.onSwap{gas: slot.gasBudget}(...) returns (bytes32 result)
          → slot.failureCount = 0   // reset on success: counter is consecutive
          → emit CallbackInvoked
        catch
          → slot.failureCount++; if ≥ THRESHOLD, slot.disabled = true
          → emit CallbackFailed (and AutoDisabled if applicable)
   3. swapContext.exitSwap()    // clears PCSwapContext.inSwap

   While inSwap is true, ALL decorated PC contracts revert PCNoReentry.InSwap
   on any external call. Callbacks can't reach into Patron, ReturnAuctionModule,
   LiveBidAdapter, BuybackBurner, VaultBurnPool, ProtocolFeePhaseAdapter, or
   PunkVaultTitleAuction.
```

The dispatch loop is the only "afterSwap-flavored" code that runs synchronously
on every swap. The dispatcher itself is just the platform; callbacks are the
third-party content.

## Parameters (immutable constructor arguments)

All values are baked in at deploy time. Constructor enforces hard bounds; deploy
must fall within them or the constructor reverts.

| Parameter | Type | Bounds (constructor-enforced) | Suggested initial value | Effect if increased |
|---|---|---|---|---|
| `MAX_CALLBACKS` | `uint256` immutable | `[4, 32]` | 16 | More registered callbacks possible → more per-swap gas overhead. |
| `MIN_GAS_BUDGET` | `uint32` immutable | `[1_000, 50_000]` | 5_000 | Floor on what a callback can request. |
| `MAX_GAS_BUDGET` | `uint32` immutable | `[MIN, 500_000]` | 100_000 | Ceiling on what a callback can request. Caps worst-case overhead = `MAX_CALLBACKS × MAX_GAS_BUDGET`. |
| `FEE_PER_GAS_UNIT` | `uint256` immutable | `[1 gwei, 100 gwei]` | 10 gwei | Higher = more anti-spam, less accessible. Registration fee = `gasBudget × FEE_PER_GAS_UNIT`. |
| `EVICTION_PREMIUM_BPS` | `uint256` immutable | `[1_000, 50_000]` (10%–500%) | 5_000 (1.5×) | Higher = harder to evict an existing slot. |
| `FAILURE_THRESHOLD` | `uint256` immutable | `[10, 1_000]` | 50 | Higher = more tolerant of misbehaving callbacks before auto-disable. |
| `REENABLE_FEE` | `uint256` immutable | `[0.0001 ETH, 0.1 ETH]` | 0.001 ETH | Higher = stronger commitment to re-enable a disabled slot. |

The bounds are themselves the audit-relevant decision. Within those bounds, the
deployer picks specific values based on observed swap activity, builder
feedback, and gas market conditions. The contract code does not need to change
to retune.

## Storage layout

```solidity
struct Slot {
    address callback;       // 20 bytes
    uint32  gasBudget;      // 4 bytes  → packed with callback
    uint64  failureCount;   // 8 bytes
    bool    disabled;       // 1 byte
    // 1 word total when packed:  [address callback][uint32 gasBudget][uint64 failureCount][bool disabled]
    uint128 feePaid;        // 16 bytes (separate word)
}

Slot[] slots;  // length = MAX_CALLBACKS, pre-allocated at construction
```

Slots are 1-indexed conceptually but 0-indexed in storage (Solidity convention).
`callback == address(0)` ⟺ slot is empty.

## Public API

### `register(address callback, uint32 gasBudget) external payable`

**Permissionless.** Anyone can call. Registers `callback` with `gasBudget` gas
allotment per swap.

Validations:
- `callback != address(0)` AND `callback.code.length > 0` (must be a deployed contract).
- `MIN_GAS_BUDGET ≤ gasBudget ≤ MAX_GAS_BUDGET`.
- `msg.value ≥ gasBudget × FEE_PER_GAS_UNIT` (the minimum required fee).

Slot assignment:
1. If any slot has `callback == address(0)` (empty), use the lowest-indexed one.
2. Otherwise, find the slot with the lowest `feePaid`. Require
   `msg.value ≥ lowestFeePaid × (10_000 + EVICTION_PREMIUM_BPS) / 10_000`. Evict
   it (emit `Evicted`) and take its slot.

The new slot has: `callback`, `gasBudget`, `feePaid: msg.value`, `failureCount: 0`,
`disabled: false`.

The full `msg.value` is forwarded to `Patron` at the end of registration.
Registration is atomic: either the slot is taken AND Patron receives the fee,
or the call reverts.

Emits `Registered(callback, slotIdx, gasBudget, feePaid)` (and `Evicted` if applicable).

### `reenable(uint256 slotIdx) external payable`

**Permissionless.** Anyone can call to re-enable a disabled slot (one whose
`failureCount` hit the threshold and got auto-disabled in the dispatch loop).

Validations:
- `slotIdx < MAX_CALLBACKS`.
- `slots[slotIdx].disabled == true`.
- `msg.value ≥ REENABLE_FEE`.

Side effects: `disabled = false`, `failureCount = 0`. Fee forwarded to Patron.
The `feePaid` field is NOT modified — the slot's eviction-resistance is
unchanged.

Emits `Reenabled(callback, slotIdx, msg.value)`.

### `afterSwap(...)` — hook entry point (IArtcoinsPoolExtension)

Called by the bound artcoins hook on every swap. Iterates registered + enabled
slots, invokes each callback under its gas budget inside a try/catch. Failures
increment the counter; threshold reached → auto-disable.

PCSwapContext is entered before the loop and exited after.

Reverts only if `msg.sender != hook` (`OnlyHook`). Anything else (including
swapContext failures) propagates up to the hook, which has its own try/catch.

### `initializePreLockerSetup(...)`, `initializePostLockerSetup(...)` — hook bind hooks (IArtcoinsPoolExtension)

No-op. Required by the `IArtcoinsPoolExtension` interface; no per-pool state
is needed since the dispatcher is single-pool-bound.

### Views

- `getSlot(uint256 idx) → Slot memory` — read a slot's full state.
- `callbackCount() → uint256` — number of registered, non-disabled slots.
- `findLowestFeeSlot() → (uint256 idx, uint128 fee, bool allEmpty)` — utility
  for builders considering a registration (so they know what fee to bid).
- `supportsInterface(bytes4)` — ERC-165 + `IArtcoinsPoolExtension`.

## Dispatch loop semantics

For each slot `i` in `0..MAX_CALLBACKS-1`:

1. If `callback == address(0)` (empty) → skip.
2. If `disabled == true` → skip.
3. Try `callback.onSwap{gas: gasBudget}(poolKey, swapParams, delta, hookData)`:
   - **Success** → reset `failureCount` to 0 (the counter tracks *consecutive*
     failures, not lifetime), emit `CallbackInvoked(callback, i, result)`.
     Continue.
   - **Failure** (revert, OOG, selfdestruct-as-no-op):
     - `failureCount++`
     - If `failureCount >= FAILURE_THRESHOLD` → `disabled = true`, emit `AutoDisabled`.
     - Always emit `CallbackFailed(callback, i, failureCount)`.
     - Continue to next slot.

Because the counter resets on every success, `FAILURE_THRESHOLD` bounds the
number of *consecutive* failures, not cumulative lifetime failures. A callback
that succeeds most of the time but fails occasionally never auto-disables; only
a callback that is broken *right now* (THRESHOLD failures in a row, with no
intervening success) gets disabled. This also closes a griefing vector where an
attacker holding an earlier, higher-gas-budget slot could gas-starve a later
honest callback into slowly accumulating failures across many swaps (audit L-4).

Failures of any slot **never** propagate to the swap. The whole dispatch loop
runs to completion regardless. The hook's own try/catch wraps `afterSwap` as
an extra safety net.

## Reentrancy story

- The dispatcher calls `swapContext.enterSwap()` BEFORE invoking any callback
  and `swapContext.exitSwap()` AFTER all callbacks have run.
- While `inSwap == true`, every PC contract decorated with `notInSwap`
  (Patron, ReturnAuctionModule, LiveBidAdapter, BuybackBurner, VaultBurnPool,
  ProtocolFeePhaseAdapter, PunkVaultTitleAuction — 7 contracts) reverts on
  external entry.
- The `notInSwap` seam is uniform belt-and-suspenders, not the sole guard.
  Independently of it: the four fund-movers (Patron, ReturnAuctionModule,
  LiveBidAdapter, PunkVaultTitleAuction) carry `nonReentrant`; `executeStep`
  runs inside `poolManager.unlock`, which V4 forbids nesting, so it cannot run
  mid-swap regardless; `VaultBurnPool.sweep` and `LiveBidAdapter.poolReplenish`
  are gated to `returnAuctionModule`; and no PC contract reads the pool's spot
  price except `BuybackBurner` (the one pool-toucher, already covered above).
  The seam exists because that safety argument is multi-premise and cannot be
  retrofitted onto immutable contracts later — an explicit guard is the durable
  form, and it is the one piece of Design B that must ship at launch.
- A callback CANNOT call `swapContext.exitSwap()` directly. The check is
  `msg.sender == authorizedExtension`, where `authorizedExtension` is the
  dispatcher's address (not the callback's). A callback's attempt reverts
  `NotAuthorizedExtension`, caught by the dispatcher's try/catch as a slot
  failure (counter increments).
- Adversarial test coverage in `LaunchInvariantForkTest` already verifies the
  PCSwapContext + PCNoReentry pattern works against the live `Deploy.s.sol`
  bytecode. PCDispatcher's role is to be a faithful citizen of that pattern.

## Lock / binding flow

The dispatcher is deployed standalone. Binding is a sequence of independent
ops:

1. **Authorize the dispatcher on PCSwapContext:**
   `pcSwapContext.setAuthorizedExtension(dispatcher)` — called by
   `PCSwapContext.owner`. This lets the dispatcher flip the `inSwap` flag.
   Reversible until lock.
2. **Allowlist the dispatcher on the artcoins hook:**
   `hook.poolExtensionAllowlist().setPoolExtension(dispatcher, true)` —
   called by the artcoins allowlist owner. (PC doesn't control this; it's
   the artcoins-side perimeter check.)
3. **Bind the dispatcher to the pool's extension slot:**
   `tokenAdminPoker.bindExtension(dispatcher)` — called by
   `TokenAdminPoker.owner`. The dispatcher is now the active per-pool
   extension. The hook calls `dispatcher.afterSwap(...)` on every swap.
4. **(Optional, irreversible) Lock the binding — after a ≥ 1-year soak:**
   the soak trigger is **≥ 1 year bound in production with a clean record**,
   chosen to mirror the protocol's other 1-year time-locks (ProtocolAdmin
   auto-lock, etc.). Once met:
   `tokenAdminPoker.lockExtension()` AND
   `pcSwapContext.lockAuthorizedExtension()`. After both, the dispatcher
   binding is permanent forever. New dispatchers cannot be bound; the
   PCSwapContext authorization cannot be transferred.

Each step is gated by a different owner key (PCSwapContext owner = deployer;
artcoins allowlist owner = artcoins-side; TokenAdminPoker owner = deployer).
Steps can be reversed individually until step 4 fires.

## Threat model

### T1. Spam-fill all slots cheap

An attacker registers `MAX_CALLBACKS` trivial callbacks at minimum gas budget.
Cost: `MAX_CALLBACKS × MIN_GAS_BUDGET × FEE_PER_GAS_UNIT`. At suggested values
(16 × 5_000 × 10 gwei) = 0.0008 ETH ≈ $2.40. Cheap.

**Why this is fine:**
- All $2.40 goes to Patron → boosts the live bid by that amount.
- Each spam slot has the minimum `feePaid`. Real builders only need to outbid
  the minimum (× 1.5) to evict. At suggested values, eviction premium on a
  minimum slot is ~$3.60. Cheap.
- Spam slots either do nothing (low gas budget produces nothing meaningful) or
  revert (failure counter eventually auto-disables them).

The spam vector is self-funded protocol-bootstrapping, not a real attack.

### T2. Gas-griefing callback

A callback that consumes its full gas budget every swap, succeeds (no revert),
and produces no useful effect. Every swap now pays an extra `gasBudget` gas.

**Why this is bounded:**
- The griefer paid a non-trivial fee to register (real economic stake).
- Outbidding evicts the griefer; their slot is gone.
- The hook's overall try/catch catches OOG / revert at the dispatcher level; a
  malicious or broken callback can never block the swap itself.
- A persistent griefer is paying protocol money to grief; their slot's
  `feePaid` makes them outbiddable.

Mitigation if this becomes a real problem: deploy a second dispatcher with a
tighter `MAX_GAS_BUDGET`. The locked dispatcher is permanent for the bound
pool, but PC could choose to **un-bind** (pre-lock) and bind a tighter
variant. Post-lock, the system is committed.

### T3. Reentrancy via callback

A callback's `onSwap` tries to reach into Patron / ReturnAuctionModule / etc.

**Why this is blocked:**
- All 7 decorated PC contracts revert `PCNoReentry.InSwap` while
  `inSwap == true`.
- The dispatcher's try/catch absorbs the revert as a slot failure (counter
  increments).
- Verified by `LaunchInvariantForkTest`'s `notInSwap` coverage (every
  decorated entry point).

### T4. Callback that tries to clear the inSwap flag

A callback calls `pcSwapContext.exitSwap()` directly to disarm the reentrancy
guard so a subsequent callback in the same loop can reenter PC.

**Why this is blocked:**
- `pcSwapContext.exitSwap()` checks `msg.sender == authorizedExtension`. The
  authorized extension is the dispatcher, not the callback. The call reverts
  `NotAuthorizedExtension`, caught by the dispatcher's try/catch.
- Verified by `LaunchInvariantForkTest`'s
  `test_fork_pcSwapContext_callbackCannotClearFlag`.

### T5. Registration front-running

An adversary watches the mempool for a real builder's registration tx and
front-runs it with their own at a higher fee, claiming the slot.

**Why this is bounded:**
- The front-runner has to pay the fee themselves (no MEV-style "extract from
  the victim").
- The fee goes to Patron. The protocol benefits from the front-run.
- The original builder's tx reverts (insufficient fee for the now-higher
  lowest slot) and they can retry at a higher bid.

Front-running here is just "early registration at a higher price," which is
the normal market mechanic.

### T6. Eviction cascade / griefing the displacement

Adversary registers + immediately gets evicted, claiming "lost money."

This isn't an attack — that's the documented mechanic. Eviction is a feature.
Slots are rent, not deed.

### T7. Selfdestruct in a callback

Post-Cancun, `SELFDESTRUCT` doesn't destroy contract code (except in same-tx
new contracts). A callback that selfdestructs during `onSwap` would still have
code at its address; the next swap would call into the (now-empty?) contract.

**Why this is bounded:**
- If the callback's bytecode goes empty, calling it succeeds with empty
  returndata, which our try/catch interprets as "no result" — emits
  `CallbackInvoked` with a zero result, doesn't increment failure counter.
- If the bytecode stays put (the common Cancun case for non-same-tx
  contracts), the callback continues to execute on subsequent swaps.
- Either way, no harm to the swap or the rest of the dispatcher loop.

### T8. Owner of the dispatcher

There is no owner. There are no setters. There is no admin. The "owner" of
each slot is implicitly whoever registered it, but no API exposes that — the
slot can only be evicted by an outbidding registration. Locked-at-registration
is intentional: no one can later increase a slot's `feePaid` to make it
harder to evict, and no one can deregister a slot to get a refund.

## Gas analysis

Per swap, the dispatcher's overhead is:

```
fixed:  enterSwap (~5k) + exitSwap (~3k) + storage reads for MAX_CALLBACKS slots (~2k each)
        ≈ 8k + (MAX_CALLBACKS × 2k)
variable: sum of (gasBudget) for each enabled callback that runs to completion
        ≤ MAX_CALLBACKS × MAX_GAS_BUDGET
```

At suggested values:
- Fixed overhead: ~8k + 32k = ~40k
- Max variable: 16 × 100k = 1.6M

Total worst-case per-swap dispatcher overhead: ~1.64M gas.

A typical Uniswap V4 swap costs 150k-300k gas. With the dispatcher fully
loaded, swap cost roughly **6x**. This is the upper bound; in practice most
callbacks will use far less than max budget.

Tradeoff: every additional `MAX_CALLBACKS` slot or every increase in
`MAX_GAS_BUDGET` directly raises the worst-case swap cost. The bounds are
chosen so even the worst case stays affordable on mainnet.

## Test coverage map

Two test suites cover the dispatcher pre-launch:
- `contracts/test/PCDispatcherSmoke.t.sol` (16 tests) — the basic
  mechanic, all paths exercised against in-memory mocks.
- `contracts/test/PCDispatcherIntegration.t.sol` (50 tests) — clean +
  adversarial builder simulators, exhaustive constructor bounds, event
  emission, fee atomicity, eviction edge cases, lock-flow rehearsal.

Combined coverage:

### Registration mechanic
- Anyone can register (no owner gating)
- Fee below `gasBudget × FEE_PER_GAS_UNIT` rejects
- gasBudget outside `[MIN, MAX]` rejects
- Callback that's not a contract rejects
- First registration takes lowest empty slot
- Registrations fill empty slots before evictions
- Once full, must outbid lowest-fee slot by `EVICTION_PREMIUM_BPS`
- Outbid below premium rejects
- All fees forward to Patron
- Failed Patron transfer reverts the registration (atomicity)
- Outbidding emits both `Evicted` and `Registered`

### Re-enable mechanic
- A disabled slot can be re-enabled by anyone with `REENABLE_FEE`
- Re-enable fee forwards to Patron
- Re-enable resets `failureCount` to 0
- Re-enabling a non-disabled slot reverts
- Re-enable fee below threshold reverts

### Dispatch loop
- All enabled callbacks fire on every swap (with attribution / without)
- Disabled callbacks skip
- Empty slots skip
- Per-callback gas budget enforced (callback OOG counted as failure)
- Reverting callback caught + counted
- PCSwapContext.inSwap == true during callbacks, false after
- Failure counter increments on each failure
- Failure counter resets to 0 on a successful invocation (consecutive, not
  cumulative — audit L-4)
- Auto-disable fires at threshold (consecutive failures)
- Failures of one callback don't block subsequent ones in same swap

### Builder integration (third-party callback simulator)
- Event-only callback works
- NFT-minter callback (UnipegArt) works
- State-reading callback (reads `pc.collectedMask()`) works
- High-gas callback (~90% of max budget) completes
- Multiple distinct-shape callbacks coexist correctly
- Different callbacks see different `hookData` correctly

### Builder adversarial simulator
- Callback that tries to reenter Patron → blocked by `notInSwap`, counted
- Callback that calls `swapContext.exitSwap()` directly → blocked, counted
- Callback that selfdestructs → handled gracefully
- Callback that returns junk data → CallbackInvoked emitted, no failure
- Callback that consumes full gas without reverting → succeeds, no failure
- Callback that calls another callback in same swap → reentry not blocked
  (callbacks-to-callbacks is fine; the notInSwap guard is only on PC)

### Cross-cutting with rest of protocol
- Four-leg fee split still routes correctly with dispatcher bound
- ReferralPayout still credits attributed referrers
- Return-auction flows (cleared + vault) still work
- Bytecode-scan still asserts no withdrawal paths

### Lock + binding flow
- `pcSwapContext.setAuthorizedExtension(dispatcher)` from owner
- `hook.allowlist.setPoolExtension(dispatcher, true)` from artcoins owner
- `tokenAdminPoker.bindExtension(...)` from owner
- After bind: hook routes afterSwap to dispatcher
- `lockExtension` → cannot re-bind
- `lockAuthorizedExtension` → cannot re-authorize
- Both locks one-way

### Constructor bounds
- All seven bound checks reject out-of-range values
- All seven accept values at the exact bounds
- Slot array correctly pre-allocated to `MAX_CALLBACKS` length

## Open questions for the auditor

1. Is the slot-finding loop in `register()` a gas concern? It's O(MAX_CALLBACKS)
   and runs on every registration. At `MAX_CALLBACKS = 32` it's a non-trivial
   read pattern but still bounded.
2. Is the `feePaid: uint128` packing acceptable? Max `msg.value` is < 2^128 wei
   (340 undecillion ETH). Even a billion-dollar registration fits. But verify
   no overflow path.
3. Does the dispatch loop's per-callback gas budget interact correctly with
   the 63/64ths gas rule? A callback that requests 100k might receive
   100k × 63/64 = 98.4k after the EIP-150 deduction. Acceptable; documented as
   the "effective" budget.
4. Lock + binding is multi-step (3 separate owner ops). Is the ordering
   matter? Specifically: what if `bindExtension` is called before
   `setAuthorizedExtension`? The dispatcher would be bound but unable to
   toggle the inSwap flag → callbacks fire without the reentrancy guard.
   Should the dispatcher's constructor or first `afterSwap` reject if not
   authorized?

## File organization

- `PCDispatcher` — the production contract (permanent surface). Kept in the
  private working repo's `contracts/future/` until it is bound post-launch; not
  part of the public launch snapshot.
- `contracts/src/interfaces/IPCCallbackExtension.sol` — moved here from
  `src/demos/` so it's the canonical builder-facing interface
- `contracts/src/demos/UnipegDispatcher.sol` — the demo dispatcher (stays
  where it is for docs)
- `contracts/src/demos/UnipegArt.sol` — sample callback (stays for docs)
- `contracts/test/PCDispatcherIntegration.t.sol` — the new test suite

## Audit scope

This contract + the `IPCCallbackExtension` interface + the integration with
`PCSwapContext`. Out of scope: the four-leg hook itself (already covered),
`UnipegDispatcher` (demo only).
