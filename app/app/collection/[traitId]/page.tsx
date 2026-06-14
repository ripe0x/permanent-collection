import type {Metadata} from 'next';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {TraitDetailHero} from '@/components/TraitDetailHero';
import {TraitGallery} from '@/components/TraitGallery';
import {renderPunkTileContent} from '@/lib/trait-tile';
import {canonicalPunkId} from '@/lib/canonical-punks';
import {isProtocolLive} from '@/lib/config';
import {getDataAdapter} from '@/lib/data';
import {formatEth, formatPunk} from '@/lib/format';
import {buildMeta} from '@/lib/meta';
import {getPunksSdk} from '@/lib/punks-sdk';

export const dynamic = 'force-dynamic';

const TOTAL_PUNKS = 10_000;
const GALLERY_PAGE = 60;

export async function generateMetadata({params}: {params: Promise<{traitId: string}>}): Promise<Metadata> {
    const {traitId: raw} = await params;
    const traitId = Number.parseInt(raw, 10);
    if (!Number.isInteger(traitId) || traitId < 0 || traitId > 110) {
        return buildMeta({title: 'Trait — not found', description: 'No such trait.', path: '/collection'});
    }
    const sdk = getPunksSdk();
    const trait = sdk.dataset.trait(traitId);
    return buildMeta({
        title: trait.name,
        description: `${trait.name} — one of the 111 trait slots in the Permanent Collection. ${trait.supply} of 10,000 Punks carry it.`,
        path: `/collection/${traitId}`,
    });
}

export default async function TraitDetailPage({params}: {params: Promise<{traitId: string}>}) {
    const {traitId: raw} = await params;
    const traitId = Number.parseInt(raw, 10);
    if (!Number.isInteger(traitId) || traitId < 0 || traitId > 110) notFound();

    const sdk = getPunksSdk();
    const trait = sdk.dataset.trait(traitId);

    // Pull protocol state + the matching auction in parallel with the SDK
    // reads, which are synchronous on the singleton.
    const adapter = getDataAdapter();
    // Pre-launch: skip the active-auctions read so this page renders
    // off the trait-grid fixtures alone. Auction sub-links route via the
    // /auction/[punkId] surface (disabled pre-launch), so we'd just produce
    // dead links otherwise.
    const [traits, auctions] = await Promise.all([
        adapter.getTraitGrid(),
        adapter.getActiveAuctions(),
    ]);
    const protocolView = traits.find((t) => t.traitId === traitId)!;
    const activeForTrait = auctions.find((a) => a.targetTraitId === traitId);

    // The Punk associated with this trait, when one exists. Vaulted Punk
    // for permanent, auction Punk for pending. Uncollected has no Punk —
    // the page foregrounds the isolated trait instead, so we don't need
    // a representative there.
    const representativePunkId =
        protocolView.state === 'permanent' && protocolView.firstVaultedPunkId !== undefined
            ? protocolView.firstVaultedPunkId
            : protocolView.state === 'pending' && activeForTrait
              ? activeForTrait.punkId
              : canonicalPunkId(traitId);

    // Pull the rep Punk's full trait list only when we'll actually show
    // it (permanent state). Skip the lookup otherwise.
    const representative =
        protocolView.state === 'permanent'
            ? sdk.get(representativePunkId, {includeTraits: true})
            : null;

    // All Punks carrying this trait, ordered by rarity (rarest first). The
    // search is over local in-memory data (no RPC / external API). We render
    // the first page server-side for instant paint + SEO, then the gallery
    // appends the rest via /api/punks-with-trait — so every matching Punk is
    // reachable without dumping thousands of tiles into one response.
    const allMatching = sdk.search({
        attributes: {required: [traitId]},
        sort: 'rarity',
    });
    const rarityPct = (trait.supply / TOTAL_PUNKS) * 100;
    const total = allMatching.length;
    const initialIds = allMatching.slice(0, GALLERY_PAGE);
    const initialSvgs: Record<number, string> = {};
    for (const pid of initialIds) initialSvgs[pid] = renderPunkTileContent(pid);

    return (
        <>
            <Header />
            <main id="top">
                <section className="trait-page">
                    <div className="wrap">
                        <div className="back-row">
                            <Link href="/collection" className="back-link">
                                ← All traits
                            </Link>
                        </div>

                        <div className="trait-layout">
                            <div className="trait-sprite-col">
                                <TraitDetailHero
                                    traitId={traitId}
                                    state={protocolView.state}
                                    punkId={
                                        protocolView.state === 'permanent'
                                            ? protocolView.firstVaultedPunkId
                                            : protocolView.state === 'pending'
                                              ? activeForTrait?.punkId
                                              : undefined
                                    }
                                    size={480}
                                    label={
                                        protocolView.state === 'uncollected'
                                            ? `${trait.name} — isolated trait visual`
                                            : `${formatPunk(representativePunkId)} — Punk for ${trait.name}; hover to isolate the trait`
                                    }
                                />
                                {protocolView.state !== 'uncollected' && (
                                    <div className="sprite-caption">
                                        <span className="sprite-caption-label">
                                            {protocolView.state === 'permanent' ? 'Vaulted' : 'In auction'}
                                        </span>
                                        {!isProtocolLive() ? (
                                            <span className="sprite-caption-link">
                                                {formatPunk(representativePunkId)}
                                            </span>
                                        ) : (
                                            <Link
                                                className="sprite-caption-link"
                                                href={
                                                    protocolView.state === 'pending'
                                                        ? `/auction/${representativePunkId}`
                                                        : `/punk/${representativePunkId}`
                                                }
                                            >
                                                {formatPunk(representativePunkId)}
                                            </Link>
                                        )}
                                    </div>
                                )}
                                {protocolView.state === 'permanent' && representative?.traits && (
                                    <div className="rep-traits">
                                        <div className="rep-traits-label">All traits on this Punk</div>
                                        <ul className="rep-traits-list">
                                            {representative.traits.map((t) => (
                                                <li key={t.id} className={t.id === traitId ? 'is-this' : ''}>
                                                    {t.id === traitId ? (
                                                        <span className="rep-trait-current">{t.name}</span>
                                                    ) : (
                                                        <Link href={`/collection/${t.id}`}>{t.name}</Link>
                                                    )}
                                                    <span className="rep-trait-kind">{t.kind}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>

                            <div className="trait-text-col">
                                <div className="kicker">
                                    Trait #{traitId} · {trait.kind}
                                </div>
                                <h1 className="section-title">{trait.name}</h1>

                                <div className="trait-facts">
                                    <div className="fact">
                                        <span className="fact-num tnum">{trait.supply.toLocaleString()}</span>
                                        <span className="fact-label">Punks carry it</span>
                                    </div>
                                    <div className="fact">
                                        <span className="fact-num tnum">{rarityPct.toFixed(2)}%</span>
                                        <span className="fact-label">of the collection</span>
                                    </div>
                                    <div className="fact">
                                        <span className="fact-num tnum">{trait.kind}</span>
                                        <span className="fact-label">category</span>
                                    </div>
                                </div>

                                <StateBlock
                    trait={protocolView}
                    activeAuctionPunkId={activeForTrait?.punkId}
                    preview={!isProtocolLive()}
                />
                            </div>
                        </div>

                        <section className="gallery-section">
                            <div className="gallery-head">
                                <div>
                                    <div className="kicker">Gallery</div>
                                    <h2 className="gallery-title">
                                        <span className="tnum">{total.toLocaleString()}</span>{' '}
                                        {total === 1 ? 'Punk' : 'Punks'} with {trait.name}
                                    </h2>
                                </div>
                                <p className="gallery-copy">
                                    Sorted rarest-first. Click any Punk to open its detail page.
                                </p>
                            </div>

                            <TraitGallery
                                traitId={traitId}
                                total={total}
                                initialIds={initialIds}
                                initialSvgs={initialSvgs}
                                pageSize={GALLERY_PAGE}
                            />
                        </section>
                    </div>
                </section>
            </main>
            <Footer />

            <style>{styles}</style>
        </>
    );
}

function StateBlock({
    trait,
    activeAuctionPunkId,
    preview,
}: {
    trait: {state: 'uncollected' | 'pending' | 'permanent'; firstVaultedPunkId?: number; acceptedBidWei?: bigint};
    activeAuctionPunkId?: number;
    /** Pre-launch (protocol not live). When true, suppress deep links to
     *  /punk/[id] and /auction/[id] (no live Punks/auctions to point at yet)
     *  and render the Punk reference as plain text instead. */
    preview?: boolean;
}) {
    if (trait.state === 'permanent') {
        return (
            <div className="trait-block">
                <p className="trait-lead">
                    Permanent.{' '}
                    {trait.firstVaultedPunkId !== undefined && (
                        <>
                            First vaulted via{' '}
                            {preview ? (
                                <strong>{formatPunk(trait.firstVaultedPunkId)}</strong>
                            ) : (
                                <Link href={`/punk/${trait.firstVaultedPunkId}`}>
                                    <strong>{formatPunk(trait.firstVaultedPunkId)}</strong>
                                </Link>
                            )}
                            {trait.acceptedBidWei !== undefined && (
                                <>
                                    {' '}
                                    for <strong className="tnum">{formatEth(trait.acceptedBidWei)}</strong>
                                </>
                            )}
                            .
                        </>
                    )}
                </p>
                <p className="trait-body">
                    This trait is part of the permanent collection forever. The representative Punk is in the
                    vault and cannot be withdrawn. Future acquisitions cannot target this trait — choose another.
                </p>
            </div>
        );
    }
    if (trait.state === 'pending') {
        return (
            <div className="trait-block">
                <p className="trait-lead">
                    In return auction.
                    {activeAuctionPunkId !== undefined && (
                        <>
                            {' '}
                            <Link href={`/auction/${activeAuctionPunkId}`}>
                                {formatPunk(activeAuctionPunkId)}&apos;s 72-hour auction
                            </Link>{' '}
                            decides this trait&apos;s fate.
                        </>
                    )}
                </p>
                <p className="trait-body">
                    If the market bids above the reserve, the Punk returns to circulation and this trait stays
                    uncollected. If no one bids, the Punk goes to the vault and this trait becomes permanent.
                </p>
            </div>
        );
    }
    return (
        <div className="trait-block">
            <p className="trait-lead">Uncollected.</p>
            <p className="trait-body">
                Any Punk carrying this trait is eligible to accept the live bid. Until someone accepts and
                the 72-hour return auction ends without a bid that returns the Punk, this trait remains uncollected.
            </p>
        </div>
    );
}

const styles = `
.trait-page {
    padding-top: clamp(40px, 6vh, 80px);
    padding-bottom: clamp(80px, 12vh, 160px);
    border-top: none;
}
.back-row {
    margin-bottom: 28px;
}
.back-link {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
}
.back-link:hover {
    color: var(--ink);
}
.trait-layout {
    display: grid;
    grid-template-columns: minmax(0, 480px) minmax(0, 1fr);
    gap: clamp(40px, 6vw, 80px);
    align-items: start;
}
.trait-sprite-col {
    display: flex;
    flex-direction: column;
    gap: 14px;
}
.sprite-caption {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    letter-spacing: 0.04em;
}
.sprite-caption-label {
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 11px;
}
.sprite-caption-link {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: var(--accent);
}
.rep-traits {
    margin-top: 14px;
    border-top: 1px solid var(--line);
    padding-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.rep-traits-label {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.14em;
}
.rep-traits-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--mono);
    font-size: 12px;
}
.rep-traits-list li {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 16px;
}
.rep-traits-list a {
    color: var(--ink);
    border-bottom: 1px dotted var(--line);
}
.rep-traits-list a:hover {
    border-bottom-color: var(--accent);
}
.rep-trait-current {
    color: var(--accent);
}
.rep-trait-kind {
    color: var(--muted);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}
.trait-text-col {
    display: flex;
    flex-direction: column;
    gap: 22px;
    padding-top: 6px;
}
.trait-facts {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    max-width: 620px;
    margin-top: 4px;
}
.fact {
    background: var(--panel);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.fact-num {
    font-family: var(--mono);
    font-size: 22px;
    color: var(--ink);
    letter-spacing: -0.02em;
}
.fact-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
}
.trait-block {
    margin-top: 8px;
    max-width: 620px;
    display: flex;
    flex-direction: column;
    gap: 22px;
}
.trait-lead {
    font-family: var(--serif);
    font-size: clamp(22px, 2.8vw, 30px);
    line-height: 1.15;
    letter-spacing: -0.025em;
}
.trait-lead a {
    text-decoration: underline;
    text-underline-offset: 4px;
    text-decoration-color: var(--accent);
    text-decoration-thickness: 2px;
}
.trait-lead strong {
    color: var(--accent);
    font-weight: 500;
}
.trait-body {
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.65;
    color: var(--muted);
}
.trait-body a {
    display: inline-block;
    margin-top: 4px;
}

.gallery-section {
    margin-top: clamp(60px, 9vh, 100px);
    border-top: 1px solid var(--line);
    padding-top: clamp(40px, 6vh, 60px);
}
.gallery-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 24px;
    margin-bottom: 28px;
}
.gallery-title {
    font-family: var(--serif);
    font-size: clamp(24px, 3vw, 36px);
    font-weight: 300;
    letter-spacing: -0.03em;
    line-height: 1.05;
}
.gallery-copy {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
    max-width: 420px;
}
.gallery-grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 12px;
}
.gallery-tile a {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 10px;
    transition: border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
}
.gallery-tile a:hover {
    border-color: var(--ink);
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.1);
}
.gallery-tile a:hover .gallery-id {
    color: var(--ink);
}
.gallery-punk {
    display: block;
    width: 96px;
    height: 96px;
    line-height: 0;
    background: var(--punk-blue);
}
.gallery-punk svg {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    shape-rendering: crispEdges;
}
.gallery-id {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--muted);
    letter-spacing: 0.04em;
    transition: color 120ms ease;
}
.gallery-more {
    margin-top: 28px;
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
}
.gallery-more-count {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
}
.gallery-more-error {
    font-family: var(--sans);
    font-size: 12px;
    color: var(--accent);
}
@media (max-width: 880px) {
    .trait-layout {
        grid-template-columns: 1fr;
    }
    .trait-sprite-col {
        max-width: 480px;
    }
    .trait-facts {
        grid-template-columns: 1fr 1fr;
    }
}
`;
