import type {Metadata} from 'next';
import Link from 'next/link';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {STATES, type StateStatus} from '@/lib/e2e/states';
import {buildMeta} from '@/lib/meta';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    ...buildMeta({
        title: 'E2E walkthrough',
        description:
            'Browseable index of the 22-state end-to-end UI walkthrough — per-state writeup + desktop and mobile screenshots.',
        path: '/e2e',
    }),
    robots: {index: false, follow: false},
};

const STATUS_LABEL: Record<StateStatus, string> = {
    covered: 'Covered',
    deferred: 'Deferred',
    blocked: 'Blocked',
    na: 'N/A',
};

export default function E2EIndexPage() {
    const counts: Record<StateStatus, number> = {covered: 0, deferred: 0, blocked: 0, na: 0};
    for (const s of STATES) counts[s.status]++;

    return (
        <>
            <Header />
            <main id="top">
                <section className="e2e-hero" aria-label="E2E walkthrough">
                    <div className="wrap">
                        <div className="kicker">E2E walkthrough</div>
                        <h1 className="e2e-h1">
                            22 states, end-to-end.
                        </h1>
                        <p className="e2e-lede">
                            Every protocol state worth driving from the UI. Per state: an
                            onchain expectation, the routes that change, a writeup of what
                            was observed, and desktop + mobile screenshots.
                        </p>
                        <p className="e2e-meta">
                            Tally:{' '}
                            <strong className="tnum">{counts.covered}</strong> covered ·{' '}
                            <strong className="tnum">{counts.blocked}</strong> blocked ·{' '}
                            <strong className="tnum">{counts.deferred}</strong> deferred
                        </p>
                    </div>
                </section>

                <section className="e2e-section" aria-label="States">
                    <div className="wrap">
                        <div className="e2e-grid">
                            {STATES.map((s) => (
                                <Link key={s.id} href={`/e2e/${s.id}`} className="e2e-card">
                                    <div className="e2e-card-head">
                                        <span className="e2e-card-id">{s.title.split('—')[0]?.trim() || s.id.toUpperCase()}</span>
                                        <span className={`e2e-pill e2e-pill-${s.status}`}>
                                            {STATUS_LABEL[s.status]}
                                        </span>
                                    </div>
                                    <div className="e2e-card-title">
                                        {s.title.split('—').slice(1).join('—').trim() || s.title}
                                    </div>
                                    <p className="e2e-card-summary">{s.summary}</p>
                                    {s.issues && s.issues.length > 0 && (
                                        <div className="e2e-card-issues">
                                            Issues filed:{' '}
                                            {s.issues.map((n, i) => (
                                                <span key={n}>
                                                    {i > 0 && ', '}
                                                    <span className="e2e-issue-num">#{n}</span>
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    {s.surfaces.length > 0 && (
                                        <div className="e2e-card-footer">
                                            {s.surfaces.length} surface{s.surfaces.length === 1 ? '' : 's'} captured
                                        </div>
                                    )}
                                </Link>
                            ))}
                        </div>
                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

const styles = `
.e2e-hero {
    padding: 72px var(--pad) 28px;
}
.e2e-h1 {
    font-family: var(--serif);
    font-size: clamp(28px, 4.4vw, 44px);
    line-height: 1.12;
    margin: 14px 0 18px;
}
.e2e-lede {
    max-width: 56ch;
    color: var(--muted);
    line-height: 1.55;
}
.e2e-meta {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    margin: 6px 0;
}
.e2e-meta a {
    color: var(--ink);
    border-bottom: 1px dotted var(--muted);
}
.e2e-section {
    padding: 8px var(--pad) 56px;
}
.e2e-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
}
.e2e-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: 1px solid var(--line);
    padding: 16px;
    text-decoration: none;
    color: var(--ink);
    transition: border-color 120ms ease, background 120ms ease;
}
.e2e-card:hover {
    border-color: var(--ink);
    background: rgba(0, 0, 0, 0.02);
}
.e2e-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.e2e-card-id {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.08em;
}
.e2e-pill {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 6px;
}
.e2e-pill-covered { background: #1e1e1e; color: #fff; }
.e2e-pill-blocked { background: #b3261e; color: #fff; }
.e2e-pill-deferred { background: rgba(0,0,0,0.06); color: var(--muted); }
.e2e-pill-na { background: rgba(0,0,0,0.04); color: var(--muted); }
.e2e-card-title {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink);
    line-height: 1.35;
}
.e2e-card-summary {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
}
.e2e-card-issues {
    color: var(--muted);
    font-size: 11px;
    margin-top: 4px;
}
.e2e-issue-num {
    color: var(--ink);
    font-family: var(--mono);
}
.e2e-card-footer {
    color: var(--muted);
    font-size: 11px;
    margin-top: auto;
    padding-top: 4px;
    font-family: var(--mono);
    letter-spacing: 0.04em;
}
`;
