import type {Metadata} from 'next';
import Link from 'next/link';

import {AltNowStrip} from '@/components/AltNowStrip';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {LoopStory} from '@/components/LoopStory';
import {LoopWheel} from '@/components/LoopWheel';
import {getDataAdapter} from '@/lib/data';
import {ZERO_PROTOCOL_STATE} from '@/lib/data/live';
import {getTokenTicker} from '@/lib/config';
import {buildMeta, TAGLINE} from '@/lib/meta';

/* Alternative landing, variant 2: wheel-hero hybrid. The flywheel is the
   hero — large, spinning, live bid in the hub — and a shortened 3-beat
   scroll story (accept, auction, fork) follows for the parts that
   benefit from sequencing. Design pass in progress; noindexed until one
   variant is promoted to the home page. Compare with /alt
   (persistent-wheel scrolly). */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    ...buildMeta({
        title: 'Permanent Collection',
        bareTitle: true,
        description: TAGLINE,
        path: '/alt2',
    }),
    robots: {index: false, follow: false},
};

export default async function AltLandingHybrid() {
    const tokenTicker = getTokenTicker();
    const adapter = getDataAdapter();
    const [state, auctions] = await Promise.all([
        adapter.getProtocolState().catch(() => ZERO_PROTOCOL_STATE),
        adapter.getActiveAuctions().catch(() => []),
    ]);

    return (
        <>
            <Header />
            <main id="top">
                <section className="alt2-hero" aria-label="Permanent Collection introduction">
                    <div className="alt2-hero-copy">
                        <h1>
                            111 Punk traits.
                            <br />
                            One permanent collection.
                            <br />
                            One public bid.
                        </h1>
                        <p className="alt2-hero-text">
                            A coin that collects CryptoPunks, one trait at a time. Fees on every
                            trade feed a standing bid, and every auction outcome pours back into the
                            loop.
                        </p>
                        <div className="alt2-actions">
                            <Link className="primary" href="/trade">
                                Trade {tokenTicker}
                            </Link>
                            <Link className="secondary" href="/collection">
                                View collection
                            </Link>
                        </div>
                        <div className="alt2-hero-cue" aria-hidden="true">
                            scroll to walk the loop &darr;
                        </div>
                    </div>
                    <div className="alt2-hero-wheel">
                        <LoopWheel
                            highlight="all"
                            spin
                            initialLiveBidWei={state.liveBidWei.toString()}
                        />
                    </div>
                </section>

                <LoopStory
                    variant="short"
                    initialLiveBidWei={state.liveBidWei.toString()}
                    collectedCount={state.collectedCount}
                />

                <AltNowStrip
                    collectedCount={state.collectedCount}
                    totalTraits={state.totalTraits}
                    auctionsLive={auctions.length}
                    vaultedCount={state.vaultedCount}
                />
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

const styles = `
.alt2-hero {
    border-top: none;
    display: grid;
    grid-template-columns: minmax(0, 1fr) clamp(320px, 38vw, 540px);
    gap: clamp(44px, 7vw, 96px);
    align-items: center;
    max-width: var(--max-wide);
    margin: 0 auto;
    padding: clamp(48px, 7vh, 88px) var(--pad) clamp(44px, 7vh, 72px);
    min-height: calc(92svh - 58px);
}
.alt2-hero-copy h1 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(34px, 4.4vw, 62px);
    line-height: 1.0;
    letter-spacing: -0.04em;
    margin-bottom: 24px;
}
.alt2-hero-text {
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.62;
    color: var(--muted);
    max-width: 520px;
}
.alt2-actions {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 28px;
}
.alt2-hero-cue {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    margin-top: clamp(32px, 5vh, 56px);
}
.alt2-hero-wheel {
    display: flex;
    align-items: center;
    justify-content: center;
}
@media (max-width: 900px) {
    .alt2-hero {
        grid-template-columns: 1fr;
        gap: 36px;
        min-height: 0;
    }
    .alt2-hero-wheel {
        order: -1;
        padding-top: 8px;
    }
    .alt2-hero-wheel .lw {
        width: 250px;
    }
}
`;
