# Permanent Collection — system overview

> Single canonical reader doc. If you only read one thing, read this. For
> details on any specific surface, the deep-link table at the bottom points
> to the focused doc.

> ✅ **2026-06-07 — contracts APPROVED FOR LAUNCH (owner sign-off).** The owner
> has approved the full immutable contract surface for the mainnet broadcast,
> based on the internal 5-auditor adversarial re-audit (0 Critical / High /
> Medium) plus the owner's own review; an external professional audit was
> considered and WAIVED. Any "focused re-audit gates the broadcast" note in this
> doc **no longer gates the broadcast** (it stays as reference). This clears the
> AUDIT gate only — separate operational pre-broadcast steps (e.g. the artcoins
> submodule pin-bump + push for the tax-cap raise) still stand.

PERMANENT COLLECTION is an on-chain art protocol. A speculative artcoin
(`111`) launched on the artcoins V3 stack funds a global ETH **live bid**
for any eligible CryptoPunk. Each acquired Punk enters a 72-hour **return
auction** that either returns it to circulation or **vaults it
permanently**. The artwork is the running system, indefinitely, until all
**111 CryptoPunks traits** are represented by vaulted Punks (or the market
settles into an equilibrium where the remaining traits are held by owners
who refuse the live bid).

The work makes one hard commitment: **once a Punk enters PunkVault, the
system provides no path for it to leave.** No admin override, no governance,
no upgradeability. Bytecode-asserted.

---

## The loop

```
trader ETH ──6% baseline skim──▶ ArtCoinsHookSkimFee (V4 hook)
                                 accrued in _beforeSwap, flushed at end of
                                 same swap's _afterSwap — no claim balance
                                 held between swaps:
   │
   ├─ ~83.33% baseline ─▶ LiveBidAdapter  ─sweep()─▶ Patron (live bid)
   │  + 100% MEV-extra        (during ~30-min anti-sniper window)
   │
   ├─ ~16.67% baseline ─▶ ProtocolFeePhaseAdapter ─sweep()─▶ PCController
   │                                                   (86.67% PC treasury / 13.33% LAYER burn)
   │                                                   from block 1
   │
   └─ ≤0.25% of volume ─▶ ReferralPayout (per-referrer ledger, pulled FROM
                          the protocol slice; paid from the first swap)

LiveBidAdapter is the single inflow governor — EVERY ETH source that funds the
live bid (the skim above, attributed contributions, bare top-ups, the cleared-
auction rescue refund) enters the adapter, which buffers and meters it into
Patron via sweep(). Patron.receive() accepts ETH ONLY from the adapter.

Metering (two-mode, keyed on the live bid vs activationThreshold): below the
threshold the adapter is in fast mode, forwarding the buffer UNCAPPED with no
cooldown, clamped so a single fast-mode forward fills the bid only UP TO the
threshold (the launch warm-up). At or above the threshold it throttles: at most maxSweepWei
(2 ETH) per minBlocksBetweenSweeps (~30 min), so a burst drips in rather than
lurching the standing offer past floor prices in one block. activationThreshold self-manages: sweep() reads the
latest acceptBid clearing price from PermanentCollection (via IPCAcquisitionReader)
and resets the threshold to 75% of it (a −25% band), clamped to
ACTIVATION_THRESHOLD_HI = 100 ether; the deploy seed is 30 ETH. acceptListing
rows are skipped so a cheap finder listing can't drag the ceiling down.
Cadence: besides the permissionless keeper/UI sweep() (claims the LP-fee escrow
+ pays the keeper reward + syncs the threshold), the artcoins hook calls the
adapter's streamForward() in _beforeSwap (opt-in via IPreSwapStream,
balance-gated, try/catch — can't brick a swap), so the bid advances per-swap
from prior swaps' buffered bounty leg: buffered-native only, no keeper reward,
no-op below MIN_STREAM_WEI (0.01 ETH) and on cooldown; streamForward() does NOT
sync the threshold, it reads whatever the last sweep() set. sweep() and
streamForward() share ONE cooldown clock (the same cap keyed on a single
lastSweepBlock), and fast-mode forwards do NOT arm it.

Patron (live bid) ─┬── acceptBid (owner lists exclusively to Patron at ≈ the live bid; anyone finalizes; seller paid by the market)
                   └── acceptListing (allowlisted seller's public listing, finder fee)
                          │
                          ▼
                  ReturnAuctionModule — 72-hour return auction
                  reserve = acquisitionCost × (101 + previousTrials) / 100
                  anti-snipe: 15-min trigger, +1h extension, uncapped
                          │
              ┌───────────┴───────────┐
              │                       │
        Cleared (bid ≥ reserve)   No bid by deadline
              │                       │
              ▼                       ▼
        Punk → bidder                       Punk → PunkVault
        65% cost → LiveBidAdapter → Patron  ONLY the recorded target trait permanent
        25% cost (residual) → BuybackBurner VaultBurnPool sweeps → BuybackBurner
        10% cost → VaultBurnPool
        premium = highBid − cost
          ├─ 5% → optional referrer (REFERRER_PREMIUM_BPS = 500; fail-closed)
          └─ 95% → VaultBurnPool
                          │
                          ▼
              BuybackBurner.executeStep (permissionless, paced)
              ETH → 111 swap → 111 to 0xdead
```

Per 1 ETH of swap volume (immutable after pool init):
**5.00% → live bid / 1.00% → protocol leg (→ PCController from block 1) /
≤0.25% → referrer if attributed (clawed from protocol slice).** Total
baseline skim = 6%. `VaultBurnPool` is no longer fed by a trading-fee
leg — its only inflow is the cleared-auction proceeds split
(`(highBid − cost) + 10% × cost`) in `ReturnAuctionModule.settle`.
The pool's 0.5%
LP fee is separate and is distributed pro-rata to in-range liquidity per
standard V4 mechanics. At launch the conversion locker owns 100% of the LP
positions (1.11B tokens across 14 tick ranges — positions 0–11 a thin-floor
taper out to ~$31M FDV, plus two concentrated tail positions (12 & 13)
extending coverage to ~$310M FDV), so the locker captures the LP
fee by depth dominance, then forwards it to `LiveBidAdapter` via the locker's
single PC reward slot (admin = `0xdEaD`, recipient permanently locked). The
tail positions provide the protocol's permanent high-FDV depth (they replace
the former `POLDepositor`); their LP fees route locker → `LiveBidAdapter` →
Patron, mission-aligned.
Public LPs can add positions after the MEV anti-sniper window closes
(~30 minutes post-launch) and will earn their proportional share of the LP
fee alongside the locker's positions — the official pool is a legitimate
open trading venue, not a closed pool. The hook's `bountyBps` config field
(8,333 of the 10,000-bps baseline) sets the live-bid leg's ~83.33% share that
accrues to `LiveBidAdapter`.

### Two attributed paths into the live bid

Two referral surfaces sit alongside the three-leg hook split. Both share
the same fail-closed shape: a missing or reverting referrer reroutes 100%
of the would-be referrer slice back to the protocol's intended internal
destination, and the entry points themselves never revert on referrer
failure.

**Return-auction premium referrer** (`ReturnAuctionModule.placeBidWithReferral(punkId, referrer, tag)`;
the no-referral `placeBid(punkId)` is the simple path).
Bidders can attach a referrer + opaque tag to any bid. The contract only
remembers the **current high bidder's referrer** via
`referrerOfHighBid[punkId]`; outbid bidders' referrers lose attribution.
On a cleared settle, **5% of the rescue premium** (`REFERRER_PREMIUM_BPS
= 500`) routes to that referrer via a 35k-gas send, and the remaining 95%
flows to `VaultBurnPool` as before. The referrer slice comes from the
voluntary overbid only — it never reduces the 65% cost → Patron, 25% cost →
BuybackBurner, or 10% cost → VaultBurnPool slices, and a vault-path settle
pays no referrer (no premium exists).

**Contribution attribution** (`LiveBidAdapter.contribute(referrer, tag)`).
The canonical on-chain destination for capital flows that want to feed the
live bid with attribution. Under inflow consolidation this surface lives on
`LiveBidAdapter` (the single inflow governor), NOT on Patron. Primary
integration target: launchpads that want a "route X% of mint proceeds to
Permanent Collection" toggle, and any project routing treasury or campaign
ETH to the protocol. `msg.value` must be non-zero; **5% of the contribution**
(`REFERRER_CONTRIB_BPS = 500`) routes to the referrer via a 35k-gas send,
with the remainder joining the adapter buffer and metering into the live bid
on the next `sweep()`. A reverting or OOG referrer folds the would-be slice
back into the buffer — the send did not move ETH, so the bid is credited
fully. Bare `LiveBidAdapter.receive()` top-ups remain available for
unattributed flows.

Both entry points carry `nonReentrant` + `notInSwap`. The bps splits are
hard-coded constants with no admin setter and no future-tunability;
neither path adds an admin surface to LiveBidAdapter or ReturnAuctionModule
(bytecode scans still pass).

Detail: [docs/PROTOCOL.md](PROTOCOL.md).

---

## Why "Permanent"

The artistic claim rests on a small set of irreversible facts about deployed
state. Each is asserted in code AND tested adversarially against live
mainnet-fork bytecode in
[`LaunchInvariantForkTest`](../contracts/test/LaunchInvariantFork.t.sol) —
53 tests across 6 hardening passes.

1. **`collectedMask` is monotonically increasing.** Bits never unset.
2. **`Acquisition[]` log only grows.** Records are never removed; a
   re-acquisition of a rescued Punk APPENDS a new row. Custody cycles
   `(zero) → InReturnAuction → ReturnedToMarket → InReturnAuction → …`;
   `Vaulted` is the only terminal state. A rescued Punk can re-enter the
   return auction; a Vaulted Punk never can.
3. **Vaulted collects ONLY the recorded target trait, and the target is
   protocol-derived — not caller-chosen.** `recordAcquisition` requires
   `targetTraitId == canonicalTargetOf(punkId)`: the RAREST uncollected,
   non-pending trait the Punk carries (ties → lowest bit index), from a pinned
   per-trait `CARRIER_COUNTS` table (a fixed projection of the sealed dataset,
   cross-checked against live PunksData by the `RarityTableFork` fork test, not
   re-derived on-chain). So no
   acceptBid/acceptListing caller can steer a scarce-trait carrier (e.g. one of
   the 9 Aliens) onto a common trait — the caller passes the target as a
   verified expectation and the call reverts (`TargetNotCanonical`) if it
   diverged. This generalizes the sole-carrier guard to every scarce trait.
   (V2 spec change — pre-V2 vaulting collected every uncollected bit on
   the mask; the target is now both target-only AND protocol-chosen.)
4. **No Punk can leave `PunkVault` or `PermanentCollection`.** Bytecode-scan
   asserted: neither has any CryptoPunks market-write selector.
5. **Cleared return-auction split is constant.** 65% cost → Patron, 10%
   cost → VaultBurnPool, 25% cost (residual) → Burner, plus the premium
   `(highBid − cost)` → VaultBurnPool. `CLEARED_BID_BPS = 6_500`,
   `CLEARED_VAULT_BURN_BPS = 1_000`, hard-coded, no setter.
6. **No admin withdrawal path from `Patron`.** Bytecode-scan asserted: no
   `withdraw*` / `rescue*` / `sweep*` / `migrate` / `emergencyWithdraw` /
   `drain*` selectors.
7. **Parameter setters are bounded.** Every economic parameter has hard-coded
   `[min, max]` bounds enforced in the setter. The bounds can't be escaped
   by the admin.
8. **`ProtocolAdmin` auto-locks at +1 year.** After lock, no economic-param
   changes accepted. Four scoped carve-outs (seller allowlist;
   `LiveBidAdapter.setActivationThreshold`, the adapter's lone lifetime
   carve-out, gated by `ProtocolAdmin.admin()` alone;
   `TokenAdminPoker.setHookMaxReferralBps ∈ [0, 1_000] bps`;
   `TokenAdminPoker.setTokenTaxBps ∈ [0, 2000] bps`, 20% cap) — all four
   must track shifting external conditions over the protocol's lifetime. The
   carve-outs stay callable until the role is burned, and the burn /
   off-switch — `transferAdmin(address(0))` — is reachable at any time, even
   after the timer has lapsed (only renewals/rotations are time-gated;
   auditor M-1). So a post-lapse key compromise always has an on-chain kill.
9. **`address(patron).balance ≥ accountedLiveBidWei`; the live bid is
   `accountedLiveBidWei`, not the raw balance.** `bidBalance()` returns
   `accountedLiveBidWei`, and `acceptBid` / `acceptListing` pay from it, so a
   force-send (selfdestruct / coinbase) can only make the balance EXCEED the
   accounted bid, never underpay it; that surplus is not part of the live bid
   and is swept to `LiveBidAdapter` by `skimSurplus()`. The accounted bid fills
   ONLY via `LiveBidAdapter`: `receive()` rejects every non-adapter sender
   (`NotAdapter`) and credits `accountedLiveBidWei` 1:1, so the single metered
   faucet is the only way the live bid grows.
10. **Token holders have no governance** over the protocol.
11. **Three-leg skim split enforced at swap-time, flushed in the same tx.**
    Live-bid (~83.33% of baseline) + protocol (~16.67% of baseline) legs are
    gross-baseline-bps; referral can ONLY come from the protocol slice;
    antiSniperExtra routes 100% to the live bid. All three accruals
    (including the credited referrer drawn from the protocol slice) flush
    to their recipients at the end of `_afterSwap` of the SAME swap — hook
    never holds a claim balance between swaps. (The former vault-burn
    trading leg was retired in the 2026-05-28 fee redesign; `VaultBurnPool`
    is now fed only by cleared-auction proceeds.)
12. **`PCSwapContext.inSwap` is permanently `false` at launch.** No extension
    is authorized; the reentrancy flag can never be set until/unless a
    future Design B dispatcher is bound (separate, deliberate action).
13. **Referral path is fail-closed.** The referral leg pays from the first
    swap when the swap carries a valid referrer, but a reverting/OOG
    `ReferralPayout` recipient folds the slice back to the protocol escrow
    (the swap never reverts on referral failure).
14. **Decorated PC contracts cannot be reentered by a Design B callback.**
    When a future dispatcher is bound, callbacks attempting to reach into
    `Patron`, `ReturnAuctionModule`, etc. revert `PCNoReentry.InSwap`.
15. **The unique rarity-1 carrier can never be wasted.** Trait bit 23
    (`"7 Attributes"`) has exactly one carrier in the sealed dataset — Punk
    #8348, the lone forced edge in the 111/111 trait→Punk matching. While bit
    23 is uncollected, `PermanentCollection.recordAcquisition` forces any
    acquisition of #8348 to target bit 23 (else `SoleCarrierMustTargetTrait`),
    so it can never be silenced against a common trait and strand the Full Set
    at 110/111 (mission finding MF-1). `Patron.acceptBid`/`acceptListing`
    mirror the guard; it self-disables once bit 23 is collected.
16. **At most one in-flight acquisition per trait: `pendingTraitCount[t] ∈
    {0,1}`.** The `TargetTraitAlreadyPending` guard rejects a second
    acquisition targeting a trait already in flight. This makes every
    vault-path settle the FIRST vaulting of its target, which keeps
    `popcount(collectedMask) == #vaulted == #Proofs` in lockstep and makes the
    redundant-vaulting branch in `settle` unreachable.
17. **Reserve strictly exceeds cost: `reserve = ⌈cost × (101 + previousTrials)
    / 100⌉ > cost`.** The ceil-div guarantees the rescue premium
    `highBid − cost` is positive on every cleared settle, so the cleared-path
    split never underflows.
18. **Each cleared settle distributes exactly `highBid`.** The cost split
    (bid + burn + vault-burn) plus the premium split (referrer + vault-burn)
    sum to `highBid`; the escrow round-trip nets zero and the module never
    spends another sale's ETH.
19. **`canonicalTargetOf` returns an uncollected, non-pending, in-mask trait,
    or reverts `NoEligibleTarget`.** A recorded target is therefore always
    collectible, so the sole-carrier guard (#15) can never contradict the
    canonical-target rule (#3).

Detail: [docs/SECURITY.md](SECURITY.md).

---

## The artwork — renderer + trait-grid

The artwork IS the rendered image. The renderer is a contract (not an
off-chain service) that reads on-chain state every time `tokenURI()` is
called and emits a fresh SVG. No IPFS, no image server, no off-chain step.

**The trait grid.** All 111 CryptoPunks traits laid out on a square
canvas: an 11×10 main grid (110 cells) with the "final type" pulled out
as a single cell beneath the grid's bottom-left, and the two-line
progress inscription set in the bottom-right. Each cell is in one of
three states, determined by
[`PermanentCollection`](../contracts/src/PermanentCollection.sol)'s live
state:

| Cell state | Trigger | What it shows |
|---|---|---|
| **Permanent** | `(collectedMask >> traitId) & 1 == 1` | The Punk that brought this trait into the vault — read via `firstVaultedPunk(traitId)`. The actual Punk pixels from PunksData, with this trait highlighted. |
| **In return auction** | `(pendingMask >> traitId) & 1 == 1 && !collected` | An in-flight Punk carries this trait as its recorded target; outcome undecided. Renders the isolated trait with a distinct background that signals "in return auction." |
| **Uncollected** | Neither set | The bare trait by itself: just the hat, or just the glasses, or just the bald head. Computed at read time by diffing a canonical Punk that carries the trait against a baseline Punk that doesn't. |

The renderer hits `FULL SET COMPLETE` only when `collectedMask ==
FULL_SET_MASK` (all 111 bits via vaulted Punks).

**The dataset is sealed.** Trait data comes from
[`PunksData`](https://etherscan.io/address/0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C)
(ENS `punksdata.eth`) — the on-chain Punks pixel store published by Larva
Labs.
[`PermanentCollection`](../contracts/src/PermanentCollection.sol)'s
constructor pins the expected dataset hash (`0x92117ce6…`) and reverts if
the on-chain value doesn't match. The artwork cannot bind to a different
taxonomy.

**Swappable renderer indirection.** Reads route through
[`RendererRegistry`](../contracts/src/RendererRegistry.sol) which holds
the active renderer address. At launch the registry points at
[`PermanentCollectionMosaicRenderer`](../contracts/src/PermanentCollectionMosaicRenderer.sol).
The admin can swap implementations until `freeze()` or the 1-year
`ProtocolAdmin` timer auto-locks. The registry moves no value, so a bad
install only reverts the forwarded views until the next swap — that
recoverability, plus verifying the live render before `freeze()`, is the
guard (there is no on-chain interface probe).

**Caches.**
[`PunkSvgFragmentCache`](../contracts/src/PunkSvgFragmentCache.sol) and
[`TraitIconCache`](../contracts/src/TraitIconCache.sol) are
permissionless, on-chain SVG caches. Anyone can call `cacheTrait(id)` /
`cachePunk(id)` to amortize render gas across the public — a one-time
~5M-gas write that drops every subsequent `tokenURI()` cost. The Mosaic
renderer consults `TraitIconCache` first and falls back to on-the-fly
compute for uncached traits. Operating model:
[docs/RENDERER_CACHE.md](RENDERER_CACHE.md).

---

## The Title and the 111 Proofs — `PunkVault` issues both

`PunkVault` is the single on-chain artifact answering "what is in the
Permanent Collection." It issues **112 named ERC721 objects** from
disjoint, hard-coded token-id ranges, plus the Punks themselves (which
are held at the canonical CryptoPunks market's `punkIndexToAddress`
slot, not tokenized on PunkVault):

- **Token id 111 — the Vault Title.** One ERC721 representing the
  singular title record for the vault. Minted into the auction escrow at
  launch; the auction itself opens once 22 traits have been collected (its
  `KICKOFF_THRESHOLD`). The Title names
  the steward of the work; it grants no claim on the Punks, no withdrawal
  rights, no admin powers, no governance.
- **Token ids 0..110 — the Proofs.** One per first-vaulting of a
  previously-uncollected trait. Minted at vault-settle time to the
  address that gave up the Punk (the `originalSeller` recorded on the
  acquisition). A Proof's token id is `traitId` (direct 1:1 with the PunksData trait taxonomy). Cap is exact and
  permanent: 111 Proofs maximum, one per trait. Each Proof is the
  **proof of a contribution to the collection**.

Token ids ≥ 112 are unreachable from any code path. The Title minter
(`titleAuction`) cannot mint Proofs; the Proof minter (`returnAuctionModule`)
cannot mint the Title.

### The Title — `PunkVaultTitleAuction`

A second on-chain artifact, separate from the trait grid. Activates once
**22 traits have been collected** (`KICKOFF_THRESHOLD`).

[`PunkVault`](../contracts/src/PunkVault.sol) is itself an ERC721 contract
(`solmate/ERC721`) — both the immutable Punk custodian and the issuer of
**token id 111** representing title to the vault — sitting just past the
Proof range (ids 0..110, with `tokenId == traitId`). At launch, token id
111 is minted to the auction contract (so its `tokenURI` and marketplace
page resolve from day one), but the auction itself stays closed until the
kickoff threshold is met.

**Lifecycle** (driven by
[`PunkVaultTitleAuction`](../contracts/src/PunkVaultTitleAuction.sol)):

1. **Pre-kickoff.** Token id 111 exists from launch (minted to the auction
   contract via `mintTitle()`, called in `Deploy.s.sol` right after
   `setTitleAuction`). The auction itself is dormant — no bids accepted.
2. **Kickoff** (permissionless, one-shot). Anyone can call `kickoff()`
   once `collection.collectedCount() >= KICKOFF_THRESHOLD` (= 22 at
   launch, per `PunkVaultTitleAuction.sol`). That call starts a **24-hour**
   auction clock (and mints the Title as an idempotent fallback if it
   somehow wasn't minted at launch).
3. **Live.** Anyone can `bid()`. No fixed reserve; each bid must be ≥ 5%
   above the current high (and strictly greater in wei). Outbid losers
   refunded via a 30k-gas push (pull-pattern `pendingRefund` fallback).
   A bid in the final 15 minutes extends the deadline by 1 hour,
   uncapped — same anti-snipe shape as return auction.
4. **Settle** (permissionless, post-deadline). With a winner: title NFT
   transfers via `transferFrom` (not `safeTransferFrom`, so a
   non-receiver-aware winner contract can't strand the token). Proceeds
   route **0% → Patron / 100% → `payoutRecipient`**
   (`PATRON_SHARE_BPS = 0`, `PAYOUT_SHARE_BPS = 10_000`). The Patron
   share is dormant, so the Title auction never sends ETH to Patron and
   never refills the live bid. The `payoutRecipient` share is credited to
   a pull-based `pendingProceeds` queue (claimed via `withdrawProceeds`;
   anyone may trigger the claim for the credited recipient).
   `payoutRecipient` is an immutable address bound at the auction's
   deploy time and does NOT default to the deployer. Without a winner:
   the title remains in the auction contract (vanishingly unlikely with
   a 5% rule, but defined).

**Permanence:** the auction has no admin functions, no setters, no
fund-recovery path. Every parameter is a compile-time constant or an
immutable bound at construction.

### The 111 Proofs — issued at vault-settle

For each trait the protocol permanently collects, one Proof NFT is
minted from `PunkVault` to the address that gave up the Punk whose
vaulting brought that trait into the collection. The Proof is a
commemorative on-chain artifact; the Punks themselves never leave the
vault.

**Eligibility (all must hold at vault-settle):**

- The Punk's return auction ended without a clearing bid; custody
  transitions to `Vaulted`.
- The Punk's recorded `targetTraitId` was previously uncollected — i.e.
  this vaulting filled the trait for the first time. Redundant vaultings
  of an already-permanent trait mint nothing, preserving the 111-cap.
- The acquisition's `originalSeller` field is non-zero (enforced at
  `recordAcquisition`).

**Atomicity.** The mint is bound to the vaulting, not best-effort.
`ReturnAuctionModule.settle` calls `mintProofs` directly — no `try/catch` —
so a mint failure reverts the **entire settle**: the vaulting, the custody
transition, and the `settled` flag all roll back, leaving the auction
settleable for a retry. The guarantee this buys is structural: a
permanently-collected trait can never exist without its one Proof. It is
safe because the required mint has no reachable revert for a legitimate
first-vaulting — the recipient is structurally non-zero (above), the token
id (`== traitId`) is structurally fresh, and `_mint` runs no recipient
callback, so a recipient cannot grief the mint to block a Punk's settlement.

**Recipient.** The `originalSeller` field on `Acquisition`:

- For `acceptBid`: the owner who listed the Punk exclusively to Patron at
  ≈ the live bid (same address the market pays the listed price to, collected
  via `withdraw()`).
- For `acceptListing`: the **public-listing seller** — distinct from the
  caller (the finder, who collects the finder fee but not the Proof).

**Token id scheme.** `tokenId == traitId` directly — a Proof for trait
20 IS token id 20. Disjoint from the Title (token id 111) and from ids
≥ 112 (unreachable).

**Minter scoping.**
`PunkVault.mintProofs(...)` is gated to `returnAuctionModule` only; reverts
`NotReturnAuction` from any other caller. `PunkVault.mintToAuction()` is
gated to `titleAuction` only. Neither minter can reach the other's id
range. Both reject `traitId ≥ 111` and unreachable ids ≥ 112.

**Permanence.** Both the Title and Proofs are transferable ERC721
tokens — the bytecode-scan invariant is about the *Punks* having no
exit path; the ERC721 tokens representing roles in the collection trade
normally. Proof `proofMeta` (punkId, traitId, sequence, mintedAtBlock)
is frozen at mint time and reads the same after a transfer — the
contribution event is immutable; the current owner is a separate fact.

**Rendering.** Proof metadata renders entirely on-chain via
[`PermanentCollectionProofRenderer`](../contracts/src/PermanentCollectionProofRenderer.sol):
a 24×24 trait tile on a `#8F918B` background. Once a
Proof is minted, the acquired Punk — the one whose vaulting brought
the trait in — is drawn faintly behind the trait at 5% opacity, with
the isolated trait icon composited crisply on top; before mint there
is no acquired Punk, so the tile shows the trait alone. The trait
name, contributing Punk id, sequence position ("47 of 111"), and
vault-settle block live in the JSON envelope. Vault delegates
`tokenURI(id)` through `RendererRegistry` → Mosaic renderer, which
dispatches ids 0..110 → Proof renderer, id 111 → Title.

**Marketing line:** *"Every vaulted Punk leaves a Proof."*

### Marketplace collection editor — one-way renounce

`PunkVault` exposes ERC-173 `owner()` so OpenSea / Blur / Magic Eden
recognize a wallet as the collection's editor for the marketplace UI
(banner image, profile image, description override, social links). The
slot is initialized to the **deployer EOA** at construction and is a
**one-way ratchet**: `renounceOwnership()` sets it to `address(0)`
forever. There is intentionally NO `transferOwnership` — once
renounced, no key compromise can ever re-acquire collection-editor
rights.

The owner slot has **no on-chain authority**: it does not gate any
vault function, does not touch the Punks, does not control the ERC721
metadata content (which comes from `RendererRegistry`), and does not
affect any other PC contract. The slot exists solely for the
launch-setup window.

**Expected sequence:**

1. Deploy `PunkVault` (deployer becomes initial `owner()`).
2. Set up the OpenSea collection page from the deployer wallet:
   banner, profile image, description override, social links.
3. Call `vault.renounceOwnership()`. `owner()` becomes
   `address(0)` permanently; OpenSea will refuse all future edits.

Marketplace metadata (banner, etc.) is then frozen alongside the
on-chain `contractURI()` content. Bytecode-scan tests assert the
vault has `owner()` + `renounceOwnership()` and NOTHING else
(no `transferOwnership`, no admin / migration / withdrawal selectors).

### ERC-7572 `ContractURIUpdated()` refresh hint

`PunkVault` emits `ContractURIUpdated()` (ERC-7572) alongside every
state change that affects collection-page metadata: on title mint
(`mintToAuction`) and on every Proof mint (`mintProofs`). OpenSea and
other ERC-7572-aware indexers refresh their cached collection
metadata when they see this event, so the "N of 111" inscription and
title progress fields stay current without waiting on poll cadence.

---

## Off-chain — indexer + frontend

The protocol is fully on-chain, but two off-chain layers serve user
experience:

**Indexer** ([`indexer/`](../indexer)) — a Ponder service that mirrors
chain events into a queryable schema for the frontend. Indexed event
shapes (`ponder.schema.ts`):

- `BidAccepted` / `ListingAccepted` — every acceptBid / acceptListing
  acquisition
- `ReturnAuctionStarted` / `BidPlaced` /
  `ReturnAuctionExtended` / `ReturnAuctionCleared` / `PunkVaulted` /
  `PunkReturnedToMarket` — return-auction lifecycle events
- `BurnEthDeposited` / `TokensBurned`
- `SwapAttribution` / `ReferralCredited` / `ReferralClaimed`
- `Contribution` / `BareTopUp` / `PoolReplenished` — attributed top-up,
  unattributed top-up, and cleared-path live-bid refill (the legacy
  `BidToppedUp` event was removed). Under inflow consolidation these emit
  from `LiveBidAdapter` (the single inflow governor), not Patron
- `ProtocolCounter(global)` — singletons for acquisitionCount,
  vaultedCount, clearedCount, collectedMask
- `TraitsCollected` per-trait state

The frontend's read path is "**indexer first, then RPC, then cache
forever**." Anything the indexer tracks (counts, histories, balances)
comes from the GraphQL endpoint. Live RPC reads are for what the indexer
hasn't caught up on yet (sub-second freshness on liveBid) or what doesn't
need indexing (current `acquisitionCount()`).

**Frontend** ([`app/`](../app)) — Next.js 15 (App Router). Pages:

| Route | What it does |
|---|---|
| `/` | Homepage. Live bid stat, recent accepted bids, active return auctions, the trait grid hero. |
| `/trade` | `111` swap UI. Universal Router + Permit2; passes `PCSwapData` hookData when a `?ref=` URL parameter is present. |
| `/accept` | Live-bid acceptance flow (`acceptBid` on-chain). Owner lists exclusively to Patron at ≈ the live bid (never 0), anyone finalizes, seller claims via the market's `withdraw()`. EIP-5792 `wallet_sendCalls` batch for the offer + accept steps on capable wallets; falls back to sequential txs on older wallets. |
| `/auction/[id]` | Per-Punk return-auction view. Live bid, reserve, anti-snipe countdown, bid / settle / withdrawRefund actions. |
| `/collection/[id]` / `/punk/[id]` | Punk detail. Trait list, current custody state. |
| `/referrals` | Referrer dashboard. Reads `accruedReferral(poolId, caller)` + `referralPayout.balances(caller)`; "Flush hook" + "Claim" buttons. |
| `/builders` | Builder docs (Design A attribution + Design B preservation) with **live Design B status** (the dispatcher binding state read from chain). |
| `/calculator` | Bid-impact calculator for traders modeling fee flows. |
| `/og/*` | Open Graph image generators. |

Server-side RPC proxy at `app/app/api/rpc/route.ts` reads `RPC_URL`
(server-only — never `NEXT_PUBLIC_RPC_URL_*`), forwards a whitelist of
read-only JSON-RPC methods through a paid primary + public-fallback
chain (Tenderly → publicnode → llamarpc → cloudflare), and applies a
per-IP rate limit (default 300 req/min/IP, configurable via
`RPC_RATE_LIMIT_PER_MIN`, skipped automatically on the local fork).
Browser writes go directly from wallets to upstream; only reads route
through the proxy.

Attribution encoding lives in
[`app/lib/swap/attribution.ts`](../app/lib/swap/attribution.ts) (the
1-tuple PoolSwapData encoder). Referrer URL parsing +
localStorage persistence:
[`app/lib/swap/useReferrer.ts`](../app/lib/swap/useReferrer.ts).

---

## Contracts

### Permanent core (no upgrade path, immobile state)

| Contract | Role |
|---|---|
| [`PermanentCollection`](../contracts/src/PermanentCollection.sol) | Records-only. Holds NO Punks. `collectedMask`, `Acquisition[]`, `pendingTraitCount`, per-Punk custody. Patron-gated `recordAcquisition`; ReturnAuctionModule-gated `markCustody`. A rescued (ReturnedToMarket) Punk is **re-acquirable** — `recordAcquisition` gates on custody (None or ReturnedToMarket), appends a new row, and re-points `_acquisitionIndexOf` to the latest; a Vaulted Punk is terminal and never re-auctions. Per-Punk readers (`getAcquisitionFor`/`originalSellerOf`/`custodyOf`) return the latest row. |
| [`PunkVault`](../contracts/src/PunkVault.sol) | Immutable terminal Punk custodian AND `solmate/ERC721` issuer for **112 named tokens**: the Title (token id 111, minted by `PunkVaultTitleAuction`) and the **111 Proofs** (token ids 0..110, one per first-vaulting of a previously-uncollected trait, minted to the recorded `originalSeller` by `ReturnAuctionModule` at vault-settle). Dual-minter scoping is bytecode-enforced: the Title minter cannot reach the Proof range; the Proof minter cannot reach id 111; both reject ids ≥ 112. The Punks themselves are NOT ERC721 tokens — they're held at the canonical CryptoPunks market's `punkIndexToAddress` slot. Exposes ERC-173 `owner()` for OpenSea / Blur recognition during the launch-setup window — one-way `renounceOwnership()` to `address(0)`; no `transferOwnership`. Emits ERC-7572 `ContractURIUpdated()` on every title / Proof mint. Bytecode-scan: no market-write selectors; only renounce-pattern owner surface (no admin / migration / withdrawal). |
| [`Patron`](../contracts/src/Patron.sol) | Live-bid hub. Holds the global ETH live bid. `acceptBid`, `acceptListing`, allowlist, bounded setters (function names follow the deployed ABI). Under inflow consolidation Patron fills ONLY via `LiveBidAdapter`: `receive()` rejects every sender other than the adapter (`NotAdapter`), and the attributed `contribute` / cleared-refund `poolReplenish` surfaces moved to the adapter (so the `Contribution` / `BareTopUp` / `PoolReplenished` events now emit there; legacy `BidToppedUp` removed). `setWiring` gained a third `liveBidAdapter` arg. No admin withdrawal path. |
| [`ReturnAuctionModule`](../contracts/src/ReturnAuctionModule.sol) | Per-Punk 72-hour return auction. `placeBidWithReferral(punkId, referrer, tag)` records the current high bidder's referrer in `referrerOfHighBid[punkId]` (overwritten on every accepted bid). Reserve formula (re-snapshotted fresh on each re-auction), anti-snipe extension, cleared / vault-path splits. A settled sale slot is **reusable** — re-auctioning a rescued Punk resets the slot (highBid/highBidder/settled + clears the stale referrer); only a live unsettled sale blocks a new `startSale`. Cleared-path cost split: 65% → `LiveBidAdapter.poolReplenish` (buffered + metered into the live bid; `CLEARED_BID_BPS = 6_500`), 10% → VaultBurnPool (`CLEARED_VAULT_BURN_BPS = 1_000`), residual 25% → BuybackBurner. The premium `(highBid − cost)` routes 5% to the recorded referrer (`REFERRER_PREMIUM_BPS = 500`, 35k-gas fail-closed send) and the remainder to VaultBurnPool; the referrer slice never touches the cost-based bid / burn / vault-burn slices. Under inflow consolidation the 65% refund goes to `LiveBidAdapter`, not Patron directly — the module gained a one-shot `setLiveBidAdapter` (mirroring `setVaultBurnPool`). Cleared settle pays no protocol-funded keeper tip (self-incentivized by the winning bidder's locked ETH). Deploys its own `ReturnAuctionEscrow` for cleared-path provenance round-trip. Emits extended `ReturnAuctionCleared(..., referrer, referrerShare)` plus a new `BidPlaced(punkId, bidder, referrer, amount, tag, endsAt)` alongside the existing bid event. (Contract names follow the deployed ABI.) |
| [`ReturnAuctionEscrow`](../contracts/src/ReturnAuctionEscrow.sol) | Settlement escrow. On cleared settle, the module round-trips the won Punk through the canonical market so it emits `PunkBought(escrow, module, highBid)` at the hammer price. (Contract name follows the deployed ABI.) |
| [`BuybackBurner`](../contracts/src/BuybackBurner.sol) | Permissionless `executeStep(minOut)` — paced V4 swap of ETH for 111, burns to `0xdead`. Caller earns a small reward. The fixed 5% V4 price-impact cap partial-fills thin-pool burns so one step never creates enough movement to be worth sandwiching. |
| [`ProtocolAdmin`](../contracts/src/ProtocolAdmin.sol) | 1-year auto-locking admin role. |

### Fee infrastructure (claim-token recipients from the 3-leg hook split)

| Contract | Role |
|---|---|
| [`LiveBidAdapter`](../contracts/src/LiveBidAdapter.sol) | **The single inflow governor.** Every ETH source that funds the live bid enters here and is buffered + metered into Patron via `sweep()` — the hook's ~83.33% baseline + 100% antiSniperExtra and the locker's share of the 0.5% LP fee (= 100% at launch by depth dominance; declines pro-rata if public LPs add positions post-window), plus the moved-from-Patron `contribute(referrer, tag)` (attributed top-ups, `REFERRER_CONTRIB_BPS = 500` to the referrer, 35k-gas fail-closed) and `receive()` (bare top-ups), plus the module-only `poolReplenish(punkId)` (the cleared-auction rescue refund). `Contribution` / `BareTopUp` / `PoolReplenished` events live here now. **Two-mode metering keyed on the live bid vs `activationThreshold`:** below the threshold the adapter is in fast mode (buffer forwards uncapped, no cooldown, clamped so a single forward fills only up to the threshold — the launch warm-up); at or above it the adapter throttles to a `maxSweepWei`-per-`minBlocksBetweenSweeps` rate cap so a burst drips in. `activationThreshold` self-manages: `sweep()` reads the latest `acceptBid` clearing price from `PermanentCollection` (via the `IPCAcquisitionReader` ref) and resets the threshold to 75% of it (a −25% band), clamped to `ACTIVATION_THRESHOLD_HI = 100 ether`; deploy seed = 30 ETH; `acceptListing` rows are skipped. `sweep()` and the hook-driven `streamForward()` share ONE cooldown clock (`maxSweepWei` per `minBlocksBetweenSweeps`, keyed on a single `lastSweepBlock`); `streamForward()` does NOT sync the threshold, and fast-mode forwards do NOT arm the cooldown. `setActivationThreshold(uint256)` is a bounded manual override gated `onlyAdminEvenIfLocked` — the adapter's lone lifetime carve-out, surviving the 1y auto-lock until the admin role is burned. The two rate-cap setters (`setMaxSweepWei` / `setMinBlocksBetweenSweeps`) stay `checkAdmin`-gated and lock at the 1y expiry (no carve-out). The threshold auto-track + fast mode knowingly re-open audit findings M-1 and L-2 (both accepted — worst case is a permanently-throttled bid with no value extracted; see [`docs/SECURITY.md`](SECURITY.md) and the `AUDIT NOTE` in `_syncActivationThreshold`). The former POL-diversion subsystem and rebate slot are deleted. Constructor takes a `returnAuctionModule` ref (gates `poolReplenish` module-only) and the `PermanentCollection` records-core ref. (Contract name follows the deployed ABI; semantically the live-bid leg recipient.) |
| [`VaultBurnPool`](../contracts/src/VaultBurnPool.sol) | Burn accumulator, two assets. **ETH** from the cleared-auction proceeds split in `ReturnAuctionModule.settle` (`(highBid − cost) + 10% × cost`), swept to BuybackBurner. **111** from the token's venue transfer tax (this contract is the tax `burnAddress`), burned in place via `token.burn` (totalSupply drops). Both release on the same `sweep`, only on a vault-path settle (`ReturnAuctionModule`-only), called DIRECTLY (no `try/catch`) so the burn is GUARANTEED (required + non-reverting; ETH forward best-effort). One-shot `setup(token)` wires the 111 token post-deploy; the only 111 outflow is `burn` (bytecode-scan: no withdrawal / no `transfer`/`transferFrom`/`approve`). |
| [`ProtocolFeePhaseAdapter`](../contracts/src/ProtocolFeePhaseAdapter.sol) | Receives the ~16.67% baseline protocol leg. `sweep()` claims it from the fee escrow and forwards it to PCController (86.67% PC treasury / 13.33% LAYER burn) from block 1 — a lean single-target forwarder, no phase gate. |
| [`ReferralPayout`](../contracts/src/ReferralPayout.sol) | Pull-based per-referrer ETH ledger. Hook-only `notify`; stray ETH not credited; reverting recipient reinstates balance. |

### Composability surface (dormant at launch; reserved for Design B)

| Contract | Role |
|---|---|
| [`PCSwapContext`](../contracts/src/PCSwapContext.sol) | Transient-storage (EIP-1153) in-swap flag registry. `authorizedExtension == address(0)` at launch; flag permanently `false`. |
| [`PCNoReentry`](../contracts/src/libraries/PCNoReentry.sol) (library) | `notInSwap` mixin. Applied to the 7 PC contracts reachable from the hook's swap path. |
| [`PCReentrancyGuard`](../contracts/src/libraries/PCReentrancyGuard.sol) (library) | Shared `nonReentrant` mutex mixin (EIP-1153 transient storage, auto-clearing). Inherited by `Patron`, `LiveBidAdapter`, `ReturnAuctionModule`, `PunkVaultTitleAuction` — replaces the four byte-identical inline `_lock` mutexes. Sibling of `PCNoReentry`. |
| [`TokenAdminPoker`](../contracts/src/TokenAdminPoker.sol) | Retained token-admin holder. Owner-gated `bindExtension` / `lockExtension`. |
| [`IPCCallbackExtension`](../contracts/src/interfaces/IPCCallbackExtension.sol) | Canonical builder-facing callback interface. Single method: `onSwap(PoolKey, SwapParams, BalanceDelta, bytes) returns (bytes32)`. |

### Design B dispatcher (verified-ready; not bound at launch)

| Contract | Role |
|---|---|
| `PCDispatcher` | **Production permissionless dispatcher.** Anyone can claim a callback slot by paying a fee (forwarded directly to Patron — registering grows the live bid). Slots are bounded; once full, new registrations must outbid the lowest-fee occupant by a premium. Misbehaving callbacks auto-disabled by an on-chain failure counter; anyone re-enables via a small fee. All economic parameters are immutable constructor arguments with hard bounds. No admin, no owner, no governance. Pre-launch deliverable: contract + adversarial test suite proving the mechanic. Binding via `TokenAdminPoker.bindExtension` is a deliberate post-launch action. See [docs/DISPATCHER_DESIGN.md](DISPATCHER_DESIGN.md). |
| [`UnipegDispatcher`](../contracts/test/mocks/UnipegDispatcher.sol) | Worked demo dispatcher (owner-gated registry). Kept as the integration example for builder docs; NOT the production platform. |
| [`UnipegArt`](../contracts/test/mocks/UnipegArt.sol) | Sample callback that mints "unipeg" NFTs on attributed swaps. Reference implementation of `IPCCallbackExtension`. |

### Renderer + auxiliary (production)

| Contract | Role |
|---|---|
| [`PermanentCollectionMosaicRenderer`](../contracts/src/PermanentCollectionMosaicRenderer.sol) | Shipped on-chain SVG renderer. 11×10 main trait grid plus one "final type" cell pulled out beneath the grid's bottom-left, on a square 356×356 canvas. Three-state cells (Collected / Pending / Uncollected). Reads `collectedMask` + `pendingMask` + `firstVaultedPunk`; consults `PunkSvgFragmentCache` and `TraitIconCache` with live-PunksData fallback. See [§ The artwork](#the-artwork--renderer--trait-grid) above. |
| [`RendererRegistry`](../contracts/src/RendererRegistry.sol) | Holds the active renderer address. The indirection lets the implementation be swapped without redeploying the protocol; freeze / 1-year admin timer auto-locks the slot. |
| [`PunkSvgFragmentCache`](../contracts/src/PunkSvgFragmentCache.sol) | Per-Punk on-chain SVG cache. `cachePunk(id)` is permissionless; amortizes render gas. |
| [`TraitIconCache`](../contracts/src/TraitIconCache.sol) | Per-trait isolated-trait SVG cache. `cacheTrait(id)` is permissionless. Empty at launch; community-fillable. [docs/RENDERER_CACHE.md](RENDERER_CACHE.md) covers the operating model. |
| [`PunkVaultTitleAuction`](../contracts/src/PunkVaultTitleAuction.sol) | One-shot English auction for the **Vault Title NFT** (token id 111 on `PunkVault`). `kickoff()` activates once `collectedCount() ≥ 22` (`KICKOFF_THRESHOLD`); 24-hour clock + 15-min/+1h uncapped anti-snipe; 5% minimum bid increase. Settled proceeds route 100% to the immutable `payoutRecipient` (0% to Patron; `PATRON_SHARE_BPS = 0`, pull-based `pendingProceeds` queue claimed via `withdrawProceeds`). No admin functions. See [§ The Title and the 111 Proofs](#the-title-and-the-111-proofs--punkvault-issues-both) above. |
| [`PermanentCollectionProofRenderer`](../contracts/src/PermanentCollectionProofRenderer.sol) | On-chain SVG + JSON renderer for Proof token ids 0..110. Reads `vault.proofMeta(id)`, `traitIconCache.buildFragment(traitId)`, and `punkSvgCache.buildFragment(punkId)`. The image is a 24×24 trait tile on a `#8F918B` background; a minted Proof draws the acquired Punk faintly behind the trait at 5% opacity, with the isolated trait icon composited crisply on top, while an unminted Proof shows the trait alone. Trait name + Punk id + sequence "N of 111" + vault-settle block live in the JSON envelope of a **minted** Proof. `tokenURI(id)` reverts `ProofNotMinted` for an unminted Proof (no preview envelope; the canonical `PunkVault.tokenURI` path likewise reverts `UnknownTokenId`); the raw `svg(traitId)` view stays total for the unminted trait tile. Dispatched into by `PermanentCollectionMosaicRenderer.tokenURI(id)`. |

---

## Deploy settings

Every numeric value the protocol launches with. Source of truth:
[`contracts/script/Deploy.s.sol`](../contracts/script/Deploy.s.sol) and the
hard-coded constants in each contract. Anything tunable lists its
admin bounds (the `[MIN, MAX]` enforced in the setter); anything constant
lists "const, no setter."

### Token + pool

| Setting | Value | Notes |
|---|---|---|
| Token name | `permanent collection` | const |
| Token symbol | `111` | const. User standing rule: never begin a ticker with `$`. |
| Total supply | `1,110,000,000 × 1e18` | const |
| Salt | `keccak256("permanent collection 111PUNKS v2")` | const |
| Paired token | `address(0)` (native ETH) | const, V3 factory supports native-ETH pairing |
| Starting tick | computed at deploy from `ETH_USD_PRICE` env var (default $2,100); at reference: configured `-172,200` → on-pool `+172,200` after factory inversion | Targets **~$69K launch FDV** at the reference price under the post-reserve 999M supply. With current 1.11B supply at this tick, launched FDV is ~$77K. Math in [`Deploy.s.sol::_computeStartingTick`](../contracts/script/Deploy.s.sol). |
| Tick spacing | `200` | const |
| Pool fee flag | `0x800000` (DYNAMIC_FEE_FLAG) | const, signals dynamic fees to V4 PoolManager |
| LP fee | `5,000 ppm` (0.5%) | const, sits ON TOP of the 6% hook skim (canonical total = 6.5%) |
| Pool extension at launch | `address(0)` (none) | reserved slot; Design B dispatcher bound later (or never) |

**Locker LP positions** (12-segment thickened-floor taper, bps share of locker LP). Positions are defined as **offsets from the deploy-time starting tick**; the offset shape is invariant across ETH-price regimes, only the absolute origin shifts. Reshaped (vs. the original 50/.../800/400 layout) after an empirical slippage probe — position 0 thickened 7.5× to absorb small launch buys; positions 10/11 reduced to compensate.

| Lower offset | Upper offset | Position share (bps) |
|---|---|---|
| 0 | 1,400 | **375** ← thickened floor |
| 1,400 | 3,400 | 150 |
| 3,400 | 6,000 | 300 |
| 6,000 | 9,400 | 500 |
| 9,400 | 14,000 | 800 |
| 14,000 | 19,400 | 1,300 |
| 19,400 | 26,000 | 1,700 |
| 26,000 | 33,000 | 1,700 |
| 33,000 | 40,000 | 1,300 |
| 40,000 | 47,000 | 1,000 |
| 47,000 | 53,400 | **600** ← reduced tail |
| 53,400 | 60,000 | **275** ← reduced tail |
| **Total** | | **10,000** |

**Direction.** Per the empirical tick-direction probe, 111 appreciation walks the on-pool tick **downward** (lower 111/ETH ratio = 111 more valuable). The locker's positions span downward in on-pool tick from the launch tick — position 0's upper bound IS the launch tick, position 11's lower bound is the deepest. Earlier docs used "stairs going up" language that was directionally inverted; the corrected framing is "stairs going down in tick."

### Hook fee split (`ArtCoinsHookSkimFee.SkimHookFeeData`)

| Field | Value | % of swap volume |
|---|---|---|
| `baselineSkimBps` | 6,000 (100k denom) | **6.00%** total skim |
| `bountyBps` | 8,333 of baseline | **5.00%** → LiveBidAdapter |
| protocol slice (derived) | `10,000 − 8,333 = 1,667` of baseline | **1.00%** → ProtocolFeePhaseAdapter |
| `maxReferralBpsOfVolume` | 250 (100k denom) | **≤0.25%** clawed from protocol slice |
| `antiSniperExtra` (MEV window) | 100% to bounty | added on top of baseline during anti-sniper window |

Spec invariant: `bountyBps < 10_000` and referral never reduces bounty — it's
clamped to `min(volume cap, protocol slice)`. Referrals pay from the first
swap when the swap carries a valid referrer; with no/invalid referrer the
slice stays in the protocol leg. The vault-burn trading leg has been
retired; `VaultBurnPool` is fed exclusively from the cleared-auction
proceeds split in `ReturnAuctionModule.settle`.

### Venue-scoped buy-side transfer tax (`ArtCoinsToken` / `TaxConfig`)

A second, independent fee on `111` itself — default-off shared infra on
`ArtCoinsToken`, switched on only for PC via the factory's
`deployTokenWithProtocolBpsAndTax` entry point. It blunts the side-pool
starvation pattern (PNKSTR-style) by removing the routing discount to trade
off-canonical.

| Setting | Value | Notes |
|---|---|---|
| Trigger | sender is a known venue, recipient not exempt | Fires ONLY on 111 *leaving* a DEX venue (a buy / pool outflow). Never on sells (111 into a pool), wallet/Safe/4337 sends, or lending/bridge/CEX flows. |
| Rate | `taxBps = 1500` (15% launch); cap 20% | The router investigation (`docs/router-results/`) found 5% is **sub-parity** vs a 0.3%-LP side pool; 12.5% floor, **15% first clean sell-leak defense with margin** (larger at 6.5% canonical). Bounded `[0, taxBpsMax = 2000]`; the token's `TAX_BPS_ABSOLUTE_MAX = 2000` makes "never above 20%" structural. Launch at 15% with headroom to 20%. **Cap raise (was 5%) requires the focused re-audit + artcoins push/pin-bump before broadcast.** |
| Proceeds | accrue in `VaultBurnPool`, burned (`token.burn`, totalSupply drops) on each vault-path settle | No ETH conversion (no sell pressure), no LP (no perpetual ETH to pair). The tax `burnAddress` is `VaultBurnPool`; its burn fires in the same `sweep` as the ETH leg, when the protocol permanently collects a Punk. The bid is fed *indirectly* by the routing shift onto canonical. |
| Canonical exemption | hook-attested amount-pinned EIP-1153 budget | The hook attests realized 111-out on canonical buys (`_afterSwap`) and canonical LP exits (`_afterRemoveLiquidity`); the token exempts exactly that. The budget is amount-pinned and **fungible within the tx**, so it can subsidize a same-tx side-pool buy, but only up to the realized canonical 111-out (bounded, not self-defeating). It only benefits a buyer already concentrating real volume on canonical (the behavior the tax encourages), and burned proceeds are never a bid-funding source. |
| V4 coverage | the PoolManager singleton (one check) | Covers ALL V4 pools — canonical AND every side pool, present + future. |
| V2/V3 coverage | 44 precomputed pools, frozen at deploy | {Uniswap V2, SushiSwap V2, PancakeSwap V2} × {WETH, USDC, USDT, DAI} (12) + {Uniswap V3, PancakeSwap V3} × {WETH, USDC, USDT, DAI} × 4 fee tiers (32), CREATE2-derived from `address(this)` in the constructor. PancakeSwap V3 uses its own PoolDeployer + 2500 tier. No dynamic add path — generous by design; every derivation proven against the live factory in `TaxedTokenForkTest`. Covers the liquid AMM space only (not wrappers/OTC/CEX — depth is the primary moat). |
| Exempt allowlist | BuybackBurner, conversion locker | PC contracts that receive 111 from the PoolManager and must not be skimmed. |
| Rate setter | `TokenAdminPoker.setTokenTaxBps` | Two-key carve-out (TokenAdminPoker.owner OR ProtocolAdmin.admin), bounded `[0, taxBpsMax = 2000]` (20% cap; launch 15%). |

Composability note: because the tax is venue-scoped, `111` is a clean ERC20
in every non-DEX context (wallets, Safe, 4337, lending, bridges, CEX) — only
DEX *buys* are affected, and only off-canonical buys are actually skimmed. It is
mechanically a fee-on-transfer token in that one narrow context; the residual
risk is integration *policy*, not mechanics. Full design rationale (and the
alternatives that were rejected): `docs/TRANSFER_TAX_INVESTIGATION.md`.

### Anti-sniper window (`ArtCoinsMevLinearSkim`)

| Field | Value |
|---|---|
| `startingBps` | 90,000 (90% trader cost at t=0) |
| `endingBps` | 6,000 (6% baseline skim — steady state) |
| `duration` | 1,800 seconds (= 30 minutes) |
| Decay shape | Linear interpolation in skim-module bps |

After expiry the MEV module auto-disables and the pool runs at the static 6%
baseline. The "anti-sniper extra" (above-baseline portion) routes 100% to
LiveBidAdapter for the duration. During the MEV anti-sniper window (T+0 to
~T+30min), the hook blocks `beforeAddLiquidity` for **all callers** — public
LPs cannot mint positions while the window is active. Once
`mevModuleOperational(pid)` returns false, the gate disengages **permanently**
and any address can add liquidity to the pool; the block is a launch-window
mechanism, not an ongoing protocol restriction.

### LP locker reward distribution

`ArtCoinsLpLockerFeeConversion` (the conversion-aware locker, deployed fresh
per launch). Configured with a single reward slot:

| Slot | Bps | Recipient | Admin |
|---|---|---|---|
| 0 | 10,000 | `LiveBidAdapter` | `0xdEaD` (`BURN_ADMIN` — recipient permanently locked) |

`ARTCOINS_PROTOCOL_BPS = 0` — no factory-injected artcoins protocol slot.
LAYER burn revenue flows via the hook's protocol leg → PCController → 13.33%
burn at the controller level, not via the locker.

### ReturnAuctionModule

| Setting | Value | Type |
|---|---|---|
| `AUCTION_DURATION` | 72 hours | const (constant name follows the deployed ABI) |
| `SNIPE_TRIGGER_WINDOW` | 15 minutes | const |
| `SNIPE_EXTENSION` | +1 hour, uncapped | const |
| Reserve formula | `acquisitionCost × (101 + previousTrials) / 100` | const, snapshotted at `startSale` |
| Cleared split | 65% cost → Patron / 25% cost (residual) → BuybackBurner / 10% cost → VaultBurnPool; premium `(highBid − cost)` splits 5% → referrer (if any) + remainder → VaultBurnPool | `CLEARED_BID_BPS = 6_500`, `CLEARED_VAULT_BURN_BPS = 1_000`, `REFERRER_PREMIUM_BPS = 500`, all const, no setter |
| Cleared settle keeper reward | none — settle pays no protocol-funded tip (self-incentivized by the winning bidder's locked ETH) | removed; the full 65%-cost share reaches the adapter |
| `REFERRER_PREMIUM_BPS` | 500 (5% of premium, fail-closed) | const, no setter |
| `REFERRER_GAS` | 35,000 | const (matches `ReferralPayout.CLAIM_GAS`) |
| `referrerOfHighBid` | `mapping(uint16 => address)` | overwritten on every accepted bid; tracks the current high bidder's referrer only — outbid bidders lose attribution |
| `minBidIncrementBps` | 100 (1.0%) | **const, no setter** (M-1 remediation value; the geometric deterrent is robust across the old `[50, 2,500]` range, so it's frozen rather than left as admin surface) |

### Patron

| Setting | Value | Type |
|---|---|---|
| `finderFeeCapBps` | 50 (0.50%) | **const, no setter** (keeper-tip bound; formerly admin-tunable `[1, 200]`) |
| `finderFeeFixedCap` | 0.01 ether | **const, no setter** (formerly admin-tunable `[0.001, 0.05] ether`) |
| `MIN_BID_FOR_LISTING` | 0.5 ether | const (protects against dust-listing drains) |
| `ALLOWLIST_DELAY` | 24 hours | const (new sellers activate 24h after `addAllowedSeller`) |
| `receive()` gate | adapter-only (`NotAdapter` otherwise) | under inflow consolidation Patron fills ONLY via `LiveBidAdapter` |
| `setWiring` args | `(permanentCollection, returnAuctionModule, liveBidAdapter)` | the third `liveBidAdapter` arg pins the sole faucet at wiring time |
| `contribute` / `poolReplenish` | **moved to `LiveBidAdapter`** | with the `REFERRER_CONTRIB_BPS = 500` / `REFERRER_GAS = 35_000` constants and the `Contribution` / `BareTopUp` / `PoolReplenished` events; `IPatron` no longer declares them |

### LiveBidAdapter

| Setting | Initial value | Type |
|---|---|---|
| `maxSweepWei` | 2 ether | admin-tunable `[0.01, 5] ether` (locks at 1y, no carve-out) |
| `minBlocksBetweenSweeps` | 150 (~30 min) | admin-tunable `[1, 7,200]` (locks at 1y, no carve-out) |
| `activationThreshold` | 30 ETH (`ADAPTER_ACTIVATION_THRESHOLD`) | self-syncs in `sweep()` to 75% of the latest `acceptBid` clearing price (−25% band), clamped to `ACTIVATION_THRESHOLD_HI = 100 ether`; `acceptListing` rows skipped |
| `setActivationThreshold(uint256)` | — | bounded manual override, `onlyAdminEvenIfLocked` — the adapter's lone lifetime carve-out; survives the 1y lock until the admin role is burned |
| Metering modes | two, keyed on live bid vs `activationThreshold` | BELOW threshold → fast mode (buffer forwards uncapped, no cooldown, clamped to fill only up to the threshold); AT/ABOVE → throttled to `maxSweepWei` per `minBlocksBetweenSweeps`. `sweep()` + `streamForward()` share one `lastSweepBlock`; fast-mode forwards do NOT arm it. |
| Keeper reward | 0.5% of forwarded, ≤ 0.01 ether | `KEEPER_REWARD_BPS = 50`, const |
| `REFERRER_CONTRIB_BPS` | 500 (5% of `contribute()` value, fail-closed) | const, no setter (moved here from Patron under inflow consolidation) |
| `REFERRER_GAS` | 35,000 | const (matches `ReferralPayout.CLAIM_GAS`) |
| Inflow surfaces | `contribute(referrer, tag)`, `receive()`, module-only `poolReplenish(punkId)` | the single faucet into Patron; emits `Contribution` / `BareTopUp` / `PoolReplenished` |
| `returnAuctionModule` (ctor) | the module address | gates `poolReplenish` module-only (immutable) |

### BuybackBurner

| Setting | Initial value | Type |
|---|---|---|
| `minBlocksBetweenSteps` | 1 (every block) | admin-tunable `[1, 50,400]` (~1 week) |
| `maxStepWei` | 1 ether | admin-tunable `[0.01, 10] ether` |
| `maxSlippageBps` | 500 (5%) | **compile-time constant** (primary price-impact cap, not tunable) |
| Execution reward | 0.5% of step, ≤ 0.01 ether | `EXEC_REWARD_BPS = 50`, const |

The sandwich guard is deliberately mechanical: `executeStep` never moves the V4
pool more than the fixed 5% `sqrtPriceLimitX96` cap. If the pool is thin, V4
partial-fills and the leftover ETH stays queued; if the pool is deep, more of
the attempted step fills without increasing the per-call movement. The cap sits
below the measured buy/sell fee moat, so a mempool attacker cannot make the
burner's own trade large enough to repay the round trip.

There is no static tokens-per-ETH floor and no EMA/reference-price state. A
static floor tightens as 111 appreciates; a stateful EMA can wedge if organic
price movement outruns successful burner steps. The current design avoids both
failure modes by making each permissionless burn small enough to be uneconomic
to sandwich rather than trying to classify price moves as good or bad.

### PunkVaultTitleAuction

| Setting | Value | Type |
|---|---|---|
| Kickoff threshold | `collectedCount ≥ KICKOFF_THRESHOLD` (= 22 at launch) | const |
| `TITLE_TOKEN_ID` | 111 | const (PunkVault is the ERC721; ids 0..110 = Proofs with `tokenId == traitId`, id 111 = Title) |
| `PunkVault.MAX_PROOF_TOKEN_ID` | 110 | const (highest valid Proof id; ids ≥ 112 unreachable) |
| `PunkVault.PROOF_COUNT` | 111 | const (one Proof per trait) |
| `AUCTION_DURATION` | 24 hours | const |
| `SNIPE_TRIGGER_WINDOW` | 15 minutes | const |
| `SNIPE_EXTENSION` | +1 hour, uncapped | const |
| `MIN_INCREASE_BPS` | 500 (5%) | const |
| `PATRON_SHARE_BPS` / `PAYOUT_SHARE_BPS` | 0 / 10,000 (0% / 100%) | const |
| `payoutRecipient` | `0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4` | **immutable**, set at construction; NOT the deployer EOA |
| Refund send gas budget | 30,000 | const |

### ProtocolAdmin

| Setting | Value |
|---|---|
| `ADMIN_TIMER_DURATION` | 365 days (1 year auto-lock) |
| Initial admin | deployer EOA |
| Burn / off-switch | `transferAdmin(address(0))` — reachable at any time, even after the timer lapses (only renewals/rotations are time-gated; auditor M-1). Permanently zeroes `admin` and disables every carve-out. |
| Post-lock carve-out 1 | `Patron.addAllowedSeller` / `removeAllowedSeller` (works as long as admin EOA isn't burned via `transferAdmin(0)`) |
| Post-lock carve-out 2 | `LiveBidAdapter.setActivationThreshold` (bounded manual override of the metering threshold; gated by `ProtocolAdmin.admin()` alone via `onlyAdminEvenIfLocked` — survives the 1y lock until the admin EOA is burned) |
| Post-lock carve-out 3 | `TokenAdminPoker.setHookMaxReferralBps` (bounded `[0, 1_000]` bps of swap volume; callable by EITHER `TokenAdminPoker.owner` OR `ProtocolAdmin.admin()` EOA — freezes only when BOTH are burned) |
| Post-lock carve-out 4 | `TokenAdminPoker.setTokenTaxBps` (bounded `[0, 2000]` bps, 20% cap, launch 15%; callable by EITHER `TokenAdminPoker.owner` OR `ProtocolAdmin.admin()` EOA — freezes only when BOTH are burned) |
| Rate-cap setters (NOT carve-outs) | `LiveBidAdapter.setMaxSweepWei` / `setMinBlocksBetweenSweeps` are `checkAdmin`-gated and lock at 1y like the rest of the economic surface |

### Token-admin role (`TokenAdminPoker`)

Retained at deploy. Owner is the deployer EOA. Exposes:
- `bindExtension(ext)` — bind a Design B dispatcher (one-time, gated by owner)
- `lockExtension()` — permanently freeze the extension binding
- `setHookMaxReferralBps(newCap)` — tune the per-swap
  referral cap on the skim hook, bounded `[0, 1_000]` bps. Two-key gate
  (owner OR `ProtocolAdmin.admin()`) — one of the three ProtocolAdmin
  carve-outs, freezes only when BOTH roles are burned. Launches at `250`.
- `setTokenTaxBps(newBps)` — tune the venue-scoped buy-tax rate, bounded
  `[0, 2000]` bps (20% cap; launch 15%). Same two-key gate.
- `transferOwnership(newOwner)`

There is intentionally **no metadata-refresh `poke()`**. `PunkVault` emits its
own ERC-7572 `ContractURIUpdated` on every title/proof mint — the only refresh
signal the protocol needs, fired straight from the real collection events. The
separate 111 ERC20 marketplace card is mission-orthogonal (read by nothing
on-chain) and is left to marketplace re-indexing.

### External addresses (mainnet)

| Role | Address |
|---|---|
| CryptoPunksMarket (2017) | `0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB` |
| PunksData (sealed; ENS `punksdata.eth`) | `0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C` (datasetHash `0x92117ce6…` pinned in `PermanentCollection` constructor) |
| V4 PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` (referenced; PC's pool is native-ETH so WETH isn't on the hot path) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| V4 Universal Router | `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8AF` |
| `ArtCoinsFactory` (fresh, tax-aware) | deployed in Phase 1; the legacy V3 factory `0xF051cd…6793e` can't produce the tax token and is NOT used |
| `ArtCoinsFeeEscrow` (fresh) | deployed in Phase 1; the legacy `0xDD1b8C…1C06` is NOT reused |
| `ArtCoinsMevLinearSkim` module (fresh) | deployed + allowlisted in Phase 1 (the SKIM variant via `setMevModule`); NOT the legacy fees module `0xAe19E4…` |
| PunkStrategy listing contract | `0xc50673EDb3A7b94E8CAD8a7d4E0cD68864E33eDF` (seeded into `Patron.allowedSellers`) |
| Title-auction payout recipient | `0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4` |
| Burn admin (locker slot owner) | `0x000000000000000000000000000000000000dEaD` |

### Pre-deploy env vars

The deploy script reads these at runtime; missing values revert preflight
rather than mid-broadcast:

| Var | What it points at |
|---|---|
| `PRIVATE_KEY` | Deployer EOA private key |
| `CONVERSION_LOCKER` | Address of the freshly-deployed `ArtCoinsLpLockerFeeConversion` instance (allowlisted by artcoins owner) |
| `PC_CONTROLLER` | Address of PC's dedicated `ProtocolFeeController` instance (86.67/13.33 treasury/burn config) |
| `ARTCOINS_HOOK_SKIM` | Deployed `ArtCoinsHookSkimFee` address |
| `ARTCOINS_MEV_SKIM` | Deployed `ArtCoinsMevLinearSkim` address |

### Pre-deploy operator ops (artcoins side)

These have to happen BEFORE `forge script Deploy.s.sol --broadcast` lands on mainnet:

1. **Broadcast `contracts/script/DeployArtcoinsLaunchStack.s.sol`** (run by the artcoins owner; env `PC_TREASURY` + `LAYER_BURN_ROUTER`). It deploys + wires the FRESH stack PC launches on — a tax-aware `ArtCoinsFactory` (the live V3 factory can't produce the tax-token bytecode), a fresh `ArtCoinsFeeEscrow`, the skim hook, the skim MEV module, a PC `ProtocolFeeController` (86.67/13.33), and a conversion locker — including the CRITICAL `escrow.addDepositor(hook)` (missing it bricks every swap). The deploy + wiring is the shared `PCLaunchStackDeployer`, the exact code `DeployRehearsalForkTest` and the fork fixtures run.
2. Set its stdout addresses as Deploy.s.sol's env vars (`ARTCOINS_FACTORY` / `ARTCOINS_FEE_ESCROW` / `ARTCOINS_HOOK_SKIM` / `ARTCOINS_MEV_SKIM` / `PC_CONTROLLER` / `CONVERSION_LOCKER`), then `forge script Deploy.s.sol --broadcast`.

(This supersedes the stale artcoins `DeployConversionLockerAndWire.s.sol`, which wired the LEGACY hook/MEV against the existing V3 factory/escrow — the wrong stack. The existing mainnet hook/MEV/escrow are NOT used.)
6. (Optional, post-launch) Deploy `PCDispatcher` for Design B; bind via `TokenAdminPoker.bindExtension` only after audit + readiness.

---

## Composing on top

The official 111 pool is a composable host. Anyone can route swaps through
it, get credit on-chain, and earn a small builder fee — without forking
liquidity, without weakening the core. Two surfaces:

**Design A — attribution (live at launch).** Encode a `PCSwapData` struct
into the V4 swap's `hookData`. The hook decodes it and routes up to 0.25%
of swap volume (from the first swap) to the referrer slot via
`ReferralPayout`. The encoding has a documented gotcha:
the hook decodes as a **1-tuple struct** (`abi.decode(swapData,
(PoolSwapData))`); encoding as a 2-tuple of bytes is off by 32 bytes and
silently fails. Use
[`app/lib/swap/attribution.ts:encodeAttributionHookData`](../app/lib/swap/attribution.ts)
or follow that pattern.

**Design B — permissionless synchronous extensions (built; not bound at launch).**
The hook reserves a single per-pool extension slot.
`PCDispatcher` is the production
platform built to occupy that slot when PC decides: any builder can claim
a callback slot by paying a fee (which goes to Patron — registering grows
the live bid). Slots are bounded; once full, new registrations must outbid
the lowest-fee occupant by a premium. Misbehaving callbacks are
auto-disabled by an on-chain failure counter; anyone can re-enable a
disabled slot with a small fee. **No admin, no owner, no governance** —
all economic parameters are immutable constructor arguments with hard
bounds. Builders implement `IPCCallbackExtension.onSwap(...)` and run
under per-slot gas budgets + try/catch isolation. Reentrancy guards on
all decorated PC entry points (`notInSwap` modifier on Patron,
ReturnAuctionModule, BuybackBurner, LiveBidAdapter,
VaultBurnPool, ProtocolFeePhaseAdapter,
PunkVaultTitleAuction) block callbacks from reentering PC's economic
surfaces. Independently of `notInSwap` (which is a no-op until a Design
B dispatcher is bound), every entry point that pays an
attacker-controllable keeper reward also carries an inline
`nonReentrant` mutex — Patron, ReturnAuctionModule, PunkVaultTitleAuction,
and the permissionless fund-mover `LiveBidAdapter.sweep`. For that
fund-mover the mutex is the only ACTIVE same-tx reentry guard at launch
(audit L-1). `BuybackBurner.executeStep` instead relies on its
block-pacing (`lastStepBlock` written before the unlock callback) and
shares no state with another fund-mover, so it carries no mutex by
    design. Its sandwich safety comes from the fixed V4 price-impact cap:
    one `executeStep` may partial-fill, but it cannot push the pool far
    enough to repay an attacker's buy/sell round trip.

The dispatcher is **verified-ready, not yet bound** — binding via
`TokenAdminPoker.bindExtension` is a deliberate post-launch action. The
[`UnipegDispatcher`](../contracts/test/mocks/UnipegDispatcher.sol) is the
worked demo (owner-gated for documentation purposes); production
permissionless flow lives in `PCDispatcher`.

Detail: [docs/COMPOSABILITY.md](COMPOSABILITY.md) (builder guide) +
[docs/DISPATCHER_DESIGN.md](DISPATCHER_DESIGN.md) (mechanic spec, threat
model, audit scope).

---

## Where things live

```
contracts/                   Foundry, solc 0.8.26, evm_version cancun
  src/                       Permanent + fee + composability + demo contracts
                             incl. PCDispatcher (Design B production platform,
                             verified-ready but not bound at launch)
  src/interfaces/            Canonical interfaces, incl. IPCCallbackExtension
                             (builder-facing Design B callback interface)
  src/demos/                 Worked examples (UnipegDispatcher, UnipegArt)
  test/                      Headline suites:
                             LaunchInvariantForkTest (adversarial tests
                             against live Deploy.s.sol bytecode);
                             PCDispatcherSmokeTest (16 mechanic tests) +
                             PCDispatcherIntegrationTest (50 builder-
                             simulator tests covering clean + adversarial
                             callback shapes, exhaustive constructor bounds,
                             eviction edge cases, fee atomicity, events,
                             and lock-flow rehearsal)
  script/Deploy.s.sol        Full one-broadcast deployment;
                             reads CONVERSION_LOCKER + PC_CONTROLLER env vars
                             (does NOT deploy PCDispatcher at launch)
  lib/artcoins/              Submodule resolved from ripe0x/artcoins (the
                             public mirror of the artcoins working repo).
                             Contains the rewritten ArtCoinsHookSkimFee (the
                             three-leg hook), conversion locker patches,
                             MEV module.

app/                         Next.js 15 frontend.
  app/page.tsx               Homepage with the trait grid + live state
  app/trade/page.tsx         111 swap UI (Universal Router + Permit2)
  app/referrals/page.tsx     Referrer dashboard (claim hook accrual + ledger)
  app/builders/page.tsx      Builder docs + live Design B binding status
  lib/swap/attribution.ts    PCSwapData hookData encoder (the 1-tuple gotcha)
  lib/swap/useReferrer.ts    ?ref=0x... URL parser + localStorage persistence
  lib/abis/                  ABIs auto-emitted by scripts/generate-abis.ts
  api/rpc/                   Server-side RPC proxy (RPC_URL is server-only)

indexer/                     Ponder indexer
  abis/                      Same ABI source as app/lib/abis

scripts/
  generate-abis.ts           forge build → ABIs in app/ and indexer/
  snapshot-punksdata.ts      Mass-reads PunksData → TS snapshot
  seed-fork.ts               Local fork seeding
```

---

## Operations

| Task | Doc |
|---|---|
| Run it all locally | [docs/RUN_LOCAL.md](RUN_LOCAL.md) |
| Mission / liveness property set | [docs/MISSION_PROPERTIES.md](MISSION_PROPERTIES.md) |
| Design B dispatcher spec | [docs/DISPATCHER_DESIGN.md](DISPATCHER_DESIGN.md) |
| Composability surface (Design A + Design B builder guide) | [docs/COMPOSABILITY.md](COMPOSABILITY.md) |
| Transfer-tax design | [docs/TRANSFER_TAX_INVESTIGATION.md](TRANSFER_TAX_INVESTIGATION.md) |
| On-chain metadata routing | [docs/METADATA_REFERENCE.md](METADATA_REFERENCE.md) |
| Trait-icon cache operating model | [docs/RENDERER_CACHE.md](RENDERER_CACHE.md) |
| artcoins submodule pin + how to verify it | [docs/ARTCOINS_PIN.md](ARTCOINS_PIN.md) |

## AI agent context

[`AGENTS.md`](../AGENTS.md) (root; `CLAUDE.md` is a symlink to it) —
comprehensive AI-agent-context doc covering the above plus operational
rules, RPC discipline, and the "things that can't be changed later"
framing. Kept in lockstep with this doc.

---

## Doc maintenance

When the protocol's architecture changes (a fee plumbing tweak; a new
permanent contract; a Design B activation; an admin power change), update
these docs **in the same commit** as the code change:

1. **`docs/SYSTEM.md` (this file)** — the canonical overview. If the
   change wouldn't show up here, it's probably not material enough to be
   architectural.
2. **`AGENTS.md`** (`CLAUDE.md` is a symlink to it) — the AI-agent-context
   twin of SYSTEM.md.
3. **`docs/PROTOCOL.md`** — protocol spec; updates to any economic
   parameter, invariant, or state-machine transition.
4. **`docs/SECURITY.md`** — trust boundaries; reentrancy posture; new
   permanent surface.
5. **`docs/COMPOSABILITY.md` / `docs/DISPATCHER_DESIGN.md`** — builder +
   Design B surface.
6. **`docs/METADATA_REFERENCE.md` / `docs/TRANSFER_TAX_INVESTIGATION.md`** —
   metadata routing and transfer-tax rationale.
7. **`README.md` / `DESCRIPTION.md`** — public-facing copy. Numbers and
   fee mechanism must match SYSTEM.md.

If a doc no longer has a unique purpose, delete it rather than letting it
drift — the maintained set is the one indexed above.
