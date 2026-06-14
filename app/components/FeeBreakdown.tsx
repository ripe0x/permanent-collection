/* Phase-aware fee breakdown. Pure presentational: takes a precomputed
 * FeePhase (typically from `getCurrentFeePhase()` on the server, or a
 * URL-override on the /debug/fees page) and renders the routed legs.
 *
 * Variants:
 *   - `compact` (default on /trade and the homepage TokenSection) — one
 *     line per leg, percent + label + destination short-form.
 *   - `detailed` (used on /debug/fees) — adds the long-form destination
 *     and prose note for each leg.
 *   - `dark` — uses the dark surface palette from TokenSection.
 *
 * No client hooks, no RPC. Components that need the current phase
 * resolve it server-side and pass it in.
 */

import { buildFeeBreakdown, describePhase, TOTAL_FEE_PCT } from "@/lib/fees";
import type { FeePhase, RoutedLeg } from "@/lib/fees-types";
import { ANTI_SNIPER, fmtPct } from "@/lib/protocol-params";

export interface FeeBreakdownProps {
  phase: FeePhase;
  /** Layout density. */
  variant?: "compact" | "detailed";
  /** When set, swap to the dark-section palette (used in TokenSection). */
  surface?: "light" | "dark";
  /** Override the top label. Defaults to "{TOTAL_FEE_PCT} all-in fee, per
   *  swap" (the LP fee + baseline skim total, driven from
   *  `FEES.totalSwapFeePct` so it can't drift). */
  heading?: string;
  /** Show the phase label as a sub-heading. Defaults to true. */
  showPhaseLabel?: boolean;
  /** Render as a slideout, closed by default — the heading becomes the
   *  toggle (native details/summary, no client JS). Used by the two swap
   *  surfaces so the routing detail doesn't crowd the swap itself. */
  collapsible?: boolean;
}

export function FeeBreakdown({
  phase,
  variant = "compact",
  surface = "light",
  heading,
  showPhaseLabel = true,
  collapsible = false,
}: FeeBreakdownProps) {
  const rows = buildFeeBreakdown();
  const headingText =
    heading ?? `${fmtPct(TOTAL_FEE_PCT)} all-in fee, per swap`;
  const phaseText = describePhase(phase);

  const body = (
    <>
      {phase.mevWindowActive && (
        <div className="fb-mev" role="note">
          <strong>Anti-sniper window active.</strong> The skim is elevated above
          the {fmtPct(ANTI_SNIPER.baselinePct)} baseline and decays linearly to{" "}
          {fmtPct(ANTI_SNIPER.baselinePct)} over ~{ANTI_SNIPER.durationMin} min
          from pool init. Any overage routes 100% to the live bid.
        </div>
      )}
      <ul className="fb-rows">
        {rows.map((row) => (
          <li key={row.key} className={`fb-row fb-row-${row.key}`}>
            <FeeBreakdownRow row={row} variant={variant} />
          </li>
        ))}
      </ul>
      <div className="fb-total">
        <span className="fb-total-label">total</span>
        <span className="fb-total-pct tnum">{fmtPct(TOTAL_FEE_PCT)}</span>
      </div>
    </>
  );

  if (collapsible) {
    return (
      <details
        className={`fee-breakdown fee-breakdown-${variant} fee-breakdown-${surface} fb-collapsible`}
        aria-label="Pool fee routing"
      >
        <summary className="fb-summary">
          <span className="fb-head">
            <span className="fb-title">{headingText}</span>
            {showPhaseLabel && (
              <span className="fb-phase">phase · {phaseText}</span>
            )}
          </span>
          <span className="fb-chevron" aria-hidden="true" />
        </summary>
        <div className="fb-body">{body}</div>
        <style>{styles}</style>
      </details>
    );
  }

  return (
    <div
      className={`fee-breakdown fee-breakdown-${variant} fee-breakdown-${surface}`}
      aria-label="Pool fee routing"
    >
      <div className="fb-head">
        <span className="fb-title">{headingText}</span>
        {showPhaseLabel && (
          <span className="fb-phase">phase · {phaseText}</span>
        )}
      </div>
      {body}
      <style>{styles}</style>
    </div>
  );
}

function FeeBreakdownRow({
  row,
  variant,
}: {
  row: RoutedLeg;
  variant: "compact" | "detailed";
}) {
  const destText =
    variant === "detailed" ? row.destination : row.destinationShort;
  return (
    <>
      <div className="fb-row-top">
        <span className="fb-row-label">{row.label}</span>
        <span className="fb-row-pct tnum">
          {row.optional ? `≤ ${row.pct.toFixed(2)}` : row.pct.toFixed(2)}%
        </span>
      </div>
      {destText && (
        <div className="fb-row-dest">
          <span className="fb-row-arrow" aria-hidden="true">
            →
          </span>
          <span className="fb-row-dest-text">{destText}</span>
        </div>
      )}
      {variant === "detailed" && row.note && (
        <p className="fb-row-note">{row.note}</p>
      )}
    </>
  );
}

const styles = `
.fee-breakdown {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.fb-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.fb-title {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.fb-phase {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    color: var(--muted);
    opacity: 0.8;
}
.fb-mev {
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.5;
    color: var(--ink);
    border-left: 2px solid var(--accent);
    padding: 8px 10px;
    background: rgba(17, 17, 17, 0.06);
}
.fb-mev strong {
    color: var(--accent);
    font-weight: 500;
}
.fb-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.fb-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.fb-row-top {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--muted);
}
.fb-row-label {
    color: var(--muted);
}
.fb-row-pct {
    color: var(--ink);
    font-weight: 500;
}
.fb-row-dest {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    opacity: 0.85;
    padding-left: 2px;
}
.fb-row-arrow {
    color: var(--muted);
    opacity: 0.6;
}

.fb-total {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 14px;
    margin-top: 2px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 13px;
}
.fb-total-label {
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 11px;
    color: var(--muted);
}
.fb-total-pct {
    color: var(--ink);
    font-weight: 600;
}

/* Compact variant — denser, used inline on /trade and TokenSection. */
.fee-breakdown-compact {
    gap: 10px;
}
.fee-breakdown-compact .fb-rows {
    gap: 6px;
}
.fee-breakdown-compact .fb-row-dest {
    font-size: 10px;
}

/* Detailed variant — used on /debug/fees. Adds the prose note line. */
.fb-row-note {
    margin: 4px 0 0;
    padding: 0 0 0 12px;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.55;
    color: var(--muted);
    border-left: 1px solid var(--line);
}

/* Collapsible slideout (the two swap surfaces). Native details/summary —
   closed by default, heading is the toggle. Block display, not the flex
   column: when closed, the flex gap to the hidden body would otherwise
   add phantom space under the summary row. */
.fb-collapsible {
    display: block;
}
.fb-collapsible .fb-summary {
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    cursor: pointer;
    user-select: none;
    /* The summary carries the panel's padding (the wrapper boxes set
       padding: 0), so the entire visible strip is the click target. */
    padding: 18px 20px;
}
.fb-collapsible .fb-summary:hover {
    background: rgba(17, 17, 17, 0.04);
}
.fee-breakdown-dark.fb-collapsible .fb-summary:hover {
    background: rgba(255, 255, 255, 0.05);
}
.fb-collapsible .fb-summary::-webkit-details-marker {
    display: none;
}
.fb-chevron {
    flex: none;
    width: 7px;
    height: 7px;
    border-right: 1.5px solid var(--muted);
    border-bottom: 1.5px solid var(--muted);
    transform: rotate(45deg);
    transition: transform 180ms ease;
    margin-top: -3px;
}
.fb-collapsible[open] .fb-chevron {
    transform: rotate(225deg);
    margin-top: 3px;
}
.fb-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 6px 20px 18px;
}
.fb-collapsible[open] .fb-body {
    animation: fb-slide 200ms ease;
}
@keyframes fb-slide {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: translateY(0); }
}
.fee-breakdown-dark .fb-chevron {
    border-color: #9A9A9A;
}

/* Dark surface (TokenSection). Overrides palette but keeps structure. */
.fee-breakdown-dark .fb-title {
    color: #9A9A9A;
}
.fee-breakdown-dark .fb-phase {
    color: #9A9A9A;
}
.fee-breakdown-dark .fb-row-label,
.fee-breakdown-dark .fb-row-dest {
    color: #C8C8C8;
}
.fee-breakdown-dark .fb-row-pct {
    color: var(--bg);
}
.fee-breakdown-dark .fb-mev {
    color: var(--bg);
    border-left-color: var(--accent);
    background: rgba(255, 255, 255, 0.10);
}
.fee-breakdown-dark .fb-row-note {
    color: #C8C8C8;
    border-left-color: #3A3A3A;
}
.fee-breakdown-dark .fb-total {
    border-top-color: #3A3A3A;
}
.fee-breakdown-dark .fb-total-label {
    color: #9A9A9A;
}
.fee-breakdown-dark .fb-total-pct {
    color: var(--bg);
}
`;
