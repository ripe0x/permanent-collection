import type {ReactNode} from 'react';
import {AuctionSection} from '@/components/AuctionSection';
import {CollectionPreview} from '@/components/CollectionPreview';
import {PunkStrategyListings} from '@/components/PunkStrategyListings';
import {PunkSvg} from '@/components/PunkSvg';
import {buildListedTraitOptions} from '@/lib/trait-options';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {Hero, LiveBidSection} from '@/components/Hero';
import {LoopStory} from '@/components/LoopStory';
import {TitleAuctionBanner} from '@/components/TitleAuctionBanner';
import {TokenSection} from '@/components/TokenSection';
import {VaultSection} from '@/components/VaultSection';
import {IndexerDegradedNotice} from '@/components/IndexerDegradedNotice';
import {getDataAdapter} from '@/lib/data';
import {isIndexerDegraded, rethrowIfIndexerMisconfigured} from '@/lib/data/indexer-client';
import {ZERO_PROTOCOL_STATE, notDeployedTitleAuctionState} from '@/lib/data/live';
import type {
    AcceptedBidEvent,
    ActiveAuction,
    PunkStrategyListing,
    MarketReference,
    ProtocolState,
    ResolvedAuction,
    TitleAuctionState,
} from '@/lib/data/types';

/** Pre-render a PunkSvg per listed Punk on the server so the 2.4MB pixel
 *  SDK never reaches the client bundle. The result is a plain map of
 *  ReactNodes the client island can drop into each row. */
function buildPunkThumbs(punkIds: number[]): Record<number, ReactNode> {
    const out: Record<number, ReactNode> = {};
    for (const id of new Set(punkIds)) {
        out[id] = <PunkSvg punkId={id} label={`Punk #${id}`} fill background="transparent" />;
    }
    return out;
}

/** Resolve a data slice, or fall back to a safe default if it throws. The
 *  home page is the live dashboard and must never 500 because one slice's
 *  read failed (a throttled public RPC, a momentarily-down indexer, a
 *  renderer revert). A failed slice degrades to honest zeros/empties — the
 *  same shape the adapter returns pre-deploy — and the page still renders.
 *  Never invents data: a failure shows nothing, not a fabricated value.
 *  One exception: a misconfigured deploy (live protocol in production with
 *  no INDEXER_URL) rethrows — that is a bug to fail loud on, not an outage
 *  to smooth over. */
function slice<T>(p: Promise<T>, fallback: T): Promise<T> {
    return p.catch((e) => {
        rethrowIfIndexerMisconfigured(e);
        return fallback;
    });
}

/** Force dynamic rendering — chain state is the whole point. Caching the
 *  page would be wrong even for a few seconds. The brief: live numbers
 *  hydrate in and show their own loading state. */
export const dynamic = 'force-dynamic';

async function fetchHomeData(): Promise<{
    state: ProtocolState;
    auctions: ActiveAuction[];
    resolved: ResolvedAuction[];
    accepted: AcceptedBidEvent[];
    market: MarketReference;
    psListings: PunkStrategyListing[];
    svgMarkup: string | null;
    traitNames: string[];
    titleAuction: TitleAuctionState;
    eligiblePunkCount: number | null;
    nowSeconds: bigint;
    indexerDegraded: boolean;
}> {
    const adapter = getDataAdapter();
    // Parallel: every panel reads its own slice. Each slice is wrapped so a
    // single read failure degrades to a safe default instead of rejecting the
    // whole page — the dashboard always renders, even mid-incident.
    const [state, auctions, resolved, accepted, market, psListings, svgMarkup, traitNames, titleAuction, eligiblePunkCount] =
        await Promise.all([
            slice(adapter.getProtocolState(), ZERO_PROTOCOL_STATE),
            slice(adapter.getActiveAuctions(), []),
            // Resolved auctions feed the section's "Previous return auctions"
            // history. Section hides entirely when there are zero active AND
            // zero resolved, so a fresh-deploy state doesn't show a stub.
            slice(adapter.getRecentResolutions(20), []),
            slice(adapter.getRecentAcceptedBids(3), []),
            slice(adapter.getMarketReference(), {available: false} as MarketReference),
            slice(adapter.getPunkStrategyListings(), []),
            slice(adapter.getRendererSvg(), null),
            slice(adapter.getTraitNames(), []),
            slice(adapter.getTitleAuctionState(), notDeployedTitleAuctionState()),
            slice(adapter.getEligiblePunkCount(), null),
        ]);
    return {
        state,
        auctions,
        resolved,
        accepted,
        market,
        psListings,
        svgMarkup,
        traitNames,
        titleAuction,
        eligiblePunkCount,
        nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
        // Read AFTER the fetches above resolve: any indexer failure during
        // this request has been recorded by then, so the page can mark its
        // indexer-backed sections as incomplete instead of quietly empty.
        indexerDegraded: isIndexerDegraded(),
    };
}

export default async function Home() {
    // Always the live dashboard. Before the protocol is deployed the adapter
    // returns honest zeros (0 live bid, nothing collected, no auctions) and
    // the artwork renders from PunksData — no fabricated data, no swap.
    const data = await fetchHomeData();
    return (
        <>
            <Header />
            <main id="top">
                {data.indexerDegraded && <IndexerDegradedNotice />}
                <Hero
                    state={data.state}
                    market={data.market}
                    svgMarkup={data.svgMarkup}
                />
                <LoopStory
                    variant="wheel"
                    initialLiveBidWei={data.state.liveBidWei.toString()}
                    collectedCount={data.state.collectedCount}
                />
                <LiveBidSection
                    state={data.state}
                    market={data.market}
                    eligiblePunkCount={data.eligiblePunkCount}
                />
                <TitleAuctionBanner
                    state={data.titleAuction}
                    nowSeconds={data.nowSeconds}
                />
                <AuctionSection
                    state={data.state}
                    auctions={data.auctions}
                    resolved={data.resolved}
                    nowSeconds={data.nowSeconds}
                    traitNames={data.traitNames}
                    recentAccepted={data.accepted}
                />
                <PunkStrategyListings
                    options={buildListedTraitOptions(data.psListings)}
                    traitNames={data.traitNames}
                    punkThumbs={buildPunkThumbs(data.psListings.map((l) => l.punkId))}
                />
                <TokenSection />
                <CollectionPreview state={data.state} />
                <VaultSection />
            </main>
            <Footer />
        </>
    );
}
