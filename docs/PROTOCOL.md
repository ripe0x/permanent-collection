# Protocol (V4 + hook redesign)

> This document covers the V4 protocol PLUS the three-leg hook redesign
> (bid + protocol + referral-from-protocol), `PCSwapContext` +
> decorations, `ReferralPayout`, and the Design B (UnipegDispatcher)
> pattern. Design B is preserved in deploy state (`PCSwapContext`
> deployed, decorations applied) but NOT bound at launch — the pool's
> extension slot is empty (`pcSwapContext.authorizedExtension == address(0)`).



PERMANENT COLLECTION is a permissionless on-chain mechanism that builds an
immutable collection of CryptoPunks traits. The artcoin (ticker `$111`)
is launched through the artcoins protocol; 6% of every trade flows back into
the system. V4 inverts the acquisition direction: the protocol posts a single
global ETH **live bid**. Any eligible Punk owner can accept it. The accepted
Punk enters a 72-hour **return auction** at `paid + premium`; cleared sales
split 65/25/10 of cost (live-bid refill / 111 burn / vault-burn pool), plus the overbid premium; unreturned Punks enter the vault.

**A trait is not permanent just because the protocol acquired a Punk
carrying it.** A trait is only **permanent** when a Punk carrying that trait
enters the immutable vault. Anything else is in-return-auction or
uncollected.

## Trait state model (unchanged from V3.1)

Every one of the 111 trait bits is in exactly one state at any given block:

| State | Meaning | Renderer |
|---|---|---|
| **Uncollected** | No vaulted Punk carries this trait, and no in-flight Punk carries it as a return-auction target either. | Isolated trait visual, dim. |
| **In return auction** | At least one in-flight Punk carries this trait as its return-auction target, but no vaulted Punk does yet. | Isolated trait visual, accent color. |
| **Permanent** | At least one vaulted Punk carries this trait. Final. Counts toward completion. | The first vaulted Punk that brought the trait, rendered through its actual pixels. |

The on-chain core stores:

- `collectedMask` — canonical 111-bit completion mask. Only updated when a
  Punk is **Vaulted**. Monotonically increasing.
- `pendingTraitCount[trait]` — how many in-return-auction acquisitions
  currently target this trait.
- `pendingAcquisitionMask[punkId]` — the single target bit this specific Punk
  contributed pendingly at acquisition time.

A trait is **in return auction** iff `(collectedMask >> trait) & 1 == 0 AND
pendingTraitCount[trait] > 0`. `FULL SET COMPLETE` flips true the first block
in which `collectedMask == FULL_SET_MASK`.

## State machine

```
[ 111 trading on artcoins V4 pool, 6% baseline skim per swap ]
                       │
                       │ ArtCoinsHookSkimFee (every swap):
                       │   _beforeSwap: _processSkimAndAttribution splits + accrues
                       ▼   _afterSwap: _flushAccruedSkim drains all 3 legs in same tx
   ┌───────────────┬───────────────┬──────────────┐
   │               │               │
 live bid        protocol        referral
 ~83.33% base    ~16.67% base    ≤ 0.25% volume
 + 100% MEV-extra (from block 1) (FROM protocol slice)
   │               │               │
   ▼               ▼               ▼
LiveBidAdapter  ProtocolFeePhaseAdapter  ReferralPayout
   │ sweep()→     │ sweep() → PCController              │ pull-based per-referrer ledger
   ▼              │   (86.67% PC-treasury /             │ (paid from the first swap)
 Patron          │    13.33% LAYER burn), from block 1
   │
 LiveBidAdapter is the SINGLE inflow governor: every ETH source that funds the
 live bid (the skim above, contribute() / receive() top-ups, the cleared rescue
 refund) enters the adapter and meters into Patron via sweep(). Patron.receive()
 accepts ETH ONLY from the adapter (NotAdapter otherwise).

 Metering / cadence: TWO modes, keyed on the live bid (Patron.balance) vs
 activationThreshold. BELOW the threshold the adapter is in fast mode — the
 buffer forwards UNCAPPED with no cooldown, clamped so a single fast-mode
 forward fills the bid only UP TO the threshold (the launch warm-up). AT or
 ABOVE the threshold the adapter throttles: every forward (both sweep() and the
 per-swap streamForward() below) drips at most maxSweepWei per
 minBlocksBetweenSweeps blocks, sharing a single lastSweepBlock, so a burst
 cannot lurch the standing offer past floor prices in one block; it buffers and
 drips. activationThreshold self-manages: sweep() reads the latest acceptBid
 clearing price from PermanentCollection (via IPCAcquisitionReader) and resets
 the threshold to 75% of it (a −25% band), clamped to ACTIVATION_THRESHOLD_HI =
 100 ether (deploy seed 30 ETH); acceptListing rows are skipped so a cheap
 finder listing can't drag the ceiling down. Besides the permissionless
 keeper/UI sweep(), the bid also advances PER-SWAP: the artcoins hook calls the
 adapter's streamForward() in _beforeSwap (opt-in via IPreSwapStream,
 balance-gated try/catch, can't brick a swap), flushing prior swaps' buffered
 bounty leg into Patron — buffered-native only, no keeper reward, no-op below
 MIN_STREAM_WEI (0.01 ETH) and on cooldown; streamForward() does NOT sync the
 threshold, it reads whatever the last sweep() set, and fast-mode forwards do
 NOT arm the shared cooldown. Runs outside the Design-B inSwap window, so it
 composes with a bound dispatcher.

(VaultBurnPool fed exclusively from cleared-auction proceeds in
ReturnAuctionModule.settle: (highBid − cost) + 10% × cost per rescue;
swept to BuybackBurner only on a vault-path settle.)

[ Patron — global live bid ]
       │
       ├── acceptBid(punkId)    ◄── Punk owner lists exclusively to hub at a
       │                                real price ≈ the live bid; ANYONE then
       │                                finalizes (permissionless). Seller paid
       │                                by the market (pendingWithdrawals →
       │                                withdraw). Function name follows the
       │                                deployed ABI.
       │
       └── acceptListing(punkId)   ◄── Anyone calls; seller must be
                                       allowlisted (PunkStrategy, etc.);
                                       finder fee paid to caller
                       │
                       ▼
       [ ReturnAuctionModule ]
                       │ 72h return auction, opening reserve = acquisitionCost
                       │   × (101 + previousTrials) / 100 (snapshot at startSale)
                       │ 15-min anti-snipe → +1h extension (uncapped)
                       ▼
        ┌──────────────┴──────────────┐
        │                             │
   bid ≥ reserve (Cleared)        no bid by deadline (Vaulted)
        │                             │
        ▼                             ▼
PunkReturnedToMarket           PunkVaulted
        │                      collectedMask |= 1 << targetBit
  ┌─────┬─────┬───────┬───────┐  pendingTraitCount[target]--
  │     │     │       │       │  Punk → PunkVault
adapter burner vaultBurnPool referrer vaultBurnPool
65%cost 25%cost 10%cost       5% of   remainder  (+ VaultBurnPool
→Patron (residual)            premium of premium    sweeps to Burner)
(buffered;                           (referrerOfHighBid;
 metered)                             fail-closed → folds into
                                      vaultBurnPool)
  Punk → buyer (via ReturnAuctionEscrow provenance round-trip)
  traits NOT permanent (unless already)
```

Per cycle, exactly one of two things is removed from circulation:

- **Cleared** — A bid above reserve returns the Punk to the market.
  Hard-coded split of acquisitionCost: `CLEARED_BID_BPS = 6_500` → 65%
  refills the live bid via `LiveBidAdapter.poolReplenish` (buffered +
  metered into Patron, not paid to Patron directly — inflow
  consolidation), `CLEARED_VAULT_BURN_BPS = 1_000` → 10% to
  VaultBurnPool, residual 25% → BuybackBurner. The surplus (`highBid −
  acquisitionCost`) is the **premium**, split between the high-bid
  referrer (5% via `REFERRER_PREMIUM_BPS = 500`, if any) and
  VaultBurnPool (remainder). Reserve formula (`× (101 +
  previousTrials) / 100`) guarantees `highBid > acquisitionCost` so
  the premium is always > 0. If no referrer is attached to the high
  bid, or the referrer send reverts / OOGs within the 35k-gas budget,
  the referrer slice folds back into VaultBurnPool BEFORE the transfer
  — settle never reverts on referrer failure. The referrer slice is
  funded entirely from fresh external value (the rescuer's voluntary
  overbid); it never reduces the cost-based bid, burn, or vault-burn
  shares. 111 supply contracts (later, when someone calls
  `executeStep`). Punk stays in circulation with a new owner; **no
  traits become permanent** unless already represented by another
  vaulted Punk.
- **Not returned / Vaulted** — The Punk enters the immutable vault. ONLY
  the recorded target trait becomes permanent and counts toward
  completion. Other uncollected bits on the same Punk remain available
  for future acquisitions. VaultBurnPool sweeps to BuybackBurner so the
  vault outcome also produces a 111 supply reduction. 111 supply
  contracts (later).

## Architecture

### Permanent core

| Contract | Role |
|---|---|
| [`PermanentCollection`](../contracts/src/PermanentCollection.sol) | Records-only core. Holds NO Punks. Stores `collectedMask`, the immutable `Acquisition[]` log, `firstVaultedPunk[traitId]`, `pendingTraitCount[traitId]`, per-Punk custody. Constructor pins PunksData's `datasetHash`. Only `patron` may call `recordAcquisition`; only `returnAuctionModule` may call `markCustody`. |
| [`PunkVault`](../contracts/src/PunkVault.sol) | Immutable terminal custodian for vaulted Punks AND `solmate/ERC721` issuer of **112 named tokens**: the Title (token id 111, minted by `PunkVaultTitleAuction`) and **111 Proofs** (token ids 0..110, one per first-vaulting of a previously-uncollected trait, minted at vault-settle to the `originalSeller` recorded on the acquisition). Proof `tokenId == traitId`. Dual-minter scoping enforced in bytecode: `titleAuction` mints only id 111; `returnAuctionModule` mints only ids 0..110; both reject ids ≥ 112. Constructor sets `returnAuctionModule` immutably. No Punk-withdrawal function. Bytecode-scan tests assert the absence of every CryptoPunks market write selector. |
| [`PermanentCollectionProofRenderer`](../contracts/src/PermanentCollectionProofRenderer.sol) | On-chain SVG + JSON renderer for Proof token ids 0..110. The image is a 24×24 trait tile on the `#1c1c1c` uncollected-cell color; a minted Proof draws the acquired Punk faintly behind the trait at 5% opacity with the isolated trait icon composited crisply on top, while an unminted Proof shows the trait alone. Trait name, Punk id, sequence position, and vault-settle block live in the JSON envelope. Reads `vault.proofMeta(id)`, `punksData.traitName(traitId)`, `traitIconCache.buildFragment(traitId)`, and `punkSvgCache.buildFragment(punkId)`. Pre-mint reads produce a preview envelope so the registry probe succeeds before any Proof has been issued. No admin, no setters, no storage of its own. |
| [`Patron`](../contracts/src/Patron.sol) | The V4 entry-point hub. Holds the global live-bid ETH. Exposes `acceptBid(punkId)`, `acceptListing(punkId)` (function names follow the deployed ABI), the allowed-sellers allowlist, and the tunable parameter setters. Under inflow consolidation Patron fills ONLY via `LiveBidAdapter`: `receive()` rejects any sender other than the adapter (`NotAdapter`), and the attributed `contribute` / cleared-refund `poolReplenish` surfaces moved to the adapter. No admin withdrawal path. |
| [`ReturnAuctionModule`](../contracts/src/ReturnAuctionModule.sol) | Per-Punk 72-hour return auction (contract name follows the deployed ABI). Opening reserve = `acquisitionCost * (101 + previousTrials) / 100` (snapshot at startSale; first attempt = 1.01x paid, each subsequent attempt against the same trait adds another 1%). 15-min anti-snipe extends by 1 hour; extensions are uncapped (actively-contested Punks stay in bid indefinitely). Cleared proceeds split: 65% cost → Patron, 25% cost (residual) → BuybackBurner, 10% cost + `(highBid − cost)` → VaultBurnPool (hard-coded `CLEARED_BID_BPS = 6_500`, `CLEARED_VAULT_BURN_BPS = 1_000`, no setter — identifier `CLEARED_BID_BPS` follows the deployed ABI). Push refunds with pull fallback. Cleared delivery round-trips the Punk through `ReturnAuctionEscrow` so the canonical market records the clearing price. Non-reentrant + notInSwap. |
| [`ReturnAuctionEscrow`](../contracts/src/ReturnAuctionEscrow.sol) | Transient settlement escrow deployed by `ReturnAuctionModule` and pinned to it. On cleared settle, lets the module round-trip the won Punk through the canonical market so it emits a real `PunkBought(escrow, module, highBid)` at the hammer price (recorded buyer is the module, not the human winner — see Settlement). `listForSettlement`/`sweepProceeds` are module-only; `receive()` accepts ETH only from the Punk market. No admin/withdrawal surface. |
| [`BuybackBurner`](../contracts/src/BuybackBurner.sol) | Receives ETH from cleared return auctions (25% × cost residual) and vault-burn pool sweeps (which carry `(highBid − cost) + 10% × cost` per cleared rescue, swept on vault-path settle). `executeStep(minOut)` is permissionless: deducts a small caller reward (≤0.5% of step, ≤0.01 ETH), swaps native ETH for 111 on the artcoins-launched V4 pool, sends the 111 token to `0xdead`. (Contract name follows the deployed ABI.) |
| [`LiveBidAdapter`](../contracts/src/LiveBidAdapter.sol) | **The single inflow governor.** Every ETH source that funds the live bid enters here and meters into Patron via `sweep()`: the **~83.33% baseline live-bid leg + 100% antiSniperExtra** from the hook (claim-tokens), the locker's 0.5% LP fee on its position depth (= 100% at launch by depth dominance, including the two concentrated tail positions' fees), the moved-from-Patron `contribute(referrer, tag)` (attributed top-ups, `REFERRER_CONTRIB_BPS = 500`, 35k-gas fail-closed) and `receive()` (bare top-ups), and the module-only `poolReplenish(punkId)` (the cleared-auction rescue refund). The `Contribution` / `BareTopUp` / `PoolReplenished` events live here now. Metering is **two-mode**, keyed on the live bid vs `activationThreshold`: BELOW the threshold the adapter is in fast mode (the buffer forwards uncapped, no cooldown, clamped so a single forward fills only up to the threshold — the launch warm-up); AT/ABOVE it throttles to a `maxSweepWei`-per-`minBlocksBetweenSweeps` rate cap (shared with `streamForward()` via a single `lastSweepBlock`) so a burst drips in. `activationThreshold` self-manages: `sweep()` reads the latest `acceptBid` clearing price from `PermanentCollection` (via `IPCAcquisitionReader`) and resets it to 75% of that (−25% band), clamped to `ACTIVATION_THRESHOLD_HI = 100 ether` (deploy seed 30 ETH); `acceptListing` rows are skipped. `streamForward()` does NOT sync the threshold; fast-mode forwards do NOT arm the cooldown. `setActivationThreshold(uint256)` is a bounded manual override gated `onlyAdminEvenIfLocked` — the adapter's lone lifetime carve-out, surviving the 1y lock until the admin role is burned; the rate-cap setters (`setMaxSweepWei` / `setMinBlocksBetweenSweeps`) lock at 1y with no carve-out. The former POL-diversion subsystem (`setPolDeployTarget`, the 50% diversion) is deleted. Constructor takes a `returnAuctionModule` ref (gates `poolReplenish` module-only) and a `PermanentCollection` records-core ref (`IPCAcquisitionReader`, read by the threshold sync). Decorated `notInSwap` + `nonReentrant`. (Contract name + the `bountyBps` config key follow the deployed ABI.) |
| [`VaultBurnPool`](../contracts/src/VaultBurnPool.sol) | Burn accumulator, two assets. **ETH** from cleared-auction proceeds in `ReturnAuctionModule.settle` — `(highBid − cost) + 10% × cost` per rescue — swept to BuybackBurner. **111** from the token's venue-scoped transfer tax (this contract is the tax `burnAddress`), burned in place via `token.burn` (totalSupply drops). Both legs release on the same `sweep`, callable only by `ReturnAuctionModule` (vault-path settle), which calls it DIRECTLY (no `try/catch`) so the burn is GUARANTEED: the burn is required and non-reverting, the ETH forward best-effort. One-shot `setup(token)` (`OneTimeSetup`) wires the 111 token post-deploy. The only 111 outflow is `burn`; bytecode-scan: no withdrawal AND no `transfer`/`transferFrom`/`approve` selectors. Decorated `notInSwap`. |
| [`ProtocolFeePhaseAdapter`](../contracts/src/ProtocolFeePhaseAdapter.sol) | Receives the **~16.67% baseline protocol leg** from the hook (deposited into the fee escrow under its address). `sweep()` claims it from the escrow and forwards it to PCController (86.67% PC-treasury / 13.33% LAYER-burn) from block 1 — a lean single-target forwarder, no phase gate. Decorated `notInSwap`. |
| [`ReferralPayout`](../contracts/src/ReferralPayout.sol) | Pull-based per-referrer ETH ledger. Hook calls `notify(referrer)` with the ≤0.25%-of-volume slice from the first swap, whenever a swap carries valid `PCAttribution` hookData. `claim` / `claimFor` are permissionless pulls with a 35k-gas budget; failed transfer reinstates balance. Stray ETH (direct `call` to `receive()`) is NOT credited. |
| [`PCSwapContext`](../contracts/src/PCSwapContext.sol) | Reentrancy-detection registry shared across PC. Exposes a transient-storage (EIP-1153) `inSwap` flag that only the `authorizedExtension` may toggle. At launch the slot is `address(0)` — flag permanently `false` and decorated functions are no-ops. Future Design B dispatcher binds via `setAuthorizedExtension`; `lockAuthorizedExtension` is one-way. No funds, no upgrade. |
| [`PCNoReentry`](../contracts/src/libraries/PCNoReentry.sol) (library) | `notInSwap` modifier mixin. The 7 decorated PC contracts inherit and apply it to all entry points that could be reentered by a callback during a swap. |
| [`TokenAdminPoker`](../contracts/src/TokenAdminPoker.sol) | Retained `tokenAdmin` role holder. Owner-gated `bindExtension(ext)` / `lockExtension()`. Lets PC defer Design B activation post-audit without redeploying. |
| [`ProtocolAdmin`](../contracts/src/ProtocolAdmin.sol) | 1-year auto-locking admin role. Gates economic-parameter setters. The allowlist setters are exempt from the timer (see below). Cannot move funds. |
| [`RendererRegistry`](../contracts/src/RendererRegistry.sol) + [`PermanentCollectionMosaicRenderer`](../contracts/src/PermanentCollectionMosaicRenderer.sol) | Stable renderer pointer plus cache-backed on-chain SVG renderer. 11×10 main trait grid plus one pulled-out "final type" cell beneath, on a square 356×356 canvas. Three states per cell. Reads `collectedMask`, `pendingMask`, `firstVaultedPunk`, and the fragment caches. |

### What V4 deleted

V3.1's pluggable acquisition-module pattern is gone. The protocol no longer
buys Punks; it pays for Punks brought to it. Removed entirely:

- `ListedAcquisitionModule` (comparable-rule, monopoly-eligible bitmap,
  pacing thresholds)
- `IAcquisitionModule` interface and the `approvedAcquisitionModule` registry
- `AcquisitionPool` (replaced by `Patron`)
- `AcquisitionPoolAdapter` (replaced by `LiveBidAdapter`)

### What the 2026-05-28 fee redesign deleted

- `VaultBurnAdapter` — retired alongside the hook's vault-burn leg.
  `VaultBurnPool` is now fed exclusively from cleared-auction proceeds
  in `ReturnAuctionModule.settle`.

## Entry points

### `Patron.acceptBid(uint16 punkId, uint8 targetTraitId, uint256 expectedListingWei)`

Accepts the live bid for the named Punk. Function name follows the deployed
ABI; user-facing copy describes the action as accepting the live bid.
Reentrancy-guarded. **Permissionless** — anyone can finalize once the owner
has listed.

**Owner pre-condition** (separate tx): the owner lists the Punk **exclusively
to Patron at a real positive price** `L` ≤ the current live bid, by calling
`punksMarket.offerPunkForSaleToAddress(punkId, L, patron)`. The frontend sets
`L = bidBalance()` (the full bid) by default; the contract only requires
`0 < L ≤ bidBalance()` — there is no reserve floor. The listing is never 0; it
is exclusive to the protocol (`onlySellTo == patron`) and cancellable anytime
(`punkNoLongerForSale`).

**Then anyone calls `acceptBid(punkId, targetTraitId, expectedListingWei)`:**

1. Read the listing: `punksOfferedForSale(punkId)` → `(isForSale, seller,
   minValue = L, onlySellTo)`. Verify `isForSale`, `onlySellTo == patron`
   (**exclusive to the protocol** — a public listing reverts), and `L > 0`
   (**listing-at-0 is a hard contract rule** — `ZeroListingPrice`).
2. Verify `L <= accountedLiveBidWei` (the listed price can't sit above the pool,
   else `ListingExceedsBid`) and `L <= expectedListingWei` (the caller's overpay
   cap, else `ListingAboveExpected` — a seller can't bump `L` between the
   frontend read and the accept tx). **There is no reserve floor** — a seller
   may list at any positive price up to the bid; the protocol pays the listed
   price `L` and the pool keeps any difference.
3. Verify `targetTraitId == canonicalTargetOf(punkId)` — the protocol-derived
   RAREST uncollected, non-pending trait the Punk carries (ties → lowest bit
   index), else `NotCanonicalTarget`. The caller passes it as a verified
   expectation; the protocol — not the caller — chooses which trait the Punk
   is made permanent for, so a scarce-trait carrier can't be steered onto a
   common trait. (`recordAcquisition` re-checks this authoritatively.)
4. Verify the Punk hasn't already been recorded (custody None or
   ReturnedToMarket).
5. `accountedLiveBidWei -= L` — the pool is debited by the actual listed price.
6. `punksMarket.buyPunk{value: L}(punkId)` — the protocol buys its own
   exclusive listing; the market credits `L` to `pendingWithdrawals[seller]`.
   Assert the Punk now belongs to Patron.
7. Transfer the Punk to `ReturnAuctionModule`; call `startSale(punkId, L, targetTraitId)`
   — reserve snapshots at `L × (101 + previousTrials) / 100`.
8. `permanentCollection.recordAcquisition(punkId, targetTraitId, mask, seller, L)`.
9. Emit `BidAccepted(punkId, seller, L)`.

**Then the seller claims** (separate tx): `punksMarket.withdraw()` collects
`L` from the market's `pendingWithdrawals[seller]`. Patron does **not** push
the bid to the seller — the seller is paid by the market.

Notes:

- The seller's flow is **list at `L` → accept → `withdraw()`**. Two of the
  three (list, withdraw) are the standard 2017-market punk-sale steps; none
  shows 0.
- `acceptBid` shares an internal `_acquire` tail (steps 6–9) with
  `acceptListing`, but the two stay **separate, separately-gated entry
  points**: `acceptBid` enforces the exclusive `onlySellTo == patron` listing +
  open access; `acceptListing` enforces the seller allowlist + finder fee +
  distinct `originalSeller`.
- For UX, the frontend can bundle the owner's list + accept via wallet-native
  batched calls (EIP-5792 / Multicall3); otherwise it falls back to two
  sequential transactions, plus the seller's later `withdraw()`.
- **There is no reserve floor on `L`** — a seller may list at any positive
  price up to the bid (`0 < L ≤ bid`), and the protocol pays the listed price
  (the pool keeps any difference; the frontend lists at the full bid by
  default). The anti-grief guard is the return auction's **open-market
  exposure**, not a reserve floor: to occupy a trait's one in-flight slot a
  griefer must put a real Punk into a 72h open auction every cycle and either
  lose it at the clearing price or buy it back at the clearing price — burning
  real money to stall a deadline-less protocol, which is economically
  irrational regardless of the price they listed at. `expectedListingWei` is the
  caller-side cap protecting against a seller bumping `L` between the read and
  the accept.

### `Patron.acceptListing(uint16 punkId)`

Anyone-callable, **but only valid when the listing's seller is on the
allowed-sellers allowlist.** This preserves V4's "no chasing listings"
principle for the general market while opening an explicit composition surface
for recognized peer protocols (PunkStrategy at launch; others as added).

1. Verify `bidBalance >= MIN_BID_FOR_LISTING` (0.5 ETH constant —
   identifier follows the deployed ABI).
2. Read listing: `isForSale && onlySellTo == 0 && allowedSellers[seller]`.
3. Verify `minValue > 0` (defense against zero-listings draining the finder fee).
4. Compute `finderFee = min(bidBalance * finderFeeCapBps / 10000, finderFeeFixedCap)`.
5. Verify `minValue + finderFee <= bidBalance`.
6. Verify `targetTraitId == canonicalTargetOf(punkId)` — the protocol-derived
   rarest uncollected, non-pending trait (else `NotCanonicalTarget`). The finder
   does NOT choose the trait; it's derived on-chain, so an unaligned finder
   can't waste a scarce-trait carrier on a common one.
7. `punksMarket.buyPunk{value: minValue}(punkId)` — seller receives minValue
   via `pendingWithdrawals` on the 2017 market.
8. Transfer Punk to `ReturnAuctionModule`; call `startSale(punkId, minValue, targetTraitId)`.
9. `recordAcquisition(punkId, targetTraitId, mask, msg.sender, minValue)`.
10. Pay caller the finder fee. Revert on failure.
11. Emit `ListingAccepted(punkId, seller, msg.sender, minValue, finderFee)`.

Notes:

- **PunkStrategy is the launch allowlist entry.** PunkStrategy's deployed
  contract autonomously buys floor Punks and re-lists at 1.2× cost via
  `offerPunkForSale` (publicly, `onlySellTo == 0`). Whenever
  `bidBalance ≥ 1.2 × cost`, anyone can call `acceptListing` and both
  protocols' cycles complete in one transaction.
- **Asymmetric pricing is intentional.** A seller using `acceptListing`
  receives only their listing price (≤ live bid), not the full live bid. If
  they wanted the full live bid, they'd use `acceptBid` directly. This
  makes `acceptListing` strictly cheaper for the protocol than `acceptBid`
  — same trait advancement for fewer ETH paid out.

### `LiveBidAdapter.receive()` — bare top-ups

```solidity
event BareTopUp(address indexed sender, uint256 amount);
```

Anyone can send ETH to `LiveBidAdapter` via a plain transfer. The
`msg.value` joins the adapter buffer and meters into the live bid on the
next `sweep()`. Use this path when no attribution / referral is needed
(e.g. internal protocol transfers, EOA donations without a referrer). The
legacy `BountyToppedUp` event has been removed; `BareTopUp` replaces it.
Under inflow consolidation this surface moved from Patron to the adapter
(the single inflow governor) — Patron's own `receive()` now rejects any
sender other than the adapter (`NotAdapter`). The adapter's `receive()`
emits `BareTopUp` only when `msg.sender != feeLocker`, so the escrow
`claim` that lands on every `sweep` (already accounted by `Swept`) is not
re-tagged as a top-up.

For attributed contributions, use `LiveBidAdapter.contribute(referrer, tag)`
below — it emits a richer event and pays a referrer slice when one is
supplied.

### `LiveBidAdapter.contribute(address referrer, bytes32 tag)` — attributed contribution

```solidity
function contribute(address referrer, bytes32 tag)
    external payable nonReentrant notInSwap;
```

Reverts `ZeroValue()` if `msg.value == 0`. Reentrancy-guarded and
`notInSwap`-decorated. Designed as the canonical on-chain destination for
capital flows that want to align with CryptoPunks trait preservation —
for example, an NFT launchpad's "Route X% of mint to Permanent
Collection" option, or any third-party UI that wants to attribute the
inbound flow to a referrer. Under inflow consolidation this surface lives
on `LiveBidAdapter`, NOT on Patron — the logic moved verbatim; the only
behavioural change is that the remainder buffers in the adapter (metered
into the live bid via `sweep()`) instead of landing in Patron directly.

**Constants** (hard-coded in `LiveBidAdapter`, no setter, no admin tuning):

- `REFERRER_CONTRIB_BPS = 500` — referrer's slice (5%).
- `REFERRER_GAS = 35_000` — gas budget for the outgoing referrer send.

**Math**:

```
if (referrer != address(0)) {
    referrerShare = msg.value * REFERRER_CONTRIB_BPS / 10_000;   // 5%
    (bool ok,) = referrer.call{value: referrerShare, gas: REFERRER_GAS}("");
    if (!ok) {
        referrerShare = 0;   // ETH did not leave the adapter; accounting reset
    }
}
// Remainder (msg.value − referrerShare) stays buffered in the adapter and
// meters into the live bid on the next sweep().
emit Contribution(msg.sender, msg.value, referrer, tag, referrerShare);
```

**Fail-closed semantics:** if `referrer == address(0)` OR the referrer
call reverts / OOGs, `referrerShare` is reset to `0` and the full
`msg.value` stays buffered in the adapter (and meters into the live bid).
The send did not move ETH, so resetting the accounting field is exact.
`contribute` itself never reverts on referrer failure (only on
`msg.value == 0` or reentry / swap guard).

**Event**:

```solidity
event Contribution(
    address indexed contributor,
    uint256 amount,
    address indexed referrer,
    bytes32 indexed tag,
    uint256 referrerShare
);
```

`tag` is opaque — emitted indexed for cheap log filtering, otherwise
unconsumed on-chain. `referrerShare` is the actual ETH paid (zero when
the send failed or no referrer was supplied).

### Allowed-sellers allowlist

State on `Patron`:

```solidity
mapping(address => bool) public allowedSellers;
```

Admin entry points (direct, no timelock, immediate effect):

- `addAllowedSeller(address)` — admin-only.
- `removeAllowedSeller(address)` — admin-only.

**The allowlist remains editable indefinitely** — it is the one admin power
that does *not* freeze at the 1-year `ProtocolAdmin` auto-lock. Rationale:

- The universe of aligned peer protocols isn't knowable at launch. Future
  Punk-treasury protocols may emerge in year 2+; freezing the allowlist
  forecloses on that.
- The allowlist is **economically benign**: the worst an admin can do is
  allowlist a seller who lists cheap eligible Punks — every such acceptance
  pays only the listing price (≤ live bid) and either clears the return
  auction (cost-based 65/25/10 split, all benefiting the protocol) or vaults a Punk (permanent trait
  added). The downside is reputational, not financial.

The launch allowlist contains exactly one address: PunkStrategy's deployed
listing contract.

### Editable parameters

Direct admin setters are bounds-checked and emit
`ParameterChanged(key, oldValue, newValue)`. Economic parameters revert after
the 1y `ProtocolAdmin` lock and freeze at their then-current values. The
persistent raw-admin carve-outs that survive the lock are listed at the end of
this section; `LiveBidAdapter.setActivationThreshold` is among them, but the
`LiveBidAdapter` rate-cap setters (`setMaxSweepWei` / `setMinBlocksBetweenSweeps`)
are NOT (they lock with the rest of the economic surface).

**On Patron:** none. Patron has no `checkAdmin`-gated economic setter. The
finder-fee parameters are protocol constants — `finderFeeCapBps = 50`
(0.5%) and `finderFeeFixedCap = 0.01 ether` — with no setter and no bounds to
escape. They size a small keeper tip for `acceptListing` whose only
requirement is "stay bounded," which a constant satisfies directly. Patron's
only remaining admin surface is the two raw-admin allowlist carve-outs.

`CLEARED_BID_BPS = 6_500` and `CLEARED_VAULT_BURN_BPS = 1_000` are
`ReturnAuctionModule` constants — no setter, no admin tuning. The
cleared-path cost split derives entirely from them:
`liveBidShareWei = acquisitionCost × CLEARED_BID_BPS / 10_000` (65% of
cost → Patron), `vaultBurnFromCost = acquisitionCost × CLEARED_VAULT_BURN_BPS
/ 10_000` (10% of cost → VaultBurnPool), `burnShareWei = acquisitionCost −
liveBidShareWei − vaultBurnFromCost` (residual 25% → BuybackBurner). The
overbid premium `(highBid − acquisitionCost)` then splits 5% → referrer
(if any) with the remainder added to VaultBurnPool. (The V2 50/50-of-highBid
split constant `Patron.BURN_SHARE_BPS` and its mirror views were dead surface
and have been removed.)

**On LiveBidAdapter** — the rate-cap setters lock at 1y (no carve-out); the
activation-threshold override is the adapter's lone lifetime carve-out:

| Setter | Default | Bounds | Lock |
|---|---|---|---|
| `setMaxSweepWei(uint256)` | 2 ether | [0.01e18, 5e18] | locks at 1y |
| `setMinBlocksBetweenSweeps(uint256)` | 150 | [1, 7200] | locks at 1y |
| `setActivationThreshold(uint256)` | 30 ETH seed | [0, `ACTIVATION_THRESHOLD_HI = 100 ether`] | **carve-out** — `onlyAdminEvenIfLocked`, survives the 1y lock until the admin EOA is burned |

`setMaxSweepWei` / `setMinBlocksBetweenSweeps` are the two knobs of the throttled-mode
rate cap; their defaults give roughly 4 ETH/hour of throttled live-bid growth, and
both freeze at the 1y lock. `setActivationThreshold` is a bounded MANUAL override of
the self-syncing metering threshold (the threshold otherwise tracks 75% of the latest
`acceptBid` clearing price); it does not lock at 1y.

**On ReturnAuctionModule:** none. `minBidIncrementBps = 100` (1%) is a
protocol constant — the M-1 remediation value, frozen rather than left as
admin surface because the geometric-overbid deterrent is robust across the
entire range the old setter allowed (0.5%–25%). `ReturnAuctionModule` holds
no `ProtocolAdmin` reference at all.

**On BuybackBurner** (locks at 1y):

| Setter | Default | Bounds |
|---|---|---|
| `setMinBlocksBetweenSteps(uint256)` | 1 | [1, 50400] |
| `setMaxStepWei(uint256)` | 1 ether | [0.01e18, 10e18] |

`maxSlippageBps` (the per-call `sqrtPriceLimitX96` price-impact cap) is a
compile-time constant (500 / 5%), not a setter. A burn step may attempt up to
`maxStepWei`, but V4 partial-fills before the burner's own price movement crosses
the cap; unspent ETH stays queued. There is no static tokens-per-ETH floor and
no EMA/reference-price state: the burner avoids stale-price and success-case
brick risks by never moving the pool hard enough in one call to make a sandwich
worth its round-trip fees.

**Persistent raw-admin carve-outs** (DO NOT lock at 1y) — four total:

- `addAllowedSeller(address)` / `removeAllowedSeller(address)` — bypass the
  timer; only burned via `protocolAdmin.transferAdmin(address(0))`.
- `LiveBidAdapter.setActivationThreshold(...)` — bounded manual override of the
  metering threshold, `[0, ACTIVATION_THRESHOLD_HI = 100 ether]`; gated by
  `ProtocolAdmin.admin()` alone via `onlyAdminEvenIfLocked`, so it survives the
  1y lock until the admin EOA is burned.
- `TokenAdminPoker.setHookMaxReferralBps(...)` — referral cap on the skim hook,
  bounded `[0, 1_000]` (1% of swap volume in 100k denom); two-key gate
  (`TokenAdminPoker.owner` OR `ProtocolAdmin.admin()`).
- `TokenAdminPoker.setTokenTaxBps(...)` — venue-scoped transfer-tax rate on the
  111 token, bounded `[0, taxBpsMax]` (20% cap; launch 15%); same two-key
  gate.

(`LiveBidAdapter.setActivationThreshold` is the one adapter carve-out; the
adapter's `setMaxSweepWei` / `setMinBlocksBetweenSweeps` rate-cap knobs lock at
1y like the rest of the economic surface.)

**Tradeoff**: no public-review window between admin proposal and change
activation. The admin EOA can shift economic parameters within their bounds
instantly. Mitigated by (a) bounds-checking prevents extreme values, (b) all
changes still emit events so they're publicly observable post-hoc, and (c) the
1y auto-lock caps the window of admin power on most economics. If the admin key
is compromised before the 1y lock, the attacker can churn within the bounds but
cannot drain funds (no withdrawal path on Patron) or break invariants. After
the lock, only the four carve-outs (allowlist, activation threshold, referral
cap, transfer-tax rate) remain live unless the admin role is burned. Burning —
`protocolAdmin.transferAdmin(address(0))`
— is reachable at any time, including after the timer has lapsed (only
renewals/rotations are time-gated; auditor M-1), so a post-lapse key compromise
of the carve-outs always has an on-chain off-switch.

## Return auction

(Struct + module names follow the deployed ABI — the per-Punk state
struct is `ReturnAuction`, stored in `ReturnAuctionModule`.)

```solidity
struct ReturnAuction {
    uint128 acquisitionCost;    // live bid paid (or listing price)
    uint128 highBidWei;
    address highBidder;
    uint64  startedAt;
    uint64  endsAt;
    uint128 reserveWei;         // snapshot = acquisitionCost × (101 + prevTrials) / 100
    uint8   targetTraitId;      // collected only on the Vault path
    bool    settled;
}
```

`reserveWei` is **snapshotted at sale start** (it depends on the per-trait
`attemptCount` at acquisition time). The min-bid increment is no longer a
per-sale field — it is the protocol constant `minBidIncrementBps` (100 bps),
read directly when validating each overbid.

Separately, the module stores a per-Punk slot for the high-bid referrer:

```solidity
mapping(uint16 => address) public referrerOfHighBid;
```

Written on every accepted `bid` to `msg.value`'s referrer (or `address(0)`).
The slot tracks **only the current high bidder's referrer** — being outbid
overwrites the slot and the prior referrer loses attribution. Read by
cleared-path settle to compute `referrerShare`. Vault-path (silenced)
settle does **not** read this mapping — no referrer is paid when no
rescue bid exists.

### Bidding

```solidity
// Simple entry point — no referral.
function placeBid(uint16 punkId) external payable nonReentrant notInSwap;

// Referral-bearing entry point — the winner's referrer earns a premium share.
function placeBidWithReferral(uint16 punkId, address referrer, bytes32 tag)
    external payable nonReentrant notInSwap;
```

`placeBid(punkId)` is exactly `placeBidWithReferral(punkId, address(0), bytes32(0))`.

- Bid must strictly exceed both the reserve and the current high bid.
- **Referrer attribution**: each call records `referrer` and `tag` against
  the high-bid slot via `referrerOfHighBid[punkId] = referrer`. The slot
  tracks the **current** high bidder's referrer only — being outbid wipes
  the prior referrer's attribution. `referrer = address(0)` means no
  attribution.
- `referrer` is paid only at cleared settle, only on the rescue (cleared)
  path, and only out of the rescuer's overbid (premium = `highBid − cost`).
  Vault-path (silenced) settle never pays a bid-side referrer.
- `tag` is an opaque 32-byte attribution tag; emitted in the
  `BidPlaced` event and not otherwise consumed on-chain.
- **Anti-snipe**: if placed within the last 15 minutes, `endsAt` extends by 1
  hour, uncapped.
- Outgoing-bidder refunds use a push pattern (30k gas) with a pull fallback
  (`withdrawRefund()`).

Events emitted on `bid`:

- `BidPlaced(uint16 indexed punkId, address indexed bidder, address indexed referrer, uint256 amount, bytes32 tag, uint64 endsAt)` — carries the referrer + tag.

### Settlement (`settle(punkId)`, permissionless after `endsAt`)

**Cleared (`highBidder != 0`):**

```
cost            = s.acquisitionCost
highBid         = s.highBidWei
premium         = highBid - cost                        // > 0; reserve formula guarantees

bidShare        = cost * CLEARED_BID_BPS / 10_000        // 65% of cost            → LiveBidAdapter → Patron
vaultBurnFromCost = cost * CLEARED_VAULT_BURN_BPS / 10_000 // 10% of cost          → VaultBurnPool
burnShare       = cost - bidShare - vaultBurnFromCost    // residual 25% of cost   → BuybackBurner

referrer        = referrerOfHighBid[punkId]
referrerShare   = referrer != address(0)
              ? premium * REFERRER_PREMIUM_BPS / 10_000   // 5% of premium     → referrer
              : 0
vaultBurnShare  = (premium - referrerShare) + vaultBurnFromCost  // premium remainder + 10% cost → VaultBurnPool

// Provenance round-trip — records a real PunkBought at the hammer price on
// the canonical market instead of a price-less PunkTransfer. Net ETH zero.
market.transferPunk(escrow, punkId)            // module -> escrow
escrow.listForSettlement(punkId, highBid)      // escrow lists to module @ highBid
market.buyPunk{value: highBid}(punkId)         // PunkBought(escrow, module, highBid)
escrow.sweepProceeds()                          // proceeds round-trip back to module
market.transferPunk(buyer, punkId)             // module -> winning bidder

liveBidAdapter.poolReplenish{value: liveBidShareWei}(punkId) // buffers + meters into the live bid (full 65% of cost; no keeper tip)
buybackBurner.call{value: burnShareWei}              // queues for burn (25% residual of cost)

// Referrer payout (fail-closed):
if (referrerShareWei > 0) {
    (bool ok,) = referrer.call{value: referrerShareWei, gas: REFERRER_GAS}("");
    if (!ok) {
        vaultBurnShareWei += referrerShareWei;   // fold back BEFORE pool transfer
        referrerShareWei   = 0;
    }
}
vaultBurnPool.call{value: vaultBurnShareWei}
permanentCollection.markCustody(punkId, ReturnedToMarket)
```

**Constants** (hard-coded in `ReturnAuctionModule`, no setter, no admin tuning):

- `CLEARED_BID_BPS = 6_500` — cost-share routed via `LiveBidAdapter.poolReplenish` (65%, buffers + meters into the live bid; the module gained a one-shot `setLiveBidAdapter` to wire this, mirroring `setVaultBurnPool`).
- `CLEARED_VAULT_BURN_BPS = 1_000` — cost-share to VaultBurnPool (10%, on top of the premium remainder).
- Residual cost-share to BuybackBurner = `10_000 − CLEARED_BID_BPS − CLEARED_VAULT_BURN_BPS` = 25%.
- `REFERRER_PREMIUM_BPS = 500` — referrer's slice of the premium (5%).
- `REFERRER_GAS = 35_000` — gas budget for the outgoing referrer send (matches `ReferralPayout.CLAIM_GAS`).

**Fail-closed semantics:** if `referrer == address(0)` OR the 35k-gas
`call` reverts / OOGs, `referrerShare` is reset to `0` and the value
is added to `vaultBurnShare` BEFORE the VaultBurnPool transfer. Settle
itself NEVER reverts on referrer failure. The referrer slice is funded
from fresh external value (the rescuer's voluntary overbid above
`acquisitionCost`); it NEVER reduces `liveBidShareWei` or `burnShareWei`. The
reserve formula guarantees `highBid > cost`, so `premium > 0` and the
fail-closed path still has non-zero value flowing to VaultBurnPool.

Cleared settle emits an extended event carrying the four-way split:

```solidity
event ReturnAuctionCleared(
    uint16  indexed punkId,
    address indexed buyer,
    address indexed referrer,
    uint256 highBidWei,
    uint256 liveBidShareWei,
    uint256 burnShareWei,
    uint256 vaultBurnShareWei,
    uint256 referrerShareWei
);
```

`markCustody(ReturnedToMarket)` releases the pending counter for this Punk's
target trait. `collectedMask` is **untouched**. The Punk is now eligible to
be **re-acquired** — a rescued Punk can re-enter the return auction, so a
trait carried by only one or a few Punks can't be made permanently
uncollectable by a single rescue (`startSale` resets the sale slot on the
next acquisition).

The round-trip exists so the Punk's canonical on-chain sale history records
the clearing **price** (a `PunkBought` event), not just a transfer. The
recorded **buyer is the module** (a protocol contract), not the human winner:
CryptoPunks records `msg.sender` of `buyPunk` as the buyer, and the winning
bid is escrowed in the module rather than paid by the winner at settle time —
so naming the human as buyer would mean giving up escrowed-bids +
permissionless settlement. The winner still appears on-chain as the final
`transferPunk` recipient (current owner). The whole sequence runs atomically
inside the `nonReentrant` `settle`; any failure rolls it back.

**Unsold (`highBidder == 0`):**

```
market.transferPunk(punkVault, punkId)
punkVault.receivePunk(punkId)
permanentCollection.markCustody(punkId, Vaulted)
if (firstVaultingOfTrait) punkVault.mintProofs(punkId, target, originalSeller, ...)
```

`markCustody(Vaulted)` releases the pending target counter AND collects only
the recorded target trait. The first-vaulted-Punk attribution is set for that
trait only.

The Proof mint is **atomic with the vaulting** — `settle` calls `mintProofs`
directly (no `try/catch`), so a mint failure reverts the whole unsold branch
(the transfer, `receivePunk`, `markCustody`, and the `settled` flag all roll
back, leaving the auction settleable for a retry). This makes the
collected-trait ⟺ Proof biconditional structural (a collected trait can never
exist without its Proof) and is safe by construction: `mintProofs` uses
`_mint` (no recipient callback, so no griefing), the recipient is
structurally non-zero, and the token id is structurally fresh on a
first-vaulting, so the required mint has no reachable revert.

## Fee plumbing (three-leg hook redesign)

The artcoins V4 pool charges a **6% baseline skim per swap**, taken
**inside the hook** — not via the locker's reward distribution. The
hook reads the three-leg split config from `SkimHookFeeData` at
`initializePool` and splits at swap-time in `_processSkimAndAttribution`
(in `_beforeSwap` for exact-input, `_afterSwap` for exact-output). The
split is accrued in three mappings (`accruedBounty` / `accruedProtocol`
/ `accruedReferral[referrer]`) and **flushed at the END of `_afterSwap`
of the same swap** via `_flushAccruedSkim` — burns the claim tokens,
takes native ETH, and forwards each leg to its recipient. The hook
never holds a claim balance between swaps.

| Leg | Recipient | Per-baseline bps | Per 1 ETH swap |
|---|---|---|---|
| live bid | `LiveBidAdapter` → Patron (`sweep()`) | 8_333 | 5.00% |
| protocol | `ProtocolFeePhaseAdapter` → PCController | 1_667 | 1.00% |
| referral | `ReferralPayout` (from protocol slice) | ≤ 250 of volume | ≤ 0.25% |

(Contract identifiers + the `bountyBps` config key follow the deployed ABI.)

**Vault-burn** is no longer a trading-fee leg. `VaultBurnPool` is fed
exclusively from cleared-auction proceeds in `ReturnAuctionModule.settle`
(`(highBid − cost) + 10% × cost` per rescue), then swept to
`BuybackBurner` only on a vault-path settle.

`maxReferralBpsOfVolume = 250` (0.25% of swap volume in 100k-denom).
Referral is clamped per-swap against `min(att.referralBps, max)` AND
against the available protocol slice. It pays from the first swap
when the swap carries a valid referrer; with no/invalid referrer the
slice stays in the protocol leg.

**antiSniperExtra** (the MEV-window overage when `ArtCoinsMevLinearSkim`
reports an elevated `currentSkimBps`) routes **100% to the live-bid leg**.
The `liveBidShare` component receives `baseline × bountyBps / 10_000 +
antiSniperExtra` in claim-tokens (identifier names follow the deployed ABI).

`ARTCOINS_PROTOCOL_BPS = 0` — no factory-injected artcoins protocol
slot. The artcoins LAYER burn revenue routes via
`ProtocolFeePhaseAdapter` → `PCController` → its internal 13.33% LAYER
burn split (from block 1).

**Locker LP fee (0.5%):** separate from the hook skim. The conversion
locker collects the 0.5% LP fee on its position depth and forwards 100%
to LiveBidAdapter via the single PC reward slot (admin = `0xdEaD` —
recipient permanently locked).

### Venue-scoped buy-side transfer tax (token-level, independent of the hook skim)

A SECOND, token-level fee blunts side-pool starvation. The 111 token
(`ArtCoinsToken`, default-off shared infra, enabled only for this launch)
taxes 111 *leaving a known trading venue to a non-exempt recipient* — i.e. a
DEX buy / pool outflow. Proceeds accrue in `VaultBurnPool` (the tax `burnAddress`) and are burned (`token.burn`, totalSupply drops) on each vault-path settle, in the same `sweep` as the ETH leg.

| Property | Value |
|---|---|
| Trigger | `taxEnabled && taxBps != 0 && _isTaxVenue(from) && !exempt[to]`, minus the canonical-exemption budget |
| Rate | **15% per leg launch** (router investigation: 5% is sub-parity vs a 0.3%-LP side pool; 12.5% floor, 15% first clean defense); bounded `[0, 20%]` with headroom to tune up to the 20% cap |
| Proceeds | accrue in `VaultBurnPool` (the tax `burnAddress`), burned via `token.burn` on each vault-path settle (no ETH conversion → no sell pressure; no LP) |
| Venues | V4 PoolManager singleton (all V4 pools) + 44 precomputed V2/V3 111 pools (frozen at deploy): {UniV2, Sushi, PancakeV2} × {WETH, USDC, USDT, DAI} + {UniV3, PancakeV3} × same × 4 tiers |
| Canonical exemption | hook attests realized 111-out (`_afterSwap`) + LP exits (`_afterRemoveLiquidity`) into an EIP-1153 amount-pinned budget; gated to `canonicalHook` + `canonicalPoolId` |
| Exempt recipients | BuybackBurner, conversion locker |
| Never taxed | sells (111 into a pool), wallet/Safe/4337 sends, lending/bridge/CEX |
| Rate setter | `TokenAdminPoker.setTokenTaxBps` (two-key carve-out, `[0, 2000]` = 20% cap) |

The bid is fed INDIRECTLY: the tax removes the routing discount to trade
off-canonical, pushing volume onto the canonical pool, whose hook skims ETH
into the bid. The burned proceeds are a deflationary byproduct, not the
funding. This is a new permanent surface on an immutable token — see
[`docs/TRANSFER_TAX_INVESTIGATION.md`](TRANSFER_TAX_INVESTIGATION.md) and the
`TaxConfig` set in `contracts/script/Deploy.s.sol`.

### Attribution (referral) — `PCSwapData` hookData encoding

Callers (routers, aggregators, frontends) that want to attribute a
referrer / sourceId / campaignId encode hookData as:

```solidity
PCSwapData psd = PCSwapData({
    attribution: PCAttribution({
        sourceId: bytes32(...),
        referrer: address(...),
        campaignId: bytes16(...),
        referralBps: 250 // 0.25% in 100k-denom; capped by maxReferralBpsOfVolume
    }),
    extensionPayload: ""
});
bytes hookData = abi.encode(psd); // 1-tuple struct, NOT a 2-tuple of bytes
```

**Encoding gotcha**: the hook decodes `swapData` as `abi.decode(swapData,
(PoolSwapData))` — a single struct. Encoding as a 2-tuple
`(bytes(""), inner)` is off by a 32-byte outer offset and the hook
silently fails to decode (treated as empty attribution). The fork tests
hit this; document for any frontend / router integrator.

## BuybackBurner caller reward

`executeStep(minOut)` is permissionless. To incentivize anyone to trigger the
burn:

- A small reward is **deducted from the step before swapping**, so:
  `reward = min(step * 50 / 10000, 0.05 ether)` (≤0.5% of step, ≤0.05 ETH).
- The remaining `step - reward` ETH is swapped to 111 through the native-ETH V4 pool;
  the 111 token is sent to `0xdead`.
- After the burn, the reward is paid to `msg.sender` via `.call{value:reward}`.
  Reward-transfer failure does **not** revert (the burn already happened).

Bounded so MEV competition can't shred the burn rate.

## Hard invariants

Carried from V3.1:

1. `collectedMask` is monotonic.
2. `Acquisition[]` log only grows.
3. Custody cycles `(zero) → InReturnAuction → ReturnedToMarket → InReturnAuction → …`; `Vaulted` is the only terminal state (enum members follow the deployed ABI). A rescued (ReturnedToMarket) Punk may re-enter the return auction — re-acquisition is gated to custody None or ReturnedToMarket in `recordAcquisition`, appends a new `Acquisition[]` row, and re-points `_acquisitionIndexOf` to the latest; a Vaulted Punk never re-auctions.
4. Acquisition does not imply permanence; only Vaulted custody adds permanent traits.
5. Returned-to-Market never adds permanent traits.
6. Vaulted always adds exactly one bit: the recorded target trait.
7. No Punk can leave `PunkVault` or `PermanentCollection`. Bytecode-scan asserted.
8. **Return-auction proceeds split enforced on-chain.** Cleared/rescue
   path splits the cost three ways plus a premium leg, all derived from
   constants in `ReturnAuctionModule`: `liveBidShareWei = cost ×
   CLEARED_BID_BPS / 10_000` (= 65% × cost) → Patron; `vaultBurnFromCost =
   cost × CLEARED_VAULT_BURN_BPS / 10_000` (= 10% × cost) → VaultBurnPool;
   `burnShareWei = cost − liveBidShareWei − vaultBurnFromCost` (= residual
   25% × cost) → BuybackBurner; `premium = highBid − cost`;
   `referrerShareWei = referrer != 0 ? premium × REFERRER_PREMIUM_BPS /
   10_000 : 0` (= 5% of premium) → high-bid referrer (35k gas budget,
   fail-closed); `vaultBurnShareWei = (premium − referrerShareWei) +
   vaultBurnFromCost` → VaultBurnPool. Reserve enforced at bid time. The
   referrer slice is funded entirely from fresh external value (the
   rescuer's voluntary overbid); it never reduces liveBidShareWei or
   burnShareWei. Vault-path (silenced) settle pays no bid-side referrer.

**Sole-carrier target guard (hard invariant #22).** Trait bit 23
(`"7 Attributes"`) has exactly one carrier in the sealed dataset — Punk
**#8348** — the unique forced edge in the 111/111 trait→Punk matching. Because
the vault is terminal, a Punk is acquirable once, and `markCustody(Vaulted)`
collects only the recorded target, a silenced vaulting of #8348 against any of
its 9 common traits would strand bit 23 forever, capping the Full Set at
110/111 (mission finding MF-1). `recordAcquisition` — the single chokepoint
both `acceptBid` and `acceptListing` flow through — therefore enforces: while
bit 23 is uncollected, an acquisition of #8348 MUST record `targetTraitId == 23`,
else it reverts `SoleCarrierMustTargetTrait`. The `(23, #8348)` pair is an
immutable constant derived from the sealed dataset (one rarity-1 trait, so one
pinned pair is complete). The guard self-disables once bit 23 is collected (by
then #8348 is already vaulted) and never fires for any other Punk; it preserves
"only the recorded target is collected" and only removes the ability to waste
the unique carrier. `Patron.acceptBid`/`acceptListing` mirror it for an early
revert.

New for V4:

9. **Only `Patron` can call `recordAcquisition`.** Only `returnAuctionModule`
   can call `markCustody` / vault receipt. No pluggable module surface.
10. **No admin withdrawal path from `Patron`.** Bytecode-scan tests assert
    absence of every common withdrawal selector.
11. **Parameter bounds are enforced in every setter.** Bounds cannot be
    escaped.
12. **After `ProtocolAdmin` locks, no economic parameter changes accepted.**
    All economic values freeze, including the `LiveBidAdapter` rate-cap setters
    (`setMaxSweepWei` / `setMinBlocksBetweenSweeps`). **Exceptions** (four
    persistent carve-outs): the seller allowlist (`addAllowedSeller` /
    `removeAllowedSeller`), `LiveBidAdapter.setActivationThreshold` (the metering
    threshold, `[0, 100 ether]`, gated by `ProtocolAdmin.admin()` alone),
    `TokenAdminPoker.setHookMaxReferralBps` (referral cap, `[0, 1_000]` bps of
    volume), and `TokenAdminPoker.setTokenTaxBps` (transfer-tax rate, `[0, 2_000]`
    bps).
13. **`address(patron).balance ≥ accountedLiveBidWei`; the live bid is
    `accountedLiveBidWei`, not the raw balance.** `bidBalance()` returns
    `accountedLiveBidWei` and `acceptBid` / `acceptListing` pay from it
    (function name follows the deployed ABI). A force-send can only make the
    raw balance EXCEED the accounted bid, never underpay it; the surplus is
    excluded from the live bid and swept to `LiveBidAdapter` by `skimSurplus()`.
    Under inflow consolidation the accounted bid fills ONLY via `LiveBidAdapter`:
    `receive()` rejects any non-adapter sender (`NotAdapter`), so the single
    metered faucet is the only path that grows the live bid.
14. **Direct contribution is fail-closed and fully credited to the live
    bid.** `LiveBidAdapter.contribute(referrer, tag)` (moved from Patron
    under inflow consolidation) reverts only on `msg.value == 0`, reentry,
    or in-swap. With `referrer == address(0)`, 100% of `msg.value` buffers
    in the adapter and meters into the live bid. With a non-zero referrer,
    the contract attempts to send `msg.value × REFERRER_CONTRIB_BPS /
    10_000` (= 5%) under the 35k-gas budget; on send failure,
    `referrerShare` is reset to `0` (ETH did not leave the adapter) and the
    full `msg.value` remains buffered as live bid. No setter for
    `REFERRER_CONTRIB_BPS`; no admin surface; bytecode-scan invariants on
    `Patron` and `LiveBidAdapter` still hold.
15. **Both new referrer surfaces are reentrancy-guarded and
    swap-guarded.** `ReturnAuctionModule.bid` and
    `LiveBidAdapter.contribute` are decorated `nonReentrant` AND
    `notInSwap`. The outgoing referrer `call` runs under a hard 35k-gas
    budget on both paths (matches `ReferralPayout.CLAIM_GAS`). Neither path
    adds new admin powers.
16. **At most one in-flight acquisition per trait: `pendingTraitCount[t] ∈
    {0,1}`.** The `TargetTraitAlreadyPending` guard rejects a second
    acquisition targeting a trait already in flight, so every vault-path settle
    is the FIRST vaulting of its target. This is what keeps
    `popcount(collectedMask) == #vaulted == #Proofs` in lockstep and makes the
    redundant-vaulting branch in `settle` unreachable.
17. **Reserve strictly exceeds cost: `reserve = ⌈cost × (101 + previousTrials)
    / 100⌉ > cost`.** The ceil-div makes the rescue premium `highBid − cost`
    positive on every cleared settle, so the cleared-path split never
    underflows.
18. **Each cleared settle distributes exactly `highBid`.** The cost split
    (bid + burn + vault-burn) plus the premium split (referrer + vault-burn)
    sum to `highBid`; the escrow round-trip nets zero and the module never
    spends another sale's ETH.
19. **`canonicalTargetOf` returns an uncollected, non-pending, in-mask trait,
    or reverts `NoEligibleTarget`.** So a recorded target is always
    collectible, and the sole-carrier guard can never contradict the
    canonical-target rule.

## PunkStrategy composition

PunkStrategy (PNKSTR) is an autonomous flip-and-burn protocol: a contract
that buys CryptoPunks from the floor and immediately re-lists them at 1.2×
cost. On sale proceeds, it buys and burns PNKSTR.

PunkStrategy's contract cannot call our protocol directly (it's a fixed-flow
yoyo). But it does expose one outbound surface: its public listings on the
2017 CryptoPunks market via `offerPunkForSale`. `Patron.acceptListing` is
the protocol's hook for that surface.

When PunkStrategy is allowlisted:

1. PunkStrategy buys a floor Punk at ~30 ETH (autonomous).
2. PunkStrategy lists at 36 ETH (1.2×).
3. 111 trading grows our live bid above 36 ETH.
4. Anyone calls `patron.acceptListing(punkId)`:
   - PunkStrategy receives 36 ETH (queued via `pendingWithdrawals`).
   - On their next `withdraw()` + sale processing, PNKSTR buy-and-burn fires.
   - Our protocol gets the Punk into a return auction.
   - Caller earns the finder fee.
5. The return auction either clears (65/25/10 cost split: refill / burn / vault-burn) or vaults the Punk.

Both protocols' cycles complete. PunkStrategy's contract address is the only
external coupling, scoped to one allowlist slot, removable instantly by admin.

## Verification

Foundry fork tests against mainnet. 74 tests across 9 suites.

```bash
cd contracts
forge test                                    # all suites
forge test --match-contract AcceptBountyTest  # one suite
```

Public RPC (`https://ethereum.publicnode.com`) is sufficient for the full
suite. Pinned-block tests would need an archive RPC (none currently in V4).

| Suite | Tests | Focus |
|---|---|---|
| `PermanentCollection.t.sol` | 9 | recordAcquisition/markCustody mechanics, bytecode-scan |
| `PunkVault.t.sol` | 4 | vault gating, no-withdrawal bytecode-scan |
| `Patron.t.sol` | 9 | bytecode-scan, pool-replenish gating, zero-bounty edge case, allowlist gating |
| `AcceptBid.t.sol` | 7 | acceptBid happy path + reverts |
| `AcceptListing.t.sol` | 10 | acceptListing happy path + reverts + allowlist behavior |
| `ReturnAuctionModule.t.sol` | 13 | reserve = cost+premium, 65/25/10 cleared split, anti-snipe, refunds |
| `Parameters.t.sol` / `LiveBidAdapter.t.sol` | 12 | bounds-checking + 1y-lock freeze + activation-threshold carve-out |
| `BuybackBurner.t.sol` | 4 | execute-step caller reward |
| `PunkStrategyComposition.t.sol` | 3 | headline yoyo composition test |
| `IntegrationFlow.t.sol` | 3 | end-to-end acceptBid → clear / vault |
