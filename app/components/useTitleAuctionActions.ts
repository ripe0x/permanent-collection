'use client';

/* Wallet-facing actions for the vault Title Auction (PunkVaultTitleAuction).
   Covers the four non-bid state-changing entry points:

     - kickoff()                       (permissionless; one-shot)
     - settle()                        (permissionless; cleared OR no-bid restart)
     - withdrawProceeds(address)       (anyone may pull credited recipient)
     - withdrawRefund()                (msg.sender pulls their own refund)

   Bids go through `TitleBidPanel` directly (the shared BidComposer wraps
   the wallet write).

   Receipt waiting: `settle()` only moves the Title ERC721 + credits a pull
   queue — no CryptoPunks market interaction. The mock connector's quirks
   that bit AcceptBounty (where the canonical Punks market doesn't run a
   custom `receive`) don't apply here. Plain `waitForTransactionReceipt`
   is sufficient. */

import {useCallback, useState} from 'react';
import type {Address, Hash} from 'viem';
import {useAccount, usePublicClient, useWalletClient} from 'wagmi';
import {abi as PunkVaultTitleAuctionAbi} from '@/lib/abis/PunkVaultTitleAuction';

export type ActionKind = 'kickoff' | 'settle' | 'withdrawProceeds' | 'withdrawRefund';

export type ActionPhase =
    | {kind: 'idle'}
    | {kind: 'wallet'; action: ActionKind}
    | {kind: 'submitted'; action: ActionKind; hash: Hash}
    | {kind: 'confirming'; action: ActionKind; hash: Hash}
    | {kind: 'success'; action: ActionKind; hash: Hash}
    | {kind: 'rejected'; action: ActionKind; message: string}
    | {kind: 'failed'; action: ActionKind; hash?: Hash; message: string};

export function useTitleAuctionActions(titleAuction: Address | undefined) {
    const {address} = useAccount();
    const {data: wallet} = useWalletClient();
    const pub = usePublicClient();
    const [phase, setPhase] = useState<ActionPhase>({kind: 'idle'});

    const run = useCallback(
        async (action: ActionKind, runWrite: () => Promise<Hash>) => {
            if (!wallet || !address || !pub || !titleAuction) return;
            setPhase({kind: 'wallet', action});
            let hash: Hash;
            try {
                hash = await runWrite();
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                setPhase({
                    kind: 'rejected',
                    action,
                    message: /user rejected|user denied/i.test(msg)
                        ? 'You declined in your wallet.'
                        : msg,
                });
                return;
            }
            setPhase({kind: 'submitted', action, hash});
            try {
                setPhase({kind: 'confirming', action, hash});
                const r = await pub.waitForTransactionReceipt({hash});
                if (r.status === 'success') {
                    setPhase({kind: 'success', action, hash});
                } else {
                    setPhase({kind: 'failed', action, hash, message: 'Transaction reverted.'});
                }
            } catch (e) {
                setPhase({
                    kind: 'failed',
                    action,
                    hash,
                    message: e instanceof Error ? e.message : String(e),
                });
            }
        },
        [wallet, address, pub, titleAuction],
    );

    const kickoff = useCallback(async () => {
        if (!wallet || !address || !titleAuction) return;
        await run('kickoff', () =>
            wallet.writeContract({
                abi: PunkVaultTitleAuctionAbi,
                address: titleAuction,
                functionName: 'kickoff',
                args: [],
                account: address as Address,
                chain: wallet.chain,
            }),
        );
    }, [wallet, address, titleAuction, run]);

    const settle = useCallback(async () => {
        if (!wallet || !address || !titleAuction) return;
        await run('settle', () =>
            wallet.writeContract({
                abi: PunkVaultTitleAuctionAbi,
                address: titleAuction,
                functionName: 'settle',
                args: [],
                account: address as Address,
                chain: wallet.chain,
            }),
        );
    }, [wallet, address, titleAuction, run]);

    const withdrawProceeds = useCallback(
        async (recipient: Address) => {
            if (!wallet || !address || !titleAuction) return;
            await run('withdrawProceeds', () =>
                wallet.writeContract({
                    abi: PunkVaultTitleAuctionAbi,
                    address: titleAuction,
                    functionName: 'withdrawProceeds',
                    args: [recipient],
                    account: address as Address,
                    chain: wallet.chain,
                }),
            );
        },
        [wallet, address, titleAuction, run],
    );

    const withdrawRefund = useCallback(async () => {
        if (!wallet || !address || !titleAuction) return;
        await run('withdrawRefund', () =>
            wallet.writeContract({
                abi: PunkVaultTitleAuctionAbi,
                address: titleAuction,
                functionName: 'withdrawRefund',
                args: [],
                account: address as Address,
                chain: wallet.chain,
            }),
        );
    }, [wallet, address, titleAuction, run]);

    const reset = useCallback(() => setPhase({kind: 'idle'}), []);

    return {
        phase,
        connected: !!address,
        kickoff,
        settle,
        withdrawProceeds,
        withdrawRefund,
        reset,
    };
}
