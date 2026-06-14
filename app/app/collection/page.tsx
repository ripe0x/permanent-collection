import type {Metadata} from 'next';
import Link from 'next/link';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {TraitGrid} from '@/components/TraitGrid';
import {TraitList} from '@/components/TraitList';
import {canonicalPunkId} from '@/lib/canonical-punks';
import {getDataAdapter} from '@/lib/data';
import type {Hex, TraitView} from '@/lib/data/types';
import {buildMeta} from '@/lib/meta';

export const metadata: Metadata = buildMeta({
    title: 'Collection',
    description: 'The 111 trait slots that make up the artwork. Permanent, in return auction, or open.',
    path: '/collection',
});

export const dynamic = 'force-dynamic';

export default async function CollectionPage({
    searchParams,
}: {
    searchParams: Promise<{demo?: string}>;
}) {
    const {demo} = await searchParams;
    const demoCount = parseDemo(demo);

    const adapter = getDataAdapter();
    // The grid renders every trait from PunksData; auctions are empty until
    // the protocol is live (the adapter returns [] pre-deploy).
    const [liveTraits, auctions] = await Promise.all([
        adapter.getTraitGrid(),
        adapter.getActiveAuctions(),
    ]);
    const auctionByTrait = new Map(auctions.map((a) => [a.targetTraitId, a]));
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

    // ?demo=N synthesizes N permanent traits using a deterministic shuffle
    // so the page can be previewed at any collected count. Production
    // behavior is unchanged when the query is absent.
    const traits = demoCount === null ? liveTraits : synthesizeDemo(demoCount);

    const permanent = traits.filter((t) => t.state === 'permanent').length;
    const pending = traits.filter((t) => t.state === 'pending').length;
    const uncollected = traits.filter((t) => t.state === 'uncollected').length;

    return (
        <>
            <Header />
            <main id="top">
                <section className="collection-head">
                    <div className="wrap">
                        <div className="kicker">
                            Collection{demoCount !== null ? ` · demo (${demoCount} permanent)` : ''}
                        </div>
                        <h1 className="section-title">The 111 trait slots.</h1>
                        <p className="section-copy">
                            One slot per Punk trait. Each starts uncollected. When a Punk owner accepts the
                            live bid and the 72-hour return auction expires without a return, the chosen trait
                            becomes permanent and that Punk represents it forever.
                        </p>
                        <div className="counts">
                            <div className="count">
                                <span className="count-num tnum">{permanent}</span>
                                <span className="count-label">permanent</span>
                            </div>
                            <div className="count">
                                <span className="count-num tnum">{pending}</span>
                                <span className="count-label">in return auction</span>
                            </div>
                            <div className="count">
                                <span className="count-num tnum">{uncollected}</span>
                                <span className="count-label">uncollected</span>
                            </div>
                            <div className="count">
                                <span className="count-num tnum">{permanent} / 111</span>
                                <span className="count-label">progress</span>
                            </div>
                        </div>
                        {demoCount !== null && <DemoLinks current={demoCount} />}
                    </div>
                </section>

                <section className="collection-grid">
                    <div className="wrap">
                        <TraitGrid traits={traits} />
                        <TraitList
                            traits={traits}
                            auctionByTrait={auctionByTrait}
                            nowSeconds={nowSeconds}
                        />
                    </div>
                </section>
            </main>
            <Footer />

            <style>{styles}</style>
        </>
    );
}

function DemoLinks({current}: {current: number}) {
    const presets = [0, 12, 37, 56, 74, 111];
    return (
        <nav className="demo-links" aria-label="Demo presets">
            <span className="demo-links-label">Preview at:</span>
            {presets.map((n) => (
                <a
                    key={n}
                    href={`/collection?demo=${n}`}
                    className={n === current ? 'is-active' : ''}
                    aria-current={n === current ? 'page' : undefined}
                >
                    {n}
                </a>
            ))}
            <Link href="/collection" className="demo-links-clear">
                Clear
            </Link>
        </nav>
    );
}

function parseDemo(raw: string | undefined): number | null {
    if (raw === undefined) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(111, n));
}

// Pre-shuffled trait ids so any prefix of length N is a diverse mix of
// kinds (NormalizedType / HeadVariant / AttributeCount / Accessory). Seeded
// permutation: a single mulberry32 pass over [0..110]. Recompute once at
// module load.
const SHUFFLED_TRAIT_ORDER: number[] = (() => {
    const ids = Array.from({length: 111}, (_, i) => i);
    let s = 0xc0ffee;
    function rand() {
        s |= 0;
        s = (s + 0x6d2b79f5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids;
})();

function synthesizeDemo(n: number): TraitView[] {
    const permanentSet = new Set(SHUFFLED_TRAIT_ORDER.slice(0, n));
    const out: TraitView[] = [];
    for (let id = 0; id < 111; id++) {
        if (permanentSet.has(id)) {
            const punk = canonicalPunkId(id);
            // Plausible bid: 10 ETH base + small per-trait jitter so the
            // list shows varied numbers in the rightmost column.
            const bidMicro = 10_000_000n + BigInt((id * 137) % 5_000_000);
            out.push({
                traitId: id,
                state: 'permanent',
                firstVaultedPunkId: punk,
                acceptedBidWei: bidMicro * 10n ** 12n,
                acquisitionTx: ('0x' + 'e'.repeat(64)) as Hex,
            });
        } else {
            out.push({traitId: id, state: 'uncollected'});
        }
    }
    return out;
}

const styles = `
.collection-head {
    padding-top: clamp(60px, 9vh, 100px);
    border-top: none;
}
.counts {
    margin-top: 38px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    max-width: 1020px;
}
.count {
    background: var(--panel);
    padding: 22px 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.count-num {
    font-family: var(--mono);
    font-size: 28px;
    color: var(--ink);
    letter-spacing: -0.02em;
}
.count-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
}
.demo-links {
    margin-top: 28px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 10px 12px;
    border: 1px dashed var(--line);
    background: var(--panel);
}
.demo-links-label {
    margin-right: 8px;
}
.demo-links a {
    padding: 4px 10px;
    border: 1px solid var(--line);
    color: var(--ink);
    background: var(--bg);
}
.demo-links a.is-active {
    background: var(--ink);
    color: var(--bg);
    border-color: var(--ink);
}
.demo-links a:hover {
    border-color: var(--accent);
}
.demo-links-clear {
    margin-left: 8px;
    color: var(--muted) !important;
    background: transparent !important;
    border-color: transparent !important;
}
.collection-grid {
    padding-top: clamp(40px, 6vh, 60px);
}
@media (max-width: 720px) {
    .counts {
        grid-template-columns: 1fr 1fr;
    }
}
`;
