'use client';

/* "Add to the bid": anyone can send ETH straight to the LiveBidAdapter's
   receive(), fueling the live bid for every eligible Punk owner. The adapter
   is the single inflow governor: Patron's receive() is adapter-only, so a
   bare top-up routes through the adapter, which meters it into the live bid.
   Small, low-friction, single tx. */

import {useCallback, useEffect, useState} from 'react';
import {parseEther, type Hash} from 'viem';
import {useAccount, useChainId, usePublicClient, useWalletClient} from 'wagmi';
import {ConnectButton} from './ConnectButton';
import {getContractAddresses} from '@/lib/config';
import {formatEth, getEvmNowTxUrl} from '@/lib/format';

type Phase =
    | {kind: 'idle'}
    | {kind: 'open'}
    | {kind: 'wallet'}
    | {kind: 'submitted'; hash: Hash}
    | {kind: 'confirming'; hash: Hash}
    | {kind: 'success'; hash: Hash; amountWei: bigint}
    | {kind: 'rejected'; message: string}
    | {kind: 'failed'; hash?: Hash; message: string};

export function TopUpButton({className = 'secondary'}: {className?: string}) {
    const {address} = useAccount();
    const chainId = useChainId();
    const pub = usePublicClient();
    const {data: wallet} = useWalletClient();
    const [phase, setPhase] = useState<Phase>({kind: 'idle'});
    const [amount, setAmount] = useState('0.1');

    const submit = useCallback(async () => {
        if (!wallet || !address) return;
        let value: bigint;
        try {
            value = parseEther(amount.trim());
        } catch {
            setPhase({kind: 'rejected', message: 'Enter a valid ETH amount.'});
            return;
        }
        if (value === 0n) {
            setPhase({kind: 'rejected', message: 'Amount must be > 0.'});
            return;
        }
        const {liveBidAdapter} = getContractAddresses();
        setPhase({kind: 'wallet'});
        try {
            const hash = await wallet.sendTransaction({
                to: liveBidAdapter,
                value,
                account: address,
                chain: wallet.chain,
            });
            // Go straight to 'confirming' so the receipt watcher effect
            // doesn't get torn down by the submitted→confirming transition
            // it used to trigger from inside itself. See issue #26 and the
            // matching AcceptBidFlow watcher for the full writeup.
            setPhase({kind: 'confirming', hash});
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setPhase({
                kind: 'rejected',
                message: /user rejected|user denied/i.test(msg)
                    ? 'You declined in your wallet.'
                    : /insufficient funds/i.test(msg)
                      ? 'Not enough ETH for amount + gas.'
                      : msg,
            });
        }
    }, [wallet, address, amount]);

    // Receipt watcher. Narrow dep array on purpose — kind→kind transitions
    // the effect causes must not re-fire the effect, or the cleanup tears
    // down the in-flight await before its `.then` can commit (issue #26).
    const phaseHash = phase.kind === 'confirming' ? phase.hash : undefined;
    useEffect(() => {
        if (!phaseHash || !pub) return;
        const hash = phaseHash;
        let cancelled = false;
        // Snapshot the amount AT WATCH TIME, not inside the effect closure.
        // We don't depend on `amount` directly because the user can keep
        // editing the input while a previous top-up is still confirming —
        // we want the success badge to reflect what they signed, not what's
        // in the input now.
        const amountWei = (() => {
            try {
                return parseEther(amount.trim());
            } catch {
                return 0n;
            }
        })();
        pub.waitForTransactionReceipt({hash})
            .then((r) => {
                if (cancelled) return;
                if (r.status === 'success') setPhase({kind: 'success', hash, amountWei});
                else setPhase({kind: 'failed', hash, message: 'Top-up reverted on-chain.'});
            })
            .catch((e) => {
                if (cancelled) return;
                setPhase({kind: 'failed', hash, message: e instanceof Error ? e.message : String(e)});
            });
        return () => {
            cancelled = true;
        };
        // `amount` is intentionally snapshotted at watch-time, not part of
        // deps — see comment above the effect body.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phaseHash, pub]);

    if (phase.kind === 'idle') {
        return (
            <>
                <button type="button" className={className} onClick={() => setPhase({kind: 'open'})}>
                    Add to the bid
                </button>
                <style>{styles}</style>
            </>
        );
    }

    return (
        <div
            className="topup-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="topup-title"
            onClick={(e) => {
                if (e.target === e.currentTarget && (phase.kind === 'open' || phase.kind === 'rejected')) {
                    setPhase({kind: 'idle'});
                }
            }}
        >
            <div className="topup-card">
                <h2 id="topup-title">Add to the bid.</h2>
                <p className="topup-copy">
                    Anyone can fuel the bid. Your ETH goes straight to the protocol pool and raises the offer to
                    every eligible Punk owner. There is no return path — once the bid is accepted, the ETH leaves
                    the pool.
                </p>
                <div className="topup-input">
                    <label htmlFor="topup-amount">Amount (ETH)</label>
                    <input
                        id="topup-amount"
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        disabled={phase.kind === 'wallet' || phase.kind === 'submitted' || phase.kind === 'confirming'}
                        placeholder="0.1"
                    />
                </div>
                <div className="topup-actions">
                    <button
                        type="button"
                        className="secondary"
                        onClick={() => setPhase({kind: 'idle'})}
                        disabled={phase.kind === 'wallet' || phase.kind === 'submitted' || phase.kind === 'confirming'}
                    >
                        Cancel
                    </button>
                    {address ? (
                        <button
                            type="button"
                            className="primary"
                            onClick={submit}
                            disabled={phase.kind === 'wallet' || phase.kind === 'submitted' || phase.kind === 'confirming'}
                        >
                            {phaseButton(phase)}
                        </button>
                    ) : (
                        <ConnectButton />
                    )}
                </div>
                <div className="topup-state" aria-live="polite">
                    {phase.kind === 'submitted' && <Line>Submitted. <TxLink hash={phase.hash} chainId={chainId} /></Line>}
                    {phase.kind === 'confirming' && <Line>Confirming on-chain… <TxLink hash={phase.hash} chainId={chainId} /></Line>}
                    {phase.kind === 'success' && (
                        <Line>
                            Thanks. {formatEth(phase.amountWei)} added to the bid. <TxLink hash={phase.hash} chainId={chainId} />
                        </Line>
                    )}
                    {phase.kind === 'rejected' && <span className="error">{phase.message}</span>}
                    {phase.kind === 'failed' && (
                        <span className="error">
                            {phase.message} {phase.hash && <TxLink hash={phase.hash} chainId={chainId} />}
                        </span>
                    )}
                </div>
            </div>
            <style>{styles}</style>
        </div>
    );
}

function phaseButton(p: Phase): string {
    switch (p.kind) {
        case 'wallet':
            return 'Confirm in wallet…';
        case 'submitted':
            return 'Submitting…';
        case 'confirming':
            return 'Confirming…';
        case 'success':
            return 'Done';
        case 'rejected':
        case 'failed':
            return 'Try again';
        default:
            return 'Send';
    }
}

function Line({children}: {children: React.ReactNode}) {
    return <span>{children}</span>;
}

function TxLink({hash, chainId}: {hash: Hash; chainId: number}) {
    return (
        <a className="tx-link" href={getEvmNowTxUrl(hash, chainId)} target="_blank" rel="noreferrer">
            view tx
        </a>
    );
}

const styles = `
.topup-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.62);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    padding: var(--pad);
}
.topup-card {
    background: var(--bg);
    border: 1px solid var(--ink);
    max-width: 520px;
    padding: clamp(28px, 4vw, 44px);
    display: flex;
    flex-direction: column;
    gap: 20px;
}
.topup-card h2 {
    font-family: var(--serif);
    font-size: clamp(26px, 3.4vw, 36px);
    font-weight: 300;
    letter-spacing: -0.035em;
    line-height: 1.05;
}
.topup-copy {
    font-family: var(--sans);
    font-size: 14px;
    color: var(--muted);
    line-height: 1.6;
}
.topup-input {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.topup-input label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.topup-input input {
    font-family: var(--mono);
    font-size: 20px;
    padding: 12px 16px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--ink);
}
.topup-input input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-color: var(--accent);
}
.topup-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}
.topup-state {
    min-height: 22px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.topup-state .error {
    color: var(--accent);
}
.tx-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
`;
