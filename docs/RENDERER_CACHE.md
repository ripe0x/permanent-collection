# Trait-icon cache — design and operating model

**Status**: deployed at launch, empty. Permissionless bakes fill the
cache over time. No admin coordination required; no hard deadline.

## What it is

`TraitIconCache` is a public-good companion to `PunkSvgFragmentCache`:

| | `PunkSvgFragmentCache` | `TraitIconCache` |
|---|---|---|
| Caches | Whole-Punk SVG fragments | The 111 trait-icon SVG fragments |
| Used in renderer for | Collected cells | Uncollected / pending cells |
| Number of entries | up to 10,000 (one per Punk) | 111 (one per trait) |
| Bake authority | Permissionless | Permissionless |
| Admin | None | None |
| Upgrade path | None | None |

The cache stores byte-identical fragments to what the renderer's
on-the-fly compute path would produce. The renderer (see
`PermanentCollectionMosaicRenderer._traitIconContent`) consults the
cache first and falls back to on-the-fly compute when an entry is
missing. Both paths produce the same bytes, so cached and uncached
renders are visually indistinguishable.

## Why this shape (vs a renderer swap)

We considered three approaches:

1. **No code change** — current renderer is on-the-fly only; deploy a
   v2 renderer + cache later, swap via `RendererRegistry`. Requires a
   1-year deadline + admin coordination.
2. **Admin-settable cache pointer** — renderer is cache-aware now;
   pointer is set later. Adds a new admin surface to the renderer.
3. **Immutable cache, deployed empty** ✅ — renderer is cache-aware
   from launch; cache exists from launch; bakes happen permissionlessly
   over time.

Approach (3) wins on every dimension:
- No new admin surface.
- No 1-year deadline pressure.
- Bakes are the cache's "activation" — no team coordination required.
- The cache is a usable public good from block 1, even before our team
  bakes anything.
- Symmetric with the existing `PunkSvgFragmentCache` pattern.

The only "cost" of doing this now: the cache contract has to ship
empty at launch. That's free.

## Gas profile

Per-render cost of `tokenURI()` as a function of cache state:

| State | Cache hits / 111 traits | Approx tokenURI gas |
|---|---|---|
| Fresh deploy, no bakes | 0 / 111 | ~500M |
| 25 bakes | 25 / 111 | ~390M |
| 50 bakes | 50 / 111 | ~280M |
| 75 bakes | 75 / 111 | ~170M |
| 100 bakes | 100 / 111 | ~60M |
| All 111 baked | 111 / 111 | ~30M |

Each cached read replaces a ~5M-gas on-the-fly compute with a ~50k-gas
SSTORE2 read. As traits get collected by the protocol, those cells
shift to `PunkSvgFragmentCache` lookups (also cheap), so the gas
curve drops further. At full collection, `tokenURI()` is ~30M gas
regardless of how many trait icons are cached, because no uncollected
cells remain — measured 29.3M on the fork.

## Cost to bake all 111 traits

| Trait class | Count | Per-bake gas | Subtotal |
|---|---|---|---|
| Type / HeadVariant (canonical Punk RLE) | 16 | ~5.2M | ~83M |
| AttributeCount (dot strip) | 8 | ~0.6M | ~5M |
| Accessory (canonical-vs-baseline diff) | 87 | ~5.1M | ~444M |
| **Total** | **111** | | **~532M** |

At 0.5 gwei: ~**0.27 ETH** to bake all 111. Each bake is its own
transaction; the team can do them all at deploy time, or seed a few
and let community keepers fill in the rest as they care to. Either
way the bakes are amortized.

## Operating model

After mainnet deploy:

1. The cache contract exists at a known address (in `deployments.json`
   under `traitIconCache`).
2. `tokenURI()` works from block 1 — OpenSea renders the artwork
   because their `eth_call` budget tolerates the ~500M empty-state
   cost.
3. Wallets / Etherscan / other consumers using tighter `eth_call`
   budgets (Geth default ~50M, Alchemy default ~550M) initially see
   broken images on most cells.
4. **Anyone** can call `traitIconCache.cacheTrait(traitId)` to bake
   an icon. Cost ~$1-10 per trait at typical gas prices.
5. As bakes accumulate, more consumers start rendering successfully.
   Once all 111 are baked, the artwork is visible everywhere.

There is no point at which the cache becomes inaccessible. There is
no admin lockout. The cache contract is immutable.

## Reorg behaviour

Cache state IS affected by chain reorgs. Each `cacheTrait(traitId)`
call deploys a fresh SSTORE2 storage contract via CREATE, so the
pointer's address is a function of the deployer's nonce. A reorg
that drops the bake transaction also drops the pointer's deploy.
After the reorg:

- `traitIconCache.isCached(traitId)` returns `false`.
- `pointerOf(traitId)` reverts with `NotCached`.
- The renderer's `tokenURI()` consults the cache, finds nothing,
  and falls through to the on-the-fly compute path. The render
  still works, just back to the slow (~5M gas / cell) path.

This is benign. The cache is idempotent and permissionless, so any
keeper — including the original baker — can re-bake the trait
permissionlessly in a new transaction. There's no team coordination
required and no funds at risk. The protocol's on-chain state
(`collectedMask`, `pendingMask`, etc.) is the ground truth; the
cache is a performance accelerator that re-establishes itself
naturally as bakers retry.

A deep reorg of length N that drops M bakes results in:
- the renderer temporarily reverting to the on-the-fly compute path
  for those M traits (no user-visible artwork outage — just slower
  off-chain consumers),
- the original bakers reissuing the txs and reinstating the cache
  entries within the next few blocks.

No PR-worthy event. No incident response needed. Just keep an eye
on `TraitCached` event volume after a known reorg if you're curious.

## Why it's a public good

Anyone reading from `traitIconCache.fragmentOf(traitId)` gets back
raw SVG bytes for the canonical trait visual. Consumers don't need to
know anything about the PERMANENT COLLECTION protocol — they just
read the trait they want.

Potential consumers:

- **Trait galleries / explainers**: render all 111 icons as visual
  chips.
- **Punk-specific trait views**: given a Punk's trait mask, render
  each of its traits as separate icons.
- **Marketplace filtering UIs**: show a trait icon next to each
  filter pill.
- **Forks of our protocol**: any project running a similar trait-
  coverage art mechanism gets a complete trait-icon library for free.
- **Print / merchandise generators**: reproducible vector output for
  any trait.

The cache derives bytes from sealed `PunksData` + a pinned
`CANONICAL_IDS` table. Anyone can independently reproduce the same
output if they want to verify or skip the cache entirely.

## Interface

```solidity
interface ITraitIconCache {
    function TOTAL_TRAITS() external view returns (uint8);              // 111
    function punksData() external view returns (address);
    function canonicalPunkForTrait(uint8 traitId) external pure returns (uint16);
    function isCached(uint8 traitId) external view returns (bool);
    function pointerOf(uint8 traitId) external view returns (address);  // SSTORE2 pointer
    function fragmentOf(uint8 traitId) external view returns (bytes memory);  // raw SVG bytes
    function svgOf(uint8 traitId) external view returns (string memory);      // standalone preview
    function cacheTrait(uint8 traitId) external returns (address pointer);
    event TraitCached(uint8 indexed traitId, address indexed pointer, uint256 byteLength);
}
```

`fragmentOf` returns raw rect markup (no outer `<g transform>` or
positioning) — consumers wrap it as they need.

## References

- `contracts/src/TraitIconCache.sol` — implementation.
- `contracts/src/PunkSvgFragmentCache.sol` — sibling cache for whole
  Punks; same shape and design rationale.
- `contracts/src/PermanentCollectionMosaicRenderer.sol` — see
  `_traitIconContent` for the consult-cache-then-fallback path.
- `contracts/test/TraitIconCache.t.sol` — full coverage including
  bounds, idempotency, no-admin properties, cross-instance
  reproducibility.
- Probe contract:
  [0xC6736a2c6aB54D6DFd9787F2335282CBF51135a0](https://etherscan.io/address/0xC6736a2c6aB54D6DFd9787F2335282CBF51135a0) —
  the throwaway research tool used to measure consumer `eth_call`
  budgets, which informed the cache-from-launch decision.
