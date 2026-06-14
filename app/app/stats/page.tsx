/* Protocol stats — headline cumulative counters for the Permanent
 * Collection protocol. The page is a thin server shell (header, title,
 * copy, styles); all data flows through the cached `/api/stats` endpoint,
 * which the client `<StatsContent />` polls via react-query.
 *
 * The page SSR-seeds that hook by calling the same shared
 * `fetchProtocolStats()` the API route uses, so first paint is fully
 * populated and the poll only takes over thereafter (the `<LiveBidStat />`
 * pattern). One query shape, one resilient-fallback path, one indexer-
 * touching module — see `lib/data/protocolStats.ts`.
 */

import type {Metadata} from 'next';

import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {StatsContent} from '@/components/StatsContent';
import {fetchProtocolStats} from '@/lib/data/protocolStats';
import {buildMeta} from '@/lib/meta';

// The page is dynamic — its SSR seed reflects the indexer at request time;
// the client poll keeps it live thereafter. Upstream load stays flat: the
// seed and every client poll route through the cached /api/stats endpoint /
// the shared cached function.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = buildMeta({
    title: 'Stats',
    description:
        'Lifetime protocol totals for Permanent Collection: permanent traits, vaulted Punks, live bid inflow, $111 burned, and contribution volume.',
    path: '/stats',
});

export default async function StatsPage() {
    const initialData = await fetchProtocolStats();

    return (
        <>
            <Header />
            <main id="top">
                <section className="stats-page">
                    <div className="wrap">
                        <div className="kicker">Protocol</div>
                        <h1 className="section-title">Stats.</h1>
                        <p className="section-copy">
                            Lifetime totals for the protocol, indexed from on-chain events.
                            These are cumulative and only grow. The current live bid balance
                            (which falls when a Punk is accepted) lives on the trade page.
                        </p>

                        <StatsContent initialData={initialData} />
                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

const styles = `
.stats-page {
    padding-top: clamp(60px, 9vh, 100px);
    padding-bottom: clamp(80px, 12vh, 160px);
}
.stats-h2 {
    margin-top: 48px;
    margin-bottom: 16px;
    font-family: var(--mono);
    font-size: 13px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
}
.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
}
.stats-card {
    padding: 18px 20px;
    background: var(--panel);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.stats-card-label {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.06em;
    color: var(--muted);
}
.stats-card-value {
    font-family: var(--mono);
    font-size: 26px;
    line-height: 1.1;
    color: var(--ink);
}
.stats-card-value.is-pending {
    color: var(--muted);
}
.stats-card-sub {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
}
.stats-asof {
    margin-top: 32px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
}
.stats-empty {
    margin-top: 28px;
    padding: 24px;
    background: var(--panel);
    border: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 13px;
    color: var(--muted);
}
`;
