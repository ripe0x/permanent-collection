/* "Collection preview" section. Links to /collection. The preview-image
   panel shows a tiny live read (collected count / 111). */
import Link from 'next/link';
import type {ProtocolState} from '@/lib/data/types';

export function CollectionPreview({state}: {state: ProtocolState}) {
    const pct = (state.collectedCount / 111) * 100;
    return (
        <section className="collection-preview" id="collection" aria-label="Collection preview">
            <div className="wrap preview-grid">
                <div className="preview-image" role="img" aria-label="Collection coverage preview">
                    <span className="preview-count tnum">
                        {state.collectedCount} / 111
                    </span>
                    <span className="preview-label">permanent traits</span>
                    <div className="preview-bar" aria-hidden="true">
                        <div className="preview-bar-fill" style={{width: `${pct}%`}} />
                    </div>
                </div>
                <div className="preview-copy">
                    <div className="kicker">Collection</div>
                    <h2 className="section-title">Explore the 111 trait slots.</h2>
                    <p>
                        Each slot represents one Punk trait. The collection page shows which traits are
                        uncollected, which are in return auction, and which are permanent.
                    </p>
                    <p className="preview-proofs">
                        <strong>{state.proofsMintedCount}</strong> of 111 Proofs issued.
                        Every vaulted Punk leaves a Proof.{' '}
                        <Link href="/proofs" className="preview-proofs-link">
                            See the wall.
                        </Link>
                    </p>
                    <Link className="secondary" href="/collection">
                        Open collection
                    </Link>
                </div>
            </div>
            <style>{styles}</style>
        </section>
    );
}

const styles = `
.preview-grid {
    display: grid;
    grid-template-columns: 0.85fr 1.15fr;
    gap: clamp(34px, 7vw, 90px);
    align-items: center;
}
.preview-image {
    aspect-ratio: 1;
    background: var(--panel);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: clamp(30px, 5vw, 60px);
}
.preview-count {
    font-family: var(--mono);
    font-size: clamp(48px, 7vw, 96px);
    line-height: 1;
    letter-spacing: -0.04em;
    color: var(--accent);
}
.preview-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
}
.preview-bar {
    width: 100%;
    height: 10px;
    border: 1px solid var(--line);
    background: var(--bg);
    position: relative;
    overflow: hidden;
}
.preview-bar-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--accent);
    transition: width 220ms ease;
}
.preview-copy p {
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.7;
    color: var(--muted);
    max-width: 560px;
    margin-bottom: 28px;
}
.preview-proofs {
    font-size: 14px !important;
    color: var(--muted);
    margin-top: 4px;
}
.preview-proofs strong {
    color: var(--accent);
    font-family: var(--mono);
    font-weight: normal;
}
.preview-proofs-link {
    color: var(--accent);
    text-decoration: underline;
}
@media (max-width: 850px) {
    .preview-grid {
        grid-template-columns: 1fr;
    }
    .preview-image {
        max-width: 520px;
    }
}
`;
