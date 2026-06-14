'use client';

/**
 * ReferralClaim — connected-wallet referrer dashboard.
 *
 * Under the fresh-only per-swap settlement, a referrer's credit lands in
 * `ReferralPayout.balances` within the SAME tx as the attributed swap.
 * The hook holds nothing between swaps — a failed forward folds into the
 * protocol escrow (not a recoverable referrer balance) — so there is no
 * flush step. The dashboard is simply the claimable ledger balance plus a
 * claim button.
 *
 * Surfaces:
 *  - The user's ledger balance: `referralPayout.balances(referrer)` —
 *    sourced from the Ponder indexer's `Referrer.balance` (populated by
 *    the `ReferralCredited` / `ReferralClaimed` handlers) via
 *    `/api/referral?address=X`. No per-tab chain reads.
 *  - A "Claim" button — calls `referralPayout.claim()` (or any caller can
 *    pull via `claimFor(referrer)`).
 *
 * RPC posture: all reads go through the cached `/api/referral` endpoint
 * (server-side `unstable_cache` keyed by address, 30s revalidate). The
 * connected wallet's own claim POSTs the cache-bust below so the user
 * sees their post-claim state immediately. N viewers per referrer
 * collapse to ~1 read per cache window upstream.
 */

import {useCallback, useEffect, useMemo, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {useAccount, useChainId, usePublicClient, useWalletClient} from 'wagmi';

import {abi as referralPayoutAbi} from '@/lib/abis/ReferralPayout';
import {ConnectButton} from './ConnectButton';
import {ReferralShare} from './ReferralShare';
import {getChainId, getContractAddresses} from '@/lib/config';
import {formatEthBare, getEvmNowAddressUrl, getEvmNowTxUrl, shortAddress} from '@/lib/format';

type TxState =
    | {kind: 'idle'}
    | {kind: 'awaiting-signature'}
    | {kind: 'confirming'; hash: `0x${string}`}
    | {kind: 'success'; hash: `0x${string}`}
    | {kind: 'failed'; hash?: `0x${string}`; message: string};

function classifyError(e: unknown): string {
    if (e instanceof Error) {
        // viem's error chain carries the real revert reason in
        // `shortMessage` or nested `cause`. Walk it.
        const walk = (err: unknown, depth = 0): string | null => {
            if (depth > 5 || !err) return null;
            if (err instanceof Error) {
                const anyErr = err as Error & {
                    shortMessage?: string;
                    cause?: unknown;
                };
                if (anyErr.shortMessage) return anyErr.shortMessage;
                return walk(anyErr.cause, depth + 1);
            }
            return null;
        };
        return walk(e) ?? e.message;
    }
    return 'Unknown error';
}

export function ReferralClaim() {
    const {address, isConnected} = useAccount();
    const chainId = useChainId();
    const expectedChainId = getChainId();
    const onWrongNetwork = isConnected && chainId !== expectedChainId;

    const pub = usePublicClient({chainId: expectedChainId});
    const {data: wallet} = useWalletClient();

    const addrs = useMemo(() => getContractAddresses(), []);
    const referralPayoutAddr = addrs.referralPayout;

    // ── Reads ─────────────────────────────────────────────────────
    // Single cached endpoint serves the ledger balance (indexer-sourced).
    // Per cache window: 1 GraphQL hit regardless of viewer count. The
    // connected wallet's own claim POSTs the cache-bust below.
    const statusQuery = useQuery({
        queryKey: ['referral-status', address?.toLowerCase()],
        queryFn: async () => {
            const res = await fetch(`/api/referral?address=${address}`, {cache: 'no-store'});
            if (!res.ok) throw new Error(`referral: HTTP ${res.status}`);
            const json = (await res.json()) as {
                balance: string;
                totalCredited: string;
                totalClaimed: string;
            };
            return {
                balance: BigInt(json.balance),
                totalCredited: BigInt(json.totalCredited),
                totalClaimed: BigInt(json.totalClaimed),
            };
        },
        enabled: Boolean(address) && Boolean(referralPayoutAddr),
        refetchInterval: 60_000,
        staleTime: 30_000,
    });
    const owedInLedger = statusQuery.data?.balance ?? 0n;

    // Optional cosmetic vanity slug for this address (operator-curated).
    // Cached on the edge; absent for most addresses. Surfaced in the share
    // widget alongside the raw `?ref=` link.
    const slugQuery = useQuery({
        queryKey: ['referral-slug', address?.toLowerCase()],
        queryFn: async () => {
            const res = await fetch(`/api/referral-alias?address=${address}`);
            if (!res.ok) return null;
            const json = (await res.json()) as {slug: string | null};
            return json.slug ?? null;
        },
        enabled: Boolean(address),
        staleTime: 5 * 60_000,
    });

    // Used by the post-claim success path to bust the shared cache + pull
    // a fresh response so the user sees their post-claim state immediately
    // rather than waiting out the 30s server TTL.
    const refetchStatus = useCallback(async () => {
        try {
            await fetch('/api/referral', {method: 'POST'});
        } catch {
            // Best-effort; the next interval poll will reconcile.
        }
        return statusQuery.refetch();
    }, [statusQuery]);

    // ── Writes ────────────────────────────────────────────────────
    const [claimTx, setClaimTx] = useState<TxState>({kind: 'idle'});

    const onClaim = useCallback(async () => {
        if (!address || !wallet || !pub || !referralPayoutAddr) return;
        setClaimTx({kind: 'awaiting-signature'});
        try {
            const hash = await wallet.writeContract({
                address: referralPayoutAddr,
                abi: referralPayoutAbi,
                functionName: 'claim',
                args: [],
            });
            setClaimTx({kind: 'confirming', hash});
            const receipt = await pub.waitForTransactionReceipt({hash});
            if (receipt.status === 'success') {
                setClaimTx({kind: 'success', hash});
                void refetchStatus();
            } else {
                setClaimTx({kind: 'failed', hash, message: 'Transaction reverted on-chain.'});
            }
        } catch (e: unknown) {
            setClaimTx({kind: 'failed', message: classifyError(e)});
        }
    }, [address, wallet, pub, referralPayoutAddr, refetchStatus]);

    // Auto-reset the inline status line a few seconds after success so the
    // panel stays clean for a follow-up action.
    useEffect(() => {
        if (claimTx.kind !== 'success') return;
        const t = setTimeout(() => setClaimTx({kind: 'idle'}), 8_000);
        return () => clearTimeout(t);
    }, [claimTx]);

    if (!referralPayoutAddr) {
        return (
            <div className="referral-card">
                <p className="referral-empty">
                    Referral payouts go live with the launch broadcast. This page will
                    light up once the contract is deployed. Until then, the
                    attribution still encodes correctly on swaps — it&apos;s just that
                    no credits accrue yet.
                </p>
                <style jsx>{`
                    .referral-card {
                        border: 1px solid var(--line);
                        background: var(--panel);
                        padding: 24px;
                        margin-top: 24px;
                    }
                    .referral-empty {
                        color: var(--muted);
                        font-size: 14px;
                        margin: 0;
                    }
                `}</style>
            </div>
        );
    }

    if (!isConnected) {
        return (
            <div className="referral-card">
                <p className="referral-empty">
                    Connect a wallet to see your accrual + claim earnings.
                </p>
                <ConnectButton />
                <style jsx>{`
                    .referral-card {
                        border: 1px solid var(--line);
                        background: var(--panel);
                        padding: 24px;
                        margin-top: 24px;
                        display: flex;
                        flex-direction: column;
                        gap: 16px;
                    }
                    .referral-empty {
                        color: var(--muted);
                        font-size: 14px;
                        margin: 0;
                    }
                `}</style>
            </div>
        );
    }

    if (onWrongNetwork) {
        return (
            <div className="referral-card">
                <p className="referral-empty">Switch to the correct network to continue.</p>
                <ConnectButton />
                <style jsx>{`
                    .referral-card {
                        border: 1px solid var(--line);
                        background: var(--panel);
                        padding: 24px;
                        margin-top: 24px;
                        display: flex;
                        flex-direction: column;
                        gap: 16px;
                    }
                    .referral-empty {
                        color: var(--muted);
                        font-size: 14px;
                        margin: 0;
                    }
                `}</style>
            </div>
        );
    }

    const refLine = address ? shortAddress(address) : '—';
    const refUrl = address ? getEvmNowAddressUrl(address, expectedChainId) : '#';

    const claimBusy =
        claimTx.kind === 'awaiting-signature' || claimTx.kind === 'confirming';

    return (
        <div className="referral-card">
            <div className="referral-row">
                <span className="referral-label">Your address</span>
                <a
                    href={refUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="referral-value tnum"
                >
                    {refLine}
                </a>
            </div>

            <div className="referral-row">
                <div className="referral-amount">
                    <span className="referral-label">Ready to claim</span>
                    <span className="referral-amount-value tnum">
                        {formatEthBare(owedInLedger, 6)} ETH
                    </span>
                </div>
                <button
                    type="button"
                    className="referral-btn referral-btn-primary"
                    onClick={() => void onClaim()}
                    disabled={owedInLedger === 0n || claimBusy}
                >
                    {claimBusy
                        ? claimTx.kind === 'awaiting-signature'
                            ? 'Confirm in wallet…'
                            : 'Confirming…'
                        : 'Claim ETH'}
                </button>
            </div>
            <p className="referral-hint">
                Credits land in your claimable balance the same tx as the attributed
                swap — no separate flush step.
            </p>
            {claimTx.kind === 'failed' && (
                <p className="referral-error">{claimTx.message}</p>
            )}
            {claimTx.kind === 'success' && (
                <p className="referral-success">
                    Claimed.{' '}
                    <a
                        href={getEvmNowTxUrl(claimTx.hash, expectedChainId)}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        View tx →
                    </a>
                </p>
            )}

            <div className="referral-share">
                <ReferralShare referrer={address} slug={slugQuery.data ?? undefined} />
            </div>

            <style jsx>{`
                .referral-card {
                    border: 1px solid var(--line);
                    background: var(--panel);
                    padding: 24px;
                    display: flex;
                    flex-direction: column;
                    gap: 18px;
                    margin-top: 24px;
                }
                .referral-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 16px;
                }
                .referral-amount {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .referral-amount-value {
                    font-size: 24px;
                    color: var(--ink);
                }
                .referral-label {
                    font-family: var(--mono);
                    font-size: 11px;
                    color: var(--muted);
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                }
                .referral-value {
                    color: var(--ink);
                    text-decoration: none;
                    border-bottom: 1px dotted var(--muted);
                }
                .referral-btn {
                    border: 1px solid var(--line);
                    background: transparent;
                    color: var(--ink);
                    padding: 10px 16px;
                    font-family: var(--mono);
                    font-size: 12px;
                    cursor: pointer;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                }
                .referral-btn:hover:not(:disabled) {
                    background: var(--ink);
                    color: var(--bg);
                }
                .referral-btn:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                }
                .referral-btn-primary {
                    background: var(--ink);
                    color: var(--bg);
                    border-color: var(--ink);
                }
                .referral-btn-primary:hover:not(:disabled) {
                    background: var(--accent);
                    border-color: var(--accent);
                }
                .referral-error {
                    color: #c44;
                    font-size: 12px;
                    font-family: var(--mono);
                    margin: 0;
                }
                .referral-success {
                    color: #2a8a3e;
                    font-size: 12px;
                    font-family: var(--mono);
                    margin: 0;
                }
                .referral-success a {
                    color: inherit;
                    text-decoration: underline;
                }
                .referral-share {
                    border-top: 1px solid var(--line);
                    padding-top: 16px;
                }
                .referral-empty {
                    color: var(--muted);
                    font-size: 14px;
                    margin: 0 0 16px;
                }
                .referral-hint {
                    color: var(--muted);
                    font-size: 12px;
                    font-family: var(--mono);
                    margin: -8px 0 0;
                    line-height: 1.5;
                }
            `}</style>
        </div>
    );
}
