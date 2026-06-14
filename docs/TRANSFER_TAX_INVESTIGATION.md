# Transfer Tax Investigation and Design Spec

> Status: CANONICAL, maintained. Last updated 2026-06-04. This is the single
> design-rationale document for the 111 venue-scoped buy-side transfer tax.
> Numbers here are the live launch values (taxBps = 1500 / 15%, cap 2000 / 20%);
> the empirical backing for those values is the router investigation in
> [`docs/router-results/FINAL_ROUTER_REPORT.md`](router-results/FINAL_ROUTER_REPORT.md).
> Behavior is covered by [`contracts/test/TaxedTokenForkTest.t.sol`](../contracts/test/TaxedTokenForkTest.t.sol)
> (17 adversarial fork tests at `TAX_BPS = 1500`). Keep this doc in sync with any
> change to a `TaxConfig` field, the cap constant, the venue set, or the
> attestation gating (see the doc-maintenance rules in `CLAUDE.md`).

This is a NEW permanent surface on an IMMUTABLE token. The cap raise (from the
original 5% to 20%) and the launch rate (15%) require a fresh focused audit plus
an artcoins submodule push and pin bump before the mainnet broadcast.

---

## 1. TL;DR

The 111 ERC20 (`ArtCoinsToken`) carries a venue-scoped buy-side transfer
tax. It fires ONLY when 111 leaves a known DEX venue to a non-exempt recipient
(a buy / pool outflow on a non-canonical pool). The canonical pool is exempted
per swap by a hook-attested, amount-pinned EIP-1153 budget. Tax proceeds accrue
in `VaultBurnPool` and are burned (real `burn()`, dropping `totalSupply`) on
each vault-path settle, alongside the ETH sweep the pool already forwards to
BuybackBurner. Sells, wallet/Safe/4337 sends, lending, bridges, and CEX
transfers are never taxed.

| Setting | Launch value | Notes |
|---|---|---|
| Trigger | `taxEnabled && taxBps != 0 && _isTaxVenue(from) && !exempt[to]`, minus the canonical budget | Fires on 111 leaving a venue to a non-exempt recipient. |
| Rate (`taxBps`) | 1500 (15%) | Tunable in `[0, taxBpsMax]`. |
| Deploy cap (`taxBpsMax`) | 2000 (20%) | Deploy-time immutable, in `[0, TAX_BPS_ABSOLUTE_MAX]`. |
| Compile backstop (`TAX_BPS_ABSOLUTE_MAX`) | 2000 (20%) | Makes "never above 20%" structural. |
| Proceeds | accrue in `VaultBurnPool`, burned (`burn()`, `totalSupply` drops) on each vault-path settle | No ETH conversion, no LP. |
| Canonical exemption | hook-attested amount-pinned EIP-1153 budget | `attestCanonicalBudget(poolId, pctOut)`, gated to `canonicalHook` + `canonicalPoolId`. |
| V4 venue coverage | the PoolManager singleton | One check covers every V4 pool, canonical and side, present and future. |
| V2/V3 venue coverage | 44 precomputed pools, frozen at deploy | {UniV2, Sushi, PancakeV2} × {WETH, USDC, USDT, DAI} + {UniV3, PancakeV3} × same × 4 tiers. CREATE2-derived from `address(this)` in the constructor. No add path. |
| Exempt recipients | BuybackBurner, conversion locker | PC contracts that receive 111 from the PoolManager. |
| Rate setter | `TokenAdminPoker.setTokenTaxBps` | Two-key carve-out: `TokenAdminPoker.owner` OR `ProtocolAdmin.admin()`. |

The launch token is created via the factory's
`deployTokenWithProtocolBpsAndTax(cfg, 0, taxConfig)` entry point. The tax is
default-off shared infrastructure on `ArtCoinsToken`; every other coin the
factory launches passes an empty `TaxConfig` and is a plain, untaxed ERC20.

---

## 2. The problem this defends against (the leakage thesis)

Only the canonical V4 pool funds the Punk live bid. The skim hook
(`ArtCoinsHookSkimFee`) takes a 5% baseline skim on both swap directions and
routes the bid leg to `LiveBidAdapter` then `Patron`. A competing 111 pool on
any other venue (a Uniswap V2/V3 side pool, another V4 pool) does NOT skim ETH
for the bid. This is the PNKSTR-style side-pool starvation pattern: liquidity
and volume migrate to an off-canonical pool, the canonical skim dries up, and
the live bid is starved even though the token is trading actively.

The asymmetry is sharpest on the sell side:

| Action | Grows the bid? | Trader frictions |
|---|---|---|
| Canonical buy | Yes (4% of volume) | 5% skim + 0.5% LP |
| Canonical sell | Yes (4% of volume) | 5% skim + 0.5% LP |
| Side buy | No (burns the 111 token) | side LP + `taxBps` |
| Side sell | No (pure leak) | side LP only (for example 0.3% to 1%) |

A canonical sell costs the trader the full canonical fee; an untaxed side sell
costs only the side LP fee. Absent any price difference, every rational sell
routes to the side pool and the bid is starved. Side sells are the leak.

You cannot tax the sell directly: a sell is the 111 token moving INTO a pool, so the
sender is the trader, not a venue. Taxing that leg would break the pool's
constant-product invariant (the pool receives less than the swap math expects)
and revert the swap. The buy tax is the only lever, and it works indirectly:
it suppresses the side pool's raw price (buyers will not buy there until it is
cheap enough to offset the tax), and a suppressed raw price is what makes an
untaxed side SELL net less ETH than a canonical sell. The core sizing question
is therefore:

> How large must `taxBps` be so that the side pool's arbitrage-induced price
> discount is deep enough that even an untaxed side sell nets less ETH than a
> canonical sell paying the full canonical fee?

---

## 3. The mechanism

### 3.1 Trigger condition

In the token's `transfer` / `transferFrom` override
(`ArtCoinsToken._taxedTransfer`), the tax fires only when ALL of:

1. `taxEnabled` (set true only for 111; false on every other coin).
2. `taxBps != 0`.
3. `_isTaxVenue(from)` (the SENDER is a known venue; see 3.3).
4. `!exempt[to]` (the recipient is not on the exempt allowlist; see 3.5).

and the canonical-exemption budget does not already cover the transferred
amount (see section 4). The tax is computed only on the portion not covered by
the budget:

```
exemptAmt = min(canonicalBudget, amount)   // amount-pinned, partial-consumes
taxable   = amount - exemptAmt
tax       = taxable * taxBps / 10_000
```

If `tax != 0`, the override does two ERC20 transfers (net to the recipient,
`tax` to the burn sink `VaultBurnPool`) and emits `TaxApplied(from, to, gross,
tax, net)`. Otherwise it is a single plain transfer. On `transferFrom`, the
allowance debit is the full `gross` (it matches what the user signed). The 111
that lands in `VaultBurnPool` is held there until the pool's next vault-path
settle, which burns it via the token's real `burn()` (see 3.4).

### 3.2 Why "buy-side" and "leaving a venue"

The tax keys on `from` being a venue. A DEX buy realizes as the pool (a venue)
sending 111 out to the buyer, so the buy is taxed. A sell is the trader sending
111 into the pool, so `from` is the trader, not a venue, and the sell is never
taxed (and never reverts the pool). LP seeding is also 111 moving into the pool,
so it is never taxed either.

### 3.3 Venue set

Two layers, both fixed at deploy with no dynamic add path:

- **V4: the PoolManager singleton.** A single `from == taxPoolManager` check
  covers every V4 pool that exists or will ever exist, canonical and side
  alike. The canonical V4 pool is then carved back out per swap by the
  attestation budget (section 4), so in practice only off-canonical V4 buys are
  skimmed.
- **V2/V3: 44 precomputed pool addresses.** {Uniswap V2, SushiSwap V2,
  PancakeSwap V2} × {WETH, USDC, USDT, DAI} (12) plus {Uniswap V3, PancakeSwap
  V3} × {WETH, USDC, USDT, DAI} × 4 fee tiers (32). Each address is
  CREATE2-derived from `address(this)` in the token's constructor and frozen
  there. Two PancakeSwap-V3 subtleties are handled in the derivation: its pools
  are CREATE2-deployed by a separate `PoolDeployer` (not the factory), and its
  enabled 0.25% tier is `2500` (Uniswap's is `3000`). Every one of the 44 is
  verified live by `TaxedTokenForkTest::test_precomputedVenues_allMatchLiveFactories`,
  which creates the real pool on each factory and asserts the constructor-derived
  address matches.

The venue set covers the **liquid** side-pool space — the AMM pools a side venue
could realistically attract depth on. It is structurally unable to cover
wrapper/vault tokens, OTC/RFQ desks, or CEX distribution (the 111 token dispensed from any
non-venue contract is untaxed), which is an inherent ceiling of any from-side
venue tax: the token cannot distinguish a pool from any other holder without
either enumeration or a heuristic that would break Safe/4337/bridge/lending/CEX
flows. The depth moat (locker dominance) + the canonical skim, not the tax, are
the primary defense; the tax is a deterrent on casual fragmentation.

There is intentionally NO function to add a venue after deploy. The set is
generous by design (it covers the venues a side pool would realistically use)
and is structurally incapable of growing, so the tax can never be pointed at a
new, unintended `from`.

### 3.4 Proceeds: burn, not convert

The tax slice is transferred to `taxBurnAddress = VaultBurnPool`, which burns it
(`token.burn`, totalSupply drops) on each vault-path settle. It is never
converted to ETH and never LP'd. Two reasons:

- **No sell pressure.** Converting the burned 111 to ETH would mean selling 111 into
  the pool, which is exactly the pressure the protocol is trying to remove.
- **No perpetual ETH liability.** LP'ing the proceeds would require a perpetual
  ETH side to pair, which the tax does not produce.

The burn is a deflationary byproduct. It is NOT how the tax funds the bid (see
section 5.1).

### 3.5 Exempt recipients

The `to`-side exempt allowlist is `{BuybackBurner, conversion locker}`. These
are the PC contracts that legitimately receive 111 directly from the PoolManager
(the burner buys the 111 token to burn; the locker holds the LP positions) and must not be
skimmed on those flows. The allowlist is set at deploy and is the complete set.

### 3.6 What is never taxed

- Sells (111 into any pool): `from` is the trader, not a venue.
- LP seeding (111 into a pool): same.
- Wallet-to-wallet, Safe, ERC-4337 sends: `from` is an account, not a venue.
- Lending deposits/withdrawals, bridges, CEX hot-wallet transfers: same.
- Canonical buys and canonical LP exits: venue sender, but covered by the
  attestation budget (section 4).

In every non-DEX context the token is a clean ERC20. It is mechanically a
fee-on-transfer token in exactly one narrow context (111 leaving a DEX venue on
a buy), and only off-canonical buys are actually skimmed.

---

## 4. The canonical-exemption budget (amount-pinned, hook-attested)

The hardest part of the design is exempting the canonical pool without opening a
hole that a side route can drive through. A boolean "canonical is exempt" flag
would bleed across an aggregator split route (one tx that buys some 111
canonically and some 111 off-canonical), exempting the side leg too. The
solution is an amount-pinned budget in EIP-1153 transient storage.

### 4.1 Attestation

The factory-blessed canonical hook calls
`attestCanonicalBudget(poolId, pctOut)` on the token:

- in `_afterSwap`, with the realized 111-out of a canonical buy, and
- in `_afterRemoveLiquidity`, with the 111 a public LP is withdrawing from the
  canonical pool (so a legitimate LP exit is not taxed).

The call is gated two ways (defense in depth):

- `msg.sender == canonicalHook` (the deployed hook only; reverts
  `NotCanonicalHook` otherwise), and
- `poolId == canonicalPoolId` (a side pool or an `initializePoolOpen` pool
  earns no budget; a mismatched pool id is silently ignored, no revert).

### 4.2 Amount-pinned consumption

The budget is a `uint256` in transient storage, not a boolean:

- `attestCanonicalBudget` accumulates: multiple canonical legs in one tx add up.
- `_taxedTransfer` consumes `min(budget, amount)` and taxes only the remainder.
- The slot is transient (`tstore`/`tload`), so it auto-clears at the end of the
  tx. It can never persist a stale exemption into a later tx.

This makes the exemption exact. In an aggregator split route, the canonical leg
consumes exactly its attested amount and the side leg in the same tx is taxed on
the rest. Proven by `test_aggregatorSplit_canonExemptSideTaxed`,
`test_attest_amountPinned_andConsumed`, `test_attest_wrongPoolId_ignored`, and
`test_budget_accumulatesWithinTx`.

---

## 5. Bounded-but-not-self-defeating subsidy semantics

The tax is, in effect, a subsidy to canonical routing: it makes canonical the
cheaper route for buyers, which pushes volume onto the canonical pool. Getting
the size right means it must be bounded on BOTH sides, or it defeats its own
purpose.

### 5.1 The subsidy is indirect, and the burn is not the funding

The protocol pays no one. The tax removes the discount that would otherwise
reward off-canonical trading. The bid grows because more volume routes through
the canonical pool, whose hook skims ETH into the bid. The burned proceeds are a
deflationary side effect, not the funding mechanism. Side-pool token burns are
NOT ETH into the bid; only the canonical skim grows the bid.

### 5.2 Too low is self-defeating

At 5% (the original launch value), against a typical 0.3%-LP side pool, the side
buy cost (about 5.3%) is below the canonical cost (about 6% at the original 6%
canonical fee). The tax is sub-parity: it induces roughly zero routing discount,
so the untaxed side sell leak stays wide open. A tax that does not move routing
is pure friction with no defensive benefit. (This corrects an earlier
"5% = parity" assumption, which had wrongly assumed a 1%-LP side pool.)

### 5.3 Too high is also self-defeating

Past the defended rate, extra tax buys no additional leak defense and starts
doing harm: the side pool becomes barely usable, side LPs are punished, and the
token reads as a hostile fee-on-transfer token to integrators and aggregators
(quote shortfalls, FOT warnings, refusal to list). The token must stay legible
as a normal fee-bearing ERC20 in the one narrow DEX-buy context. So the rate is
capped (`taxBpsMax = 2000`, backed by `TAX_BPS_ABSOLUTE_MAX = 2000`), and the
launch value sits at the bottom of the defended band with headroom, not at the
ceiling.

### 5.4 The three-layer cap and the two-key tuning carve-out

```
taxBps (runtime, two-key carve-out)  in  [0, taxBpsMax]
taxBpsMax (deploy immutable)         in  [0, TAX_BPS_ABSOLUTE_MAX]
TAX_BPS_ABSOLUTE_MAX (compile const) =   2000   // 20%, structural ceiling
```

The rate is tunable forever within `[0, taxBpsMax]` via
`TokenAdminPoker.setTokenTaxBps`, gated by a two-key carve-out: callable by
EITHER `TokenAdminPoker.owner` OR the `ProtocolAdmin.admin()` EOA. The rate
therefore stays tunable past the 1-year ProtocolAdmin lock AND past
`TokenAdminPoker.transferOwnership(<dead>)`; it freezes only when BOTH roles are
burned. This is one of the protocol's three persistent admin carve-outs (the
others: the seller allowlist and `setHookMaxReferralBps`). The rationale, shared
with hard invariant #12, is that the right tax rate tracks a side-pool
competition regime that shifts over the protocol's lifetime, so freezing the
launch value permanently would be wrong. The 20% structural ceiling means the
carve-out can never push the rate into self-defeating territory.

---

## 6. Rate sizing: 15% launch, 20% cap (router investigation)

The launch values come from a two-phase router investigation (full data in
[`docs/router-results/FINAL_ROUTER_REPORT.md`](router-results/FINAL_ROUTER_REPORT.md)).

### 6.1 Phase 1: leak economics (controlled deep-pool fork sweeps)

Authoritative for the sizing. From executed deep-pool fork swaps with the real
hook, real canonical depth, and a side-tax rate sweep:

- **5% fails.** Sub-parity vs a 0.3%-LP side pool; induces about 0% discount;
  the side sell leak stays open. Must not ship.
- **12.5% is the floor; 15% is the first clean defense with margin** at 6%
  canonical / 0.3% side LP, across all trade sizes. Small trades are the hardest
  to defend (their sell-flip sits at a deeper discount) and set the required
  rate.
- **A lower canonical fee helps materially.** At 5.5% canonical the needed tax
  drops toward roughly 10% to 12.5%, so 15% at 5.5% canonical carries
  comfortable margin. This is why the launch lowered the LP fee to 0.5% (total
  canonical 5.5% = 5% skim + 0.5% LP).
- **20% over-tunes.** At 5.5% canonical / 0.3% side LP, 15% already defends with
  margin; 20% makes the side pool barely usable and punishes side LPs without a
  corresponding leak-defense gain. Keep 20% as a tunable contingency ceiling,
  not a launch value.

Analytic anchor (the fork uses actual execution deltas, this is just the model):

```
buy-neutral side discount  ~  1 - (1 - side_buy_tax) / (1 - canon_total_fee)
canonical SELL wins once    induced_discount  >~  canon_total_fee - side_LP
worked: canon 5.5%, tax 15%, side LP 0.3%
        induced discount ~ 1 - 0.85/0.945 ~ 10.05%
        canonical sell wins sells once discount >~ 5.2%  -> 15% clears it with margin
```

### 6.2 Phase 2: public router and UX behavior (mainnet decoy)

A tiny anonymous mainnet decoy token (no PC branding) tested how live routers
and front-ends treat a venue-scoped-tax token. Authoritative for router/UX, not
for leak economics (the decoy's side pool was intentionally too shallow to
reproduce the depth-dependent leak):

- **No canonical poisoning.** 0x's tax fields are route-specific: `buyTaxBps = 0`
  whenever 0x routes the canonical pool, the tax rate only when it routes the
  taxed side. Canonical buys are quoted clean.
- **Front-ends are mostly transparent or protective.** Matcha (0x UI) shows a
  buy-tax warning only when it selects the taxed side route; DeFiLlama and Kyber
  reliably route canonical. ParaSwap is the one outlier: it silently misquotes
  taxed side buys (gross), a UX/revert risk for ParaSwap users, not protocol-
  fixable; PC's own frontend always routes canonical.
- **Operational caveat.** 0x's V4 indexing flickered for the ~$200-TVL decoy
  pool; expected to be stable on a deep real pool. Worth a post-launch spot-check
  once the real pool and any side pools exist.
- **Open item.** The decoy exempted canonical by "PoolManager is not a venue",
  not by the real token's per-swap hook attestation. Whether 0x's route
  simulation treats the real HOOKED canonical pool as untaxed is the one
  unresolved follow-up; schedule it only if 0x canonical-buy behavior is deemed
  launch-critical.

### 6.3 Net recommendation (adopted)

Launch: canonical total 5.5% (4% bid / 1% protocol / 0.5% LP), side buy tax 15%,
side sell tax 0% (structural), ceiling tunable to 20%, never 5%.

---

## 7. Alternatives considered and rejected

- **Tax the sell leg directly.** Rejected: a sell is 111 into a pool, so taxing
  it shorts the pool's constant-product math and reverts the swap. The leak is
  closed indirectly via the buy tax suppressing the side price.
- **Convert tax proceeds to ETH and feed the bid.** Rejected: that is selling
  111 into the pool, the exact sell pressure the design removes. Burn instead.
- **LP the tax proceeds.** Rejected: needs a perpetual ETH side to pair, which
  the tax does not produce.
- **Tax all transfers (a flat FOT token).** Rejected: breaks composability in
  every non-DEX context (wallets, Safe, 4337, lending, bridges, CEX) and makes
  the token broadly hostile to integrators for no defensive gain.
- **Boolean canonical exemption.** Rejected: bleeds across an aggregator split
  route, exempting the side leg. Replaced by the amount-pinned EIP-1153 budget.
- **A dynamic venue-add path (admin can register new venues).** Rejected: a
  permanent admin lever pointing a tax at arbitrary `from` addresses. Replaced
  by a generous precomputed set frozen at deploy plus the V4-singleton catch-all.
- **A separate per-venue tax rate.** Rejected: one global `taxBps` with the
  canonical pool carved out per swap is simpler and has a smaller surface.
- **Launch at 5%.** Rejected: sub-parity, does not move routing (Phase 1).
- **Freeze the rate at 15%.** Rejected: the side-pool competition regime shifts;
  the two-key carve-out keeps the rate tunable within `[0, 20%]`.
- **Set the ceiling at 25% for maximum tuning flex.** Rejected: 20% is past the
  defended rate already; a higher ceiling only enlarges the self-defeating band.

---

## 8. Invariant linkage

- **Hard invariant #21** is the structural statement of this mechanism: the tax
  fires only on 111 leaving a known venue to a non-exempt recipient; the
  canonical pool is exempted by the amount-pinned hook-attested budget; the rate
  is bounded `[0, taxBpsMax = 2000]` with the token's
  `TAX_BPS_ABSOLUTE_MAX = 2000` making "never above 20%" structural.
- **Hard invariant #12** lists `TokenAdminPoker.setTokenTaxBps` as one of the
  three persistent ProtocolAdmin carve-outs (two-key gate; freezes only when both
  roles are burned).

If you change the venue set, the cap, the exempt set, the attestation gating, or
the burn sink, you are changing a hard invariant. Update #21 (and #12 if the
setter gating changes) in the same commit, per the doc-maintenance rules.

---

## 9. Test coverage

[`contracts/test/TaxedTokenForkTest.t.sol`](../contracts/test/TaxedTokenForkTest.t.sol)
exercises the live `Deploy.s.sol` bytecode on a mainnet fork at `TAX_BPS = 1500`
(17 adversarial fork tests):

- Canonical buy exempt; canonical LP add/remove exempt (the
  `_afterRemoveLiquidity` attest path).
- V4 side-pool buy taxed; precomputed Uniswap V2 buy taxed (validates the
  constructor venue derivation against the real `createPair` address).
- Canonical sell, V2 sell, wallet-to-wallet, and contract-to-contract all
  untaxed and non-reverting.
- PC adapters (BuybackBurner, conversion locker) exempt even on a direct
  venue-to-adapter transfer.
- Budget: hook-only attestation, amount-pinned consumption, wrong-pool-id
  ignored, accumulation within a tx, aggregator-split (canonical leg exempt /
  side leg taxed in one tx).
- Proceeds land in `VaultBurnPool` (the tax `burnAddress`) and are burned on each vault-path settle.
- Rate setter: two-key carve-out plus the bound check (over-cap reverts,
  unauthorized caller reverts, ProtocolAdmin EOA can set, rate 0 is inert).
- Dormant on a non-PC token (empty `TaxConfig`): zero behavior change.

Run:

```bash
MAINNET_RPC_URL=https://gateway.tenderly.co/public/mainnet \
  forge test --match-contract TaxedTokenForkTest -vv -j 4
```

(The `MockTaxVenueToken` test double used by the router sweep copies
`_taxedTransfer` / `_isTaxVenue` / `attestCanonicalBudget` byte-for-byte from
`ArtCoinsToken`, with only the cap parametrized so the experiment can explore
rates above 5%, and a fidelity test asserts byte-match at 5%.)

---

## 10. Launch and audit status

- **Launch values:** `taxBps = 1500` (15%), `taxBpsMax = 2000` (20%),
  `TAX_BPS_ABSOLUTE_MAX = 2000`. Set in the token `TaxConfig` passed to the
  factory via `deployTokenWithProtocolBpsAndTax`; see
  [`contracts/script/Deploy.s.sol`](../contracts/script/Deploy.s.sol) for the
  full `TaxConfig` and every deploy constant.
- **Audit:** new permanent surface on an immutable token, a genuine one-shot.
  The cap raise from the original 5% to 20% and the 15% launch rate are the
  delta to re-audit (token transfer path, both hook attestation paths, canonical
  budget correctness under aggregator splits). See the threat-model entry in
  [`docs/SECURITY.md`](SECURITY.md).
- **Submodule:** the cap-raise also requires pushing the artcoins submodule and
  bumping the pin in permanent-collection before the broadcast (the tax-aware
  `ArtCoinsFactory` and `ArtCoinsToken` bytecode live there).

---

## 11. Related documents

- [`docs/router-results/FINAL_ROUTER_REPORT.md`](router-results/FINAL_ROUTER_REPORT.md):
  consolidated Phase 1 + Phase 2 results and the final fee/tax recommendation.
- [`docs/SYSTEM.md`](SYSTEM.md) and [`docs/PROTOCOL.md`](PROTOCOL.md): the
  reader-facing `TaxConfig` summary tables.
- [`docs/SECURITY.md`](SECURITY.md): trust boundaries and the audit ask (T7).
- [`docs/COMPOSABILITY.md`](COMPOSABILITY.md): integrator-facing notes on
  treating the 111 token as a venue-scoped FOT token in router/aggregator contexts.
