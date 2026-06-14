# PERMANENT COLLECTION — mission / liveness / equilibrium properties

> **Status: living reference, first cut 2026-05-30.** This is a technical
> review artifact: it uses the deployed code identifiers verbatim (`acceptBid`,
> `markCustody`, `rescue`, `attemptCount`, etc.) and is **not** aligned to the
> user-facing language guide.
>
> **RE-STATUS (this reconciliation, post-fix): R1 and R3 now HOLD.** The two
> properties this doc originally marked **VIOLATED** were violated by finding
> **MF-1**, which is now **CLOSED** in this tree. The sole-carrier target guard
> (hard invariant #22) is enforced in `PermanentCollection.recordAcquisition`
> (keyed off the live `collectedMask`) and mirrored in `Patron` for an
> early/cheap revert. The orthogonal rescue-strand vector (a rescuer who buys
> and holds #8348) is bounded ECONOMICALLY, not by a reclaim mechanic: denying
> bit 23 means acquiring #8348 at the reserve (≥ `1.01×` the protocol's cost,
> which a rational owner only accepts at ≥ market value), so the cheapest denial
> is "own #8348 and refuse the live bid" — the legitimate refusal equilibrium
> (E4). The re-auction redesign lets a `ReturnedToMarket` Punk be re-auctioned,
> but it does NOT let the protocol reclaim a *held* #8348 (re-acquisition needs
> the current owner's offer), and there is no direct-vault path to secure a
> below-market or donated carrier from interception. Coverage:
> `contracts/test/SoleCarrierGuard.t.sol`. The in-body R1/R3/E2 verdicts below
> are the pre-fix snapshot; read them together with this banner.
> Separately, **NF-1 (the `BuybackBurner` EMA wedge) is SUPERSEDED**: this
> tree's `BuybackBurner` has no EMA gate and no `pokeEma`. It uses a fixed
> `maxSlippageBps = 500` sqrt-price impact cap, so the K3 "EMA wedge" caveat
> below no longer describes the deployed code.

## Why this document exists

The protocol ships **21 hard invariants** (CLAUDE.md / `docs/SYSTEM.md`). Every
one of them is a **safety** property: "nothing bad happens" (no reentrancy, no
overflow, monotonic `collectedMask`, append-only `Acquisition[]`, frozen custody
transitions, no admin withdrawal path, and so on). Tests and security audits
verify safety.

There were **zero** written-down **liveness / equilibrium / mission** properties:
"the good thing the system exists to do actually keeps happening." That asymmetry
is a structural blind spot. Liveness failures are slow-burn: they surface at the
distributional tail, at economic equilibrium, or after a price / volume / time
regime shift, so point-in-time tests miss them. This document closes the gap by
stating the mission properties as single testable assertions, so future changes
can be checked against "does this still let the artwork finish?" the same way
they're checked against the safety invariants.

## The mission (the artwork's actual commitment)

Assemble a **permanent** on-chain collection of CryptoPunks that covers **all 111
distinct traits** (Full Set = `(1 << 111) - 1`). A trait is **collected** only
when a Punk carrying it is **vaulted** (a silenced 72-hour return auction) with
that trait recorded as the target. The system posts one global ETH live bid;
eligible Punk owners accept it; each accepted Punk runs a return auction that
either **clears** (rescued to a bidder, trait *not* collected) or is **silenced**
(vaulted forever, *only* the target trait collected). The work completes when
`collectedMask == FULL_SET_MASK`, **or** it settles into a legitimate equilibrium
where the remaining traits are held by owners who refuse the live bid.

## The load-bearing distinction (internalize before reading the properties)

- A trait staying uncollected because its holders **rationally refuse** the live
  bid is the **legitimate, intended equilibrium**. It *is* the artwork. The
  protocol explicitly may settle there. **Not** a property violation.
- A trait becoming **uncollectable**, or collection **stalling**, because of a
  protocol **mechanic** is an **intent failure**. That **is** a property
  violation.

Every property below is about the second kind. Where a property is marked
**soft**, a "violation" that is really the refusal-equilibrium is acceptable as
long as it's a conscious equilibrium and not a mechanic artifact.

## Method and provenance (two-pass independence)

This set was derived in two passes to avoid anchoring:

1. **Pass 1 (blind).** The reviewer derived a property set directly from primary
   sources (`docs/SYSTEM.md`, `docs/PROTOCOL.md`, `CLAUDE.md`, the contracts in
   `contracts/src/`, and a live read of the canonical `PunksData` dataset)
   **before** consulting any seed list.
2. **Pass 2 (reconcile).** That set was reconciled against a provided seed list
   (groups A-F). The reconciliation table at the bottom records, per seed item,
   whether it was **kept**, **reworded**, **rejected**, or **promoted to a
   verified result**, plus the properties added that the seed missed.

Each property carries a **provenance** tag: `seed` (kept from the seed),
`seed→reworded`, or `added` (introduced in Pass 1, absent from the seed).

Each property carries a **status** from the review:
`HOLDS` (verified to hold), `VERIFIED-TRUE` (an open seed question resolved
affirmatively), `VIOLATED` (a confirmed finding breaks it), or
`HOLDS w/ caveat`.

---

## Group I — Collection reachability and terminal-state liveness

| ID | Property (single testable assertion) | Hard/Soft | Status | Provenance |
|----|--------------------------------------|-----------|--------|------------|
| **R1** | No protocol *mechanic* can render a trait permanently uncollectable; only holder *refusal* may leave a trait uncollected. | hard | **HOLDS** (MF-1 CLOSED) | seed (A1) |
| **R2** | The Full Set is *combinatorially* reachable on the real trait↔Punk graph under the collection rules (target-only collection, one trait per vault, terminal vault). | hard | **VERIFIED-TRUE** | seed→reworded (A2) |
| **R3** | Every sole-carrier and few-carrier trait retains **at least one mechanic-reachable collection path at all times**: no single acquisition action can consume the *last* reachable path to a trait. | hard | **HOLDS** (MF-1 CLOSED) | **added** |
| **R4** | No reachable state permanently blocks intake: given a funded bid and an offered eligible Punk, an acquisition can always complete (no permanent `pendingTraitCount` wedge, no lock that blocks *every* carrier of an uncollected trait). | hard | **HOLDS** | seed (A3) |
| **R5** | `collectedMask` can keep *climbing* toward 111 under expected actor behaviour, not merely never-decrease. | soft | **HOLDS** | seed (A4) |
| **R6** | Every recorded acquisition reaches a terminal settle (vault or rescue); none can be stuck in-flight forever with its target trait locked pending. | hard | **HOLDS** | **added** |

**R2 is the sharpest correction to the seed.** The seed framed reachability as an
open question and floated "a single Punk that is the sole carrier of ≥2 traits
makes the Full Set impossible." A live read of `PunksData` (datasetHash matches)
**refutes** that hypothesis: **no Punk anywhere is the sole carrier of ≥2 traits**,
and a bipartite matching of traits to distinct carrier Punks **saturates 111/111**.
The Full Set is reachable. See the combinatorial result in the findings doc.

**R3 is the property the seed missed and the one the headline finding MF-1
originally violated; it now HOLDS.** There is exactly **one** sole-carrier trait
(bit 23 `"7 Attributes"`, carried only by Punk **#8348**, the unique forced edge
in the 111/111 matching). Pre-fix, the acquisition mechanic let the caller choose
**any** uncollected in-mask target with **zero coupling to carrier count**, so a
single mistimed vaulting of #8348 against a *common* target would have deleted the
only path to bit 23 forever. The fix (hard invariant #22, the sole-carrier target
guard) couples #8348's target to bit 23 while bit 23 is uncollected, in
`PermanentCollection.recordAcquisition` (authoritative, keyed off the live
`collectedMask`) and mirrored in `Patron`, so the last reachable path to bit 23
can no longer be consumed by a wrong-target acquisition. The static graph is
reachable (R2) and the *dynamic* path-preservation guarantee (R3) now holds with
that guard in place.

---

## Group II — Live-bid sustainability (fuel)

| ID | Property | Hard/Soft | Status | Provenance |
|----|----------|-----------|--------|------------|
| **B1** | Under non-zero trading volume the live bid refills toward the Punk floor fast enough to sustain a non-zero acquisition cadence; it cannot be mechanically pinned at 0 while traits remain uncollected. | soft | **HOLDS** | seed (B1) |
| **B2** | No throttle / cooldown / rate-cap state can *permanently* prevent bid funding; throttles may only **pace**, and buffered fuel can only move toward the bid. | hard | **HOLDS** | seed (B2) |
| **B3** | The live bid can reach the prevailing Punk floor across price regimes (the rate cap only paces refill speed); a rising floor causes rate-paced lag, never a permanent ceiling. | soft | **HOLDS** | seed (B3) |
| **B4** | A volume-independent fuel path exists (`Patron.contribute` / `receive`) so the mission is never hard-gated on a single fuel source. | hard | **HOLDS** | **added** |

`LiveBidAdapter.sweep` (and the per-swap `streamForward`) forward at most
`maxSweepWei` of the buffer per `minBlocksBetweenSweeps` blocks, both keyed off one
shared `lastSweepBlock`; the buffer **only** exits toward `Patron`, and `acceptBid`
drains `Patron` toward ~0 so the bid keeps refilling at the rate cap toward the
prevailing floor. The only forward target is `Patron.receive()`, which cannot
revert, so `sweep` cannot wedge. The rate cap is correctly scoped to *refill speed
only*: it never sets a bid amount, never gates an acquisition, never moves a wei
on its own, and both knobs are bounds-checked, so even a manipulated value cannot
create a funding-prevention mechanic; it can only change how fast the buffer
drips. (It is still new permanent surface on the immutable adapter and warrants the
fresh focused audit the docs already flag, separate from this liveness
assessment.)

---

## Group III — Keeper / permissionless-action liveness

| ID | Property | Hard/Soft | Status | Provenance |
|----|----------|-----------|--------|------------|
| **K1** | Settling a ready auction is always permissionless and either incentivized or cheap enough that some aligned party performs it; collection is never *gated* on a keeper tip. | soft | **HOLDS** | seed→reworded (C1) |
| **K2** | No mission-critical permissionless action (`settle`, `sweep`) can be forced into an always-reverts state by adversarial input. | hard | **HOLDS** | seed (C4) |
| **K3** | Buy-and-burn (`BuybackBurner.executeStep`) is not permanently brickable by the slippage gate across appreciation regimes. | soft (secondary) | **HOLDS** (NF-1 SUPERSEDED) | seed (C2) |
| **K4** | `LiveBidAdapter.sweep` (bid funding) is permissionless and cannot be starved to always-revert. | hard | **HOLDS** | seed (C3) |

**K1 nuance (checked, not a gap).** The vault-path `settle` pays no keeper reward
at all: the per-settle keeper-reward subsystem was removed, so a silenced auction
always settles for free
(confirmed by `test_VaultPath_SettlesWithEmptyPoolAndNoReward` / `StuckPunk.t.sol`)
and the trait
still collects. Settling is permissionless and never gated on a tip; the natural
settler is the Proof-NFT recipient (the recorded `originalSeller`) plus other
aligned parties.

**K3 (NF-1 SUPERSEDED).** The EMA-wedge caveat no longer applies to the deployed
code. This tree's `BuybackBurner` has **no EMA gate** and **no `pokeEma`**; its
sandwich resistance is a single fixed `maxSlippageBps = 500` (5%) sqrt-price
impact cap applied through V4's `sqrtPriceLimitX96` (a compile-time constant, not
tunable, no admin). V4 partial-fills when the limit binds, so a step can never
revert-and-freeze; there is no reference EMA to wedge. K3 holds unconditionally,
and the "wedge under sustained appreciation" failure mode the older revision
described is gone with the gate it referenced. (Buy-and-burn remains **off the
collection path** regardless; the live bid is funded by the volume skim.)

---

## Group IV — Rational-actor equilibrium

| ID | Property | Hard/Soft | Status | Provenance |
|----|----------|-----------|--------|------------|
| **E1** | A bid level exists at which vaulting (silence) is the rational outcome for *some* carriers of every trait; the system is not structurally rigged so that rescuing always dominates (which would yield zero collection). | hard | **HOLDS** | seed (D1) |
| **E2** | No actor can profitably grief the mission to a *permanent halt* (drain-the-bid loops, perpetual rescue, sandwiching, side-pool diversion, keeping auctions open). | hard | **HOLDS w/ caveat** | seed (D2) |
| **E3** | Reserve escalation (1%/trial against a trait) is *monotone toward collection*: repeated trials make rescue strictly costlier, never cheaper, so a contested trait trends toward vaulting. | hard | **HOLDS** | seed (D3) |
| **E4** | The cost of *denying* a trait (perpetually rescuing its carriers) is bounded below by the carriers' own market value, so denial is never indefinitely cheaper than the protocol's persistence. | hard | **HOLDS** | **added** |

**E2 caveat (now resolved).** Anti-snipe keep-open griefing is self-limiting (the
1% minimum increment forces geometric capital growth) and perpetual same-trait
rescue is self-limiting (the rescuer is handed the Punk and loses the premium). The
one sharp case, a single rescue of sole-carrier #8348 permanently denying bit 23,
was the rescue-stranding vector folded into MF-1. Its resolution is **economic,
not a reclaim mechanic**: a rescuer who buys and holds #8348 can keep bit 23
uncollected, but only by paying ≥ the reserve (`1.01×` the protocol's cost, which
a rational owner accepts only at ≥ market value) — denial therefore costs ≥ owning
the Punk and refusing the live bid, the legitimate refusal equilibrium (E4). The
re-auction redesign lets a `ReturnedToMarket` Punk be re-auctioned, but it does
NOT let the protocol reclaim a *held* #8348 (re-acquisition needs the current
owner's offer); the sole-carrier target guard (invariant #22) only prevents
WASTING #8348 on a common trait. So E2 holds as worded — griefing is unprofitable
— with the understood residual that an *affordable* (unprofitable) refusal can
settle the mission at 110/111 (the equilibrium the system permits), and that
there is no direct-vault path to secure a below-market or donated #8348 from
interception.

**Design decision on this residual (accepted, not mechanically fixed).** A
direct-vault path for the sole carrier of an uncollected trait (skip the return
auction, or set that sale's reserve to `type(uint).max`) was considered and
deliberately NOT added. Two reasons: (1) the 110/111 refusal equilibrium is an
*intended* terminal state, not a failure: the work completes the Full Set OR
settles into equilibrium, so a permanently-held #8348 is within the design; and
(2) the protocol's value is its immutability, and a special-case vault path is
new permanent surface for an edge a rational actor never reaches. A rational
owner holds or sells at market (both already handled); only an *altruistic
below-market donation* of #8348 is interceptable, and even that contributor can
still route through the normal `acceptBid` flow bearing the auction risk. This
is recorded as a conscious choice, not an oversight.

**E3 / E4 calibration note.** Escalation never makes rescue *cheaper*, so E3
holds. But it is weaker than it looks against the only reachable denial vector
(exhausting a *few*-carrier trait's distinct carriers): ≤24 carriers means at most
+24% on the final rescue. The real deterrent against carrier-exhaustion is E4 (the
carriers' market value), not the ramp. Both protect the mission; the ramp is not
the load-bearing part.

---

## Group V — Frozen-decision regime robustness

| ID | Property | Hard/Soft | Status | Provenance |
|----|----------|-----------|--------|------------|
| **F1** | Every immutable constant / formula stays mission-correct (or has a carve-out) across launch → 1 year → 10× price → 100× volume; no frozen value can brick a mission-critical path by regime shift. | hard | **HOLDS w/ caveat** (NF-2) | seed (E1) |
| **F2** | The admin carve-outs are exactly the parameters that must track a shifting market regime, and nothing dangerous is left open; nothing the mission must adapt is frozen without a carve-out. | hard | **HOLDS w/ caveat** | seed (E2) |
| **F3** | Absolute-ETH keeper / finder caps stay economically meaningful at high gas / price regimes, *or* collection does not depend on them. | soft | **HOLDS** (via the "or") | **added** |

The decisive structural fact: the live bid's **primary** funding is the 5% hook
skim on swap **volume**, which is depth-, price-, and tip-independent. The reserve
formula is monotone mission-aligned. `MIN_BID_FOR_LISTING` is a dust guard that
only blocks bids too small to buy a Punk and never gates `acceptBid`. The locker
tail FDV ceiling caps only a *bonus* depth leg in an extreme-success tail. The
adapter rate-cap constants (`maxSweepWei` / `minBlocksBetweenSweeps`) change only
refill *speed*, never collectability.

**NF-2 (the residual under F1/F3).** The four `0.01 ETH` keeper/exec reward caps
(`BuybackBurner`, `ReturnAuctionModule`, `Patron`, `LiveBidAdapter`) are frozen in
ETH terms with no setter and go underwater versus gas at modest gwei. F3 still
holds via its "or": every mission-critical action has a non-tip driver
(cleared-settle by the winning bidder, vault-settle by the Proof recipient or any
aligned party, `acceptBid` by the owner who is paid the whole bid). The cap
erosion degrades the *full-autonomy* nice-to-have, not the mission.

**F2 observation (NF-1 SUPERSEDED, now moot).** The older revision flagged
`BuybackBurner.setReferenceDeviationBps` (an EMA-gate tuning knob that was not a
carve-out and locked at the 1-year mark) as the one debatable spot under F2,
because combined with the EMA wedge a post-lock wedge could be unrecoverable. That
knob and the EMA gate are **gone** in this tree: the burner's price protection is
the fixed `maxSlippageBps = 500` impact cap, which has no tuning knob to freeze
and no wedge state. F2's "nothing the system must adapt is frozen without a
carve-out" no longer has that contested case.

---

## Group VI — Definitional consistency

| ID | Property | Hard/Soft | Status | Provenance |
|----|----------|-----------|--------|------------|
| **D1** | "111 traits" / Full Set mask / "collected" / "eligible" / "permanent" are defined **identically** across the `PunksData` hash, collection logic, renderers, and docs. | hard | **HOLDS** | seed (F1) |
| **D2** | Proof NFTs mint **exactly once per first-vaulting**; `popcount(collectedMask) == #vaulted Punks == #Proofs`, in lockstep, capped at 111. | hard | **HOLDS** | seed→reworded (F2) |
| **D3** | `collectedMask == FULL_SET_MASK` implies 111 distinct Punks physically in `PunkVault`, one per trait (target-only + terminal vault reconciles with "111 represented by vaulted Punks"). | hard | **HOLDS** | seed (F3) |

The `PunksData` 5+11+8+87=111 taxonomy, `PermanentCollection.TRAIT_COUNT`, both
renderers' `TOTAL_TRAITS`/`PROOF_COUNT`, and `PunkVaultTitleAuction.TRAIT_COUNT`
all read 111. The Proof gate `firstVaultingOfTrait = (maskBeforeSettle & targetBit)
== 0` and the `collectedMask` flip read the **same** pre-state inside the same
`nonReentrant settle`, so a Proof mints **iff** the bit flips; over-mint is
triple-guarded and the only theoretical under-mint (`proofRecipient == 0`) is
excluded by the immutable `originalSeller != 0` enforcement. The lone definitional
drift found is on the **auxiliary Title path** (`KICKOFF_THRESHOLD = 22` in code
vs "50% / ≥56 traits" in docs + two test suites), which has no authority over
`collectedMask`, Proof accounting, or the completion test. Tracked as NF-3
(document-only).

---

## Pass-2 reconciliation against the seed list

| Seed item | Disposition | Final property | Note |
|-----------|-------------|----------------|------|
| A1 | keep | R1 | unchanged |
| A2 | **promote to verified result** | R2 | seed framed it as an open risk; the matching saturates 111/111, so it is VERIFIED-TRUE. The real risk is the dynamic R3, which the seed under-specified by fixating on the empirically-nonexistent "sole-carries ≥2" case. |
| A3 | keep | R4 | holds |
| A4 | keep | R5 | soft |
| B1, B2, B3 | keep | B1, B2, B3 | B2 verified; B1/B3 hold as pacing/equilibrium |
| C1 | reword | K1 | added "collection is never *gated* on a tip"; the 0-reward-below-0.5-ETH case is not a gap because `settle` is free |
| C2 | keep (downgrade for mission) | K3 | real wedge (NF-1) but off the collection path, so soft/secondary for the mission |
| C3, C4 | keep | K4, K2 | hold |
| D1 | keep | E1 | holds |
| D2 | keep | E2 | holds; the #8348 rescue case folds into MF-1 |
| D3 | keep + caveat | E3 | monotone non-cheapening holds; calibration caveat added (E4 is the real deterrent) |
| E1 | keep | F1 | holds; NF-2 is the degrading residual |
| E2 | keep + observation | F2 | carve-outs assessed sufficient; the EMA-gate-tuning lock is the one debatable spot |
| F1, F2, F3 | keep | D1, D2, D3 | hold; lockstep made precise; Title drift = NF-3 |
| **added by Pass 1** | — | **R3, R6, B4, E4, F3 (the "or" form), D2/D3 lockstep precision** | the seed missed sole/few-carrier dynamic path-preservation (R3 — the one MF-1 violates), stuck-pending liveness (R6), volume-independent fuel (B4), denial-cost-via-market-value (E4), and the lockstep precision in D2/D3 |

### Where the reviewer diverged from the seed (signal)

- The seed's confirmed candidate ("#8348 sole-carries ≥2 traits ⇒ Full Set
  impossible") is **factually refuted** by the dataset. Adopting it verbatim would
  have propagated a false premise. The surviving, sharper finding (MF-1) is a
  *dynamic* path-preservation failure on the lone rarity-1 trait, not a static
  combinatorial impossibility.
- The seed treated reachability (A2) as the headline risk; the review shows
  reachability **holds** and the headline risk is the *mechanic that can destroy*
  the one forced matching edge (R3), which the seed did not name.
- The seed's keeper (C2) and frozen-constant (E1) concerns are real but, traced to
  the mission, land **off the collection path** (NF-1, NF-2), so they degrade
  autonomy/tokenomics rather than defeat the mission.
