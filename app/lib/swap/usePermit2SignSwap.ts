'use client';

import {useCallback, useRef, useState} from 'react';
import {
    useAccount,
    useConfig,
    usePublicClient,
    useSignTypedData,
    useSwitchChain,
} from 'wagmi';
import {getWalletClient} from 'wagmi/actions';
import {mainnet} from 'wagmi/chains';
import {encodeFunctionData, erc20Abi, maxUint256, type Address, type Chain, type Hash} from 'viem';

import {abi as universalRouterAbi} from '@/lib/abis/UniversalRouter';
import {abi as permit2Abi} from '@/lib/abis/Permit2';
import {getV4Infrastructure} from '@/lib/config';
import {anvilFork} from '@/lib/wagmi';
import {
    buildBuyCalldata,
    buildSellCalldata,
    MAX_UINT160,
    PERMIT2_TYPES,
    permit2Domain,
    type PermitSingle,
} from './v4-calldata';
import {chainDeadlineBaseSeconds} from './chainTime';

import type {EngineState, SwapEngine} from './types';

const PERMIT_EXPIRATION_SECS = 30 * 86400; // 30 days
const PERMIT_SIG_DEADLINE_SECS = 30 * 60; // 30 minutes

const ONE_GWEI = 1_000_000_000n;
const PRIORITY_FEE = ONE_GWEI; // 1 gwei tip
// Hard ceiling so a base-fee read spike can't authorize an absurd max.
const MAX_FEE_CAP = 100n * ONE_GWEI; // 100 gwei
// Floor so the explicit fees still clear a near-empty mempool / fresh fork.
const MAX_FEE_FLOOR = 3n * ONE_GWEI; // 3 gwei

/**
 * Compute EIP-1559 fees grounded in the LIVE base fee instead of a flat
 * worst-case ceiling.
 *
 * Why this matters for the balance check, not just cost: a wallet reserves
 * `gas × maxFeePerGas` against the account balance during its pre-flight —
 * the MAX the user authorizes, not the realistic cost at the current base
 * fee. A flat `maxFeePerGas = 100 gwei` with `gas = 3M` reserves 0.3 ETH of
 * phantom headroom, so a 0.3-ETH buy from a 0.5-ETH wallet trips "total cost
 * exceeds balance" even though the real gas cost is ~0.003 ETH. Tracking the
 * live base fee keeps that reservation proportional (e.g. 2 gwei base →
 * ~5 gwei max → ~0.015 ETH reserved on a 3M-gas tx).
 *
 * We still pass fees EXPLICITLY (the original rationale): some wallets/viem
 * auto-estimates hand back `maxFee == priority`, leaving no base-fee headroom
 * so the tx never crosses the inclusion threshold (anvil silently queues it).
 * maxFee = 2 × baseFee + priority gives a full block of base-fee headroom,
 * clamped to [3, 100] gwei.
 */
async function computeFees(
    client: {getBlock: (a: {blockTag: 'latest'}) => Promise<{baseFeePerGas: bigint | null}>},
): Promise<{maxFeePerGas: bigint; maxPriorityFeePerGas: bigint}> {
    let baseFee = 0n;
    try {
        const block = await client.getBlock({blockTag: 'latest'});
        baseFee = block.baseFeePerGas ?? 0n;
    } catch {
        // Fall through to the floor — better an explicit modest fee than none.
    }
    let maxFeePerGas = baseFee * 2n + PRIORITY_FEE;
    if (maxFeePerGas < MAX_FEE_FLOOR) maxFeePerGas = MAX_FEE_FLOOR;
    if (maxFeePerGas > MAX_FEE_CAP) maxFeePerGas = MAX_FEE_CAP;
    return {maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE};
}

/**
 * Resolve a viem `Chain` object so we can pass it explicitly to
 * `sendTransaction`. Without this, some wallet clients receive
 * `chain: undefined (id: …)` and respond with a phantom 4001 / "User
 * rejected" without ever showing a popup.
 */
function chainFromId(chainId: number): Chain | undefined {
    if (chainId === 1) return mainnet;
    if (chainId === 31_337) return anvilFork;
    return undefined;
}

/**
 * Surface viem's full error chain instead of the truncated top-level message.
 *
 * viem wraps each layer (ContractFunctionExecutionError → CallExecutionError
 * → RpcRequestError → underlying provider error). The interesting bits — the
 * actual revert reason, RPC error code, signed payload — live in
 * `shortMessage`, `metaMessages`, and the `cause` chain. Walk the chain and
 * stitch them together so a "User rejected the request" wrapper doesn't hide
 * a real underlying revert.
 *
 * Pattern carried over from the artcoins production debugger and called out
 * in the user's global CLAUDE.md as the canonical way to read viem errors.
 */
function formatViemError(e: unknown): string {
    const parts: string[] = [];
    let cur: unknown = e;
    let depth = 0;
    while (cur && depth < 6) {
        if (cur instanceof Error) {
            const a = cur as Error & {
                shortMessage?: string;
                metaMessages?: string[];
                details?: string;
                cause?: unknown;
            };
            const short = a.shortMessage ?? cur.message ?? '';
            if (short) parts.push(short);
            if (a.metaMessages?.length) parts.push(...a.metaMessages);
            if (a.details) parts.push(a.details);
            cur = a.cause;
        } else {
            parts.push(String(cur));
            break;
        }
        depth++;
    }
    const out: string[] = [];
    for (const p of parts) {
        if (out[out.length - 1] !== p) out.push(p);
    }
    return out.join('\n').slice(0, 2500);
}

function classifyTopLevel(msg: string): string {
    if (/user rejected|user denied/i.test(msg)) return 'You declined in your wallet.';
    if (/insufficient funds/i.test(msg)) return 'Not enough ETH for amount + gas.';
    return msg;
}

interface Options {
    chainId: number;
}

/**
 * Single-engine swap hook for the native-ETH-paired 111 V4 pool.
 *
 * Buy:  one tx. UR commands = [V4_SWAP]. ETH sent via msg.value.
 * Sell: one signature + one tx. UR commands = [PERMIT2_PERMIT, V4_SWAP].
 *       Token contract grants infinite ERC20→Permit2 allowance (Solady
 *       default), so no `token.approve` is ever needed.
 */
export function usePermit2SignSwap({chainId}: Options): SwapEngine {
    const {address} = useAccount();
    const client = usePublicClient({chainId});
    // Fetch wallet client IMPERATIVELY inside `execute()` rather than via
    // `useWalletClient()`. The hook race-conditions across chain-switch
    // transitions: at the moment the user clicks swap, the hook may
    // still be carrying the old chain's client (or undefined while the
    // switch is in flight), and we'd surface a misleading
    // "Wallet client unavailable" error. Imperative get-after-switch
    // is bullet-proof — we ask the connector for a client tied to the
    // chain we KNOW we just landed on.
    const config = useConfig();
    const {switchChainAsync} = useSwitchChain();
    const v4 = getV4Infrastructure();
    const targetChain = chainFromId(chainId);

    const {signTypedDataAsync} = useSignTypedData();

    const [state, setState] = useState<EngineState>('idle');
    const [statusLabel, setStatusLabel] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [txHash, setTxHash] = useState<Hash | null>(null);

    const stableAddress = useRef<Address | undefined>(undefined);
    stableAddress.current = address;

    const execute = useCallback<SwapEngine['execute']>(
        async (params) => {
            const user = stableAddress.current;
            if (!user) {
                setState('error');
                setError('Wallet not connected');
                return;
            }
            if (!client) {
                setState('error');
                setError('No RPC client');
                return;
            }
            if (!targetChain) {
                setState('error');
                setError(`Unsupported chain: ${chainId}`);
                return;
            }

            setError(null);
            setTxHash(null);

            let walletClient: Awaited<ReturnType<typeof getWalletClient>>;
            try {
                // Land on the right chain first. wagmi's switchChainAsync
                // is a no-op if already there; on mismatch it dispatches
                // wallet_switchEthereumChain (with add-chain fallback)
                // and waits for the wallet to confirm. After this
                // resolves, the connector's provider is guaranteed to be
                // on `chainId`, so the wallet client we fetch next is
                // tied to the right chain.
                await switchChainAsync({chainId});
                walletClient = await getWalletClient(config, {chainId});
            } catch (e: unknown) {
                setState('error');
                const formatted = formatViemError(e);
                setError(`Couldn't reach the wallet on chain ${chainId}: ${classifyTopLevel(formatted)}`);
                return;
            }
            if (!walletClient) {
                setState('error');
                setError(`Wallet client unavailable for chain ${chainId} — open your wallet, confirm it's connected, and retry.`);
                return;
            }

            try {

                let commands: `0x${string}`;
                let inputs: `0x${string}`[];
                let value: bigint;

                if (params.isBuy) {
                    ({commands, inputs, value} = buildBuyCalldata({
                        poolKey: params.poolKey,
                        tokenIsToken0: params.tokenIsToken0,
                        token: params.token,
                        ethAmount: params.amountIn,
                        minTokenOut: params.minOut,
                        hookData: params.hookData,
                    }));
                    setState('awaiting-tx');
                    setStatusLabel('Confirm in wallet…');
                } else {
                    // Sell — read live Permit2 nonce, sign permit, submit.
                    setState('preparing');
                    setStatusLabel('Reading nonce…');

                    // Defensive: ensure token grants Permit2 transferFrom. The 111
                    // token inherits Solady's ERC20, which auto-grants infinite
                    // ERC20 → Permit2 allowance, so this read returns max and the
                    // approve below is skipped. The branch exists in case the
                    // factory ever ships a non-Solady base (the Permit2 swap
                    // would otherwise revert silently at SETTLE_ALL).
                    const tokenAllowance = (await client.readContract({
                        address: params.token,
                        abi: erc20Abi,
                        functionName: 'allowance',
                        args: [user, v4.permit2],
                    })) as bigint;
                    if (tokenAllowance < params.amountIn) {
                        setStatusLabel('Approving token…');
                        const approveTx = await walletClient.sendTransaction({
                            chain: targetChain,
                            account: user,
                            to: params.token,
                            data: encodeFunctionData({
                                abi: erc20Abi,
                                functionName: 'approve',
                                args: [v4.permit2, maxUint256],
                            }),
                            gas: 100_000n,
                            // Same EIP-1559 explicit-fees rationale as the
                            // swap tx below — protects against
                            // `maxFee == priority` wallets/wagmi auto-estimates
                            // leaving no baseFee headroom — but grounded in the
                            // live base fee so the wallet's gas reservation
                            // stays proportional (see computeFees).
                            ...(await computeFees(client)),
                            // Local-fork nonce pin — see the swap tx below.
                            nonce:
                                chainId === 31_337
                                    ? await client.getTransactionCount({
                                          address: user,
                                          blockTag: 'pending',
                                      })
                                    : undefined,
                        });
                        const approveReceipt = await client.waitForTransactionReceipt({
                            hash: approveTx,
                            timeout: 90_000,
                        });
                        if (approveReceipt.status !== 'success') {
                            setState('error');
                            setStatusLabel('');
                            setError(`Token approval reverted (tx ${approveTx.slice(0, 10)}…).`);
                            return;
                        }
                        setStatusLabel('Reading nonce…');
                    }

                    const allowance = (await client.readContract({
                        address: v4.permit2,
                        abi: permit2Abi,
                        functionName: 'allowance',
                        args: [user, params.token, v4.universalRouter],
                    })) as readonly [bigint, number, number];
                    const nonce = allowance[2] ?? 0;

                    // Use chain-time, not wall-time. Permit2 enforces both
                    // `expiration` and `sigDeadline` against `block.timestamp`,
                    // and a dev anvil fork may be hours ahead/behind wall time
                    // (see `chainTime.ts` for why).
                    const now = await chainDeadlineBaseSeconds(client);
                    const permitSingle: PermitSingle = {
                        details: {
                            token: params.token,
                            amount: MAX_UINT160,
                            expiration: now + PERMIT_EXPIRATION_SECS,
                            nonce,
                        },
                        spender: v4.universalRouter,
                        sigDeadline: BigInt(now + PERMIT_SIG_DEADLINE_SECS),
                    };

                    setState('awaiting-signature');
                    setStatusLabel('Sign in wallet…');
                    const signature = await signTypedDataAsync({
                        domain: permit2Domain(chainId, v4.permit2),
                        types: PERMIT2_TYPES,
                        primaryType: 'PermitSingle',
                        message: permitSingle,
                    });

                    // Give the wallet a moment to settle before the next
                    // request. Rainbow + WalletConnect mobile have been
                    // observed dropping the very-next eth_sendTransaction
                    // with a phantom 4001 when it lands within ~500ms of
                    // the typed-data signature.
                    await new Promise((r) => setTimeout(r, 700));

                    ({commands, inputs, value} = buildSellCalldata({
                        poolKey: params.poolKey,
                        tokenIsToken0: params.tokenIsToken0,
                        token: params.token,
                        tokenAmount: params.amountIn,
                        minEthOut: params.minOut,
                        permit: {permit: permitSingle, signature},
                        hookData: params.hookData,
                    }));
                    setState('awaiting-tx');
                    setStatusLabel('Confirm in wallet…');
                }

                // Bypass wagmi's writeContract wrapper. It has been
                // observed to hand the wallet a request with
                // `chain: undefined (id: …)`, which some wallets reject
                // without a popup. Calling sendTransaction directly with
                // explicit `chain` + `account` gives the wallet the full
                // context.
                const data = encodeFunctionData({
                    abi: universalRouterAbi,
                    functionName: 'execute',
                    args: [commands, inputs, params.deadline],
                });

                // Pre-flight simulate the tx ourselves. If the wallet's own
                // pre-flight sees a revert it typically swallows the reason
                // and surfaces EIP-1193 4001 ("User rejected") with no popup
                // — confusing the user. By doing our own eth_call first we
                // get the actual revert and can show it inline.
                try {
                    await client.call({
                        account: user,
                        to: v4.universalRouter,
                        data,
                        value,
                    });
                } catch (simErr: unknown) {
                    setState('error');
                    setStatusLabel('');
                    const formatted = formatViemError(simErr);
                    setError(
                        'Pre-flight simulation reverted — the wallet would auto-reject this. ' +
                            'Most likely: slippage too tight, or input size exceeds available ' +
                            'pool liquidity.\n\n' +
                            formatted,
                    );
                    return;
                }

                setStatusLabel(params.isBuy ? 'Buying…' : 'Selling…');

                // Explicit EIP-1559 fees. Without these, MetaMask/viem
                // sometimes submits txs where `maxFeePerGas == maxPriorityFeePerGas`
                // — which leaves no headroom for the network's baseFee
                // and anvil silently queues the tx forever (it never
                // crosses the inclusion threshold even though anvil's
                // baseFee is in the millionths-of-a-gwei range on a
                // fresh fork). Specifying both explicitly forces a
                // proper `maxFee >= baseFee + maxPriority` relationship
                // regardless of wallet auto-estimation.
                //
                // Values: 1 gwei priority, 100 gwei max. Max worst-case
                // gas cost = 100 × 1.5M gas = 0.00015 ETH — fine on
                // mainnet (baseFee spikes to ~50 gwei in busy moments,
                // still leaves 50 gwei headroom) and trivially OK on
                // the local fork.
                // Local-fork nonce pin: read anvil's live nonce and submit with
                // it, so the swap is immune to the wallet's stale cache after a
                // refork (Rainbow signs the nonce we provide). This is the SOLE
                // fork-nonce mechanism. The old `anvil_setNonce` "stuckRecover"
                // and `anvil_dropAllTransactions` were removed — `setNonce`
                // desynced anvil's mempool and orphaned correctly-nonced txs
                // into the `queued` set (the very "stuck on Confirming…" it
                // claimed to fix), and `dropAllTransactions` dropped in-flight
                // txs during rapid swaps. Dev-only: on mainnet we pass
                // `undefined` so the wallet manages its own nonce.
                const forkNonce =
                    chainId === 31_337
                        ? await client.getTransactionCount({address: user, blockTag: 'pending'})
                        : undefined;

                const hash = await walletClient.sendTransaction({
                    chain: targetChain,
                    account: user,
                    to: v4.universalRouter,
                    data,
                    value,
                    // Skip eth_estimateGas. During tight slippage races the
                    // simulation can revert and the wallet wraps that as a
                    // UserRejectedRequestError with no popup — confusing UX.
                    // Hardcoding sidesteps that entirely.
                    //
                    // Sizing: a per-swap flywheel cycle (collect from 12 LP
                    // positions + convert artcoin→ETH + sweep two adapters)
                    // uses ~1.1M warm-cache, more cold-cache or with
                    // accumulated fees. We need to OVERSHOOT because
                    // eth_estimateGas under-counts here: the hook splits and
                    // flushes all three skim legs inside _afterSwap of the
                    // same swap (the bid leg forwards to LiveBidAdapter, the
                    // protocol leg deposits to the fee escrow, the referral
                    // leg pays out), and the estimator can land short of the
                    // cold-cache + accumulated-fee path. 3M comfortably covers
                    // it. Cost of unused headroom at mainnet 50 gwei × 1.5M ≈ $0.25.
                    gas: 3_000_000n,
                    // Fees grounded in the live base fee — a flat 100-gwei
                    // ceiling × 3M gas reserves 0.3 ETH of phantom balance in
                    // the wallet's pre-flight and blocks otherwise-affordable
                    // buys (see computeFees).
                    ...(await computeFees(client)),
                    nonce: forkNonce,
                });

                setTxHash(hash);
                setState('confirming');

                // Wait for the REAL on-chain receipt — with a timeout so a tx
                // that never mines (e.g. stuck behind a nonce gap, dropped, or
                // underpriced) surfaces as a FAILURE instead of hanging at
                // "Confirming…" forever. And only declare success when the
                // receipt status is actually `success` — a mined-but-REVERTED
                // swap must show as failed, never as a (false) success.
                const receipt = await client.waitForTransactionReceipt({
                    hash,
                    timeout: 90_000,
                });
                if (receipt.status !== 'success') {
                    setState('error');
                    setStatusLabel('');
                    setError(`Swap reverted on-chain — no funds moved (tx ${hash.slice(0, 10)}…).`);
                    return;
                }
                setState('success');
                setStatusLabel('');
            } catch (e: unknown) {
                setState('error');
                setStatusLabel('');
                const formatted = formatViemError(e);
                setError(classifyTopLevel(formatted));
            }
        },
        [
            v4.permit2,
            v4.universalRouter,
            chainId,
            client,
            config,
            signTypedDataAsync,
            switchChainAsync,
            targetChain,
        ],
    );

    const reset = useCallback(() => {
        setState('idle');
        setStatusLabel('');
        setError(null);
        setTxHash(null);
    }, []);

    return {
        state,
        statusLabel,
        txHash,
        error,
        execute,
        reset,
    };
}
