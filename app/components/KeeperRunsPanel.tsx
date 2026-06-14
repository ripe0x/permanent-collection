/* Renders the keeper's recent pass reports on /debug/fees. Each run the keeper
 * (scripts/keeper.ts on Fly) posts to /api/keeper-report shows up here: idle
 * passes collapse to a one-line heartbeat (proof the keeper is alive), and
 * passes that did something expand with their hop rows + evm.now tx links.
 * Server component — the page reads the runs from Blobs and passes them in. */

import {formatRelative, getEvmNowTxUrl} from '@/lib/format';
import type {KeeperReportStatus, KeeperRunReport} from '@/lib/keeper/report';

const ICON: Record<KeeperReportStatus, string> = {
    confirmed: '✓',
    reverted: '✗',
    failed: '✗',
    simulated: '◦',
    idle: '·',
    disabled: '⏸',
};

function summaryText(run: KeeperRunReport): string {
    if (run.sent > 0 || run.failed > 0) {
        return `${run.sent} sent${run.failed > 0 ? ` · ${run.failed} failed` : ''}`;
    }
    if (run.actionable > 0) return `${run.actionable} actionable`;
    return 'idle';
}

export function KeeperRunsPanel({runs}: {runs: KeeperRunReport[]}) {
    if (runs.length === 0) {
        return (
            <div className="krun-empty">
                No keeper runs reported yet. Each scheduled pass shows here once the keeper is
                wired to post them (KEEPER_REPORT_URL + KEEPER_REPORT_SECRET on the Fly app and
                the matching secret in the site env).
                <style>{styles}</style>
            </div>
        );
    }
    return (
        <div className="krun-list">
            {runs.map((run, i) => {
                const rows = run.rows.filter((r) => r.status !== 'idle' && r.status !== 'disabled');
                const active = rows.length > 0;
                return (
                    <div key={`${run.tsMs}-${i}`} className={`krun${active ? ' is-active' : ''}`}>
                        <div className="krun-head">
                            <span className="krun-time">{formatRelative(BigInt(Math.floor(run.tsMs / 1000)))}</span>
                            <span className="krun-block">block {run.block}</span>
                            <span className={`krun-summary${active ? ' is-active' : ''}`}>{summaryText(run)}</span>
                        </div>
                        {rows.length > 0 && (
                            <div className="krun-rows">
                                {rows.map((r, j) => (
                                    <div key={j} className="krun-row">
                                        <span className={`krun-icon st-${r.status}`} aria-hidden="true">
                                            {ICON[r.status]}
                                        </span>
                                        <span className="krun-hop">{r.hop}</span>
                                        <span className="krun-detail">{r.detail}</span>
                                        {r.txHash ? (
                                            <a
                                                className="krun-tx"
                                                href={getEvmNowTxUrl(r.txHash, run.chainId)}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                {r.txHash.slice(0, 10)}… ↗
                                            </a>
                                        ) : (
                                            <span className="krun-tx" />
                                        )}
                                        <span className="krun-gas">{r.gasUsed ? `${Number(r.gasUsed).toLocaleString()} gas` : ''}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
            <style>{styles}</style>
        </div>
    );
}

const styles = `
.krun-empty {
    margin-top: 12px;
    padding: 20px;
    border: 1px dashed var(--line);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    color: var(--muted);
    max-width: 820px;
}
.krun-list { display: flex; flex-direction: column; border: 1px solid var(--line); max-width: 820px; }
.krun { border-bottom: 1px solid var(--line); }
.krun:last-child { border-bottom: none; }
.krun.is-active { background: var(--panel); }
.krun-head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    padding: 9px 14px;
    font-family: var(--mono);
    font-size: 12px;
}
.krun-time { color: var(--ink); white-space: nowrap; }
.krun-block { color: var(--muted); }
.krun-summary { margin-left: auto; color: var(--muted); }
.krun-summary.is-active { color: var(--accent); }
.krun-rows { border-top: 1px solid var(--line); padding: 6px 14px 10px; display: flex; flex-direction: column; gap: 4px; }
.krun-row {
    display: grid;
    grid-template-columns: 14px minmax(120px, 1fr) minmax(0, 2fr) auto auto;
    align-items: baseline;
    gap: 10px;
    font-family: var(--mono);
    font-size: 11px;
}
.krun-icon { text-align: center; }
.krun-icon.st-confirmed { color: #2e7d32; }
.krun-icon.st-reverted, .krun-icon.st-failed { color: #c62828; }
.krun-icon.st-simulated { color: var(--muted); }
.krun-hop { color: var(--ink); word-break: break-all; }
.krun-detail { color: var(--muted); word-break: break-word; }
.krun-tx { color: var(--muted); text-decoration: none; white-space: nowrap; }
.krun-tx:hover { color: var(--accent); text-decoration: underline; }
.krun-gas { color: var(--muted); white-space: nowrap; }
@media (max-width: 640px) {
    .krun-row { grid-template-columns: 14px 1fr; }
    .krun-detail, .krun-tx, .krun-gas { grid-column: 2; }
}
`;
