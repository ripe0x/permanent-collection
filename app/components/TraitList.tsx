/* Below the grid: a named list of all 111 traits grouped by state. The grid
   is the at-a-glance shape; this list is where users find a specific trait by
   name (Mohawk / Pipe / Cap / etc.).

   Each row carries a small SDK-rendered pixel thumbnail (the on-chain
   canonical exemplar Punk for that trait) plus the trait's supply, so the
   visual context shows up at scan-time without a click into the detail page.
*/
import Link from 'next/link';
import {PunkSvg} from '@/components/PunkSvg';
import {canonicalPunkId} from '@/lib/canonical-punks';
import type {ActiveAuction, TraitView} from '@/lib/data/types';
import {formatDurationFromSeconds, formatEth, formatPunk} from '@/lib/format';
import {getPunksSdk} from '@/lib/punks-sdk';
import {renderTraitTileContent} from '@/lib/trait-tile';

/** Isolated trait visual (no Punk) on the dim trait-detail surface — the same
 *  artwork the on-chain renderer draws for an uncollected slot. Used for the
 *  uncollected list so each row shows the trait itself, not a Punk wearing it. */
function TraitThumb({traitId, label, size}: {traitId: number; label: string; size: number}) {
    return (
        <span
            className="trait-thumb trait-thumb-isolated"
            role="img"
            aria-label={label}
            style={{width: size, height: size}}
        >
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                shapeRendering="crispEdges"
                dangerouslySetInnerHTML={{__html: renderTraitTileContent(traitId)}}
            />
        </span>
    );
}

export function TraitList({
    traits,
    auctionByTrait,
    nowSeconds,
}: {
    traits: TraitView[];
    /** Map of pending traitId → live auction record. Provided when the
     *  page knows which Punk's auction is putting each trait in flight,
     *  along with the current bid/reserve and deadline. */
    auctionByTrait?: Map<number, ActiveAuction>;
    /** Chain timestamp (seconds) used to render the countdown column.
     *  Server-rendered once; the row labels are intentionally static
     *  (not a live tick) — the row links to the detail page for the
     *  high-precision clock. */
    nowSeconds?: bigint;
}) {
    const sdk = getPunksSdk();
    const records = new Map(sdk.dataset.traits().map((t) => [t.id, t]));
    const permanent = traits.filter((t) => t.state === 'permanent');
    const pending = traits.filter((t) => t.state === 'pending');
    const uncollected = traits.filter((t) => t.state === 'uncollected');

    function rowMeta(t: TraitView) {
        const rec = records.get(t.traitId);
        // Pending and permanent rows want a Punk image with a story:
        //   permanent → the vaulted Punk that brought it in.
        //   pending   → the Punk currently in the auction for it.
        //   else      → the canonical exemplar from the on-chain renderer.
        const thumbPunkId =
            t.state === 'permanent' && t.firstVaultedPunkId !== undefined
                ? t.firstVaultedPunkId
                : t.state === 'pending' && auctionByTrait?.get(t.traitId) !== undefined
                  ? auctionByTrait.get(t.traitId)!.punkId
                  : canonicalPunkId(t.traitId);
        return {rec, thumbPunkId};
    }

    return (
        <div className="trait-list-wrap">
            <Section title="Permanent" count={permanent.length} kicker="The artwork's locked-in slots">
                {permanent.length === 0 ? (
                    <p className="empty">No traits permanent yet. The first vault outcome locks in the first one.</p>
                ) : (
                    <ul className="trait-rows">
                        {permanent.map((t) => {
                            const {rec, thumbPunkId} = rowMeta(t);
                            return (
                                <li key={t.traitId} className="trait-row trait-permanent">
                                    <Link href={`/collection/${t.traitId}`} className="trait-link">
                                        <PunkSvg
                                            punkId={thumbPunkId}
                                            size={48}
                                            label={rec?.name ?? `trait ${t.traitId}`}
                                            background="classic"
                                            className="trait-thumb trait-thumb-classic"
                                        />
                                        <span className="trait-num tnum">#{t.traitId}</span>
                                        <span className="trait-name">{rec?.name ?? `Trait ${t.traitId}`}</span>
                                        <span className="trait-meta">
                                            {rec && (
                                                <span className="trait-supply tnum">
                                                    {rec.supply.toLocaleString()} of 10k
                                                </span>
                                            )}
                                            {t.firstVaultedPunkId !== undefined && (
                                                <span>via {formatPunk(t.firstVaultedPunkId)}</span>
                                            )}
                                            {t.acceptedBidWei !== undefined && (
                                                <span className="trait-bid tnum">{formatEth(t.acceptedBidWei)}</span>
                                            )}
                                        </span>
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </Section>

            <Section title="In return auction" count={pending.length} kicker="Decided in the next 72 hours">
                {pending.length === 0 ? (
                    <p className="empty">No traits in active auction.</p>
                ) : (
                    <ul className="trait-rows">
                        {pending.map((t) => {
                            const {rec, thumbPunkId} = rowMeta(t);
                            const auction = auctionByTrait?.get(t.traitId);
                            const hasBid = auction !== undefined && auction.highBidWei > 0n;
                            const priceLabel = hasBid ? 'current bid' : 'reserve';
                            const priceValue = auction
                                ? hasBid
                                    ? formatEth(auction.highBidWei)
                                    : formatEth(auction.reserveWei)
                                : null;
                            const remaining = auction && nowSeconds !== undefined
                                ? auction.endsAt > nowSeconds
                                    ? auction.endsAt - nowSeconds
                                    : 0n
                                : null;
                            return (
                                <li key={t.traitId} className="trait-row trait-pending">
                                    <Link
                                        href={
                                            auction
                                                ? `/auction/${auction.punkId}`
                                                : `/collection/${t.traitId}`
                                        }
                                        className="trait-link trait-link-auction"
                                    >
                                        <PunkSvg
                                            punkId={thumbPunkId}
                                            size={48}
                                            label={rec?.name ?? `trait ${t.traitId}`}
                                            background="transparent"
                                            className="trait-thumb"
                                        />
                                        <span className="trait-num tnum">#{t.traitId}</span>
                                        <span className="trait-id-block">
                                            <span className="trait-name">{rec?.name ?? `Trait ${t.traitId}`}</span>
                                            {auction && (
                                                <span className="trait-sub">
                                                    {formatPunk(auction.punkId)}&apos;s auction
                                                </span>
                                            )}
                                        </span>
                                        <span className="trait-auction-cell trait-auction-price">
                                            <span className="trait-auction-label">{priceLabel}</span>
                                            <span className="trait-auction-value tnum">
                                                {priceValue ?? '—'}
                                            </span>
                                        </span>
                                        <span className="trait-auction-cell trait-auction-time">
                                            <span className="trait-auction-label">time left</span>
                                            <span className="trait-auction-value tnum">
                                                {remaining === null
                                                    ? '—'
                                                    : remaining === 0n
                                                      ? 'ended'
                                                      : formatDurationFromSeconds(remaining)}
                                            </span>
                                        </span>
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </Section>

            <Section title="Uncollected" count={uncollected.length} kicker="Open to acceptance">
                <ul className="trait-rows trait-rows-compact">
                    {uncollected.map((t) => {
                        const {rec} = rowMeta(t);
                        return (
                            <li key={t.traitId} className="trait-row trait-uncollected">
                                <Link href={`/collection/${t.traitId}`} className="trait-link trait-link-compact">
                                    <TraitThumb
                                        traitId={t.traitId}
                                        size={40}
                                        label={rec?.name ?? `trait ${t.traitId}`}
                                    />
                                    <span className="trait-num tnum">#{t.traitId}</span>
                                    <span className="trait-name">{rec?.name ?? `Trait ${t.traitId}`}</span>
                                    {rec && <span className="trait-supply tnum">{rec.supply}</span>}
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            </Section>
            <style>{styles}</style>
        </div>
    );
}

function Section({
    title,
    count,
    kicker,
    children,
}: {
    title: string;
    count: number;
    kicker: string;
    children: React.ReactNode;
}) {
    return (
        <div className="trait-section">
            <div className="trait-section-head">
                <div>
                    <div className="kicker">{kicker}</div>
                    <h3 className="trait-section-title">
                        {title} <span className="trait-section-count tnum">{count}</span>
                    </h3>
                </div>
            </div>
            {children}
        </div>
    );
}

const styles = `
.trait-list-wrap {
    display: flex;
    flex-direction: column;
    gap: clamp(40px, 6vh, 64px);
    margin-top: clamp(40px, 6vh, 80px);
}
.trait-section {
    display: flex;
    flex-direction: column;
    gap: 18px;
}
.trait-section-title {
    font-family: var(--serif);
    font-size: clamp(28px, 3.5vw, 42px);
    font-weight: 300;
    letter-spacing: -0.035em;
    line-height: 1;
    display: flex;
    align-items: baseline;
    gap: 14px;
}
.trait-section-count {
    font-family: var(--mono);
    font-size: 18px;
    color: var(--muted);
    letter-spacing: 0;
}
.trait-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.trait-rows-compact {
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}
.trait-row {
    background: var(--bg);
}
.trait-row.trait-pending {
    background: var(--panel);
}
.trait-row.trait-permanent .trait-link {
    color: var(--ink);
}
.trait-link {
    display: grid;
    grid-template-columns: 48px 48px 1fr auto;
    align-items: center;
    gap: 14px;
    padding: 10px 16px;
    font-family: var(--sans);
    font-size: 15px;
    color: var(--ink);
    transition: background 100ms ease;
}
.trait-link:hover {
    background: var(--panel);
}
.trait-row.trait-pending .trait-link:hover {
    background: var(--bg);
}
.trait-link-compact {
    grid-template-columns: 40px 40px 1fr auto;
    padding: 8px 12px;
    gap: 10px;
}
.trait-thumb {
    background: transparent !important;
    border: 1px solid var(--line);
    line-height: 0;
}
.trait-thumb-classic {
    /* Permanent rows: collection tile color baked behind the SVG; tighten
       the row border to match so the tile reads as one unified swatch. */
    background: #8F918B !important;
    border-color: #8F918B;
}
.trait-thumb-isolated {
    /* Uncollected rows: the isolated trait visual on the dim trait-detail
       surface — same tile color the detail-page hero uses for an
       uncollected slot. */
    background: var(--tile-dark) !important;
    border-color: var(--tile-dark);
    display: block;
    line-height: 0;
}
.trait-thumb-isolated svg {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    shape-rendering: crispEdges;
}
.trait-num {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.04em;
}
.trait-name {
    font-family: var(--serif);
    font-size: 17px;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.trait-row.trait-uncollected .trait-name {
    color: var(--ink);
}
.trait-meta {
    display: inline-flex;
    gap: 14px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    align-items: center;
}
.trait-supply {
    color: var(--muted);
    letter-spacing: 0.02em;
}
.trait-bid {
    color: var(--accent);
}
/* Pending rows: 5-col grid swaps the right-side metadata cell for two
   auction columns (price + countdown), so the row reads like a small
   auction summary. */
.trait-link-auction {
    grid-template-columns: 48px 48px 1fr auto auto;
    gap: 18px;
}
.trait-id-block {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    overflow: hidden;
}
.trait-sub {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.02em;
}
.trait-auction-cell {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    min-width: 90px;
}
.trait-auction-label {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
}
.trait-auction-price .trait-auction-value {
    color: var(--pending);
    font-size: 16px;
}
.trait-auction-time .trait-auction-value {
    color: var(--ink);
    font-size: 14px;
}
.empty {
    font-family: var(--sans);
    font-size: 14px;
    color: var(--muted);
    padding: 14px 18px;
    border: 1px solid var(--line);
    background: var(--panel);
}

@media (max-width: 560px) {
    .trait-link {
        grid-template-columns: 44px 36px 1fr;
    }
    .trait-meta {
        grid-column: 1 / -1;
        padding-left: 92px;
    }
    .trait-link-auction {
        grid-template-columns: 44px 36px 1fr;
    }
    .trait-auction-cell {
        grid-column: 1 / -1;
        flex-direction: row;
        align-items: baseline;
        justify-content: space-between;
        padding-left: 92px;
        min-width: 0;
    }
}
`;
