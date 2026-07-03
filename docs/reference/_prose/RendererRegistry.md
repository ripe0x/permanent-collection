---
contract: RendererRegistry
slug: renderer-registry
deploymentsKey: rendererRegistry
title: RendererRegistry
---

# summary

The stable address fronting the protocol's renderer. The $111 ERC20 and
`PunkVault` both store this registry as their immutable metadata renderer
reference; the actual rendering logic lives at `implementation` (the
mosaic renderer) and every metadata call passes through here. The
implementation can be swapped by the protocol admin to fix display bugs,
until either `freeze()` is called or the 1-year admin timer locks, after
which the renderer is permanent.

The registry carries no funds and no economic authority. It forwards four
views to the current implementation: `tokenURI()` (zero-arg, ERC20
metadata), `tokenURI(uint256)` (ERC721 metadata for the Vault Title and
the Proofs), `svg()` (the raw mosaic SVG, no JSON envelope), and
`contractURI(address)` (ERC-7572 contract-level metadata). Worst-case
bad-faith admin: garbage strings until the next swap. It cannot move ETH,
cannot move Punks, cannot affect any protocol state.

# concepts

### Why a registry at all

The renderer is the one part of the system where a display bug is
plausible and harmless, so it gets the protocol's narrowest mutability
window instead of being immutable from day one. The artcoins factory
wires the $111 token's `metadataRenderer` to this address, and
`PunkVault` pins it as the source of `tokenURI(id)` and `contractURI()`.
Both references are immutable, so the registry is the only way to change
what those surfaces return, and only until it locks.

### What is and isn't checked on `setImplementation`

There is no on-chain interface probe. `setImplementation` guards exactly
two foot-guns: the zero address (`ZeroAddress`) and an address with no
contract code, an EOA or destroyed contract (`NotAContract`). A candidate
that has code but renders wrongly is not caught on-chain by design: the
registry moves no value, so a bad install only breaks the forwarded views
until the next `setImplementation`, and that recoverability is the real
bound. The operational practice is to verify the live render output
before calling `freeze()`.

### Reading through the registry

```bash
# Current implementation
cast call {{addr:rendererRegistry}} "implementation()(address)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# The Vault Title metadata, forwarded to the live renderer
cast call {{addr:rendererRegistry}} "tokenURI(uint256)(string)" 111 \
  --rpc-url https://ethereum-rpc.publicnode.com

# Is the implementation permanent yet?
cast call {{addr:rendererRegistry}} "isLocked()(bool)" \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function setImplementation

access: admin-only (`ProtocolAdmin.checkAdmin(msg.sender)` must be true, so the caller must hold the admin role with its 1-year timer unexpired)

Points the registry at a new renderer implementation. Reverts
`AlreadyFrozen` if `freeze()` has been called, `NotAdmin` if the caller
isn't the active admin, `ZeroAddress` for the zero address, and
`NotAContract` if the candidate has no code. No further validation: a
contract that exists but renders garbage is accepted, since the mistake
is recoverable by swapping again. Emits `ImplementationUpdated` with the
previous and next addresses.

## function freeze

access: admin-only (`ProtocolAdmin.checkAdmin(msg.sender)`), one-way

Permanently locks the current implementation. Reverts `AlreadyFrozen` if
already frozen and `NotAdmin` for anyone but the active admin. There is
no unfreeze; after this call `setImplementation` reverts forever
regardless of admin state. Emits `Frozen` with the block number. Note the
lock can also arrive implicitly: once the admin role expires or is
burned, `setImplementation` is unreachable even with `frozen == false`.

## function adminContract

The immutable `ProtocolAdmin` instance gating `setImplementation` and
`freeze`. Same 1-year heartbeat-renewable timer as the rest of the
protocol's mutable surfaces.

## function contractURI

Forwarded ERC-7572 `contractURI(address token)`. The $111 ERC20 calls
this on its configured metadata renderer to resolve both its own
`contractURI()` and zero-arg `tokenURI()`; `PunkVault.contractURI()`
calls it with the vault's address. The live implementation keys the
returned `symbol` field off the `token` argument ("PERMANENTCOLLECTION"
for the vault, "111" for the ERC20) and otherwise returns the same
collection envelope with the live mosaic image and N-of-111 progress.

## function frozen

True iff `freeze()` has been called. Distinct from `isLocked()`: `frozen`
only reflects the explicit freeze, not admin expiry.

## function implementation

The current renderer implementation address. All four pass-through views
forward here. Updated by `setImplementation` while the registry is
unfrozen and the admin role active.

## function isLocked

True iff the implementation is permanent, for either reason: `freeze()`
was called, or the admin role is no longer exercisable
(`adminContract.isLocked()`). The value to surface in a UI that wants to
say "the renderer can/can't still change".

## function svg

Forwarded raw SVG payload from the implementation: the full mosaic image
with no JSON envelope. Useful for off-chain tools that want the image
without base64-decoding a metadata blob.

## function tokenURI()

Forwarded zero-arg `tokenURI()`, the ERC20-flavored metadata. The
artcoins ERC20's metadata path consumes this signature; it resolves to
the same collection JSON as `contractURI` with symbol "111".

## function tokenURI(uint256)

Forwarded `tokenURI(uint256 id)` for the PunkVault ERC721 tokens. The
live implementation dispatches ids 0..110 to the Proof renderer, id 111
to the Vault Title render, and reverts `UnknownTokenId` for anything
higher. Calling it here for an in-range but unminted Proof reverts
`ProofNotMinted` at the Proof renderer; the canonical entry point,
`PunkVault.tokenURI(id)`, gates on mint state before forwarding.

## event Frozen

Emitted exactly once, when `freeze()` is called, with the block number.
After this event the implementation can never change again.

## event ImplementationUpdated

Emitted at deployment (with `previous == address(0)`) and on every
successful `setImplementation`, with the previous and next implementation
addresses, both indexed. The full renderer history of the protocol is
this event stream.

## error AlreadyFrozen

`setImplementation` or `freeze` was called after `freeze()`. The
implementation is permanent; there is nothing the caller can do.

## error NotAContract

The `setImplementation` candidate has no contract code (an EOA, a typo,
or a destroyed contract). Deploy the renderer first, then register it.

## error NotAdmin

The caller of `setImplementation` or `freeze` isn't the active protocol
admin, either because it's the wrong address or because the admin timer
has expired.

## error ZeroAddress

The zero address was passed where a contract is required: either
constructor argument, or the `newImpl` argument of `setImplementation`.
