'use client';

/* Bid composer for the vault Title Auction. Wraps the shared `BidComposer`
   with a `PunkVaultTitleAuction.bid()` write call.

   No reserve. The first bid only needs to be non-zero; subsequent bids
   must be strictly greater AND ≥ 5% above the current high (the contract
   enforces both with `BidNotHigherThanCurrent` + `BidBelowMinimumIncrease`).

   Pre-launch envs may not have a titleAuction address — the composer
   short-circuits to a "Not deployed" hint instead. */

import {abi as PunkVaultTitleAuctionAbi} from '@/lib/abis/PunkVaultTitleAuction';
import {BidComposer} from './BidComposer';
import {getContractAddresses} from '@/lib/config';

export function TitleBidPanel({
    minNextBidWei,
    closed,
    variant = 'card',
    hasHigh,
}: {
    /** From `minNextBid()` view. 0 pre-first-bid (first bid only needs to
     *  be non-zero); otherwise highBidWei × 1.05. */
    minNextBidWei: bigint;
    /** True when the auction is settled OR in a settleable state where
     *  bids no longer take. */
    closed: boolean;
    variant?: 'card' | 'inline';
    /** Whether a bid already exists. Drives the helper copy under the
     *  input ("first bid — any non-zero amount" vs minimum-bid framing). */
    hasHigh: boolean;
}) {
    const addrs = getContractAddresses();
    const titleAuction = addrs.titleAuction;
    if (!titleAuction) {
        return (
            <aside className="title-bid-stub" aria-label="Title Auction not deployed">
                <p>Title Auction not deployed in this environment.</p>
                <style>{stubStyles}</style>
            </aside>
        );
    }

    return (
        <BidComposer
            minNextBidWei={minNextBidWei}
            closed={closed}
            closedMessage="The bidding window is closed. Settlement is the next step, and anyone can call it."
            inputIdSuffix="title"
            variant={variant}
            kickerLabel="bid on the title"
            successMessage="You're the high bidder for the Title."
            onSubmit={async ({wallet, address, amount}) => {
                return wallet.writeContract({
                    abi: PunkVaultTitleAuctionAbi,
                    address: titleAuction,
                    functionName: 'bid',
                    args: [],
                    value: amount,
                    account: address,
                    chain: wallet.chain,
                });
            }}
            onSuccess={() => {
                // Bust the shared /api/title-auction/bids cache so this
                // bidder (and everyone's next poll) sees the new bid
                // immediately instead of waiting out the TTL.
                void fetch('/api/title-auction/bids', {method: 'POST'}).catch(() => {});
            }}
            fineprint={
                hasHigh
                    ? 'Bids must be at least 5% above the current high. Bids in the final 15 minutes extend the deadline by 1 hour, uncapped. Outgoing bidders are refunded automatically; if the push fails you can pull from the auction.'
                    : 'No reserve. The first bid may be any non-zero amount. After that, each new bid must be at least 5% above the current high. Bids in the final 15 minutes extend the deadline by 1 hour, uncapped.'
            }
        />
    );
}

const stubStyles = `
.title-bid-stub {
    border: 1px dashed var(--line);
    padding: 18px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.title-bid-stub p {
    margin: 0;
}
`;
