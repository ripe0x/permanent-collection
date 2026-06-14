/* The hero. Two-column on desktop (copy left, artwork right), stacks on
   mobile. Every number on screen is a live read; the AsOfBadge gives the
   user a way to tell. */
import Link from 'next/link';
import {Artwork} from './Artwork';
import {BidFacts} from './BidFacts';
import {LiveBidPending, LiveBidStat, LiveBidUsd} from './LiveBidStat';
import {ProgressBar} from './ProgressBar';
import {getTokenSymbol} from '@/lib/config';
import type {MarketReference, ProtocolState} from '@/lib/data/types';

const TOKEN_SYMBOL = getTokenSymbol();

export function Hero({
    state,
    market,
    svgMarkup,
}: {
    state: ProtocolState;
    market: MarketReference;
    svgMarkup: string | null;
}) {
    return (
        <>
            <section className="hero" aria-label="Permanent Collection introduction">
                <div className="hero-copy">
                    <h1>
                        111 Punk traits.
                        <br />
                        One permanent collection.
                        <br />
                        One public bid.
                    </h1>
                    <p className="hero-text">
                        Trading feeds the bid. Any Punk carrying an uncollected trait can accept. If the
                        market returns it, the Punk goes back to circulation. If not, it enters the
                        immutable vault and one more trait becomes permanently collected.
                    </p>

                    <div className="actions">
                        <Link className="primary" href="/trade">
                            Trade {TOKEN_SYMBOL}
                        </Link>
                        <Link className="secondary" href="/collection">
                            View collection
                        </Link>
                    </div>
                </div>

                <Artwork svgMarkup={svgMarkup} />
            </section>
            <style>{styles}</style>
        </>
    );
}

/** The live-bid strip. Split from the hero so the page can place it
 *  independently (it sits below the how-it-works loop story). */
export function LiveBidSection({
    state,
    market,
    eligiblePunkCount = null,
}: {
    state: ProtocolState;
    market: MarketReference;
    /** Punks that could accept the bid right now (adapter-computed); null
     *  hides the fact. */
    eligiblePunkCount?: number | null;
}) {
    return (
        <>
            <section className="bid-section" aria-label="Live bid">
                <div className="bid-section-inner">
                    <div className="bid-section-header">
                        <div className="bid-label">live bid</div>
                    </div>
                    <div className="bid-section-figure">
                        {/* Live on-chain bid — same source as /trade's
                         *  LiveBidStat (Patron.bidBalance + optimistic
                         *  per-session delta). SSR-seeded from `state.liveBidWei`
                         *  so the figure isn't blank on first paint, then the
                         *  client read takes over. Previously this rendered the
                         *  mock adapter's hardcoded 12.4 ETH, which disagreed
                         *  with /trade. */}
                        <LiveBidStat
                            initialWei={state.liveBidWei.toString()}
                            valueClassName="bid-value tnum"
                        />
                        {/* "≈ $X" dollar annotation — polls the same live-bid
                         *  read as the figure above, priced at the shared
                         *  ETH/USD spot. Hides until both are known. */}
                        <LiveBidUsd initialWei={state.liveBidWei.toString()} />
                        <LiveBidPending initialWei={state.liveBidPendingWei.toString()} />
                        <p className="bid-note">
                            The bid grows through official {TOKEN_SYMBOL} trading until an eligible
                            Punk owner accepts.
                        </p>
                        {/* Lifetime official-pool volume (exact, indexer-sourced
                         *  SkimSplit totals) + how many Punks could accept right
                         *  now. Each fact hides when its source is unknown. */}
                        <BidFacts
                            totalSwapVolumeWei={
                                state.totalSwapVolumeWei !== null
                                    ? state.totalSwapVolumeWei.toString()
                                    : null
                            }
                            swapCount={state.swapCount}
                            eligiblePunkCount={eligiblePunkCount}
                        />
                    </div>
                    <ProgressBar
                        liveBidWei={state.liveBidWei}
                        cheapestEligibleWei={market.cheapestEligiblePriceWei}
                        marketAvailable={market.available}
                    />
                    {/* Only surface "Accept the bid" when the standing bid is
                       actually a positive offer for the cheapest currently-
                       listed eligible Punk. Below that threshold, the CTA is
                       misleading — any owner *can* still accept (they could
                       be selling for sentiment), but the public-facing case
                       isn't compelling and the progress bar tells the story.
                       When the market reference is unavailable (`available`
                       false / undefined price), fail-open and show the CTA
                       — losing the gating is better than hiding the path. */}
                    {(() => {
                        const ceiling = market.cheapestEligiblePriceWei;
                        const shouldShow =
                            !market.available || ceiling === undefined || state.liveBidWei >= ceiling;
                        if (!shouldShow) return null;
                        return (
                            <div className="bid-actions">
                                <Link className="primary" href="/bid">
                                    Accept the bid
                                </Link>
                            </div>
                        );
                    })()}
                </div>
            </section>

            <style>{styles}</style>
        </>
    );
}

const styles = `
.hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(320px, 0.95fr);
    gap: clamp(44px, 7vw, 96px);
    align-items: start;
    padding: clamp(62px, 9vh, 96px) var(--pad) clamp(36px, 5vh, 56px);
    max-width: var(--max-wide);
    margin: 0 auto;
    /* The global section border-top rule would stack a second line
       directly below the header's own border-bottom. Hero sits flush. */
    border-top: none;
}
.hero-copy {
    max-width: 650px;
}
.hero h1 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(32px, 3.8vw, 52px);
    line-height: 1.02;
    letter-spacing: -0.035em;
    margin-bottom: 26px;
}
.hero-text {
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.62;
    color: var(--muted);
    max-width: 560px;
    margin-bottom: 28px;
}
.actions {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 28px;
}
.bid-section {
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    padding: clamp(36px, 5vh, 56px) 0;
}
.bid-section-inner {
    max-width: var(--max-wide);
    margin: 0 auto;
    padding: 0 var(--pad);
}
.bid-section-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 16px;
    margin-bottom: clamp(18px, 3vh, 28px);
}
.bid-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.bid-section-figure {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-bottom: clamp(28px, 4vh, 44px);
}
.bid-value {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(56px, 7.4vw, 116px);
    line-height: 0.9;
    letter-spacing: -0.02em;
    color: var(--accent);
    white-space: nowrap;
}
.bid-note {
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0;
    max-width: 460px;
}
.bid-actions {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: clamp(24px, 4vh, 36px);
}
@media (max-width: 900px) {
    .hero {
        grid-template-columns: 1fr;
    }
}
`;
