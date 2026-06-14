/* Return-auctions section.
   - 0 active + 0 resolved → section is omitted entirely (fresh-deploy state)
   - 0 active + N resolved → "No active return auction." + Previous-auctions list
   - 1 active → "Punk #N is in return auction." (+ Returned / Not returned outcome panel)
   - N active → "N active return auctions." (list + "View all auctions" link)
*/
import Link from 'next/link';
import {PunkSvg} from '@/components/PunkSvg';
import {getTokenSymbol} from '@/lib/config';
import type {
    AcceptedBidEvent,
    ActiveAuction,
    ProtocolState,
    ResolvedAuction,
} from '@/lib/data/types';
import {
    formatDurationFromSeconds,
    formatEth,
    formatEthBare,
    formatPunk,
    formatTraitName,
} from '@/lib/format';

const TOKEN_SYMBOL = getTokenSymbol();

export function AuctionSection({
    state,
    auctions,
    resolved,
    nowSeconds,
    traitNames,
    recentAccepted,
}: {
    state: ProtocolState;
    auctions: ActiveAuction[];
    /** Previously-resolved return auctions, newest first. When `auctions` and
     *  `resolved` are both empty, the whole section is omitted — there's
     *  nothing meaningful to show pre-first-acquisition. */
    resolved: ResolvedAuction[];
    /** Server-side "now" so initial render is deterministic. The client
     *  ticks countdowns separately. */
    nowSeconds: bigint;
    traitNames?: readonly string[];
    /** Used to surface "Last accepted bid" in the empty-state metrics. */
    recentAccepted?: AcceptedBidEvent[];
}) {
    // Section completely hidden when there are zero active AND zero resolved
    // auctions. Pre-first-acquisition the panel was just a placeholder; we
    // remove the noise until there's real history to show.
    if (auctions.length === 0 && resolved.length === 0) {
        return null;
    }

    const count = auctions.length;
    let heading: string;
    let title: string;
    let copy: string;

    if (count === 0) {
        heading = 'No active return auction.';
        title = 'The live bid is standing.';
        copy =
            `Any eligible Punk owner can accept it. Official ${TOKEN_SYMBOL} trading keeps adding to the bid.`;
    } else if (count === 1) {
        const a = auctions[0];
        heading = `${formatPunk(a.punkId)} is in return auction.`;
        title = `${formatTraitName(a.targetTraitId, traitNames)} could become permanent.`;
        copy = `The market has ${formatDurationFromSeconds(a.endsAt - nowSeconds)} to return this Punk to circulation. If it is not returned, ${formatTraitName(a.targetTraitId, traitNames)} becomes a permanent trait.`;
    } else {
        heading = `${count} active return auctions.`;
        title = 'The market has open auctions.';
        copy =
            'Each accepted Punk has its own 72-hour return auction. Returned Punks go back to circulation. Vaulted Punks make their chosen traits permanent.';
    }

    return (
        <section className="state-section" id="auctions" aria-label="Return auction state">
            <div className="wrap">
                <div className="state-head">
                    <div>
                        <div className="kicker">Return auctions</div>
                        <h2 className="section-title">{heading}</h2>
                    </div>
                </div>

                <div className="auction-panel">
                    <div className="auction-main">
                        {count === 1 && (
                            <PunkSvg
                                punkId={auctions[0].punkId}
                                size={120}
                                label={`Punk #${auctions[0].punkId}`}
                                background="transparent"
                                className="auction-single-thumb"
                            />
                        )}
                        <div className="auction-title">{title}</div>
                        <p className="auction-copy">{copy}</p>

                        {count === 1 && (
                            <div className="outcomes">
                                <div className="outcome">
                                    <div className="outcome-label">Returned</div>
                                    <p>The Punk returns to circulation. {TOKEN_SYMBOL} burns.</p>
                                </div>
                                <div className="outcome">
                                    <div className="outcome-label">Not returned</div>
                                    <p>
                                        The Punk enters the vault.{' '}
                                        {formatTraitName(auctions[0].targetTraitId, traitNames)} becomes a
                                        permanent trait. {TOKEN_SYMBOL} burns.
                                    </p>
                                </div>
                            </div>
                        )}

                        {count > 1 && (
                            <>
                                <div className="auction-list">
                                    {auctions.map((a) => (
                                        <Link key={a.punkId} className="auction-row" href={`/auction/${a.punkId}`}>
                                            <PunkSvg
                                                punkId={a.punkId}
                                                size={48}
                                                label={`Punk #${a.punkId}`}
                                                background="transparent"
                                                className="auction-row-thumb"
                                            />
                                            <div className="auction-row-text">
                                                <strong>{formatPunk(a.punkId)}</strong>
                                                <br />
                                                <span>{formatTraitName(a.targetTraitId, traitNames)}</span>
                                            </div>
                                            <div className="auction-close tnum">
                                                {formatDurationFromSeconds(a.endsAt - nowSeconds)}
                                            </div>
                                        </Link>
                                    ))}
                                </div>
                                <Link className="view-all" href="/#auctions">
                                    View all auctions
                                </Link>
                            </>
                        )}
                    </div>

                    <div className="auction-side">
                        <div className="metrics">
                            {metricsFor(state, auctions, nowSeconds, traitNames, recentAccepted).map(
                                ([label, value]) => (
                                    <div key={label} className="metric">
                                        <span>{label}</span>
                                        <strong className="tnum">{value}</strong>
                                    </div>
                                ),
                            )}
                        </div>
                    </div>
                </div>

                {resolved.length > 0 && (
                    <div className="resolved-block" aria-label="Previous return auctions">
                        <div className="resolved-head">
                            <div className="kicker">Previous return auctions</div>
                        </div>
                        <div className="resolved-list">
                            {resolved.map((r) => (
                                <Link
                                    key={`${r.punkId}-${r.txHash}`}
                                    className="resolved-row"
                                    href={`/auction/${r.punkId}`}
                                >
                                    <PunkSvg
                                        punkId={r.punkId}
                                        size={40}
                                        label={`Punk #${r.punkId}`}
                                        background="transparent"
                                        className="resolved-thumb"
                                    />
                                    <div className="resolved-punk">
                                        <strong>{formatPunk(r.punkId)}</strong>
                                    </div>
                                    <div className="resolved-trait">
                                        {formatTraitName(r.targetTraitId, traitNames)}
                                    </div>
                                    <div
                                        className={`resolved-outcome resolved-outcome-${r.outcome}`}
                                    >
                                        {r.outcome === 'cleared' ? 'Returned' : 'Vaulted'}
                                    </div>
                                    <div className="resolved-price tnum">
                                        {r.finalBidWei > 0n ? formatEth(r.finalBidWei) : '—'}
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            <style>{styles}</style>
        </section>
    );
}

function metricsFor(
    state: ProtocolState,
    auctions: ActiveAuction[],
    nowSeconds: bigint,
    traitNames?: readonly string[],
    recentAccepted?: AcceptedBidEvent[],
): [string, string][] {
    if (auctions.length === 0) {
        const last = recentAccepted?.[0];
        return [
            ['Permanent traits', `${state.collectedCount} / 111`],
            ['Acquisitions', state.acquisitionCount.toString()],
            ['Last accepted bid', last ? formatEth(last.amountWei) : '—'],
            [`${TOKEN_SYMBOL} burned`, `${formatEthBare(state.totalTokenBurnedWei)} ${TOKEN_SYMBOL}`],
        ];
    }
    if (auctions.length === 1) {
        const a = auctions[0];
        return [
            ['Target trait', formatTraitName(a.targetTraitId, traitNames)],
            ['Time remaining', formatDurationFromSeconds(a.endsAt - nowSeconds)],
            ['Opening price', formatEth(a.reserveWei)],
            ['Current bid', a.highBidWei > 0n ? formatEth(a.highBidWei) : '—'],
        ];
    }
    const soonest = auctions.reduce((acc, a) => (a.endsAt < acc.endsAt ? a : acc), auctions[0]);
    const highest = auctions.reduce((acc, a) => (a.highBidWei > acc.highBidWei ? a : acc), auctions[0]);
    return [
        ['Soonest close', formatDurationFromSeconds(soonest.endsAt - nowSeconds)],
        ['Highest current bid', highest.highBidWei > 0n ? formatEth(highest.highBidWei) : '—'],
        ['Traits at stake', auctions.length.toString()],
        ['Open auctions', auctions.length.toString()],
    ];
}

const styles = `
.state-head {
    display: flex;
    justify-content: space-between;
    gap: 30px;
    align-items: flex-end;
    flex-wrap: wrap;
    margin-bottom: 34px;
}
.auction-panel {
    display: grid;
    grid-template-columns: 1.1fr 0.9fr;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.auction-main,
.auction-side {
    background: var(--bg);
    padding: clamp(28px, 5vw, 58px);
}
.auction-title {
    font-family: var(--serif);
    font-size: clamp(30px, 4.6vw, 60px);
    line-height: 1.02;
    letter-spacing: -0.04em;
    margin-bottom: 24px;
    font-weight: 300;
}
.auction-copy {
    font-family: var(--sans);
    font-size: 16px;
    color: var(--muted);
    max-width: 540px;
    line-height: 1.65;
}
.outcomes {
    margin-top: 32px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.outcome {
    background: var(--panel);
    padding: 20px 22px;
}
.outcome-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 8px;
}
.outcome p {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.55;
    color: var(--ink);
    margin: 0;
}
.metrics {
    display: grid;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.metric {
    background: var(--panel);
    padding: 18px 20px;
    display: flex;
    justify-content: space-between;
    gap: 20px;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--muted);
}
.metric strong {
    color: var(--ink);
    font-weight: 500;
    text-align: right;
}
.auction-list {
    display: grid;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    margin-top: 28px;
}
.auction-row {
    background: var(--bg);
    padding: 14px 18px;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 16px;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--muted);
    transition: background 120ms ease;
}
.auction-row:hover {
    background: var(--panel);
}
.auction-row strong {
    color: var(--ink);
    font-weight: 500;
}
.auction-row-thumb {
    flex-shrink: 0;
}
.auction-row-text {
    line-height: 1.5;
}
.auction-close {
    align-self: center;
    color: var(--ink);
}
.auction-single-thumb {
    margin-bottom: 20px;
}
.view-all {
    display: inline-block;
    margin-top: 22px;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    border-bottom: 1px solid var(--line);
    padding-bottom: 3px;
    transition: color 120ms ease, border-color 120ms ease;
}
.view-all:hover {
    color: var(--ink);
    border-bottom-color: var(--ink);
}
.resolved-block {
    margin-top: 40px;
    padding-top: 30px;
    border-top: 1px solid var(--line);
}
.resolved-head {
    margin-bottom: 16px;
}
.resolved-list {
    display: grid;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.resolved-row {
    background: var(--bg);
    padding: 12px 18px;
    display: grid;
    grid-template-columns: auto 1fr 1fr auto auto;
    align-items: center;
    gap: 18px;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--muted);
    transition: background 120ms ease;
}
.resolved-row:hover {
    background: var(--panel);
}
.resolved-thumb {
    flex-shrink: 0;
}
.resolved-punk strong {
    color: var(--ink);
    font-weight: 500;
}
.resolved-trait {
    color: var(--muted);
}
.resolved-outcome {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 8px;
    border: 1px solid currentColor;
    white-space: nowrap;
}
.resolved-outcome-cleared {
    color: #2a8a3e;
}
.resolved-outcome-vaulted {
    color: var(--accent);
}
.resolved-price {
    color: var(--ink);
    text-align: right;
    min-width: 80px;
}
@media (max-width: 820px) {
    .auction-panel {
        grid-template-columns: 1fr;
    }
    .outcomes {
        grid-template-columns: 1fr;
    }
    .resolved-row {
        grid-template-columns: auto 1fr auto;
        gap: 12px;
        row-gap: 6px;
    }
    .resolved-trait,
    .resolved-outcome {
        grid-column: 2 / 4;
    }
    .resolved-outcome {
        justify-self: start;
    }
}
`;
