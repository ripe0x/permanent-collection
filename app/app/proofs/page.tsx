import type {Metadata} from 'next';
import Link from 'next/link';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {getDataAdapter} from '@/lib/data';
import type {ProofView, TitleNftView} from '@/lib/data/types';
import {shortAddress} from '@/lib/format';
import {buildMeta} from '@/lib/meta';

export const metadata: Metadata = buildMeta({
    title: 'Proofs',
    description:
        'The 111 Proofs and the Vault Title. One Proof per trait, issued to the address that gave up the Punk whose vaulting brought that trait into the Permanent Collection.',
    path: '/proofs',
});

export const dynamic = 'force-dynamic';

export default async function ProofsPage() {
    const adapter = getDataAdapter();
    const [proofs, title] = await Promise.all([
        adapter.getProofs(),
        adapter.getTitleNft().catch(() => null),
    ]);
    const mintedCount = proofs.filter((p) => p.minted).length;

    return (
        <>
            <Header />
            <main id="top" className="proofs-page">
                <section className="proofs-intro">
                    <div className="kicker">Proofs</div>
                    <h1>The 111 Proofs</h1>
                    <p>
                        For each trait the Permanent Collection has permanently
                        acquired, one <em>Proof</em> NFT is issued from{' '}
                        <code>PunkVault</code> to the address that gave up the
                        Punk whose vaulting brought that trait in. Return
                        auctions that return the Punk mint no Proof. Redundant
                        vaultings of already collected traits mint no Proof. The
                        cap is 111, exact and permanent.
                    </p>
                    <p>
                        Alongside them sits the one-of-one <em>Vault Title</em>{' '}
                        (token id 111), the deed for the whole collection. Open
                        any card for its image, mint record, and provenance.
                    </p>
                    <p className="proofs-count">
                        <strong>{mintedCount}</strong> of 111 issued.
                    </p>
                </section>

                {title?.minted && <TitleCard title={title} />}

                <section className="proofs-grid">
                    {proofs.map((p) => (
                        <ProofCell key={p.tokenId} proof={p} />
                    ))}
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

function TitleCard({title}: {title: TitleNftView}) {
    return (
        <section className="title-card-section">
            <Link href="/proofs/111" className="title-card">
                {title.svgMarkup ? (
                    <div
                        className="title-card-art"
                        // SVG is our own on-chain renderer (tokenURI(111)); safe to inline.
                        dangerouslySetInnerHTML={{__html: title.svgMarkup}}
                    />
                ) : (
                    <div className="title-card-art title-card-art-empty" />
                )}
                <div className="title-card-body">
                    <div className="kicker">Vault Title</div>
                    <h2>The deed for the collection</h2>
                    <p>
                        A single one-of-one NFT (token id 111) that inscribes the
                        live state of the Permanent Collection. Minted to the
                        winner of the Vault Title auction.
                    </p>
                    <div className="title-card-meta">
                        {title.owner && (
                            <span>
                                Held by{' '}
                                <span className="mono">{shortAddress(title.owner)}</span>
                            </span>
                        )}
                        <span className="title-card-cta">View Title →</span>
                    </div>
                </div>
            </Link>
        </section>
    );
}

function ProofCell({proof}: {proof: ProofView}) {
    const dim = !proof.minted;
    const cls = dim ? 'proof-cell proof-cell-empty' : 'proof-cell proof-cell-minted';
    return (
        <Link href={`/proofs/${proof.tokenId}`} className={cls}>
            {proof.svgMarkup ? (
                <div
                    className="proof-cell-art"
                    // SVG comes from our own on-chain renderer (proofRenderer.tokenURI(id));
                    // safe to inline.
                    dangerouslySetInnerHTML={{__html: proof.svgMarkup}}
                />
            ) : (
                <ProofCellTextOnly proof={proof} />
            )}
            <div className="proof-cell-foot">
                <div className="proof-cell-id">Proof #{proof.tokenId}</div>
                {proof.minted ? (
                    <div className="proof-cell-owner">
                        Owner <span className="mono">{shortAddr(proof.currentOwner)}</span>
                    </div>
                ) : (
                    <div className="proof-cell-empty-label">awaiting vaulting</div>
                )}
            </div>
        </Link>
    );
}

function ProofCellTextOnly({proof}: {proof: ProofView}) {
    return (
        <div className="proof-cell-art proof-cell-art-empty">
            <div className="proof-cell-name">{proof.traitName}</div>
            {proof.minted && (
                <div className="proof-cell-meta">
                    <div>Punk #{proof.punkId}</div>
                    <div>{proof.sequence} of 111</div>
                </div>
            )}
        </div>
    );
}

function shortAddr(addr: string | null): string {
    if (!addr) return '';
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const styles = `
.proofs-page {
    max-width: var(--max);
    margin: 0 auto;
    padding: clamp(28px, 5vw, 64px) var(--pad);
}
.proofs-intro {
    margin-bottom: clamp(28px, 5vw, 56px);
    max-width: 720px;
}
.proofs-intro h1 {
    font-family: var(--serif);
    font-size: clamp(36px, 5vw, 56px);
    line-height: 1.05;
    letter-spacing: -0.01em;
    color: var(--ink);
    margin: 8px 0 18px;
}
.proofs-intro p {
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.7;
    color: var(--muted);
    margin: 0 0 16px;
}
.proofs-intro p code {
    font-family: var(--mono);
    color: var(--ink);
    background: var(--panel);
    padding: 1px 6px;
    font-size: 13px;
}
.proofs-intro p em {
    font-style: italic;
    color: var(--ink);
}
.proofs-count {
    font-family: var(--mono) !important;
    font-size: 13px !important;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}
.proofs-count strong {
    font-weight: normal;
    color: var(--accent);
    font-size: 16px;
}

.title-card-section {
    margin-bottom: clamp(32px, 5vw, 56px);
}
.title-card {
    display: grid;
    grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
    gap: clamp(20px, 4vw, 40px);
    align-items: center;
    background: var(--panel);
    border: 1px solid var(--line);
    text-decoration: none;
    color: inherit;
    padding: clamp(18px, 3vw, 28px);
    transition: border-color 120ms ease;
}
.title-card:hover {
    border-color: var(--accent);
}
.title-card-art {
    aspect-ratio: 1 / 1;
    width: 100%;
    line-height: 0;
    background: #1c1c1c;
    overflow: hidden;
    border: 1px solid var(--line);
}
.title-card-art svg {
    width: 100%;
    height: 100%;
    display: block;
    image-rendering: pixelated;
}
.title-card-art-empty {
    background: #1c1c1c;
}
.title-card-body h2 {
    font-family: var(--serif);
    font-size: clamp(22px, 3vw, 32px);
    line-height: 1.1;
    color: var(--ink);
    margin: 6px 0 12px;
}
.title-card-body p {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.6;
    color: var(--muted);
    margin: 0 0 16px;
    max-width: 460px;
}
.title-card-meta {
    display: flex;
    align-items: baseline;
    gap: 18px;
    flex-wrap: wrap;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.title-card-meta .mono {
    color: var(--ink);
}
.title-card-cta {
    color: var(--accent);
    letter-spacing: 0.04em;
}

.proofs-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 18px;
}
.proof-cell {
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--line);
    text-decoration: none;
    color: inherit;
    transition: border-color 120ms ease, transform 120ms ease;
    overflow: hidden;
}
.proof-cell:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
}
.proof-cell-empty {
    opacity: 0.92;
}
.proof-cell-art {
    aspect-ratio: 1 / 1;
    width: 100%;
    line-height: 0;
    background: #8F918B;
    overflow: hidden;
}
.proof-cell-art svg {
    width: 100%;
    height: 100%;
    display: block;
    image-rendering: pixelated;
}
.proof-cell-art-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 18px;
    line-height: 1.35;
    color: #5a5a5a;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}
.proof-cell-foot {
    padding: 10px 14px 12px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    border-top: 1px solid var(--line);
}
.proof-cell-id {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
}
.proof-cell-name {
    font-family: var(--serif);
    font-size: 19px;
    font-weight: 600;
    color: var(--ink);
    margin-bottom: 8px;
}
.proof-cell-meta {
    font-family: var(--sans);
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
}
.proof-cell-owner {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
}
.proof-cell-owner .mono {
    color: var(--ink);
    margin-left: 4px;
}
.proof-cell-empty-label {
    font-family: var(--sans);
    font-size: 11px;
    font-style: italic;
    color: var(--muted);
}
@media (max-width: 640px) {
    .title-card {
        grid-template-columns: 1fr;
    }
}
`;
