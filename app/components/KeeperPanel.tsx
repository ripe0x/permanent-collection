'use client';

/**
 * KeeperPanel — execute a station's permissionless keeper call from the
 * /debug/distribution dashboard.
 *
 * Several pipeline stations only move value downstream when a keeper pokes
 * them: LiveBidAdapter.sweep(), ProtocolFeePhaseAdapter.sweep(),
 * BuybackBurner.executeStep(0), ReturnAuctionModule.settle(punkId). The
 * server snapshot tags those stations with a `keeper` descriptor; this
 * client island renders one button per action and sends the tx with the
 * connected wallet.
 *
 * Args arrive as decimal strings (no bigint crosses the RSC boundary) and
 * are widened back to bigint here — viem accepts bigint for uint16/uint256
 * alike. On success we `router.refresh()` so the server component re-reads
 * balances + the settleable set and the page reflects the moved ETH.
 */

import {useCallback, useState} from 'react';
import {useRouter} from 'next/navigation';
import {useAccount, useChainId, usePublicClient, useWalletClient} from 'wagmi';

import {KEEPER_ABIS, type KeeperContract} from '@/lib/keeper/targets';
import {ConnectButton} from './ConnectButton';
import {getChainId} from '@/lib/config';
import {getEvmNowTxUrl} from '@/lib/format';

export interface KeeperActionDTO {
    contract: KeeperContract;
    address: `0x${string}`;
    functionName: string;
    args: string[];
    label: string;
    actionable: boolean;
}

type TxState =
    | {kind: 'idle'}
    | {kind: 'pending'; key: string; phase: 'sign' | 'confirm'; hash?: `0x${string}`}
    | {kind: 'success'; key: string; hash: `0x${string}`}
    | {kind: 'failed'; key: string; message: string; hash?: `0x${string}`};

function classifyError(e: unknown): string {
    if (e instanceof Error) {
        const walk = (err: unknown, depth = 0): string | null => {
            if (depth > 5 || !err) return null;
            if (err instanceof Error) {
                const anyErr = err as Error & {shortMessage?: string; cause?: unknown};
                if (anyErr.shortMessage) return anyErr.shortMessage;
                return walk(anyErr.cause, depth + 1);
            }
            return null;
        };
        return walk(e) ?? e.message;
    }
    return 'Unknown error';
}

const keyOf = (a: KeeperActionDTO) => `${a.address}:${a.functionName}:${a.args.join(',')}`;

export function KeeperPanel({hint, actions}: {hint: string; actions: KeeperActionDTO[]}) {
    const {isConnected} = useAccount();
    const chainId = useChainId();
    const expectedChainId = getChainId();
    const onWrongNetwork = isConnected && chainId !== expectedChainId;

    const pub = usePublicClient({chainId: expectedChainId});
    const {data: wallet} = useWalletClient();
    const router = useRouter();

    const [tx, setTx] = useState<TxState>({kind: 'idle'});
    const busy = tx.kind === 'pending';

    const run = useCallback(
        async (action: KeeperActionDTO) => {
            if (!wallet || !pub) return;
            const key = keyOf(action);
            setTx({kind: 'pending', key, phase: 'sign'});
            try {
                const hash = await wallet.writeContract({
                    address: action.address,
                    abi: KEEPER_ABIS[action.contract],
                    functionName: action.functionName,
                    args: action.args.map((a) => BigInt(a)),
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any);
                setTx({kind: 'pending', key, phase: 'confirm', hash});
                const receipt = await pub.waitForTransactionReceipt({hash});
                if (receipt.status === 'success') {
                    setTx({kind: 'success', key, hash});
                    // Re-read the server snapshot so balances + the settleable
                    // set reflect the value we just moved.
                    router.refresh();
                } else {
                    setTx({kind: 'failed', key, hash, message: 'Transaction reverted on-chain.'});
                }
            } catch (e: unknown) {
                setTx({kind: 'failed', key, message: classifyError(e)});
            }
        },
        [wallet, pub, router],
    );

    const canSend = isConnected && !onWrongNetwork && Boolean(wallet);

    return (
        <div className="kp">
            <p className="kp-hint">{hint}</p>

            {actions.length === 0 ? (
                <p className="kp-none">Nothing to run right now.</p>
            ) : (
                <div className="kp-actions">
                    {actions.map((a) => {
                        const key = keyOf(a);
                        const isThis = tx.kind !== 'idle' && tx.key === key;
                        const thisPending = isThis && tx.kind === 'pending';
                        const label = thisPending
                            ? tx.phase === 'sign'
                                ? 'Confirm in wallet…'
                                : 'Confirming…'
                            : a.label;
                        return (
                            <button
                                key={key}
                                type="button"
                                className={`kp-btn${a.actionable ? ' is-ready' : ''}`}
                                disabled={!canSend || !a.actionable || busy}
                                title={
                                    !canSend
                                        ? 'Connect a wallet on the right network to run'
                                        : !a.actionable
                                          ? 'Nothing to do (empty / on cooldown)'
                                          : undefined
                                }
                                onClick={() => void run(a)}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            )}

            {(!isConnected || onWrongNetwork) && actions.length > 0 && (
                <div className="kp-connect">
                    <ConnectButton />
                </div>
            )}

            {tx.kind === 'failed' && <p className="kp-error">{tx.message}</p>}
            {tx.kind === 'success' && (
                <p className="kp-success">
                    Done.{' '}
                    <a
                        href={getEvmNowTxUrl(tx.hash, expectedChainId)}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        View tx →
                    </a>
                </p>
            )}

            <style jsx>{`
                .kp {
                    border-top: 1px solid var(--line);
                    padding-top: 10px;
                    margin-top: 2px;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .kp-hint {
                    margin: 0;
                    font-family: var(--mono);
                    font-size: 11px;
                    line-height: 1.5;
                    color: var(--muted);
                }
                .kp-actions {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                }
                .kp-btn {
                    border: 1px solid var(--line);
                    background: transparent;
                    color: var(--ink);
                    padding: 7px 12px;
                    font-family: var(--mono);
                    font-size: 11px;
                    letter-spacing: 0.04em;
                    text-transform: uppercase;
                    cursor: pointer;
                }
                .kp-btn.is-ready {
                    border-color: var(--accent);
                    color: var(--accent);
                }
                .kp-btn:hover:not(:disabled) {
                    background: var(--accent);
                    border-color: var(--accent);
                    color: var(--bg);
                }
                .kp-btn:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                }
                .kp-none {
                    margin: 0;
                    font-family: var(--mono);
                    font-size: 11px;
                    color: var(--muted);
                }
                .kp-connect {
                    margin-top: 2px;
                }
                .kp-error {
                    margin: 0;
                    font-family: var(--mono);
                    font-size: 11px;
                    color: #c44;
                    word-break: break-word;
                }
                .kp-success {
                    margin: 0;
                    font-family: var(--mono);
                    font-size: 11px;
                    color: var(--accent);
                }
                .kp-success a {
                    color: inherit;
                    text-decoration: underline;
                }
            `}</style>
        </div>
    );
}
