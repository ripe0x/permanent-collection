import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {AuctionDetailView} from '@/components/AuctionDetailView';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {PunkSvg} from '@/components/PunkSvg';
import {getDataAdapter} from '@/lib/data';
import {getChainTimeSeconds} from '@/lib/data/fork';
import {buildMeta} from '@/lib/meta';

export const dynamic = 'force-dynamic';

export async function generateMetadata({params}: {params: Promise<{punkId: string}>}): Promise<Metadata> {
    const {punkId: raw} = await params;
    const punkId = Number.parseInt(raw, 10);
    return buildMeta({
        title: `Punk #${punkId}`,
        description: `Punk #${punkId}'s 72-hour return auction.`,
        path: `/auction/${punkId}`,
    });
}

export default async function AuctionPage({params}: {params: Promise<{punkId: string}>}) {
    const {punkId: raw} = await params;
    const punkId = Number.parseInt(raw, 10);
    if (!Number.isInteger(punkId) || punkId < 0 || punkId > 9999) notFound();

    const adapter = getDataAdapter();
    const [auction, traitNames, nowSeconds] = await Promise.all([
        adapter.getAuctionByPunkId(punkId),
        adapter.getTraitNames(),
        // Chain time for the countdown render. Date.now() drifts from
        // `block.timestamp` by hours-to-days on local anvil forks (which warp
        // ahead) and on mainnet RPCs that lag the head. Resilient: falls back
        // to wall-clock if the RPC read fails, so a throttled public node
        // can't 500 the page.
        getChainTimeSeconds(),
    ]);
    // Once an auction settles, getAuctionByPunkId returns null. Fall back to the
    // settled record so the page shows the outcome + bid history instead of a
    // not-found state.
    const resolved = auction ? null : await adapter.getResolvedAuctionByPunkId(punkId);
    const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '1');

    return (
        <>
            <Header />
            <main id="top">
                <AuctionDetailView
                    auction={auction ? {
                        punkId: auction.punkId,
                        targetTraitId: auction.targetTraitId,
                        acquisitionCostWei: auction.acquisitionCostWei.toString(),
                        reserveWei: auction.reserveWei.toString(),
                        highBidWei: auction.highBidWei.toString(),
                        highBidder: auction.highBidder,
                        startedAt: auction.startedAt.toString(),
                        endsAt: auction.endsAt.toString(),
                        extensions: auction.extensions,
                        attemptCount: auction.attemptCount,
                    } : null}
                    resolved={resolved ? {
                        punkId: resolved.punkId,
                        targetTraitId: resolved.targetTraitId,
                        outcome: resolved.outcome,
                        finalBidWei: resolved.finalBidWei.toString(),
                        acquisitionPriceWei: resolved.acquisitionPriceWei?.toString(),
                        liveBidShareWei: resolved.liveBidShareWei?.toString(),
                        burnShareWei: resolved.burnShareWei?.toString(),
                        settledAt: resolved.settledAt.toString(),
                    } : null}
                    punkId={punkId}
                    nowSeconds={nowSeconds.toString()}
                    chainId={chainId}
                    traitNames={traitNames}
                    punkImage={
                        <PunkSvg
                            punkId={punkId}
                            size={520}
                            label={`Punk #${punkId}`}
                            background="transparent"
                        />
                    }
                />
            </main>
            <Footer />
        </>
    );
}
