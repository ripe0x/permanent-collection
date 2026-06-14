import type {Metadata} from 'next';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {STATES, type E2EState, type E2ESurface, type StateStatus} from '@/lib/e2e/states';
import {buildMeta} from '@/lib/meta';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<StateStatus, string> = {
    covered: 'Covered',
    deferred: 'Deferred',
    blocked: 'Blocked',
    na: 'N/A',
};

export async function generateMetadata({params}: {params: Promise<{stateId: string}>}): Promise<Metadata> {
    const {stateId} = await params;
    const s = STATES.find((x) => x.id === stateId);
    if (!s) {
        return {
            ...buildMeta({title: 'State not found', description: '', path: '/e2e'}),
            robots: {index: false, follow: false},
        };
    }
    return {
        ...buildMeta({
            title: `${s.title} — E2E walkthrough`,
            description: s.summary,
            path: `/e2e/${s.id}`,
        }),
        robots: {index: false, follow: false},
    };
}

export default async function E2EStatePage({params}: {params: Promise<{stateId: string}>}) {
    const {stateId} = await params;
    const idx = STATES.findIndex((s) => s.id === stateId);
    if (idx === -1) notFound();
    const state = STATES[idx]!;
    const prev = idx > 0 ? STATES[idx - 1] : undefined;
    const next = idx < STATES.length - 1 ? STATES[idx + 1] : undefined;

    return (
        <>
            <Header />
            <main id="top">
                <section className="e2e-state-hero">
                    <div className="wrap">
                        <div className="e2e-breadcrumb">
                            <Link href="/e2e">← All states</Link>
                        </div>
                        <div className="e2e-state-head">
                            <h1 className="e2e-state-title">{state.title}</h1>
                            <span className={`e2e-pill e2e-pill-${state.status}`}>
                                {STATUS_LABEL[state.status]}
                            </span>
                        </div>
                        <p className="e2e-state-summary">{state.summary}</p>
                    </div>
                </section>

                <section className="e2e-state-section" aria-label="Writeup">
                    <div className="wrap e2e-state-body-grid">
                        <h2 className="e2e-state-h2">Writeup</h2>
                        <div className="e2e-state-body">
                            {state.body.split('\n').map((para, i) => (
                                <p key={i}>{para}</p>
                            ))}
                            {state.issues && state.issues.length > 0 && (
                                <p className="e2e-state-issues-row">
                                    Issues filed:{' '}
                                    {state.issues.map((n, i) => (
                                        <span key={n}>
                                            {i > 0 && ' · '}
                                            #{n}
                                        </span>
                                    ))}
                                </p>
                            )}
                        </div>
                    </div>
                </section>

                {state.surfaces.length > 0 ? (
                    <section className="e2e-state-section" aria-label="Surfaces">
                        <div className="wrap">
                            <h2 className="e2e-state-h2">Surfaces ({state.surfaces.length})</h2>
                            <div className="e2e-surfaces">
                                {state.surfaces.map((sf, i) => (
                                    <SurfaceCard key={i} surface={sf} />
                                ))}
                            </div>
                        </div>
                    </section>
                ) : (
                    <section className="e2e-state-section" aria-label="No screenshots">
                        <div className="wrap">
                            <h2 className="e2e-state-h2">Surfaces</h2>
                            <p className="e2e-empty">
                                No screenshots captured for this state. See the writeup for context.
                            </p>
                        </div>
                    </section>
                )}

                <nav className="e2e-state-section e2e-nav" aria-label="State navigation">
                    <div className="wrap e2e-nav-grid">
                        <div>
                            {prev && (
                                <Link href={`/e2e/${prev.id}`} className="e2e-nav-link">
                                    ← {prev.title.split('—')[0]?.trim()}
                                </Link>
                            )}
                        </div>
                        <div className="e2e-nav-right">
                            {next && (
                                <Link href={`/e2e/${next.id}`} className="e2e-nav-link">
                                    {next.title.split('—')[0]?.trim()} →
                                </Link>
                            )}
                        </div>
                    </div>
                </nav>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

function SurfaceCard({surface}: {surface: E2ESurface}) {
    const desktopFull = surface.desktop.fullPage
        ? `/api/e2e-screenshot/e2e-fullpage/${surface.desktop.fullPage}`
        : undefined;
    const desktopPhase1 = surface.desktop.phase1
        ? `/api/e2e-screenshot/e2e/${surface.desktop.phase1}`
        : undefined;
    const desktopPhase3 = surface.desktop.phase3
        ? `/api/e2e-screenshot/e2e-rerun/${surface.desktop.phase3}`
        : undefined;
    const mobileFull = surface.mobile.fullPage
        ? `/api/e2e-screenshot/e2e-fullpage/${surface.mobile.fullPage}`
        : undefined;
    const mobilePhase1 = surface.mobile.phase1
        ? `/api/e2e-screenshot/e2e/${surface.mobile.phase1}`
        : undefined;
    const mobilePhase3 = surface.mobile.phase3
        ? `/api/e2e-screenshot/e2e-rerun/${surface.mobile.phase3}`
        : undefined;
    return (
        <div className="e2e-surface">
            <div className="e2e-surface-head">
                <div className="e2e-surface-route">{surface.route}</div>
                {surface.note && <div className="e2e-surface-note">{surface.note}</div>}
            </div>
            <div className="e2e-shots">
                <ShotPair label="Desktop · full page" src={desktopFull} viewport="desktop" emphasize />
                <ShotPair label="Mobile · full page" src={mobileFull} viewport="mobile" emphasize />
                <ShotPair label="Desktop · viewport · P1" src={desktopPhase1} viewport="desktop" />
                <ShotPair label="Desktop · viewport · P3" src={desktopPhase3} viewport="desktop" />
                <ShotPair label="Mobile · viewport · P1" src={mobilePhase1} viewport="mobile" />
                <ShotPair label="Mobile · viewport · P3" src={mobilePhase3} viewport="mobile" />
            </div>
        </div>
    );
}

function ShotPair({
    label,
    src,
    viewport,
    emphasize,
}: {
    label: string;
    src: string | undefined;
    viewport: 'desktop' | 'mobile';
    /** Full-page captures get a wider column + a thicker border. */
    emphasize?: boolean;
}) {
    if (!src) {
        return (
            <div
                className={`e2e-shot e2e-shot-${viewport} e2e-shot-empty${emphasize ? ' e2e-shot-emphasize' : ''}`}
            >
                <div className="e2e-shot-label">{label}</div>
                <div className="e2e-shot-placeholder">— not captured</div>
            </div>
        );
    }
    return (
        <a
            className={`e2e-shot e2e-shot-${viewport}${emphasize ? ' e2e-shot-emphasize' : ''}`}
            href={src}
            target="_blank"
            rel="noreferrer"
        >
            <div className="e2e-shot-label">{label}</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={label} loading="lazy" />
        </a>
    );
}

const styles = `
.e2e-state-hero {
    padding: 56px var(--pad) 24px;
}
.e2e-breadcrumb {
    font-family: var(--mono);
    font-size: 12px;
    margin-bottom: 16px;
}
.e2e-breadcrumb a {
    color: var(--muted);
    text-decoration: none;
}
.e2e-breadcrumb a:hover { color: var(--ink); }
.e2e-state-head {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    margin-bottom: 12px;
}
.e2e-state-title {
    font-family: var(--serif);
    font-size: clamp(24px, 3.6vw, 36px);
    line-height: 1.12;
    margin: 0;
}
.e2e-state-summary {
    color: var(--muted);
    line-height: 1.55;
    max-width: 60ch;
    margin: 0;
}
.e2e-state-section {
    padding: 22px var(--pad);
}
.e2e-state-body-grid {
    max-width: 60ch;
}
.e2e-state-h2 {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0 0 14px;
}
.e2e-state-body p {
    margin: 0 0 12px;
    font-size: 14px;
    line-height: 1.6;
    color: var(--ink);
    white-space: pre-wrap;
}
.e2e-state-issues-row {
    color: var(--muted);
    font-size: 12px;
    margin-top: 8px;
}
.e2e-state-issues-row a {
    color: var(--ink);
    border-bottom: 1px dotted var(--muted);
    font-family: var(--mono);
}
.e2e-empty {
    color: var(--muted);
    font-size: 13px;
}
.e2e-pill {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 3px 8px;
}
.e2e-pill-covered { background: #1e1e1e; color: #fff; }
.e2e-pill-blocked { background: #b3261e; color: #fff; }
.e2e-pill-deferred { background: rgba(0,0,0,0.06); color: var(--muted); }
.e2e-pill-na { background: rgba(0,0,0,0.04); color: var(--muted); }
.e2e-surfaces {
    display: flex;
    flex-direction: column;
    gap: 28px;
}
.e2e-surface {
    border: 1px solid var(--line);
    padding: 16px;
}
.e2e-surface-head {
    margin-bottom: 14px;
}
.e2e-surface-route {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink);
}
.e2e-surface-note {
    font-size: 12px;
    color: var(--muted);
    margin-top: 4px;
    line-height: 1.45;
}
.e2e-shots {
    display: grid;
    grid-template-columns: 2fr 200px 1fr 1fr 140px 140px;
    gap: 14px;
    align-items: start;
}
@media (max-width: 1200px) {
    .e2e-shots {
        grid-template-columns: 2fr 200px 1fr 1fr;
    }
    .e2e-shot:nth-child(n+5):not(.e2e-shot-emphasize) {
        display: none;
    }
}
@media (max-width: 800px) {
    .e2e-shots {
        grid-template-columns: 1fr 180px;
    }
    .e2e-shot:nth-child(n+3):not(.e2e-shot-emphasize) {
        display: none;
    }
}
@media (max-width: 560px) {
    .e2e-shots {
        grid-template-columns: 1fr;
    }
    .e2e-shot:nth-child(n+2):not(.e2e-shot-emphasize) {
        display: none;
    }
}
.e2e-shot-emphasize img {
    border-width: 2px;
    border-color: var(--ink);
}
.e2e-shot-emphasize .e2e-shot-label {
    color: var(--ink);
    font-weight: 500;
}
.e2e-shot {
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-decoration: none;
    color: var(--ink);
}
.e2e-shot-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
}
.e2e-shot img {
    width: 100%;
    height: auto;
    border: 1px solid var(--line);
    background: #fff;
    transition: border-color 120ms ease;
}
.e2e-shot:hover img {
    border-color: var(--ink);
}
.e2e-shot-empty {
    opacity: 0.5;
}
.e2e-shot-placeholder {
    border: 1px dashed var(--line);
    padding: 24px 12px;
    text-align: center;
    color: var(--muted);
    font-size: 11px;
    font-family: var(--mono);
}
.e2e-shot-mobile img,
.e2e-shot-mobile .e2e-shot-placeholder {
    max-width: 200px;
}
.e2e-nav {
    padding: 16px var(--pad) 56px;
}
.e2e-nav-grid {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid var(--line);
    padding-top: 18px;
}
.e2e-nav-right { text-align: right; }
.e2e-nav-link {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    text-decoration: none;
}
.e2e-nav-link:hover { color: var(--ink); }
`;
