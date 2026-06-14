'use client';

/* Bid history for an active return auction.

   Reads from `/api/auction-bids?punkId=N`, a shared server-cached endpoint
   backed by the Ponder indexer's `Bid` table. The previous implementation
   ran a `pub.getLogs` against the wallet's public-client transport once
   per viewer — that fanned out chain reads across every tab, which under
   the new three-leg fee story was a real RPC-cost regression.

   The endpoint is `unstable_cache`d at ~15s so N concurrent viewers
   collapse to ~1 indexer hit per cache window. The connected bidder's own
   bids bust the cache directly via the POST handler from PlaceBidPanel's
   onSuccess hook, so a bidder sees their tx land immediately. */

import {useQuery} from '@tanstack/react-query';
import {usePublicClient} from 'wagmi';
import {chainNowSeconds} from '@/lib/swap/chainTime';
import {useAuctionBids} from '@/lib/data/useAuctionBids';
import {formatEth, getEvmNowTxUrl, shortAddress} from '@/lib/format';

/** A non-bid terminal row appended after the bids — the cleared-settle
 *  allocations of the winning bid (live-bid refill, bought-and-burned, vault
 *  burn). Rendered distinctly from bids: an allocation label + short tag, no
 *  bidder/time/tx. */
export interface TerminalAllocationRow {
    label: string;
    amountWei: bigint;
    /** Short uppercase tag in the time column, e.g. "to bid" / "burned". */
    tag: string;
}

interface Props {
    punkId: number;
    chainId: number;
    /** Server-side hint: the chain-direct getSale returned a non-zero high
     *  bid. Used to disambiguate the empty-state copy when the indexer-
     *  backed bids cache lags behind the chain. */
    highBidExists?: boolean;
    /** Settlement allocations to append below the bids (cleared auctions only).
     *  Undefined for live auctions and legacy rows without an indexed split. */
    terminalRows?: TerminalAllocationRow[];
}

export function AuctionBidHistory({punkId, chainId, highBidExists, terminalRows}: Props) {
    const pub = usePublicClient();
    const {data, isLoading, error} = useAuctionBids(punkId);
    // Pull chain "now" so bid age is correct on forks where anvil's clock
    // is warped past wall time. Falls back to Date.now() only if there's
    // no client OR the read fails. Co-located with the bids query so the
    // re-fetch interval covers both.
    const {data: nowSec} = useQuery({
        queryKey: ['chain-now', chainId],
        queryFn: async (): Promise<number> => {
            if (!pub) return Math.floor(Date.now() / 1000);
            try {
                return await chainNowSeconds(pub);
            } catch {
                return Math.floor(Date.now() / 1000);
            }
        },
        refetchInterval: 30_000,
        staleTime: 15_000,
        enabled: !!pub,
    });

    const bids = data ?? [];
    const burnRows = terminalRows ?? [];
    // The burn rows are prop-derived (the settled split), so they render
    // regardless of the bid query — only fall through to loading/error/empty
    // when there's nothing to show at all.
    const hasContent = bids.length > 0 || burnRows.length > 0;

    return (
        <section className="bid-history" aria-label="Bid history">
            <h3 className="bid-history-title">Bid history</h3>
            {isLoading && !hasContent ? (
                <p className="bid-history-empty">Loading bids…</p>
            ) : error && !hasContent ? (
                <p className="bid-history-empty">Couldn&apos;t load bid history.</p>
            ) : !hasContent ? (
                <p className="bid-history-empty">
                    {highBidExists
                        ? 'Catching up to chain… the current high bid is on the panel above.'
                        : 'No bids yet. Be the first.'}
                </p>
            ) : (
                <ol className="bid-history-list">
                    {bids.map((b) => (
                        <li key={`${b.txHash}-${b.blockNumber}`} className="bid-history-row">
                            <span className="bid-history-amount tnum">{formatEth(b.amount)}</span>
                            <span className="bid-history-bidder">{shortAddress(b.bidder)}</span>
                            <span className="bid-history-when">{relativeFromNow(b.timestamp, nowSec)}</span>
                            <a
                                className="bid-history-tx"
                                href={getEvmNowTxUrl(b.txHash, chainId)}
                                target="_blank"
                                rel="noreferrer"
                            >
                                tx ↗
                            </a>
                        </li>
                    ))}
                    {burnRows.map((t, i) => (
                        <li key={`alloc-${i}`} className="bid-history-row bid-history-row-alloc">
                            <span className="bid-history-amount tnum">{formatEth(t.amountWei)}</span>
                            <span className="bid-history-bidder">{t.label}</span>
                            <span className="bid-history-when bid-history-alloc-tag">{t.tag}</span>
                            <span aria-hidden="true" />
                        </li>
                    ))}
                </ol>
            )}
            <style>{styles}</style>
        </section>
    );
}

function relativeFromNow(timestampSec: bigint, chainNowSec?: number): string {
    if (timestampSec === 0n) return '—';
    // Default to wall clock if chain time hasn't loaded yet (first render).
    // The query refetches every 30s so the chain-time value lands quickly.
    const nowSec = chainNowSec ?? Math.floor(Date.now() / 1000);
    const delta = nowSec - Number(timestampSec);
    if (delta < 0) return 'just now';
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}

const styles = `
.bid-history {
    margin-top: 28px;
    border-top: 1px solid var(--line);
    padding-top: 22px;
}
.bid-history-title {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 300;
    letter-spacing: -0.02em;
    margin: 0 0 14px;
}
.bid-history-empty {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
    margin: 0;
}
.bid-history-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.bid-history-row {
    background: var(--bg);
    padding: 12px 14px;
    display: grid;
    grid-template-columns: minmax(0, 110px) minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 14px;
    font-family: var(--mono);
    font-size: 13px;
}
.bid-history-row:first-child {
    background: var(--panel);
}
.bid-history-amount {
    color: var(--accent);
    font-size: 14px;
}
.bid-history-bidder {
    color: var(--ink);
}
.bid-history-when {
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.04em;
}
.bid-history-tx {
    color: var(--muted);
    font-size: 11px;
    text-decoration: none;
    letter-spacing: 0.04em;
}
.bid-history-tx:hover {
    color: var(--accent);
}
.bid-history-row-alloc {
    background: var(--panel);
}
.bid-history-row-alloc .bid-history-bidder {
    color: var(--muted);
    text-transform: none;
}
.bid-history-alloc-tag {
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 10px;
    color: var(--muted);
}
@media (max-width: 560px) {
    .bid-history-row {
        grid-template-columns: 1fr auto;
        row-gap: 4px;
    }
    .bid-history-bidder {
        grid-column: 1 / -1;
        font-size: 12px;
    }
}
`;
