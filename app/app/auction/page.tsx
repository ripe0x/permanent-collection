import type {Metadata} from 'next';
import Link from 'next/link';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {PunkSvg} from '@/components/PunkSvg';
import {getDataAdapter} from '@/lib/data';
import type {ActiveAuction, ResolvedAuction} from '@/lib/data/types';
import {formatDurationFromSeconds, formatEth, formatPunk, formatTraitName, shortAddress} from '@/lib/format';
import {buildMeta} from '@/lib/meta';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = buildMeta({
    title: 'Auctions — Permanent Collection',
    description:
        'Every active 72-hour return auction, plus the resolved history. Cleared auctions returned a Punk to the market; vaulted auctions ended in silence and a permanent trait.',
    path: '/auction',
});

export default async function AuctionsListPage() {
    const adapter = getDataAdapter();
    const [active, resolved, traitNames] = await Promise.all([
        adapter.getActiveAuctions().catch(() => [] as ActiveAuction[]),
        adapter.getRecentResolutions(50).catch(() => [] as ResolvedAuction[]),
        adapter.getTraitNames().catch(() => undefined),
    ]);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

    return (
        <>
            <Header />
            <main id="top">
                <section className="auctions-hero" aria-label="Auctions">
                    <div className="wrap">
                        <div className="kicker">Auctions</div>
                        <h1 className="auctions-h1">
                            Every return auction, active and past.
                        </h1>
                        <p className="auctions-lede">
                            When a Punk owner accepts the live bid, the Punk enters a 72-hour
                            return auction. A bid at or above the reserve returns the Punk to
                            circulation. No bid by the deadline vaults the Punk — and the
                            chosen trait becomes permanent.
                        </p>
                    </div>
                </section>

                <section className="auctions-section" aria-label="Active return auctions">
                    <div className="wrap">
                        <h2 className="auctions-h2">
                            Active ({active.length})
                        </h2>
                        {active.length === 0 ? (
                            <p className="auctions-empty">
                                No active return auctions. The live bid is still standing —
                                see <Link href="/bid">/bid</Link> if you own a Punk
                                that carries an uncollected trait.
                            </p>
                        ) : (
                            <div className="auctions-grid">
                                {active.map((a) => (
                                    <ActiveAuctionCard
                                        key={a.punkId}
                                        auction={a}
                                        nowSeconds={nowSeconds}
                                        traitNames={traitNames}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </section>

                {resolved.length > 0 && (
                    <section className="auctions-section" aria-label="Settled return auctions">
                        <div className="wrap">
                            <h2 className="auctions-h2">Settled auctions ({resolved.length})</h2>
                            <div className="resolved-list">
                                {resolved.map((r) => (
                                    <ResolvedRow key={r.punkId} row={r} traitNames={traitNames} />
                                ))}
                            </div>
                        </div>
                    </section>
                )}
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

function ActiveAuctionCard({
    auction,
    nowSeconds,
    traitNames,
}: {
    auction: ActiveAuction;
    nowSeconds: bigint;
    traitNames?: readonly string[];
}) {
    const remaining = auction.endsAt > nowSeconds ? auction.endsAt - nowSeconds : 0n;
    // With a live high bid, the bid IS the price that matters — show it in place
    // of the reserve rather than both.
    const hasBid = auction.highBidWei > 0n;
    return (
        <Link href={`/auction/${auction.punkId}`} className="auction-card">
            <div className="auction-card-svg">
                <PunkSvg punkId={auction.punkId} label={`Punk #${auction.punkId}`} fill />
            </div>
            <div className="auction-card-body">
                <div className="auction-card-id">{formatPunk(auction.punkId)}</div>
                <div className="auction-card-trait">
                    Target: {formatTraitName(auction.targetTraitId, traitNames)}
                </div>
                <div className="auction-card-stat-row">
                    <div className="auction-card-stat">
                        <span className="auction-card-stat-label">Time left</span>
                        <span className="auction-card-stat-value tnum">
                            {remaining > 0n ? formatDurationFromSeconds(remaining) : 'Closed'}
                        </span>
                    </div>
                    <div className="auction-card-stat">
                        <span className="auction-card-stat-label">{hasBid ? 'Current bid' : 'Reserve'}</span>
                        <span className="auction-card-stat-value tnum">
                            {hasBid ? formatEth(auction.highBidWei) : formatEth(auction.reserveWei)}
                        </span>
                    </div>
                </div>
                {auction.highBidder && (
                    <div className="auction-card-bidder">
                        Bidder: <span className="tnum">{shortAddress(auction.highBidder)}</span>
                    </div>
                )}
                {auction.extensions > 0 && (
                    <div className="auction-card-extensions">
                        {auction.extensions} anti-snipe extension{auction.extensions === 1 ? '' : 's'}
                    </div>
                )}
            </div>
        </Link>
    );
}

function ResolvedRow({row, traitNames}: {row: ResolvedAuction; traitNames?: readonly string[]}) {
    const cleared = row.outcome === 'cleared';
    return (
        <Link href={`/punk/${row.punkId}`} className="resolved-row">
            <div className="resolved-svg">
                <PunkSvg punkId={row.punkId} label={`Punk #${row.punkId}`} fill />
            </div>
            <div className="resolved-meta">
                <div className="resolved-id">{formatPunk(row.punkId)}</div>
                <div className="resolved-trait">{formatTraitName(row.targetTraitId, traitNames)}</div>
            </div>
            <div className={`resolved-outcome ${cleared ? 'cleared' : 'vaulted'}`}>
                {cleared ? 'Returned to market' : 'Vaulted'}
            </div>
            <div className="resolved-bid tnum">
                {cleared
                    ? row.finalBidWei > 0n
                        ? formatEth(row.finalBidWei)
                        : '—'
                    : row.acquisitionPriceWei !== undefined && row.acquisitionPriceWei > 0n
                      ? formatEth(row.acquisitionPriceWei)
                      : '—'}
            </div>
        </Link>
    );
}

const styles = `
.auctions-hero {
    padding: 72px var(--pad) 36px;
}
.auctions-h1 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(28px, 4.4vw, 44px);
    line-height: 1.12;
    letter-spacing: -0.035em;
    margin: 14px 0 18px;
    max-width: 26ch;
}
.auctions-lede {
    font-family: var(--sans);
    font-size: 16px;
    max-width: 56ch;
    color: var(--muted);
    line-height: 1.6;
}
.auctions-section {
    padding: 28px var(--pad);
}
.auctions-h2 {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 16px;
}
.auctions-empty {
    color: var(--muted);
    font-size: 14px;
    line-height: 1.55;
}
.auctions-empty a {
    color: var(--ink);
    border-bottom: 1px dotted var(--muted);
}
.auctions-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
}
.auction-card {
    display: grid;
    grid-template-rows: auto auto;
    gap: 14px;
    text-decoration: none;
    color: var(--ink);
    border: 1px solid var(--line);
    padding: 16px;
    transition: border-color 120ms ease, background 120ms ease;
}
.auction-card:hover {
    border-color: var(--ink);
    background: rgba(0, 0, 0, 0.02);
}
.auction-card-svg {
    width: 100%;
    aspect-ratio: 1 / 1;
    overflow: hidden;
    background: var(--punk-blue);
    display: flex;
}
.auction-card-svg .punk-svg { width: 100%; height: 100%; }
.auction-card-svg svg { width: 100%; height: 100%; image-rendering: pixelated; }
.auction-card-id {
    font-family: var(--mono);
    font-size: 13px;
    letter-spacing: 0.06em;
}
.auction-card-trait {
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 8px;
}
.auction-card-stat-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 6px;
}
.auction-card-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.auction-card-stat-label {
    color: var(--muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
}
.auction-card-stat-value {
    font-size: 13px;
}
.auction-card-bidder,
.auction-card-extensions {
    color: var(--muted);
    font-size: 11px;
    margin-top: 4px;
}
.resolved-list {
    display: grid;
    gap: 0;
    border-top: 1px solid var(--line);
}
.resolved-row {
    display: grid;
    grid-template-columns: 40px 1fr auto auto;
    gap: 12px;
    align-items: center;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
    text-decoration: none;
    color: var(--ink);
    font-size: 13px;
}
.resolved-row:hover {
    background: rgba(0, 0, 0, 0.02);
}
.resolved-svg {
    width: 40px;
    height: 40px;
    overflow: hidden;
    background: var(--punk-blue);
}
.resolved-svg svg { width: 100%; height: 100%; image-rendering: pixelated; }
.resolved-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.resolved-id {
    font-family: var(--mono);
    font-size: 12px;
}
.resolved-trait {
    color: var(--muted);
    font-size: 12px;
}
.resolved-outcome {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}
.resolved-outcome.cleared { color: var(--muted); }
.resolved-outcome.vaulted { color: var(--ink); }
.resolved-bid {
    font-size: 12px;
    text-align: right;
    min-width: 80px;
}
`;
