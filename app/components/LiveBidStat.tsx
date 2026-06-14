'use client';

/* Client-side reactive Live Bid display with odometer-style increment.
 *
 * Shows `Patron.bidBalance()` via the cached `/api/live-bid` endpoint
 * (SSR-seeded for a fast first paint), polled on a short interval. The
 * three-leg hook split in `ArtCoinsHookSkimFee` accrues each leg into its
 * adapter at swap-time and flushes within the same tx, so the on-chain
 * live bid grows on its own — no manual sweep, no optimistic estimate.
 * The poll means the chip ticks up for ANYONE's trade, not just the
 * viewer's; SwapBox also refetches after the viewer's own swap so they
 * see it instantly. The query is shared via react-query's cache.
 *
 * Visual: when the value rises, a small green "+0.XXX ETH" badge slides in
 * next to it for ~2.5s. Makes the "every trade grows the bid" affordance loud.
 *
 * `<LiveBidPending />` is a separate sibling component for the smaller
 * "+X ETH pending" counter (fees collected but still upstream of Patron). Kept
 * separate so each caller can decide where to place it — e.g. the footer
 * line "0.199 ETH live bid" stays compact inline, with pending falling to a
 * second line UNDER the whole line rather than splitting "live bid" off the
 * value. Both components subscribe to the same `useLiveBidBalance` hook, so
 * they share one react-query entry (no extra fetches).
 *
 * `<LiveBidSweepMover />` is the permissionless "move pending → live" affordance
 * that calls `LiveBidAdapter.sweep()`. It surfaces inline between the live-bid
 * value and the pending counter on the /trade page so it reads as "the lever
 * between these two boxes". The explainer (pending vs. live) is always shown;
 * the actual button only renders when there's pending ETH to move.
 */

import {useCallback, useEffect, useState} from 'react';
import {formatEther, type Hash} from 'viem';
import {useAccount, useChainId, usePublicClient, useReadContracts, useWalletClient} from 'wagmi';

import {abi as liveBidAdapterAbi} from '@/lib/abis/LiveBidAdapter';
import {getContractAddresses} from '@/lib/config';
import {useEthUsd} from '@/lib/data/useEthUsd';
import {useIncreaseFlash} from '@/lib/data/useIncreaseFlash';
import {useLiveBidBalance} from '@/lib/data/useLiveBidBalance';
import {formatDelta, formatEth, formatUsdWhole, getEvmNowTxUrl} from '@/lib/format';

interface LiveBidStatProps {
    /** SSR seed — live-bid value at page-request time, in wei (string-encoded). */
    initialWei: string;
    /** Class for the value span. Defaults to the /trade stat style;
     *  the Hero passes its larger `bid-value tnum`. */
    valueClassName?: string;
}

interface LiveBidPendingProps {
    /** SSR seed — pending (in-flight fee) value at page-request time, in wei
     *  (string-encoded). Optional: defaults to 0, so the counter hides on first
     *  paint and appears once the first poll lands. Callers should pass
     *  `state.liveBidPendingWei.toString()` so the counter doesn't pop in. */
    initialWei?: string;
}

export function LiveBidStat({
    initialWei,
    valueClassName = 'trade-stat-value tnum',
}: LiveBidStatProps) {
    const {value: onchainValue, isStale} = useLiveBidBalance();

    const totalWei = onchainValue ?? BigInt(initialWei);

    // Surface the most-recent increase as a green badge that pulses in and
    // auto-clears after 2.5s so the chip settles back to its normal look.
    const recentDelta = useIncreaseFlash(totalWei, 2500);

    // Show the value silently — no per-poll roll-up animation. The big
    // headline number ticking on every refresh felt like the screen was
    // "saving and coming back" even when the actual change was tiny. The
    // green "+0.XXX ETH" delta badge below is the increase affordance.
    const valueText = formatEth(totalWei);

    const title = `Live bid (reads Patron.bidBalance on-chain): ${formatEther(totalWei)} ETH`;

    return (
        <>
            <span className={`live-bid-wrap ${isStale ? 'is-stale' : ''}`.trim()} title={title}>
                <span className={`${valueClassName} live-bid-value`}>
                    {valueText}
                </span>
                {recentDelta > 0n && (
                    <span
                        key={recentDelta.toString()}
                        className="live-bid-delta tnum"
                        aria-hidden="true"
                    >
                        {formatDelta(recentDelta)}
                    </span>
                )}
            </span>
            <style>{styles}</style>
        </>
    );
}

/** The smaller "+X ETH pending" counter that sits below the live bid. Surfaces
 *  the fee ETH already collected from LP fees but still upstream of Patron
 *  (buffered at LiveBidAdapter + the LiveBidAdapter slot in the artcoins
 *  escrow) — the "fees in the system on their way to the bid". Hidden when
 *  there's nothing pending; appears as soon as fees accumulate. */
export function LiveBidPending({initialWei}: LiveBidPendingProps) {
    const {pending: onchainPending} = useLiveBidBalance();
    const pendingWei = onchainPending ?? (initialWei ? BigInt(initialWei) : 0n);
    if (pendingWei <= 0n) return null;
    const eth = Number(formatEther(pendingWei));
    const formatted =
        eth >= 0.001
            ? `+${eth.toFixed(3)} ETH`
            : eth >= 0.000001
              ? `+${eth.toFixed(6)} ETH`
              : `+${eth.toExponential(2)} ETH`;
    return (
        <div
            className="live-bid-pending tnum"
            title={`In flight to the bid: ${formatEther(pendingWei)} ETH (fees collected + waiting to sweep into Patron)`}
        >
            {formatted} pending
        </div>
    );
}

/** The "≈ $X" dollar annotation under the live-bid value. Same polled
 *  on-chain read as `LiveBidStat` (shared react-query entry) × the shared
 *  ETH/USD spot from the GeckoTerminal proxy, so it ticks with the bid and
 *  with the price. Renders nothing until both are known (or when the bid is
 *  zero) — the ETH figure is the canonical number, the dollar line is an
 *  annotation that must never block or invent. */
export function LiveBidUsd({initialWei}: {initialWei?: string}) {
    const {value: onchainValue} = useLiveBidBalance();
    const ethUsd = useEthUsd();
    const wei = onchainValue ?? (initialWei ? BigInt(initialWei) : 0n);
    if (wei <= 0n || ethUsd === null) return null;
    const usd = Number(formatEther(wei)) * ethUsd;
    return (
        <>
            <div
                className="live-bid-usd tnum"
                title={`At $${ethUsd.toLocaleString('en-US', {maximumFractionDigits: 0})}/ETH (GeckoTerminal spot, refreshed every minute)`}
            >
                ≈ {formatUsdWhole(usd)}
            </div>
            <style>{usdStyles}</style>
        </>
    );
}

const usdStyles = `
.live-bid-usd {
    display: block;
    margin-top: 6px;
    font-family: var(--mono);
    font-size: 14px;
    letter-spacing: 0.02em;
    color: var(--muted);
    white-space: nowrap;
}
`;

/** Walk a viem/wallet error's cause chain for the most useful message
 *  (`shortMessage` beats the truncated top-level `.message`). */
function walletErrorMessage(err: unknown, depth = 0): string | null {
    if (depth > 5 || !err) return null;
    if (err instanceof Error) {
        const anyErr = err as Error & {shortMessage?: string; cause?: unknown};
        if (anyErr.shortMessage) return anyErr.shortMessage;
        return walletErrorMessage(anyErr.cause, depth + 1) ?? anyErr.message;
    }
    return null;
}

/** True when the user dismissed the wallet prompt (so we must NOT silently
 *  fall back to a second prompt). */
function isUserRejection(err: unknown): boolean {
    return /user rejected|user denied/i.test(walletErrorMessage(err) ?? '');
}

/** Sweep affordance that sits in the vertical gap between the trade-stats
 *  row (Current live bid + Permanent traits) and the fee-routing block on
 *  the /trade page. Full-width row with a brief pending-vs-live explainer
 *  on the left and an action button on the right.
 *
 *  Drains the pending fee ETH into the live bid via a single
 *  `LiveBidAdapter.sweep()`. The bid leg is the only fee leg that funds the
 *  live bid (the protocol leg sweeps to PCController and never reaches it), so
 *  one sweep of the bid adapter drains everything the pending counter shows.
 *  The call is permissionless and pays the caller (kept as `msg.sender`) a
 *  small keeper reward off the forwarded amount (≤0.5% / ≤0.01 ETH). */
export function LiveBidSweepMover() {
    const {pending, value: liveBid, refetch} = useLiveBidBalance();
    const {address} = useAccount();
    const chainId = useChainId();
    const pub = usePublicClient();
    const {data: wallet} = useWalletClient();

    // Read the adapter's two-mode parameters so the explainer can describe what
    // a sweep will actually do: BELOW the activation threshold the buffer
    // forwards uncapped (fast warm-up); AT/ABOVE it the throttle caps each
    // forward at `maxSweepWei`. These move only on an `acceptBid` (which
    // re-syncs the threshold) or an admin tweak, so a long staleTime is fine —
    // and the reads route through the same-origin /api/rpc proxy.
    const {liveBidAdapter: adapterAddr} = getContractAddresses();
    const {data: adapterParams} = useReadContracts({
        contracts: [
            {address: adapterAddr, abi: liveBidAdapterAbi, functionName: 'activationThreshold'},
            {address: adapterAddr, abi: liveBidAdapterAbi, functionName: 'maxSweepWei'},
        ],
        query: {staleTime: 60_000},
    });
    const activationThreshold = adapterParams?.[0]?.result as bigint | undefined;
    const maxSweepWei = adapterParams?.[1]?.result as bigint | undefined;
    // The contract gates fast/throttled on Patron's raw balance; the live bid
    // (accountedLiveBidWei) is the user-facing proxy and differs only by any
    // force-sent surplus, immaterial for this informational copy.
    const fastMode =
        activationThreshold !== undefined && liveBid !== undefined
            ? liveBid < activationThreshold
            : undefined;
    const moverText =
        activationThreshold === undefined || fastMode === undefined
            ? 'Trade fees pool at the LiveBidAdapter, then sweep into the live bid an eligible Punk owner can accept.'
            : fastMode
              ? `Below the activation threshold (${formatEth(activationThreshold)}), a sweep fills the live bid fast: uncapped, up to the threshold (the launch warm-up).`
              : `Above the activation threshold (${formatEth(activationThreshold)}), a sweep adds at most ${maxSweepWei !== undefined ? formatEth(maxSweepWei) : '…'} at a time, then waits out a short cooldown.`;

    const [tx, setTx] = useState<
        | {kind: 'idle'}
        | {kind: 'awaiting-signature'}
        | {kind: 'confirming'; hash: Hash}
        | {kind: 'success'; hash?: Hash}
        | {kind: 'failed'; hash?: Hash; message: string}
    >({kind: 'idle'});

    const onSweep = useCallback(async () => {
        if (!address || !wallet || !pub) return;
        const {liveBidAdapter} = getContractAddresses();

        // One sweep, one prompt. The bid adapter is the only fee leg that funds
        // the live bid — `LiveBidAdapter.sweep()` meters its buffer into Patron
        // and pays the caller the keeper reward. The protocol leg lives in a
        // separate adapter that sweeps to PCController, so it's never part of
        // this drain.
        try {
            setTx({kind: 'awaiting-signature'});
            const hash = await wallet.writeContract({
                address: liveBidAdapter,
                abi: liveBidAdapterAbi,
                functionName: 'sweep',
                args: [],
            });
            setTx({kind: 'confirming', hash});
            const receipt = await pub.waitForTransactionReceipt({hash});
            if (receipt.status !== 'success') {
                setTx({kind: 'failed', hash, message: 'Sweep reverted on-chain.'});
                return;
            }
            setTx({kind: 'success', hash});
            void refetch();
        } catch (e: unknown) {
            const message = walletErrorMessage(e) ?? 'Unknown error';
            setTx({
                kind: 'failed',
                message: isUserRejection(e) ? 'You declined in your wallet.' : message,
            });
        }
    }, [address, wallet, pub, refetch]);

    // Auto-clear the inline success/failed status after a few seconds so the
    // row settles back to its quiet state.
    useEffect(() => {
        if (tx.kind !== 'success' && tx.kind !== 'failed') return;
        const t = setTimeout(() => setTx({kind: 'idle'}), 7_000);
        return () => clearTimeout(t);
    }, [tx]);

    const hasPending = (pending ?? 0n) > 0n;
    const isWorking = tx.kind === 'awaiting-signature' || tx.kind === 'confirming';

    // Hide the whole mover when there's nothing to sweep — keeps the trade
    // stats row uncluttered. Exception: stay visible during/after the
    // viewer's own sweep so the "Swept." / "Confirm…" / "Sweeping…" state
    // remains legible even though the sweep itself drained `pending` to 0.
    // The auto-clear effect on `tx` flips it back to `idle` after a few
    // seconds, at which point the mover collapses.
    const showMover = hasPending || tx.kind !== 'idle';
    if (!showMover) return null;

    return (
        <aside className="live-bid-mover" aria-label="Pending vs. live bid">
            <div className="live-bid-mover-explain">
                <span className="live-bid-mover-key">Pending → live</span>
                <span className="live-bid-mover-text">{moverText}</span>
            </div>
            <div className="live-bid-mover-action">
                {hasPending ? (
                    <button
                        type="button"
                        className="live-bid-mover-btn"
                        onClick={onSweep}
                        disabled={!address || isWorking}
                        title={
                            !address
                                ? 'Connect a wallet to sweep'
                                : 'Move pending fees into the live bid (permissionless; small keeper reward)'
                        }
                    >
                        {tx.kind === 'awaiting-signature'
                            ? 'Confirm…'
                            : tx.kind === 'confirming'
                              ? 'Sweeping…'
                              : '↓ Sweep now'}
                    </button>
                ) : null}
                {tx.kind === 'confirming' && tx.hash && (
                    <a
                        className="live-bid-mover-tx"
                        href={getEvmNowTxUrl(tx.hash, chainId)}
                        target="_blank"
                        rel="noreferrer"
                    >
                        view tx
                    </a>
                )}
                {tx.kind === 'success' && (
                    <span className="live-bid-mover-ok">
                        ✓ Swept
                        {tx.hash && (
                            <>
                                {' · '}
                                <a
                                    className="live-bid-mover-tx"
                                    href={getEvmNowTxUrl(tx.hash, chainId)}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    view tx
                                </a>
                            </>
                        )}
                    </span>
                )}
                {tx.kind === 'failed' && (
                    <span className="live-bid-mover-err" title={tx.message}>
                        {tx.message.length > 48
                            ? `${tx.message.slice(0, 48)}…`
                            : tx.message}
                    </span>
                )}
            </div>
            <style>{moverStyles}</style>
        </aside>
    );
}

const moverStyles = `
.live-bid-mover {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 16px;
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
    background: transparent;
}
.live-bid-mover-explain {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
}
.live-bid-mover-key {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink);
}
.live-bid-mover-text {
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1.45;
    color: var(--muted);
    letter-spacing: 0.01em;
}
.live-bid-mover-action {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
}
.live-bid-mover-btn {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    background: var(--ink);
    color: var(--bg);
    border: 1px solid var(--ink);
    padding: 6px 12px;
    cursor: pointer;
    transition: opacity 120ms ease, background 120ms ease;
    white-space: nowrap;
}
.live-bid-mover-btn:hover:not(:disabled) {
    background: var(--accent);
    border-color: var(--accent);
}
.live-bid-mover-btn:disabled {
    cursor: not-allowed;
    opacity: 0.45;
}
.live-bid-mover-empty {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    opacity: 0.7;
    white-space: nowrap;
}
.live-bid-mover-tx {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
.live-bid-mover-ok {
    font-family: var(--mono);
    font-size: 10px;
    color: #2a8a3e;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}
.live-bid-mover-err {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--danger);
    line-height: 1.4;
}
@media (max-width: 600px) {
    .live-bid-mover {
        flex-direction: column;
        align-items: flex-start;
        gap: 10px;
        padding: 12px 14px;
    }
    .live-bid-mover-action {
        width: 100%;
        justify-content: flex-start;
    }
}
`;

const styles = `
.live-bid-wrap {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
}
.live-bid-wrap.is-stale .live-bid-value {
    opacity: 0.7;
}
.live-bid-value {
    display: inline-block;
}
.live-bid-delta {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.02em;
    color: #fff;
    background: #2a8a3e;
    padding: 2px 7px;
    line-height: 1.4;
    animation: live-bid-delta-in 280ms ease-out, live-bid-delta-out 600ms 1900ms ease-in forwards;
    white-space: nowrap;
}
/* The "fees in flight" counter under the live bid. Quiet and persistent —
 * it represents accrued fees that will drip into the headline on the next
 * sweep, not a transient affordance. Rendered as a block so it falls onto
 * its own line under the live-bid line. */
.live-bid-pending {
    display: block;
    margin-top: 4px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--muted);
    opacity: 0.85;
    white-space: nowrap;
}
@keyframes live-bid-delta-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.9); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes live-bid-delta-out {
    from { opacity: 1; transform: translateY(0); }
    to   { opacity: 0; transform: translateY(-4px); }
}
`;
