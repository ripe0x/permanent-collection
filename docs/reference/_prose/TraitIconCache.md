---
contract: TraitIconCache
slug: trait-icon-cache
deploymentsKey: traitIconCache
title: TraitIconCache
---

# summary

Public, permissionless on-chain cache of compact SVG fragments for the 111
CryptoPunks trait icons, companion to `PunkSvgFragmentCache` (that one
caches whole-Punk tiles for collected cells; this one caches the trait
icons drawn in uncollected and pending cells of the mosaic). For each trait
id 0..110 the cache stores the exact bytes the Mosaic renderer would
compose on the fly: a full canonical Punk for type and head-variant traits
(ids 0..15), an N-of-7 dot strip for attribute-count traits (ids 16..23),
and a canonical-versus-baseline pixel diff for accessory traits (ids
24..110). The canonical exemplar Punk per trait is pinned in an embedded
`CANONICAL_IDS` table, identical to the renderer's, and all pixel data
comes from the sealed PunksData contract at {{addr:punksData}}, pinned at
construction by its dataset hash.

Anyone can pay gas to bake a trait via `cacheTrait(traitId)`; once baked, a
fragment is permanent (SSTORE2 storage contract, no admin, no setters, no
funds). Six trait ids ({0, 1, 4, 5, 6, 15}, the rare types and their
matching head variants) are deliberately not cacheable: the renderer draws
a per-block-rotated Punk for those cells, so a stored fragment would be
stale within seconds. `buildFragment` still serves them live.

The cache is a render accelerator, not a dependency: the Mosaic renderer
consults it first and falls back to on-the-fly compute when an entry is
missing, and both paths produce byte-identical output. It's also a
standalone public good; any project rendering Punk trait icons can read
this same instance with no knowledge of the protocol.

# concepts

### How the renderers consume it

The Mosaic renderer at {{addr:renderer}} composes each uncollected or
pending cell of the Vault Title image (`tokenURI(111)`) through a
cache-first path:

1. Rotation short-circuit: for trait ids {0, 1, 4, 5, 6, 15} it always
   recomputes on the fly, picking the current block's Punk from the shared
   `RotationPool` library
2. Cache fast path: if `isCached(traitId)`, return `fragmentOf(traitId)`,
   one storage load plus an SSTORE2 read, roughly 50k gas
3. On-the-fly fallback: recompute the same bytes from PunksData, typically
   a few million gas per cell

The Proof renderer draws every Proof token's crisp trait-icon layer from
this contract too, but always via the live `buildFragment(traitId)` view
rather than the stored fragment. So baking traits speeds up the mosaic
(the Vault Title render), not individual Proof renders.

The cross-contract identity invariant is that for every valid trait id,
`buildFragment(t)` equals the Mosaic renderer's own on-the-fly bytes at
the same block, and equals `fragmentOf(t)` once baked. For the six
rotation ids both sides compute the same per-block pick through the shared
library, so the equality holds within a block.

### Who warms the cache, and why

`cacheTrait` is fully permissionless and idempotent: any account can bake
any cacheable trait, in any order, at any time, and races between bakers
waste little gas. The cache ships empty and "turns on" gradually as bakes
accumulate, no team coordination required. The payoff is `eth_call`
budgets: marketplace and wallet `tokenURI` fetches run as `eth_call`s with
provider-side gas caps (Alchemy defaults to 150M, Infura around 125M, many
public endpoints around 50M), and a mosaic render with many uncached cells
can exceed the tighter ones. Each bake permanently replaces one
few-million-gas on-the-fly cell with a roughly-50k-gas read, so the render
cost falls with every bake until all cacheable traits are covered. As
traits get collected by the protocol, their cells shift to
`PunkSvgFragmentCache` lookups instead, which drops the curve further.

A chain reorg that drops a bake transaction also drops its SSTORE2
pointer: `isCached` returns false again and the renderer falls back to
on-the-fly compute, so nothing breaks. Anyone can re-bake in a new
transaction.

### Checking and warming from the command line

```bash
# Is trait 23 baked? Is it even cacheable?
cast call {{addr:traitIconCache}} "isCached(uint8)(bool)" 23 \
  --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:traitIconCache}} "isRotationTrait(uint8)(bool)" 23 \
  --rpc-url https://ethereum-rpc.publicnode.com

# Bake it (any funded account)
cast send {{addr:traitIconCache}} "cacheTrait(uint8)" 23 \
  --rpc-url https://ethereum-rpc.publicnode.com --private-key $PRIVATE_KEY

# Read the standalone SVG
cast call {{addr:traitIconCache}} "svgOf(uint8)(string)" 23 \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function cacheTrait

access: permissionless

Bakes `traitId`'s SVG fragment into a fresh SSTORE2 storage contract and
records the pointer. Reverts `InvalidTraitId` for `traitId >= 111` and
`RotationTraitNotCacheable` for the six per-block-rotating ids
({0, 1, 4, 5, 6, 15}). If the trait is already cached the call returns the
existing pointer without redeploying, so double-bakes are cheap no-ops.
Otherwise it composes the fragment from PunksData and the pinned
`CANONICAL_IDS` table (the same bytes `buildFragment` returns), reverts
`EmptyFragment` if the derivation came back empty (unreachable given the
sealed dataset), writes the bytes via SSTORE2, stores the pointer, and
emits `TraitCached`. Once written an entry can never be changed or
removed. Gas varies by trait class: attribute-count strips are cheap
(under a million gas), full-Punk and accessory-diff traits cost a few
million each.

## function EXPECTED_DATASET_HASH

The pinned PunksData dataset hash, constant
`0x92117ce6cb6bb70f9ffb9bf51ebbca6a84eae10e70639295d9c4a07958cd1f68`. The
constructor rejects any `punksData` whose `datasetHash()` doesn't match.
Same value pinned by `PunkSvgFragmentCache` and `PermanentCollection`.

## function PUNK_DIM

The 24x24 dimension of canonical Punk tiles, constant `24`. Fragment
coordinates are in the 0..23 range.

## function TOTAL_TRAITS

Number of distinct CryptoPunks traits, constant `111`. Valid trait ids are
0..110.

## function buildFragment

Compute, without storing, the fragment bytes for `traitId`: the exact
bytes `cacheTrait` would bake, derived fresh from PunksData on every call.
Reverts `InvalidTraitId` for `traitId >= 111`. Unlike `cacheTrait`, this
works for the six rotation trait ids too, returning the current block's
pick (it reads `block.number`, so rotation-trait output changes every
block; all other traits are stable forever). Uses: the Proof renderer's
per-render icon source, off-chain previewers that want icon bytes without
paying bake gas, test invariants asserting cached bytes equal on-the-fly
bytes, and independent verification of any bake.

## function canonicalPunkForTrait

The pinned exemplar Punk id for `traitId`, decoded from the embedded
`CANONICAL_IDS` table (2 bytes per trait, identical to the Mosaic
renderer's table). Pure view so any consumer can reuse the mapping without
redoing the decode. Reverts `InvalidTraitId` for `traitId >= 111`. For
type and head-variant traits this Punk is rendered in full; for accessory
traits it's diffed against its head-variant baseline.

## function fragmentOf

Raw cached fragment bytes for `traitId`: a sequence of `<rect>` elements
(one per maximal horizontal run of same-colored pixels, or one per dot
slot for attribute-count traits) with coordinates in the 0..23 range.
Reverts `InvalidTraitId` for `traitId >= 111` and `NotCached` if the trait
hasn't been baked. This is the Mosaic renderer's fast-path read; the bytes
carry no outer `<g>` or positioning, so consumers wrap them as needed.

## function isCached

True iff `traitId` has been baked. Reverts `InvalidTraitId` for
`traitId >= 111`. The existence probe consumers call before choosing
between `fragmentOf` (cached) and their own fallback. Rotation trait ids
always return false, since `cacheTrait` rejects them.

## function isRotationTrait

True iff `traitId` is one of the six per-block-rotating ids
({0, 1, 4, 5, 6, 15}, the rare types and their matching head variants).
Pure view; reverts `InvalidTraitId` for `traitId >= 111`. Rotation traits
can be read via `buildFragment` (current block's pick) but never baked;
`cacheTrait` reverts `RotationTraitNotCacheable` for them.

## function pointerOf

The SSTORE2 storage-contract address holding `traitId`'s fragment. Reverts
`InvalidTraitId` for `traitId >= 111` and `NotCached` if unbaked. For
callers composing at the SSTORE2 layer directly rather than materializing
the bytes through this contract.

## function punksData

The immutable PunksData source of pixel and palette data,
{{addr:punksData}}, validated against `EXPECTED_DATASET_HASH` at
construction. Every fragment, cached or live, derives from this contract
plus the pinned `CANONICAL_IDS` table.

## function svgOf

Convenience view: the cached fragment wrapped in a standalone
`<svg viewBox="0 0 24 24">` element, ready to render as-is. Reverts
`InvalidTraitId` for `traitId >= 111` and `NotCached` if the trait hasn't
been baked.

## event TraitCached

Emitted exactly once per trait, on its first successful `cacheTrait`, with
the trait id (indexed), the SSTORE2 pointer address (indexed), and the
fragment byte length. Idempotent re-calls don't re-emit. An indexer can
reconstruct full cache coverage (at most 105 events, since the 6 rotation
ids are never baked) from this event alone; after a reorg drops a bake,
the re-bake emits a fresh event with a new pointer.

## error EmptyFragment

`cacheTrait` derived an empty fragment for the trait. Defense in depth: no
valid trait icon resolves to zero bytes given the pinned `CANONICAL_IDS`
table and the sealed PunksData state, so this is unreachable on the live
deployment.

## error InvalidTraitId

A function was called with `traitId >= 111`. Every external function on
the contract bounds-checks first, so this fires before any other error.
Use a valid trait id (0..110).

## error NotCached

`pointerOf`, `fragmentOf`, or `svgOf` was called for a trait that has
never been baked. Check `isCached` first, fall back to `buildFragment` for
a live derivation, or bake it with `cacheTrait`.

## error RotationTraitNotCacheable

`cacheTrait` was called for one of the six per-block-rotating trait ids
({0, 1, 4, 5, 6, 15}). These cells change every block, so a stored
fragment would be wrong within seconds; read them live via `buildFragment`
instead.

## error UnexpectedDatasetHash

Constructor-only: the supplied PunksData address reported a `datasetHash()`
other than `EXPECTED_DATASET_HASH`. Prevents deploying the cache against
an impostor dataset. Never reachable on the live deployment.
