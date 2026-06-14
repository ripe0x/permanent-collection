import type {Metadata} from 'next';
import {TitleAuctionView} from '@/components/TitleAuctionView';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {getContractAddresses} from '@/lib/config';
import {getDataAdapter} from '@/lib/data';
import {getChainTimeSeconds} from '@/lib/data/fork';
import {buildMeta} from '@/lib/meta';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
    return buildMeta({
        title: 'The Title',
        description:
            "The vault's one-of-one Title NFT. Auctioned once the protocol has collected 22 traits.",
        path: '/title',
    });
}

export default async function TitlePage() {
    const adapter = getDataAdapter();
    const [state, bids, titleSvg, nowSeconds] = await Promise.all([
        adapter.getTitleAuctionState(),
        adapter.getTitleAuctionBids(),
        adapter.getTitleSvg(),
        // Chain time, not wall-clock. The countdown / "ended N ago" copy on
        // TitleAuctionView is computed against this; Date.now() drifts by
        // hours-to-days on local anvil forks (which warp ahead) and on
        // mainnet RPCs that lag the head. Resilient: falls back to wall-clock
        // if the RPC read fails, so a throttled public node can't 500 the page.
        getChainTimeSeconds(),
    ]);
    const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '1');

    return (
        <>
            <Header />
            <main id="top">
                <TitleAuctionView
                    state={{
                        phase: state.phase,
                        collectedCount: state.collectedCount,
                        isKickoffReady: state.isKickoffReady,
                        isLive: state.isLive,
                        isSettleable: state.isSettleable,
                        kickedOff: state.kickedOff,
                        settled: state.settled,
                        endsAt: state.endsAt.toString(),
                        highBidWei: state.highBidWei.toString(),
                        highBidder: state.highBidder,
                        minNextBidWei: state.minNextBidWei.toString(),
                        restartCount: state.restartCount,
                        extensionsThisRound: state.extensionsThisRound,
                        pendingProceedsByAddr: {
                            patron: state.pendingProceedsByAddr.patron.toString(),
                            payoutRecipient: state.pendingProceedsByAddr.payoutRecipient.toString(),
                        },
                        patronAddr: state.patronAddr,
                        payoutRecipientAddr: state.payoutRecipientAddr,
                        pendingRefundForCaller: state.pendingRefundForCaller?.toString(),
                    }}
                    bids={bids.map((b) => ({
                        bidder: b.bidder,
                        amount: b.amount.toString(),
                        endsAt: b.endsAt.toString(),
                        extended: b.extended,
                        blockNumber: b.blockNumber.toString(),
                        timestamp: b.timestamp.toString(),
                        txHash: b.txHash,
                    }))}
                    nowSeconds={nowSeconds.toString()}
                    chainId={chainId}
                    titleAuctionAddr={getContractAddresses().titleAuction}
                    titleSvg={titleSvg}
                />
            </main>
            <Footer />
        </>
    );
}
