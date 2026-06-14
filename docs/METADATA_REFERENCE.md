# Metadata Reference — ERC20 + NFTs

Single reference for every piece of on-chain metadata the protocol serves:
**name, description, attributes, image** for the **111 ERC20** and for
the **PunkVault ERC721 tokens** (the Title + 111 Proofs), plus the
`tokenURI` / `contractURI` plumbing and the SVG images each embeds.

Everything here is generated **on-chain**. There are no off-chain JSON
files, no IPFS, no hosted images. Marketplaces read these strings directly
from the contracts.

> Source of truth: derived from the contracts as committed. Names,
> descriptions, and attribute keys are quoted verbatim from the renderers.
> Live values (counts, ids, block numbers, the embedded image) are filled
> in at read time from chain state. If you change a renderer, update this
> doc in the same commit.

---

## 1. Routing — who serves what

Every metadata call funnels through `RendererRegistry` to the live
`PermanentCollectionMosaicRenderer`, which either answers directly or
delegates Proof ids to `PermanentCollectionProofRenderer`.

```
ERC20 111 (ArtCoinsToken)
  ├─ tokenURI()      ─┐
  └─ contractURI()   ─┴─► _resolveURI()
                            └─► RendererRegistry.contractURI(thisToken)
                                  └─► Mosaic.contractURI(token != vault)
                                        └─► _tokenURIZeroArg()   ← ERC20 JSON (§2)

PunkVault (ERC721, "PCVAULT")
  ├─ contractURI()   ──► RendererRegistry.contractURI(vault)
  │                        └─► Mosaic.contractURI(token == vault)
  │                              └─► _tokenURITitle()           ← collection JSON
  │                                  (byte-identical to the Title token, §3.1)
  └─ tokenURI(id)    ──► RendererRegistry.tokenURI(id)
                           └─► Mosaic.tokenURI(id)
                                 ├─ id 0..110  → ProofRenderer.tokenURI(id) ← Proof JSON (§3.2)
                                 │                 (reverts ProofNotMinted if that Proof is unminted)
                                 ├─ id 111     → _tokenURITitle()           ← Title JSON (§3.1)
                                 └─ id ≥ 112   → revert UnknownTokenId
```

Two pairs come out byte-identical by design:

- ERC20 `tokenURI()` ≡ ERC20 `contractURI()` (both call `_resolveURI()`).
- Vault `contractURI()` ≡ Title token `tokenURI(111)` (both resolve to
  `_tokenURITitle()`).

The registry is swappable by the admin until `freeze()` or the 1-year
admin lock, after which the renderer is permanent. Its `setImplementation`
interface probe staticcalls `tokenURI()`, `contractURI(address)`, and
`tokenURI(111)` (the Title) — **not** a Proof id, because an unminted Proof
reverts `ProofNotMinted` (no preview envelope) and no Proof is guaranteed
minted at swap time.

---

## 2. ERC20 — 111 (`ArtCoinsToken`)

### Static ERC20 fields

| Field | Value | Source |
|---|---|---|
| `name()` | `permanent collection` (lowercase) | `Deploy.s.sol` `TOKEN_NAME` |
| `symbol()` | `111` | `Deploy.s.sol` `TOKEN_SYMBOL` |
| `decimals()` | `18` | Solady `ERC20` default |
| total supply | `1_110_000_000e18` | `Deploy.s.sol` `TOKEN_TOTAL_SUPPLY` |
| `metadataRenderer()` | `RendererRegistry` address | factory token config |

> **Name casing is intentional and asymmetric.** The ERC20 `name()` returns
> lowercase `permanent collection` (what a wallet shows next to the
> balance). The metadata JSON `"name"` below is uppercase
> `PERMANENT COLLECTION` (what a marketplace collection page shows). Two
> different surfaces; they do not need to match.

### Metadata served by `tokenURI()` / `contractURI()`

**Name:**
```
PERMANENT COLLECTION
```

**Description:**
> PERMANENT COLLECTION is an ERC20 artwork built to assemble a permanent CryptoPunks collection representing all 111 collectable traits. Collected Punks are held in an immutable contract and can never be withdrawn.

**Attributes:**

| `trait_type` | `value` | JSON type | Source |
|---|---|---|---|
| `Traits Collected` | `<count>` | number | `PermanentCollection.collectedCount()` |
| `Traits Total` | `111` | number | constant |
| `Punks Vaulted` | `<vaulted>` | number | `PunkVault.lockedPunkCount()` |

**Image:** the shared mosaic SVG (see §4), embedded as a
`data:image/svg+xml;base64,…` URI.

Also carries a non-standard top-level `"symbol":"111"` field.

**Envelope:** `data:application/json;base64,<base64(json)>` (the
OpenSea-documented form); the inner image is a base64 SVG data URI. Decoded
JSON:

```json
{"name":"PERMANENT COLLECTION","symbol":"111","description":"PERMANENT COLLECTION is an ERC20 artwork built to assemble a permanent CryptoPunks collection representing all 111 collectable traits. Collected Punks are held in an immutable contract and can never be withdrawn.","image":"data:image/svg+xml;base64,<MOSAIC SVG>","attributes":[{"trait_type":"Traits Collected","value":<count>},{"trait_type":"Traits Total","value":111},{"trait_type":"Punks Vaulted","value":<vaulted>}]}
```

### Built-in default (fallback — NOT used at launch)

If the metadata renderer were ever unset, the token falls back to its own
builder using the constructor strings, which at launch are all empty:

```
data:application/json;base64,<base64 of {"name":"permanent collection","symbol":"111","description":"","image":""}>
```

Documented for completeness only; the renderer is wired at launch so this
is never served.

---

## 3. NFTs — PunkVault collection (`PCVAULT`)

`PunkVault` issues 112 ERC721 tokens: the **Title** (id 111) and **111
Proofs** (ids 0..110, where `tokenId == traitId`).

### Static ERC721 fields

| Field | Value |
|---|---|
| `name()` | `Title to PERMANENT COLLECTION Vault` |
| `symbol()` | `PCVAULT` |
| `totalSupply()` | `(titleMinted ? 1 : 0) + proofsMintedCount` |
| ERC-165 | adds EIP-4906 (`0x49064906`) over solmate's set |

### `tokenURI(id)` dispatch (from PunkVault)

| id | Vault pre-check | Resolves to |
|---|---|---|
| `0..110` (Proof) | reverts `UnknownTokenId` if Proof's bit unset in `proofsMintedMask` | Proof JSON (§3.2) |
| `111` (Title) | reverts `TitleNotMinted` if unminted | Title JSON (§3.1) |
| `≥ 112` | — | reverts `UnknownTokenId` |

`contractURI()` resolves to `_tokenURITitle()` (identical to id 111).

---

### 3.1 Title — token id 111

**Name:**
```
PERMANENT COLLECTION Vault Title
```

**Description:**
> Title to the PERMANENT COLLECTION vault. The vault is the immutable contract that holds the collected CryptoPunks. Owning this token records its holder as the title owner of the vault and grants no claim on the Punks, no withdrawal rights, and no administrative control.

**Attributes:**

| `trait_type` | `value` | JSON type | Source |
|---|---|---|---|
| `Punks Vaulted` | `<vaulted>` | number | `PunkVault.lockedPunkCount()` |
| `Traits Collected` | `<count>` | number | `PermanentCollection.collectedCount()` |
| `Traits Total` | `111` | number | constant |
| `Collection Complete` | `<Yes\|No>` | string | `PermanentCollection.isComplete()` → `"Yes"`/`"No"` |

**Image:** the shared mosaic SVG (see §4). Same image as the ERC20; only
the attributes differ (the Title adds `Collection Complete`).

**Envelope:** `data:application/json;base64,<base64(json)>`. Decoded JSON:

```json
{"name":"PERMANENT COLLECTION Vault Title","description":"Title to the PERMANENT COLLECTION vault. The vault is the immutable contract that holds the collected CryptoPunks. Owning this token records its holder as the title owner of the vault and grants no claim on the Punks, no withdrawal rights, and no administrative control.","image":"data:image/svg+xml;base64,<MOSAIC SVG>","attributes":[{"trait_type":"Punks Vaulted","value":<vaulted>},{"trait_type":"Traits Collected","value":<count>},{"trait_type":"Traits Total","value":111},{"trait_type":"Collection Complete","value":"<Yes|No>"}]}
```

---

### 3.2 Proofs — token ids 0..110 (`tokenId == traitId`)

Served by `PermanentCollectionProofRenderer`. Only a **minted** Proof has a
`tokenURI`; an unminted id reverts (there is no preview envelope — see the
Unminted Proof note below). Common live values: `<traitName>` =
`PunksData.traitName(traitId)` (e.g. `7 Attributes`, `Mohawk`); the rest
come from `PunkVault.proofMeta(id)`.

#### Minted Proof

**Name:** (uses the collection `sequence`, e.g. "Proof 47")
```
Permanent Collection Proof <sequence> (<traitName>)
```

**Description:**
> Proof that CryptoPunk \<punkId\> was added to Permanent Collection's immutable contract for the \<traitName\> trait.

**Attributes:**

| `trait_type` | `value` | JSON type | Source |
|---|---|---|---|
| `Trait` | `<traitName>` | string | `PunksData.traitName(traitId)` |
| `Trait ID` | `<traitId>` | number | the token id (0..110) |
| `Punk ID` | `<punkId>` | number | `proofMeta.punkId` (the Punk whose vaulting brought the trait in) |
| `Sequence` | `<sequence> of 111` | string | `proofMeta.sequence` (1-based collection order) |
| `Vaulted at Block` | `<mintedAtBlock>` | number | `proofMeta.mintedAtBlock` |
| `Status` | `Minted` | string | constant for this branch |

**Image:** the per-Proof SVG with the faint acquired-Punk layer (see §5).

**Envelope:** `data:application/json;base64,<base64(json)>`. Decoded JSON:

```json
{"name":"Permanent Collection Proof <sequence> (<traitName>)","description":"Proof that CryptoPunk <punkId> was added to Permanent Collection's immutable contract for the <traitName> trait.","image":"data:image/svg+xml;base64,<PROOF SVG>","attributes":[{"trait_type":"Trait","value":"<traitName>"},{"trait_type":"Trait ID","value":<traitId>},{"trait_type":"Punk ID","value":<punkId>},{"trait_type":"Sequence","value":"<sequence> of 111"},{"trait_type":"Vaulted at Block","value":<mintedAtBlock>},{"trait_type":"Status","value":"Minted"}]}
```

#### Unminted Proof — reverts (no metadata)

An unminted Proof has no metadata. Both `tokenURI` paths revert, by design:

- `PunkVault.tokenURI(id)` → `UnknownTokenId(id)` (gates on `proofsMintedMask`).
- `PermanentCollectionProofRenderer.tokenURI(id)`, and the Mosaic dispatch
  that forwards to it, → `ProofNotMinted(id)`.

The raw `ProofRenderer.svg(traitId)` view is the exception: it stays total
and renders the trait tile (icon alone, no Punk layer) for an unminted
trait, for tooling/QA. It is not a token-metadata accessor.

> Numeric attributes (`Trait ID`, `Punk ID`, `Vaulted at Block`) are
> emitted unquoted; `Sequence` is intentionally a quoted string
> `"N of 111"`.

---

## 4. The mosaic image (ERC20 + Title share it)

`Mosaic._renderSvg(collectedMask, pendingMask, collectedCount)`. A square
356×356 design canvas rasterized at 8× (`width`/`height` = `2848`,
`viewBox` stays `0 0 356 356`).

```
<svg xmlns="http://www.w3.org/2000/svg" width="2848" height="2848" viewBox="0 0 356 356" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#000"/> … cells … <footer> </svg>
```

Layout:

- An **11×10 grid** of 24×24 trait cells (28 px pitch, 24 px outer
  padding) covering 110 trait slots, plus **one pulled-out "final type"
  cell** (trait 4 / Zombie) at `(306, 306)`.
- A two-line **footer**: top line `"<count> / 111"` in dim `#6a6a6a`,
  bottom line `"PERMANENT COLLECTION"` in `#f5f5f5`, drawn in an inline
  5×7 pixel font.

Per-cell state (driven by `collectedMask` / `pendingMask`):

| State | Rendering |
|---|---|
| Uncollected | flat `#1c1c1c` cell + the trait icon |
| Pending (return auction live) | uncollected look + a 1-px dashed `#454545` border overlay |
| Collected | a `#8F918B` swatch + the vaulted Punk's pixel fragment |

`RendererRegistry.svg()` / `Mosaic.svg()` return this same SVG with no
JSON envelope, for off-chain tooling.

---

## 5. The Proof image (per Proof)

`ProofRenderer._renderSvg(traitId, punkId, minted)`. A 24×24 trait tile
with a 1-px frame and 1-px padding, `viewBox -2 -2 28 28`, rasterized at
100× (`width`/`height` = `2800`).

```
<svg xmlns="http://www.w3.org/2000/svg" width="2800" height="2800" viewBox="-2 -2 28 28" shape-rendering="crispEdges"><rect x="-2" y="-2" width="28" height="28" fill="#8F918B"/> … <rect … stroke="#DADAD7" …/></svg>
```

| State | Rendering |
|---|---|
| Minted | the acquired Punk drawn first at **5% opacity** (`<g opacity="0.05">`) as a faint background, the isolated trait icon composited crisply on top, then a 1-px `#DADAD7` frame |
| Unminted | the trait icon alone on the `#8F918B` background + the 1-px frame |

`ProofRenderer.svg(uint8 traitId)` returns this raw SVG (reflects live mint
state) and stays total — it renders the unminted-trait image too. Note the
unminted image is reachable **only** via `svg(traitId)`; `tokenURI(id)`
reverts `ProofNotMinted` for an unminted Proof. Not exposed through the
registry passthrough.

---

## 6. Refresh signals (events)

So marketplaces re-pull these strings without waiting on poll cadence:

| Event | Emitted by | On |
|---|---|---|
| ERC-7572 `ContractURIUpdated()` | `ArtCoinsToken` | image/metadata/renderer change |
| ERC-7572 `ContractURIUpdated()` | `PunkVault` | every Title mint + every Proof mint (changes the "N of 111" progress fields) |
| EIP-4906 `MetadataUpdate(tokenId)` | `PunkVault` | `receivePunk` (title attrs change) and Title/Proof mint |

---

## 7. Quick contract map

| Contract | Metadata role |
|---|---|
| `ArtCoinsToken` (111, artcoins submodule) | ERC20; `tokenURI()`/`contractURI()` delegate to the wired renderer |
| `PunkVault` | ERC721 issuer; `contractURI()` + `tokenURI(id)` delegate to the registry |
| `RendererRegistry` | stable front; swappable until freeze/admin-lock; probes the impl interface |
| `PermanentCollectionMosaicRenderer` | serves ERC20 JSON, Title JSON, the mosaic SVG; dispatches Proof ids |
| `PermanentCollectionProofRenderer` | serves the 111 Proof JSON envelopes + Proof SVGs |
| `PunksData` (`0x9cF9C8eA…117C`, sealed) | trait names + pixels + palette the images are built from |
| `TraitIconCache` / `PunkSvgFragmentCache` | on-chain SVG fragment caches (perf only; not metadata sources) |
