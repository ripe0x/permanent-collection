/* Homepage banner. Renders when the Title Auction is live OR settleable,
   linking visitors to the dedicated /title page. The banner sits above
   AuctionSection — both surfaces stack and never hide each other (Title
   Auction is rare and newsworthy, but doesn't supplant the standing
   return-auction state).

   Server component, no interactivity beyond the link. */

import Link from 'next/link';
import type {TitleAuctionState} from '@/lib/data/types';
import {formatDurationFromSeconds, formatEth} from '@/lib/format';
import {COLLECTION, TITLE} from '@/lib/protocol-params';

export function TitleAuctionBanner({
    state,
    nowSeconds,
}: {
    state: TitleAuctionState;
    nowSeconds: bigint;
}) {
    // Surfaces from the moment the kickoff threshold is met (kickoff-ready)
    // through any in-progress / settleable round. Hidden pre-threshold and
    // post-settle. "Active" in the user's framing = the threshold has
    // been crossed → there's something for the homepage to point at. The
    // gate is `KICKOFF_THRESHOLD = 22` in PunkVaultTitleAuction.sol.
    const visible =
        state.phase === 'kickoff-ready' ||
        state.phase === 'live' ||
        state.phase === 'settleable';
    if (!visible) return null;
    const remaining = state.endsAt > nowSeconds ? state.endsAt - nowSeconds : 0n;
    const hasHigh = state.highBidWei > 0n;
    const kicker =
        state.phase === 'kickoff-ready'
            ? 'The Title · ready to start'
            : 'The Title · live auction';
    const headline =
        state.phase === 'kickoff-ready'
            ? `${TITLE.kickoffThreshold} traits are permanent. Start the Title Auction.`
            : state.phase === 'live'
              ? 'The vault Title is for sale.'
              : hasHigh
                ? 'Bidding window closed — settle now.'
                : 'No-bid round. Settle to restart the auction.';
    return (
        <Link href="/title" className="title-banner" aria-label="Title Auction status">
            <div className="wrap title-banner-inner">
                <div className="title-banner-text">
                    <span className="title-banner-kicker">{kicker}</span>
                    <h3 className="title-banner-headline">{headline}</h3>
                </div>
                <div className="title-banner-stats">
                    {state.phase === 'kickoff-ready' ? (
                        <>
                            <Stat label="collected" value={`${state.collectedCount} / ${COLLECTION.totalTraits}`} primary />
                            <Stat label="next step" value="kickoff" />
                        </>
                    ) : (
                        <>
                            <Stat
                                label={hasHigh ? 'high bid' : 'no bid yet'}
                                value={hasHigh ? formatEth(state.highBidWei) : '—'}
                                primary
                            />
                            <Stat
                                label={state.phase === 'live' ? 'time left' : 'state'}
                                value={
                                    state.phase === 'live'
                                        ? formatDurationFromSeconds(remaining)
                                        : 'settleable'
                                }
                            />
                        </>
                    )}
                </div>
            </div>
            <style>{styles}</style>
        </Link>
    );
}

function Stat({
    label,
    value,
    primary,
}: {
    label: string;
    value: string;
    primary?: boolean;
}) {
    return (
        <div className={`title-banner-stat ${primary ? 'title-banner-stat-primary' : ''}`}>
            <span className="title-banner-stat-label">{label}</span>
            <strong className="title-banner-stat-value tnum">{value}</strong>
        </div>
    );
}

const styles = `
.title-banner {
    display: block;
    text-decoration: none;
    color: inherit;
    background: var(--ink);
    color: var(--bg);
    border-bottom: 1px solid var(--line);
    padding: clamp(16px, 2vh, 24px) 0;
    transition: background 120ms ease;
}
.title-banner:hover {
    background: #111;
}
.title-banner-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: clamp(16px, 3vw, 36px);
    flex-wrap: wrap;
}
.title-banner-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.title-banner-kicker {
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    opacity: 0.7;
}
.title-banner-headline {
    font-family: var(--serif);
    font-size: clamp(20px, 2.4vw, 28px);
    line-height: 1.15;
    letter-spacing: -0.02em;
    margin: 0;
    font-weight: 300;
}
.title-banner-stats {
    display: flex;
    gap: clamp(16px, 3vw, 36px);
    align-items: center;
}
.title-banner-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 110px;
}
.title-banner-stat-label {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    opacity: 0.6;
}
.title-banner-stat-value {
    font-family: var(--mono);
    font-size: 18px;
}
.title-banner-stat-primary .title-banner-stat-value {
    font-size: 22px;
    color: var(--accent);
}
@media (max-width: 560px) {
    .title-banner-stats {
        gap: 18px;
    }
    .title-banner-stat {
        min-width: 0;
    }
}
`;
