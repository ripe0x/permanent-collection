---
contract: TokenAdminPoker
slug: token-admin-poker
deploymentsKey: tokenAdminPoker
title: TokenAdminPoker
---

# summary

Retained-admin holder of the $111 token's `tokenAdmin` role. The token
itself sees this contract as its admin, but the contract exposes only four
narrow forwards: bind or lock the official pool's per-swap fee extension on
the skim hook (`bindExtension` / `lockExtension`, owner-gated), tune the
hook's referral cap (`setHookMaxReferralBps`), and tune the token's
venue-scoped buy-tax rate (`setTokenTaxBps`). Every other token-admin
surface (metadata, image, admin transfer on the token) has no passthrough
here and is therefore unreachable, making the rest of the token effectively
immutable.

A one-shot `setup` pins the token address and the canonical pool key. The
extension and cap setters take no target arguments; they can only ever act
on that pinned pool's hook and that pinned token. The two rate setters use a
two-key gate: callable by either `owner` (the launch key) or the current
`ProtocolAdmin` admin EOA, so each rate stays tunable until BOTH roles are
burned.

# concepts

### Why the admin is retained

The pool extension slot on the skim hook is empty at launch. A future
synchronous extension dispatcher (Design B) binds through this contract's
`bindExtension`; once the extension is proven in production, `lockExtension`
freezes the binding permanently. Retaining the owner key is what keeps that
path open. When the owner is transferred to a dead address, `bindExtension`,
`lockExtension`, and `setup` become unreachable, and the two rate setters
fall back to the `ProtocolAdmin` key alone.

### The two-key carve-out pattern

`setHookMaxReferralBps` and `setTokenTaxBps` accept `msg.sender == owner` OR
`msg.sender == adminContract.admin()`. Each rate tracks a market regime that
shifts over the protocol's lifetime (referral economics, side-pool
competition), so it should stay tunable past the 1-year `ProtocolAdmin`
timer and past an owner renouncement. The bounds are enforced downstream,
not here:

| Setter | Enforced by | Bound |
|---|---|---|
| `setHookMaxReferralBps` | the skim hook | `[0, 1_000]` bps of swap volume, 100k denominator (at most 1% of volume) |
| `setTokenTaxBps` | the $111 token | `[0, taxBpsMax]`, with `taxBpsMax <= 2000` structural (never above 20%; launch rate 1500) |

Either role being alive keeps the value tunable; both burned freezes it
where it last stood.

### Reading the wiring

```bash
cast call {{addr:tokenAdminPoker}} "owner()(address)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:tokenAdminPoker}} "token()(address)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:tokenAdminPoker}} "poolKey()(address,address,uint24,int24,address)" --rpc-url https://ethereum-rpc.publicnode.com
```

The last component of `poolKey` is the skim hook, the only contract the
extension and referral-cap setters can ever call.

## function setup

access: owner-only, one-shot (reverts `AlreadySetup` on a second call)

Pins the $111 token address and the canonical pool key (including its hook).
Reverts `ZeroAddress` if the token or the key's hook is zero. Pinning here
is what lets `bindExtension` / `lockExtension` / `setHookMaxReferralBps`
drop their target arguments: they act only on this pool and this token,
never on a caller-supplied address.

## function bindExtension

access: owner-only (reverts `NotOwner` otherwise; reverts `NotSetup` before `setup`)

Binds (or re-binds, or swaps) the per-swap fee extension on the pinned
pool's hook by forwarding `setPoolExtension(poolKey, extension, "")`. Works
because this contract holds the token-admin role; the hook additionally
requires the extension to be allowlisted on its side. Re-callable until
`lockExtension` freezes the binding. Emits `ExtensionBound`.

## function lockExtension

access: owner-only (reverts `NotOwner` otherwise; reverts `NotSetup` before `setup`)

One-way freeze of the pool's extension binding, forwarding
`lockPoolExtension(poolKey)` to the hook. Intended for after a bound
extension has proven itself in production; once called, the binding can
never change again. Emits `ExtensionLocked`.

## function setHookMaxReferralBps

access: two-key (either `owner` or the current `ProtocolAdmin.admin()` EOA; all other callers revert `NotAuthorized`; reverts `NotSetup` before `setup`)

Updates the referral cap on the skim hook for the pinned pool by forwarding
`setMaxReferralBpsOfVolume(poolKey, newCap)`. The hook enforces the hard
upper bound of `1_000` (1% of swap volume in the 100k denominator); this
wrapper just forwards the value. Launch value is `250` (0.25% of volume).
Because the gate accepts the `ProtocolAdmin` admin as well as the owner, the
cap survives the 1-year admin timer and an owner renouncement; it freezes
only when both roles are burned. Emits `MaxReferralBpsSet`.

## function setTokenTaxBps

access: two-key (either `owner` or the current `ProtocolAdmin.admin()` EOA; all other callers revert `NotAuthorized`; reverts `NotSetup` if the token isn't pinned yet)

Updates the $111 token's venue-scoped buy-tax rate by forwarding
`setTaxBps(newBps)` to the token. The token enforces the bound
(`newBps <= taxBpsMax`, itself capped at a structural `2000`, so the rate
can never exceed 20%; the launch rate is `1500`). The token reverts
`TaxNotEnabled` if its tax feature is off, so the forward is safe against a
dormant token. Same two-key survival semantics as `setHookMaxReferralBps`.
Emits `TokenTaxBpsSet`.

## function transferOwnership

access: owner-only (reverts `NotOwner` otherwise)

Transfers the retained owner key. Reverts `ZeroAddress` for `address(0)`;
to effectively renounce, transfer to a dead-but-non-zero address, which
makes the owner-only functions unreachable while leaving the two-key rate
setters alive through the `ProtocolAdmin` path. Emits
`OwnershipTransferred`.

## function adminContract

The immutable `ProtocolAdmin` reference used by the two-key gates. Its
current `admin()` is accepted alongside `owner` in `setHookMaxReferralBps`
and `setTokenTaxBps`.

## function owner

The protocol's launch key (or its successor via `transferOwnership`). Gates
`setup`, `bindExtension`, `lockExtension`, and `transferOwnership`, and is
one of the two accepted keys on the rate setters.

## function poolKey

The canonical pool key pinned by `setup`: currency pair, LP fee,
tick spacing, and the hook address. The hook component is the only contract
`bindExtension` / `lockExtension` / `setHookMaxReferralBps` can ever call.

## function setupDone

True once `setup` has run. While false, every forward reverts `NotSetup`
(the tax setter checks the pinned token instead, with the same effect).

## function token

The $111 token address pinned by `setup`, target of `setTokenTaxBps`.
`address(0)` until setup.

## event ExtensionBound

Emitted on every `bindExtension` with the hook (indexed) and the extension
(indexed). A rebind emits again with the new extension; `address(0)` means
the slot was cleared.

## event ExtensionLocked

Emitted once, on `lockExtension`, with the hook (indexed). From this point
the pool's extension binding is permanent.

## event MaxReferralBpsSet

Emitted on every `setHookMaxReferralBps` with the hook (indexed) and the new
cap. The latest event carries the live referral ceiling for attributed
swaps.

## event OwnershipTransferred

Emitted at construction (from `address(0)`) and on every
`transferOwnership`. Tracks who holds the retained owner key.

## event TokenTaxBpsSet

Emitted on every `setTokenTaxBps` with the token (indexed) and the new rate
in bps. The latest event carries the live venue-scoped buy-tax rate.

## error AlreadySetup

`setup` was called a second time. The token and pool pin once and never
change.

## error NotAuthorized

A rate setter (`setHookMaxReferralBps` / `setTokenTaxBps`) was called by an
address that is neither `owner` nor the current `ProtocolAdmin.admin()`.

## error NotOwner

An owner-only function (`setup`, `bindExtension`, `lockExtension`,
`transferOwnership`) was called by an address other than `owner`.

## error NotSetup

A forward was attempted before `setup` pinned its target: the extension and
referral-cap setters check `setupDone`, the tax setter checks the pinned
token.

## error ZeroAddress

Raised by the constructor for a zero owner or admin-contract address, by
`setup` for a zero token or hook, and by `transferOwnership` for a zero new
owner.
