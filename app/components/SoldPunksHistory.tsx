'use client';

/* "Your sold Punks" + claim section for the /bid page.
 *
 * Closes a real gap: after accepting the bid, the proceeds sit in the 2017
 * CryptoPunks market under `pendingWithdrawals[seller]` (the protocol never
 * pushes ETH — the seller pulls it with `market.withdraw()`). The in-flow
 * AcceptBidFlow surfaces that only within the live session; reload the page and
 * the Claim step is gone. This component reads the wallet's withdrawable
 * balance directly from the market on every load, so the claim is always
 * reachable, and lists the wallet's accepted-bid history (Punk, amount, date,
 * tx) from `/api/sold-by`.
 *
 * The withdraw is a SINGLE aggregate balance — the 2017 market pools all of a
 * seller's proceeds into one `pendingWithdrawals` slot, so it's one Withdraw
 * button for the total, not per-Punk. */

import {useCallback, useEffect, useState} from 'react';
import {type Hash} from 'viem';
import {useAccount, useChainId, usePublicClient, useWalletClient} from 'wagmi';

import {abi as CryptoPunksMarketAbi} from '@/lib/abis/CryptoPunksMarket';
import {getContractAddresses} from '@/lib/config';
import {formatEth, formatEthBare, formatPunk, formatRelative, getEvmNowTxUrl} from '@/lib/format';

/** Pull the most useful message out of a viem/wallet error (shortMessage,
 *  else the cause chain, else the raw message). */
function errMessage(e: unknown): string {
    const a = e as {shortMessage?: string; message?: string; cause?: unknown} | undefined;
    if (a?.shortMessage) return a.shortMessage;
    if (/user rejected|user denied/i.test(a?.message ?? '')) return 'You declined in your wallet.';
    return a?.message ?? 'Withdraw failed.';
}

interface SoldRow {
    punkId: number;
    amountWei: string;
    blockNumber: string;
    timestamp: string;
    txHash: Hash;
}

type ClaimTx =
    | {kind: 'idle'}
    | {kind: 'wallet'}
    | {kind: 'confirming'; hash: Hash}
    | {kind: 'success'; hash: Hash}
    | {kind: 'failed'; message: string};

export function SoldPunksHistory() {
    const {address} = useAccount();
    const chainId = useChainId();
    const pub = usePublicClient();
    const {data: wallet} = useWalletClient();

    const [sold, setSold] = useState<SoldRow[] | null>(null);
    const [pending, setPending] = useState<bigint | null>(null);
    const [claimTx, setClaimTx] = useState<ClaimTx>({kind: 'idle'});

    // Withdrawable balance — read straight from the market so it survives a
    // reload (no dependence on the accept flow's in-session state).
    const refreshPending = useCallback(async () => {
        if (!pub || !address) {
            setPending(null);
            return;
        }
        try {
            const p = (await pub.readContract({
                address: getContractAddresses().punksMarket,
                abi: CryptoPunksMarketAbi,
                functionName: 'pendingWithdrawals',
                args: [address],
            })) as bigint;
            setPending(p);
        } catch {
            // Leave prior value; the section degrades to history-only.
        }
    }, [pub, address]);

    useEffect(() => {
        void refreshPending();
    }, [refreshPending]);

    // Accepted-bid history for this wallet.
    useEffect(() => {
        if (!address) {
            setSold(null);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(`/api/sold-by?seller=${address}`, {cache: 'no-store'});
                if (!res.ok) return;
                const json = (await res.json()) as {sold?: SoldRow[]};
                if (!cancelled) setSold(json.sold ?? []);
            } catch {
                if (!cancelled) setSold([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [address]);

    const onWithdraw = useCallback(async () => {
        if (!wallet || !address || !pub) return;
        setClaimTx({kind: 'wallet'});
        try {
            const hash = await wallet.writeContract({
                address: getContractAddresses().punksMarket,
                abi: CryptoPunksMarketAbi,
                functionName: 'withdraw',
                args: [],
                account: address,
                chain: wallet.chain,
            });
            setClaimTx({kind: 'confirming', hash});
            const receipt = await pub.waitForTransactionReceipt({hash});
            if (receipt.status === 'success') {
                setClaimTx({kind: 'success', hash});
                void refreshPending();
            } else {
                setClaimTx({kind: 'failed', message: 'Withdraw reverted on-chain.'});
            }
        } catch (e) {
            setClaimTx({kind: 'failed', message: errMessage(e)});
        }
    }, [wallet, address, pub, refreshPending]);

    // Nothing to show until a wallet is connected.
    if (!address) return null;
    // No history and nothing to claim → stay out of the way.
    const hasClaim = pending !== null && pending > 0n;
    const hasHistory = sold !== null && sold.length > 0;
    if (!hasClaim && !hasHistory) return null;

    const isWorking = claimTx.kind === 'wallet' || claimTx.kind === 'confirming';

    return (
        <section className="sold-history" aria-label="Your sold Punks">
            <div className="sold-history-head">
                <h2 className="sold-history-title">Punks you&apos;ve sold</h2>
                {hasClaim && (
                    <div className="sold-claim">
                        <span className="sold-claim-amount tnum">
                            {formatEth(pending)} to claim
                        </span>
                        <button
                            type="button"
                            className="sold-claim-btn"
                            onClick={onWithdraw}
                            disabled={isWorking}
                            title="Withdraw your proceeds from the CryptoPunks market"
                        >
                            {claimTx.kind === 'wallet'
                                ? 'Confirm…'
                                : claimTx.kind === 'confirming'
                                  ? 'Withdrawing…'
                                  : `Withdraw ${formatEthBare(pending)} ETH`}
                        </button>
                    </div>
                )}
            </div>

            {claimTx.kind === 'success' && (
                <p className="sold-claim-ok">
                    ✓ Withdrawn{' '}
                    <a
                        href={getEvmNowTxUrl(claimTx.hash, chainId)}
                        target="_blank"
                        rel="noreferrer"
                    >
                        view tx
                    </a>
                </p>
            )}
            {claimTx.kind === 'failed' && <p className="sold-claim-err">{claimTx.message}</p>}

            {hasHistory ? (
                <table className="sold-table">
                    <thead>
                        <tr>
                            <th>Punk</th>
                            <th>Sold for</th>
                            <th>When</th>
                            <th>Tx</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sold!.map((r) => (
                            <tr key={r.txHash}>
                                <td>{formatPunk(r.punkId)}</td>
                                <td className="tnum">{formatEth(BigInt(r.amountWei))}</td>
                                <td>{formatRelative(BigInt(r.timestamp))}</td>
                                <td>
                                    <a
                                        href={getEvmNowTxUrl(r.txHash, chainId)}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        view
                                    </a>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                hasClaim && (
                    <p className="sold-history-note">
                        You have proceeds to withdraw from the CryptoPunks market.
                    </p>
                )
            )}

            <style>{styles}</style>
        </section>
    );
}

const styles = `
.sold-history {
    margin-top: clamp(40px, 6vh, 72px);
    padding-top: 28px;
    border-top: 1px solid var(--line);
}
.sold-history-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 18px;
    flex-wrap: wrap;
    margin-bottom: 16px;
}
.sold-history-title {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink);
    margin: 0;
}
.sold-claim {
    display: flex;
    align-items: center;
    gap: 12px;
}
.sold-claim-amount {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.sold-claim-btn {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    background: var(--ink);
    color: var(--bg);
    border: none;
    padding: 8px 14px;
    cursor: pointer;
}
.sold-claim-btn:disabled {
    opacity: 0.6;
    cursor: default;
}
.sold-claim-ok,
.sold-claim-err {
    font-family: var(--mono);
    font-size: 11px;
    margin: 0 0 12px;
}
.sold-claim-err {
    color: var(--ink);
}
.sold-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: 12px;
}
.sold-table th {
    text-align: left;
    font-weight: 400;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 10px;
    padding: 6px 12px 6px 0;
    border-bottom: 1px solid var(--line);
}
.sold-table td {
    padding: 8px 12px 8px 0;
    border-bottom: 1px solid var(--line);
    color: var(--ink);
}
.sold-history-note {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    margin: 0;
}
`;
