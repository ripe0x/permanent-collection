---
contract: PCSwapContext
slug: pc-swap-context
deploymentsKey: pcSwapContext
title: PCSwapContext
---

# summary

Shared reentrancy-detection registry for the protocol. It exposes a single
boolean, `inSwap`, held in EIP-1153 transient storage, that an authorized
extension sets before running swap callbacks and clears after. Protocol
contracts decorated with the `notInSwap` modifier read this flag and revert
if a callback tries to reach back into them mid-swap.

At launch `authorizedExtension` is `address(0)`, so `enterSwap` and
`exitSwap` revert for every caller and the flag is permanently false: every
`notInSwap`-decorated function passes the guard as a no-op. The contract
holds no funds, has no upgrade path, and has exactly three owner calls:
`setAuthorizedExtension`, `lockAuthorizedExtension` (one-way), and
`transferOwnership`.

# concepts

### Why this exists: synchronous swap-callback composability

The skim hook on the official pool carries an unbound extension slot. The
protocol's composability design lets a future dispatcher occupy that slot
and invoke third-party callbacks synchronously inside each swap's
`afterSwap`. Those callbacks are untrusted code running mid-swap, so every
fund-moving protocol entry point needs a guard against being reentered from
inside the callback loop. Retrofitting guards onto immutable contracts is
impossible, so the guard infrastructure ships from day one: the decorated
contracts read this registry, and the registry waits, inert, for a
dispatcher to be authorized.

When a dispatcher is bound and authorized, it calls `enterSwap` before
iterating callbacks and `exitSwap` after. During that window any call into a
decorated function reverts `InSwap` at the caller's `notInSwap` modifier.
The callbacks can observe the protocol; they can't move it.

### The decorated surface

Seven protocol contracts inherit the `notInSwap` modifier, which reads
`inSwap()` here and reverts if true:

| Contract | Functions |
|---|---|
| `Patron` | `acceptBid`, `acceptListing` |
| `ReturnAuctionModule` | `placeBid`, `placeBidWithReferral`, `settle`, `withdrawRefund` |
| `BuybackBurner` | `executeStep` |
| `LiveBidAdapter` | `contribute`, `poolReplenish`, `sweep`, `streamForward` |
| `ProtocolFeePhaseAdapter` | `sweep` |
| `VaultBurnPool` | `sweep` |
| `PunkVaultTitleAuction` | `bid`, `settle`, `withdrawProceeds`, `withdrawRefund` |

The cost while dormant is one TLOAD plus a comparison per decorated call.

### Activation and lock

Arming the guard is a deliberate, reversible-until-locked sequence by the
owner:

1. `setAuthorizedExtension(dispatcher)` authorizes the dispatcher to toggle
   the flag. Re-callable, and `address(0)` revokes
2. `lockAuthorizedExtension()` freezes the binding forever. After this,
   `setAuthorizedExtension` reverts permanently and the current value is
   locked in

Note the flag is per-transaction: transient storage auto-clears at the end
of every transaction, so a crashed or misbehaving extension can never leave
the protocol stuck in the in-swap state.

### Reading the state

```bash
cast call {{addr:pcSwapContext}} "authorizedExtension()(address)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:pcSwapContext}} "inSwap()(bool)" --rpc-url https://ethereum-rpc.publicnode.com
```

`inSwap` read from off-chain is always false (transient storage only holds a
value inside a transaction); the meaningful off-chain reads are the
extension binding and its lock.

## function enterSwap

access: extension-only (`msg.sender` must equal the current `authorizedExtension`, which must be non-zero; otherwise reverts `NotAuthorizedExtension`)

Sets the transient `inSwap` flag to true and emits `SwapEntered`. Called by
the authorized dispatcher immediately before it runs its callback loop, so
that every `notInSwap`-decorated protocol function reverts for the duration.
With no extension authorized (the launch state) this is uncallable, so the
flag can never be set.

## function exitSwap

access: extension-only (same gate as `enterSwap`)

Clears the transient `inSwap` flag and emits `SwapExited`. Called by the
authorized dispatcher after its callback loop completes. Even if this call
were skipped, the flag would auto-clear at transaction end because it lives
in transient storage.

## function setAuthorizedExtension

access: owner-only (reverts `NotOwner` otherwise; reverts `AuthorizedExtensionAlreadyLocked` after the lock)

Authorizes `ext` to toggle the `inSwap` flag. Re-callable until
`lockAuthorizedExtension` freezes the binding; pass `address(0)` to revoke
(future re-authorization stays possible until the lock). Emits
`AuthorizedExtensionSet`.

## function lockAuthorizedExtension

access: owner-only (reverts `NotOwner` otherwise; reverts `AuthorizedExtensionAlreadyLocked` if already locked)

One-way freeze of the extension binding. After this call
`setAuthorizedExtension` reverts forever and the current
`authorizedExtension` value (whatever it is, including `address(0)`) is
permanent. Emits `AuthorizedExtensionLocked`.

## function transferOwnership

access: owner-only (reverts `NotOwner` otherwise)

Transfers the owner role. Reverts `ZeroAddress` for `address(0)`: burning
the owner outright would foreclose the future binding path, so the intended
way to permanently disable this contract is `lockAuthorizedExtension`,
optionally followed by a transfer to a dead-but-non-zero address. Emits
`OwnershipTransferred`.

## function authorizedExtension

The contract currently allowed to call `enterSwap` / `exitSwap`.
`address(0)` at launch, which makes the flag permanently false until an
extension dispatcher is authorized.

## function authorizedExtensionLocked

True once `lockAuthorizedExtension` has been called. From then on the
extension binding can never change.

## function inSwap

The transient in-swap flag that `notInSwap`-decorated protocol functions
read. True only between an `enterSwap` and the matching `exitSwap` within a
single transaction; always false when read from off-chain, and permanently
false while no extension is authorized.

## function owner

Holder of the three admin calls (`setAuthorizedExtension`,
`lockAuthorizedExtension`, `transferOwnership`). Expected to be the same key
as `TokenAdminPoker.owner`, since binding a dispatcher requires coordinated
calls on both contracts.

## event AuthorizedExtensionLocked

Emitted exactly once, on `lockAuthorizedExtension`. The extension binding is
permanent from this point.

## event AuthorizedExtensionSet

Emitted on every `setAuthorizedExtension` with the new extension (indexed).
An `address(0)` value is a revocation. The latest event carries the live
binding.

## event OwnershipTransferred

Emitted at construction (from `address(0)`) and on every
`transferOwnership`. Tracks who can authorize or lock the extension binding.

## event SwapEntered

Emitted on every `enterSwap`. Useful for indexers counting armed callback
windows once a dispatcher is live; never emitted while no extension is
authorized.

## event SwapExited

Emitted on every `exitSwap`, closing the window opened by the matching
`SwapEntered` in the same transaction.

## error AuthorizedExtensionAlreadyLocked

`setAuthorizedExtension` or `lockAuthorizedExtension` was called after the
binding was already locked. The lock is one-way; there is nothing to retry.

## error NotAuthorizedExtension

`enterSwap` / `exitSwap` was called by anything other than the currently
authorized extension, or while no extension is authorized (the launch
state).

## error NotOwner

An owner-only function was called by an address other than `owner`.

## error ZeroAddress

Raised by the constructor for a zero initial owner and by
`transferOwnership` for a zero new owner. Ownership here can't be burned to
zero by design; use the lock to make the binding permanent instead.
