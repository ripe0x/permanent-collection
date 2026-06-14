import type {Address, Hex} from 'viem';
import type {PoolKey} from './poolKey';

/** Unified state machine. The SwapBox renders uniformly off these states.
 *
 *  - `idle`               — ready to accept a new swap
 *  - `preparing`          — engine is doing read-then-decide work (e.g. reading
 *                           Permit2 nonce before kicking off)
 *  - `awaiting-signature` — user must sign typed data (sell path only)
 *  - `awaiting-tx`        — user must confirm a wallet transaction
 *  - `confirming`         — tx submitted, awaiting receipt
 *  - `success`            — terminal: receipt confirmed, txHash set
 *  - `error`              — terminal: any failure, error string set
 */
export type EngineState =
    | 'idle'
    | 'preparing'
    | 'awaiting-signature'
    | 'awaiting-tx'
    | 'confirming'
    | 'success'
    | 'error';

export interface SwapExecuteParams {
    /** True for ETH→token, false for token→ETH. */
    isBuy: boolean;
    poolKey: PoolKey;
    /** Is the 111 token currency0 in this pool? false on the native-ETH-paired
     *  pool because address(0) < any real token address. */
    tokenIsToken0: boolean;
    /** The 111 token address. */
    token: Address;
    /** Amount of input wei (ETH for buy, token for sell). */
    amountIn: bigint;
    /** Slippage-protected minimum output wei. */
    minOut: bigint;
    /** Final recipient — typically the connected wallet address. */
    recipient: Address;
    /** Universal Router execute() deadline (unix seconds). */
    deadline: bigint;
    /** Optional hook data; defaults to `0x`. */
    hookData?: Hex;
}

export interface SwapEngine {
    state: EngineState;
    /** Human-friendly button label per state. */
    statusLabel: string;
    txHash: `0x${string}` | null;
    error: string | null;
    /** Kick off a swap. Resolves when the engine has reached a terminal state. */
    execute: (params: SwapExecuteParams) => Promise<void>;
    /** Reset the engine back to `idle`. Used by the success-state "New Swap" button. */
    reset: () => void;
}
