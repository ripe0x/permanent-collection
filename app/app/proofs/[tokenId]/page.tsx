import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {getChainId, isProtocolLive} from '@/lib/config';
import {getDataAdapter} from '@/lib/data';
import type {ProofDetail, TitleNftView} from '@/lib/data/types';
import {formatEth, formatPunk, getEvmNowAddressUrl, shortAddress} from '@/lib/format';
import {buildMeta} from '@/lib/meta';
import {getPunksSdk} from '@/lib/punks-sdk';

export const dynamic = 'force-dynamic';

const TITLE_TOKEN_ID = 111;

function parseTokenId(raw: string): number | null {
    const id = Number.parseInt(raw, 10);
    if (!Number.isInteger(id) || id < 0 || id > TITLE_TOKEN_ID) return null;
    return id;
}

export async function generateMetadata({
    params,
}: {
    params: Promise<{tokenId: string}>;
}): Promise<Metadata> {
    const {tokenId: raw} = await params;
    const id = parseTokenId(raw);
    if (id === null) {
        return buildMeta({title: 'Token — not found', description: 'No such token.', path: '/proofs'});
    }
    if (id === TITLE_TOKEN_ID) {
        return buildMeta({
            title: 'Vault Title',
            description:
                'The one-of-one Vault Title (token id 111) — the deed for the Permanent Collection.',
            path: `/proofs/${id}`,
        });
    }
    const trait = getPunksSdk().dataset.trait(id);
    return buildMeta({
        title: `Proof #${id} — ${trait.name}`,
        description: `The Proof NFT for the ${trait.name} trait in the Permanent Collection.`,
        path: `/proofs/${id}`,
    });
}

export default async function ProofDetailPage({params}: {params: Promise<{tokenId: string}>}) {
    const {tokenId: raw} = await params;
    const id = parseTokenId(raw);
    if (id === null) notFound();

    if (id === TITLE_TOKEN_ID) {
        const title = await getDataAdapter()
            .getTitleNft()
            .catch(() => null);
        return <TitleDetail title={title} />;
    }

    const detail = await getDataAdapter()
        .getProofDetail(id)
        .catch(() => null);
    return <ProofDetailView tokenId={id} detail={detail} />;
}

// ─────────────────────────── Proof (0..110) ───────────────────────────

function ProofDetailView({tokenId, detail}: {tokenId: number; detail: ProofDetail | null}) {
    const trait = getPunksSdk().dataset.trait(tokenId);
    const chainId = getChainId();
    const live = isProtocolLive();
    const minted = !!detail?.minted;

    return (
        <>
            <Header />
            <main id="top">
                <section className="nft-detail">
                    <div className="wrap">
                        <div className="back-row">
                            <Link href="/proofs" className="back-link">
                                ← All Proofs
                            </Link>
                        </div>

                        <div className="nft-layout">
                            <div className="nft-art-col">
                                <div className="nft-art">
                                    {detail?.svgMarkup ? (
                                        <div
                                            className="nft-art-inner"
                                            // Our own on-chain renderer output; safe to inline.
                                            dangerouslySetInnerHTML={{__html: detail.svgMarkup}}
                                        />
                                    ) : (
                                        <div className="nft-art-inner nft-art-empty">
                                            <span>{trait.name}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="nft-text-col">
                                <div className="kicker">
                                    Proof #{tokenId} · {trait.kind}
                                </div>
                                <h1 className="section-title">{trait.name}</h1>

                                {minted ? (
                                    <p className="nft-lead">
                                        Issued. This Proof records the first vaulting of{' '}
                                        <strong>{trait.name}</strong> into the Permanent Collection.
                                    </p>
                                ) : (
                                    <p className="nft-lead nft-lead-muted">
                                        Not issued yet. A Proof for{' '}
                                        <strong>{trait.name}</strong> mints only when a Punk carrying
                                        it is vaulted for the first time.
                                    </p>
                                )}

                                <dl className="nft-facts">
                                    <Fact label="Token id" value={`#${tokenId}`} />
                                    <Fact label="Trait" value={trait.name} />
                                    <Fact label="Category" value={trait.kind} />
                                    <Fact
                                        label="Trait rarity"
                                        value={`${trait.supply.toLocaleString()} / 10,000 Punks`}
                                    />
                                    {minted && detail && (
                                        <>
                                            <Fact
                                                label="Collection order"
                                                value={`${detail.sequence} of 111`}
                                            />
                                            <Fact
                                                label="Minted at block"
                                                value={detail.mintedAtBlock.toString()}
                                                mono
                                            />
                                            <Fact
                                                label="Current owner"
                                                value={
                                                    detail.currentOwner ? (
                                                        live ? (
                                                            <a
                                                                href={getEvmNowAddressUrl(
                                                                    detail.currentOwner,
                                                                    chainId,
                                                                )}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                            >
                                                                {shortAddress(detail.currentOwner)}
                                                            </a>
                                                        ) : (
                                                            shortAddress(detail.currentOwner)
                                                        )
                                                    ) : (
                                                        '—'
                                                    )
                                                }
                                                mono
                                            />
                                        </>
                                    )}
                                </dl>

                                {minted && detail && (
                                    <Provenance detail={detail} chainId={chainId} live={live} />
                                )}

                                <div className="nft-links">
                                    <Link href={`/collection/${tokenId}`}>
                                        View trait & full gallery →
                                    </Link>
                                    {minted && detail && live && (
                                        <Link href={`/punk/${detail.punkId}`}>
                                            View {formatPunk(detail.punkId)} →
                                        </Link>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

function Provenance({
    detail,
    chainId,
    live,
}: {
    detail: ProofDetail;
    chainId: number;
    live: boolean;
}) {
    const p = detail.provenance;
    return (
        <div className="nft-prov">
            <div className="nft-prov-title">Provenance</div>
            {p ? (
                <p className="nft-prov-lead">
                    {formatPunk(detail.punkId)} was acquired
                    {p.via === 'acceptListing' ? ' from a public listing' : ''} for{' '}
                    <strong className="tnum">{formatEth(p.acquisitionPriceWei)}</strong>, then vaulted
                    when its 72-hour return auction closed with no bid — making{' '}
                    <strong>{detail.traitName}</strong> permanent.
                </p>
            ) : (
                <p className="nft-prov-lead nft-lead-muted">
                    {formatPunk(detail.punkId)} brought this trait in. The acquisition record
                    couldn&apos;t be read right now.
                </p>
            )}
            <dl className="nft-facts">
                <Fact
                    label="Vaulted Punk"
                    value={
                        live ? (
                            <Link href={`/punk/${detail.punkId}`}>{formatPunk(detail.punkId)}</Link>
                        ) : (
                            formatPunk(detail.punkId)
                        )
                    }
                />
                {p && (
                    <>
                        <Fact
                            label="Acquired via"
                            value={p.via === 'acceptBid' ? 'Live bid (acceptBid)' : 'Listing (acceptListing)'}
                        />
                        <Fact label="Acquisition price" value={formatEth(p.acquisitionPriceWei)} mono />
                        <Fact label="Acquired at block" value={p.acquiredAtBlock.toString()} mono />
                        <Fact
                            label="Given up by (Proof recipient)"
                            value={
                                live ? (
                                    <a
                                        href={getEvmNowAddressUrl(p.originalSeller, chainId)}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        {shortAddress(p.originalSeller)}
                                    </a>
                                ) : (
                                    shortAddress(p.originalSeller)
                                )
                            }
                            mono
                        />
                        {p.via === 'acceptListing' && (
                            <Fact
                                label="Accepted by (finder)"
                                value={
                                    live ? (
                                        <a
                                            href={getEvmNowAddressUrl(p.acquirer, chainId)}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            {shortAddress(p.acquirer)}
                                        </a>
                                    ) : (
                                        shortAddress(p.acquirer)
                                    )
                                }
                                mono
                            />
                        )}
                    </>
                )}
            </dl>
        </div>
    );
}

// ─────────────────────────── Title (111) ───────────────────────────

function TitleDetail({title}: {title: TitleNftView | null}) {
    const chainId = getChainId();
    const live = isProtocolLive();
    const minted = !!title?.minted;

    return (
        <>
            <Header />
            <main id="top">
                <section className="nft-detail">
                    <div className="wrap">
                        <div className="back-row">
                            <Link href="/proofs" className="back-link">
                                ← All Proofs
                            </Link>
                        </div>

                        <div className="nft-layout">
                            <div className="nft-art-col">
                                <div className="nft-art">
                                    {title?.svgMarkup ? (
                                        <div
                                            className="nft-art-inner"
                                            dangerouslySetInnerHTML={{__html: title.svgMarkup}}
                                        />
                                    ) : (
                                        <div className="nft-art-inner nft-art-empty">
                                            <span>Vault Title</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="nft-text-col">
                                <div className="kicker">Token #111 · Vault Title</div>
                                <h1 className="section-title">The Vault Title</h1>

                                {minted ? (
                                    <p className="nft-lead">
                                        Minted. The one-of-one deed for the Permanent Collection. Its
                                        image inscribes the live state of the collection and updates as
                                        traits become permanent.
                                    </p>
                                ) : (
                                    <p className="nft-lead nft-lead-muted">
                                        Not minted yet. The Vault Title is awarded to the winner of the
                                        Vault Title auction. Its image already inscribes the live state
                                        of the collection.
                                    </p>
                                )}

                                <dl className="nft-facts">
                                    <Fact label="Token id" value="#111" />
                                    <Fact label="Type" value="One-of-one deed" />
                                    <Fact label="Status" value={minted ? 'Minted' : 'Not minted'} />
                                    {minted && title?.owner && (
                                        <Fact
                                            label="Current owner"
                                            value={
                                                live ? (
                                                    <a
                                                        href={getEvmNowAddressUrl(title.owner, chainId)}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                    >
                                                        {shortAddress(title.owner)}
                                                    </a>
                                                ) : (
                                                    shortAddress(title.owner)
                                                )
                                            }
                                            mono
                                        />
                                    )}
                                </dl>

                                <div className="nft-links">
                                    <Link href="/title">
                                        {minted ? 'View Title auction history →' : 'View Title auction →'}
                                    </Link>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

// ─────────────────────────── Shared ───────────────────────────

function Fact({
    label,
    value,
    mono,
}: {
    label: string;
    value: ReactNode;
    mono?: boolean;
}) {
    return (
        <div className="nft-fact">
            <dt>{label}</dt>
            <dd className={mono ? 'mono' : undefined}>{value}</dd>
        </div>
    );
}

const styles = `
.nft-detail {
    padding-top: clamp(40px, 6vh, 80px);
    padding-bottom: clamp(80px, 12vh, 160px);
    border-top: none;
}
.back-row { margin-bottom: 28px; }
.back-link {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
}
.back-link:hover { color: var(--ink); }
.nft-layout {
    display: grid;
    grid-template-columns: minmax(0, 440px) minmax(0, 1fr);
    gap: clamp(40px, 6vw, 80px);
    align-items: start;
}
.nft-art {
    width: 100%;
    aspect-ratio: 1 / 1;
    background: #8F918B;
    border: 1px solid var(--line);
    overflow: hidden;
}
.nft-art-inner {
    width: 100%;
    height: 100%;
    line-height: 0;
}
.nft-art-inner svg {
    width: 100%;
    height: 100%;
    display: block;
    image-rendering: pixelated;
}
.nft-art-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 24px;
    color: #5a5a5a;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    line-height: 1.4;
}
.nft-text-col {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding-top: 6px;
}
.nft-lead {
    font-family: var(--serif);
    font-size: clamp(19px, 2.4vw, 26px);
    line-height: 1.2;
    letter-spacing: -0.02em;
    margin: 0;
}
.nft-lead strong { color: var(--accent); font-weight: 500; }
.nft-lead-muted { color: var(--muted); }
.nft-facts {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    margin: 6px 0 0;
    max-width: 560px;
}
.nft-fact {
    background: var(--panel);
    padding: 12px 16px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 18px;
}
.nft-fact dt {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
}
.nft-fact dd {
    margin: 0;
    font-family: var(--sans);
    font-size: 14px;
    color: var(--ink);
    text-align: right;
}
.nft-fact dd.mono { font-family: var(--mono); font-size: 12px; }
.nft-fact dd a {
    color: var(--ink);
    border-bottom: 1px dotted var(--line);
}
.nft-fact dd a:hover { border-bottom-color: var(--accent); }
.nft-prov {
    margin-top: 14px;
    border-top: 1px solid var(--line);
    padding-top: 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 560px;
}
.nft-prov-title {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.nft-prov-lead {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.65;
    color: var(--muted);
    margin: 0;
}
.nft-prov-lead strong { color: var(--ink); font-weight: 600; }
.nft-links {
    display: flex;
    flex-wrap: wrap;
    gap: 22px;
    margin-top: 16px;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.04em;
}
.nft-links a {
    color: var(--accent);
}
.nft-links a:hover { text-decoration: underline; text-underline-offset: 3px; }
@media (max-width: 880px) {
    .nft-layout { grid-template-columns: 1fr; }
    .nft-art-col { max-width: 440px; }
}
`;
