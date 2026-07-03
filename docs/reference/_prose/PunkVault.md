---
contract: PunkVault
slug: punk-vault
deploymentsKey: punkVault
title: PunkVault
---

# summary

`PunkVault` is the immutable terminal custodian for vaulted Punks. When a
72-hour return auction ends with no bid, the `ReturnAuctionModule` transfers
the Punk to the vault's address on the 2017 CryptoPunks market and calls
`receivePunk`. From that point the Punk is permanently held: the vault's
bytecode contains no path to any market write function (`transferPunk`,
`offerPunkForSale`, `acceptBidForPunk`, or any other), so no key, role, or
future contract can move a vaulted Punk.

The vault is also a solmate ERC721 contract (name
`Title to PERMANENT COLLECTION Vault`, symbol `PERMANENTCOLLECTION`) issuing
the protocol's 112 named tokens: the 111 **Proofs** (token ids 0..110, one per
first-vaulting of a previously uncollected trait, where `tokenId == traitId`)
and the one-of-one **Vault Title** (token id 111). Token ids 112 and above are
unreachable from any code path. The Proofs and the Title are ordinary
transferable ERC721 tokens; the no-exit guarantee applies to the Punks, not to
these role-of-record tokens.

The vault has no admin functions. Its two wiring slots (`titleAuction`,
`rendererRegistry`) are deployer-only one-shot setters that lock after first
use, and its ERC-173 `owner()` slot is a marketplace-editor handle with zero
on-chain authority and a one-way `renounceOwnership()`.

# concepts

### Punks are not ERC721 tokens

CryptoPunks predate ERC721. A vaulted Punk is held as a plain ownership entry
at the market's `punkIndexToAddress(punkId)` slot, with the vault's address as
the owner. Nothing about a vaulted Punk appears in this contract's ERC721
accounting: `balanceOf`, `ownerOf`, `totalSupply`, and the transfer surface
cover only the Proofs and the Title. To enumerate vaulted Punks, index the
`PunkLocked` event log or read `isLocked(punkId)` / `lockedPunkCount()`.

### Two minters, disjoint id ranges

The two token classes are issued by two distinct immutable minters whose id
ranges cannot overlap:

- `returnAuctionModule` (set at construction, never rotatable) is the only
  caller of `receivePunk` and `mintProofs`. `mintProofs` can only produce
  token ids 0..110 (the id is derived from the trait id, which is checked
  against `PROOF_COUNT`), at most once per trait
- `titleAuction` (wired once via `setTitleAuction`) is the only caller of
  `mintToAuction`, which mints exactly token id 111, at most once

Neither minter has a path into the other's range, and no path mints an id
at or above 112.

### Proof metadata is frozen at mint

Each Proof records a `ProofMeta` struct at mint time: the `punkId` whose
vaulting brought the trait into the collection, the `traitId` (equal to the
token id), the 1-based `sequence` in collection order, and `mintedAtBlock`.
All four fields are written once and never change, even when the Proof is
transferred. The immutable contribution record and the current holder are
separate questions: read `proofMeta(tokenId)` for the former, `ownerOf(tokenId)`
for the latter. `sequence` diverges from `tokenId` because traits are vaulted
in an arbitrary order, not in trait-id order.

Proofs are minted with `_mint`, not `_safeMint`. There is no
`onERC721Received` callback, so a contract recipient without receiver support
still gets its Proof, and no recipient can grief a Punk's settlement by
reverting in a callback.

### tokenURI dispatch through the RendererRegistry

`tokenURI(id)` and `contractURI()` hold no metadata themselves. After local
existence checks, both delegate to the wired `RendererRegistry`, which
forwards to the live renderer implementation. The renderer dispatches on the
id: ids 0..110 resolve to the Proof renderer, id 111 to the Title JSON.
`contractURI()` resolves to the same content as the Title's `tokenURI(111)`.
Queries for unminted tokens revert (`UnknownTokenId` for an unminted Proof id,
`TitleNotMinted` for id 111 before the Title exists); there is no preview
envelope.

### The owner() slot: marketplace editor only, one-way ratchet

The vault exposes ERC-173 `owner()` solely so OpenSea, Blur, and Magic Eden
recognize a wallet as the collection-page editor (banner, profile image,
description override, social links). The slot is initialized to the deployer
EOA at construction and is only ever settable to `address(0)` via
`renounceOwnership()`. There is intentionally no `transferOwnership`: once
renounced, no key compromise can re-acquire the editor surface. The owner has
zero on-chain authority. It gates no vault function, cannot touch the Punks,
and does not control the metadata content (which comes from the
`RendererRegistry`).

### Metadata refresh signals

The vault emits ERC-7572 `ContractURIUpdated()` on the Title mint and on every
Proof mint, since both change the collection-progress fields marketplaces
display, and EIP-4906 `MetadataUpdate(tokenId)` when a token's rendered
attributes may have changed (each mint, plus `MetadataUpdate(111)` on every
`receivePunk` once the Title exists, because the Title's attributes include the
vaulted-Punk count). `supportsInterface` advertises EIP-4906 (`0x49064906`) so
indexers know to listen.

### Live reads

```bash
# Proofs issued so far (0..111)
cast call {{addr:punkVault}} "totalProofsMinted()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# Frozen metadata for Proof token id 20 (trait 20):
# (punkId, traitId, sequence, mintedAtBlock)
cast call {{addr:punkVault}} \
  "proofMeta(uint256)(uint16,uint8,uint16,uint64)" 20 \
  --rpc-url https://ethereum-rpc.publicnode.com
```

`proofMeta` returns all zeros for an unminted id; check
`isProofMinted(traitId)` first to distinguish "not yet minted" from a Proof
genuinely minted with zero-valued fields (only Punk #0 as the acquired Punk
could make `punkId` zero, and `mintedAtBlock` is never zero for a real mint).

## function receivePunk

access: returnAuctionModule-only (`NotReturnAuction` for any other caller)

Registers a Punk as permanently vaulted. The caller must have already executed
`transferPunk(vault, punkId)` on the CryptoPunks market; `receivePunk` verifies
current market ownership via `punkIndexToAddress` and reverts
`NotOwnedByVault(punkId)` if the vault isn't the holder. Reverts
`AlreadyLocked(punkId)` if the Punk was already registered. On success it sets
`isLocked[punkId]`, increments `lockedPunkCount`, emits `PunkLocked(punkId)`,
and, once the Title has been minted, emits `MetadataUpdate(111)` so indexers
refresh the Title's attributes (which include the vaulted-Punk count).

There is no reverse operation. No function on this contract can release a
Punk, and the bytecode contains no CryptoPunks market write selector.

## function mintProofs

access: returnAuctionModule-only (`NotReturnAuction` for any other caller)

Mints the Proof for `targetTraitId` as token id `uint256(targetTraitId)`
(ids 0..110) to `recipient`, the `originalSeller` recorded on the acquisition
whose vault-settle produced this Proof. Called by `ReturnAuctionModule.settle`
atomically with the vaulting when the settle is the first vaulting of a
previously uncollected trait; a revert here rolls back the entire settle.

Checks, in order: caller gate, `InvalidTraitId` if `targetTraitId >= 111`,
`InvalidRecipient` if `recipient == address(0)`, `ProofAlreadyMinted` if the
trait's bit is already set in `proofsMintedMask`. On success it sets the bit,
increments `proofsMintedCount`, writes the frozen `proofMeta` record
(`punkId`, `traitId`, `sequence`, `block.number`), and mints with `_mint` (no
`onERC721Received` callback, so a contract recipient can neither be stranded
nor grief the settle). Emits `ProofMinted`, the ERC721 `Transfer` from
`address(0)`, `MetadataUpdate(tokenId)`, and `ContractURIUpdated()`.

`acquisitionId` (the 0-based index into `PermanentCollection`'s acquisition
log) and `sequence` (the 1-based collection order at mint time) are recorded
verbatim; the vault does not re-derive them.

## function mintToAuction

access: titleAuction-only (`NotTitleAuction` for any other caller)

Mints the Vault Title (token id 111) to the `titleAuction` contract itself,
which escrows it for its auction. One-shot: reverts `TitleAlreadyMinted` on
any second call. Emits `TitleMinted(titleAuction)`, the ERC721 `Transfer`,
`MetadataUpdate(111)`, and `ContractURIUpdated()`. Reachable permissionlessly
through the title auction's own idempotent `mintTitle()` entry point; the
vault only checks that the immediate caller is the wired auction.

## function setTitleAuction

access: deployer one-shot (`NotDeployer` for others; `TitleAuctionAlreadySet`
once wired)

Binds the `titleAuction` address exactly once. Reverts `ZeroAddress` for
`address(0)`. After this call `mintToAuction` is callable only by the bound
address and the slot can never be changed. Emits `TitleAuctionSet`. Part of
the deploy broadcast; already executed on mainnet.

## function setRendererRegistry

access: deployer one-shot (`NotDeployer` for others;
`RendererRegistryAlreadySet` once wired)

Binds the `RendererRegistry` address exactly once. Reverts `ZeroAddress` for
`address(0)`. After this call `tokenURI` and `contractURI` delegate to the
registry and the slot can never be changed (the registry itself fronts a
swappable renderer implementation until its own freeze). Emits
`RendererRegistrySet`. Part of the deploy broadcast; already executed on
mainnet.

## function renounceOwnership

access: owner-only (`NotOwner` for any other caller)

Permanently sets the ERC-173 `owner()` slot to `address(0)` and emits
`OwnershipTransferred(previousOwner, address(0))`. One-way: there is no
`transferOwnership`, so no address can ever hold the slot again, and
marketplaces will refuse all future collection-page edits. The slot carries no
on-chain authority, so renouncing changes nothing about the vault's behavior.

## function approve

access: permissionless (token owner or an `isApprovedForAll` operator; solmate
reverts `NOT_AUTHORIZED` otherwise)

Standard ERC721 single-token approval for a Proof or the Title. No
protocol-specific behavior.

## function setApprovalForAll

access: permissionless (sets the caller's own operator flag)

Standard ERC721 operator approval covering all of the caller's PunkVault
tokens. No protocol-specific behavior.

## function transferFrom

access: permissionless (owner, approved spender, or operator of `id`)

Standard solmate ERC721 transfer of a Proof or the Title. Uses string
reverts from the solmate base for the standard failure modes (`WRONG_FROM`,
`NOT_AUTHORIZED`, `INVALID_RECIPIENT` for a zero `to`). Transferring a Proof
moves ownership only; its `proofMeta` record is frozen and travels with the
token id, not the holder. Transferring the Title moves titular ownership of
the vault (a display-side role; it grants no claim on the Punks and no
authority over any contract).

## function safeTransferFrom(address,address,uint256)

access: permissionless (owner, approved spender, or operator of `id`)

`transferFrom` plus the ERC721 receiver check: if `to` is a contract it must
return the `onERC721Received` selector (solmate reverts `UNSAFE_RECIPIENT`
otherwise). No protocol-specific behavior.

## function safeTransferFrom(address,address,uint256,bytes)

access: permissionless (owner, approved spender, or operator of `id`)

Same as the 3-argument form, forwarding `data` to the recipient's
`onERC721Received`. No protocol-specific behavior.

## function MAX_PROOF_TOKEN_ID

Constant `110`. Highest valid Proof token id; Proofs occupy ids
0..`MAX_PROOF_TOKEN_ID` inclusive with `tokenId == traitId`.

## function PROOF_COUNT

Constant `111`. Number of distinct Proofs, one per trait in the sealed
PunksData taxonomy.

## function TITLE_TOKEN_ID

Constant `111`. Token id of the one-of-one Vault Title, sitting just past the
Proof range.

## function balanceOf

Standard ERC721 balance over the vault's own tokens (Proofs + Title), not
Punks. Reverts (solmate `ZERO_ADDRESS`) for the zero address.

## function contractURI

ERC-7572 collection-level metadata JSON (data URI). Delegates to
`RendererRegistry.contractURI(address(this))`; resolves to the same content as
the Title's `tokenURI(111)`. Reverts `RendererRegistryNotSet` if the registry
was never wired.

## function getApproved

Standard ERC721 per-token approval getter. Raw mapping read: returns
`address(0)` for unminted ids rather than reverting.

## function isApprovedForAll

Standard ERC721 operator-approval getter. Raw mapping read.

## function isLocked

Per-Punk vaulted flag, keyed by Punk id. Once true, stays true forever. This
is the Punk-side record (distinct from the ERC721 accounting, which never
includes Punks).

## function isProofMinted

True iff the Proof for `traitId` has been minted. Returns `false` (rather than
reverting) for `traitId >= 111`. Cheaper than `ownerOf(traitId)`, which
reverts pre-mint. Use this to guard `proofMeta` reads.

## function lockedPunkCount

Count of permanently vaulted Punks. Monotonic. The per-Punk history is the
`PunkLocked` event log; there is no on-chain array accessor for the full list.

## function name

ERC721 name: `Title to PERMANENT COLLECTION Vault`.

## function owner

ERC-173 owner. The deployer EOA until `renounceOwnership()` is called, then
`address(0)` forever. Read by marketplaces to decide which wallet can edit the
collection page; carries no on-chain authority (see Concepts).

## function ownerOf

Standard ERC721 owner lookup for Proof ids 0..110 and the Title (111). Reverts
(solmate `NOT_MINTED`) for unminted or out-of-range ids. Never answers for
Punks; use `punksMarket.punkIndexToAddress(punkId)` for Punk custody.

## function proofMeta

Frozen per-Proof metadata, keyed by Proof token id: `(punkId, traitId,
sequence, mintedAtBlock)`. Written once at mint and never mutated, even across
transfers. Returns all zeros for an unminted id; check `isProofMinted` first.
See the Concepts section for a `cast` example.

## function proofsMintedCount

Number of Proofs minted so far (0..111). Equals
`popcount(proofsMintedMask)`, tracked explicitly so the renderer composes its
"N of 111" progress inscription in one read.

## function proofsMintedMask

Bitmap of minted Proofs: bit `traitId` is set iff that trait's Proof exists.
Single read for computing full issued-so-far state.

## function punksMarket

The 2017 CryptoPunks market contract
([0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB](https://evm.now/address/0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB?chainId=1)).
Immutable. Vaulted Punks live at this contract's `punkIndexToAddress` slot
with the vault as owner.

## function rendererRegistry

The wired `RendererRegistry` address that `tokenURI` and `contractURI`
delegate to. `address(0)` only before the one-shot `setRendererRegistry`
wiring (already executed on mainnet).

## function returnAuctionModule

The only address that may call `receivePunk` and `mintProofs`. Immutable,
set at construction (the deploy precomputes the module's CREATE address so the
two contracts can reference each other).

## function supportsInterface

ERC165. Advertises ERC721 (`0x80ac58cd`), ERC721Metadata (`0x5b5e139f`),
ERC165 itself (`0x01ffc9a7`), and EIP-4906 (`0x49064906`) so marketplaces know
to listen for `MetadataUpdate`.

## function symbol

ERC721 symbol: `PERMANENTCOLLECTION`.

## function titleAuction

The only address that may call `mintToAuction`. Wired once via the deployer
one-shot `setTitleAuction`.

## function titleMinted

True iff the Vault Title (token id 111) has been minted.

## function titleOwner

Current holder of the Vault Title. Returns `address(0)` before the Title is
minted; otherwise equivalent to `ownerOf(111)` (initially the title auction
contract, which escrows it until its auction settles).

## function tokenURI

Token metadata JSON (data URI) for a minted Proof (ids 0..110) or the minted
Title (id 111). Reverts `UnknownTokenId(id)` for an unminted Proof id or any
id at or above 112, `TitleNotMinted` for id 111 before the Title exists, and
`RendererRegistryNotSet` if the registry was never wired. Resolution delegates
to `RendererRegistry.tokenURI(id)`, which forwards to the live renderer; the
renderer dispatches on the id (Proof renderer for 0..110, Title JSON for 111).

## function totalProofsMinted

Number of Proofs minted so far, as `uint256` (same value as
`proofsMintedCount`). Caps at 111.

## function totalSupply

Total PunkVault-issued ERC721 tokens: minted Proofs plus the Title if minted
(maximum 112). For marketplaces and indexers without ERC721Enumerable. Does
not count vaulted Punks; that's `lockedPunkCount`.

## event Approval

Standard ERC721 single-token approval event for Proofs and the Title.

## event ApprovalForAll

Standard ERC721 operator-approval event.

## event ContractURIUpdated

ERC-7572 collection-metadata refresh hint. Emitted on the Title mint and on
every Proof mint, since each changes the collection-progress fields
(`totalSupply`, the renderer's "N of 111" inscription, the Title JSON's
progress attributes). Marketplaces that honor ERC-7572 re-fetch
`contractURI()` on this event instead of waiting on poll cadence.

## event MetadataUpdate

EIP-4906 per-token metadata refresh hint. Emitted with the minted token's id
on each mint, and with id 111 on every `receivePunk` once the Title exists
(the Title's rendered attributes include the vaulted-Punk count). Indexers
should re-fetch `tokenURI(_tokenId)`.

## event OwnershipTransferred

ERC-173 ownership transition. Exactly two emissions are possible over the
contract's lifetime: `(address(0) → deployer)` at construction and
`(deployer → address(0))` at `renounceOwnership()`.

## event ProofMinted

Emitted once per Proof, alongside the ERC721 `Transfer` from `address(0)`.
Indexers should read: `tokenId` (= `traitId`, 0..110), `punkId` (the Punk
whose vaulting brought the trait in), `recipient` (the `originalSeller` who
gave up the Punk), `acquisitionId` (0-based index into `PermanentCollection`'s
acquisition log), `sequence` (1-based collection order, diverges from
`tokenId`), and `mintedAtBlock`. The same values are frozen in
`proofMeta(tokenId)`.

## event PunkLocked

Emitted exactly once per Punk that enters the vault. By design there is no
counterpart "released" event; the `PunkLocked` log is the canonical
append-only list of vaulted Punks.

## event RendererRegistrySet

Emitted once, at the one-shot `setRendererRegistry` wiring.

## event TitleAuctionSet

Emitted once, at the one-shot `setTitleAuction` wiring.

## event TitleMinted

Emitted once, at Title mint time, with the title auction contract as `to`.
Mirrors the ERC721 `Transfer(address(0), titleAuction, 111)` for indexers
that key on a protocol-specific event name.

## event Transfer

Standard ERC721 transfer event for Proofs and the Title, including the
mint-time transfers from `address(0)`. Never fired for Punks; Punk movements
are events on the CryptoPunks market contract.

## error AlreadyLocked

`receivePunk` was called for a Punk already registered as vaulted. Each Punk
locks at most once; there is nothing for the caller to do.

## error InvalidRecipient

`mintProofs` was called with `recipient == address(0)`. Defense in depth:
`PermanentCollection.recordAcquisition` already enforces a non-zero
`originalSeller`.

## error InvalidTraitId

`mintProofs` was called with `traitId >= 111`. Trait ids run 0..110; the id
is out of the taxonomy.

## error NotDeployer

`setTitleAuction` or `setRendererRegistry` was called by an address other
than the deployer EOA. These are launch-wiring functions, not integrator
surface.

## error NotOwnedByVault

`receivePunk` ran before the Punk was actually transferred to the vault on
the CryptoPunks market. The module must execute `transferPunk(vault, punkId)`
first; the check keeps the vaulted list honest.

## error NotOwner

`renounceOwnership` was called by an address other than the current
`owner()`. Once renounced, no caller can ever satisfy the check again.

## error NotReturnAuction

`receivePunk` or `mintProofs` was called by an address other than the
immutable `returnAuctionModule`. These functions aren't callable by
integrators.

## error NotTitleAuction

`mintToAuction` was called by an address other than the wired `titleAuction`
contract. Use the title auction's own `mintTitle()` entry point.

## error ProofAlreadyMinted

`mintProofs` was called for a trait whose Proof already exists. Each trait's
Proof mints exactly once, at the trait's first vaulting.

## error RendererRegistryAlreadySet

Second call to the one-shot `setRendererRegistry`. The registry slot is
write-once.

## error RendererRegistryNotSet

`tokenURI` or `contractURI` was called before the registry was wired. Not
reachable on mainnet: the wiring is part of the deploy broadcast.

## error TitleAlreadyMinted

Second call to `mintToAuction`. The Title is a one-of-one; it mints exactly
once.

## error TitleAuctionAlreadySet

Second call to the one-shot `setTitleAuction`. The title-auction slot is
write-once.

## error TitleNotMinted

`tokenURI(111)` was queried before the Title exists. Check `titleMinted()`
before querying, or treat the revert as "not yet issued".

## error UnknownTokenId

`tokenURI(id)` was queried for an unminted Proof id (0..110 with its
`proofsMintedMask` bit unset) or any id at or above 112. For Proof ids, check
`isProofMinted(uint8(id))` before querying.

## error ZeroAddress

A constructor argument or one-shot wiring target (`setTitleAuction`,
`setRendererRegistry`) was `address(0)`.
