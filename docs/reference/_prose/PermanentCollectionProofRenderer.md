---
contract: PermanentCollectionProofRenderer
slug: proof-renderer
title: PermanentCollectionProofRenderer
---

# summary

On-chain SVG + JSON renderer for the 111 Proof NFTs issued by `PunkVault`
(token ids 0..110, where `tokenId == traitId` directly). Each Proof
attests to a single trait's first-vaulting and is minted to the address
that originally gave up the Punk. The image is composed entirely
on-chain: a 24×24 trait tile on a `#8F918B` background with a 1-px
`#DADAD7` frame. On a minted Proof the acquired Punk, the one whose
vaulting brought the trait in, is drawn first at 5% opacity as a
barely-visible background layer, with the isolated trait icon composited
crisply on top; an unminted Proof has no acquired Punk yet, so the raw
`svg(traitId)` view renders the trait icon alone.

The contract has no admin, no setters, and no storage beyond its
immutable references. Its address isn't in `deployments.mainnet.json`;
discover it on-chain via the mosaic renderer's `proofRenderer` accessor:
`cast call {{addr:renderer}} "proofRenderer()(address)" --rpc-url
https://ethereum-rpc.publicnode.com`. Canonical consumers never call it
directly anyway: `PunkVault.tokenURI(id)` goes through `RendererRegistry`
to the mosaic renderer, which delegates ids 0..110 here.

# concepts

### Minted vs unminted

The distinction lives in two places. In the image: `svg(traitId)` is
total over 0..110 and reflects live mint state, drawing the faint
acquired-Punk layer once the Proof is minted and the trait icon alone
before. In the metadata: `tokenURI(id)` exists only for a minted Proof
and reverts `ProofNotMinted` otherwise, with no preview envelope. That
mirrors the canonical `PunkVault.tokenURI` path, which reverts
`UnknownTokenId` for the same unminted ids, so no surface ever serves
metadata for a Proof that doesn't exist yet.

### What the metadata says

All per-Proof data comes from `vault.proofMeta(id)`, frozen at mint time,
plus the trait name from the sealed `PunksData` contract. The name is
`Permanent Collection Proof <traitId> (<traitName>)`, so the Proof number
matches the token id, not the order of collection. The description names
the CryptoPunk whose vaulting brought the trait in. Attributes: Trait
(the human-readable name), Trait ID (== token id), Punk ID, Sequence
(a string, "N of 111", the 1-based collection order), and Vaulted at
Block. The envelope is a `data:application/json;base64,` URI with the
image embedded as a base64 SVG data URI.

### How the image is built

The trait icon comes from `TraitIconCache.buildFragment(traitId)`, a pure
view that computes the fragment whether or not the trait has been baked
into the cache. The acquired-Punk layer comes from the same
`PunkSvgFragmentCache` the mosaic renderer uses, reading the baked
fragment when present and computing it live otherwise. Both fragments
live in the same 0..23 pixel coordinate space, so they overlay with no
scaling. The `viewBox` is `-2 -2 28 28` (tile + frame + 1-px pad) and
the intrinsic `width`/`height` are 2800, so a right-click "Copy Image"
rasterizes at high resolution while display sizing stays CSS-driven.

## function MAX_PROOF_TOKEN_ID

Highest valid Proof token id, a constant `110`. Proofs occupy 0..110 with
`tokenId == traitId`; id 111 is the Vault Title, which this contract
refuses to claim.

## function PROOF_COUNT

Total number of Proofs in the collection, a constant `111`. The cap never
changes.

## function punkSvgCache

The immutable public `PunkSvgFragmentCache` supplying the acquired Punk's
pixel fragment for the faint background layer on a minted Proof. The same
instance the mosaic renderer uses.

## function punksData

The immutable sealed `PunksData` contract, read for the human-readable
trait name inscribed in the Proof's metadata.

## function svg

Raw SVG payload for the Proof image at `traitId`, no JSON envelope.
Reverts `UnknownTokenId` for `traitId >= 111`. Total over the valid
range: it renders for unminted traits too (trait icon alone on the
background), and reflects live mint state, adding the 5%-opacity acquired
Punk once the trait's Proof is minted. The only surface that shows the
pre-mint image; useful for tooling and previews. Not exposed through the
registry passthrough.

## function tokenURI

The data-URI-encoded ERC721 JSON metadata for a minted Proof. Reverts
`UnknownTokenId(id)` for `id > 110` and `ProofNotMinted(id)` for an
in-range id whose Proof hasn't been minted (checked via
`vault.proofMeta(id).mintedAtBlock == 0`). For a minted Proof, returns
the base64 JSON envelope described in the concepts section: name,
description, the two-layer image, and the Trait / Trait ID / Punk ID /
Sequence / Vaulted at Block attributes.

## function traitIconCache

The immutable public `TraitIconCache` whose pure-view `buildFragment`
supplies the isolated trait icon, working for baked and unbaked traits
alike.

## function vault

The immutable `PunkVault` reference, read for `proofMeta(tokenId)` (punk
id, trait id, sequence, minted-at block) at render time. `proofMeta`
returns a zero-valued struct for a never-minted id, which is how this
renderer detects mint state.

## error ProofNotMinted

`tokenURI` was called for an in-range Proof id (0..110) that hasn't been
minted. There is no preview envelope; use `svg(traitId)` for the pre-mint
image.

## error UnknownTokenId

The id is outside the Proof range: `tokenURI` with `id > 110` or `svg`
with `traitId >= 111`. Id 111 is the Vault Title, served by the mosaic
renderer, not here.

## error ZeroAddress

Constructor-only: raised if any of the four immutable references (vault,
PunksData, trait-icon cache, Punk SVG cache) is the zero address. Never
reachable on a live deployment.
