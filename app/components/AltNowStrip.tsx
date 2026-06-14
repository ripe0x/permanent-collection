/* "Right now" closing strip for the alt landing variants: lands the
   reader back on the live state of the work after the loop story. Pure
   server component; values come from the page's protocol-state read. */

import Link from 'next/link';

export function AltNowStrip({
    collectedCount,
    totalTraits,
    auctionsLive,
    vaultedCount,
}: {
    collectedCount: number;
    totalTraits: number;
    auctionsLive: number;
    vaultedCount: number;
}) {
    return (
        <section className="alt-now" aria-label="Current state">
            <div className="wrap">
                <div className="kicker">Right now</div>
                <div className="alt-now-stats">
                    <div className="alt-now-stat">
                        <span className="alt-now-label">traits permanent</span>
                        <span className="alt-now-value tnum">
                            {collectedCount} of {totalTraits}
                        </span>
                    </div>
                    <div className="alt-now-stat">
                        <span className="alt-now-label">return auctions live</span>
                        <span className="alt-now-value tnum">{auctionsLive}</span>
                    </div>
                    <div className="alt-now-stat">
                        <span className="alt-now-label">Punks vaulted</span>
                        <span className="alt-now-value tnum">{vaultedCount}</span>
                    </div>
                </div>
                <div className="alt-now-links">
                    <Link className="secondary" href="/auction">
                        Watch the auctions
                    </Link>
                    <Link className="secondary" href="/bid">
                        Accept the bid
                    </Link>
                </div>
            </div>
            <style>{styles}</style>
        </section>
    );
}

const styles = `
.alt-now .alt-now-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    margin-top: 10px;
}
.alt-now-stat {
    background: var(--bg);
    padding: 26px 28px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.alt-now-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.alt-now-value {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(28px, 3.2vw, 42px);
    letter-spacing: -0.02em;
    line-height: 1;
}
.alt-now-links {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 28px;
}
@media (max-width: 700px) {
    .alt-now .alt-now-stats {
        grid-template-columns: 1fr;
    }
}
`;
