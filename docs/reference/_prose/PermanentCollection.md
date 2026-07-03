---
contract: PermanentCollection
slug: permanent-collection
deploymentsKey: permanentCollection
title: PermanentCollection
---

# summary

The records-only permanent core of the protocol. It holds no Punks and no ETH.
It stores the canonical completion state: the 111-bit `collectedMask`, the
append-only `Acquisition[]` log, per-Punk custody, per-trait pending and
attempt counters, and the first-vaulted-Punk mapping each trait resolves to.
The constructor pins the sealed PunksData trait dataset by hash, so the
contract can never be deployed against a substituted dataset.

Exactly two addresses can write to it, both fixed forever at setup:
`patron` (the only caller of `recordAcquisition`) and `returnAuctionModule`
(the only caller of `markCustody`). Everything else is a view. There is no
admin surface, no upgrade path, and no way to remove or rewrite a record.

# concepts

### The 111-bit trait model

CryptoPunks have 111 distinct traits across four dimensions (types, head
variants, attribute counts, accessories). Each trait is one bit in a
`uint256`. `TRAIT_COUNT` is 111 and `FULL_SET_MASK` is `(1 << 111) - 1`.
`collectedMask` is the artwork's completion state: bit `t` is set iff a Punk
carrying trait `t` entered `PunkVault` with `t` as its recorded target. The
mask is strictly monotonic, bits are never unset, and the protocol is
complete (`isComplete()`) when `collectedMask == FULL_SET_MASK`.

Acquisition never equals collection. `recordAcquisition` marks one trait
pending; only `markCustody(punkId, Vaulted)` sets a bit on `collectedMask`,
and only the recorded target bit. Other uncollected traits on a vaulted
Punk's mask stay available for future acquisitions of other Punks.

### Custody state machine

Each Punk has a custody slot (`custodyOf`), an
`IPermanentCollection.Custody` enum:

| Value | Name | Meaning |
|---|---|---|
| 0 | `None` | never acquired |
| 1 | `InReturnAuction` | a 72-hour return auction is live for it |
| 2 | `ReturnedToMarket` | its return auction cleared; the Punk went to the winning bidder |
| 3 | `Vaulted` | its return auction did not clear; the Punk is in `PunkVault` forever |

Transitions cycle `None → InReturnAuction → ReturnedToMarket →
InReturnAuction → ...`; `Vaulted` is the only terminal state. A
`ReturnedToMarket` Punk can be re-acquired: `recordAcquisition` appends a new
`Acquisition` row and re-points the per-Punk index to it, while the prior
row's own `custody` field stays frozen at `ReturnedToMarket` (the log is
append-only). A `Vaulted` Punk can never be acquired again and there is no
withdrawal path from the vault.

Per-Punk readers (`getAcquisitionFor`, `originalSellerOf`, `custodyOf`,
`acquisitionIndexOf`, `pendingAcquisitionMaskOf`) always reflect the latest
row for that Punk.

### Canonical target derivation

The target trait of an acquisition is protocol-derived, not caller-chosen.
`canonicalTargetOf(punkId)` returns the rarest trait the Punk carries that is
both uncollected and not pending in another return auction, where rarity is
the carrier count from the pinned `CARRIER_COUNTS` table (how many of the
10,000 Punks carry the trait, exposed via `traitCarrierCount`). Ties break to
the lowest bit index. `recordAcquisition` requires the supplied
`targetTraitId` to equal this canonical value and reverts
`TargetNotCanonical` otherwise, so the parameter is a verified expectation:
the call fails loud if the canonical target shifted between the caller's read
and the transaction landing, instead of silently recording a different
permanent trait. This makes it impossible to waste a scarce-trait carrier on
a common trait.

### Sole-carrier guard

The sealed dataset contains exactly one rarity-1 trait: bit 23
("7 Attributes"), carried by exactly one Punk, #8348. Bit 23 can only ever be
collected by vaulting #8348 with bit 23 as the recorded target. Because the
vault is terminal, vaulting #8348 against any of its common traits would
strand bit 23 forever and cap the collection at 110 of 111. So while bit 23
is uncollected, any acquisition of #8348 must record `targetTraitId == 23`,
else `recordAcquisition` reverts `SoleCarrierMustTargetTrait`. The guard
self-disables once bit 23 is collected and never fires for any other Punk.
The pinned pair is exposed as `SOLE_CARRIER_TRAIT_BIT` and
`SOLE_CARRIER_PUNK_ID`, and `soleCarrierConstraint(punkId)` reports whether
the guard currently binds. The canonical-target rule subsumes this guard
(bit 23 is always the rarest pick for #8348 while uncollected); the dedicated
check runs first for a specific early revert.

### Pending and attempt counters

`pendingTraitCount[t]` counts in-flight return auctions targeting trait `t`.
It is 0 or 1 by construction: `recordAcquisition` rejects a second
acquisition targeting a trait already in flight
(`TargetTraitAlreadyPending`), and `markCustody` releases the counter on
either outcome. `attemptCount[t]` counts every acquisition that has ever
targeted `t` and never decrements; `ReturnAuctionModule` snapshots it when a
return auction starts to escalate the reserve (each prior attempt for the
same trait adds 1% of the paid price to the reserve).

### Live reads

```bash
# The 111-bit completion mask
cast call {{addr:permanentCollection}} "collectedMask()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# How many of the 111 traits are permanently collected
cast call {{addr:permanentCollection}} "collectedCount()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# The trait an acquisition of Punk #8348 would have to target right now
cast call {{addr:permanentCollection}} "canonicalTargetOf(uint16)(uint8)" 8348 \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function recordAcquisition

access: patron-only (`msg.sender` must equal the wired `patron` address, else `NotPatron`)

Records a new acquisition after `Patron` has bought the Punk. Validates,
appends one immutable `Acquisition` row, marks the target trait pending,
bumps `attemptCount[targetTraitId]`, and sets the Punk's custody to
`InReturnAuction`. It never touches `collectedMask`.

Validation order, each with its own revert:

1. `originalSeller` must be non-zero (`ZeroAddress`)
2. `punkId` must be below 10,000 (`PunkOutOfRange`)
3. custody must be `None` or `ReturnedToMarket`; `InReturnAuction` and
   `Vaulted` reject (`AlreadyRecorded`)
4. `mask` must equal `punksData.traitMaskOf(punkId)` (`MaskMismatch`)
5. `targetTraitId` must be below 111 (`BadCategoryId`) and set on `mask`
   (`TargetTraitNotInMask`)
6. the target must not already be collected (`TargetTraitAlreadyCollected`)
7. while trait bit 23 is uncollected, Punk #8348 must target bit 23
   (`SoleCarrierMustTargetTrait`)
8. the target must not be pending in another return auction
   (`TargetTraitAlreadyPending`)
9. `targetTraitId` must equal `canonicalTargetOf(punkId)`
   (`TargetNotCanonical`; the canonical derivation itself reverts
   `NoEligibleTarget` if the Punk carries no collectable trait)

On success it emits `AcquisitionRecorded`, `TraitsPending`, and
`CustodyUpdated(punkId, InReturnAuction)`. A re-acquisition of a
`ReturnedToMarket` Punk appends a fresh row and re-points the per-Punk index;
the prior row is never mutated.

## function markCustody

access: returnAuctionModule-only (`msg.sender` must equal the wired `returnAuctionModule` address, else `NotReturnAuction`)

Settles the terminal outcome of a Punk's current return auction. `outcome`
must be `ReturnedToMarket` (the auction cleared with a buyer) or `Vaulted`
(no bid by the deadline); anything else reverts
`InvalidCustodyTransition`. The Punk must be recorded (`NotRecorded`) and
currently `InReturnAuction` (`CustodyAlreadySet`).

Both outcomes release the target trait's pending counter and update custody
on the live slot and the latest acquisition row, emitting `CustodyUpdated`.
The `Vaulted` outcome additionally collects the recorded target trait, and
only that trait: if the target bit was uncollected, it records the Punk as
`firstVaultedPunk` for the trait, sets the bit on `collectedMask`, and emits
`TraitsCollected`. The `ReturnedToMarket` path never touches
`collectedMask`.

## function setWiring

access: deployer one-shot (`OneTimeSetup` gate: caller must be the constructor-time deployer, callable exactly once)

Binds the four protocol addresses this contract references: `patron` and
`returnAuctionModule` (the two authorized writers) plus `punkVault` and
`buybackBurner` (published for indexers only, never called from inside this
contract). All four must be non-zero (`ZeroAddress`). The call finalizes the
`OneTimeSetup` gate in the same transaction, so a second call reverts
(`AlreadyFinalized`, or `AlreadyInitialized` if `patron` were somehow set
first). After this call the wiring is permanent: no admin recovery, no
upgrade path. Emits `WiringFinalized` and `Finalized`. The
`_finalSaleModule` parameter name is the deployed ABI's name for the
`returnAuctionModule` slot.

## function EXPECTED_DATASET_HASH

The pinned hash of the sealed PunksData trait dataset. The constructor
reverts unless the referenced PunksData contract reports exactly this
`datasetHash`, so every trait mask this contract verifies against comes from
one fixed dataset.

## function FULL_SET_MASK

The completion target: `(1 << 111) - 1`, all 111 trait bits set.

## function SOLE_CARRIER_PUNK_ID

The unique Punk (#8348) carrying the dataset's single rarity-1 trait. The
only Punk the sole-carrier guard ever constrains.

## function SOLE_CARRIER_TRAIT_BIT

The dataset's single rarity-1 trait bit (23, "7 Attributes"). While
uncollected, an acquisition of its sole carrier must target it.

## function TRAIT_COUNT

The number of trait bits: 111.

## function acquisitionCount

Total number of acquisitions ever recorded. Monotonic. Pair with
`getAcquisition` for safe paging over the log.

## function acquisitionIndexOf

The 0-based index of `punkId`'s latest acquisition row in the log. Reverts
`NotRecorded` for a Punk that has never been acquired. Stable handle: a
re-acquisition re-points it to the new row, but existing indices keep
addressing their original rows via `getAcquisition`.

## function adminContract

The `ProtocolAdmin` address, recorded for provenance only. No code path in
this contract consults it; admin gating lives on other contracts' setters.

## function attemptCount

Per-trait counter of how many acquisitions have ever targeted the given
trait id. Increments once per `recordAcquisition`, never decrements.
`ReturnAuctionModule` snapshots it into the reserve escalation for the
trait's next return auction.

## function buybackBurner

The `BuybackBurner` address, published for indexers. Provenance only, never
called from inside this contract.

## function canonicalTargetOf

The trait an acquisition of `punkId` would have to target right now: the
rarest (fewest carriers in the sealed dataset) trait the Punk carries that is
both uncollected and not pending in another return auction, ties broken to
the lowest bit index. Reverts `PunkOutOfRange` for `punkId >= 10000` and
`NoEligibleTarget` if every trait the Punk carries is already collected or
in flight. Frontends read this to pre-fill the target and preview which trait
a vault outcome would collect; the value can shift whenever `collectedMask`
or a pending counter changes, which is why `recordAcquisition` re-verifies
it.

## function collectedCount

Number of bits set on `collectedMask`, 0 through 111.

## function collectedMask

The canonical 111-bit completion mask. Bit `t` is set iff trait `t` is
permanently collected. Only `markCustody(punkId, Vaulted)` updates it, and
strictly monotonically.

## function custodyOf

The current custody value for `punkId`. Returns `None` (0) for a Punk that
has never been acquired. See the custody state machine above for the enum.

## function deployedAtBlock

The block number this contract was deployed at. Provenance only; useful as a
stable lower bound for indexer backfills.

## function firstVaultedPunk

For a trait id, the first Punk vaulted with that trait as its recorded
target, as `(punkId, exists)`. Returns `(0, false)` for an uncollected
trait. Reverts `BadCategoryId` for `traitId >= 111`. Because a trait is
collected exactly once, "first" is also "only".

## function getAcquisition

Reads one `Acquisition` row by 0-based log index. Reverts with a plain
array out-of-bounds panic past `acquisitionCount()`. Row fields: `punkId`,
`targetTraitId`, the full trait `mask` verified at record time,
`pendingMaskAtAcquisition` (the single target bit), `acquirer`,
`originalSeller`, `priceWei`, `acquiredAtBlock`, and the row's own frozen
`custody`.

## function getAcquisitionFor

Reads the latest `Acquisition` row for `punkId`. Reverts `NotRecorded` if
the Punk has never been acquired. After a re-acquisition this returns the
newest row; older rows stay reachable by index via `getAcquisition`.

## function isCollected

True iff the given trait id is permanently in the collection. Reverts
`BadCategoryId` for `traitId >= 111`.

## function isComplete

True iff all 111 trait bits are set, i.e. `collectedMask == FULL_SET_MASK`.

## function isPending

True iff the trait is uncollected and an in-flight return auction targets
it. Reverts `BadCategoryId` for `traitId >= 111`.

## function isRecorded

True iff `punkId` has ever been recorded as an acquisition, in any custody
state.

## function newBitsCountFor

Population count of `newBitsFor(punkId)`: how many currently-uncollected
traits the Punk carries.

## function newBitsFor

The Punk's trait mask intersected with the currently-uncollected set,
`traitMaskOf(punkId) & ~collectedMask`. A live measure of what the Punk
could still contribute; unlike `pendingAcquisitionMaskOf`, it shrinks as
other acquisitions collect bits. Returns 0 for `punkId >= 10000` instead of
reverting.

## function originalSellerOf

The address that gave up `punkId` to the protocol on its latest
acquisition: the previous owner on `acceptBid` (equal to the recorded
`acquirer`), or the public listing's seller on `acceptListing` (distinct
from the caller, who is the finder). Returns `address(0)` for an unrecorded
Punk. `PunkVault.mintProofs` reads this at vault-settle time to address the
Proof NFT.

## function patron

The single acquisition entry point. The only address allowed to call
`recordAcquisition`. Fixed forever at `setWiring`.

## function pendingAcquisitionMaskOf

The single-bit pending mask recorded on `punkId`'s latest acquisition row
(the target bit at record time). Frozen on the record for provenance; it
does not shrink as other acquisitions collect bits. Returns 0 for an
unrecorded Punk.

## function pendingMask

Bitmap of every trait that is uncollected and currently targeted by an
in-flight return auction. One call instead of looping `pendingTraitCount`
111 times; the renderer consumes this.

## function pendingTraitCount

Per-trait counter of in-flight return auctions whose recorded target is this
trait. Always 0 or 1: `recordAcquisition` enforces at most one in-flight
acquisition per trait, and `markCustody` releases it on either outcome.

## function punkVault

The `PunkVault` address, published for indexers and UI. Provenance only;
the vault is never called from inside this contract.

## function punksData

The sealed canonical CryptoPunks trait dataset contract. Every mask this
contract verifies or derives comes from `punksData.traitMaskOf(punkId)`;
its `datasetHash` was pinned against `EXPECTED_DATASET_HASH` at
construction.

## function returnAuctionModule

The single custody-marker. The only address allowed to call `markCustody`.
Fixed forever at `setWiring`.

## function setupFinalized

True once `setWiring` has run. Off-chain tooling checks this before
treating the wiring as permanent.

## function soleCarrierConstraint

Whether acquiring `punkId` is currently constrained by the sole-carrier
guard, as `(required, requiredTraitId)`. Returns `(true, 23)` only for Punk
#8348 while trait bit 23 is uncollected; `(false, 0)` in every other case.
Frontends read this to pre-fill the only valid target and warn before a
wasted call.

## function traitCarrierCount

The number of the 10,000 Punks carrying the given trait in the sealed
dataset, from the pinned `CARRIER_COUNTS` table. Pure. Reverts
`BadCategoryId` for `traitId >= 111`. This is the rarity metric
`canonicalTargetOf` minimizes.

## function uncollectedMask

Complement of `collectedMask` within `FULL_SET_MASK`: the bitmap of traits
still to be collected.

## event AcquisitionRecorded

Emitted once per `recordAcquisition`. Indexed: `punkId`, `targetTraitId`,
`acquirer`. Data: `originalSeller` (the future Proof NFT recipient), the
Punk's full verified `mask`, `pendingBits` (the single target bit),
`priceWei`, and `acquiredAtBlock`. One event per log row; a re-acquisition
of a returned Punk emits it again with the new row's values.

## event CustodyUpdated

Emitted on every custody transition: `InReturnAuction` at record time, then
`ReturnedToMarket` or `Vaulted` at settle, and `InReturnAuction` again on a
re-acquisition. An indexer can replay these to reconstruct the full custody
history of a Punk.

## event Finalized

Emitted exactly once, when `setWiring` closes the `OneTimeSetup` gate. After
this event the contract's setup surface is permanently closed.

## event TraitsCollected

Emitted when a bit transitions to permanently collected: exactly one bit per
`markCustody(punkId, Vaulted)`, the recorded target. Carries
`newlyCollectedBits` (the single bit), the running `collectedCount`, and the
cached `isComplete` flag so off-chain consumers need no follow-up read.

## event TraitsPending

Emitted alongside `AcquisitionRecorded` with the same single-bit
`pendingBits` value, for indexers that key off per-bit pending state.

## event WiringFinalized

Emitted once at `setWiring` time with the four wired addresses. `patron`,
`returnAuctionModule`, and `punkVault` are indexed. The addresses are
immutable thereafter.

## error AlreadyFinalized

An `onlySetup`-gated call (i.e. `setWiring`) landed after the setup gate was
already closed. The wiring is permanent; there is nothing to retry.

## error AlreadyInitialized

`setWiring` found `patron` already set. Same terminal condition as
`AlreadyFinalized`: wiring happens exactly once.

## error AlreadyRecorded

`recordAcquisition` was called for a Punk whose custody is `InReturnAuction`
or `Vaulted`. A live auction must settle first; a vaulted Punk can never be
acquired again.

## error BadCategoryId

A trait id argument was 111 or higher. Valid trait ids are 0 through 110.

## error CustodyAlreadySet

`markCustody` was called for a Punk that is not currently
`InReturnAuction`. The current auction's outcome was already marked.

## error DatasetHashMismatch

Constructor-only: the supplied PunksData contract's `datasetHash` did not
equal `EXPECTED_DATASET_HASH`. Deployment against a substituted dataset
fails.

## error InvalidCustodyTransition

`markCustody` received an `outcome` other than `ReturnedToMarket` or
`Vaulted`. Those are the only two terminal outcomes of a return auction.

## error MaskMismatch

The `mask` supplied to `recordAcquisition` did not match
`punksData.traitMaskOf(punkId)`. Re-read the canonical mask and retry.

## error NoEligibleTarget

The Punk carries no trait that is both uncollected and not already pending
in another return auction, so there is nothing an acquisition could target.
Raised by `canonicalTargetOf` (directly and inside `recordAcquisition`).

## error NotDeployer

An `onlySetup`-gated call came from an address other than the
constructor-time deployer.

## error NotPatron

`recordAcquisition` was called by an address other than the wired `patron`.
There is no other acquisition entry point.

## error NotRecorded

The Punk has never been acquired. Raised by `markCustody`,
`acquisitionIndexOf`, and `getAcquisitionFor`.

## error NotReturnAuction

`markCustody` was called by an address other than the wired
`returnAuctionModule`. There is no other custody-marker.

## error PunkOutOfRange

`punkId` was 10,000 or higher. Valid CryptoPunk indices are 0 through 9999.

## error SoleCarrierMustTargetTrait

An acquisition of Punk #8348 targeted a trait other than bit 23 while bit 23
is uncollected. Supply `targetTraitId = 23`; `soleCarrierConstraint` reports
when this applies.

## error TargetNotCanonical

The supplied `targetTraitId` did not equal `canonicalTargetOf(punkId)`. The
error carries both values. Re-read the canonical target and retry; the
target is protocol-derived, not caller-chosen.

## error TargetTraitAlreadyCollected

The target trait's bit is already set on `collectedMask`. Collected traits
can never be targeted again.

## error TargetTraitAlreadyPending

Another in-flight return auction already targets this trait. At most one
acquisition per trait can be in flight; wait for that auction to settle.

## error TargetTraitNotInMask

The target trait bit is not set on the Punk's verified trait mask. The Punk
does not carry the trait.

## error ZeroAddress

A required address argument was zero: any of the four `setWiring` addresses,
or `originalSeller` in `recordAcquisition`.
