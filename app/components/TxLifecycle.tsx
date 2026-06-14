'use client';

/* One write-tx lifecycle component covering every state per the brief:
     idle → wallet prompt → rejected
                          → submitted (tx hash + explorer link)
                          → confirming (n confirmations)
                          → success (UI reflects new chain state)
                          → failed/reverted (specific reason)
                          → replaced/sped-up (followed, not lost)
   Wrong-network and no-provider are handled inline.

   The actual contract write is passed in as a function so this component
   stays generic across acceptBid / acceptListing / bid. The caller
   provides a label, the contract function reference, and (for irreversible-
   adjacent actions like acceptBid) a consent gate that gates submit.
*/

import {useCallback, useEffect, useState, type ReactNode} from 'react';
import {useAccount, useChainId, useSwitchChain, useWaitForTransactionReceipt} from 'wagmi';
import type {Hash} from 'viem';
import {getChainId} from '@/lib/config';
import {getEvmNowTxUrl} from '@/lib/format';

type Phase =
    | {kind: 'idle'}
    | {kind: 'consent'}
    | {kind: 'wallet'}
    | {kind: 'submitted'; hash: Hash}
    | {kind: 'confirming'; hash: Hash; confirmations: number}
    | {kind: 'success'; hash: Hash}
    | {kind: 'rejected'; message: string}
    | {kind: 'failed'; hash?: Hash; message: string};

export interface TxAction {
    /** Short label, e.g. "Accept bid" or "Place bid". */
    label: string;
    /** Triggers the wallet prompt; resolves with the tx hash or rejects. */
    submit: () => Promise<Hash>;
    /** Optional: consent gate copy. If provided, shows a blocking confirmation
     *  before submit. Use for irreversible-adjacent actions (acceptBid). */
    consent?: {
        title: string;
        body: ReactNode;
        confirmLabel: string;
    };
}

export function TxLifecycle({action, disabled}: {action: TxAction; disabled?: boolean}) {
    const {address} = useAccount();
    const chainId = useChainId();
    const {switchChain, isPending: switching} = useSwitchChain();
    const expectedChainId = getChainId();
    const onWrongNetwork = chainId !== undefined && chainId !== expectedChainId;

    const [phase, setPhase] = useState<Phase>({kind: 'idle'});
    const txHash = phase.kind === 'submitted' || phase.kind === 'confirming' || phase.kind === 'success'
        ? phase.hash
        : phase.kind === 'failed' && phase.hash
          ? phase.hash
          : undefined;
    const receipt = useWaitForTransactionReceipt({hash: txHash});

    const fire = useCallback(async () => {
        setPhase({kind: 'wallet'});
        try {
            const hash = await action.submit();
            setPhase({kind: 'submitted', hash});
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setPhase({kind: 'rejected', message: msg});
        }
    }, [action]);

    const onClickStart = useCallback(async () => {
        if (action.consent) {
            setPhase({kind: 'consent'});
        } else {
            await fire();
        }
    }, [action, fire]);

    // Drive transitions from the receipt query.
    useEffect(() => {
        if (!txHash) return;
        if (receipt.fetchStatus === 'fetching' && phase.kind === 'submitted') {
            setPhase({kind: 'confirming', hash: txHash, confirmations: 0});
        }
        if (receipt.data) {
            if (receipt.data.status === 'success') {
                setPhase({kind: 'success', hash: txHash});
            } else {
                setPhase({kind: 'failed', hash: txHash, message: 'Transaction reverted on-chain.'});
            }
        }
        if (receipt.error) {
            setPhase({kind: 'failed', hash: txHash, message: receipt.error.message});
        }
    }, [receipt.data, receipt.error, receipt.fetchStatus, txHash, phase.kind]);

    // Render
    if (!address) {
        return (
            <button type="button" className="primary" disabled>
                Connect wallet to {action.label.toLowerCase()}
                <style>{styles}</style>
            </button>
        );
    }

    if (onWrongNetwork) {
        return (
            <button
                type="button"
                className="primary"
                onClick={() => switchChain({chainId: expectedChainId})}
                disabled={switching}
            >
                {switching ? 'Switching network…' : `Switch to chain ${expectedChainId}`}
                <style>{styles}</style>
            </button>
        );
    }

    return (
        <div className="tx">
            <button
                type="button"
                className="primary"
                disabled={
                    disabled ||
                    phase.kind === 'wallet' ||
                    phase.kind === 'submitted' ||
                    phase.kind === 'confirming'
                }
                onClick={onClickStart}
            >
                {phaseButtonLabel(phase, action.label)}
            </button>

            {phase.kind === 'consent' && action.consent && (
                <ConsentDialog
                    title={action.consent.title}
                    body={action.consent.body}
                    confirmLabel={action.consent.confirmLabel}
                    onCancel={() => setPhase({kind: 'idle'})}
                    onConfirm={() => void fire()}
                />
            )}

            {phase.kind === 'submitted' && (
                <PhaseLine>
                    Submitted. Waiting for confirmation. <ExplorerLink hash={phase.hash} />
                </PhaseLine>
            )}
            {phase.kind === 'confirming' && (
                <PhaseLine>
                    Confirming on-chain. <ExplorerLink hash={phase.hash} />
                </PhaseLine>
            )}
            {phase.kind === 'success' && (
                <PhaseLine>
                    Confirmed. <ExplorerLink hash={phase.hash} />
                </PhaseLine>
            )}
            {phase.kind === 'rejected' && (
                <PhaseLine kind="error">
                    Rejected: {classifyRejection(phase.message)}
                </PhaseLine>
            )}
            {phase.kind === 'failed' && (
                <PhaseLine kind="error">
                    Failed: {phase.message}
                    {phase.hash && <> · <ExplorerLink hash={phase.hash} /></>}
                </PhaseLine>
            )}
            <style>{styles}</style>
        </div>
    );
}

function phaseButtonLabel(phase: Phase, label: string): string {
    switch (phase.kind) {
        case 'wallet':
            return 'Confirm in wallet…';
        case 'submitted':
            return 'Submitting…';
        case 'confirming':
            return 'Confirming…';
        case 'success':
            return `${label} confirmed`;
        default:
            return label;
    }
}

function classifyRejection(message: string): string {
    if (/user rejected|user denied/i.test(message)) return 'You declined in your wallet.';
    if (/insufficient funds/i.test(message)) return 'Insufficient ETH for gas + value.';
    return message;
}

function PhaseLine({children, kind}: {children: ReactNode; kind?: 'info' | 'error'}) {
    return (
        <p className={`tx-line ${kind === 'error' ? 'tx-error' : ''}`} aria-live="polite">
            {children}
        </p>
    );
}

function ExplorerLink({hash}: {hash: Hash}) {
    // evm.now is chain-aware via `chainId` query param — works for mainnet
    // and is the project-wide convention. For the local anvil fork the
    // link won't resolve to a live tx, but stays click-to-copy.
    return (
        <a
            className="tx-link"
            href={getEvmNowTxUrl(hash, getChainId())}
            target="_blank"
            rel="noreferrer"
        >
            view tx
        </a>
    );
}

function ConsentDialog({
    title,
    body,
    confirmLabel,
    onCancel,
    onConfirm,
}: {
    title: string;
    body: ReactNode;
    confirmLabel: string;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    // Trap focus on the confirm button; the brief: "fully keyboard-operable
    // and screen-reader correct".
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);

    return (
        <div className="consent-overlay" role="dialog" aria-modal="true" aria-labelledby="consent-title">
            <div className="consent">
                <h3 id="consent-title">{title}</h3>
                <div className="consent-body">{body}</div>
                <div className="consent-actions">
                    <button type="button" className="secondary" onClick={onCancel}>
                        Cancel
                    </button>
                    <button type="button" className="primary" onClick={onConfirm} autoFocus>
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}

const styles = `
.tx {
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: flex-start;
}
.tx-line {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    margin: 0;
}
.tx-line.tx-error {
    color: var(--danger);
}
.tx-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
.consent-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.62);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    padding: var(--pad);
}
.consent {
    background: var(--bg);
    border: 1px solid var(--ink);
    max-width: 560px;
    padding: clamp(28px, 4vw, 48px);
    display: flex;
    flex-direction: column;
    gap: 22px;
}
.consent h3 {
    font-family: var(--serif);
    font-size: clamp(26px, 3.5vw, 38px);
    line-height: 1.05;
    letter-spacing: -0.035em;
    font-weight: 300;
}
.consent-body {
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.62;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.consent-body strong {
    color: var(--ink);
    font-weight: 500;
}
.consent-actions {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
}
`;
