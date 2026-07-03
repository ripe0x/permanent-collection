---
contract: PunkSvgFragmentCache
slug: punk-svg-fragment-cache
deploymentsKey: punkSvgCache
title: PunkSvgFragmentCache
---

# summary

Public, permissionless on-chain cache of compact 24x24 SVG fragments derived
from the canonical CryptoPunks pixel data. Each cached entry is one Punk's
full tile as SVG path markup (one `<path>` per distinct opaque color, with
one closed subpath per maximal horizontal pixel run), stored in a dedicated
SSTORE2 storage contract. Anyone can pay gas to bake a Punk via
`cachePunk(punkId)`; once baked, the fragment is permanent. There is no
admin, no setter, no upgrade path, and the contract holds no funds.

The cache derives bytes exclusively from the sealed PunksData contract at
{{addr:punksData}} (`indexedPixelsOf` plus `paletteRgbaBytes`), pinned at
construction by its dataset hash, never from caller-supplied data. So a
cached fragment is a pure, reproducible function of the sealed dataset:
anyone can verify a bake by comparing `fragmentOf(punkId)` against the live
re-derivation `buildFragment(punkId)`.

In the protocol the cache is a render accelerator for the two renderers. The
Mosaic renderer draws a collected trait's cell from the first-vaulted Punk's
fragment, and the Proof renderer draws a minted Proof's faint background
Punk layer from the same fragment. Both read the cache when the Punk is
baked and fall back to the on-the-fly derivation when it isn't, so renders
work either way and cached versus uncached output is byte-identical. The
cache is also a standalone public good: any project that wants compact
on-chain Punk tiles can read or extend this same instance.

# concepts

### How the renderers consume it

Both renderers use the same consult-then-fallback read:

```solidity
bytes memory frag = punkSvgCache.isCached(punkId)
    ? punkSvgCache.fragmentOf(punkId)   // one SLOAD + one SSTORE2 read
    : punkSvgCache.buildFragment(punkId); // live derivation from PunksData
```

The Mosaic renderer at {{addr:renderer}} does this once per collected trait
cell when composing `tokenURI(111)` (the Vault Title image). The Proof
renderer does it once per minted Proof `tokenURI` for the 5%-opacity
background layer. Fragments are coordinate-local (`x`/`y` in 0..23), so
consumers wrap them in `<g transform="translate(cx cy)">...</g>` to place
them in a larger composition, or call `svgOf(punkId)` for a standalone
24x24 tile.

### Who warms the cache, and why

`cachePunk` is fully permissionless: any account can bake any Punk at any
time, and the call is idempotent. The intended cadence is one bake per
vaulting: after a trait is collected, anyone calls the Mosaic renderer's
`cacheTrait(traitId)` wrapper, which resolves the trait's first-vaulted Punk
from `PermanentCollection.firstVaultedPunk` and forwards to
`cachePunk(punkId)` here. Calling `cachePunk` directly with the Punk id is
equivalent. No team coordination is required; the cache "turns on" entry by
entry as bakes accumulate.

### Gas: bake once, read forever

An uncached read (`buildFragment`, or a renderer falling back to it) walks
the full 576-pixel indexed buffer plus a 256-entry palette and typically
costs a few million gas per Punk. A cached read is one storage load plus an
SSTORE2 `EXTCODECOPY`, roughly 50k gas. That difference matters because
marketplace `tokenURI` fetches are `eth_call`s with provider-side gas
budgets (Alchemy defaults to 150M, Infura around 125M, many public
endpoints around 50M): a Vault Title render with many uncached collected
cells can exceed those budgets, while a warm cache keeps it comfortably
inside them. The bake itself pays the derivation once plus the SSTORE2
deploy (proportional to fragment byte length); after that every consumer
reads for cheap, forever.

A chain reorg that drops a bake transaction also drops the SSTORE2 pointer.
That's benign: `isCached` returns false again, renderers fall back to the
on-the-fly path, and anyone can re-bake in a new transaction.

### Checking and warming from the command line

```bash
# Is Punk 8348 baked?
cast call {{addr:punkSvgCache}} "isCached(uint16)(bool)" 8348 \
  --rpc-url https://ethereum-rpc.publicnode.com

# Bake it (any funded account)
cast send {{addr:punkSvgCache}} "cachePunk(uint16)" 8348 \
  --rpc-url https://ethereum-rpc.publicnode.com --private-key $PRIVATE_KEY

# Read the standalone SVG
cast call {{addr:punkSvgCache}} "svgOf(uint16)(string)" 8348 \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function cachePunk

access: permissionless

Bakes `punkId`'s SVG fragment into a fresh SSTORE2 storage contract and
records the pointer. Reverts `InvalidPunkId` for `punkId >= 10000`. If the
Punk is already cached the call is a cheap no-op that returns the existing
pointer without redeploying, so double-bakes and races between keepers waste
little gas and never corrupt state. Otherwise it derives the fragment from
PunksData (the same bytes `buildFragment` returns), reverts `EmptySvg` if
the derivation came back empty (unreachable for a real Punk), writes the
bytes via SSTORE2, stores the pointer, and emits `PunkCached`. Once written
an entry can never be changed or removed. Expect a few million gas for the
derivation plus the SSTORE2 deploy cost proportional to the fragment's byte
length.

## function EXPECTED_DATASET_HASH

The pinned PunksData dataset hash, constant
`0x92117ce6cb6bb70f9ffb9bf51ebbca6a84eae10e70639295d9c4a07958cd1f68`. The
constructor rejects any `punksData` whose `datasetHash()` doesn't match, so
the cache can only ever derive from the sealed dataset. Same value pinned by
`PermanentCollection.EXPECTED_DATASET_HASH`.

## function PUNK_DIM

Width and height of a Punk tile in pixels, constant `24` per the 2017
CryptoPunks specification. Fragment coordinates are in the 0..23 range.

## function buildFragment

Live, cacheless re-derivation of `punkId`'s fragment: the exact bytes
`cachePunk` would store, computed fresh from PunksData on every call.
Reverts `InvalidPunkId` for `punkId >= 10000`. This is the fallback path
both renderers take for an uncached Punk, so a render is never blocked on a
bake, just slower. Costs a few million gas per call; a `tokenURI` view that
falls back for many Punks at once can run into provider `eth_call` gas
budgets, which is exactly what baking avoids. The identity
`buildFragment(p) == fragmentOf(p)` for every baked `p` is what keeps
cached and uncached renders byte-identical.

## function fragmentOf

Raw cached fragment bytes for `punkId`: SVG path markup with one `<path>`
per distinct opaque color the Punk uses, each packing that color's maximal
horizontal pixel runs as closed 1-pixel-tall subpaths, coordinates in the
0..23 range. Reverts `NotCached` if the Punk hasn't been baked. This is the
read the renderers use on the fast path; embed the bytes directly inside an
`<svg>` or a positioned `<g>` wrapper.

## function isCached

True iff `punkId` has been baked. The cheap existence probe consumers
should call before choosing between `fragmentOf` (cached) and
`buildFragment` (live). Never reverts; an out-of-range id simply returns
false.

## function pointerOf

The SSTORE2 storage-contract address holding `punkId`'s fragment. Reverts
`NotCached` if unbaked. For callers that want to compose at the SSTORE2
layer (or verify the pointer's code) rather than materializing the bytes
through this contract.

## function punksData

The immutable PunksData source of pixel and palette data,
{{addr:punksData}}, validated against `EXPECTED_DATASET_HASH` at
construction. Every fragment, cached or live, derives from this contract
alone.

## function svgOf

Convenience view: the cached fragment wrapped in a standalone
`<svg viewBox="0 0 24 24">` element, ready to render as-is. Reverts
`NotCached` if the Punk hasn't been baked. Useful for previewers, tests,
and any consumer that wants a complete tile rather than a composable
fragment.

## event PunkCached

Emitted exactly once per Punk, on its first successful `cachePunk`, with
the Punk id (indexed), the SSTORE2 pointer address (indexed), and the
fragment byte length. Idempotent re-calls don't re-emit. An indexer can
reconstruct the full cache state (which Punks are baked and where) from
this event alone; after a reorg drops a bake, the re-bake emits a fresh
event with a new pointer.

## error EmptySvg

`cachePunk` derived an empty fragment, meaning PunksData returned an
all-transparent 24x24 tile for the id. Defense in depth: no real Punk is
all-transparent, so this is unreachable against the sealed dataset.

## error InvalidPunkId

`cachePunk` or `buildFragment` was called with `punkId >= 10000`. Use a
valid CryptoPunks index (0..9999).

## error NotCached

`pointerOf`, `fragmentOf`, or `svgOf` was called for a Punk that has never
been baked. Check `isCached` first, or fall back to `buildFragment` for a
live derivation, or bake it with `cachePunk`.

## error UnexpectedDatasetHash

Constructor-only: the supplied PunksData address reported a `datasetHash()`
other than `EXPECTED_DATASET_HASH`. Prevents deploying the cache against an
impostor dataset. Never reachable on the live deployment.
