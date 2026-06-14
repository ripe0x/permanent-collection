import type {Metadata} from 'next';

import {BidCalculator} from '@/components/BidCalculator';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {getDataAdapter} from '@/lib/data';
import {buildMeta} from '@/lib/meta';
import {FEES, fmtPct} from '@/lib/protocol-params';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = buildMeta({
    title: 'Bid calculator',
    description:
        'Play with the fee split and target bid; see how much swap volume the protocol needs to get there.',
    path: '/calculator',
});

export default async function CalculatorPage() {
    const adapter = getDataAdapter();
    // Seed the "current bid" knob from chain so first paint is honest. If
    // the adapter throws (indexer/RPC blip), fall back to 0 — the calculator
    // still works; the user just slides current themselves.
    let initialCurrentWei = '0';
    try {
        const state = await adapter.getProtocolState();
        initialCurrentWei = state.liveBidWei.toString();
    } catch {
        initialCurrentWei = '0';
    }

    return (
        <>
            <Header />
            <main id="top">
                <section className="calc-page">
                    <div className="wrap">
                        <div className="kicker">Demo</div>
                        <h1 className="section-title">How much trading does the bid need?</h1>
                        <p className="section-copy">
                            The protocol only acquires a Punk when its standing bid clears
                            an eligible owner&apos;s reserve. Trading IS how that bid grows:{' '}
                            {fmtPct(FEES.baselineSkimPct)} of every swap is skimmed, with{' '}
                            {fmtPct(FEES.bidLegPct)} of volume routed to Patron. Drag the
                            knobs to see how the math shifts: a different fee, a different
                            split, a different target.
                        </p>
                        <BidCalculator initialCurrentWei={initialCurrentWei} />
                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

const styles = `
.calc-page {
    padding-top: clamp(60px, 9vh, 100px);
    padding-bottom: clamp(80px, 12vh, 160px);
    border-top: none;
}
.calc-page .wrap {
    display: flex;
    flex-direction: column;
    gap: 24px;
}
.calc-page .section-copy {
    max-width: 64ch;
}
`;
