'use client';

/* The quiet facts line under the live-bid note on the landing page: lifetime
 * official-pool volume (exact ETH from the indexer's per-swap SkimSplit
 * totals, annotated with an approximate dollar figure at the current ETH
 * spot) and the count of Punks currently eligible to accept the bid.
 *
 * Annotation row, not a dashboard: every value is optional and the row
 * collapses to whatever is actually known — volume hides when the indexer
 * predates the SkimSplit counters (or genuinely reads 0), the dollar figure
 * hides until the shared ETH spot lands, the eligible count hides when the
 * state can't be sourced. Nothing here is ever estimated or invented. */

import {formatEther} from 'viem';

import {useEthUsd} from '@/lib/data/useEthUsd';
import {formatEthBare, formatUsdCompact} from '@/lib/format';

export function BidFacts({
    totalSwapVolumeWei,
    swapCount,
    eligiblePunkCount,
}: {
    /** Serialized wei (server components can't hand bigint to a client
     *  island). Null or "0" hides the volume fact. */
    totalSwapVolumeWei: string | null;
    swapCount: number | null;
    eligiblePunkCount: number | null;
}) {
    const ethUsd = useEthUsd();

    const volumeWei = totalSwapVolumeWei !== null ? BigInt(totalSwapVolumeWei) : null;
    const showVolume = volumeWei !== null && volumeWei > 0n;
    const volumeUsd =
        showVolume && ethUsd !== null
            ? formatUsdCompact(Number(formatEther(volumeWei)) * ethUsd)
            : null;
    const showEligible = eligiblePunkCount !== null && eligiblePunkCount > 0;

    if (!showVolume && !showEligible) return null;

    return (
        <div className="bid-facts">
            {showVolume && (
                <span
                    className="bid-fact tnum"
                    title="Lifetime ETH volume through the official pool (both directions), from the hook's per-swap events. The dollar figure applies the current ETH price to the whole history."
                >
                    {formatEthBare(volumeWei, 1)} ETH traded in the official pool
                    {swapCount !== null && swapCount > 0
                        ? ` across ${swapCount.toLocaleString()} trades`
                        : ''}
                    {volumeUsd ? ` (≈ ${volumeUsd})` : ''}
                </span>
            )}
            {showVolume && showEligible && (
                <span className="bid-facts-sep" aria-hidden="true">
                    ·
                </span>
            )}
            {showEligible && (
                <span
                    className="bid-fact tnum"
                    title="Punks carrying at least one uncollected, non-pending trait and not already in a return auction or the vault. Any of them can accept the live bid."
                >
                    {eligiblePunkCount.toLocaleString()} eligible Punks
                </span>
            )}
            <style>{styles}</style>
        </div>
    );
}

const styles = `
.bid-facts {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 14px;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    color: var(--muted);
}
.bid-facts-sep {
    opacity: 0.5;
}
`;
