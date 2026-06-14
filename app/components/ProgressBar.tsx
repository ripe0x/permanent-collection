/* The live-bid → cheapest-eligible-Punk progress meter from v3. When the
   market reference is unavailable, we drop the meter and label why — never
   block the page. */
import {formatEth, ratioPct} from '@/lib/format';

export function ProgressBar({
    liveBidWei,
    cheapestEligibleWei,
    marketAvailable,
}: {
    liveBidWei: bigint;
    cheapestEligibleWei?: bigint;
    marketAvailable: boolean;
}) {
    if (!marketAvailable || cheapestEligibleWei === undefined) {
        return null;
    }

    const pct = ratioPct(liveBidWei, cheapestEligibleWei);

    return (
        <div className="progress">
            <div className="progress-meta">
                <span>{formatEth(liveBidWei)} live bid</span>
                <span>{formatEth(cheapestEligibleWei)} cheapest listed eligible Punk</span>
            </div>
            <div
                className="bar"
                role="progressbar"
                aria-label="Live bid compared to cheapest listed eligible Punk"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
            >
                <div className="bar-fill" style={{width: `${pct}%`}} />
            </div>
            <p className="progress-caption">
                Any eligible Punk owner can accept the bid, listed or unlisted.
            </p>
            <style>{styles}</style>
        </div>
    );
}

const styles = `
.progress {
    margin-top: 24px;
}
.progress-meta {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 9px;
}
.bar {
    height: 11px;
    border: 1px solid var(--line);
    background: var(--panel);
    position: relative;
    overflow: hidden;
}
.bar-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--accent);
    transition: width 220ms ease;
}
.progress-caption {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.5;
    color: var(--muted);
    margin-top: 11px;
}
`;
