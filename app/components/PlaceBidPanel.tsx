'use client';

/* Bid composer for an active return auction (return auction). Used by the
   homepage (AuctionSection, count === 1) and the auction detail page
   (/auction/[punkId]).

   The contract exposes two bid entry points:
     - `placeBid(uint16 punkId)`                              — the simple path
     - `placeBidWithReferral(uint16 punkId, address, bytes32)` — with referral
   both with `value = amount`. Outgoing bidders are refunded by the contract on
   the next bid; if push fails the refund is recoverable from ReturnAuctionModule.

   The common case stays simple: with no referrer we call `placeBid(punkId)`. A
   bidder who arrived via `?ref=0x…` (resolved by `useReferrer()` — the same
   source the swap path uses) routes through `placeBidWithReferral` so their
   referrer earns the auction-referral share of the premium if this bid wins.
   `tag` is unused by the default UI, so we pass the zero hash.

   The actual input + submit + state machine + tx-link UI lives in the
   shared `BidComposer` — this wrapper only injects the return-auction-specific
   ABI call + reserve fineprint. */

import {zeroHash} from 'viem';
import {useQueryClient} from '@tanstack/react-query';
import {abi as ReturnAuctionAbi} from '@/lib/abis/ReturnAuctionModule';
import {BidComposer} from './BidComposer';
import {getContractAddresses} from '@/lib/config';
import {auctionBidsKey} from '@/lib/data/useAuctionBids';
import {formatEth} from '@/lib/format';
import {useReferrer} from '@/lib/swap/useReferrer';

export function PlaceBidPanel({
    punkId,
    minNextBidWei,
    reserveWei,
    highBidWei,
    closed,
    variant = 'card',
}: {
    punkId: number;
    minNextBidWei: bigint;
    reserveWei: bigint;
    highBidWei: bigint;
    closed: boolean;
    variant?: 'card' | 'inline';
}) {
    const hasHigh = highBidWei > 0n;
    const referrer = useReferrer();
    const queryClient = useQueryClient();
    return (
        <BidComposer
            minNextBidWei={minNextBidWei}
            closed={closed}
            inputIdSuffix={String(punkId)}
            variant={variant}
            onSubmit={async ({wallet, address, amount}) => {
                const addrs = getContractAddresses();
                // No referrer → the simple entry point. A resolved referrer
                // routes through placeBidWithReferral so attribution is carried
                // on-chain (the contract's referral path is fail-closed, but we
                // don't even reach it without a referrer).
                if (referrer) {
                    return wallet.writeContract({
                        abi: ReturnAuctionAbi,
                        address: addrs.returnAuctionModule,
                        functionName: 'placeBidWithReferral',
                        args: [punkId, referrer, zeroHash],
                        value: amount,
                        account: address,
                        chain: wallet.chain,
                    });
                }
                return wallet.writeContract({
                    abi: ReturnAuctionAbi,
                    address: addrs.returnAuctionModule,
                    functionName: 'placeBid',
                    args: [punkId],
                    value: amount,
                    account: address,
                    chain: wallet.chain,
                });
            }}
            onSuccess={() => {
                // Bust the shared /api/auction-bids cache so this bidder
                // (and everyone's next poll) sees the new bid immediately
                // instead of waiting out the TTL. Best-effort.
                void fetch('/api/auction-bids', {method: 'POST'}).catch(() => {});
                // Refetch the shared bids query now so the current-bid stat +
                // bid history reflect this bid the moment it confirms, without
                // waiting on the 30s poll.
                void queryClient.invalidateQueries({queryKey: auctionBidsKey(punkId)});
            }}
            fineprintExtra={
                !hasHigh ? `Reserve was set at acceptance: ${formatEth(reserveWei)}.` : undefined
            }
        />
    );
}
