/* Shared render for the value-distribution snapshot: a refresh bar, the
 * per-location pipeline (each step's CURRENT holding + TOTAL distributed +
 * readiness), and the merged event history. Server component — the page
 * resolves `getDistributionSnapshot()` and passes it in, so the same panel
 * can live on both /debug/fees and /debug/distribution. Stations that rely
 * on a permissionless keeper call carry a "Keeper" tag and an execute
 * button (KeeperPanel, a client component). */

import {DebugRefreshBar} from '@/components/DebugRefreshBar';
import {KeeperPanel} from '@/components/KeeperPanel';
import {getChainId} from '@/lib/config';
import {formatRelative, getEvmNowAddressUrl, getEvmNowTxUrl} from '@/lib/format';
import type {DistroSnapshot, DistroStation} from '@/lib/server/distribution';

export function DistributionPanel({snapshot: snap}: {snapshot: DistroSnapshot}) {
    const chainId = getChainId();
    return (
        <div className="ddist-panel">
            <DebugRefreshBar asOfMs={snap.asOfMs} asOfBlock={snap.asOfBlock} />

            {snap.notes.length > 0 && (
                <div className="ddist-notes" role="note">
                    {snap.notes.map((n, i) => (
                        <div key={i}>· {n}</div>
                    ))}
                </div>
            )}

            {!snap.live ? (
                <div className="ddist-empty">
                    Nothing to show yet. Deploy the protocol on a local fork (token
                    configured) and this fills in.
                </div>
            ) : (
                <>
                    <div className="ddist-headline">
                        <div className="ddist-hl-primary">
                            <span className="ddist-hl-label">Team earned (lifetime)</span>
                            <span className="ddist-hl-value">{snap.headline.teamEarned}</span>
                            {snap.headline.teamRecipient !== '—' && (
                                <a
                                    className="ddist-hl-recip"
                                    href={getEvmNowAddressUrl(snap.headline.teamRecipient, chainId)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="Team fee recipient (treasury)"
                                >
                                    → {snap.headline.teamRecipient} ↗
                                </a>
                            )}
                        </div>
                        <div className="ddist-hl-secondary">
                            <div className="ddist-hl-stat">
                                <span className="ddist-hl-slabel">To LAYER burn</span>
                                <span className="ddist-hl-sval">{snap.headline.layerBurned}</span>
                            </div>
                            <div className="ddist-hl-stat">
                                <span className="ddist-hl-slabel">Total volume</span>
                                <span className="ddist-hl-sval">{snap.headline.volume}</span>
                            </div>
                        </div>
                    </div>

                    <h2 className="ddist-h2">Pipeline status</h2>
                    <div className="ddist-flow">
                        {snap.stations.map((s, i) => (
                            <div key={s.key} className="ddist-step-wrap">
                                <StationCard station={s} chainId={chainId} />
                                {i < snap.stations.length - 1 && (
                                    <div className="ddist-arrow" aria-hidden="true">
                                        ↓
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    <h2 className="ddist-h2">
                        History
                        <span className="ddist-count">{snap.history.length}</span>
                    </h2>
                    {snap.history.length === 0 ? (
                        <div className="ddist-empty">
                            No distribution events yet from the deploy block. Run a swap or an
                            auction stage, then refresh.
                        </div>
                    ) : (
                        <div className="ddist-history">
                            <div className="ddist-hrow ddist-hhead">
                                <span>Time</span>
                                <span>Contract</span>
                                <span>Event</span>
                                <span>Detail</span>
                            </div>
                            {snap.history.map((e) => (
                                <div key={e.id} className="ddist-hrow" title={e.txHash ?? ''}>
                                    <span className="ddist-time">
                                        {e.txHash ? (
                                            <a
                                                href={getEvmNowTxUrl(e.txHash, chainId)}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="ddist-txlink"
                                            >
                                                {formatRelative(BigInt(e.tsSecs))} ↗
                                            </a>
                                        ) : (
                                            formatRelative(BigInt(e.tsSecs))
                                        )}
                                    </span>
                                    <span className="ddist-contract">{e.contract}</span>
                                    <span className="ddist-event">{e.name}</span>
                                    <span className="ddist-detail">{e.summary}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    <h2 className="ddist-h2">Distribution recipients</h2>
                    <p className="ddist-recip-note">
                        The contracts each leg of the fee distribution flows to. The LAYER
                        BurnRouter is discovered at runtime via the controller, so it always
                        reflects the live router.
                    </p>
                    <div className="ddist-recips">
                        {snap.headline.teamRecipient !== '—' && (
                            <RecipientRow
                                label="PC treasury (team)"
                                address={snap.headline.teamRecipient}
                                chainId={chainId}
                            />
                        )}
                        {snap.stations
                            .filter((s) => s.present && s.address)
                            .map((s) => (
                                <RecipientRow
                                    key={s.key}
                                    label={s.label}
                                    address={s.address as string}
                                    chainId={chainId}
                                />
                            ))}
                    </div>
                </>
            )}
            <style>{styles}</style>
        </div>
    );
}

function StationCard({station: s, chainId}: {station: DistroStation; chainId: number}) {
    return (
        <div className={`ddist-card${s.present ? '' : ' is-missing'}`}>
            <div className="ddist-card-head">
                <span className="ddist-card-headline">
                    <span className="ddist-card-label">{s.label}</span>
                    {s.keeper && <span className="ddist-keeper-tag">Keeper</span>}
                </span>
                {s.ready && (
                    <span className={`ddist-chip${s.ready.ok ? ' is-ok' : ''}`}>
                        <span className="ddist-chip-dot" aria-hidden="true" />
                        {s.ready.label}
                    </span>
                )}
            </div>
            <div className="ddist-card-main">
                <div className="ddist-metric">
                    <span className="ddist-card-mlabel">Current · {s.currentLabel}</span>
                    <span className="ddist-card-mval">{s.currentValue}</span>
                </div>
                <div className="ddist-metric ddist-metric-total">
                    <span className="ddist-card-mlabel">Total · {s.totalLabel}</span>
                    <span className="ddist-card-mval">{s.totalValue}</span>
                </div>
            </div>
            <p className="ddist-card-role">{s.role}</p>
            {s.rows.length > 0 && (
                <dl className="ddist-rows">
                    {s.rows.map((r) => (
                        <div key={r.k} className="ddist-row">
                            <dt>{r.k}</dt>
                            <dd>{r.v}</dd>
                        </div>
                    ))}
                </dl>
            )}
            {s.address && (
                <a
                    className="ddist-addr"
                    href={getEvmNowAddressUrl(s.address, chainId)}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {s.address} ↗
                </a>
            )}
            {s.keeper && <KeeperPanel hint={s.keeper.hint} actions={s.keeper.actions} />}
        </div>
    );
}

function RecipientRow({label, address, chainId}: {label: string; address: string; chainId: number}) {
    return (
        <div className="ddist-recip">
            <span className="ddist-recip-label">{label}</span>
            <a
                className="ddist-recip-addr"
                href={getEvmNowAddressUrl(address, chainId)}
                target="_blank"
                rel="noopener noreferrer"
            >
                {address} ↗
            </a>
        </div>
    );
}

const styles = `
.ddist-panel { display: block; }
.ddist-headline {
    margin: 18px 0 8px;
    padding: 20px 22px;
    border: 1px solid var(--accent);
    background: var(--panel);
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 18px;
}
.ddist-hl-primary { display: flex; flex-direction: column; gap: 6px; }
.ddist-hl-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
}
.ddist-hl-value {
    font-family: var(--sans);
    font-size: 32px;
    line-height: 1;
    color: var(--accent);
    font-weight: 600;
}
.ddist-hl-secondary { display: flex; gap: 28px; }
.ddist-hl-stat { display: flex; flex-direction: column; gap: 4px; text-align: right; }
.ddist-hl-slabel {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
}
.ddist-hl-sval { font-family: var(--mono); font-size: 15px; color: var(--ink); }
.ddist-notes {
    margin: 14px 0;
    padding: 10px 14px;
    border: 1px solid var(--line);
    background: var(--panel);
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.6;
    color: var(--muted);
}
.ddist-empty {
    margin-top: 18px;
    padding: 20px;
    border: 1px dashed var(--line);
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.ddist-h2 {
    margin: 40px 0 16px;
    font-family: var(--sans);
    font-size: 20px;
    color: var(--ink);
    display: flex;
    align-items: baseline;
    gap: 12px;
}
.ddist-count {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}

/* Pipeline flow */
.ddist-flow {
    display: flex;
    flex-direction: column;
    max-width: 760px;
}
.ddist-step-wrap { display: flex; flex-direction: column; }
.ddist-arrow {
    align-self: center;
    font-family: var(--mono);
    color: var(--muted);
    font-size: 16px;
    line-height: 1;
    padding: 6px 0;
}
.ddist-card {
    border: 1px solid var(--line);
    background: var(--panel);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.ddist-card.is-missing { opacity: 0.55; }
.ddist-card-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
}
.ddist-card-headline {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.ddist-card-label {
    font-family: var(--mono);
    font-size: 13px;
    letter-spacing: 0.04em;
    color: var(--ink);
}
.ddist-keeper-tag {
    display: inline-flex;
    align-items: center;
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--accent);
    padding: 2px 6px;
    white-space: nowrap;
}
.ddist-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    border: 1px solid var(--line);
    padding: 3px 8px;
}
.ddist-chip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted);
}
.ddist-chip.is-ok { color: var(--accent); border-color: var(--accent); }
.ddist-chip.is-ok .ddist-chip-dot { background: var(--accent); }
.ddist-card-main {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.ddist-metric {
    background: var(--panel);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.ddist-metric-total .ddist-card-mval { color: var(--accent); }
.ddist-card-mlabel {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
}
.ddist-card-mval {
    font-family: var(--mono);
    font-size: 18px;
    color: var(--ink);
    letter-spacing: -0.01em;
}
.ddist-card-role {
    margin: 0;
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.55;
    color: var(--muted);
}
.ddist-rows {
    margin: 2px 0 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.ddist-row {
    background: var(--panel);
    padding: 7px 10px;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: baseline;
}
.ddist-row dt {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0;
}
.ddist-row dd {
    margin: 0;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
    text-align: right;
}
.ddist-addr {
    display: block;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--muted);
    text-decoration: none;
    word-break: break-all;
    border-top: 1px solid var(--line);
    padding-top: 8px;
}
.ddist-addr:hover { color: var(--accent); text-decoration: underline; }

/* Headline team-fee recipient link */
.ddist-hl-recip {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    text-decoration: none;
    word-break: break-all;
    margin-top: 2px;
}
.ddist-hl-recip:hover { color: var(--accent); text-decoration: underline; }

/* Distribution recipients list */
.ddist-recip-note {
    margin: 0 0 14px;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.6;
    color: var(--muted);
    max-width: 760px;
}
.ddist-recips {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    max-width: 760px;
}
.ddist-recip {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
}
.ddist-recip:last-child { border-bottom: none; }
.ddist-recip-label {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--ink);
    white-space: nowrap;
}
.ddist-recip-addr {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    text-decoration: none;
    word-break: break-all;
    text-align: right;
}
.ddist-recip-addr:hover { color: var(--accent); text-decoration: underline; }

/* History */
.ddist-history {
    border: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 12px;
}
.ddist-hrow {
    display: grid;
    grid-template-columns: 70px 130px 150px minmax(0, 1fr);
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    align-items: baseline;
}
.ddist-hrow:last-child { border-bottom: none; }
.ddist-hhead {
    background: var(--panel);
    color: var(--muted);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    position: sticky;
    top: 0;
}
.ddist-time { color: var(--muted); white-space: nowrap; }
.ddist-txlink { color: var(--muted); text-decoration: none; }
.ddist-txlink:hover { color: var(--accent); text-decoration: underline; }
.ddist-contract { color: var(--muted); }
.ddist-event { color: var(--ink); }
.ddist-detail { color: var(--ink); word-break: break-word; }
@media (max-width: 720px) {
    .ddist-rows { grid-template-columns: 1fr; }
    .ddist-hrow { grid-template-columns: 54px 1fr; }
    .ddist-hhead { display: none; }
    .ddist-event { color: var(--accent); }
}
`;
