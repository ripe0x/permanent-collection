// Fee breakdown, built on the shared protocol-params config.
//
// SOURCE OF TRUTH: every number here comes from `./protocol-params`
// (`FEES`, `ANTI_SNIPER`), which mirrors the hook's `SkimHookFeeData`
// config set at `initializePool`. The hook splits the baseline skim THREE
// ways inside `_afterSwap`: a bid leg (~83.33% of baseline), a protocol
// leg (~16.67%), and a referral slice (≤0.25% of volume, pulled from the
// protocol leg). The referral slice is paid from the first swap whenever
// the swap carries attribution; with no referrer it stays in the protocol
// leg.
//
// There is no trading-fee vault-burn leg. VaultBurnPool is fed
// exclusively from cleared-auction proceeds in `ReturnAuctionModule.settle`
// and swept to BuybackBurner only on vault-path settle.
//
// Routing:
//   - bid leg → Patron (live bid), always.
//   - protocol leg → ProtocolFeePhaseAdapter (now a plain forwarder) →
//     PCController, FROM BLOCK 1 — no pre-acquisition Patron detour.
//     PCController splits ~86.67% PC-treasury / ~13.33% LAYER-burn.
//   - referral slice → the credited referrer whenever the swap carries
//     attribution (from block 1); otherwise it stays in the protocol leg
//     (→ PCController treasury / LAYER).
//
// Every leg routes the same way from block 1 — the routed breakdown is
// phase-independent. The MEV anti-sniper window elevates the skim above
// baseline and decays linearly; the antiSniperExtra (skim above baseline)
// routes 100% to the bid leg. In this UI model the MEV state is a separate
// "active" flag — the breakdown rows themselves use the steady-state
// baseline.

import { FEES } from "./protocol-params";
import type { FeePhase, RoutedLeg } from "./fees-types";

export type { FeePhase, RoutedLeg } from "./fees-types";

// All exports below are annotated `: number` so they widen from the
// `as const` config's non-widening literal types — consumers like
// `useState(POOL_FEE_PCT)` need `number`, not the literal `5`.

/** Baseline pool fee, % of swap volume. */
export const POOL_FEE_PCT: number = FEES.baselineSkimPct;

/** Baseline sub-splits as bps of the baseline skim (sum to 10_000),
 *  derived from the config. Exposed for the BidCalculator's
 *  percent-of-fee model (~83% bid / ~17% protocol). */
export const BOUNTY_BPS: number = Math.round(
  (FEES.bidLegPct / FEES.baselineSkimPct) * 10_000,
);
export const PROTOCOL_BPS: number = Math.round(
  (FEES.protocolLegPct / FEES.baselineSkimPct) * 10_000,
);

/** Maximum referral slice as bps of swap volume (100k-denom). The hook
 *  clamps the attributed `referralBps` from hookData to this cap, then to
 *  the protocol slice itself (referral never reduces the bid leg). */
export const MAX_REFERRAL_BPS_OF_VOLUME: number = FEES.referralCapBpsOfVolume;

/** Steady-state percentages of swap volume, sourced from the config so
 *  analytical UIs (BidCalculator, debug page) share one set of numbers. */
export const BOUNTY_PCT_OF_VOLUME: number = FEES.bidLegPct;
export const PROTOCOL_PCT_OF_VOLUME: number = FEES.protocolLegPct;
export const MAX_REFERRAL_PCT_OF_VOLUME: number = FEES.referralCapPct;

/** V4 LP fee, % of swap volume — paid to liquidity providers (not the
 *  hook). The conversion locker holds 100% of LP at launch and routes its
 *  share to the live bid. */
export const LP_FEE_PCT: number = FEES.lpFeePct;

/** All-in fee, % of swap volume = baseline skim + LP fee. */
export const TOTAL_FEE_PCT: number = FEES.totalSwapFeePct;

/** Where the protocol leg ultimately lands, in % of swap volume. The
 *  protocol leg (PROTOCOL_PCT_OF_VOLUME) less the max referral carve splits
 *  per the PCController ratio into the PC treasury ("team") and the
 *  artcoins $LAYER buy-and-burn ("artcoins protocol"). Sourced from the
 *  config so the breakdown sums exactly to TOTAL_FEE_PCT. */
const PROTOCOL_AFTER_REFERRAL = FEES.protocolLegPct - FEES.referralCapPct;
export const TEAM_PCT_OF_VOLUME: number =
  (PROTOCOL_AFTER_REFERRAL * FEES.pcTreasuryPct) / 100;
export const ARTCOINS_FEE_PCT_OF_VOLUME: number =
  (PROTOCOL_AFTER_REFERRAL * FEES.layerBurnPct) / 100;

/** Convenience: every defined phase as a tuple, ordered chronologically
 *  through the protocol's life. Useful for the debug walkthrough. */
export const ORDERED_PHASES: readonly FeePhase[] = [
  { postFirstAcquisition: false, postFirstVault: false, mevWindowActive: true },
  {
    postFirstAcquisition: false,
    postFirstVault: false,
    mevWindowActive: false,
  },
  { postFirstAcquisition: true, postFirstVault: false, mevWindowActive: false },
  { postFirstAcquisition: true, postFirstVault: true, mevWindowActive: false },
];

/** Short human label for each phase — used by the debug page tabs and
 *  on-page indicators. Doesn't claim transition order (the MEV window
 *  can technically still be active after an acquisition, though in
 *  practice it'll have closed first — ~30 min is much shorter than the
 *  first acquisition turnaround). */
export function describePhase(phase: FeePhase): string {
  if (phase.mevWindowActive) return "Anti-sniper window";
  if (!phase.postFirstAcquisition) return "Pre-first-acquisition";
  if (!phase.postFirstVault) return "Post-acquisition, pre-first-vault";
  return "Steady state (post-vault)";
}

/** Build the routed fee breakdown. Pure function — no RPC, no I/O.
 *  Components render this output directly. Returns every destination an
 *  all-in swap fee splits into: live bid, LP, team (PC treasury), the
 *  optional swap referral, and artcoins protocol ($LAYER burn). The five
 *  legs sum to TOTAL_FEE_PCT.
 *
 *  The breakdown is phase-independent: every leg routes the same way from
 *  block 1. The swap-referral leg is credited to a referrer whenever the
 *  swap carries attribution; with no referrer the slice stays in the
 *  protocol leg. The protocol leg goes straight to the PCController
 *  (treasury / LAYER split), with no pre-acquisition Patron detour. */
export function buildFeeBreakdown(): RoutedLeg[] {
  const liveBidRow: RoutedLeg = {
    key: "live-bid",
    label: "live bid",
    pct: BOUNTY_PCT_OF_VOLUME,
    destination: "Patron — grows the standing live bid",
    destinationShort: "",
    note: "Flushes to LiveBidAdapter on every swap and sweeps to Patron — the standing ETH offer an eligible Punk owner can accept.",
  };

  const lpRow: RoutedLeg = {
    key: "lp",
    label: "liquidity (LP)",
    pct: LP_FEE_PCT,
    destination:
      "Protocol-owned LP (V4 standard) — the locker routes its fees to the live bid at launch",
    destinationShort: "protocol owned LP fees go to the live bid",
    note: "Standard Uniswap V4 LP fee, paid pro-rata to in-range liquidity — not taken by the hook. At launch the conversion locker holds 100% of the LP positions and routes its share to LiveBidAdapter, so the LP fee feeds the live bid until public LPs add depth.",
  };

  const teamRow: RoutedLeg = {
    key: "team",
    label: "team",
    pct: TEAM_PCT_OF_VOLUME,
    destination: "",
    // Compact surfaces (the /trade + homepage breakdown) show the team
    // leg as label + percent only — the empty short form omits the
    // destination line there. The detailed /debug page still renders the
    // long-form destination above.
    destinationShort: "",
    note: "The PC-treasury share of the protocol leg, routed by PCController. Flows from block 1 — there is no pre-acquisition phase gate on this leg.",
  };

  const artcoinsRow: RoutedLeg = {
    key: "artcoins-fee",
    label: "artcoins protocol",
    pct: ARTCOINS_FEE_PCT_OF_VOLUME,
    destination: "$LAYER buy-and-burn — via PCController (from block 1)",
    destinationShort: "$LAYER burn",
    note: "The artcoins-protocol share of the protocol leg — a $LAYER buy-and-burn, routed by PCController. Flows from block 1, same as the team share.",
  };

  const referralRow: RoutedLeg = {
    key: "referral",
    label: "swap referral",
    pct: MAX_REFERRAL_PCT_OF_VOLUME,
    destination:
      "Referrer — pulled from the protocol leg if a swap carries attribution",
    destinationShort: "build on the protocol and earn",
    note: `Capped at ${MAX_REFERRAL_PCT_OF_VOLUME}% of swap volume. Pulled FROM the protocol leg (never reduces the live-bid leg). Credited from the first swap whenever the swap carries attribution; with no referrer the slice stays in the protocol leg and folds into the team / artcoins split.`,
  };

  return [liveBidRow, lpRow, teamRow, referralRow, artcoinsRow];
}

/** All-in % of swap volume the breakdown accounts for — the sum of every
 *  leg (bid + LP + team + artcoins + max referral) = TOTAL_FEE_PCT. */
export function totalFeePctOfVolume(rows: RoutedLeg[]): number {
  return rows.reduce((acc, r) => acc + r.pct, 0);
}
