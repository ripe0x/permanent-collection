'use client';

/* The protocol flywheel, as a state-driven diagram. Shared by the alt
 * landing variants: the persistent-wheel scrolly drives `highlight` /
 * `forked` / `spin` from scroll position; the hybrid hero renders it
 * always-on (`highlight="all"`, `spin`).
 *
 * Geometry lives in one SVG (viewBox 200x260): the ring sits in the top
 * 200x200 square; the bottom 60 units are reserved for the vaulted-exit
 * branch so toggling `forked` never shifts layout. Station chips and
 * fork labels are HTML positioned over the SVG. Progress arcs accumulate
 * clockwise (trade -> accept -> auction) mirroring the loop's order; the
 * pulse dot is the ETH circulating. The hub is the live bid — the same
 * polled on-chain read as the home hero (`LiveBidStat`).
 */

import {useEffect, useState} from 'react';

import {LiveBidStat} from './LiveBidStat';
import {getTokenTicker} from '@/lib/config';
import {CLEARED_SPLIT, fmtPct} from '@/lib/protocol-params';

const TOKEN_TICKER = getTokenTicker();

export type WheelHighlight = 'none' | 'trade' | 'accept' | 'auction' | 'all';

/** The recurring buy-and-burn treatment. Same shape everywhere a burn
 *  happens so the reader learns it once. */
export function BurnPill({children}: {children: React.ReactNode}) {
    return (
        <span className="burn-pill">
            <BurnFlame />
            {children}
            <style>{burnStyles}</style>
        </span>
    );
}

export function BurnFlame({size = 10}: {size?: number}) {
    return (
        <svg
            className="burn-flame"
            width={size}
            height={size * 1.2}
            viewBox="0 0 10 12"
            aria-hidden="true"
        >
            <path
                d="M5 0.6C5.5 3 1.8 4.2 1.8 7.2a3.2 3.2 0 0 0 6.4 0C8.2 4.6 5.6 3.4 5 0.6Z"
                fill="currentColor"
            />
        </svg>
    );
}

const burnStyles = `
.burn-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--danger);
    color: #fff;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 5px 10px;
    white-space: nowrap;
}
.burn-flame {
    flex: none;
    animation: burn-flame-pulse 1.8s ease-in-out infinite;
}
@media (max-width: 860px) {
    .burn-pill {
        white-space: normal;
        line-height: 1.5;
        text-align: left;
        align-items: flex-start;
    }
    .burn-pill .burn-flame {
        margin-top: 3px;
    }
}
@keyframes burn-flame-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
}
`;

/** Cumulative clockwise quarter arcs: trade lights W->N, accept adds
 *  N->E, auction adds E->S; 'all' closes the ring. */
const ARCS: {key: Exclude<WheelHighlight, 'none' | 'all'> | 'close'; d: string}[] = [
    {key: 'trade', d: 'M14,100 A86,86 0 0 1 100,14'},
    {key: 'accept', d: 'M100,14 A86,86 0 0 1 186,100'},
    {key: 'auction', d: 'M186,100 A86,86 0 0 1 100,186'},
    {key: 'close', d: 'M100,186 A86,86 0 0 1 14,100'},
];

const ORDER: WheelHighlight[] = ['trade', 'accept', 'auction'];

function arcVisible(arcKey: string, highlight: WheelHighlight, forked: boolean): boolean {
    if (highlight === 'all') return true;
    if (highlight === 'none') return false;
    // The fork is the settlement moment: both endings burn, so the path
    // from the auction station on to the burn station lights with it.
    if (arcKey === 'close') return forked;
    return ORDER.indexOf(arcKey as WheelHighlight) <= ORDER.indexOf(highlight);
}

export function LoopWheel({
    highlight,
    forked = false,
    spin = false,
    initialLiveBidWei,
    className = '',
}: {
    highlight: WheelHighlight;
    forked?: boolean;
    spin?: boolean;
    /** SSR seed for the live bid (wei, string-encoded). */
    initialLiveBidWei: string;
    className?: string;
}) {
    // SMIL ignores the global reduced-motion CSS kill, so the circulating
    // pulse is gated in JS instead.
    const [motionOk, setMotionOk] = useState(false);
    useEffect(() => {
        setMotionOk(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }, []);

    const staActive = (key: WheelHighlight) => highlight === 'all' || highlight === key;

    return (
        <div
            className={`lw ${className}`.trim()}
            role="img"
            aria-label="The loop: trading feeds the live bid, an eligible Punk accepts it, a 72-hour return auction decides whether it is returned to circulation or vaulted, and both outcomes feed the next cycle."
        >
            <svg viewBox="0 0 200 260" className="lw-svg" aria-hidden="true">
                <defs>
                    <marker
                        id="lw-arrow"
                        markerWidth="7"
                        markerHeight="7"
                        refX="5"
                        refY="3.5"
                        orient="auto"
                    >
                        <path d="M0,0 L7,3.5 L0,7 Z" fill="var(--ink)" />
                    </marker>
                </defs>
                <g className={`lw-dash${spin ? ' is-spinning' : ''}`}>
                    <circle
                        cx="100"
                        cy="100"
                        r="86"
                        fill="none"
                        stroke="var(--line)"
                        strokeWidth="1.5"
                        strokeDasharray="3 5"
                    />
                </g>
                {ARCS.map((a) => (
                    <path
                        key={a.key}
                        d={a.d}
                        fill="none"
                        stroke="var(--ink)"
                        strokeWidth="2"
                        className={`lw-arc${arcVisible(a.key, highlight, forked) ? ' is-on' : ''}`}
                        markerEnd={a.key === 'close' && forked ? 'url(#lw-arrow)' : undefined}
                    />
                ))}
                {motionOk && highlight !== 'none' && (
                    <rect x="-3" y="-3" width="6" height="6" fill="var(--ink)">
                        <animateMotion
                            dur="7s"
                            repeatCount="indefinite"
                            path="M186,100 A86,86 0 1 1 14,100 A86,86 0 1 1 186,100"
                        />
                    </rect>
                )}
                <g
                    className={`lw-feed${
                        highlight === 'trade' || highlight === 'all' ? ' is-on' : ''
                    }`}
                >
                    <path
                        d="M100,14 C 140,24 150,58 132,82"
                        fill="none"
                        stroke="var(--ink)"
                        strokeWidth="1.5"
                        markerEnd="url(#lw-arrow)"
                    />
                </g>
                <g className={`lw-fork${forked ? ' is-on' : ''}`}>
                    <path
                        d="M100,186 C 62,176 50,140 70,116"
                        fill="none"
                        stroke="var(--ink)"
                        strokeWidth="1.5"
                        markerEnd="url(#lw-arrow)"
                    />
                    <path
                        d="M100,186 L100,220"
                        fill="none"
                        stroke="var(--ink)"
                        strokeWidth="1.5"
                        markerEnd="url(#lw-arrow)"
                    />
                    <g>
                        <rect x="91" y="227" width="8" height="8" fill="var(--ink)" />
                        <rect x="101" y="227" width="8" height="8" fill="none" stroke="var(--line)" strokeWidth="1" />
                        <rect x="91" y="237" width="8" height="8" fill="none" stroke="var(--line)" strokeWidth="1" />
                        <rect x="101" y="237" width="8" height="8" fill="none" stroke="var(--line)" strokeWidth="1" />
                    </g>
                </g>
            </svg>

            <div className="lw-hub">
                <span className="lw-hub-label">live bid</span>
                <LiveBidStat initialWei={initialLiveBidWei} valueClassName="lw-hub-value tnum" />
            </div>

            <span className={`lw-sta lw-sta-n${staActive('trade') ? ' is-active' : ''}`}>
                trade {TOKEN_TICKER}
            </span>
            <span className={`lw-sta lw-sta-e${staActive('accept') ? ' is-active' : ''}`}>
                accept bid
            </span>
            <span className={`lw-sta lw-sta-s${staActive('auction') ? ' is-active' : ''}`}>
                punk auction
            </span>
            <span className={`lw-sta lw-sta-w lw-sta-burn${highlight === 'all' ? ' is-active' : ''}`}>
                <BurnFlame size={9} />
                burn {TOKEN_TICKER}
            </span>

            <div className={`lw-fork-label lw-fl-returned${forked ? ' is-on' : ''}`}>
                <span className="lw-fl-title">returned to circulation</span>
                <span className="lw-fl-line">
                    {fmtPct(CLEARED_SPLIT.liveBidPct)} refills the bid
                </span>
                <span className="lw-fl-burn">
                    <BurnFlame size={8} />
                    {fmtPct(CLEARED_SPLIT.buybackBurnPct)} buys + burns {TOKEN_TICKER}
                </span>
            </div>
            <div className={`lw-fork-label lw-fl-vaulted${forked ? ' is-on' : ''}`}>
                <span className="lw-fl-title">vaulted &middot; trait permanent</span>
                <span className="lw-fl-burn">
                    <BurnFlame size={8} />
                    burn pool buys + burns {TOKEN_TICKER}
                </span>
            </div>

            <style>{styles}</style>
        </div>
    );
}

const styles = `
.lw {
    position: relative;
    width: 100%;
    aspect-ratio: 200 / 260;
}
.lw-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
}
.lw-dash {
    transform-origin: 100px 100px;
}
.lw-dash.is-spinning {
    animation: lw-rot 24s linear infinite;
}
@keyframes lw-rot {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}
.lw-arc {
    opacity: 0;
    transition: opacity 350ms ease;
}
.lw-arc.is-on {
    opacity: 1;
}
.lw-fork,
.lw-feed {
    opacity: 0;
    transition: opacity 350ms ease;
}
.lw-fork.is-on,
.lw-feed.is-on {
    opacity: 1;
}
/* Ring center is at (50%, 100/260) of the box; stations sit on the ring. */
.lw-hub {
    position: absolute;
    left: 50%;
    top: 38.46%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    text-align: center;
}
.lw-hub-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
}
.lw-hub-value {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(26px, 3vw, 42px);
    letter-spacing: -0.02em;
    line-height: 1;
    white-space: nowrap;
}
.lw-sta {
    position: absolute;
    background: var(--bg);
    border: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 4px 10px;
    white-space: nowrap;
    transition: background 300ms ease, color 300ms ease, border-color 300ms ease;
}
.lw-sta.is-active {
    background: var(--ink);
    border-color: var(--ink);
    color: var(--bg);
}
.lw-sta-n { left: 50%; top: 5.4%; transform: translate(-50%, -50%); }
.lw-sta-e { left: 93%; top: 38.46%; transform: translate(-50%, -50%); }
.lw-sta-s { left: 50%; top: 71.5%; transform: translate(-50%, -50%); }
.lw-sta-w { left: 7%; top: 38.46%; transform: translate(-50%, -50%); }
.lw-sta-burn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
}
.lw-sta-burn,
.lw-sta-burn.is-active {
    background: var(--danger);
    border-color: var(--danger);
    color: #fff;
}
.lw-sta-burn .burn-flame {
    animation: burn-flame-pulse 1.8s ease-in-out infinite;
}
.lw-fork-label {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    opacity: 0;
    transition: opacity 350ms ease;
    pointer-events: none;
}
/* Labels can cross the ring — knock the line out behind the text the
   same way the station chips do. */
.lw-fork-label > span {
    background: var(--bg);
    padding: 1px 3px;
    margin-left: -3px;
}
.lw-fork-label.is-on {
    opacity: 1;
}
.lw-fl-title {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink);
}
.lw-fl-line {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--muted);
}
.lw-fl-burn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--mono);
    font-size: 9.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--danger);
}
.lw-fl-returned {
    left: 0;
    top: 56%;
    max-width: 36%;
    text-align: left;
}
.lw-fl-vaulted {
    left: 58%;
    top: 84%;
    text-align: left;
}
@keyframes burn-flame-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
}
`;
