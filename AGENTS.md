# PERMANENT COLLECTION — context for AI coding agents

> **Status: live on Ethereum mainnet since 2026-06-08.** Every protocol
> contract is deployed, immutable, and source-verified on Etherscan
> (`contracts/deployments.mainnet.json`). This file is the durable
> architecture + invariant reference for any AI coding agent working in this
> repo — not a changelog (git history covers process).

## What it is

An on-chain protocol that uses a speculative ERC20 to build a **permanent**
collection of CryptoPunks via full-trait coverage. The artwork *is* the
system — a global ETH live bid offered for any eligible Punk, with a 72-hour
return auction deciding each Punk's fate. License MIT. No deadline; the
protocol completes only when all 111 CryptoPunks traits are represented by
vaulted Punks.

**Launched as an art coin on the artcoins protocol.** The 111 token, V4
pool, and LP locker are deployed via the artcoins factory; the PERMANENT
COLLECTION-specific contracts plug into the factory's reward distribution.

## The artistic claim

CryptoPunks have **111** distinct traits across 4 dimensions (5 normalized
types, 11 head variants, 8 attribute counts, 87 accessories). A "Full Set"
is the bit mask `(1 << 111) - 1`. The protocol's goal is to assemble a
collection that covers every trait bit.

**V4 inverts the V3.1 acquisition direction**: instead of the protocol
hunting listings, it posts a single global ETH **live bid**. Any eligible Punk
owner can accept it by sending their Punk in. The Punk then enters a 72-hour
**return auction**:

- **Rescue** — someone bids ≥ `paid × (101 + previousTrials) / 100`
  (1% reserve premium per prior trial against this trait; first trial = 1.01×).
  Punk → bidder; 50% of high bid refills the live bid; 50% buys and burns the 111 token.
- **Silence** — nobody bids. Punk enters `PunkVault` permanently; ONLY the
  recorded target trait becomes Collected (V2 spec change — V1 collected
  every uncollected bit on the mask).

The work is the sum of all those choices, indefinitely, until the full set is
complete or the system reaches an equilibrium where the remaining traits are
held by owners who refuse the live bid.

## Economic loop (V4 + hook-redesign / three-leg skim)

```
Trader ETH ─6% baseline skim→ ArtCoinsHookSkimFee
                              ↓ split + accrued in _beforeSwap (or _afterSwap exact-out)
                              ↓ flushed to all 3 recipients at end of same swap's _afterSwap
                              ↓ (no separate extension; hook self-routes within the swap's tx)
   │
   ├─ ~83.33% baseline ─→ LiveBidAdapter   ─sweep()→ Patron (throttled)
   │   + 100% antiSniperExtra  ─→ LiveBidAdapter  (MEV-window overage
   │                              concentrates here; spec invariant)
   ├─ ~16.67% baseline ─→ ProtocolFeePhaseAdapter
   │                  └─ sweep() → PCController (86.67/13.33 split,
   │                               13.33% routed to LAYER BurnRouter), from block 1
   └─ ≤0.25% of volume ─→ ReferralPayout (per-referrer ledger; pulled FROM
                          the protocol slice; never touches bid leg;
                          paid from the first swap when the swap carries
                          a valid referrer)

LP fee (0.5%) is distributed pro-rata to in-range V4 liquidity per standard
mechanics. At launch the conversion locker owns 100% of LP positions (1.11B
tokens across 14 tick ranges — positions 0-11 a thin-floor taper out to ~$31M
FDV, plus two concentrated tail positions 12 & 13 extending coverage to
~$310M FDV) and captures the LP fee by depth dominance →
LiveBidAdapter (single PC reward slot, 10_000 bps, admin = 0xdEaD →
permanently locked recipient). The tail positions are what provide the
protocol's permanent high-FDV depth (replacing the deleted POLDepositor) —
their LP fees route locker → LiveBidAdapter → Patron, mission-aligned.
Public LPs can mint positions after the
~30 min MEV window closes and will earn proportional fees alongside the
locker — the LP block is a launch-window mechanism, not an ongoing
restriction.

                                       │
                              ┌────────┴────────┐
                              │                  │
                       acceptBid       acceptListing
                       (owner lists      (allowlisted seller's
                        exclusively to    public listing ≤ bid,
                        hub @ ~live bid,  caller earns finder fee)
                        anyone finalizes)
                              │                  │
                              ▼                  ▼
                   buyPunk{value:listingWei}  buyPunk{value:minValue}
                              │                  │
                              └────────┬─────────┘
                                       ▼
                              ReturnAuctionModule (72h, reserve = paid × (101 + prevTrials) / 100)
                                       │
                              ┌────────┴────────┐
                              │                  │
                       bid ≥ reserve     no bid by deadline
                              │                  │
                              ▼                  ▼
                        Cleared / Rescue            Silenced / Vaulted (forever)
                        - Punk → buyer              - Punk → PunkVault
                        - 65% cost → Patron         - ONLY target trait collected
                        - 25% cost → Burner         - VaultBurnPool swept → BuybackBurner
                        - 10% cost + (highBid − cost)
                          → VaultBurnPool
                              │                  │
                              └────────┬─────────┘
                                       ▼
                        111 bought + burned (0xdead)
                        via permissionless executeStep
                        caller earns small reward (≤ 0.5% of step, ≤ 0.01 ETH)
```

Per 1 ETH of swap volume (3-leg split, set in `Deploy.s.sol._buildFactoryConfig`
and consumed by the hook's `initializePool`):
**5.00% → bid leg, 1.00% → protocol leg (→ PCController from block 1),
≤0.25% deducted from protocol leg to referrer if attributed**. Total
baseline skim = 6% (`baselineSkimBps = 6_000` on a 100k-denom). Sub-bps split
on the BASELINE skim: `bountyBps = 8_333`, protocolBps absorbs the
remainder (`= 10_000 - bountyBps = 1_667`). The vault-burn trading leg
has been retired — `VaultBurnPool` is now fed exclusively from the
cleared-auction proceeds split in `ReturnAuctionModule.settle`
(`(highBid − cost) + 10% × cost`).
Referral cap launches at `maxReferralBpsOfVolume = 250` (0.25% of
volume — the frontend default), admin-tunable forever within
`[0, 1_000]` (up to 1% of volume in 100k-denom) via
`TokenAdminPoker.setHookMaxReferralBps`; clamped per-swap from the
protocol slice only. The referral pays from the first swap (live from
block 1) whenever the swap carries a valid referrer; with no/invalid
referrer the slice stays in the protocol leg. `ARTCOINS_PROTOCOL_BPS = 0` —
no factory-injected artcoins protocol slot; LAYER burn revenue routes via the
protocol leg → PCController → its internal 13.33% burn split.

**Anti-sniper window**: for the first 30 minutes after pool init, the
**hook skim** (not the LP fee) linearly decays via `ArtCoinsMevLinearSkim`
from a 90% peak down to the 6% baseline over 30 min (~2.8% per minute).
`_skimAmounts` decomposes the total into `baselineSkim` + `antiSniperExtra`;
the BASELINE portion splits ~83.33/16.67 as above, and the **antiSniperExtra
routes 100% to the bid leg** (spec invariant — see
`_processSkimAndAttribution`). After ~30 min the module reports
`baselineBps` and the pool runs at the static 6%. The 0.5% LP fee is
independent and unchanged across the window.

**Acquisition does not equal collection** — a trait only counts toward Full
Set when a Punk carrying it enters `PunkVault`.

## Architecture: dependencies on artcoins

**PC launches on a FRESH artcoins stack it deploys per launch — NOT the
existing mainnet V3 factory.** The live V3 factory (`0xF051cd…6793e`) can't
produce the venue-scoped-transfer-tax token bytecode, so the launch broadcasts
`contracts/script/DeployArtcoinsLaunchStack.s.sol` (the shared
`PCLaunchStackDeployer`): a fresh tax-aware `ArtCoinsFactory`, a fresh
`ArtCoinsFeeEscrow`, the skim hook, the skim MEV module, a PC
`ProtocolFeeController`, and a conversion locker — all wired (incl.
`escrow.addDepositor(hook)`). PC's `Deploy.s.sol` then deploys the 111
token + V4 pool + LP via that fresh factory and reads the rest by env var. The
existing mainnet hook (`0xAAd673…`), MEV (`0xAe19E4…`), and escrow
(`0xDD1b8C…`) are the LEGACY stack and are NOT used. ⚠️ The `0xd1595a…92f9` /
`0xA5eA99…28cc` / `0x75be…1118` / `0x1143db…6b05` set earlier docs cited is the
**V1 LAYER** stack — also not PC's.

| Artcoins contract | Role for us |
|---|---|
| `ArtCoinsFactory` (**fresh tax-aware, redeployed per launch** via `DeployArtcoinsLaunchStack` — NOT the existing V3 `0xF051cd…6793e`) | Single-tx deploy of 111 token + V4 pool + LP. Called via `deployTokenWithProtocolBpsAndTax(cfg, 0, taxConfig)` (PC sets `ARTCOINS_PROTOCOL_BPS = 0` — no factory-injected artcoins protocol slot). |
| `ArtCoinsToken` (instance deployed by factory; the artcoins repo's renamed `NewMaterialToken`) | The 111 ERC20 itself. **Carries the venue-scoped buy-side transfer tax** (default-off shared infra, switched ON only for 111 via the factory's `deployTokenWithProtocolBpsAndTax` entry point — see invariant #21). `tokenAdmin` = **`TokenAdminPoker`** (a PC contract holding the role; owner-gated `bindExtension` / `lockExtension` / `setTokenTaxBps` safety valves — no metadata-refresh `poke()`, since the vault self-emits ERC-7572 refreshes; see the `TokenAdminPoker` row below). **Retained admin by design** — NOT a full lockout. `lockExtension` freezes the pool-extension binding when the dev chooses; `setTokenTaxBps` keeps the tax rate tunable within `[0, taxBpsMax]` (20% cap; launch 15%). |
| `ArtCoinsHookSkimFee` (rewritten — submodule, awaiting mainnet redeploy) | V4 hook. PC's launch consumes the **three-leg skim variant**: the hook reads `bountyBps`/`maxReferralBpsOfVolume` from `SkimHookFeeData` at `initializePool`. `_beforeSwap` (or `_afterSwap` for exact-output) splits the 6% baseline skim into **bid / protocol / referral** accruals via `_processSkimAndAttribution`. At the END of `_afterSwap` of the same swap, `_flushAccruedSkim` flushes all three FRESH accruals with no held/retry state: the bid leg forwards immediately to LiveBidAdapter and reverts the swap on failure (`BidForwardFailed`, trusted launch infra); the protocol leg deposits to the fee escrow (`storeFeesNative` under `protocolRecipient`, pull-based via `ProtocolFeePhaseAdapter.sweep`); the referral leg pays `ReferralPayout` (gas-capped) and folds to the protocol escrow on a failed payout rather than holding. The hook never holds a claim balance between swaps. The antiSniperExtra (MEV-window overage) routes 100% to the bid leg. Also hosts the `poolExtension` slot (empty at launch — Design B's dispatcher binds later via `TokenAdminPoker.bindExtension`). |
| `ArtCoinsMevLinearSkim` (PC's MEV module, **fresh per launch** — NOT the legacy `0xAe19E4…`) | Reports an elevated `currentSkimBps` during the first ~30 min after pool init; hook clamps `[baseline, MAX_SKIM_BPS]`. Auto-disables after expiry. Allowlisted on the fresh factory (`setMevModule`) inside the `DeployArtcoinsLaunchStack` broadcast — `Deploy.s.sol` reverts `MevModuleNotEnabled` otherwise. |
| `ArtCoinsLpLockerFeeConversion` (the **conversion locker**, deployed fresh per launch) | What PC launches on — NOT the stock V3 locker (`0xd914c8…97b2`). **Holds the 14 LP positions** minted from 100% of the token supply at launch — positions 0-11 a reweighted thin-floor taper out to ~$31M FDV, plus **two concentrated tail positions (12 & 13)** covering ~$31M–$310M FDV (the protocol's permanent high-FDV depth, replacing the deleted POLDepositor). Geometry is the "C4-smoothed" weights array `[375, 150, 300, 500, 800, 700, 1500, 1700, 1150, 850, 600, 275, 700, 400]` (BPS, sums to 10,000), chosen by a real-fork V4-Quoter slippage probe; tail tick offsets from the starting tick are +60,000→+72,000 (pos 12) and +72,000→+83,000 (pos 13). Collects fees from those positions (V4 pro-rata, so locker captures all LP fees only while it dominates depth) and forwards to a **single PC reward slot (10_000 bps)** wired to LiveBidAdapter, with admin = `BURN_ADMIN` (`0xdEaD`) so the recipient is permanently locked. Needs PC's patches (native-ETH support + `MAX_LP_POSITIONS=14` — bumped from 12 in the artcoins submodule, a coordinated launch step pending explicit approval); **not yet deployed on mainnet** — passed to Deploy.s.sol via `CONVERSION_LOCKER` env var. Geometry overridable via `Deploy.s.sol._lockerPositions()` (default = the 14-position array; validated for contiguity + Σbps==10,000). |
| `ArtCoinsFeeEscrow` (**fresh, deployed per launch** via `DeployArtcoinsLaunchStack` — NOT the existing `0xDD1b8C…1C06`) | Per-recipient **native-ETH** balance store backing the protocol-fee leg + the locker LP-fee path. The skim hook AND the locker are `addDepositor`'d in the deploy (the hook deposits every swap — missing it bricks trading). Reached via `claim(feeOwner, address(0))` / `availableFees(owner, address(0))`. |
| `ProtocolFeeController` (PCController instance, deployed fresh per PC launch) | Artcoins generic controller dedicated to PC, configured **86.67% PC treasury / 13.33% LAYER burn**. The single forward target of `ProtocolFeePhaseAdapter`, which sweeps the protocol leg here from block 1 (no phase gate). Passed via `PC_CONTROLLER` env var to `Deploy.s.sol`. |
| `BurnRouter` (LAYER) | Receives PCController's 13.33% LAYER-burn slice — the only path that touches LAYER. Live router `0x0EB22955E8904b8C5a4EC6f1D476f5b0C93854ca` (impact-cap: 1% swap-impact clamp + spot floor), redeployed + rewired via `controller.setBurnRouter` 2026-06-09 to replace the wedge-prone EMA router `0xE60046ee…` (now orphaned, drained). Discovered at runtime via `controller.burnRouter()`, so the keeper and the `/debug/fees` dashboard auto-followed the rewire with no config change. Distinct from the LAYER token's OWN active burn router `0x2edbdf…2000` (a separate per-WETH-floor router fed by the LAYER FeeLocker; LAYER trade fees burn there, untouched by PC). Keeper-driven on the artcoins side; does NOT gate PC's hook skim. |

**The pool is native-ETH-paired** (`pairedToken: address(0)`; V3 supports it).
No WETH plumbing in the adapter — `LiveBidAdapter` claims
native ETH from the escrow's `address(0)` slot and forward directly. `Patron`
holds native ETH so it can call `buyPunk{value:}`; `BuybackBurner` swaps
ETH→111 inside its V4 unlock callback via `settle{value:}` (no wrap).

### Artcoins source is a git submodule

`contracts/lib/artcoins` is a git submodule pinned to a specific commit,
resolved from [ripe0x/artcoins](https://github.com/ripe0x/artcoins) — the
public mirror of the artcoins working repo
([ripe0x/new-material-coin-launcher](https://github.com/ripe0x/new-material-coin-launcher),
private; its `master` mirrors to `ripe0x/artcoins` with identical SHAs).
Because the mirror is public, CI and fresh clones need no special
credentials; the repo secret `SUBMODULE_TOKEN` remains as a fallback in
`e2e.yml` only. The local submodule has two remotes: `origin` (GitHub)
and `sibling` (the local working clone at
`/Users/dd/CascadeProjects/new-material-coin-launcher` on dev's machine,
for fast local fetches).

**Check the pin state any time** with `scripts/artcoins-pin.sh check`. It reads
the gitlink (the single source of truth, never a SHA in prose) and reports
whether the pinned commit is pushed to GitHub, whether it's artcoins `master`'s
tip, and what it is. Full explainer: docs/ARTCOINS_PIN.md.

**When to bump the artcoins pin**: only when you change artcoins AND want
permanent-collection to use the new version. 99% of permanent-collection
work doesn't touch the submodule at all.

**Bump recipe** (when needed):

```bash
# 1. Edit + commit in the sibling artcoins repo (your normal flow)
cd /Users/dd/CascadeProjects/new-material-coin-launcher
# ...edits, git commit

# 2. Pull into permanent-collection's submodule — LOCAL fetch, instant
cd /Users/dd/CascadeProjects/permanent-collection/contracts/lib/artcoins
git fetch sibling && git checkout sibling/master

# 3. Bump the pin in permanent-collection
cd ../../.. && git add contracts/lib/artcoins
git commit -m "bump artcoins to <short-hash>"

# 4. Before pushing the bump publicly, also push artcoins to GitHub
#    so the pinned commit reaches the public ripe0x/artcoins mirror
#    (the working repo's master auto-mirrors there on push).
cd /Users/dd/CascadeProjects/new-material-coin-launcher && git push
```

If you're a fresh assistant joining a worktree and `contracts/lib/artcoins`
is empty: `git submodule update --init --recursive`. If you're creating a
new worktree: `git worktree add --recurse-submodules <path> <branch>` (or
ensure `git config --global submodule.recurse=true` is set so plain
`git worktree add` handles it).

**Note on `.gitmodules` `update = none`**: the artcoins submodule entry is
pinned `update = none` so the Netlify production build (which clones the
parent repo via the Netlify GitHub App but cannot reach this private
submodule over plain HTTPS) skips it cleanly during repo-prep. The Netlify
deploy only builds the `app/` workspace and never needs artcoins.

Consequence for local contracts work: plain `git submodule update --init
--recursive` will SKIP artcoins because of the `update = none` default.
Pass `--checkout` to override:
`git submodule update --init --recursive --checkout contracts/lib/artcoins`.
GitHub Actions CI is unaffected — the current `app` workflow uses plain
`actions/checkout@v4` (no `submodules: true`) so submodules are never
fetched on CI; the `SUBMODULE_TOKEN` repo secret would only kick in if
the deleted contracts/forge job is restored.

## Our contracts (production, `contracts/src/`)

### Permanent core (no upgrade path, immobile state)

| Contract | Role |
|---|---|
| `PermanentCollection` | Records-only permanent core. Holds NO Punks. Tracks `collectedMask` (monotonic), `pendingTraitCount`, `firstVaultedPunk`, the immutable `Acquisition[]` log (each row records `punkId`, `targetTraitId`, `mask`, `pendingMaskAtAcquisition`, `acquirer`, `originalSeller`, `priceWei`, `acquiredAtBlock`, `custody`), per-Punk `Custody`. The `originalSeller` field is the giver-up of the Punk and the recipient of any future Proof NFT at vault-settle — for `acceptBid` it equals `acquirer`; for `acceptListing` it's the listing seller (distinct from the finder `acquirer`). Constructor pins `PunksData.datasetHash`. **Only `patron` may call `recordAcquisition`; only `returnAuctionModule` may call `markCustody`.** `recordAcquisition` also hosts the **sole-carrier target guard** (invariant #22): while the dataset's one rarity-1 trait (`SOLE_CARRIER_TRAIT_BIT` = 23) is uncollected, an acquisition of its unique carrier (`SOLE_CARRIER_PUNK_ID` = #8348) must record `targetTraitId == 23`, else `SoleCarrierMustTargetTrait`. Exposes the dataset-pinned constants + a `soleCarrierConstraint(punkId)` view. Bytecode scan asserts no third-party mutator selectors. |
| `PunkVault` | Immutable terminal custodian for vaulted Punks AND `solmate/ERC721` issuer of the protocol's **112 named tokens**: the Title (token id 111, minted by `PunkVaultTitleAuction`) and the **111 Proofs** (token ids 0..110, one per first-vaulting of a previously-uncollected trait, minted to the recorded `originalSeller` by `ReturnAuctionModule` at vault-settle). Proof `tokenId == traitId`. Dual-minter scoping is bytecode-enforced: the Title minter cannot reach the Proof range; the Proof minter cannot reach id 111; both reject ids ≥ 112. Proofs use `_mint` (not `_safeMint`) so a non-receiver-aware contract recipient cannot strand the Proof. Per-Proof `proofMeta(tokenId)` is frozen at mint time (punkId, traitId, sequence, mintedAtBlock) and survives transfers — the current owner is queryable separately via `ownerOf`. `tokenURI(id)` dispatches via `RendererRegistry` → Mosaic renderer → ids 0..110 = `PermanentCollectionProofRenderer, id 111 = Title`, else `UnknownTokenId(id)`. Punks themselves are NOT ERC721 tokens — they're held at the canonical market's `punkIndexToAddress` slot. **Marketplace collection editor:** exposes ERC-173 `owner()` (initialized to deployer EOA) so OpenSea / Blur / Magic Eden recognize the deployer for setting collection banner / profile image / description / social links during the launch-setup window. **One-way ratchet:** `renounceOwnership()` sets owner to `address(0)` forever; there is intentionally no `transferOwnership`. Owner slot has zero on-chain authority — does not gate any vault state, the Punks, the metadata content (rendered from `RendererRegistry`), or any other PC contract. Emits ERC-7572 `ContractURIUpdated()` on every title / Proof mint so marketplaces refresh the "N of 111" progress fields automatically. NO Punk-withdrawal function — bytecode-scan tests assert the absence of every CryptoPunks market-write selector AND assert the only admin-pattern selectors on the vault are `owner()` + `renounceOwnership()` (covered live at fork level by `LaunchInvariantForkTest` + `ProofMintForkTest`). |
| `Patron` | V4 entry-point hub. Holds the global live-bid ETH. Exposes `acceptBid(uint16 punkId, uint8 targetTraitId, uint256 expectedListingWei)`, `acceptListing(punkId, targetTraitId)`, allowlist management, and bounded parameter setters. **`acceptBid` priced-listing model:** the owner lists their Punk **exclusively to Patron at a real positive price ≤ the current live bid** (`offerPunkForSaleToAddress(punkId, listingWei, patron)`, never 0; the frontend lists at the full bid by default); **anyone** may then finalize (permissionless — the target is protocol-derived via `canonicalTargetOf`, so there is no caller-chosen target to front-run). Patron buys at the listed price via `buyPunk{value: listingWei}`, so **the seller is paid by the market** (`pendingWithdrawals`, collected with `withdraw()`) — Patron no longer pushes the bid to the seller. The price checks are just `L > 0` (`ZeroListingPrice`), `L ≤` the live bid (`ListingExceedsBid` — can't list above the pool), and `L ≤ expectedListingWei` (`ListingAboveExpected` — the caller's overpay cap); the 3rd arg flipped from a seller-payout floor (`minPayoutWei`) to this cap. **There is no reserve floor** — a seller may list at ANY positive price up to the bid; the protocol pays the listed price and the pool keeps any difference. The return auction's open-market exposure is the anti-grief mechanism, not a reserve floor: occupying a trait's one in-flight slot means putting a real Punk into a 72h open auction every cycle, which is economically irrational against a deadline-less protocol. Removed errors `SellerPaymentFailed`/`MinPayoutRequired`/`PayoutBelowMin`/`NotPunkOwner`; added `ListingAboveExpected`/`ListingExceedsBid`/`ZeroListingPrice`. `acceptBid` and `acceptListing` now share an internal `_acquire` tail but stay two SEPARATE, separately-gated entry points (different anti-grief models: open access vs allowlist + finder fee). **Inflow consolidation:** `receive()` is now **adapter-only** (`if (msg.sender != liveBidAdapter) revert NotAdapter()`) — every bid-funding source routes through `LiveBidAdapter` (the single faucet), which buffers + meters into Patron. `contribute(address,bytes32)` and `poolReplenish(uint16)` (+ their `BareTopUp`/`Contribution`/`PoolReplenished` events, `REFERRER_CONTRIB_BPS`/`REFERRER_GAS` constants, `ZeroValue` error) **moved to `LiveBidAdapter`**; `IPatron` no longer declares them (breaking interface change). `setWiring` gained a 3rd `liveBidAdapter` param. Both `acceptBid` and `acceptListing` mirror the **sole-carrier target guard** (invariant #22) in their target pre-validation for an early/cheap revert (`SoleCarrierMustTargetTrait`) before `buyPunk` — `PermanentCollection.recordAcquisition` is authoritative. No admin withdrawal path (bytecode-scan asserted; `contribute`/`poolReplenish` selectors now confirmed ABSENT on Patron, present on the adapter). Decorated with `nonReentrant` + `notInSwap`. |
| `ReturnAuctionModule` | Per-Punk 72-hour return auction. **Reserve = `acquisitionCost × (101 + previousTrials) / 100`** (snapshotted at `startSale`; deterministic from `PermanentCollection.attemptCount(target)`). **A settled sale slot is reusable — a rescued (ReturnedToMarket) Punk can be re-auctioned: `startSale` resets the slot (clears highBid/highBidder/settled + `referrerOfHighBid[punkId]`) and re-snapshots the reserve off the new acquisition price (the per-trait `attemptCount` escalation carries forward); only a LIVE unsettled sale blocks a new `startSale`.** Anti-snipe: 15-min trigger window / +1h extension, **uncapped**. Bid entry points are `placeBid(uint16 punkId)` (simple, no referral) and `placeBidWithReferral(uint16 punkId, address referrer, bytes32 tag)` (referral-bearing) — both decorated `nonReentrant` + `notInSwap`, both delegating to an internal `_placeBid` (`placeBid` passes `referrer = address(0)`); the accepted bidder's referrer overwrites `referrerOfHighBid[punkId]` (outbid bidders' referrers lose attribution; SLOT tracks the current high bidder's referrer only). Cleared → Punk delivered to buyer via a **provenance round-trip** through `ReturnAuctionEscrow`; proceeds split: **65% cost → `LiveBidAdapter.poolReplenish` (buffered + metered into the live bid — inflow consolidation, no longer a direct Patron spike) / 25% cost (residual) → BuybackBurner / 10% cost → VaultBurnPool / 5% of premium → referrer (hard-coded `REFERRER_PREMIUM_BPS = 500`, 35k-gas budget, fail-closed; folds back into the vault-burn share on failure) / remaining premium → VaultBurnPool** (hard-coded `CLEARED_BID_BPS = 6_500`, `CLEARED_VAULT_BURN_BPS = 1_000`). Auction-referral pulls ONLY from premium — NEVER from bounty/burn. Unsold → PunkVault, ONLY the recorded target trait collected; no auction referrer paid on the vault path (no premium exists). Vault-path settle also sweeps VaultBurnPool → BuybackBurner. Emits extended `ReturnAuctionCleared(punkId, buyer, referrer, highBidWei, bountyShare, burnShare, vaultBurnShare, referrerShare)` and new `BidPlaced(punkId, bidder, referrer, amount, tag, endsAt)`. |
| `ReturnAuctionEscrow` | Settlement escrow, deployed by `ReturnAuctionModule` in its constructor and pinned to it (`MODULE`). On cleared settle, the module transfers Punk in → escrow lists it exclusively back to module at hammer price → module `buyPunk`s it → canonical market emits `PunkBought(escrow, module, highBid)`. Proceeds round-trip straight back via `sweepProceeds`. Winner is the final `transferPunk` recipient (not the recorded `buyPunk` caller). `listForSettlement`/`sweepProceeds` module-only; `receive()` accepts ETH only from the Punk market. No admin/withdrawal surface. |
| `BuybackBurner` | Receives ETH from cleared settles + VaultBurnPool sweeps + any inflow via `receive()`. `executeStep(minOut)` paced by `minBlocksBetweenSteps`, permissionless, caller earns small reward (≤ 0.5% of step, ≤ 0.01 ETH). Burns the 111 token to `0xdead`. **Sandwich protection is a fixed V4 price-impact cap**: `maxSlippageBps = 500` (5%) is a compile-time constant (not tunable, no admin) — each step partial-fills against the cap so one buy-and-burn never moves price enough to be worth sandwiching. The prior EMA-anchored `referenceDeviationBps` gate and the `minTokensPerEthFloor` slot were **removed** (PR #184 / artcoins #17): a static/relative gate was the wrong shape for an appreciating ETH→111 pool, and the impact cap subsumes them. Decorated with `notInSwap`; no `nonReentrant` mutex by design — `lastStepBlock` is written before the unlock callback, so a same-tx re-entry of `executeStep` reverts `StepTooEarly`, and it shares no mutable state with any other fund-mover (audit L-1 reviewed this and accepted pacing as the complete same-tx guard). Off the collection critical path (live bid funded by the 6% skim regardless). |
| `LiveBidAdapter` | **The single inflow governor for the live bid.** Native-ETH adapter, registered as the single PC reward slot (10_000 bps) on the conversion locker (admin = `0xdEaD`, recipient locked forever). **Inflow consolidation:** every ETH source that funds the bid enters here and is buffered + metered into Patron via `sweep` — Patron's `receive()` accepts ETH ONLY from this adapter. Inflows: the **~83.33% baseline bid leg** + **antiSniperExtra** from the hook (claim-tokens); the locker's 0.5% LP-fee share (100% at launch by depth dominance); `contribute(address,bytes32)` attributed top-ups (moved from Patron — `REFERRER_CONTRIB_BPS = 500` to the referrer, 35k-gas fail-closed, emits `Contribution`); bare `receive()` top-ups (emits `BareTopUp`); and the cleared return-auction rescue refund via module-only `poolReplenish(uint16)` (new immutable `returnAuctionModule` ref gates it; emits `PoolReplenished`). `contribute`/`poolReplenish` decorated `nonReentrant` + `notInSwap`. **`sweep()` meters the buffer into Patron in TWO modes keyed on `Patron.balance` vs `activationThreshold`: BELOW the threshold it forwards the buffer uncapped with no cooldown, clamped to land the bid exactly AT the threshold (fast launch warm-up); AT/ABOVE it the throttle caps each forward at `maxSweepWei` (2 ETH) per `minBlocksBetweenSweeps` (~30 min).** `sweep()` first calls `_syncActivationThreshold()` so the fast-mode decision reads the freshest threshold. **Pre-swap streaming:** besides keeper/UI `sweep()`, the adapter exposes `streamForward()` (implements `IPreSwapStream`) — the artcoins hook calls it in `_beforeSwap` (opt-in by interface, balance-gated try/catch, can't brick a swap) so the bid advances per-swap from prior swaps' buffered bounty leg: buffered-native only (no escrow claim), **no keeper reward**, no-op below `MIN_STREAM_WEI` (0.01 ETH) and on cooldown; runs outside the Design-B `inSwap` window so it composes with a bound dispatcher (artcoins hook pin `7ef5c96`). **`sweep` and `streamForward` share ONE cooldown clock (`lastSweepBlock`)** so the throttled-mode rate cap holds across both paths; fast-mode forwards (below the threshold) do NOT arm the clock, so the throttle engages fresh from the first at-or-above-threshold forward. **`activationThreshold` self-tracks the revealed floor:** `_syncActivationThreshold` (run first in `sweep`) reads the records core (`permanentCollection` / `IPCAcquisitionReader`) and overwrites the threshold with 75% of the latest `acceptBid` clearing price (−25% band), clamped to `ACTIVATION_THRESHOLD_HI = 100 ether`; `acceptListing` rows are skipped (a cheap finder listing must not drag the ceiling down); fail-open if the reader reverts or the ref is `address(0)` (auto-track disabled → manual-only, the standalone-unit-test mode). Deploy seed `ADAPTER_ACTIVATION_THRESHOLD = 30 ether`. `streamForward` does NOT sync (lean swap hot path — it reads whatever the last `sweep` set). **Re-opens audit M-1 (a 1-wei `acceptBid` craters the synced threshold to 0 → adapter pinned into throttled/cap-always mode; worst case = the cap-always behavior, no protocol value extracted) and L-2 (fast-mode has no cooldown, so a keeper can harvest the bounded reward per tiny inflow until the threshold is crossed) — both KNOWINGLY ACCEPTED (see the `AUDIT NOTE` in `_syncActivationThreshold`).** The POL-diversion + rebate slots remain **deleted** (separate prior removals, unrelated to the threshold). The two rate-cap setters (`setMaxSweepWei` / `setMinBlocksBetweenSweeps`) are `checkAdmin`-gated and lock at the 1y expiry; `setActivationThreshold` is `onlyAdminEvenIfLocked` and is the adapter's lone lifetime carve-out (persistent ProtocolAdmin carve-outs are back to 4). `returnAuctionModule == address(0)` leaves `poolReplenish` uncallable (standalone-unit-test mode). Decorated `notInSwap` + `nonReentrant` (the keeper-reward `.call` to `msg.sender` is un-gas-limited and every forward is cooldown-gated, so the mutex is the active same-tx reentry guard — audit L-1). |
| `VaultBurnPool` | Burn accumulator released on every vault-path settle. Holds TWO assets: ETH (swept to BuybackBurner) and the 111 token's venue-scoped transfer-tax proceeds — it is the token's tax `burnAddress`, so tax 111 accrues here and is burned in place via `token.burn` (real supply reduction, totalSupply drops) on the SAME `sweep` that forwards the ETH. The 111 burn runs FIRST and is REQUIRED (burning the contract's own balance can't revert); the ETH forward is BEST-EFFORT (a failed forward leaves the ETH for the next sweep — no revert; no `ForwardFailed`). Both legs release on one trigger: only `ReturnAuctionModule` may call `sweep()` (vault-path settle), which calls it **DIRECTLY — no `try/catch`.** `sweep` is non-reverting by construction (burn can't revert + ETH best-effort + the `msg.sender` gate passes for the module), so the direct call can't strand a Punk AND makes the 111 burn **GUARANTEED** rather than gas-skippable (a `try/catch` lets `eth_estimateGas` pick the cheaper burn-skipped path and silently defer the burn; a direct call forces the estimator to provision it). One-shot `setup(token)` wires the 111 token post-deploy (resolving the token↔`burnAddress` construction cycle), then locks via `OneTimeSetup`; until wired the 111 burn leg is a no-op (pure-ETH behaviour). The only 111 outflow is `burn` — never a transfer to an external address. Bytecode-scan asserts no withdrawal AND no token-transfer-out (`transfer`/`transferFrom`/`approve`) selectors. Decorated `notInSwap`. |
| `ProtocolFeePhaseAdapter` | Receives the **~16.67% baseline protocol leg** from the hook (deposited into the fee escrow under its address). `sweep()` claims it from the escrow and forwards it to PCController (86.67/13.33 PC-treasury/LAYER-burn) from block 1 — a lean single-target forwarder, no phase gate, no `liveBidAdapter`/`pc` wiring. Decorated `notInSwap`. |
| `ReferralPayout` | Pull-based per-referrer ETH ledger. The hook calls `notify(referrer)` with the ≤0.25%-of-volume slice from the first swap, whenever a swap carries valid `PCAttribution` hookData. Referrers (or anyone via `claimFor`) pull via `claim`. 35k-gas budget on the outgoing send; reverting recipient → balance reinstated + `TransferFailed`. Stray ETH (direct `call` to `receive()`) is accepted but NOT credited. |
| `PCSwapContext` | **Reentrancy-detection registry** shared across PC contracts. Exposes a transient-storage `inSwap` flag (EIP-1153) that only the `authorizedExtension` may toggle. At launch the slot is `address(0)` — the flag is permanently `false` and decorated functions are no-ops. Future Design B dispatcher binds via `setAuthorizedExtension`; `lockAuthorizedExtension` is one-way. No funds, no upgrade path. |
| `PCNoReentry` (library / mixin) | `notInSwap` modifier the 7 decorated PC contracts inherit. Reads `PCSwapContext.inSwap()`; reverts `PCNoReentry.InSwap` if a callback during a swap tries to reenter. Accepts `swapContext = address(0)` (modifier short-circuits to no-op) so test fixtures and contracts without a registry attached compile and run. |
| `PCReentrancyGuard` (library / mixin) | Shared `nonReentrant` mutex inherited by `Patron`, `LiveBidAdapter`, `ReturnAuctionModule`, `PunkVaultTitleAuction` — replaces the four byte-identical inline `_lock` mutexes those contracts previously each defined. Sibling of `PCNoReentry`. Uses EIP-1153 transient storage (same primitive as `PCSwapContext.inSwap`): the lock auto-clears at tx end (no trailing SSTORE, no stuck-lock mode); the slot is per-contract-address so the shared constant is collision-free. `notInSwap` guards cross-swap-callback reentry; `nonReentrant` guards same-call reentry from a `.call` payout recipient — the two are orthogonal and both decorate the fund-movers. |
| `TokenAdminPoker` | **Retained token-admin holder.** Owns the 111 `tokenAdmin` role. Exposes owner-gated `bindExtension(ext)` / `lockExtension()` / `setHookMaxReferralBps(newCap)` / `setTokenTaxBps(newBps)`, one-shot `setup(token, poolKey)` (pins the token + canonical pool, so the extension / referral-cap setters take no target args — they act only on this pool), and `transferOwnership`. **No metadata-refresh `poke()`** — `PunkVault` self-emits ERC-7572 `ContractURIUpdated` on every title/proof mint (the only refresh the protocol needs, straight from the real collection events), and the separate 111 ERC20 marketplace card is mission-orthogonal (read by nothing on-chain), left to marketplace re-indexing. The old public, rate-limited `poke()` + its cooldown state (`MIN_PUBLIC_POKE_BLOCKS`/`lastPublicPokeBlock`/`hasPublicPoked`) and the unused `vault` wiring were removed (an idempotent re-write of identical token metadata never earned its permanent place). Admin is **deliberately retained** so a future Design B dispatcher can be bound when ready; `lockExtension` then freezes the binding permanently. `setHookMaxReferralBps` forwards to the skim-fee hook's `setMaxReferralBpsOfVolume`, bounded by the hook's hard `MAX_REFERRAL_CAP_OF_VOLUME = 1_000` (1% of swap volume in 100k denom); used to raise (or lower) the referral cap post-launch — PC launches at `250` (0.25% of volume, matching the frontend default) and can tune it up to `1_000` (1% of volume) or down to `0` later. **Not carved out** from the protocol-owner lifecycle: when `owner` is transferred to a dead address (the convention is to do this at the same time `ProtocolAdmin` is burned), all four setters become unreachable, the cap freezes wherever it was last set, and the binding remains forever via `lockExtension`. |
| `ProtocolAdmin` | 1-year auto-locking admin role. Gates `Patron` economic-parameter setters + adapter operational setters. **Surface it gates exempt from the 1y lock**: the seller allowlist (`Patron.addAllowedSeller` / `removeAllowedSeller`). (The adapter's `setMaxSweepWei` / `setMinBlocksBetweenSweeps` lock at the 1y expiry — NO carve-out; `LiveBidAdapter.setActivationThreshold` IS a carve-out — `onlyAdminEvenIfLocked`, single-key on `ProtocolAdmin.admin()` (the fast/throttled boundary; re-opens audit M-1/L-2, accepted). The two `TokenAdminPoker` carve-outs — `setHookMaxReferralBps`, `setTokenTaxBps` — are two-key-gated on EITHER `ProtocolAdmin.admin()` OR `TokenAdminPoker.owner`; see invariant #12. Total = four lifetime carve-outs across both admin roles.) Cannot move funds. Initial admin = deployer EOA. **Burn (`transferAdmin(address(0))`) is the always-available off-switch — reachable at any time, even after the 1y timer lapses; only renewals/rotations are time-gated (auditor M-1)** — so the carve-outs always retain an on-chain kill. |

### Renderer + auxiliary (also production)

| Contract | Role |
|---|---|
| `PermanentCollectionMosaicRenderer` | Shipped renderer. Cache-backed mosaic — 11×10 main trait grid plus one "final type" cell pulled out beneath the grid's bottom-left, on a square 356×356 canvas. Three-state cells (Collected / Pending / Uncollected). Reads `collectedMask` + `pendingMask` + `firstVaultedPunk`. Registered via `RendererRegistry`. **`tokenURI(uint256 id)` dispatches: id 111 → Title (this contract), ids 0..110 → `proofRenderer`, else → `UnknownTokenId`.** All bytes accumulation (outer SVG + inner `_rlePunk` / `_rleDiff` / `_renderCountDots` / `_renderPixelText`) uses solady's `DynamicBuffer` — O(n) memory and gas, not O(n²) — so on-the-fly fallback renders for uncached cells are cheap. |
| `PermanentCollectionProofRenderer` | On-chain SVG + JSON renderer for Proof token ids 0..110. Reads `vault.proofMeta(id)` + `punksData.traitName(traitId)` + `traitIconCache.buildFragment(traitId)` + `punkSvgCache.buildFragment(punkId)`. The image is a 24×24 trait tile on a `#8F918B` background: on a **minted** Proof the acquired Punk (the `punkId` whose vaulting brought the trait in) is drawn first at **5% opacity** as a barely-visible background layer, then the isolated trait icon is composited crisply on top; an **unminted** Proof has no acquired Punk yet, so it renders the trait icon alone. The minted-vs-unminted distinction lives in the IMAGE via the raw `svg(traitId)` view (faint Punk layer once minted, trait icon alone before). `tokenURI(id)`, by contrast, exists ONLY for a minted Proof — it reverts `ProofNotMinted` for an unminted id (no preview envelope; mirrors the canonical `PunkVault.tokenURI` path, which reverts `UnknownTokenId`). The `RendererRegistry` forwards `tokenURI(uint256(111))` (the Title, which always renders) rather than a Proof id (which reverts `ProofNotMinted` until minted) when verifying a live render — `RendererRegistry.setImplementation` performs no on-chain interface probe. No admin, no setters, no storage of its own. |
| `PunkSvgFragmentCache` / `TraitIconCache` | On-chain SVG caches for renderer performance. |
| `RendererRegistry` | Stable address fronting the live renderer. Pass-through `tokenURI()` / `tokenURI(uint256)` / `contractURI(address)` / `svg()` to `implementation`. Admin can swap impls until `freeze()` (or admin auto-locks). **There is NO on-chain interface probe** — `setImplementation` guards only the zero address (`ZeroAddress`) and an EOA / destroyed contract (`NotAContract`); a candidate that HAS code but renders garbage is NOT caught on-chain by design (the registry moves no value, so a bad install only reverts the forwarded views and is recoverable by swapping again until `freeze()`). The launch runbook's visual verification of the live `tokenURI(111)` / `contractURI` output before `freeze()` — not a deploy-time selector check (which a contract returning two garbage words would pass anyway) — is the real bound. See the `setImplementation` NatSpec. |
| `PunkVaultTitleAuction` | Auctions title rights for vaulted Punks (display-side governance). Mints token id 111 (the Title) on PunkVault — sits just past the 111 Proofs (ids 0..110). The mint is **decoupled from the auction**: `mintTitle()` (permissionless, idempotent) mints the Title into the auction escrow and is called by `Deploy.s.sol` right after `setTitleAuction`, so the Title exists and its `tokenURI(111)`/marketplace page resolve from launch; the AUCTION stays closed (no bids) until `kickoff()` past the 22-trait `KICKOFF_THRESHOLD` (kickoff re-calls `mintTitle()` only as an idempotent fallback). Decorated `nonReentrant` + `notInSwap`. |

### Design B dispatcher (verified-ready; not bound at launch)

| Contract | Role |
|---|---|
| `PCDispatcher` | **Production permissionless dispatcher.** Anyone can claim a callback slot by paying a fee (forwarded directly to Patron — registering grows the live bid). Slots bounded by immutable `MAX_CALLBACKS` `[4, 32]`; once full, new registrations must outbid the lowest-fee occupant by `EVICTION_PREMIUM_BPS` premium. Misbehaving callbacks auto-disabled by an on-chain failure counter at `FAILURE_THRESHOLD`; anyone re-enables for `REENABLE_FEE`. All seven economic parameters are immutable constructor arguments with hard `[LOWER, UPPER]` bounds enforced in the constructor — the *mechanic* is what gets audited; the specific tuning is a deploy-time decision. No admin, no owner, no setters. Built + smoke-tested pre-launch (16 `PCDispatcherSmokeTest` tests). Binding via `TokenAdminPoker.bindExtension` is a deliberate post-launch operation. ~8.2KB runtime. Spec: `docs/DISPATCHER_DESIGN.md`. |
| `IPCCallbackExtension` (`src/interfaces/`) | Canonical builder-facing callback interface. Single method: `onSwap(PoolKey, SwapParams, BalanceDelta, bytes) returns (bytes32)`. Stable surface; PCDispatcher and any future dispatcher consume this. |
| `UnipegDispatcher` (`src/demos/`) | Demo dispatcher with owner-gated registry (MAX_CALLBACKS = 8). Kept as documentation example for the callback pattern. NOT the production platform. |
| `UnipegArt` (`src/demos/`) | Demo callback that mints "unipeg" NFTs on every swap with valid attribution. Reference `IPCCallbackExtension` implementation. |

### What's been deleted (history)

V4 (vs V3.1):
- `AcquisitionPool` → replaced by `Patron`
- `AcquisitionPoolAdapter` → replaced by `LiveBidAdapter`
- `ListedAcquisitionModule` (atomic acquire, comparable rule,
  monopoly-eligible bitmap, pacing thresholds)
- `IAcquisitionModule` interface + the `approvedAcquisitionModule` registry
- `test/AcquisitionPool.t.sol`, `test/ListedAcquisitionModule.t.sol`

Hook redesign (vs V4 path B):
- `PerSwapFeeExtension` (the per-swap callback flywheel that drove
  collect → convert → distribute) — deleted; the three-leg split now
  happens inside `ArtCoinsHookSkimFee._afterSwap` directly, with no
  separate extension contract needed at launch.
- `MetadataPoker` (full-lockout) — superseded by `TokenAdminPoker`
  (retained admin so future Design B binding is possible).
- `PCFeeRouter` — superseded by direct hook-side routing to the
  adapters; the file lingers as a deprecated artifact and is NOT used
  by the current `Deploy.s.sol`.

Fee-leg simplification (2026-05-28):
- `VaultBurnAdapter` — deleted. The hook's vault-burn leg is retired;
  `VaultBurnPool` is now fed exclusively from the cleared-auction
  proceeds split in `ReturnAuctionModule.settle` (`(highBid − cost) +
  CLEARED_VAULT_BURN_BPS × cost`).

## Critical external addresses (mainnet)

- `0xb47e3cd8…3BBB` — CryptoPunksMarket (original 2017)
- `0x9cF9C8eA…117C` — **PunksData** (sealed; ENS `punksdata.eth`). Constructor pins `datasetHash = 0x92117ce6…1f68`. Never substitute.
- `0xC02aaA39…56Cc2` — WETH
- `0x00…04444…08A90` — V4 PoolManager
- `0x66a9893c…ba8af` — V4 Universal Router
- `0x00…22D473…78BA3` — Permit2
- `0xc50673…33eDF` — **PunkStrategy listing contract** (PNKSTR yoyo). Seeded into `Patron.allowedSellers` at deploy via `Deploy.s.sol`.
- `0xAe19E4…D8C6F` — the LEGACY anti-sniper linear-FEES MEV module. **PC does NOT use it** — the launch deploys a fresh `ArtCoinsMevLinearSkim` (the SKIM variant) via `DeployArtcoinsLaunchStack` and allowlists it on the fresh factory there (the `setMevModule` happens in that broadcast). Its decay is configured by `Deploy.s.sol`'s `mevModuleConfig` with `abi.encode(uint24(90_000), uint24(6_000), uint32(1_800))` — 90% → 6% baseline over 30 minutes (~2.8% per minute). After expiry the module self-disables and the pool runs the static 6% baseline. `Deploy.s.sol` reverts `MevModuleNotEnabled()` if the MEV isn't allowlisted on the factory.
- See "Architecture: dependencies on artcoins" above for the artcoins suite.

## Hard invariants

These are the artwork's actual commitments. If a change weakens any of
these, stop and surface it.

1. **`collectedMask` is monotonically increasing.** Bits never unset.
2. **`Acquisition[]` log only grows.** Records never removed. A
   re-acquisition of a rescued Punk APPENDS a new row (it never mutates a
   prior row); only the current row's `custody` field mutates, and only
   forward (`InReturnAuction → ReturnedToMarket | Vaulted`).
3. **Custody cycles `(zero/None) → InReturnAuction → ReturnedToMarket → InReturnAuction → …`; `Vaulted` is the ONLY terminal state.** A rescued (ReturnedToMarket) Punk may re-enter the return auction — re-acquisition is gated in `PermanentCollection.recordAcquisition` to custody None or ReturnedToMarket (InReturnAuction and Vaulted are rejected `AlreadyRecorded`). Each re-acquisition appends a new `Acquisition[]` row and re-points `_acquisitionIndexOf` to it; the prior row's `custody` stays frozen at ReturnedToMarket (append-only, #2). A Vaulted Punk can NEVER be re-auctioned (no withdrawal path from `PunkVault`). `collectedMask` stays monotonic (#1) — a re-auction can only target an uncollected, non-pending trait.
4. **Acquisition does not imply collection.** `recordAcquisition` never
   touches `collectedMask`; only `markCustody(punkId, Vaulted)` does.
5. **Returned-to-Market never collects traits.** Only decrements pending
   counters.
6. **Vaulted collects ONLY the recorded target trait** (V2 spec change — pre-V2 collected every uncollected bit on the mask). Other uncollected bits on the Punk's mask remain available for future acquisitions. **The recorded target is protocol-derived, not caller-chosen (2026-06-03): `recordAcquisition` enforces `targetTraitId == PermanentCollection.canonicalTargetOf(punkId)` — the RAREST uncollected, non-pending trait the Punk carries (ties → lowest bit index), read from a pinned `CARRIER_COUNTS` table (111 packed uint16 counts, verified against live PunksData by `test/RarityTableFork.t.sol` since PunksData has no per-trait count accessor). The caller passes the value as a VERIFIED EXPECTATION — `recordAcquisition` reverts `TargetNotCanonical` (and `Patron._validateTarget` mirrors it as `NotCanonicalTarget`) if it isn't the canonical bit, failing loud if the canonical target shifted between the caller's read and the tx rather than silently recording a different permanent trait. This removes caller discretion on BOTH `acceptBid` (owner) and `acceptListing` (finder), generalizing #22 from the single rarity-1 trait to every scarce trait. `RarityTableFork` also proves rarest-first saturates 111/111 (the greedy never strands a trait).**
7. **No Punk can leave `PunkVault` or `PermanentCollection`.** Neither has
   a path to call CryptoPunks market write functions. Asserted by
   bytecode-selector scans (re-run post-Proofs in `ProofMintForkTest::
   test_BytecodeContainsNoMarketWriteSelectors_PostProofs` so the added
   ERC721 mint surface for Proofs doesn't re-introduce any of them).
   The 112 ERC721 tokens (Title + 111 Proofs) themselves ARE freely
   transferable — the bytecode-scan invariant is about the *Punks*
   not having an exit path, not the role-of-record tokens.
8. **return auction proceeds split (cleared/rescue path) is enforced on-chain and constant — with an auction-referral slice carved from premium.** `bountyShareWei = cost × CLEARED_BID_BPS / 10_000` with `CLEARED_BID_BPS = 6_500` hard-coded → Patron (the full 65%; cleared settle pays NO protocol-funded keeper tip — it is self-incentivized by the winning bidder's locked ETH, mirroring the tipless vault path). `vaultBurnFromCost = cost × CLEARED_VAULT_BURN_BPS / 10_000` with `CLEARED_VAULT_BURN_BPS = 1_000` hard-coded → VaultBurnPool (on top of the premium). `burnShare = cost − bountyShareWei − vaultBurnFromCost` (residual; 25% of cost when the two BPS constants take their canonical values) → BuybackBurner. `premium = highBid − cost`; `referrerShare = referrerOfHighBid != address(0) ? premium × REFERRER_PREMIUM_BPS / 10_000 : 0` with `REFERRER_PREMIUM_BPS = 500` hard-coded → referrer (35k-gas budget; fail-closed). `vaultBurnShare = (premium − referrerShare) + vaultBurnFromCost` → VaultBurnPool. All percentages hard-coded — no setter, no bounds, no admin tunability. The cost constants are constrained at construction such that the per-cost split never leaks (asserted by `test_ClearedConstants_SumToBPSDENOM`). Reserve formula (`cost × (101 + previousTrials) / 100`) guarantees `highBid > cost` so `premium > 0` on every rescue. The referrer slot is `referrerOfHighBid[punkId]` — overwritten on each accepted `bid(punkId, referrer, tag)`, so outbid bidders' referrers lose attribution; the SLOT tracks the current high bidder's referrer only. Fail-closed in both directions: `referrer == address(0)` OR `referrer.call` reverts/OOGs → `referrerShare` folds back into `vaultBurnShare` BEFORE the VaultBurnPool transfer; settle never reverts on referrer failure. Auction referral pulls from FRESH EXTERNAL VALUE (the rescuer's voluntary overbid) — NEVER reduces `bountyShareWei` or `burnShare`. Vault-path (silenced) settle pays no auction referrer (no premium exists). Replaces the prior 70/30/premium split. (The older 50/50 `Patron.BURN_SHARE_BPS` constant and its `burnShareBps()`/`clearedBidShareBps()` mirror views were dead surface and have been removed.)
9. **Only `Patron` can call `recordAcquisition`. Only `returnAuctionModule` can call `markCustody`, `receivePunk`, or `mintProofs` on PunkVault. Only `titleAuction` can call `mintToAuction`.** No pluggable module surface.
    - PunkVault's two minter roles are immutable at construction and bytecode-enforced as disjoint by id range: `titleAuction` mints only token id 111 (the Title); `returnAuctionModule` mints only ids 0..110 (the Proofs, with `tokenId == traitId` directly). Both reject ids ≥ 112. Neither minter can reach the other's range.
10. **No admin withdrawal path from `Patron`.** Asserted by bytecode scan (no `withdraw`, `rescue`, `sweep`, `migrate`, `emergencyWithdraw` selectors). **Under inflow consolidation `contribute`/`poolReplenish` MOVED to `LiveBidAdapter`** — the `LaunchInvariantForkTest` bytecode scan now asserts those selectors are ABSENT on Patron and PRESENT on the adapter (which itself has no withdraw/rescue/migrate/drain path; its buffer exits only toward Patron via `sweep`). Patron's only outflows remain `acceptBid`/`acceptListing`.
11. **Parameter bounds are enforced in every setter.** Bounds cannot be escaped: `LiveBidAdapter.maxSweepWei ∈ [0.01, 5] ETH`, `minBlocksBetweenSweeps ∈ [1, 7200]` (the two throttled-mode rate-cap knobs — together they bound how fast the live bid grows once it is at/above the activation threshold; both lock at the 1y admin expiry, no carve-out), `activationThreshold ∈ [0, 100] ETH` (`ACTIVATION_THRESHOLD_LO = 0` / `ACTIVATION_THRESHOLD_HI = 100 ether`; the fast/throttled boundary — below it the buffer forwards uncapped, at/above it the rate cap applies; `setActivationThreshold` is the adapter's lone lifetime carve-out, `onlyAdminEvenIfLocked`, surviving the 1y lock); `BuybackBurner.minBlocksBetweenSteps ∈ [1, 50_400]`, `maxStepWei ∈ [0.01, 10] ETH`, `referenceDeviationBps ∈ [50, 5000]` (or 0 to disable). `BuybackBurner.maxSlippageBps = 5000` is a compile-time constant (defense-in-depth backstop, NOT tunable); `BuybackBurner.minTokensPerEthFloor` is immutable and ships **disabled (`0`)** (audit H-1: a static tokens-per-ETH floor bricks buy-and-burn as 111 appreciates, so the EMA gate — not the floor — is the slippage guard). **`Patron.finderFeeCapBps = 50` / `finderFeeFixedCap = 0.01 ETH` and `ReturnAuctionModule.minBidIncrementBps = 100` are now protocol constants — no setter, no bounds to escape** (frozen because each is a "keep incentives bounded" knob whose default is permanently sound; minBidIncrementBps is the audited M-1 value and freezing it removes any path — including a compromised admin key — to weaken it toward the old 0.5% floor). Removing those three setters left `ReturnAuctionModule` with no `ProtocolAdmin` reference at all (6-arg constructor) and left Patron with no `checkAdmin`-gated setter (only the raw-admin allowlist carve-out). Cleared-path split (`CLEARED_BID_BPS = 6_500`, `CLEARED_VAULT_BURN_BPS = 1_000`) and `ReturnAuctionModule.AUCTION_DURATION = 72h` / `SNIPE_EXTENSION = 1h` are constants, not setters.
12. **After `ProtocolAdmin` locks, no economic parameter changes accepted — with four scoped carve-outs.** All four remain editable past the 1y lock as long as the relevant admin EOA hasn't been burned via `transferAdmin(0)`. **The burn is the always-available off-switch:** `transferAdmin(address(0))` is reachable at any time, even after the timer lapses — only renewals/rotations (`newAdmin != 0`) are time-gated (auditor M-1) — so a post-lapse key compromise can always be neutralised by burning the role, permanently disabling every carve-out. The four carve-outs:
    - **Seller allowlist** (`Patron.addAllowedSeller` / `removeAllowedSeller`) — recognizing new aligned listing contracts (PunkStrategy-style yoyos) is a forever requirement.
    - **`LiveBidAdapter.setActivationThreshold`** — the fast/throttled boundary, bounded `[0, 100 ETH]`. Gated `onlyAdminEvenIfLocked` (raw `ProtocolAdmin.admin()` only — unlike the two TokenAdminPoker carve-outs below, this is single-key). An anomaly-correction valve: the threshold normally self-tracks the latest `acceptBid` clearing price (×0.75), so a manual write persists only until the next acceptBid re-syncs. Freezes when the admin role is burned. Rationale: the warm-up/throttle boundary tracks the live-bid regime over the protocol's lifetime; a manual override valve is worth keeping while the role is alive.
    - **`TokenAdminPoker.setHookMaxReferralBps`** — referral cap on the skim hook, bounded `[0, 1_000]` (1% of swap volume in 100k denom). Gated by EITHER `TokenAdminPoker.owner` OR `ProtocolAdmin.admin()` EOA — same "scoped raw-admin" pattern as the others. The cap freezes only when BOTH roles are burned. Rationale: referral economics track a market regime that shifts over the protocol's lifetime; freezing the launch value `250` permanently would be wrong.
    - **`TokenAdminPoker.setTokenTaxBps`** — venue-scoped transfer-tax rate on the 111 token, bounded `[0, taxBpsMax]` where `taxBpsMax = 2000` (20% cap; **launch rate 1500/15%**) and the token's own `TAX_BPS_ABSOLUTE_MAX = 2000` backstops it (NEVER above 20%). Two-key gate (`TokenAdminPoker.owner` OR `ProtocolAdmin.admin()` EOA), same as the referral cap; freezes only when BOTH roles are burned. Rationale: the tax rate tracks the side-pool-competition regime, which shifts over the protocol's lifetime; freezing the launch value `1500` permanently would be wrong.
13. **`address(patron).balance >= accountedLiveBidWei`; the live bid is `accountedLiveBidWei`, not the raw balance.** `bidBalance()` returns `accountedLiveBidWei` and `acceptBid`/`acceptListing` pay from it. A force-send (selfdestruct/coinbase) can only make the raw balance EXCEED the accounted bid, never underpay it; the surplus is excluded from the live bid and swept to `LiveBidAdapter` by `skimSurplus()`. **Under inflow consolidation, the accounted bid fills ONLY via `LiveBidAdapter`** — `receive()` reverts `NotAdapter` for every other sender, so the adapter is the single faucet. Every bid-funding source (fees, `contribute`, bare sends, the cleared rescue refund) enters the adapter's buffer and meters in via `sweep`; the buffer can only exit toward Patron (no withdrawal), so the accounted bid is still the all-in live bid, just filled through one metered governor.
14. **Token holders have no governance over the protocol.**
15. **Three-leg skim split is enforced at swap-time, not post-hoc.** The hook's `_processSkimAndAttribution` decomposes the baseline skim and assigns:
    - `bountyShare = baseline × bountyBps / 10_000` (claim-tokens to LiveBidAdapter)
    - `protocolShare = baseline − bountyShare` (to ProtocolFeePhaseAdapter, less any referral)
    - `antiSniperExtra` (when MEV module active) routes **100% to bid leg**
    - `referral ≤ min(volume × min(att.referralBps, maxReferralBpsOfVolume) / 100_000, protocolShare)`; paid from the first swap when the swap carries a valid referrer; never reduces bountyShare. `maxReferralBpsOfVolume` is **admin-tunable** within `[0, 1_000]` (hook hard-cap `MAX_REFERRAL_CAP_OF_VOLUME` — i.e. 1% of swap volume in 100k denom) via `TokenAdminPoker.setHookMaxReferralBps(newCap)`. **ProtocolAdmin carve-out:** callable by EITHER `TokenAdminPoker.owner` OR `ProtocolAdmin.admin()` EOA, so the cap stays tunable past the 1y admin timer AND past `TokenAdminPoker.transferOwnership(<dead>)`. Cap freezes only when BOTH roles are burned. PC launches the cap at `250` (0.25% of volume — matches the frontend default `MAX_REFERRAL_BPS_OF_VOLUME = 250` in `app/lib/swap/attribution.ts`).
    - **Intra-tx flush**: at the end of `_afterSwap` of the SAME swap, `_flushAccruedSkim` burns the swap's claim tokens, takes native ETH, and forwards every leg (including the credited referrer's accrual) to its recipient. The flush is fresh-only with no held/retry state: the bid leg reverts the swap on a failed forward (`BidForwardFailed`); the protocol leg deposits to the fee escrow; the referral leg folds to the protocol escrow on a failed `ReferralPayout` payout. The hook never holds a claim balance between swaps and has no retry escape hatches.
16. **`PCSwapContext.inSwap` is permanently `false` at launch.** `authorizedExtension == address(0)` at deploy; `enterSwap`/`exitSwap` revert `NotAuthorizedExtension` for any caller. Decorated PC functions (Patron, ReturnAuctionModule, BuybackBurner, LiveBidAdapter, VaultBurnPool, ProtocolFeePhaseAdapter, PunkVaultTitleAuction) are no-ops on the guard. Future Design B activation requires (a) `PCSwapContext.setAuthorizedExtension(dispatcher)`, (b) artcoins allowlist add, (c) `TokenAdminPoker.bindExtension(dispatcher)`. Each step is independently gated; `lockExtension` + `lockAuthorizedExtension` make the binding permanent.
17. **Referral path is fail-closed.** The referral leg pays from the first swap when the swap carries a valid referrer, but a failed payout never costs the protocol or reverts the swap: a reverting/OOG `ReferralPayout.notify` recipient folds the slice back to the protocol escrow (the swap proceeds). ReferralPayout's `notify` is hook-only; stray `receive()` ETH is NOT credited; `_claim` reinstates balance on failed send.

18. **Direct contribution split (`LiveBidAdapter.contribute`) is hard-coded and fail-closed in both directions.** **Inflow consolidation moved `contribute` from Patron to `LiveBidAdapter`.** `contribute(address referrer, bytes32 tag)` is the canonical attribution-bearing top-up surface; the remainder now buffers in the adapter and meters into the live bid via `sweep` (rather than landing in Patron directly). `msg.value == 0` reverts `ZeroValue()`. With `referrer != address(0)`: `referrerShare = msg.value × REFERRER_CONTRIB_BPS / 10_000` with `REFERRER_CONTRIB_BPS = 500` hard-coded → referrer (35k-gas budget; on revert/OOG `referrerShare` resets to 0 and the full `msg.value` stays buffered — accurate accounting because the failed send did not move ETH). With `referrer == address(0)`: 100% buffered. No admin setter on the bps; no future-tunability. `nonReentrant` + `notInSwap` decorated. Emits `Contribution(contributor, amount, referrer, tag, referrerShare)`; unattributed bare top-ups to the adapter's `receive()` emit `BareTopUp(sender, amount)` (skipped when `msg.sender == feeLocker`, since fee-escrow claims are accounted for by `Swept`). Primary integration target is NFT-launchpad "Route X% of mint to Permanent Collection" checkboxes — the function is the Schelling-point on-chain destination for capital flows that want to align with Punks preservation.

19. **Proof NFTs (token ids 0..110 on PunkVault) mint iff and only if a trait is *first-vaulted*.** `ReturnAuctionModule.settle` snapshots `collectedMask` before `markCustody(Vaulted)`; the Proof mint fires only when `(maskBeforeSettle & targetBit) == 0`. This gate is independent of the recorded-target-only collection rule (#6) — the protocol's in-flight-per-trait invariant (#9 / `TargetTraitAlreadyPending`) already prevents two acquisitions from racing for the same target, but the `firstVaultingOfTrait` check inside settle is defense in depth against any future surface that could bypass that invariant. Cleared return auctions never mint a Proof. Already-collected-trait vaultings never mint a Proof. **The mint is atomic with the vaulting** — `settle` calls `mintProofs` directly (no `try/catch`), so any mint failure reverts the ENTIRE settle (the vaulting, the custody transition, and the early `settled` flag all roll back, leaving the auction settleable/retryable); a permanently-collected trait can therefore never exist without its one Proof. The cap stays at 111 forever.
    - Proof recipient is `PermanentCollection.originalSellerOf(punkId)`, the address recorded on the acquisition at `recordAcquisition` time:
      - `acceptBid`: lister/owner (== `acquirer`)
      - `acceptListing`: public-listing seller (NOT the caller / finder)
    - `recordAcquisition` enforces `originalSeller != address(0)`. PunkVault rejects zero recipients. The mint uses `_mint` (no `onERC721Received` callback) so a non-receiver-aware contract recipient cannot strand the Proof — and, because there is no recipient callback, the recipient cannot grief the mint to block a Punk's settlement. `ReturnAuctionModule.settle` calls `mintProofs` directly (NO `try/catch`): the mint is required, so a failure reverts the whole settle and everything rolls back (retryable) rather than silently vaulting the Punk without its Proof. This is safe because the required mint has no reachable revert for a legitimate first-vaulting: the recipient is structurally non-zero (above) and the token id (`== traitId`) is structurally fresh. The zero-recipient case is delegated to `mintProofs`' own `InvalidRecipient` revert (not silently skipped) so the atomic invariant has no escape hatch.
18. **The fork tests in `LaunchInvariantForkTest.t.sol` exercise every permanence-critical invariant adversarially against the live-deployed `Deploy.s.sol` bytecode**, plus **16 `PCDispatcherSmokeTest` mock-based tests** for the dispatcher mechanic. Coverage: PCSwapContext lockdown (4 angles), every decorated PC entry point's `notInSwap` reentry guard, the `nonReentrant` keeper-reward reentry path on `LiveBidAdapter.sweep` (the permissionless fund-mover paying an attacker-controllable keeper reward — audit L-1), chained reentry, sell-direction skim, 3-leg split (baseline ~83.33/16.67 + MEV-window + sell), attribution decode tolerance (malformed bytes, valid outer/invalid inner, fully valid), pre/post-acquisition referral gate, multi-referrer accrual independence, referral-cap clamping, dispatcher MAX_CALLBACKS + OnlyHook, extension lock + non-allowlisted rejection, hook unlockCallback auth, PunkVault + Patron + LiveBidAdapter bytecode scans (post-inflow-consolidation: `contribute`/`poolReplenish` selectors ABSENT on Patron, PRESENT on the adapter; adapter has no withdraw/rescue/migrate/drain), Patron adapter-only `receive()` gate + direct-send rejection, Patron `nonReentrant` against malicious-seller `receive()`, ReferralPayout reverting recipient + stray-ETH unclaimability, acceptBid priced-listing path (exclusive-only listing + accepts a below-bid listing + overpay-cap + permissionless finalize, seller paid via market `withdraw()`), ReturnAuction cleared-path E2E (asserts 65/25/10 + premium split) + acceptListing E2E + vault-path + bid validation + anti-snipe, auction-referral path (`test_fork_referral_auction_*` — premium-only carve, fail-closed referrer, slot-overwrite semantics, vault-path pays no referrer), contribution-referral path on the adapter (`test_fork_referral_contribute_*` — 5% slice, fail-closed, zero-value revert, remainder buffered), BuybackBurner pacing, 1y admin auto-lock + carve-out, allowlist 24h activation delay, hook held-skim retry. `PCDispatcherSmokeTest` covers: 7 constructor bound rules, register/eviction/fee validation, gas-budget bounds, dispatch loop + failure-counter auto-disable, reenable mechanic, ERC-165. Run with `MAINNET_RPC_URL=https://gateway.tenderly.co/public/mainnet forge test --match-contract LaunchInvariantForkTest -vv` and `forge test --match-contract PCDispatcherSmokeTest -vv`.

20. **`PunkVault.owner()` is a one-way ratchet with no on-chain authority.** The slot exists solely so OpenSea / Blur / Magic Eden recognize a wallet for the marketplace collection-page editor UI (banner image, profile image, description override, social links). Initialized to the deployer EOA in the constructor; `renounceOwnership()` sets it to `address(0)` forever. There is intentionally NO `transferOwnership` — once renounced, no key compromise can re-acquire the editor surface. The slot does NOT gate any vault function, does NOT touch the Punks, does NOT control the on-chain `tokenURI` / `contractURI` content (which comes from `RendererRegistry`), and does NOT affect any other PC contract. Bytecode-scan asserts the vault contains `owner()` + `renounceOwnership()` AND NOT `transferOwnership` / `acceptOwnership` / `pendingOwner` / any rescue / migration / withdrawal selector. Expected post-launch op: deploy → set up OpenSea collection page from deployer wallet → `vault.renounceOwnership()`.
21. **Venue-scoped buy-side transfer tax fires ONLY on 111 leaving a known venue to a non-exempt recipient; the canonical pool is exempted by an amount-pinned hook-attested budget.** The tax (`ArtCoinsToken`, default-off shared infra, enabled only for 111) is charged in the token's `transfer`/`transferFrom` override when `taxEnabled && taxBps != 0 && _isTaxVenue(from) && !exempt[to]` and the canonical-exemption budget doesn't cover the amount. It NEVER fires on 111 entering a venue (sells / LP seeding — would revert the pool), on wallet/Safe/4337 sends, or on lending/bridge/CEX transfers (`from` isn't a venue). Proceeds accrue in `VaultBurnPool` (the token's tax `burnAddress`) and are burned there — a real `token.burn` that drops totalSupply — on each vault-path settle, in the same `sweep` that forwards the ETH leg, so the side-pool tax burn fires when the protocol permanently collects a Punk; never converted to ETH (no sell pressure) and never LP'd. Venue set = the V4 PoolManager singleton (covers ALL V4 pools) + 44 CREATE2-derived V2/V3 pool addresses computed from `address(this)` in the constructor, **frozen at deploy** (no add path): {Uniswap V2, SushiSwap V2, PancakeSwap V2} × {WETH, USDC, USDT, DAI} (12) plus {Uniswap V3, PancakeSwap V3} × {WETH, USDC, USDT, DAI} × 4 fee tiers (32). PancakeSwap V3 pools are CREATE2-deployed by its separate PoolDeployer (not the factory) and its 0.25% tier is 2500 (Uniswap's is 3000) — both handled in the derivation. Every derived address is reproduced against the live factory in `test/TaxedTokenForkTest.t.sol::test_precomputedVenues_allMatchLiveFactories`. The enumeration covers the LIQUID side-pool space (the AMM pools a side venue could realistically attract depth on); it cannot cover wrapper/OTC/CEX distribution, which is an inherent ceiling of any from-side venue tax — the depth moat, not the tax, is the primary defense. Canonical exemption: the hook calls `attestCanonicalBudget(poolId, pctOut)` in `_afterSwap` (buys) and `_afterRemoveLiquidity` (public LP exits) — gated to `msg.sender == canonicalHook` AND `poolId == canonicalPoolId` (defense-in-depth: side / `initializePoolOpen` pools earn no budget). The budget lives in EIP-1153 transient storage — amount-pinned (NOT boolean), accumulates within a tx, auto-clears at tx end. It is **fungible within the tx**: it CAN subsidize a same-tx side-pool buy, but only up to the realized canonical 111-out (bounded, not self-defeating). The subsidy only benefits a buyer already concentrating real volume on canonical (the behavior the tax encourages), and a side / `initializePoolOpen` pool can never *earn* budget, so burned tax proceeds are never a bid-funding source. Rate `taxBps` is bounded `[0, taxBpsMax=2000]` (20% cap; **launch 1500/15%**); the token's `TAX_BPS_ABSOLUTE_MAX=2000` makes "never above 20%" structural. Exempt allowlist (`to` side) = BuybackBurner, conversion locker (the PC contracts that receive 111 from the PoolManager). The bid is fed INDIRECTLY by the routing shift onto canonical (whose hook skims ETH), not by the burned proceeds. Design rationale: `docs/TRANSFER_TAX_INVESTIGATION.md`. Covered by `test/TaxedTokenForkTest.t.sol`.

22. **The sole carrier of a rarity-1 trait can never be wasted on a common trait — the unique forced edge in the 111/111 matching is protected.** **(2026-06-03: now SUBSUMED and GENERALIZED by the protocol-derived canonical target — see #6. `canonicalTargetOf` always returns the rarest uncollected trait a Punk carries, which for #8348 is bit 23 (rarity-1) whenever uncollected — so this dedicated guard is now redundant defense-in-depth, and the canonical-target rule extends the SAME no-waste protection to EVERY scarce trait, not just bit 23. The guard below is kept because it is audited and gives a specific early revert; it fires BEFORE the canonical check in both `recordAcquisition` and `Patron._validateTarget`, so its `SoleCarrierMustTargetTrait` revert still surfaces for a #8348 mis-target.)** In the sealed PunksData dataset (pinned by `EXPECTED_DATASET_HASH`) exactly one trait is rarity-1: bit 23 `"7 Attributes"`, carried by exactly one Punk — #8348 (verified live, the unique forced edge in the trait→Punk bipartite matching; no Punk anywhere is the sole carrier of ≥2 traits). Because the vault is terminal (#7), a Punk is acquirable once (`AlreadyRecorded`), and `markCustody(Vaulted)` collects ONLY the recorded target (#6), a single silenced vaulting of #8348 against any of its 9 common traits would strand bit 23 forever, capping `collectedMask` at 110/111 and making `isComplete()` unreachable (mission-fatal finding MF-1; mission properties R1/R3/R5). `PermanentCollection.recordAcquisition` — the single chokepoint both `acceptBid` and `acceptListing` flow through — enforces the guard: **while `SOLE_CARRIER_TRAIT_BIT` (23) is uncollected, an acquisition of `SOLE_CARRIER_PUNK_ID` (#8348) MUST record `targetTraitId == 23`, else it reverts `SoleCarrierMustTargetTrait`.** The guard is self-disabling (once bit 23 is collected #8348 is already vaulted; never fires for any other Punk) and preserves invariant #6 (still one target per vault, still target-only collection) and the artistic "one deliberate choice per vaulting" — it only removes the ability to *waste* the unique carrier. `Patron.acceptBid` / `acceptListing` mirror the check (internal constants) for an early/cheap revert before `buyPunk`; `PermanentCollection` is authoritative. The pair is a single pinned immutable constant (not an array) because the sealed dataset has, and can only ever have, exactly one sole-carrier pair — re-verified live by `SoleCarrierGuardForkTest` (uniqueness scan + 111/111 matching saturation under the forced edge). The dataset-derived `(bit 23, #8348)` constants and the `soleCarrierConstraint(punkId)` view are public on `PermanentCollection`. Mission rationale: `docs/MISSION_PROPERTIES.md`. Covered by `test/SoleCarrierGuard.t.sol`.

23. **At most one in-flight acquisition per trait: `pendingTraitCount[t] ∈ {0,1}`.** The `TargetTraitAlreadyPending` guard rejects a second acquisition targeting a trait already in flight, so every vault-path settle is the FIRST vaulting of its target. This keeps `popcount(collectedMask) == #vaulted == #Proofs` in lockstep and makes the redundant-vaulting branch in `ReturnAuctionModule.settle` unreachable.
24. **Reserve strictly exceeds cost: `reserve = ⌈cost × (101 + previousTrials) / 100⌉ > cost`.** The ceil-div guarantees the rescue premium `highBid − cost` is strictly positive on every cleared settle, so the cleared-path split (#8) never underflows.
25. **Each cleared settle distributes exactly `highBid`.** The cost split (`CLEARED_BID_BPS` bid + residual burn + `CLEARED_VAULT_BURN_BPS` vault-burn) plus the premium split (referrer + vault-burn) sum to `highBid`; the `ReturnAuctionEscrow` round-trip nets zero and the module never spends another sale's ETH.
26. **`canonicalTargetOf` returns an uncollected, non-pending, in-mask trait, or reverts `NoEligibleTarget`.** A recorded target is therefore always collectible, so the sole-carrier guard (#22) can never contradict the canonical-target rule (#6).

## Important non-obvious facts

- **CryptoPunks is not ERC721.** Use `transferPunk(to, id)`, `buyPunk(id)`,
  `offerPunkForSale(id, price)`, `offerPunkForSaleToAddress(id, price, to)`
  on the market. `vm.prank(currentOwner); transferPunk(...)` works for any
  Punk in tests.
- **`acceptBid` requires the owner to list exclusively to Patron at a real
  positive price ≤ the live bid (never 0).** Three steps from the seller's side: (a) owner:
  `offerPunkForSaleToAddress(punkId, listingWei, patron)` with `listingWei`
  ≤ `bidBalance()` (the frontend uses the full bid; there is no reserve floor),
  (b) anyone: `patron.acceptBid(punkId, targetTraitId, expectedListingWei)`
  (permissionless — target is protocol-derived, no front-run surface),
  (c) seller: `market.withdraw()` to collect the listed price from the market.
  Frontend can bundle (a)+(b) via Multicall3 / EIP-5792.
- **`buyPunk` proceeds queue in `pendingWithdrawals[seller]`** on the 2017
  market, not transferred directly. The seller (PunkStrategy's contract, or the
  acceptBid lister) has to call `withdraw()` to claim — this is how the
  acceptBid seller is paid (the market, not a Patron push). Affects how tests
  verify payment.
- **Artcoins V3 pools support native-ETH pairing.** 111 launches as a
  native-ETH-paired pool (`pairedToken: address(0)`). LiveBidAdapter and
  LiveBidAdapter has no WETH plumbing — it claims native ETH from the
  V3 escrow's `address(0)` token slot and forward directly. BuybackBurner
  swaps 111/ETH inside its unlock callback via `settle{value:}` — no
  WETH wrap. Patron stays native-ETH so it can call `buyPunk{value:}`.
- **Fee split lives in the hook, not in the locker reward distribution.**
  `ARTCOINS_PROTOCOL_BPS = 0` — no factory-injected artcoins protocol
  slot. The single locker reward slot (10_000 bps) goes to LiveBidAdapter
  with admin = `0xdEaD`. The actual 3-leg split happens at swap-time
  inside `ArtCoinsHookSkimFee._afterSwap` via the
  `bountyBps`/`maxReferralBpsOfVolume` config keys read
  from `SkimHookFeeData` at `initializePool`. Configured in
  `Deploy.s.sol._buildFactoryConfig` (`bountyBps = 8_333`,
  `maxReferralBpsOfVolume = 250` — 0.25% of swap
  volume, matches the frontend default in `attribution.ts`. Tunable up
  to `1_000` (1% of volume) via the `TokenAdminPoker.setHookMaxReferralBps`
  carve-out, callable by EITHER TokenAdminPoker.owner OR ProtocolAdmin
  admin EOA so the cap survives either role being burned).
- **HookData encoding is a 1-tuple struct, not a 2-tuple of bytes.** The
  hook decodes `swapData` as `abi.decode(swapData, (PoolSwapData))` — a
  single struct. Callers MUST encode as `abi.encode(psd)` where `psd` is
  a `PoolSwapData` struct. Encoding as `abi.encode(bytes(""), inner)`
  (a 2-tuple) is off by a 32-byte outer-offset prefix and the hook
  silently fails to decode (treated as empty attribution). This bit a
  test helper during fork-test development; document it for any swap
  router / frontend integration.
- **Factory call reverts with `Deprecated()` on mainnet.** Test fixtures
  impersonate the factory owner (`0xCB43…17F9`) via `vm.prank` and call
  `setDeprecated(false)` in `_launchPool`. Production deploy requires the
  owner to toggle it back to active first.
- **LP positions for token1 art coins**: the factory negates positions
  internally. We use LAYER's exact negative tick values verbatim.
- **PunkVault and ReturnAuctionModule have a circular constructor dependency.**
  Vault references ReturnAuctionModule immutably; ReturnAuctionModule references
  Vault. Resolved by precomputing the ReturnAuctionModule's CREATE address via
  `vm.getNonce` + `vm.computeCreateAddress`, deploying Vault first, then
  ReturnAuctionModule, asserting addresses match. Pattern used in `Deploy.s.sol`
  and `ForkFixtures.sol`.
- **Allowlist carve-out**: `Patron.addAllowedSeller` / `.removeAllowedSeller`
  check `msg.sender == adminContract.admin()` directly — bypassing the
  `checkAdmin()` timer check. So allowlist edits work past the 1y lock as
  long as the admin EOA hasn't been burned via `transferAdmin(address(0))`.
- **Referral-cap carve-out**: `TokenAdminPoker.setHookMaxReferralBps`
  uses a two-key gate (`msg.sender == owner || msg.sender == adminContract.admin()`),
  so EITHER role can tune the cap. Cap freezes only when BOTH roles are
  burned. Pattern is symmetric with the other three carve-outs but with
  one extra "alive" path because TokenAdminPoker.owner is independent
  from ProtocolAdmin.admin.
- **Default-referrer fallback in the frontends (runtime-tunable)**:
  - PC's `useReferrer` (`app/lib/swap/useReferrer.ts`) fetches
    `/api/config` (`app/app/api/config/route.ts`) on mount. The route
    reads server-only env var `DEFAULT_REFERRER`. Operator changes the
    fallback by updating the env var on the hosting platform — NO
    frontend rebuild needed. Edge-cached for 60s + 5min SWR.
  - Artcoins UI's `useReferrer`
    (`new-material-coin-launcher/ui/src/lib/useReferrer.ts`) fetches
    `/config.json` (`ui/public/config.json`) on mount. Operator edits +
    re-uploads the static JSON to swap the default — NO rebuild.
  - Both: fallback is async, so a swap fired in the first ~300ms before
    the fetch resolves uses URL/localStorage only. The credit is
    silently skipped only when the swap carries no valid referrer /
    attribution.
- **0xSplits requires ≥2 accounts in `createSplit`**, so the creator slot is
  the raw EOA. To add a splitter post-launch:
  `locker.updateRewardRecipient(1, splitter)` from slot 1's admin.

## Stack & layout

```
contracts/                Foundry, solc 0.8.26, evm_version cancun
  src/                    V4 + three-leg-skim contracts:
                            core:        PermanentCollection, PunkVault, Patron,
                                         ReturnAuctionModule, ReturnAuctionEscrow,
                                         BuybackBurner, ProtocolAdmin
                            fees:        LiveBidAdapter,
                                         VaultBurnPool, ProtocolFeePhaseAdapter,
                                         ReferralPayout,
                                         TokenAdminPoker
                            composability: PCSwapContext, libraries/PCNoReentry,
                                           PCDispatcher (production
                                           permissionless Design B
                                           dispatcher — verified-ready,
                                           NOT bound at launch)
                            render:      PermanentCollectionMosaicRenderer,
                                         PermanentCollectionProofRenderer,
                                         PunkSvgFragmentCache, TraitIconCache,
                                         RendererRegistry, PunkVaultTitleAuction
                            demos/:      UnipegDispatcher, UnipegArt
                                         (worked examples; NOT the
                                         production platform)
                          + libraries/  (OneTimeSetup, BaseHook, PCNoReentry)
                          + interfaces/ (ABI interfaces, incl.
                                         IArtcoinsPoolExtension, IPCSwapContext,
                                         IReferralPayout, IPCCallbackExtension
                                         — canonical builder interface)
                          MetadataPoker / PCFeeRouter linger as deprecated
                            files but are NOT used by the current Deploy.
  test/                   Mainnet-fork tests, ~570 tests across ~68 suites
                          (run `forge test --list` for current count).
                          Public-RPC friendly — no archive node required.
                          Headline suites: `LaunchInvariantForkTest`
                          (adversarial tests probing every
                          permanence-critical invariant against the
                          live-deployed Deploy.s.sol bytecode);
                          `PCDispatcherSmokeTest` (16 mock-based tests
                          covering the dispatcher mechanic).
    helpers/              ForkFixtures (legacy), SkimForkFixture
                          (current — drives Deploy.s.sol), PunkSeeder,
                          HookMiner, TestSwapHelper.
  script/                 Deploy.s.sol — full token + pool + permanent
                          stack in one broadcast, reads CONVERSION_LOCKER
                          + PC_CONTROLLER env vars.
  lib/                    forge-std, v4-core, v4-periphery, openzeppelin,
                          solady, artcoins (submodule).

app/                      Next.js 15 (App Router) frontend. Wired to the
                          current three-leg fee path (bid + protocol +
                          referral-from-protocol).
                          NOT YET reviewed against PCSwapContext +
                          ReferralPayout. /builders page added with
                          docs about the Design B extension pattern.
                          Referral attribution IS wired: useReferrer
                          reads ?ref=0x... from URL → SwapBox encodes
                          via encodeAttributionHookData → V4 hookData;
                          /referrals surfaces the claim. Indexer side
                          shipped via #24 (referral-indexer). Browser
                          RPC reads route through the same-origin
                          `/api/rpc` proxy (server-only RPC_URL +
                          public fallbacks + per-IP rate limit) so
                          paid Alchemy/Infura keys never ship in the
                          client bundle. Known gap: acceptBid is two
                          sequential txs (no Multicall3 bundling).
                          /homage section (mint + explore + redeem +
                          calculator) is the ported "Homage to the Punk"
                          frontend — the site's main minting UX. Pages in
                          app/app/homage/ (own scoped Tailwind-v4 sheet,
                          homage.css — the ONLY Tailwind entry in the
                          app), libs in app/lib/homage/, components in
                          app/components/homage/. Gated on
                          NEXT_PUBLIC_HOMAGE_ADDRESS (+ PC_* runtime
                          twin): unset ⇒ local explore preview only
                          (zero-RPC punks-sdk rendering); set ⇒ full
                          mint/claim/claimFor/allowlist/redeem. Quote
                          pool key is read from the Homage contract's
                          own immutables (fallback: PC's canonical 111
                          pool). Owned-homages scan chunks getLogs to
                          ≤5000 blocks (proxy rule); follow-up: index
                          Homage in pc-ponder and swap the seam to one
                          API fetch.

scripts/                  TS pipeline tools, viem-based.
  snapshot-punksdata.ts            Multicalls 111 trait names + 10,000 masks → TS
  generate-abis.ts                 forge build → app/src/lib/abis/
  seed-fork.ts                     Lists Punks for sale on a local fork
  find-cryptopunks-floor.ts        Floor finder

docs/SYSTEM.md            Canonical reader-facing system overview (start here).
docs/PROTOCOL.md          Protocol spec — three-leg hook (bid + protocol +
                          referral-from-protocol), cleared-path 65/25/10
                          split, and the trait state machine.
docs/SECURITY.md          Trust model, reentrancy posture, permanent surface.
docs/COMPOSABILITY.md     Builder spec — Design A (referral attribution) +
                          Design B (PCSwapContext + PCDispatcher pattern).
docs/DISPATCHER_DESIGN.md PCDispatcher mechanic spec (Design B; not bound
                          at launch).
docs/METADATA_REFERENCE.md  On-chain metadata (ERC20 + ERC721) routing.
docs/TRANSFER_TAX_INVESTIGATION.md  Venue-scoped transfer-tax rationale.
docs/MISSION_PROPERTIES.md  Mission / liveness / equilibrium properties.
docs/RENDERER_CACHE.md    Trait-icon cache operating model.
docs/ARTCOINS_PIN.md      artcoins submodule pin + how to verify it.
docs/RUN_LOCAL.md         Local fork bring-up + walkthrough.
docs/reference/           GENERATED per-contract API reference (functions,
                          events, errors, access control) + guides, served
                          on the site at /docs. Edit _prose/ + _pages/ and
                          run `pnpm generate:docs` — never the output pages
                          (see docs/reference/README.md; prose format in
                          docs/reference/_prose/SPEC.md). The generator also
                          emits app/lib/docs/{manifest,content}.json and
                          app/public/{abis/,protocol-manifest.json,llms.txt,
                          docs-search-index.json}.
README.md, DESCRIPTION.md  Public-facing copy.
```

## Test invariants

- **All tests run against a mainnet fork.** No mocks. Fixture uses
  `MAINNET_RPC_URL` if set, else falls back to `ethereum.publicnode.com`.
- **Foundry tests must run from `contracts/`** (where `foundry.toml` lives).
- **The fixture impersonates the artcoins factory owner** to undeprecate
  before each `_launchPool`. That's testing-only; mainnet operator must
  toggle it themselves.
- **All tests pass on public RPC.** No pinned-block tests in V4 — the
  comparable-rule + DeployerProfit suites that needed an archive RPC were
  deleted with V3.1. Run `forge test --list` for the current count.
- **Invariant suite** lives in `test/Invariants.t.sol` — exercises the four
  hard invariants (monotonic `collectedMask`, append-only `Acquisition[]`,
  `pendingTraitCount` accounting, `address(patron).balance >= accountedLiveBidWei`).
  Tuned conservative in `foundry.toml` (`runs=16, depth=20`); bump locally
  for a pre-mainnet rigor pass.
- **Fuzz tests** in `test/Fuzz.t.sol` cover the reserve formula, finder fee
  calculation (against the now-constant caps), and slippage floor. The
  finder-fee setter-bounds fuzz tests were removed when `finderFeeCapBps` /
  `finderFeeFixedCap` became protocol constants.

## Concurrent builds (many worktrees, one machine)

Dozens of worktrees share one 16-core / 128 GB box and multiple agent
sessions compile at once. `forge build` / `forge test` with no `-j` defaults
to **one solc thread per core (16 parallel solc)**, and on the big via-IR
contracts (the renderers) each solc process has a large transient memory
spike. Two uncapped cold builds at once oversubscribe the cores and stack
those spikes until solc is killed mid-compile, which forge then misreports as
a wall of bogus parser errors ("256 errors", "file not found", random
failures on files you never touched). Warm incremental builds (~1s once the
cache is hot) are cheap and safe to run concurrently; the danger is
concurrent **cold** builds.

Rules:

- **Always cap threads: `forge build -j 4` / `forge test ... -j 4`.** Never run
  an uncapped (default-16-thread) build. `-j 4` cuts each build's CPU and peak
  memory roughly 4x, so a few builds coexist safely on the 16-core box.
- **Warm each worktree's cache once; after that incrementals are ~1s.** Only a
  worktree's first cold build is heavy. Before starting a cold build, check
  nothing else is mid-compile (`pgrep -fl "forge build"`). Fresh worktrees also
  need their submodule libs populated before they compile at all
  (`git submodule update --init --recursive --checkout contracts/lib/artcoins`).
- **Don't build speculatively.** Frontend / docs / indexer / script-only work
  needs no `forge build`. Compile only after changing Solidity, and prefer a
  scoped `forge test --match-contract X -j 4` over a full build.
- **A wall of solc errors on code you did not change is almost always a
  concurrent build, not your bug.** Retry alone with `-j 4` before chasing a
  phantom compile error.

## Critical operational rules

- **Fresh worktrees / clones don't auto-checkout the artcoins submodule.**
  `contracts/lib/artcoins` is pinned `update = none` (so the app-only
  Netlify build, which can't reach the submodule, skips it cleanly), which
  means a plain `git submodule update --init --recursive` SKIPS it. Pass
  `--checkout` to populate it before compiling the contracts:
  `git submodule update --init --recursive --checkout contracts/lib/artcoins`.
- **No forge job runs in CI.** GitHub Actions builds only `app/` + the
  Playwright e2e (which compiles `Deploy.s.sol` but NOT the
  `contracts/test/` tree), because the via-IR forge build peaks at ~13 GB
  RSS and OOMs the default runner. So a forge compile/test break can reach
  `master` green — always run the full forge suite locally
  (`cd contracts && forge test -j 4`) after any Solidity change, and
  especially after any artcoins-pin bump.
- **Never curl image/binary endpoints into conversation** — corrupts context
  permanently. Save to file or check status only:
  `curl -s -o /dev/null -w "%{http_code}" URL`.
- **Never clear caches without explicit user approval.**
- **Don't add abstractions speculatively.** This protocol's value is in its
  immutability. Every added function is another thing that has to be
  permanent.
- **V4 has four persistent admin carve-outs** past the 1y lock: the
  seller allowlist, `LiveBidAdapter.setActivationThreshold`,
  `TokenAdminPoker.setHookMaxReferralBps`, and
  `TokenAdminPoker.setTokenTaxBps`. Each is bounded so the admin
  power is confined to a defensible range (allowlist additions only;
  `[0, 100]` ETH for the activation threshold; `[0, 1_000]` bps of swap
  volume for the referral cap; `[0, 2_000]` bps for the transfer tax —
  never above the 20% cap, launch 15%). The pattern is
  "tracks a market regime that shifts over the protocol's lifetime,
  where freezing the launch-time value would be wrong." Other surfaces
  are designed to freeze — don't propose new carve-outs.
  (`setActivationThreshold` is `onlyAdminEvenIfLocked` single-key on
  `ProtocolAdmin.admin()` and re-opens audit M-1/L-2, both knowingly
  accepted; its `maxSweepWei`/`minBlocksBetweenSweeps` rate-cap siblings
  stay checkAdmin-gated and lock at 1y, NO carve-out. One former carve-out
  stays removed: `LiveBidAdapter.setPolDeployTarget`, deleted with the POL
  subsystem.)

## Language — keep public copy mechanically precise

This applies to the site, docs, metadata, labels, contract comments,
generated descriptions, and any public-facing text.

Keep language mechanically precise. Avoid investment framing, avoid dramatic
finality, avoid deprecated terms (bounty, final sale, trial, rescue, hunter,
locked away, gone forever, captured, buyback as promotional copy, yield,
profit, floor support, etc.). Use the approved core terms: live bid, return
auction, accepted Punk, eligible Punk, vaulted, permanent trait, official
pool, Vault Title.

Copy is **not** a source of technical parameters. Durations, fees, fee
splits, thresholds, addresses, token symbols, pool config, payout routing,
and any other live value must come from the codebase, app config, indexed
protocol data, or chain reads. When user-facing language and a deployed
contract identifier (a function name, an event topic, an error name)
conflict, keep the contract identifier verbatim in code samples and align
the prose, not the ABI.

## Doc maintenance — keep these current with any architectural change

When you change the protocol's architecture (a fee plumbing tweak, a new
permanent contract, a Design B activation, an admin power change, an
invariant rewrite), update the following docs **in the same commit** as
the code change. If a change wouldn't show up in any of these, it's
probably not material enough to be architectural:

1. **`docs/SYSTEM.md`** — the canonical reader-facing system overview.
   Numbers, invariants, contract table, doc index.
2. **`AGENTS.md`** (this file; `CLAUDE.md` is a symlink to it) —
   AI-agent-context twin of SYSTEM.md.
3. **`docs/PROTOCOL.md`** — protocol spec; updates to any economic
   parameter, invariant, or state-machine transition.
4. **`docs/SECURITY.md`** — trust boundaries; reentrancy posture; new
   permanent surface.
5. **`docs/COMPOSABILITY.md`** — builder-facing spec; update on changes to
   the attribution path, referral semantics, or Design B surface.
6. **`docs/DISPATCHER_DESIGN.md`** — mechanic spec for `PCDispatcher`;
   update on any change to constructor parameters, dispatch semantics,
   threat model, or test coverage map.
7. **`docs/METADATA_REFERENCE.md`** — on-chain metadata routing; update on
   any tokenURI / contractURI / renderer-registry change.
8. **`docs/TRANSFER_TAX_INVESTIGATION.md`** — transfer-tax design
   rationale; update on any venue-set, exemption, or rate-bound change.
9. **`README.md` / `DESCRIPTION.md`** — public-facing copy. Numbers and
   fee mechanism must match SYSTEM.md.

The remaining docs (`MISSION_PROPERTIES.md`, `RENDERER_CACHE.md`,
`ARTCOINS_PIN.md`, `RUN_LOCAL.md`) are reference docs — update
them when the surface they describe changes.

If a doc no longer has a unique purpose (its content is fully absorbed
elsewhere), DELETE it rather than letting it drift. The current trimmed
set is the one indexed in `docs/SYSTEM.md` — that's the maintained
surface.

Operational runbooks, audit records, design specs, and historical reference
docs live under `docs/internal/` (see `docs/internal/README.md`). That folder
is kept in the private working repo ONLY — the public mirror strips it from
the published snapshot — so put process-flavored or operational docs there,
not in `docs/`.

The public mirror also strips (kept private-only, via `PRIVATE_PATHS` in
`.github/workflows/mirror.yml`): `contracts/future/` (the not-yet-bound
Design B `PCDispatcher` + its tests), the off-chain keeper bot (`keeper/`,
`scripts/keeper.ts`, `.github/workflows/keeper.yml`, `docs/KEEPER.md`), and
`docs/internal/`. They stay in this private repo; they're just absent from the
public repo. The ON-CHAIN keeper-reward mechanism (the permissionless `sweep()`
/ `executeStep()` reward in the contracts) is unrelated protocol design and
stays public.
