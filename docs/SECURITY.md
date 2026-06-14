# Security (V4 + hook redesign)

> This document covers the V4 protocol PLUS the three-leg hook redesign,
> `PCSwapContext` + decorations, `ReferralPayout`, and the Design B
> (UnipegDispatcher) pattern. The pattern is preserved in the deploy but
> NOT bound at launch — `pcSwapContext.authorizedExtension == address(0)`
> and the pool's extension slot is empty.

> ✅ **2026-06-07 — contracts APPROVED FOR LAUNCH (owner sign-off).** The owner
> has approved the full immutable contract surface for the mainnet broadcast,
> based on the internal 5-auditor adversarial re-audit (0 Critical / High /
> Medium) plus the owner's own review; an external professional audit was
> considered and WAIVED. The "new permanent surface — needs a fresh focused
> audit before broadcast" notes in this document **no longer gate the
> broadcast** — they are retained as reference.



## Assumptions

1. **CryptoPunks are not ERC721.** Ownership flows through the original 2017
   market contract via `transferPunk`, `buyPunk`, `offerPunkForSale`, and
   `offerPunkForSaleToAddress`. The protocol uses the canonical interface
   defined in `src/interfaces/ICryptoPunksMarket.sol`.
2. **`PunksData` (sealed, `punksdata.eth`) is the trait source.** The protocol
   reads `traitMaskOf(uint16)` and `datasetHash()` directly;
   `PermanentCollection`'s constructor reverts on a `datasetHash` mismatch.
3. **"Permanent" means no exit path in the deployed contracts.** It does not
   guarantee permanence of Ethereum, CryptoPunks, the artcoins protocol,
   PunkStrategy, or the cultural systems around any of them.
4. **Token holders do not own the Permanent Collection.** They cannot vote on,
   govern, or otherwise control any protocol contract.
5. **The deployer is the artist; the creator reward slot is the artist
   commission.** The current deployment routes 720 bps of the factory reward
   array (8% of PC-allocatable fees, 0.36% of swap volume) to that recipient.
   This is the only creator revenue path. No other fee surface, no admin
   treasury, no `withdraw` on Patron.

## Trust boundaries

### Deployer trust during setup

Between `Deploy.s.sol`'s factory call and the `setWiring(...)` calls on
`PermanentCollection` and `Patron`, the deployer could mis-configure
cross-references. Both contracts gate wiring through `OneTimeSetup`: once
`setWiring` is called, no further changes are possible. The post-deploy
checklist covers verification.

### Persistent admin power (V4-specific)

V4 has **four scoped admin surfaces** that don't freeze at the 1-year auto-lock.
The count moved from five to three and back to four: `setPolDeployTarget` was
removed with the POL subsystem, and `LiveBidAdapter.setActivationThreshold` was
removed in a simplification but has since been RESTORED with the
activation-threshold machinery (re-opening audit findings M-1 and L-2, both
knowingly accepted — see the adapter note below). They stay callable
indefinitely (or until the relevant admin role is burned via
`transferAdmin(address(0))`). The first two (#1 seller allowlist, #2 activation
threshold) are gated on `ProtocolAdmin.admin()` alone; the last two (#3, #4) are
two-key-gated on EITHER `TokenAdminPoker.owner` OR `ProtocolAdmin.admin()` and
freeze only when BOTH are burned.

**1. Seller allowlist on `Patron`** —
`addAllowedSeller(address)` / `removeAllowedSeller(address)`.

**Why this is acceptable**: the allowlist's only effect is which sellers'
public listings can be accepted via `acceptListing`. Every accept pays the
seller only their listing price (≤ live bid), then either clears the return
auction (the cost-based 65/25/10 cleared split benefits the protocol) or vaults the Punk
(permanent trait added at a cheap price). No allowlist entry can take more
than their own listing price. Worst case is reputational, not financial.

**Mitigations**:
- `addAllowedSeller` only grants the ability to be accepted by us — it does
  not give the allowlisted contract any power.
- `acceptListing` enforces `minValue > 0`, `bidBalance ≥ MIN_BID_FOR_LISTING`,
  `minValue + finderFee ≤ bidBalance`, and a single-Punk per-call cadence.

**Shared mitigation**:
- The admin role can be burned via `protocolAdmin.transferAdmin(address(0))`
  at ANY time — including after the 1-year timer has lapsed without a
  heartbeat — which permanently freezes the raw-admin carve-outs alongside
  everything else. Only renewals/rotations are time-gated; the burn path is
  never gated, so the carve-outs always retain an on-chain off-switch even if
  the admin key is compromised post-lapse (auditor finding M-1).

**2. Activation threshold on `LiveBidAdapter`** —
`setActivationThreshold(uint256)` (`onlyAdminEvenIfLocked`, gated on
`ProtocolAdmin.admin()` alone, bounds `[0, 100] ETH`). It sets the
fast/throttled boundary: below it the buffer forwards uncapped (a fast launch
warm-up, clamped to land the bid AT the threshold); at/above it the
`maxSweepWei`/`minBlocksBetweenSweeps` rate cap paces growth. The threshold
normally self-tracks 75% of the latest `acceptBid` clearing price (a −25% band)
via `_syncActivationThreshold` reading the records core (`permanentCollection` /
`IPCAcquisitionReader`); this setter is a bounded manual override
(last-writer-wins until the next acceptBid re-syncs).

**Why this is acceptable**: the setter only moves the warm-up/throttle boundary
within `[0, 100] ETH`. It cannot move funds, cannot reach Patron's balance, and
the buffer it governs can only ever flow toward Patron.

**It knowingly re-opens audit M-1 and L-2.** M-1: an attacker can list a Punk to
the hub at 1 wei, have the acceptBid finalized, and drive the synced threshold
to `(1 * 75) / 100 == 0`, which pins the adapter into throttled mode forever (a
0 threshold makes `Patron.balance >= threshold` always true, so fast-mode is
bypassed). L-2: in fast mode there is no cooldown, so a keeper can collect the
bounded keeper reward on each tiny inflow until the bid crosses the threshold.
Both are ACCEPTED: the worst-case outcome of M-1 is the adapter being permanently
throttled (every forward rate-limited — the live bid still grows, just at the
drip and never uncapped) and the attacker extracts no protocol value (they pay gas plus a
return-auction premium on a Punk they already custody); L-2's harvest is bounded
by the per-call reward cap and ends once the threshold is crossed. The source
carries an `AUDIT NOTE` on `_syncActivationThreshold` (M-1) and on the fast-mode
branches (L-2). New permanent surface on the immutable adapter.

**The two rate-cap knobs are NOT carve-outs** — `setMaxSweepWei(uint256)` and
`setMinBlocksBetweenSweeps(uint256)` (contract names follow the deployed ABI)
are the two knobs of the throttled-mode rate cap. They are `checkAdmin`-gated
and freeze at the 1-year `ProtocolAdmin` lock with the rest of the economic
surface — only `setActivationThreshold` survives the lock.

**First new trust-boundary note (un-audited) — POL removal + locker tail
positions**: the `POLDepositor` "permanent depth bootstrap" and its entire
POL-diversion subsystem (`polRecipient`, `polDeployTarget`, `POL_DIVERSION_BPS`,
`bindPolRecipient`, `setPolDeployTarget`, the 50% `sweep()` diversion, the POL
events) have been **deleted** from the launch surface. `LiveBidAdapter.sweep`
now forwards 100% of bounty-bound inflow to Patron from block 1. Permanent
high-FDV depth is instead provided by **two concentrated tail LP positions
(12 & 13) registered in the conversion locker at deploy** (covering ~$31M–$310M
FDV), which requires bumping artcoins `MAX_LP_POSITIONS` from 12 to 14. The new
permanent surface = the two tail positions (immutable once registered) + the
bumped locker constant; the modified surface = the simpler `LiveBidAdapter`
`sweep` (POL stripped); the removed surface = the entire `POLDepositor`. This
needs a fresh focused audit before broadcast — bundle it with the other
un-audited `LiveBidAdapter` changes below since the surface overlaps.

**Second new trust-boundary note (un-audited) — inflow consolidation
(`LiveBidAdapter` is the single faucet into Patron)**: every ETH source that
funds the live bid now enters through `LiveBidAdapter` (the single inflow
governor), which buffers and meters it into Patron via `sweep`. The new /
modified permanent surface across three immutable contracts:
- **`Patron`** — `receive()` is now adapter-only: `if (msg.sender !=
  liveBidAdapter) revert NotAdapter()`. The adapter is the ONLY address that
  can push ETH into the live bid; every other source routes through it.
  `setWiring` gained a third `liveBidAdapter` arg. `contribute` and
  `poolReplenish` were REMOVED (moved to the adapter); `IPatron` no longer
  declares them (breaking interface change).
- **`LiveBidAdapter`** — gained `contribute(referrer, tag)` (attributed
  top-ups, `REFERRER_CONTRIB_BPS = 500`, 35k-gas fail-closed, `nonReentrant`
  + `notInSwap`) and a **module-only** `poolReplenish(uint16)` (the cleared
  rescue refund; gated to the new immutable `returnAuctionModule` ref so the
  punk-keyed `PoolReplenished` event can't be spoofed). The `Contribution` /
  `BareTopUp` / `PoolReplenished` events moved here. (The refund and every other
  inflow meter into Patron under the two-mode meter — above the activation
  threshold a large rescue refund cannot spike the live bid; it buffers and
  drips like the rest.)
- **`ReturnAuctionModule`** — the cleared-path 65%-of-cost refund now calls
  `liveBidAdapter.poolReplenish` instead of `patron.poolReplenish`; the module
  gained a one-shot `setLiveBidAdapter` (same shape as the audited
  `setVaultBurnPool`). The cleared-settle keeper reward was removed — settle
  pays no protocol-funded tip (self-incentivized by the winning bidder's
  locked ETH), so the un-gas-limited `msg.sender.call{value:reward}` and its
  fail-closed reroute are gone.
- **Forced reroutes** (immutable): `ProtocolFeePhaseAdapter`'s
  pre-first-acquisition leg now targets `liveBidAdapter` (immutable ref
  renamed `patron`→`liveBidAdapter`), because Patron's adapter-only gate
  would otherwise revert its sends; and `PCDispatcher`'s registration fee
  forward targets the adapter (built, NOT bound at launch).
`PunkVaultTitleAuction` is untouched (its Patron share is
`PATRON_SHARE_BPS = 0`, pull-based — it never sends ETH to Patron).
This is new permanent surface on three immutable launch contracts and needs
a fresh focused audit before broadcast — compose it with the other un-audited
`LiveBidAdapter` changes here, since they touch the same code.

**Mitigations**:
- `maxSweepWei` and `minBlocksBetweenSweeps` freeze at the 1-year lock; only
  `setActivationThreshold` survives as the adapter's carve-out.
- Forwards emit `Swept(ethSwept, ethForwarded, ethBuffered)`; rate-cap and
  threshold changes emit `ParameterChanged("maxSweepWei" |
  "minBlocksBetweenSweeps" | "activationThreshold", old, new)`; an `acceptBid`
  auto-sync emits `ActivationThresholdSynced` and a below→above crossing emits
  `ThresholdCrossed`. All public for monitoring.
- Above the activation threshold the rate cap bounds bid growth to at most
  `maxSweepWei` per `minBlocksBetweenSweeps` blocks regardless of inflow source
  or magnitude, so no inflow path (fees, `contribute`, bare send, rescue refund)
  can spike the live bid past the threshold; below it the fast-mode forward is
  clamped to land the bid exactly AT the threshold (then the cap engages).

**Third new trust-boundary note (un-audited) — per-swap pre-swap streaming**:
a change to live-bid metering, new permanent surface on `LiveBidAdapter` (#172)
and the artcoins hook (pinned `7ef5c96`).
- **Pre-swap streaming (`streamForward` + hook `_beforeSwap`)**: this is the
  one genuinely new trust surface — **protocol funds now move during a swap**.
  The hook calls `IPreSwapStream(bountyRecipient).streamForward()` in
  `_beforeSwap` (balance-gated `try/catch`), flushing the adapter's buffered
  bounty leg into Patron before the swap executes. Reentrancy posture: the
  only external call `streamForward` makes is to `Patron.receive()` (a
  no-logic sink) — it does NOT claim the fee escrow and cannot re-enter the
  PoolManager or alter the in-flight swap's settlement (this swap's own skim is
  taken later, in `_afterSwap`); `streamForward` is `nonReentrant` (a malicious
  Patron re-entering is blocked, no double-forward) + `notInSwap`; and the
  `try/catch` means a reverting/non-implementing recipient can never brick a
  swap. It runs OUTSIDE the Design-B `inSwap` window (the dispatcher only sets
  `inSwap` around its `_afterSwap` callback), so it composes with a bound
  extension without tripping the guard. `streamForward` pays NO keeper reward
  and no-ops (returns 0, never reverts) below `MIN_STREAM_WEI` (0.01 ETH) or on
  cooldown. The `_beforeSwap` fund-movement is the thing the focused re-audit
  should scrutinize hardest. Covered by `test_fork_preSwapStream_*`
  (advances-bid / reverting-recipient-survives / dispatcher-coexistence) +
  adapter units (nonReentrant, dust/cooldown, rate-cap edges); 111 pass on a
  clean isolated run. Spec: `LiveBidAdapter` NatSpec + `docs/SYSTEM.md` /
  `docs/PROTOCOL.md`.

**Fourth new trust-boundary note (un-audited) — `acceptBid` priced-listing
rework**: the accept-the-bid acquisition was reworked from "list to Patron for
0, get pushed the live bid" to "list to Patron at a real price ≈ the live bid,
get paid by the market." New / modified permanent surface on the immutable
`Patron`:
- **Listing model.** The owner lists their Punk **exclusively to Patron at a
  real positive price `L`** (`offerPunkForSaleToAddress(punkId, L, patron)`,
  never 0) with `L ≤ bidBalance()` (the frontend lists at the full bid by
  default). `acceptBid` reads the listing and requires `isForSale`,
  `onlySellTo == patron` (exclusive), and `L > 0` — listing-at-0 is a hard
  contract rule.
- **No reserve floor.** `L` need only satisfy `L <= accountedLiveBidWei` (the
  listed price can't sit above the pool); there is no lower bound beyond
  `L > 0`. A seller may list at any positive price up to the bid, and the
  protocol pays the listed price (the pool keeps any difference). The anti-grief
  guard is the return auction's **open-market exposure**, not a reserve floor:
  occupying a trait's one in-flight slot means putting a real Punk into a 72h
  open auction every cycle and either losing it at the clearing price or buying
  it back at the clearing price — economically irrational against a
  deadline-less protocol. An earlier reserve-floor proposal (forcing `L` to
  within ~1% of the bid) was dropped as a net surface reduction; it added only
  marginal grief resistance and could revert a legitimate accept if the bid
  drifted up between the list and accept txs.
- **Removed seller push.** The old `seller.call{value: payout}` and its
  `SellerPaymentFailed` revert are **gone**. Patron's only ETH movement on
  `acceptBid` is `buyPunk{value: L}` to the 2017 market, which credits `L` to
  `pendingWithdrawals[seller]`; the seller collects via `withdraw()`. This is
  a **net reduction** in attack surface (no malicious-seller-`receive()`
  vector — see the reentrancy note below) and `buyPunk` is already-audited
  surface (`acceptListing` uses it).
- **Permissionless finalize.** `acceptBid` is now anyone-callable (the removed
  `NotPunkOwner` owner-gate): the target is protocol-derived via
  `canonicalTargetOf`, so the original owner-only reason (front-running the
  owner's trait pick) is moot. The seller — or a protocol watcher — finalizes.
- **Param flip + errors.** The 3rd arg flipped from a seller-payout floor
  `minPayoutWei` (and its mandatory-non-zero `MinPayoutRequired` /
  `PayoutBelowMin` checks, removed) to a caller-side overpay cap
  `expectedListingWei` (`ListingAboveExpected` if `L` exceeds it). The price
  checks are just `L > 0` (`ZeroListingPrice`), `L <= accountedLiveBidWei`
  (`ListingExceedsBid`), and `L <= expectedListingWei` (`ListingAboveExpected`).
  `BidAccepted(punkId, seller, L)` payload is unchanged (`L` == the listed price
  paid through the market).
- **Shared `_acquire` tail.** `acceptBid` and `acceptListing` now share an
  internal `_acquire` helper (the buyPunk → startSale → recordAcquisition tail)
  but remain **two separate, separately-gated entry points** enforcing
  different anti-grief models (exclusive `onlySellTo == patron` listing + open
  access vs allowlist + finder fee). The auditor should confirm the two can't
  cross-contaminate through the shared tail.
No hard invariant weakens: #10 (no Patron withdrawal path) is preserved (no new
selector; the bytecode scan is unchanged), #13 (`balance >= accountedLiveBidWei`)
holds by construction (`accountedLiveBidWei -= L` and exactly `L` leaves via
`buyPunk`), and #8/#22/#6/#23/#9 (the return-auction + canonical-target +
caller-role guards) are untouched. This is new permanent surface on the
immutable `Patron` and **needs a fresh focused audit before broadcast** — bundle
it with the inflow-consolidation Patron changes above (same contract).

**2. Referral cap (NEW — added with the referral activation)** —
`TokenAdminPoker.setHookMaxReferralBps(newCap)`, bounded
`[0, 1_000]` bps (0%–1% of swap volume in 100k denom).

**Why this is acceptable**:
- The cap controls the maximum referral fraction the hook will honor per
  swap. It cannot exceed the hook's hard ceiling `MAX_REFERRAL_CAP_OF_VOLUME = 1_000`.
- Referrals are paid EXCLUSIVELY from the protocol leg (20% of baseline
  skim). Raising the cap cannot reduce the bounty leg or the vault-burn
  leg — the bytecode-enforced invariant in `_processSkimAndAttribution`
  guarantees that.
- The pre-acquisition gate still applies: pre-first-Punk-vaulted, the
  hook silently ignores attribution regardless of the cap.

**Two-key authorization (carve-out specific)**: unlike the seller-allowlist and
activation-threshold carve-outs (#1 / #2, gated on `ProtocolAdmin.admin()`
alone), this setter accepts
EITHER `TokenAdminPoker.owner` OR
`ProtocolAdmin.admin()` EOA. The cap freezes only when BOTH roles are
burned (rather than just `ProtocolAdmin.transferAdmin(0)`). This is
intentional — both retained-admin handles point at the same EOA at deploy,
so the redundant gate just adds graceful degradation if either is rotated.

**Mitigations**:
- Hard ceiling enforced in the hook itself (`MaxReferralTooHigh` revert)
  is not adjustable.
- Changes emit `MaxReferralBpsSet(hook, newCap)` for public monitoring.
- Bytecode-enforced invariant: referral never reduces bounty or vault-burn
  legs (`LaunchInvariantForkTest::test_fork_4LegSplit_*` group).

**3. Venue-scoped transfer-tax rate** —
`TokenAdminPoker.setTokenTaxBps(uint16)` → `ArtCoinsToken.setTaxBps`.

**Why this is acceptable**: the rate is bounded `[0, taxBpsMax]` where
`taxBpsMax = 2000` (20% cap; **launch rate 15%**, sized by the router
investigation — `docs/router-results/`), and the token's own compile-time
`TAX_BPS_ABSOLUTE_MAX = 2000` backstops the constructor — so the admin can only
ever sweep the rate within `[0, 20%]`, never predatory. (Cap raised from 5% per
the investigation; **requires a fresh focused audit of the cap-raise surface
before broadcast** — see invariant #21.) The tax can only EVER skim a DEX buy (111 leaving a venue to a
non-exempt recipient); it cannot touch wallet sends, the bid, the vault, the
Punks, or any non-DEX transfer. Worst case: the admin sets the rate to its
already-launched maximum (5%), or to 0 (disabling deterrence). Both are within
the designed band.

**Mitigations**:
- Two-key gate: callable by `TokenAdminPoker.owner` OR `ProtocolAdmin.admin()`;
  freezes only when BOTH are burned (same posture as the referral cap).
- The token's transfer-path tax logic is IMMUTABLE — only the bounded rate is
  live. No path adds venues, changes the burn sink, or removes exemptions.
- Changes emit `TaxBpsUpdated(old, new)` (token) + `TokenTaxBpsSet(token, new)`
  (poker) for public monitoring.

### Venue-scoped transfer tax — trust + composability surface

The 111 token carries a default-off, venue-scoped, buy-side transfer tax
(enabled only for this launch). Security-relevant facts:

- **It is fee-on-transfer in ONE narrow context** (111 leaving a DEX venue on a
  buy / pool outflow). In every other context — wallet/Safe/4337 sends,
  lending, bridges, CEX — it is a plain ERC20. The residual integration risk is
  *policy* (a venue may decline a token it deems FOT), not mechanics.
- **The canonical pool is exempt** via an EIP-1153 amount-pinned budget the
  factory-blessed hook attests per swap (`attestCanonicalBudget`, gated to
  `canonicalHook` + `canonicalPoolId`). The budget is a uint (not a bool) and is
  **fungible within the tx**: it can subsidize a same-tx side-pool buy, but only
  up to the realized canonical 111-out, and it can never be *earned* by a
  side / permissionless-open pool. So it is **bounded, not self-defeating**: it
  only ever benefits a buyer who is already concentrating real volume on
  canonical (the behavior the tax wants to encourage), and burned tax proceeds
  are never a bid-funding source, so the subsidy can't be turned into protocol
  profit.
- **Proceeds accrue in `VaultBurnPool`, burned on vault-path settle** — the tax
  `burnAddress` is `VaultBurnPool`; accrued 111 is burned via `token.burn`
  (totalSupply drops, a stronger burn than a transfer-to-dead) in the same
  `sweep` as the ETH leg, when the protocol permanently collects a Punk. Never
  converted to ETH (no sell pressure), never LP'd. The bid is fed indirectly by
  the routing shift onto canonical.
- **No new fund-extraction surface.** The tax can only move 111 from a venue
  outflow to the burn sink; there is no admin path to redirect proceeds, add a
  recipient, or skim a non-venue transfer. The sink (`VaultBurnPool`) can only
  `burn` the accrued 111 — it exposes no `transfer`/`transferFrom`/`approve`
  (bytecode-scan asserted) — and only `ReturnAuctionModule` triggers the burn
  (on vault-path settle). The `OneTimeSetup` `setup(token)` is a one-shot
  post-deploy wiring that locks; it moves no value.
- **One-shot immutable surface** — requires a fresh focused audit. Full
  rationale: `docs/TRANSFER_TAX_INVESTIGATION.md`.

### Referrer addresses passed into entry points (NEW)

Two PC entry points accept an arbitrary `address referrer` parameter from
the caller. Both treat the referrer as a fully UNTRUSTED external contract
and are fail-closed in both directions: no referrer, OR a reverting / OOG
referrer, sends 100% of the would-be-referrer slice to the protocol's
intended internal target. Neither code path can be made to revert by a
hostile referrer, and neither can reduce the protocol's other splits.

There are NO new admin surfaces, NO setters, and NO future-tunability for
either mechanism. Both bps constants are immutable.

**1. `ReturnAuctionModule.placeBidWithReferral(uint16 punkId, address referrer, bytes32 tag)`** (and the no-referral `placeBid(uint16 punkId)`, which routes through the same internal logic with `referrer == address(0)`)

- The `referrer` address is stored at `referrerOfHighBid[punkId]`. This
  slot is OVERWRITTEN on every accepted bid that becomes the new high
  bid — the slot tracks the CURRENT high bidder's referrer only. An
  outbid bidder's referrer loses attribution at the moment of outbidding.
  Winner-take-all semantics, no claim path, no future-payout queue, no
  escrow for displaced referrers.
- On cleared / rescue settle, the outgoing send to `referrer` is capped
  at `REFERRER_GAS = 35_000` (matches `ReferralPayout.CLAIM_GAS`).
- `REFERRER_PREMIUM_BPS = 500` is an immutable constant. The referrer
  slice is computed strictly from the premium (`highBid − cost`); the
  referrer NEVER reduces the bounty leg or the burn leg.
- Fail-closed: if `referrer.call` reverts or OOGs (35k budget exceeded),
  `referrerShare` is reset to zero BEFORE the VaultBurnPool transfer and
  the would-be slice folds back into `vaultBurnShare`. Settle itself
  never reverts on referrer failure — the Punk transfer, bounty payment,
  burn payment, and vault-burn payment all complete regardless.
- Vault-path (silenced) settle pays no auction referrer — there is no
  premium to split.
- Bytecode-scan still asserts no admin/withdrawal selectors on
  `ReturnAuctionModule`.

**2. `LiveBidAdapter.contribute(address referrer, bytes32 tag)`** (moved from
Patron to the adapter under inflow consolidation — the adapter is now the
single faucet into the live bid)

- The `referrer` address is read once per call and never stored. There
  is no per-contributor or per-referrer ledger on the adapter — the path
  is send-once-and-done.
- Outgoing send to `referrer` is capped at `REFERRER_GAS = 35_000`.
- `REFERRER_CONTRIB_BPS = 500` is an immutable constant. The referrer
  slice is 5% of `msg.value`; the remainder stays buffered in the adapter
  (and meters into the live bid via `sweep`). No other split is affected.
- Fail-closed: `referrer == address(0)` OR reverting / OOG referrer →
  `referrerShare` is reset to zero and 100% of `msg.value` stays buffered
  in the adapter as live bid. The send did not move ETH, so the
  accounting is exact.
- `msg.value == 0` reverts `ZeroValue()` to prevent bare attribution
  pings from polluting the `Contribution` event stream.
- Decorated `nonReentrant + notInSwap`. The `nonReentrant` mutex is
  SHARED with `sweep` and `poolReplenish`, so a malicious referrer cannot
  re-enter any adapter fund-mover — see the table below.
- Bytecode-scan asserts (a) no admin / withdrawal selectors on the adapter
  and (b) the `contribute(address,bytes32)` selector IS reachable, so
  the canonical schelling-point destination cannot silently disappear
  in a future build.

A second adapter entry point, **`LiveBidAdapter.poolReplenish(uint16 punkId)`**,
accepts the cleared-auction rescue refund. It is **module-only** — gated to
the immutable `returnAuctionModule` ref (`NotReturnAuction` otherwise) so the
punk-keyed `PoolReplenished` event cannot be spoofed — and carries the same
`nonReentrant + notInSwap` decoration. It moves ETH only INTO the buffer (no
outflow), then meters into Patron on the next `sweep`.

### Artcoins dependencies

The protocol depends on the artcoins contract suite for its token + V4 pool +
LP infrastructure. **These are external contracts under the artcoins
protocol's ownership**, not ours.

| Artcoins contract | What it controls | Mitigation |
|---|---|---|
| Factory (`0xF051…793e`) | Decides which hooks/lockers/extensions are allowed at deploy. Owner can deprecate future deploys. | Only matters once: at our deploy time. Post-deploy, our pool is independent of factory state. |
| Hook (`0xAAd6…A8Cc`) | Charges the per-swap fee. Reads fee from pool configuration set at deploy. | Hook bytecode is fixed once deployed; can't change fee semantics for an existing pool. |
| Conversion locker (`ArtCoinsLpLockerFeeConversion`, deployed per launch) | Holds the LP NFT; collects + converts the artcoin-side fee → native ETH and credits the escrow. PC launches on this, NOT the stock locker `0xd914…7b2`. | **Real trust surface** — same as any V4 protocol that doesn't deploy its own pool infra. |
| Fee escrow (`0xDD1b…1C06`) | Queues native ETH per-recipient. `claim` is permissionless. | Low trust — pull-based, recipient-specific. |
| BurnRouter | Where the artcoins protocol slice flows. Outside our concern. | No interaction. |

**PC-side trust surface — the pool-extension slot is empty at launch.**
The hook ITSELF performs the three-leg skim split (bid / protocol /
referral) inside `_afterSwap` (no separate per-swap extension contract).
The pool's `extension` slot is deliberately bound to `address(0)` at launch.

`TokenAdminPoker` (owner = deployer) retains the capability to
`bindExtension` a future Design B dispatcher (e.g. `UnipegDispatcher`)
that fans out third-party `afterSwap` callbacks under gas budgets +
try/catch isolation. **A bound dispatcher cannot reenter any decorated
PC contract**: `PCSwapContext.inSwap` flips for the duration of the
callback loop, and the 7 PC contracts decorated with `notInSwap` revert
`PCNoReentry.InSwap` if a callback attempts to reach in. The dispatcher
also has no custody of funds and no path to move Punks. Calling
`tokenAdminPoker.lockExtension()` +
`pcSwapContext.lockAuthorizedExtension()` once a dispatcher is proven
freezes the slot permanently.

Even if the deployer key is compromised BEFORE locking, the attacker
can at worst:
- Bind a malicious dispatcher → triggers callbacks each swap, but
  callbacks cannot reenter PC contracts (notInSwap), cannot exit the
  inSwap flag (only authorizedExtension can flip), cannot exceed
  per-callback gas budgets (try/catch + budget enforcement in
  dispatcher).
- Worst real damage: cause the per-swap callback loop to consume gas
  or revert (the parent hook's try/catch catches the dispatcher's
  failures so the swap itself doesn't revert).
- They cannot seize the live bid, the LP position, the vaulted Punks,
  or reroute the three-leg skim distribution.

See `docs/COMPOSABILITY.md` for the Design B threat model.

### PunkStrategy dependency (V4)

PunkStrategy is allowlisted at launch as a peer-protocol seller. The
relationship is **one-way**: PunkStrategy's contract has no power over us; we
have an option to buy its publicly-listed Punks via `acceptListing`. If
PunkStrategy migrates, becomes inactive, or is exploited, our protocol is
unaffected — the admin removes the address with `removeAllowedSeller` and
continues.

### Our contracts

| Contract | Egress surface | No-admin invariant |
|---|---|---|
| `PermanentCollection` | None. Records-only. | Bytecode-scan asserts no CryptoPunks market write selector. |
| `PunkVault` | ERC721 transfers for Proofs (ids 0..110, with `tokenId == traitId`) + Title (token id 111). No Punk egress — once owned, Punks never leave. | Bytecode-scan asserts no CryptoPunks market write selector (re-run post-Proofs via `ProofMintForkTest`). Mint paths are dual-gated and disjoint by id range: only `titleAuction` can mint id 111 (`mintToAuction`); only `returnAuctionModule` can mint ids 0..110 (`mintProofs`); ids ≥ 112 unreachable from any code path. **Marketplace owner slot (ERC-173 `owner()`)** is a one-way ratchet — initialized to the deployer EOA, only `renounceOwnership()` to `address(0)`; no `transferOwnership`. Slot has zero on-chain authority: does NOT gate any vault function, the Punks, the `tokenURI` / `contractURI` content (rendered from `RendererRegistry`), or any other PC contract. Used solely so marketplaces recognize the deployer wallet as the collection-page editor during the launch-setup window; the dev calls `renounceOwnership()` after setting up OpenSea banner / profile image / social links and the editor surface is permanently sealed. Bytecode-scan asserts only `owner()` + `renounceOwnership()` admin-pattern selectors are present (no `transferOwnership`, no `rescue*`, no `sweep`, no `migrate`, no `emergencyWithdraw`). |
| `Patron` | (a) `buyPunk{value:listingWei}` in `acceptBid` (paid to the 2017 market, which credits the seller's `pendingWithdrawals` — no direct seller push); (b) `buyPunk{value:minValue}` in `acceptListing` (paid to market, not arbitrary); (c) `msg.sender.call{value:finderFee}` in `acceptListing`; (d) `returnAuctionModule.startSale` and `punksMarket.transferPunk(returnAuctionModule, ...)` in both paths. No other path. | Bytecode-scan asserts no `withdraw`, `rescue`, `sweep`, `migrate`, `emergencyWithdraw` selectors. |
| `ReturnAuctionModule` | (a) Bidder refunds (push w/ pull fallback); (b) `liveBidAdapter.poolReplenish` on clear (the 65%-of-cost refund — buffered + metered into the live bid, not paid to Patron directly); (c) `buybackBurner.call{value:burnShare}` on clear; (d) `transferPunk` to buyer (clear) or vault (unsold). | No admin path; all triggered by user `bid`/`settle`. |
| `BuybackBurner` | (a) 111 to `0xdead`; (b) `msg.sender.call{value:reward}` for execution reward. | No admin path; `executeStep` is permissionless. |
| `LiveBidAdapter` | (a) `patron.call{value:fwd}` (the metered forward — the single faucet into the live bid); (b) `referrer.call{value, gas:35_000}` on `contribute` (fail-closed); (c) `msg.sender.call{value:reward}` keeper reward on `sweep`. `sweep` also makes read-only `staticcall`s to `permanentCollection` (`acquisitionCount` / `getAcquisition`) to sync the activation threshold (fail-open; moves no value). Inflows (`contribute` / `receive` / module-only `poolReplenish`) move ETH only into the buffer. | No admin path; `sweep` is permissionless. |
| `ProtocolAdmin` | None — role contract, no funds. | One-way locking; cannot be unlocked. |

## Reentrancy posture

**Two-layer defense.** Every public state-changing PC entry point carries
a `notInSwap` modifier (from `PCNoReentry`). On top of that, every entry
point that pays an attacker-controllable keeper reward (or otherwise hands
control to an external `.call`) ALSO carries a `nonReentrant` mutex from the
shared `PCReentrancyGuard` mixin — inherited by `Patron`, `LiveBidAdapter`,
`ReturnAuctionModule`, and `PunkVaultTitleAuction` (it replaces the four
byte-identical inline `_lock` mutexes those contracts previously each
defined). The guard uses EIP-1153 transient storage (same primitive as
`PCSwapContext.inSwap`), so the lock auto-clears at end of transaction with
no trailing SSTORE and no stuck-lock failure mode; the slot is per-contract
address, so the shared constant is collision-free across inheritors.
`nonReentrant` prevents same-function recursion (and, where a single lock is
shared between two fund-movers, cross-function recursion) within one tx;
`notInSwap` prevents reentry from a Design B dispatcher's callback during a
swap. The two are complementary, NOT redundant: `notInSwap` is a no-op at
launch (no extension is authorized to set `inSwap`), so for the
permissionless fund-movers the mutex is the only ACTIVE same-tx reentry
guard today — this is the substance of audit finding L-1.

| Entry point | Guards |
|---|---|
| `Patron.acceptBid` | `nonReentrant` + `notInSwap` |
| `Patron.acceptListing` | `nonReentrant` + `notInSwap` |
| `LiveBidAdapter.contribute` | `nonReentrant` + `notInSwap` (moved from Patron; mutex shared with `sweep` / `poolReplenish`) |
| `LiveBidAdapter.poolReplenish` | `nonReentrant` + `notInSwap` (ReturnAuctionModule-only; the cleared rescue refund) |
| `ReturnAuctionModule.placeBid` / `placeBidWithReferral` | `nonReentrant` + `notInSwap` |
| `ReturnAuctionModule.settle` | `nonReentrant` + `notInSwap` |
| `ReturnAuctionModule.withdrawRefund` | `nonReentrant` + `notInSwap` |
| `BuybackBurner.executeStep` | `notInSwap` + block-pacing (`lastStepBlock` is written before the unlock callback, so a same-tx re-entry reverts `StepTooEarly`). Deliberately NO mutex: it shares no mutable state with any other fund-mover, so pacing is the complete same-tx guard. |
| `LiveBidAdapter.sweep` | `nonReentrant` + `notInSwap` (the un-gas-limited keeper-reward `.call` to `msg.sender` is the same-tx reentry vector, so the mutex guards it) |
| `LiveBidAdapter.streamForward` | `nonReentrant` + `notInSwap` (pre-swap stream; no keeper reward) |
| `ProtocolFeePhaseAdapter.sweep` | `notInSwap` (no keeper reward; forwards the entire balance to a trusted recipient — `LiveBidAdapter` under inflow consolidation — so a re-entry finds a zero balance — no mutex needed) |
| `VaultBurnPool.sweep` | `notInSwap` (ReturnAuctionModule-only; no keeper reward) |
| `PunkVaultTitleAuction` (entry points) | `nonReentrant` + `notInSwap` |

`PCSwapContext.inSwap` is the shared transient-storage flag. At launch
`authorizedExtension == address(0)`, so the flag is permanently `false`
and the `notInSwap` modifier is a no-op for every entry point. The
modifier exists today so the wiring is permanent — when a future
Design B dispatcher is bound, the existing PC contracts already block
its callbacks from reentering, no redeploy needed.

External calls that could re-enter:

- `acceptBid` Punk purchase (`buyPunk{value:listingWei}` into the 2017
  market) — protected by `nonReentrant`. The priced-listing rework
  **removed the direct `seller.call` push**: the seller is now paid by the
  market's pull-based `pendingWithdrawals` (collected via `withdraw()`), so a
  malicious seller's `receive()` is never invoked during `acceptBid` and the
  former double-claim vector is structurally gone. The mutex still guards
  against re-entry via the (trusted) market call. Verified end-to-end by
  `test_fork_hardening_acceptBounty_noSellerPushReentry` (the test name
  retains the legacy "acceptBounty" label), which asserts the acquisition
  succeeds while the seller's `receive()` never fires.
- `acceptListing` finder fee (`msg.sender.call`) — protected by
  `nonReentrant`.
- Permissionless fund-mover keeper reward (`msg.sender.call` in
  `LiveBidAdapter.sweep`) — protected by an inline `nonReentrant` mutex
  (audit L-1). It pays an attacker-controllable reward via an
  un-gas-limited `.call`; the buffer is always forwarded to the protocol
  recipient (Patron — 100% of bounty-bound inflow from block 1, no POL
  diversion) BEFORE the reward send, and the mutex blocks the recipient's
  `receive()` from re-entering the sweep. `notInSwap` provides no cover
  here at launch, so the mutex is the active guard. Verified by
  `test_fork_hardening_liveBidAdapterSweep_reentryFromKeeperBlocked`
  against the live `Reentrant` selector.
- `ReturnAuctionModule.placeBid` refund (`previousBidder.call{gas: 30_000}`) —
  gas-bounded + `nonReentrant`. A grief-bidder can only force the
  refund into pull mode (`withdrawRefund`).
- `ReturnAuctionModule.settle` `liveBidAdapter.poolReplenish` (the
  cleared 65%-of-cost refund — routed through the adapter buffer under
  inflow consolidation, not Patron directly) and `buybackBurner.call` —
  both are our own contracts; both gate on the expected caller; both
  notInSwap.
- `BuybackBurner.unlockCallback` from the V4 PoolManager — gated on
  `msg.sender == poolManager`.
- `ReferralPayout._claim` recipient send (35k gas budget) — protected
  by balance-zeroing-before-send AND balance-reinstate-on-failure +
  `TransferFailed` revert. Pull-based; no reentry into payout state.
- `LiveBidAdapter.contribute` referrer send (`referrer.call{value, gas: 35_000}`)
  — `nonReentrant` (mutex shared with `sweep` / `poolReplenish`) +
  `notInSwap` cover the path. Fail-closed: a reverting / OOG referrer
  leaves `referrerShare` at zero and the full `msg.value` stays buffered in
  the adapter as live bid. The send happens against the inbound
  `msg.value`, which is already in the adapter, so there is no balance to
  "re-claim" by reentering (and the shared mutex blocks re-entry into
  `sweep`/`poolReplenish` regardless). Moved from Patron under inflow
  consolidation.
- `ReturnAuctionModule.settle` referrer send (`referrer.call{value, gas: 35_000}`)
  — fires only on the cleared / rescue path, after `liveBidShare` and
  `burnShare` have been computed but BEFORE the VaultBurnPool transfer.
  Fail-closed: a reverting / OOG referrer folds the slice into
  `vaultBurnShare`; settle never reverts on referrer failure. The Punk
  has already been delivered to the buyer via the escrow round-trip by
  the time the referrer send fires, so a hostile referrer cannot strand
  the Punk or block the proceeds split.
- `ReturnAuctionModule.settle` vault-path `punkVault.mintProofs(...)` — the
  one interaction here that is **required, not best-effort**: it is called
  directly (no `try/catch`), so a failure reverts the whole settle and rolls
  it back (retryable), binding the Proof mint atomically to the vaulting
  (hard invariant #19 — collected-trait ⟺ Proof). This adds no griefing/DoS
  vector even though it can revert settle: `mintProofs` uses `_mint` (no
  `onERC721Received` callback), so the Proof recipient executes no code during
  the mint and cannot force a revert to block a Punk's vaulting. And it cannot
  brick a legitimate settle — the recipient is structurally non-zero
  (`recordAcquisition` enforces `originalSeller != 0`) and the token id
  (`== traitId`) is structurally fresh on a first-vaulting, so the required
  mint has no reachable revert. (`PunkVault` is one of our own contracts, not
  an untrusted external party.)
- Hook fee flush: the per-swap flush of all three legs happens inside
  `_afterSwap` itself (already within the PoolManager's swap unlock), so the
  hook needs no separate `unlockCallback` and exposes no no-swap escape
  hatch. The flush is fresh-only: the bid leg reverts the swap on a failed
  forward (`BidForwardFailed`), and the referral leg folds to the protocol
  escrow on a failed `ReferralPayout` payout, so the hook never holds funds
  between swaps.

**Design B callback isolation** (when a dispatcher is bound):

- Dispatcher's `afterSwap` calls `PCSwapContext.enterSwap()` before the
  callback loop and `exitSwap()` after.
- Each callback runs under a per-callback gas budget inside the
  dispatcher's try/catch — a failing callback (revert, OOG,
  selfdestruct) does NOT unwind the swap; the loop continues.
- A callback's attempt to reenter ANY decorated PC contract reverts
  `PCNoReentry.InSwap` (caught by the dispatcher's try/catch as a
  per-callback failure, not a swap failure).
- A callback's attempt to call `PCSwapContext.exitSwap()` reverts
  `NotAuthorizedExtension` (only the dispatcher is authorized).
  Verified by
  `test_fork_pcSwapContext_callbackCannotClearFlag` with a downstream
  observer callback still seeing inSwap == true.

## Permanent disclosures

> Permanent means irreversible within the rules of the deployed contracts.
>
> The work cannot guarantee the permanence of Ethereum.
>
> The work cannot guarantee the permanence of the CryptoPunks market contract.
>
> The work cannot guarantee the permanence of the WETH contract.
>
> The work cannot guarantee the permanence of the artcoins protocol or its LP locker.
>
> The work cannot guarantee the permanence of any allowlisted peer protocol (PunkStrategy or otherwise).
>
> The work cannot guarantee the permanence of the CryptoPunks cultural context.
>
> The work makes one commitment: within this system, once a Punk enters `PunkVault`, the work provides no path for it to leave.

## Known limitations

1. **Live-bid growth depends on 111 trading.** If trading volume is low,
   the live bid grows slowly. The protocol cannot force trading. Patrons
   can accelerate via `LiveBidAdapter.receive()` / `contribute()` top-ups
   (under inflow consolidation the adapter is the single faucet into
   Patron — direct sends to Patron revert `NotAdapter`). The top-up
   buffers in the adapter and meters into the live bid via `sweep`.
2. **Owner-acceptance requires owners to act.** If no eligible Punk owner
   ever accepts the live bid, the protocol stalls indefinitely. There is
   no timeout, no forced acquisition, no "must-buy" path.
3. **`acceptListing` requires aligned peer protocols to be allowlisted AND
   active.** Past the 1y admin lock, new peers can still be allowlisted —
   but they need to *exist* and *list Punks publicly* for the path to fire.
4. **Return-auction clears can outpace permanence.** A Punk that always
   clears never vaults. Traits never become permanent through paths that
   consistently clear. The live bid has to grow large enough that bidders
   won't clear at reserve.
5. **BuybackBurner depends on artcoins' LP staying intact.** If the artcoins
   locker is exploited or its LP is withdrawn (admin lever exists), the
   burner's swap path stops working. Same risk applies to any user trading
   on the pool.

   *Slippage-guard posture.* The burner does not try to maintain a price oracle
   or classify price moves. Its per-swap protection is the V4
   `sqrtPriceLimitX96` clamp derived from `maxSlippageBps = 500` (5%). If the
   pool would move farther, V4 partial-fills the exact-input swap and the
   unspent ETH stays queued. The cap is below the measured buy/sell fee moat, so
   the burner's own trade should never be large enough to make a same-block
   sandwich profitable. `maxStepWei` bounds the attempted amount, and caller
   `minOut` can only make an individual keeper stricter.

   A static tokens-per-ETH floor is intentionally absent: the pool is ETH→111,
   so tokens-per-ETH falls as 111 appreciates, and a fixed floor would tighten
   in the success case until it bricked every `executeStep`. EMA/reference-price
   state is intentionally absent too: a stateful guard can stale-wedge under
   organic appreciation. The simpler posture is to never push the pool hard
   enough to be worth sandwiching.
6. **Artcoins factory owner can pause future deploys.** Doesn't affect our
   pool post-launch but means a one-time live coordination is required at
   mainnet launch (factory must not be `deprecated = true` at the moment of
   our deploy tx).
7. **Artcoins V3 stack dependency.** All fee flow passes through the V3
   artcoins fee escrow + LP locker. A bug in those external contracts
   would freeze fee distribution. The pool is native-ETH paired so there's
   no WETH-contract dependency in our adapter / burner paths; the protocol
   also accepts native-ETH top-ups directly via `LiveBidAdapter`
   (`receive()` / `contribute()`), which buffers and meters them into the
   live bid.
8. **V4 ecosystem maturity.** V4 tooling (routing aggregators, indexers) is
   still developing.
9. **Persistent allowlist admin (V4-specific).** A compromised admin EOA past
   the 1y lock can still edit the allowlist. Worst case is reputational
   (allowlisting a misbehaving peer); financial damage is bounded by the
   listing-price-≤-live-bid invariant. The on-chain off-switch survives the
   lock: `transferAdmin(address(0))` is reachable at any time (only
   renewals/rotations are time-gated — auditor finding M-1), so the admin EOA
   owner can always burn the role to permanently disable the carve-outs if
   they stop managing the allowlist actively or suspect key compromise.
## Audit-style invariant checklist

These are the hard invariants the test suite must continue to assert across
any future change.

| # | Invariant | Test coverage |
|---|---|---|
| 1 | `collectedMask` monotonic | `PermanentCollection.t.sol`, `IntegrationFlow.t.sol` |
| 2 | `Acquisition[]` log append-only | `PermanentCollection.t.sol` (implicit via `recordAcquisition` revert paths) |
| 3 | Custody cycles `InReturnAuction → ReturnedToMarket → InReturnAuction …`; `Vaulted` terminal (rescued Punk re-auctionable, vaulted Punk never) | `ReAuction.t.sol`, `Invariants.t.sol::invariant_VaultedIsTerminal`, `PermanentCollection.t.sol::test_MarkCustody_*` |
| 4 | Acquisition does not imply collection | `PermanentCollection.t.sol::test_RecordAcquisition_DoesNotCollect`, `ReturnAuctionModule.t.sol::test_ClearedDoesNotCollect` |
| 5 | Returned-to-Market never collects | `IntegrationFlow.t.sol::test_FullFlow_AcceptBounty_FinalSaleClears_NoCollection` |
| 6 | Vaulted collects ONLY the recorded target trait | `IntegrationFlow.t.sol::test_FullFlow_AcceptBounty_FinalSaleUnsold_Collects` |
| 7 | No Punk leaves PunkVault / PermanentCollection | `PermanentCollection.t.sol::test_BytecodeNoMarketWrite`, `PunkVault.t.sol::test_BytecodeContainsNoMarketWriteSelectors` |
| 8 | return auction cleared split (65/25/10 of cost + premium) enforced; reserve enforced at bid time | `ReturnAuctionModule.t.sol::test_Cleared_65_25_10_Split`, `test_ClearedConstants_SumToBPSDENOM`, `test_BidBelowReserveReverts` |
| 9 | Only `Patron` calls `recordAcquisition`; only `ReturnAuctionModule` calls `markCustody` / vault receipt | `PermanentCollection.t.sol::test_RecordAcquisition_OnlyPatron`, `test_MarkCustody_OnlyFinalSale`, `PunkVault.t.sol::test_ReceivePunk_OnlyReturnAuctionModule` |
| 10 | No admin withdrawal path from Patron | `Patron.t.sol::test_BytecodeContainsNoAdminWithdrawSelectors` |
| 11 | Parameter bounds enforced | `Parameters.t.sol::test_Set*_BoundsEnforced` |
| 12 | Economic params (incl. the adapter rate-cap setters) freeze at 1y lock; allowlist editable past lock | `Parameters.t.sol::test_EconomicParamsLockedAfterTimerExpires`, `AcceptListing.t.sol::test_AllowlistEditable_AfterTimerExpiry`, `LiveBidAdapter.t.sol::test_RateCapSetters_LockAfterAdminExpiry` |
| 13 | `bidBalance == address(patron).balance` | Implicit; no separate accounting state. |
| 22 | Sole-carrier guard: while bit 23 (`"7 Attributes"`) is uncollected, acquiring #8348 (its unique carrier) must target bit 23 | `SoleCarrierGuard.t.sol::test_fork_*` (revert on wrong target via Patron mirror + the authoritative `recordAcquisition`; bit-23 target succeeds; inert once collected / for other Punks; live uniqueness scan; 111/111 matching saturates) |
