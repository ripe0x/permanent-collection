/* Value-distribution debug dashboard. Server-rendered live status of every
 * step in the fee / auction distribution pipeline plus a merged event
 * history, for walking through local fork-test stages. Reads server-side
 * (full history from the deploy block, no proxy getLogs cap). Hidden from
 * search. The pipeline + history render is the shared `DistributionPanel`,
 * also embedded on /debug/fees. */

import type {Metadata} from 'next';

import {DistributionPanel} from '@/components/DistributionPanel';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {getDistributionSnapshot} from '@/lib/server/distribution';
import {buildMeta} from '@/lib/meta';

export const metadata: Metadata = {
    ...buildMeta({
        title: 'Debug — distribution',
        description: 'Live status of every value-distribution step plus event history.',
        path: '/debug/distribution',
    }),
    robots: {index: false, follow: false},
};

export const dynamic = 'force-dynamic';

export default async function DistributionDebugPage() {
    const snap = await getDistributionSnapshot();

    return (
        <>
            <Header />
            <main id="top">
                <section className="ddist">
                    <div className="wrap">
                        <div className="kicker">Debug</div>
                        <h1 className="section-title">Value distribution.</h1>
                        <p className="ddist-intro">
                            Every distribution location (hook, adapter, swapper, escrow,
                            controller, pools) with its <strong>current</strong> holding and
                            its <strong>total</strong> distributed over the contract&apos;s
                            lifetime, plus a merged history of every value-movement event.
                            Reads straight from the configured RPC (the local fork in fork
                            mode), so you can advance a stage in a test and refresh to watch
                            ETH move through. Stations tagged{' '}
                            <span className="ddist-keeper-tag">Keeper</span> only move value
                            downstream when someone calls them — use the execute buttons on
                            those cards to run the step with a connected wallet.
                        </p>

                        <DistributionPanel snapshot={snap} />
                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

const styles = `
.ddist {
    padding-top: clamp(48px, 8vh, 90px);
    padding-bottom: clamp(80px, 12vh, 160px);
}
.ddist-intro {
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.65;
    color: var(--muted);
    max-width: 70ch;
    margin: 12px 0 0;
}
`;
