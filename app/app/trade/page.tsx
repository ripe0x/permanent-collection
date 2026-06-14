import type { Metadata } from "next";
import { FeeBreakdown } from "@/components/FeeBreakdown";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import {
  LiveBidPending,
  LiveBidStat,
  LiveBidSweepMover,
  LiveBidUsd,
} from "@/components/LiveBidStat";
import { SwapBox } from "@/components/SwapBox";
import { getTokenSymbol, getTokenTicker } from "@/lib/config";
import { getDataAdapter } from "@/lib/data";
import { buildMeta } from "@/lib/meta";
import { FEES, fmtPct } from "@/lib/protocol-params";
import { getCurrentFeePhase } from "@/lib/server/fee-phase";

const TOKEN_SYMBOL = getTokenSymbol();
const TICKER = getTokenTicker();

export const dynamic = "force-dynamic";

export const metadata: Metadata = buildMeta({
  title: `Trade ${TOKEN_SYMBOL}`,
  description: `Buy or sell ${TOKEN_SYMBOL} in the official pool. Every trade grows the live bid.`,
  path: "/trade",
});

export default async function TradePage() {
  const adapter = getDataAdapter();
  // Best-effort fetch of indexer-backed stats. The SwapBox itself reads
  // directly from chain, so an indexer outage must not block the swap UI.
  // We render "—" for the affected stat when this fails.
  const [phase, state] = await Promise.all([
    getCurrentFeePhase(),
    adapter.getProtocolState().catch(() => null),
  ]);

  return (
    <>
      <Header />
      <main id="top">
        <section className="trade-page">
          <div className="wrap trade-layout">
            <div className="trade-header">
              <h1 className="section-title">Trade {TICKER}.</h1>
            </div>
            <div className="trade-swap">
              <SwapBox />
            </div>
            <div className="trade-intro">
              <p className="section-copy">
                Trading is how the live bid grows. The more {TICKER} changes
                hands, the more ETH flows to the standing live bid that an
                eligible Punk owner can accept.
              </p>
              <div className="trade-stats">
                <div className="trade-stat">
                  <span className="trade-stat-label">Current live bid</span>
                  {/* SSR snapshot hands off to a client component
                   *  that reads `Patron.bidBalance` live and
                   *  flashes a green "+0.XXX ETH" badge when it
                   *  rises. The three-leg hook split accrues into
                   *  each adapter at swap-time and flushes within
                   *  the same tx — the live bid grows with no
                   *  manual sweep — and SwapBox refetches this
                   *  read after each swap. */}
                  <LiveBidStat
                    initialWei={state ? state.liveBidWei.toString() : "0"}
                  />
                  {/* "≈ $X" dollar annotation under the figure — same polled
                   *  read, priced at the shared ETH/USD spot. */}
                  <LiveBidUsd
                    initialWei={state ? state.liveBidWei.toString() : "0"}
                  />
                  <LiveBidPending
                    initialWei={
                      state ? state.liveBidPendingWei.toString() : "0"
                    }
                  />
                </div>
                <div className="trade-stat">
                  <span className="trade-stat-label">Permanent traits</span>
                  <strong className="trade-stat-value tnum">
                    {state ? `${state.collectedCount} / 111` : "— / 111"}
                  </strong>
                </div>
              </div>
            </div>
            <div className="trade-body">
              {/* Sweep affordance sits in the vertical gap between
               *  the stats row above and the fee-routing row below.
               *  Explainer is always visible so the pending/live
               *  concept is legible even with nothing pending; the
               *  action button only surfaces when there's ETH to
               *  move. */}
              <LiveBidSweepMover />
              <div className="trade-fees">
                <FeeBreakdown phase={phase} variant="compact" collapsible showPhaseLabel={false} />
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />

      <style>{styles}</style>
    </>
  );
}

const styles = `
.trade-page {
    padding-top: clamp(60px, 9vh, 100px);
    padding-bottom: clamp(80px, 12vh, 160px);
    border-top: none;
}
.trade-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 0.9fr);
    grid-template-areas:
        "header swap"
        "intro  swap"
        "body   swap";
    column-gap: clamp(40px, 6vw, 88px);
    row-gap: 22px;
    align-items: start;
    /* The swap column spans all three rows, so its height inflates the
       row tracks and spreads the left column apart. Pin the first two
       rows to their content and let the LAST row absorb the slack (its
       item is start-aligned, so the slack stays empty). */
    grid-template-rows: auto auto 1fr;
}
.trade-intro {
    grid-area: intro;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 22px;
}
.trade-header {
    grid-area: header;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 22px;
}
.trade-header .section-title {
    overflow-wrap: anywhere;
}
.trade-body {
    grid-area: body;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 22px;
}
.trade-stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    margin-top: 8px;
}
.trade-stat {
    background: var(--panel);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.trade-stat-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.trade-stat-value {
    font-family: var(--mono);
    font-size: 22px;
    color: var(--ink);
    letter-spacing: -0.02em;
}
.trade-fees {
    background: var(--panel);
    border: 1px solid var(--line);
    /* The collapsible breakdown inside carries its own padding so its
       whole strip is the click target. */
    padding: 0;
}
.trade-swap {
    grid-area: swap;
    min-width: 0;
    position: sticky;
    top: 78px;
}

@media (max-width: 880px) {
    .trade-layout {
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas:
            "header"
            "intro"
            "swap"
            "body";
        row-gap: 32px;
    }
    .trade-swap {
        position: static;
    }
}
`;
