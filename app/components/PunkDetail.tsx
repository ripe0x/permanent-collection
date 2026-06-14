/* Server-rendered Punk detail page body. Shows the Punk's art + traits, its
   current status in the Permanent Collection, and a provenance timeline that
   merges this protocol's lifecycle events with the Punk's current public
   2017-market listing. All data is indexer/cache-sourced upstream — this
   component is purely presentational. */

import Link from 'next/link';
import {AsOfBadge} from './AsOfBadge';
import {getTokenTicker} from '@/lib/config';
import {
    formatEth,
    formatPunk,
    formatRelative,
    formatTraitName,
    getEvmNowAddressUrl,
    getEvmNowTxUrl,
    shortAddress,
} from '@/lib/format';
import type {PunkProvenance, PunkProvenanceEvent} from '@/lib/data/types';

type Status = 'uncollected' | 'preListed' | 'inReturnAuction' | 'returned' | 'vaulted';

interface Props {
    punkId: number;
    status: Status;
    owner: `0x${string}`;
    ownerLabel?: string;
    traits: {id: number; name: string; kind: string; supply: number}[];
    punkTypeName: string;
    attributeCount: number;
    uncollectedTraitIds: number[];
    pendingTraitIds: number[];
    /** Target trait of the live return auction, when one is running. */
    targetTraitId?: number;
    provenance: PunkProvenance;
    traitNames: readonly string[];
    chainId: number;
    asOfBlock: bigint;
    asOfTimestamp: bigint;
    /** True when an indexer query failed while assembling this page, so the
     *  protocol timeline below may be missing events (see isIndexerDegraded). */
    indexerDegraded?: boolean;
    /** Server-rendered <PunkSvg>, passed as children so the 2.4MB pixel SDK
     *  never lands in the client bundle. */
    punkImage: React.ReactNode;
}

const STATUS_COPY: Record<Status, {label: string; lead: string}> = {
    uncollected: {
        label: 'Uncollected',
        lead: 'This Punk is not in the Permanent Collection. Any uncollected trait it carries is eligible to accept the live bid.',
    },
    preListed: {
        label: 'Listed to Patron',
        lead: 'The owner has listed this Punk exclusively to Patron on the 2017 Punks market at a price at or below the live bid. Anyone can now call `Patron.acceptBid` to finalize the acquisition. Patron buys at the listed price and the 2017 market pays the owner, who collects with `withdraw()`. The Punk then enters its 72-hour return auction.',
    },
    inReturnAuction: {
        label: 'In return auction',
        lead: 'This Punk is in a 72-hour return auction. A bid above the reserve returns it to circulation. If no bid is received, the Punk enters the vault and the target trait becomes permanent.',
    },
    returned: {
        label: 'Returned to market',
        lead: 'A bid above the reserve returned this Punk to circulation. The targeted trait stayed uncollected.',
    },
    vaulted: {
        label: 'Vaulted',
        lead: 'This Punk is vaulted. The vault has no withdrawal path — the target trait is part of the Permanent Collection.',
    },
};

export function PunkDetail({
    punkId,
    status,
    owner,
    ownerLabel,
    traits,
    punkTypeName,
    attributeCount,
    uncollectedTraitIds,
    pendingTraitIds,
    targetTraitId,
    provenance,
    traitNames,
    chainId,
    asOfBlock,
    asOfTimestamp,
    indexerDegraded,
    punkImage,
}: Props) {
    const copy = STATUS_COPY[status];
    const uncollected = new Set(uncollectedTraitIds);
    const pending = new Set(pendingTraitIds);
    const listing = provenance.currentListing;
    const externalUrl = `https://www.cryptopunks.app/cryptopunks/details/${punkId}`;

    return (
        <section className="punk-page">
            <div className="wrap punk-grid">
                <div className="punk-art-col">
                    <div className="punk-detail-image">{punkImage}</div>
                    <a className="external-link" href={externalUrl} target="_blank" rel="noreferrer">
                        Full market history on cryptopunks.app ↗
                    </a>
                </div>

                <div className="punk-main">
                    <div className="punk-head">
                        <div className="kicker">Punk · {punkTypeName}</div>
                        <AsOfBadge
                            block={asOfBlock}
                            timestamp={asOfTimestamp}
                            degraded={indexerDegraded}
                        />
                    </div>
                    <h1 className="section-title">{formatPunk(punkId)}</h1>

                    <div className={`status-pill status-${status}`}>{copy.label}</div>
                    <p className="punk-lead">{copy.lead}</p>

                    {status === 'inReturnAuction' && (
                        <div className="actions">
                            <Link className="primary" href={`/auction/${punkId}`}>
                                View the live auction
                            </Link>
                        </div>
                    )}
                    {status === 'preListed' && (
                        <div className="actions">
                            <Link className="primary" href={`/bid?punk=${punkId}`}>
                                Accept the bid →
                            </Link>
                        </div>
                    )}

                    <div className="punk-facts">
                        <div className="fact">
                            <span className="fact-label">Type</span>
                            <span className="fact-val">{punkTypeName}</span>
                        </div>
                        <div className="fact">
                            <span className="fact-label">Attributes</span>
                            <span className="fact-val tnum">{attributeCount}</span>
                        </div>
                        <div className="fact">
                            <span className="fact-label">Owner</span>
                            <span className="fact-val">
                                <a
                                    className="addr-link"
                                    href={getEvmNowAddressUrl(owner, chainId)}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {shortAddress(owner)}
                                </a>
                            </span>
                        </div>
                        {listing && (
                            <div className="fact">
                                <span className="fact-label">Listed for</span>
                                <span className="fact-val tnum">{formatEth(listing.minValueWei)}</span>
                            </div>
                        )}
                    </div>
                    {ownerLabel && <p className="owner-note">{ownerLabel}</p>}

                    <div className="punk-section">
                        <h2 className="punk-subtitle">Traits</h2>
                        <ul className="trait-list">
                            {traits.map((t) => {
                                const collectable = uncollected.has(t.id) && !pending.has(t.id);
                                const isPending = pending.has(t.id);
                                const isTarget = t.id === targetTraitId;
                                return (
                                    <li key={t.id} className="trait-row">
                                        <Link className="trait-name" href={`/collection/${t.id}`}>
                                            {t.name}
                                        </Link>
                                        <span className="trait-kind">{t.kind}</span>
                                        <span className="trait-supply tnum">{t.supply.toLocaleString()}</span>
                                        <span className="trait-tag">
                                            {isTarget ? (
                                                <em className="tag tag-target">Target trait</em>
                                            ) : isPending ? (
                                                <em className="tag tag-pending">Pending</em>
                                            ) : collectable ? (
                                                <em className="tag tag-open">Uncollected</em>
                                            ) : (
                                                <em className="tag tag-done">Collected</em>
                                            )}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>

                    <div className="punk-section">
                        <h2 className="punk-subtitle">Provenance</h2>
                        {provenance.events.length === 0 ? (
                            <p className="prov-empty">
                                No protocol or market activity recorded for this Punk yet. See its full market
                                history on{' '}
                                <a href={externalUrl} target="_blank" rel="noreferrer">
                                    cryptopunks.app
                                </a>
                                .
                            </p>
                        ) : (
                            <ol className="prov-list">
                                {provenance.events.map((e, i) => (
                                    <ProvenanceRow
                                        key={`${e.txHash ?? 'na'}-${i}`}
                                        event={e}
                                        traitNames={traitNames}
                                        chainId={chainId}
                                    />
                                ))}
                            </ol>
                        )}
                    </div>
                </div>
            </div>
            <style>{styles}</style>
        </section>
    );
}

function ProvenanceRow({
    event,
    traitNames,
    chainId,
}: {
    event: PunkProvenanceEvent;
    traitNames: readonly string[];
    chainId: number;
}) {
    const {title, detail} = describeEvent(event, traitNames);
    return (
        <li className={`prov-row prov-${event.source}`}>
            <div className="prov-marker" aria-hidden="true" />
            <div className="prov-body">
                <div className="prov-line">
                    <span className="prov-title">{title}</span>
                    <span className="prov-source">{event.source === 'market' ? 'Market' : 'Protocol'}</span>
                </div>
                {detail && <div className="prov-detail">{detail}</div>}
                <div className="prov-meta">
                    {event.timestamp > 0n && <span>{formatRelative(event.timestamp)}</span>}
                    {event.actor && (
                        <a
                            className="addr-link"
                            href={getEvmNowAddressUrl(event.actor, chainId)}
                            target="_blank"
                            rel="noreferrer"
                        >
                            {shortAddress(event.actor)}
                        </a>
                    )}
                    {event.counterparty && (
                        <>
                            <span aria-hidden="true">→</span>
                            <a
                                className="addr-link"
                                href={getEvmNowAddressUrl(event.counterparty, chainId)}
                                target="_blank"
                                rel="noreferrer"
                            >
                                {shortAddress(event.counterparty)}
                            </a>
                        </>
                    )}
                    {event.txHash && (
                        <a
                            className="tx-link"
                            href={getEvmNowTxUrl(event.txHash, chainId)}
                            target="_blank"
                            rel="noreferrer"
                        >
                            view tx
                        </a>
                    )}
                </div>
            </div>
        </li>
    );
}

function describeEvent(
    e: PunkProvenanceEvent,
    traitNames: readonly string[],
): {title: string; detail?: string} {
    const amount = e.amountWei !== undefined ? formatEth(e.amountWei) : undefined;
    const trait = e.traitId !== undefined ? formatTraitName(e.traitId, traitNames) : undefined;
    switch (e.kind) {
        case 'listed':
            return {title: 'Listed for sale', detail: amount ? `Public 2017-market offer at ${amount}.` : undefined};
        case 'sale':
            return {title: 'Sold', detail: amount ? `Changed hands for ${amount}.` : 'Changed hands.'};
        case 'transfer':
            return {title: 'Transferred', detail: undefined};
        case 'marketBid':
            return {title: 'Market bid', detail: amount ? `Bid ${amount} on the 2017 market.` : undefined};
        case 'acquired':
            return {
                title: 'Accepted into the protocol',
                detail: [amount && `Paid ${amount}`, trait && `targeting ${trait}`].filter(Boolean).join(' · '),
            };
        case 'bid':
            return {title: 'Return-auction bid', detail: amount ? `Bid ${amount} to return the Punk.` : undefined};
        case 'returned':
            return {
                title: 'Returned to circulation',
                detail: [amount && `Cleared at ${amount}`, trait && `${trait} stayed uncollected`]
                    .filter(Boolean)
                    .join(' · '),
            };
        case 'vaulted':
            return {
                title: 'Vaulted permanently',
                detail: trait ? `${trait} collected — now permanent.` : undefined,
            };
        case 'bidRefill':
            return {
                title: 'Returned to the live bid',
                detail: amount ? `${amount} of the winning bid refilled the live bid.` : undefined,
            };
        case 'tokenBuyBurn':
            return {
                title: 'Bought and burned',
                detail: amount ? `${amount} of the winning bid bought ${getTokenTicker()} and burned it.` : undefined,
            };
        case 'tokenBurn':
            return {
                title: 'Vault burn',
                detail: amount
                    ? `${amount} routed to the vault-burn pool, which buys and burns ${getTokenTicker()}.`
                    : undefined,
            };
    }
}

const styles = `
.punk-page {
    padding-top: clamp(40px, 6vh, 80px);
    padding-bottom: clamp(80px, 12vh, 160px);
    border-top: none;
}
.punk-grid {
    display: grid;
    grid-template-columns: minmax(0, 360px) minmax(0, 1fr);
    gap: clamp(40px, 6vw, 80px);
    align-items: start;
}
.punk-art-col {
    display: flex;
    flex-direction: column;
    gap: 14px;
    position: sticky;
    top: 78px;
}
.punk-detail-image {
    line-height: 0;
    border: 1px solid var(--line);
    background: var(--panel);
}
.punk-detail-image .punk-svg {
    width: 100% !important;
    height: auto !important;
    aspect-ratio: 1;
}
.punk-detail-image .punk-svg svg {
    width: 100% !important;
    height: 100% !important;
}
.external-link {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--muted);
    text-decoration: underline;
    text-underline-offset: 3px;
}
.external-link:hover {
    color: var(--ink);
}
.punk-main {
    display: flex;
    flex-direction: column;
    gap: 18px;
}
.punk-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
}
.status-pill {
    align-self: flex-start;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 5px 10px;
    border: 1px solid var(--line);
}
.status-uncollected { color: var(--muted); }
.status-inReturnAuction { color: var(--pending); border-color: var(--pending); }
.status-returned { color: var(--ink); }
.status-vaulted { color: var(--ink); border-color: var(--ink); background: var(--panel); }
.punk-lead {
    font-family: var(--serif);
    font-size: clamp(18px, 2.2vw, 24px);
    line-height: 1.3;
    letter-spacing: -0.02em;
    max-width: 640px;
}
.actions {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
}
.punk-facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    margin-top: 4px;
}
.fact {
    background: var(--panel);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.fact-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
}
.fact-val {
    font-family: var(--mono);
    font-size: 15px;
    color: var(--ink);
}
.owner-note {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
}
.addr-link, .tx-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
.punk-section {
    margin-top: 14px;
    border-top: 1px solid var(--line);
    padding-top: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
}
.punk-subtitle {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.trait-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.trait-row {
    background: var(--panel);
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.8fr) auto auto;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    font-family: var(--mono);
    font-size: 13px;
}
.trait-name {
    color: var(--ink);
    border-bottom: 1px dotted var(--line);
}
.trait-name:hover { border-bottom-color: var(--accent); }
.trait-kind {
    color: var(--muted);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}
.trait-supply { color: var(--muted); text-align: right; }
.trait-tag { text-align: right; }
.tag {
    font-style: normal;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 7px;
    border: 1px solid var(--line);
    color: var(--muted);
}
.tag-open { color: var(--ink); border-color: var(--ink); }
.tag-pending { color: var(--pending); border-color: var(--pending); }
.tag-target { color: var(--bg); background: var(--accent); border-color: var(--accent); }
.tag-done { color: var(--muted); }
.prov-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
}
.prov-row {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 14px;
    padding: 0 0 20px;
    position: relative;
}
.prov-row:not(:last-child)::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 14px;
    bottom: 0;
    width: 1px;
    background: var(--line);
}
.prov-marker {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    margin-top: 3px;
    border: 1px solid var(--ink);
    background: var(--bg);
}
.prov-market .prov-marker { border-color: var(--muted); }
.prov-protocol .prov-marker { background: var(--ink); }
.prov-body { display: flex; flex-direction: column; gap: 5px; }
.prov-line {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
}
.prov-title {
    font-family: var(--serif);
    font-size: 16px;
    color: var(--ink);
}
.prov-source {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
}
.prov-detail {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
}
.prov-meta {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
}
.prov-empty {
    font-family: var(--sans);
    font-size: 14px;
    color: var(--muted);
    line-height: 1.6;
}
.prov-empty a { color: var(--accent); text-decoration: underline; }
@media (max-width: 880px) {
    .punk-grid { grid-template-columns: 1fr; }
    .punk-art-col { position: static; max-width: 360px; }
    .trait-row { grid-template-columns: minmax(0, 1fr) auto; }
    .trait-kind, .trait-supply { display: none; }
}
`;
