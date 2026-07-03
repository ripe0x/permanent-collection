---
contract: ProtocolAdmin
slug: protocol-admin
deploymentsKey: protocolAdmin
title: ProtocolAdmin
---

# summary

The protocol's single, time-locked admin role. One address (`admin`) holds it,
and its authority auto-expires one year after the last renewal
(`ADMIN_TIMER_DURATION = 365 days`). Other protocol contracts consult this
registry through `checkAdmin(caller)` before accepting a parameter change;
once the timer lapses without renewal, `checkAdmin` returns false forever and
every setter gated on it reverts. The contract holds no funds and can move
none: it's a pure role registry with one write function, `transferAdmin`.

Two classes of surface reference this contract. The `checkAdmin`-gated
setters (operational rate caps and the renderer registry) lock at expiry.
A small set of scoped carve-outs read the raw `admin` address instead, so
they survive the timer and are disabled only by burning the role with
`transferAdmin(address(0))`. The burn is reachable at any time, including
after the timer has lapsed; only renewals and rotations are time-gated.

# concepts

### What checkAdmin gates (locks at the 1-year expiry)

These setters call `checkAdmin(msg.sender)` and become permanently
unreachable once `isLocked()` is true:

| Contract | Functions |
|---|---|
| `LiveBidAdapter` | `setMaxSweepWei`, `setMinBlocksBetweenSweeps` |
| `BuybackBurner` | `setMinBlocksBetweenSteps`, `setMaxStepWei` |
| `RendererRegistry` | `setImplementation`, `freeze` |

Every gated parameter has hard bounds enforced in its own setter, so even a
live admin can only move values within a fixed band. No gated function moves
funds.

### The four lifetime carve-outs (survive the lock)

Four setters stay callable past the 1-year expiry as long as the relevant
role hasn't been burned. Each tracks a market regime that shifts over the
protocol's lifetime, where freezing the launch value would be wrong:

- `Patron.addAllowedSeller` / `removeAllowedSeller` reads `admin()` directly
  (not `checkAdmin`), so recognizing new aligned listing contracts stays
  possible indefinitely. A 24-hour activation delay on adds gives the
  community a detection window
- `LiveBidAdapter.setActivationThreshold` also reads `admin()` directly,
  bounded [0, 100 ETH]. It's an anomaly-correction valve on the adapter's
  fast/throttled boundary, which normally self-tracks the latest clearing
  price
- `TokenAdminPoker.setHookMaxReferralBps` is two-key gated: callable by
  either `TokenAdminPoker.owner` or this contract's `admin()`. Bounded
  [0, 1000] bps of swap volume at the hook (100k denominator)
- `TokenAdminPoker.setTokenTaxBps` uses the same two-key gate. Bounded
  [0, taxBpsMax] at the token, with a structural 20% ceiling

The first two freeze when this role is burned. The two `TokenAdminPoker`
carve-outs freeze only when both this role and `TokenAdminPoker.owner` are
burned.

### The burn is the off-switch

`transferAdmin(address(0))` permanently disables the role: `checkAdmin`
returns false, the raw-admin carve-outs stop matching any caller, and no
future assignment is possible. Because burning strictly reduces power, it is
not timer-gated. A key compromised after the timer lapsed can still be
neutralised by burning, so the carve-outs always have an on-chain kill.

### Reading the role state

```bash
cast call {{addr:protocolAdmin}} "admin()(address)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:protocolAdmin}} "isLocked()(bool)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:protocolAdmin}} "timeUntilLock()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
```

## function transferAdmin

access: admin-only (`msg.sender` must equal the current `admin`; any other caller reverts `NotAdmin`)

The role's single write path, with two distinct behaviors keyed on
`newAdmin`:

- `newAdmin != address(0)`: renewal or rotation. Requires the role to still
  be active (reverts `Locked` if the timer has expired or the role is
  burned). Sets `admin = newAdmin` and resets `adminTimerExpires` to now
  plus one year. Self-transfer (`newAdmin == admin`) is allowed and acts as
  a heartbeat that renews the timer without changing custody. Emits
  `AdminTransferred`
- `newAdmin == address(0)`: burn. NOT timer-gated, so it stays reachable at
  any time, including after a missed heartbeat. Sets `admin = address(0)`
  and `adminBurned = true`, permanently disabling `checkAdmin`, the
  raw-admin carve-outs, and any future assignment. Emits `AdminBurned`

There is no way to recover a lapsed role: once the timer expires, renewals
revert `Locked` and the only remaining action is the burn.

## function ADMIN_TIMER_DURATION

The renewal period, a constant `365 days` (31,536,000 seconds). Every
successful renewal or rotation sets `adminTimerExpires` this far into the
future. Not configurable.

## function admin

The current admin address, or `address(0)` after a burn. The raw-admin
carve-outs (`Patron`'s seller allowlist, `LiveBidAdapter.setActivationThreshold`,
and the two `TokenAdminPoker` two-key setters) compare callers against this
value directly, so they honor it even after the timer lapses.

## function adminBurned

True iff `transferAdmin(address(0))` has been called. Once set it never
clears; the role is permanently disabled.

## function adminTimerExpires

Unix timestamp at which the role auto-locks. Reset to now plus one year by
every renewal or rotation. The lock is inclusive: the role is already locked
at exactly this timestamp.

## function checkAdmin

The gate other contracts consult: returns true iff `caller` is the current
`admin` AND the role is still active (`!isLocked()`). Setters gated on this
lock permanently at expiry or burn.

## function isLocked

True if admin powers gated on `checkAdmin` are no longer exercisable, either
because the role was burned or because `block.timestamp >= adminTimerExpires`.
Note that a true value from timer expiry alone does NOT disable the raw-admin
carve-outs or the burn path; only `adminBurned` does that.

## function timeUntilLock

Seconds remaining until the timer expires, or 0 if already locked. Handy for
a dashboard countdown to the renewal deadline.

## event AdminTransferred

Emitted at construction (with `previousAdmin = address(0)`) and on every
renewal or rotation. Carries the outgoing admin, the incoming admin (never
`address(0)` on this event; burns emit `AdminBurned` instead), and the fresh
expiry timestamp. An indexer can track the live expiry from the latest
`newTimerExpires`.

## event AdminBurned

Emitted exactly once, on `transferAdmin(address(0))`. From this point every
admin surface in the protocol is permanently disabled, including the
lifetime carve-outs gated on this contract's `admin()`.

## error Locked

A renewal or rotation (`newAdmin != address(0)`) was attempted after the
timer expired or after a burn. Lapsed roles can't be revived; the only
remaining action is the burn.

## error NotAdmin

`transferAdmin` was called by an address other than the current `admin`.
