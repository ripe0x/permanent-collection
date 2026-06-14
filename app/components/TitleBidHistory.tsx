'use client';

/* Bid history for the vault Title Auction. Receives an initial server-side
   list and refreshes via a client-side API call once a minute (so visitors
   landing during an active round see fresh bids without a hard reload).

   The history straddles all rounds — including any no-bidder restart loops.
   Each row gets its tx link via evm.now per the project's tx-link rule. */

import {useEffect, useState} from 'react';
import {formatEth, getEvmNowTxUrl, shortAddress} from '@/lib/format';
import type {TitleAuctionBidEntry} from '@/lib/data/types';

interface Wire {
    bidder: string;
    amount: string;
    endsAt: string;
    extended: boolean;
    blockNumber: string;
    timestamp: string;
    txHash: string;
}

interface Props {
    /** Server-rendered initial list (serialized bigints as strings). */
    initial: Wire[];
    chainId: number;
}

export function TitleBidHistory({initial, chainId}: Props) {
    const [bids, setBids] = useState<TitleAuctionBidEntry[]>(() =>
        initial.map(deserialize),
    );

    // Light client refresh: poll once per minute so a viewer who lingers
    // sees other people's bids without reloading. The same data is hot-
    // pulled by the bid panel's tx confirmation flow (separately), so this
    // is a backstop for everyone-else's-bids freshness.
    useEffect(() => {
        let cancelled = false;
        async function refresh() {
            try {
                const res = await fetch('/api/title-auction/bids', {cache: 'no-store'});
                if (!res.ok) return;
                const json = (await res.json()) as {bids: Wire[]};
                if (!cancelled) setBids(json.bids.map(deserialize));
            } catch {
                // Ignore — keep last-known list.
            }
        }
        const id = setInterval(refresh, 60_000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, []);

    return (
        <section className="title-bid-history" aria-label="Bid history">
            <h3 className="title-bid-history-title">Bid history</h3>
            {bids.length === 0 ? (
                <p className="title-bid-history-empty">No bids yet. Be the first.</p>
            ) : (
                <ol className="title-bid-history-list">
                    {bids.map((b) => (
                        <li
                            key={`${b.txHash}-${b.blockNumber}`}
                            className="title-bid-history-row"
                        >
                            <span className="title-bid-history-amount tnum">
                                {formatEth(b.amount)}
                            </span>
                            <span className="title-bid-history-bidder">
                                {shortAddress(b.bidder)}
                            </span>
                            <span className="title-bid-history-when">
                                {relative(b.timestamp)}
                                {b.extended && (
                                    <span
                                        className="title-bid-history-extended"
                                        title="Triggered an anti-snipe extension"
                                    >
                                        +1h
                                    </span>
                                )}
                            </span>
                            <a
                                className="title-bid-history-tx"
                                href={getEvmNowTxUrl(b.txHash, chainId)}
                                target="_blank"
                                rel="noreferrer"
                            >
                                tx ↗
                            </a>
                        </li>
                    ))}
                </ol>
            )}
            <style>{styles}</style>
        </section>
    );
}

function deserialize(w: Wire): TitleAuctionBidEntry {
    return {
        bidder: w.bidder as `0x${string}`,
        amount: BigInt(w.amount),
        endsAt: BigInt(w.endsAt),
        extended: w.extended,
        blockNumber: BigInt(w.blockNumber),
        timestamp: BigInt(w.timestamp),
        txHash: w.txHash as `0x${string}`,
    };
}

function relative(timestampSec: bigint): string {
    if (timestampSec === 0n) return '—';
    const now = Math.floor(Date.now() / 1000);
    const delta = now - Number(timestampSec);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86_400)}d ago`;
}

const styles = `
.title-bid-history {
    margin-top: 28px;
    border-top: 1px solid var(--line);
    padding-top: 22px;
}
.title-bid-history-title {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 300;
    letter-spacing: -0.02em;
    margin: 0 0 14px;
}
.title-bid-history-empty {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
    margin: 0;
}
.title-bid-history-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.title-bid-history-row {
    background: var(--bg);
    padding: 12px 14px;
    display: grid;
    grid-template-columns: minmax(0, 110px) minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 14px;
    font-family: var(--mono);
    font-size: 13px;
}
.title-bid-history-row:first-child {
    background: var(--panel);
}
.title-bid-history-amount {
    color: var(--accent);
    font-size: 14px;
}
.title-bid-history-bidder {
    color: var(--ink);
}
.title-bid-history-when {
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.04em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
}
.title-bid-history-extended {
    border: 1px solid var(--accent);
    color: var(--accent);
    padding: 1px 5px;
    font-size: 10px;
    letter-spacing: 0.08em;
}
.title-bid-history-tx {
    color: var(--muted);
    font-size: 11px;
    text-decoration: none;
    letter-spacing: 0.04em;
}
.title-bid-history-tx:hover {
    color: var(--accent);
}
@media (max-width: 560px) {
    .title-bid-history-row {
        grid-template-columns: 1fr auto;
        row-gap: 4px;
    }
    .title-bid-history-bidder {
        grid-column: 1 / -1;
        font-size: 12px;
    }
}
`;
