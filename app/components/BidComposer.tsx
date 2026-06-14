'use client';

/* Shared bid composer: input + quick-add chips + submit + state machine + tx
   link. Reused by `PlaceBidPanel` (return auction flavor) and `TitleBidPanel`
   (vault Title Auction flavor). The caller injects the actual write call
   via `onSubmit` — the composer doesn't know which contract it's hitting,
   only the wei amount.

   Visual variants:
     - `card`   — bordered aside, sticky in the detail-page layout.
     - `inline` — flat, sits inside its own panel (homepage / banner). */

import {useCallback, useEffect, useState, type ReactNode} from 'react';
import {parseEther, type Hash, type WalletClient} from 'viem';
import {useAccount, useChainId, usePublicClient, useWalletClient} from 'wagmi';
import {ConnectButton} from './ConnectButton';
import {ceilWeiToDecimals, formatEth, formatEthBare, getEvmNowTxUrl} from '@/lib/format';
import type {Address} from '@/lib/data/types';

// `awaitingReceipt` collapses the old "submitted" + "confirming" split into
// one state. The previous shape transitioned submitted → confirming inside
// the receipt-wait effect via setPhase, which — because `phase` was in the
// effect's dep array — re-ran the effect and fired the cleanup *before* the
// receipt Promise resolved. The cleanup set a closure-scoped `cancelled =
// true`, so when the receipt finally arrived the `.then` short-circuited:
// `setPhase('success')` never fired and the caller's `onSuccess` callback
// (used by `TitleBidPanel` / `PlaceBidPanel` to bust their cached bid
// histories) was silently dropped.
type Phase =
    | {kind: 'idle'}
    | {kind: 'wallet'}
    | {kind: 'awaitingReceipt'; hash: Hash}
    | {kind: 'success'; hash: Hash}
    | {kind: 'rejected'; message: string}
    | {kind: 'failed'; hash?: Hash; message: string};

export interface BidComposerProps {
    /** Minimum acceptable bid in wei. Used for the default input value, the
     *  inline error, and the chip baselines. Pass 0 if no high bid exists
     *  yet (Title Auction allows any non-zero first bid). */
    minNextBidWei: bigint;
    /** Hides input + chips and shows the "Closed." message. */
    closed: boolean;
    /** Copy shown when `closed`. */
    closedMessage?: string;
    /** Suffix appended to the input id to avoid duplicates when two
     *  composers share the same page (homepage banner + detail view). */
    inputIdSuffix: string;
    /** Wallet write call. The composer hands the user's wallet + address +
     *  parsed amount; the caller decides which contract method to invoke
     *  and returns the tx hash. */
    onSubmit: (params: {
        wallet: WalletClient;
        address: Address;
        amount: bigint;
    }) => Promise<Hash>;
    /** Top-level kicker label (e.g. "place a bid" / "bid on title"). */
    kickerLabel?: string;
    /** Replaces the standard "Bids in the final 15 minutes…" fineprint. */
    fineprint?: ReactNode;
    /** Optional secondary fineprint (e.g. reserve callout). */
    fineprintExtra?: ReactNode;
    /** `card` = bordered aside (default), `inline` = flat. */
    variant?: 'card' | 'inline';
    /** When true, the success state shows a one-line "you're the high
     *  bidder" message specific to your context. */
    successMessage?: string;
    /** Fired once the tx receipt confirms `status === 'success'`. Used by
     *  PlaceBidPanel to bust the shared `/api/auction-bids` cache so the
     *  bidder sees their own bid land in the history immediately instead
     *  of waiting out the TTL. Best-effort — failures are swallowed. */
    onSuccess?: (hash: Hash) => void;
}

export function BidComposer({
    minNextBidWei,
    closed,
    closedMessage = 'The bidding window is closed. Settlement is the next step, and anyone can call it.',
    inputIdSuffix,
    onSubmit,
    kickerLabel = 'place a bid',
    fineprint,
    fineprintExtra,
    variant = 'card',
    successMessage = "You're the high bidder.",
    onSuccess,
}: BidComposerProps) {
    const {address} = useAccount();
    const chainId = useChainId();
    const pub = usePublicClient();
    const {data: wallet} = useWalletClient();
    // The on-chain floor (return-auction reserve, or the +1% increment over the
    // current high bid) at full wei precision. `formatEth` truncates to 3
    // decimals, so seeding the input straight from `minNextBidWei` would render
    // a value BELOW the floor that parses back below it — leaving the submit
    // button disabled on the very amount the UI presents as "min". Round the
    // DISPLAYED minimum up to display precision so every affordance (default
    // value, "min" chip, the "min …" label) is an amount the contract accepts;
    // validity below still checks the exact wei floor.
    const displayMinWei = minNextBidWei > 0n ? ceilWeiToDecimals(minNextBidWei) : 0n;
    const initialInput = displayMinWei > 0n ? formatEthBare(displayMinWei) : '0.01';
    const [amount, setAmount] = useState(initialInput);
    const [phase, setPhase] = useState<Phase>({kind: 'idle'});

    const parsed = (() => {
        try {
            const v = parseEther(amount.trim());
            return v;
        } catch {
            return null;
        }
    })();
    // For Title Auction's "any non-zero first bid" rule, minNextBidWei = 0
    // and any parsed > 0 is valid. For a return auction, minNextBidWei > 0
    // sets the floor.
    const tooLow =
        parsed !== null && (minNextBidWei > 0n ? parsed < minNextBidWei : parsed === 0n);
    const valid = parsed !== null && !tooLow;
    const className = variant === 'inline' ? 'bid-panel bid-panel--inline' : 'bid-panel';

    const submit = useCallback(async () => {
        if (!wallet || !address || parsed === null) return;
        setPhase({kind: 'wallet'});
        try {
            const hash = await onSubmit({
                wallet,
                address: address as Address,
                amount: parsed,
            });
            setPhase({kind: 'awaitingReceipt', hash});
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setPhase({
                kind: 'rejected',
                message: /user rejected|user denied/i.test(msg)
                    ? 'You declined in your wallet.'
                    : /insufficient funds/i.test(msg)
                      ? 'Not enough ETH for bid + gas.'
                      : msg,
            });
        }
    }, [wallet, address, parsed, onSubmit]);

    // Receipt-wait. Effect deps narrow to the hash we're waiting on so a
    // phase change (e.g. cancelling after a tx submit) doesn't re-fire the
    // effect and accidentally cancel the in-flight wait. The cleanup still
    // runs on unmount or when a new submit kicks off a different hash.
    const awaitingHash = phase.kind === 'awaitingReceipt' ? phase.hash : null;
    useEffect(() => {
        if (!awaitingHash || !pub) return;
        let cancelled = false;
        pub.waitForTransactionReceipt({hash: awaitingHash})
            .then((r) => {
                if (cancelled) return;
                if (r.status === 'success') {
                    setPhase({kind: 'success', hash: awaitingHash});
                    try {
                        onSuccess?.(awaitingHash);
                    } catch {
                        // Caller-side errors mustn't blank the success UI.
                    }
                } else
                    setPhase({kind: 'failed', hash: awaitingHash, message: 'Bid reverted on-chain.'});
            })
            .catch((e) => {
                if (cancelled) return;
                setPhase({
                    kind: 'failed',
                    hash: awaitingHash,
                    message: e instanceof Error ? e.message : String(e),
                });
            });
        return () => {
            cancelled = true;
        };
    }, [awaitingHash, pub, onSuccess]);

    if (closed) {
        return (
            <aside className={className} aria-label="Bid panel closed">
                <h3 className="bid-panel-title">Closed.</h3>
                <p className="bid-panel-copy">{closedMessage}</p>
                <style>{styles}</style>
            </aside>
        );
    }

    // Chips build off the display-rounded minimum and are themselves ceiled to
    // display precision, so each round-trips exactly through formatEth ->
    // parseEther — the "selected" highlight (parsed === q.wei) lands, and every
    // chip stays at or above the true wei floor.
    const minPositive = displayMinWei > 0n ? displayMinWei : parseEther('0.01');
    const quickAdds: {label: string; wei: bigint}[] = [
        {label: 'min', wei: minPositive},
        {label: '+5%', wei: ceilWeiToDecimals((minPositive * 105n) / 100n)},
        {label: '+10%', wei: ceilWeiToDecimals((minPositive * 110n) / 100n)},
        {label: '+25%', wei: ceilWeiToDecimals((minPositive * 125n) / 100n)},
    ];

    const defaultFineprint =
        'Bids in the final 15 minutes extend the deadline by 1 hour.';

    return (
        <aside className={className} aria-label="Place a bid">
            <div className="bid-panel-head">
                <span className="bid-panel-kicker">{kickerLabel}</span>
                <span className="bid-panel-min tnum" aria-label="Minimum next bid">
                    {displayMinWei > 0n ? `min ${formatEth(displayMinWei)}` : 'no min'}
                </span>
            </div>
            <div className="bid-input">
                <label htmlFor={`bid-amount-${inputIdSuffix}`} className="bid-input-label">
                    Your bid
                </label>
                <input
                    id={`bid-amount-${inputIdSuffix}`}
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder={formatEthBare(minPositive)}
                    disabled={
                        phase.kind === 'wallet' || phase.kind === 'awaitingReceipt'
                    }
                />
                <span className="bid-input-unit">ETH</span>
            </div>
            <div className="bid-chips" role="group" aria-label="Quick-bid amounts">
                {quickAdds.map((q) => (
                    <button
                        key={q.label}
                        type="button"
                        className={`bid-chip ${
                            parsed !== null && parsed === q.wei ? 'bid-chip-on' : ''
                        }`}
                        onClick={() => setAmount(formatEthBare(q.wei))}
                    >
                        {q.label}
                        <span className="bid-chip-value tnum">{formatEthBare(q.wei)}</span>
                    </button>
                ))}
            </div>
            <button
                type="button"
                className="primary bid-submit"
                onClick={submit}
                disabled={
                    !valid ||
                    !address ||
                    phase.kind === 'wallet' ||
                    phase.kind === 'awaitingReceipt'
                }
            >
                {phaseButton(phase)}
            </button>
            <div className="bid-state" aria-live="polite">
                {tooLow && minNextBidWei > 0n && (
                    <span className="bid-error">
                        Below the minimum ({formatEth(displayMinWei)}).
                    </span>
                )}
                {tooLow && minNextBidWei === 0n && (
                    <span className="bid-error">Enter an amount greater than zero.</span>
                )}
                {!address && (
                    <span className="bid-connect">
                        Connect a wallet to bid. <ConnectButton />
                    </span>
                )}
                {phase.kind === 'awaitingReceipt' && (
                    <span>
                        Confirming on-chain… <TxLink hash={phase.hash} chainId={chainId} />
                    </span>
                )}
                {phase.kind === 'success' && (
                    <span>
                        {successMessage} <TxLink hash={phase.hash} chainId={chainId} />
                    </span>
                )}
                {phase.kind === 'rejected' && (
                    <span className="bid-error">{phase.message}</span>
                )}
                {phase.kind === 'failed' && (
                    <span className="bid-error">
                        {phase.message}{' '}
                        {phase.hash && <TxLink hash={phase.hash} chainId={chainId} />}
                    </span>
                )}
            </div>
            <p className="bid-fineprint">{fineprint ?? defaultFineprint}</p>
            {fineprintExtra && (
                <p className="bid-fineprint bid-fineprint-quiet">{fineprintExtra}</p>
            )}
            <style>{styles}</style>
        </aside>
    );
}

function phaseButton(p: Phase): string {
    switch (p.kind) {
        case 'wallet':
            return 'Confirm in wallet…';
        case 'awaitingReceipt':
            return 'Confirming…';
        case 'success':
            return 'Confirmed';
        case 'rejected':
        case 'failed':
            return 'Retry bid';
        default:
            return 'Place bid';
    }
}

function TxLink({hash, chainId}: {hash: Hash; chainId: number}) {
    return (
        <a
            className="tx-link"
            href={getEvmNowTxUrl(hash, chainId)}
            target="_blank"
            rel="noreferrer"
        >
            view tx
        </a>
    );
}

const styles = `
.bid-panel {
    border: 1px solid var(--ink);
    padding: clamp(20px, 2.8vw, 28px);
    display: flex;
    flex-direction: column;
    gap: 14px;
    position: sticky;
    top: 78px;
    background: var(--bg);
}
.bid-panel--inline {
    border: none;
    padding: 0;
    position: static;
    background: transparent;
}
.bid-panel-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
}
.bid-panel-kicker {
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--muted);
}
.bid-panel-min {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.bid-input {
    position: relative;
    display: flex;
    align-items: stretch;
}
.bid-input input {
    flex: 1;
    width: 100%;
    font-family: var(--mono);
    font-size: 22px;
    padding: 16px 64px 16px 16px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--ink);
}
.bid-input input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-color: var(--accent);
}
.bid-input-unit {
    position: absolute;
    right: 14px;
    top: 50%;
    transform: translateY(-50%);
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    pointer-events: none;
    letter-spacing: 0.08em;
}
.bid-input-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
}
.bid-chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}
.bid-chip {
    flex: 1 1 0;
    min-width: 70px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--ink);
    cursor: pointer;
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    transition: border-color 100ms ease, background 100ms ease;
}
.bid-chip:hover {
    border-color: var(--accent);
}
.bid-chip-on {
    border-color: var(--ink);
    background: var(--panel);
}
.bid-chip-value {
    font-size: 13px;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
}
.bid-submit {
    width: 100%;
    padding: 14px 18px;
    font-family: var(--mono);
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
}
.bid-state {
    min-height: 22px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
}
.bid-connect {
    display: inline-flex;
    align-items: center;
    gap: 10px;
}
.bid-error {
    color: var(--accent);
}
.bid-fineprint {
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.55;
    color: var(--muted);
    margin: 4px 0 0;
}
.bid-fineprint-quiet {
    font-size: 11px;
    opacity: 0.75;
}
.bid-panel-title {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 300;
    letter-spacing: -0.02em;
    margin: 0 0 4px;
}
.bid-panel-copy {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0;
}
.tx-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
`;
