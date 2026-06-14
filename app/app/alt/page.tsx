import type {Metadata} from 'next';

import {AltNowStrip} from '@/components/AltNowStrip';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {LoopStory} from '@/components/LoopStory';
import {getDataAdapter} from '@/lib/data';
import {ZERO_PROTOCOL_STATE} from '@/lib/data/live';
import {buildMeta, TAGLINE} from '@/lib/meta';

/* Alternative landing, variant 1: persistent-wheel scrolly. The flywheel
   stays on screen for the entire scroll story — each beat lights one
   station, the fork beat draws both outcome branches on the wheel, and
   the finale spins it. Design pass in progress; noindexed until promoted
   to the home page. Compare with /alt2 (wheel-hero hybrid). */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    ...buildMeta({
        title: 'Permanent Collection',
        bareTitle: true,
        description: TAGLINE,
        path: '/alt',
    }),
    robots: {index: false, follow: false},
};

export default async function AltLanding() {
    const adapter = getDataAdapter();
    const [state, auctions] = await Promise.all([
        adapter.getProtocolState().catch(() => ZERO_PROTOCOL_STATE),
        adapter.getActiveAuctions().catch(() => []),
    ]);

    return (
        <>
            <Header />
            <main id="top">
                <section className="alt-hero" aria-label="Permanent Collection introduction">
                    <h1>
                        111 Punk traits.
                        <br />
                        One permanent collection.
                        <br />
                        One public bid.
                    </h1>
                    <p className="alt-hero-text">
                        A coin that collects CryptoPunks, one trait at a time. Scroll to walk the
                        loop.
                    </p>
                    <div className="alt-hero-cue" aria-hidden="true">
                        scroll &darr;
                    </div>
                </section>

                <LoopStory
                    variant="wheel"
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
.alt-hero {
    border-top: none;
    min-height: calc(72svh - 58px);
    display: flex;
    flex-direction: column;
    justify-content: center;
    max-width: var(--max-wide);
    margin: 0 auto;
    padding: clamp(62px, 9vh, 110px) var(--pad) clamp(44px, 7vh, 72px);
}
.alt-hero h1 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(38px, 5.4vw, 76px);
    line-height: 1.0;
    letter-spacing: -0.04em;
    margin-bottom: 26px;
}
.alt-hero-text {
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.62;
    color: var(--muted);
    max-width: 560px;
}
.alt-hero-cue {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    margin-top: clamp(36px, 6vh, 64px);
}
`;
