'use client';

/* Scroll-locked "walk the loop" story for the alt landing pages.
 *
 * Two variants share the scroll machinery (tall scroll slot, sticky
 * viewport, continuous track translate, beat dimming):
 *
 * - `wheel` (/alt): the flywheel is the persistent hero. The pinned
 *   viewport is two columns — text beats scroll on the left while a
 *   large `LoopWheel` stays on screen the whole story, lighting one
 *   station per beat, drawing the fork branches on the wheel itself at
 *   beat 04, and spinning at the finale.
 *
 * - `short` (/alt2): the wheel lives in the page hero instead, so the
 *   scrolly is just the three beats that benefit from sequencing
 *   (accept, auction, fork) with the card-based fork geometry.
 *
 * All numbers in copy come from `lib/protocol-params.ts`; the live bid
 * is the same polled on-chain read the home hero uses (`LiveBidStat`).
 */

import Link from 'next/link';
import {useCallback, useEffect, useRef, useState} from 'react';

import {BurnPill, LoopWheel, type WheelHighlight} from './LoopWheel';
import {getTokenTicker} from '@/lib/config';
import {AUCTION, CLEARED_SPLIT, COLLECTION, FEES, fmtPct} from '@/lib/protocol-params';

const TOKEN_TICKER = getTokenTicker();

export type LoopStoryVariant = 'wheel' | 'short';

/** Per-beat wheel state for the `wheel` variant. */
const WHEEL_STATES: {highlight: WheelHighlight; forked?: boolean; spin?: boolean}[] = [
    {highlight: 'trade'},
    {highlight: 'accept'},
    {highlight: 'auction'},
    {highlight: 'auction', forked: true},
    {highlight: 'all', spin: true},
];

export function LoopStory({
    variant,
    initialLiveBidWei,
    collectedCount,
}: {
    variant: LoopStoryVariant;
    /** SSR seed for the live bid (wei, string-encoded). */
    initialLiveBidWei: string;
    collectedCount: number;
}) {
    const beatCount = variant === 'wheel' ? 5 : 3;

    const scrollRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
    const [beat, setBeat] = useState(0);

    // Below 860px the scroll-locked treatment doesn't earn its space: the
    // wheel and the beat text fight over a short viewport. The section
    // renders statically instead — wheel on top (full loop state, not
    // sticky), beats flowing below. CSS does the layout; this flag stops
    // the scroll-driven transform writes and pins the wheel state.
    const [staticLayout, setStaticLayout] = useState(false);
    useEffect(() => {
        const mq = window.matchMedia('(max-width: 860px)');
        const apply = () => setStaticLayout(mq.matches);
        apply();
        mq.addEventListener('change', apply);
        return () => mq.removeEventListener('change', apply);
    }, []);

    const layout = useCallback(() => {
        const scrollEl = scrollRef.current;
        const vp = viewportRef.current;
        const track = trackRef.current;
        if (!scrollEl || !vp || !track) return;
        if (window.matchMedia('(max-width: 860px)').matches) {
            track.style.transform = 'none';
            return;
        }

        const stickyTop = parseFloat(getComputedStyle(vp).top) || 0;
        const rect = scrollEl.getBoundingClientRect();
        const travel = scrollEl.offsetHeight - vp.offsetHeight;
        const raw = travel > 0 ? Math.min(1, Math.max(0, (stickyTop - rect.top) / travel)) : 0;
        const p = raw * (beatCount - 1);

        // Continuous translate: lerp between adjacent beat centers so the
        // track moves with the scroll instead of jump-cutting.
        const lo = Math.floor(p);
        const hi = Math.min(beatCount - 1, lo + 1);
        const frac = p - lo;
        const center = (i: number) => {
            const r = rowRefs.current[i];
            return r ? r.offsetTop + r.offsetHeight / 2 : 0;
        };
        const c = center(lo) + (center(hi) - center(lo)) * frac;
        track.style.transform = `translateY(${Math.round(vp.offsetHeight / 2 - c)}px)`;

        const next = Math.round(p);
        setBeat((b) => (b === next ? b : next));
    }, [beatCount]);

    useEffect(() => {
        let raf = 0;
        const schedule = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(layout);
        };
        layout();
        window.addEventListener('scroll', schedule, {passive: true});
        window.addEventListener('resize', schedule);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
        };
    }, [layout]);

    const setRow = (i: number) => (el: HTMLDivElement | null) => {
        rowRefs.current[i] = el;
    };
    const rowClass = (i: number, extra = '') =>
        `ls-row${extra ? ` ${extra}` : ''}${beat === i ? ' is-active' : ''}`;

    // Static (mobile) layout shows the whole loop at once; the scrolly
    // drives the wheel per beat.
    const wheelState = staticLayout
        ? {highlight: 'all' as const, spin: true, forked: false}
        : WHEEL_STATES[Math.min(beat, WHEEL_STATES.length - 1)];
    const collectedPct = Math.round((collectedCount / COLLECTION.totalTraits) * 100);

    /* Beat building blocks shared by the variants. The number is the
       visual rail label; beats renumber per variant. */
    const tradeBeat = (i: number, num: string) => (
        <div className={rowClass(i)} ref={setRow(i)} key="trade">
            <div className="ls-num">{num}</div>
            <div className="ls-node" />
            <div className="ls-body">
                <h3>Trade</h3>
                <p>
                    Fees on trades in the official pool feed the live bid.{' '}
                    {fmtPct(FEES.bidLegPct)} of every swap reaches the bid in the same block it
                    trades.
                </p>
            </div>
        </div>
    );
    const acceptBeat = (i: number, num: string) => (
        <div className={rowClass(i)} ref={setRow(i)} key="accept">
            <div className="ls-num">{num}</div>
            <div className="ls-node" />
            <div className="ls-body">
                <h3>Accept bid</h3>
                <p>
                    Any eligible Punk owner can accept the live bid. A Punk carrying an uncollected
                    trait comes in, and the owner is paid the bid.
                </p>
            </div>
        </div>
    );
    const auctionBeat = (i: number, num: string) => (
        <div className={rowClass(i)} ref={setRow(i)} key="auction">
            <div className="ls-num">{num}</div>
            <div className="ls-node" />
            <div className="ls-body">
                <h3>Return auction</h3>
                <p>
                    The Punk enters a {AUCTION.durationHours}-hour return auction, giving the market
                    an opportunity to keep it in circulation. Anyone can bid a premium over what the
                    protocol paid.
                </p>
            </div>
        </div>
    );

    /* Compact stacked fork for the wheel variant — the geometry lives on
       the wheel; the text states the two outcomes. */
    const forkBeatCompact = (i: number, num: string) => (
        <div className={rowClass(i)} ref={setRow(i)} key="fork">
            <div className="ls-num">{num}</div>
            <div className="ls-node" />
            <div className="ls-body">
                <h3>Two endings</h3>
                <p className="ls-fork-lead">When the auction ends, one of two things has happened.</p>
                <div className="ls-outcomes">
                    <div className="ls-outcome">
                        <div className="ls-outcome-tag">the market bid</div>
                        <h4>Returned to circulation</h4>
                        <p>
                            The high bidder takes the Punk at a premium. At settlement,{' '}
                            {fmtPct(CLEARED_SPLIT.liveBidPct)} of the proceeds refill the live bid
                            and {fmtPct(CLEARED_SPLIT.vaultBurnPct)} accrues to the burn pool.
                        </p>
                        <BurnPill>
                            {fmtPct(CLEARED_SPLIT.buybackBurnPct)} buys and burns {TOKEN_TICKER}
                        </BurnPill>
                    </div>
                    <div className="ls-outcome">
                        <div className="ls-outcome-tag">no bids</div>
                        <h4>Vaulted</h4>
                        <p>
                            The Punk enters the immutable vault and the chosen trait becomes
                            permanently collected. One of {COLLECTION.totalTraits} cells fills, for
                            good.
                        </p>
                        <BurnPill>the burn pool buys and burns {TOKEN_TICKER} at settlement</BurnPill>
                    </div>
                </div>
            </div>
        </div>
    );

    /* Card fork with orthogonal connectors — used by the short variant,
       where there is no wheel on screen to carry the geometry. */
    const forkBeatCards = (i: number, num: string) => (
        <div className={rowClass(i, 'ls-fork')} ref={setRow(i)} key="fork">
            <div className="ls-num">{num}</div>
            <div className="ls-node" />
            <div className="ls-body">
                <p className="ls-fork-lead">When the auction ends, one of two things has happened.</p>
            </div>
            <div className="ls-fork-area">
                <div className="ls-conn ls-conn-top" aria-hidden="true">
                    <span className="ls-line-v ls-ct-stub" />
                    <span className="ls-line-h ls-ct-bar" />
                    <span className="ls-line-v ls-ct-drop-a" />
                    <span className="ls-line-v ls-ct-drop-b" />
                </div>
                <div className="ls-cards">
                    <article className="ls-card">
                        <div className="ls-outcome-tag">the market bid</div>
                        <h4>Returned to circulation</h4>
                        <p>
                            The high bidder takes the Punk at a premium over what the protocol paid.
                            At settlement, {fmtPct(CLEARED_SPLIT.liveBidPct)} of the proceeds refill
                            the live bid and {fmtPct(CLEARED_SPLIT.vaultBurnPct)} accrues to the
                            burn pool.
                        </p>
                        <BurnPill>
                            {fmtPct(CLEARED_SPLIT.buybackBurnPct)} buys and burns {TOKEN_TICKER}
                        </BurnPill>
                    </article>
                    <article className="ls-card">
                        <div className="ls-outcome-tag">no bids</div>
                        <h4>Vaulted</h4>
                        <p>
                            The Punk enters the immutable vault and the chosen trait becomes
                            permanently collected. One of {COLLECTION.totalTraits} cells fills, for
                            good.
                        </p>
                        <BurnPill>the burn pool buys and burns {TOKEN_TICKER} at settlement</BurnPill>
                    </article>
                </div>
                <div className="ls-conn ls-conn-bottom" aria-hidden="true">
                    <span className="ls-line-v ls-cb-drop-a" />
                    <span className="ls-line-v ls-cb-drop-b" />
                    <span className="ls-line-h ls-cb-bar" />
                    <span className="ls-line-v ls-cb-up" />
                </div>
                <div className="ls-return">
                    <span aria-hidden="true">&uarr;</span> Both outcomes feed the next cycle. The
                    loop restarts.
                </div>
            </div>
        </div>
    );

    const finaleBeat = (i: number) => (
        <div className={rowClass(i, 'ls-finale')} ref={setRow(i)} key="finale">
            <div className="ls-num" />
            <div className="ls-node ls-node-hidden" />
            <div className="ls-body">
                <h3>The loop never waits.</h3>
                <p>
                    The bid is standing. It grows the block a trade happens, refills when a Punk is
                    returned, and burns {TOKEN_TICKER} every time an auction settles.
                </p>
                <ul className="ls-tempo">
                    <li>grows on every trade</li>
                    <li>refills from every return auction</li>
                    <li className="ls-tempo-burn">
                        <BurnPill>burns {TOKEN_TICKER} on every settlement</BurnPill>
                    </li>
                </ul>
                <div className="ls-progress">
                    <span className="ls-progress-label tnum">
                        {collectedCount} of {COLLECTION.totalTraits} traits permanent
                    </span>
                    <span className="ls-progress-bar">
                        <span
                            className="ls-progress-fill"
                            style={{
                                width: `${Math.max(collectedPct, collectedCount > 0 ? 2 : 0)}%`,
                            }}
                        />
                    </span>
                </div>
                <div className="ls-actions">
                    <Link className="primary" href="/trade">
                        Trade {TOKEN_TICKER}
                    </Link>
                    <Link className="secondary" href="/collection">
                        View collection
                    </Link>
                </div>
            </div>
        </div>
    );

    const rows =
        variant === 'wheel'
            ? [
                  tradeBeat(0, '01'),
                  acceptBeat(1, '02'),
                  auctionBeat(2, '03'),
                  forkBeatCompact(3, '04'),
                  finaleBeat(4),
              ]
            : [acceptBeat(0, '01'), auctionBeat(1, '02'), forkBeatCards(2, '03')];

    return (
        <section className={`loop-story is-${variant}`} aria-label="How the loop works" id="how">
            <div className="ls-scroll" ref={scrollRef} style={{height: `${beatCount * 100}vh`}}>
                <div className="ls-viewport" ref={viewportRef}>
                    <div className="ls-cols">
                        <div className="ls-left">
                            <div className="ls-track" ref={trackRef}>
                                {rows}
                            </div>
                        </div>
                        {variant === 'wheel' && (
                            <div className="ls-wheelcol">
                                <LoopWheel
                                    highlight={wheelState.highlight}
                                    forked={wheelState.forked}
                                    spin={wheelState.spin}
                                    initialLiveBidWei={initialLiveBidWei}
                                    className="ls-wheel"
                                />
                            </div>
                        )}
                    </div>
                </div>
            </div>
            <style>{styles}</style>
        </section>
    );
}

const styles = `
.loop-story {
    border-top: 1px solid var(--line);
    padding: 0;
}
.ls-scroll {
    position: relative;
}
.ls-viewport {
    position: sticky;
    /* Cap the pinned stage on tall screens. Uncapped (100svh - header), the
       stage centers the active beat + wheel at half the FULL viewport — so at
       the section's entry, before the sticky engages, they sit below the fold
       behind a screen-sized void under the title, and the wheel is clipped at
       the fold. 880px holds the tallest beat (the 560px fork) and the 650px
       wheel with margins; the top calc centers the capped stage between the
       58px site header and the fold while pinned. On laptop-height screens
       the min() resolves to the full viewport height and nothing changes. */
    --ls-stage: min(calc(100svh - 58px), 880px);
    top: calc(58px + (100svh - 58px - var(--ls-stage)) / 2);
    height: var(--ls-stage);
    overflow: hidden;
}
.ls-cols {
    max-width: var(--max-wide);
    margin: 0 auto;
    padding: 0 var(--pad);
    height: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: center;
    gap: clamp(28px, 4vw, 64px);
}
.loop-story.is-wheel .ls-cols {
    grid-template-columns: minmax(0, 1fr) clamp(300px, 36vw, 500px);
}
.ls-left {
    position: relative;
    height: 100%;
    overflow: hidden;
}
.ls-wheelcol {
    display: flex;
    align-items: center;
    justify-content: center;
}
.ls-wheel {
    width: 100%;
    max-width: 500px;
}
.ls-track {
    will-change: transform;
}
.ls-row {
    position: relative;
    display: grid;
    grid-template-columns: 44px 44px minmax(0, 1fr);
    padding: 60px 0;
    opacity: 0.22;
    transition: opacity 350ms ease;
}
.ls-row.is-active {
    opacity: 1;
}
/* The rail: a continuous 1px line through the step rows. Each row draws
   its own slice (rows touch, so the slices read as one line). */
.ls-row::before {
    content: '';
    position: absolute;
    left: 66px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--line);
}
.ls-row.ls-fork::before {
    bottom: auto;
    height: 76px;
}
.ls-row.ls-finale::before {
    display: none;
}
.ls-num {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    text-align: right;
    padding-right: 18px;
    padding-top: 13px;
}
.ls-node {
    width: 11px;
    height: 11px;
    background: var(--ink);
    margin-left: 17px;
    margin-top: 14px;
    position: relative;
    z-index: 1;
}
.ls-node-hidden {
    visibility: hidden;
}
.ls-body {
    max-width: 620px;
}
.ls-body h3 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(28px, 3.2vw, 42px);
    letter-spacing: -0.035em;
    line-height: 1.02;
    margin-bottom: 14px;
}
.ls-body > p {
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.65;
    color: var(--muted);
    max-width: 500px;
}

/* ─── Compact stacked fork (wheel variant) ─────────────────────────── */
.ls-fork-lead {
    margin-bottom: 18px;
}
.ls-outcomes {
    display: flex;
    flex-direction: column;
    gap: 18px;
}
.ls-outcome {
    border-left: 1px solid var(--line);
    padding-left: 18px;
}
.ls-outcome-tag {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 8px;
}
.ls-outcome h4,
.ls-card h4 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: 24px;
    letter-spacing: -0.03em;
    line-height: 1.05;
    margin-bottom: 8px;
}
.ls-outcome p,
.ls-card p {
    font-family: var(--sans);
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--muted);
    margin-bottom: 12px;
    max-width: 460px;
}

/* ─── Card fork with connectors (short variant) ────────────────────── */
.ls-fork-area {
    grid-column: 1 / -1;
    margin-left: 66px;
}
.ls-conn {
    position: relative;
    height: 36px;
}
.ls-line-v,
.ls-line-h {
    position: absolute;
    background: var(--line);
}
.ls-line-v { width: 1px; }
.ls-line-h { height: 1px; }
.ls-ct-stub { left: 0; top: -28px; height: 46px; }
.ls-ct-bar { left: 0; top: 18px; width: calc(75% + 10px); }
.ls-ct-drop-a { left: calc(25% - 10px); top: 18px; height: 18px; }
.ls-ct-drop-b { left: calc(75% + 10px); top: 18px; height: 18px; }
.ls-cb-drop-a { left: calc(25% - 10px); top: 0; height: 18px; }
.ls-cb-drop-b { left: calc(75% + 10px); top: 0; height: 18px; }
.ls-cb-bar { left: 0; top: 18px; width: calc(75% + 10px); }
.ls-cb-up { left: 0; top: 18px; height: 18px; }
.ls-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
}
.ls-card {
    border: 1px solid var(--line);
    background: var(--bg);
    padding: 24px 26px 22px;
}
.ls-card .ls-outcome-tag {
    margin-bottom: 14px;
}
.ls-return {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink);
    margin-top: 4px;
}

/* ─── Finale ───────────────────────────────────────────────────────── */
.ls-tempo {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin: 20px 0 24px;
}
.ls-tempo li {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink);
    padding-left: 18px;
    position: relative;
}
.ls-tempo li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    width: 7px;
    height: 7px;
    transform: translateY(-50%);
    background: var(--ink);
}
.ls-tempo li.ls-tempo-burn {
    padding-left: 0;
}
.ls-tempo li.ls-tempo-burn::before {
    display: none;
}
.ls-progress {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 26px;
}
.ls-progress-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
}
.ls-progress-bar {
    display: block;
    height: 4px;
    background: var(--panel);
    max-width: 360px;
}
.ls-progress-fill {
    display: block;
    height: 100%;
    background: var(--ink);
}
.ls-actions {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
}

/* ─── Responsive: static layout below 860px ─────────────────────────────
   No scroll-locking on small screens — the wheel sits at the top of the
   section in its full-loop state and the beats flow below it. The JS side
   mirrors this via the staticLayout flag (stops transform writes, pins
   the wheel state to the full loop). */
@media (max-width: 860px) {
    .loop-story {
        padding: clamp(40px, 6vh, 64px) 0;
    }
    .ls-scroll {
        height: auto !important;
    }
    .ls-viewport {
        position: static;
        height: auto;
        overflow: visible;
    }
    .ls-cols {
        display: flex;
        flex-direction: column;
        height: auto;
    }
    .loop-story.is-wheel .ls-wheelcol {
        /* The wheel leads the section on mobile (it is grid column 2 on
           desktop, so DOM order puts it after the beats). */
        order: -1;
        margin: 0 auto 32px;
        width: min(78vw, 340px);
    }
    .loop-story.is-wheel .ls-wheel {
        /* The diagram box reserves a bottom zone for the fork branches,
           which never render in the static layout — reclaim it. The
           percentage resolves against the wheel width (zone = 60/200). */
        margin-bottom: -25%;
    }
    .ls-left {
        height: auto;
        overflow: visible;
        width: 100%;
    }
    .ls-track {
        transform: none !important;
    }
    .ls-row {
        opacity: 1;
    }
    .ls-row {
        grid-template-columns: 30px 24px minmax(0, 1fr);
        padding: 38px 0;
    }
    .ls-row::before {
        left: 42px;
    }
    .ls-row.ls-fork::before {
        height: 56px;
    }
    .ls-num {
        padding-right: 8px;
        padding-top: 11px;
    }
    .ls-node {
        margin-left: 7px;
        margin-top: 13px;
        width: 9px;
        height: 9px;
    }
    .ls-body h3 {
        font-size: 26px;
    }
    .ls-outcome h4,
    .ls-card h4 {
        font-size: 20px;
    }
    .ls-fork-area {
        margin-left: 0;
    }
    .ls-conn {
        display: none;
    }
    .ls-cards {
        grid-template-columns: 1fr;
        gap: 12px;
        margin-top: 18px;
    }
    .ls-card {
        padding: 18px 18px 16px;
    }
    .ls-return {
        margin-top: 14px;
    }
}
`;
