/* Static "how the loop works" section for the home page: the full wheel
   beside the four beats, one viewport, no scroll machinery. This is the
   same treatment LoopStory falls back to below 860px, promoted to every
   breakpoint — the pinned scrollytelling lives on only in the /alt
   experiments. All numbers come from `lib/protocol-params.ts`; the live
   bid at the wheel hub is the same polled read the hero uses. */
import Link from 'next/link';

import {LoopWheel} from './LoopWheel';
import {getTokenTicker} from '@/lib/config';
import {AUCTION, CLEARED_SPLIT, COLLECTION, FEES, fmtPct} from '@/lib/protocol-params';

const TOKEN_TICKER = getTokenTicker();

const BEATS: {title: string; body: React.ReactNode}[] = [
    {
        title: 'Trade',
        body: (
            <>
                Fees on trades in the official pool feed the live bid. {fmtPct(FEES.bidLegPct)} of
                every swap is skimmed for the bid in the same transaction and metered into the
                standing offer.
            </>
        ),
    },
    {
        title: 'Accept bid',
        body: (
            <>
                Any eligible Punk owner can accept the live bid: they list the Punk to the protocol
                at up to the bid, and collect the price from the Punk market.
            </>
        ),
    },
    {
        title: 'Return auction',
        body: (
            <>
                The Punk enters a {AUCTION.durationHours}-hour return auction, giving the market an
                opportunity to keep it in circulation. Anyone can bid a premium over what the
                protocol paid.
            </>
        ),
    },
    {
        title: 'Two endings',
        body: (
            <>
                If the market bids, the Punk returns to circulation: {fmtPct(CLEARED_SPLIT.liveBidPct)}{' '}
                of what the protocol paid refills the live bid, {fmtPct(CLEARED_SPLIT.buybackBurnPct)}{' '}
                buys and burns {TOKEN_TICKER}, and the rest accrues toward future burns. If no bid
                clears, the Punk is vaulted and the recorded target trait becomes permanently
                collected.
            </>
        ),
    },
];

export function LoopSection({initialLiveBidWei}: {initialLiveBidWei: string}) {
    return (
        <section className="loop-section" id="how" aria-label="How the loop works">
            <div className="wrap">
                <div className="loop-head">
                    <div className="kicker">The loop</div>
                    <h2 className="section-title">How the loop works.</h2>
                </div>
                <div className="loop-grid">
                    <div className="loop-wheel-col">
                        <LoopWheel
                            highlight="all"
                            spin
                            initialLiveBidWei={initialLiveBidWei}
                            className="loop-wheel"
                        />
                    </div>
                    <div className="loop-beats">
                        {BEATS.map((beat, i) => (
                            <div className="loop-beat" key={beat.title}>
                                <div className="loop-beat-num tnum">{`0${i + 1}`}</div>
                                <div>
                                    <h3>{beat.title}</h3>
                                    <p>{beat.body}</p>
                                </div>
                            </div>
                        ))}
                        <p className="loop-horizon">
                            No deadline. The work runs until all {COLLECTION.totalTraits} traits are
                            permanent, or settles where the remaining traits are held by owners who
                            refuse the bid.
                        </p>
                        <Link href="/protocol" className="loop-protocol-link">
                            Read the full protocol &rarr;
                        </Link>
                    </div>
                </div>
            </div>
            <style>{styles}</style>
        </section>
    );
}

const styles = `
.loop-head {
    margin-bottom: clamp(26px, 4vh, 40px);
}
.loop-grid {
    display: grid;
    grid-template-columns: clamp(280px, 34vw, 440px) minmax(0, 1fr);
    gap: clamp(34px, 6vw, 80px);
    align-items: center;
}
.loop-wheel-col {
    display: flex;
    align-items: center;
    justify-content: center;
}
.loop-wheel {
    width: 100%;
    max-width: 440px;
}
.loop-beats {
    display: flex;
    flex-direction: column;
    gap: 18px;
    max-width: 560px;
}
.loop-beat {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 12px;
}
.loop-beat-num {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--muted);
    padding-top: 3px;
}
.loop-beat h3 {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin: 0 0 5px;
}
.loop-beat p {
    font-family: var(--sans);
    font-size: 14.5px;
    line-height: 1.6;
    color: var(--muted);
    margin: 0;
}
.loop-horizon {
    border-top: 1px solid var(--line);
    margin: 8px 0 0;
    padding-top: 16px;
    font-family: var(--serif);
    font-style: italic;
    font-size: 16px;
    line-height: 1.55;
    color: var(--ink);
}
.loop-protocol-link {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    text-decoration: underline;
    text-underline-offset: 3px;
    width: fit-content;
}
.loop-protocol-link:hover {
    color: var(--ink);
}
@media (max-width: 860px) {
    .loop-grid {
        grid-template-columns: 1fr;
        gap: 30px;
    }
    .loop-wheel {
        max-width: 360px;
    }
}
`;
