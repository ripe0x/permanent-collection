/**
 * Universal Router calldata builders for V4 swaps against the 111 pool.
 *
 * # hookData encoding gotcha — READ BEFORE WIRING ATTRIBUTION
 *
 * The artcoins skim hook decodes `hookData` (the `bytes` parameter
 * threaded through every V4 swap call) as a **1-tuple struct**:
 *
 *   abi.decode(swapData, (PoolSwapData))
 *
 * where `PoolSwapData = { bytes mevModuleSwapData; bytes poolExtensionSwapData; }`.
 *
 * Solidity's ABI encoder for a single struct argument writes a 32-byte
 * pointer (outer offset) followed by the struct body. If callers
 * (frontends, routers, aggregators) instead pass a 2-tuple of bytes —
 * `abi.encode(bytes(""), inner)` — the byte stream is off by 32 bytes
 * of outer-offset and the hook's `abi.decode` silently throws, which
 * the multi-layer try/catch in `_decodeAttribution` interprets as
 * "no attribution." The swap completes; the referral path is skipped.
 * Hard to spot because nothing reverts.
 *
 * Always build hookData via `lib/swap/attribution.ts:encodeAttributionHookData`
 * — that helper does the 1-tuple encoding correctly. Never hand-roll
 * the `hookData` bytes in component code.
 *
 * Routes through this file pass `hookData` opaquely; encoding lives in
 * the attribution module.
 */

import {encodeAbiParameters, type Address, type Hex} from 'viem';
import type {PoolKey} from './poolKey';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

// ─── Universal Router commands ────────────────────────────────────
//
// We only need PERMIT2_PERMIT + V4_SWAP because the 111 pool is native-ETH-
// paired: ETH flows in directly via msg.value (no WRAP_ETH) and ETH flows
// out directly via TAKE_ALL → UR's sweep-to-msg.sender at the end of
// execute() (no UNWRAP_WETH).
const CMD_PERMIT2_PERMIT = 0x0a;
const CMD_V4_SWAP = 0x10;

// ─── V4 router actions ────────────────────────────────────────────
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE = 0x0b; // (Currency, uint256 amount, bool payerIsUser)
const ACT_SETTLE_ALL = 0x0c; // (Currency, uint256 maxAmount)
const ACT_TAKE_ALL = 0x0f; // (Currency, uint256 minAmount)

function packBytes1(values: number[]): Hex {
    return `0x${values.map((v) => v.toString(16).padStart(2, '0')).join('')}` as Hex;
}

// ─── EIP-712 Permit2 PermitSingle ─────────────────────────────────
//
// The 111 token is deployed by the artcoins V3 factory and inherits Solady's
// ERC20 base, which auto-grants infinite ERC20 → Permit2 allowance from every
// holder. The user therefore never calls `token.approve(permit2, ...)` — they
// only need to sign Permit2 → UniversalRouter authorization off-chain, which
// is consumed inside the same `execute` call as the V4 swap.

export interface PermitDetails {
    token: Address;
    amount: bigint; // uint160
    expiration: number; // uint48 unix seconds — when the on-chain Permit2 allowance lapses
    nonce: number; // uint48 — read from Permit2.allowance(...)[2]
}

export interface PermitSingle {
    details: PermitDetails;
    spender: Address;
    sigDeadline: bigint; // uint256 unix seconds — when the signature itself expires
}

/** EIP-712 types object for `signTypedData`. Permit2's domain has no `version`. */
export const PERMIT2_TYPES = {
    PermitDetails: [
        {name: 'token', type: 'address'},
        {name: 'amount', type: 'uint160'},
        {name: 'expiration', type: 'uint48'},
        {name: 'nonce', type: 'uint48'},
    ],
    PermitSingle: [
        {name: 'details', type: 'PermitDetails'},
        {name: 'spender', type: 'address'},
        {name: 'sigDeadline', type: 'uint256'},
    ],
} as const;

export function permit2Domain(chainId: number, permit2Address: Address) {
    return {
        name: 'Permit2' as const,
        chainId,
        verifyingContract: permit2Address,
    };
}

/** Max uint160 — used for "infinite" Permit2 allowance amount. */
export const MAX_UINT160 = (1n << 160n) - 1n;

// ─── Encoders ────────────────────────────────────────────────────

const poolKeyComponents = [
    {name: 'currency0', type: 'address'},
    {name: 'currency1', type: 'address'},
    {name: 'fee', type: 'uint24'},
    {name: 'tickSpacing', type: 'int24'},
    {name: 'hooks', type: 'address'},
] as const;

const exactInputSingleComponents = [
    {name: 'poolKey', type: 'tuple', components: poolKeyComponents},
    {name: 'zeroForOne', type: 'bool'},
    {name: 'amountIn', type: 'uint128'},
    {name: 'amountOutMinimum', type: 'uint128'},
    {name: 'hookData', type: 'bytes'},
] as const;

const permitDetailsComponents = [
    {name: 'token', type: 'address'},
    {name: 'amount', type: 'uint160'},
    {name: 'expiration', type: 'uint48'},
    {name: 'nonce', type: 'uint48'},
] as const;

const permitSingleComponents = [
    {name: 'details', type: 'tuple', components: permitDetailsComponents},
    {name: 'spender', type: 'address'},
    {name: 'sigDeadline', type: 'uint256'},
] as const;

export function encodePermit2PermitInput(permit: PermitSingle, signature: Hex): Hex {
    return encodeAbiParameters(
        [{type: 'tuple', components: permitSingleComponents}, {type: 'bytes'}],
        [permit, signature],
    );
}

/**
 * Encode the V4 SWAP_EXACT_IN_SINGLE + SETTLE/SETTLE_ALL + TAKE/TAKE_ALL
 * sub-action sequence that lives inside one V4_SWAP UR command.
 *
 * Critical encoding note: ExactInputSingleParams must be encoded as a SINGLE
 * dynamic tuple (i.e. wrapped with a leading 0x20 offset word). V4Router's
 * CalldataDecoder dereferences this offset in assembly:
 *   swapParams := add(params.offset, calldataload(params.offset))
 * Passing flat fields would omit the offset word and revert. This matches
 * what `abi.encode(struct)` produces in Solidity and what the artcoins
 * frontend ships on mainnet.
 */
function encodeV4SwapInput(params: {
    poolKey: PoolKey;
    zeroForOne: boolean;
    amountIn: bigint;
    amountOutMinimum: bigint;
    hookData: Hex;
    inputCurrency: Address;
    outputCurrency: Address;
    /** true  → SETTLE_ALL: pulls input from user (msg.sender) via Permit2.
     *  false → SETTLE: pays from the router's own balance / native msg.value. */
    payerIsUser: boolean;
}): Hex {
    const settleAction = params.payerIsUser ? ACT_SETTLE_ALL : ACT_SETTLE;
    const actions = packBytes1([ACT_SWAP_EXACT_IN_SINGLE, settleAction, ACT_TAKE_ALL]);

    // Encode ExactInputSingleParams as a SINGLE dynamic tuple — matches
    // abi.encode(struct) in Solidity. V4Router's CalldataDecoder
    // dereferences a leading 0x20 offset word; passing flat fields would
    // omit that offset and revert.
    const swapParams = encodeAbiParameters(
        [{type: 'tuple', components: exactInputSingleComponents}],
        [
            {
                poolKey: params.poolKey,
                zeroForOne: params.zeroForOne,
                amountIn: params.amountIn,
                amountOutMinimum: params.amountOutMinimum,
                hookData: params.hookData,
            },
        ],
    );

    // SETTLE_ALL: (Currency, uint256 maxAmount)
    // SETTLE:     (Currency, uint256 amount, bool payerIsUser)
    const settleParams = params.payerIsUser
        ? encodeAbiParameters(
              [{type: 'address'}, {type: 'uint256'}],
              [params.inputCurrency, params.amountIn],
          )
        : encodeAbiParameters(
              [{type: 'address'}, {type: 'uint256'}, {type: 'bool'}],
              [params.inputCurrency, params.amountIn, false],
          );

    // TAKE_ALL: (Currency, uint256 minAmount) — recipient implicit.
    // V4Router's TAKE_ALL routes the swap output to the locker (= the
    // Universal Router itself). UR then sweeps leftover ETH and ERC20s
    // to msg.sender of execute() (the EOA) at the end of the call. The
    // minAmount field is the slippage gate.
    const takeParams = encodeAbiParameters(
        [{type: 'address'}, {type: 'uint256'}],
        [params.outputCurrency, params.amountOutMinimum],
    );

    return encodeAbiParameters(
        [{type: 'bytes'}, {type: 'bytes[]'}],
        [actions, [swapParams, settleParams, takeParams]],
    );
}

export interface BuildBuyArgs {
    poolKey: PoolKey;
    /** Is the 111 token currency0 in the pool? false for the native-ETH-
     *  paired pool because address(0) sorts below any real token address. */
    tokenIsToken0: boolean;
    /** Token being bought (111). */
    token: Address;
    /** Amount of ETH being spent. */
    ethAmount: bigint;
    /** Minimum tokens received — slippage-protected. */
    minTokenOut: bigint;
    /** Hook data — usually `0x`. */
    hookData?: Hex;
}

/**
 * Build Universal Router inputs for an ETH→111 buy against the native-ETH-
 * paired pool. Single command: V4_SWAP. The router accepts ETH via msg.value;
 * no WRAP_ETH is needed because address(0) IS one of the pool currencies.
 */
export function buildBuyCalldata(args: BuildBuyArgs): {
    commands: Hex;
    inputs: Hex[];
    value: bigint;
} {
    const hookData: Hex = args.hookData ?? '0x';

    const commands = packBytes1([CMD_V4_SWAP]);

    // Native ETH is the input currency. zeroForOne is true iff the input
    // sits at slot 0 in the pool key — which it does for the 111 pool
    // (address(0) < token address).
    const zeroForOne = !args.tokenIsToken0;

    const v4Input = encodeV4SwapInput({
        poolKey: args.poolKey,
        zeroForOne,
        amountIn: args.ethAmount,
        amountOutMinimum: args.minTokenOut,
        hookData,
        inputCurrency: ZERO,
        outputCurrency: args.token,
        payerIsUser: false, // router pays from the native ETH it received as msg.value
    });

    return {commands, inputs: [v4Input], value: args.ethAmount};
}

export interface BuildSellArgs {
    poolKey: PoolKey;
    tokenIsToken0: boolean;
    /** Token being sold (111). */
    token: Address;
    tokenAmount: bigint;
    /** Minimum ETH received — slippage-protected. */
    minEthOut: bigint;
    hookData?: Hex;
    /**
     * Optional Permit2 signature bundle. When present, prepends a
     * PERMIT2_PERMIT command so the UR can pull tokens via Permit2 in the
     * same tx as the swap — no separate on-chain `permit2.approve` needed.
     */
    permit?: {permit: PermitSingle; signature: Hex};
}

/**
 * Build Universal Router inputs for a 111→ETH sell against the native-ETH-
 * paired pool.
 *
 * Flow: (optional PERMIT2_PERMIT) → V4_SWAP (Token → native ETH, settled
 * from user via Permit2, ETH taken directly to msg.sender).
 *
 * No UNWRAP_WETH command is needed — currency0 of the pool IS native ETH,
 * so TAKE_ALL on currency0 hands ETH straight to the user.
 *
 * Pre-conditions when `permit` is supplied:
 *   - The token grants infinite ERC20 → Permit2 allowance for every holder
 *     (Solady ERC20 default — true for the artcoins V3 factory's 111).
 *   - The caller has signed `permitSingle` off-chain via EIP-712.
 */
export function buildSellCalldata(args: BuildSellArgs): {
    commands: Hex;
    inputs: Hex[];
    value: bigint;
} {
    const hookData: Hex = args.hookData ?? '0x';

    const commands = args.permit
        ? packBytes1([CMD_PERMIT2_PERMIT, CMD_V4_SWAP])
        : packBytes1([CMD_V4_SWAP]);

    // Token is the input currency. zeroForOne is true iff token sits at
    // slot 0 — which it doesn't for the 111 pool (token is currency1).
    const zeroForOne = args.tokenIsToken0;

    const v4Input = encodeV4SwapInput({
        poolKey: args.poolKey,
        zeroForOne,
        amountIn: args.tokenAmount,
        amountOutMinimum: args.minEthOut,
        hookData,
        inputCurrency: args.token,
        outputCurrency: ZERO,
        payerIsUser: true,
    });

    const inputs: Hex[] = args.permit
        ? [encodePermit2PermitInput(args.permit.permit, args.permit.signature), v4Input]
        : [v4Input];

    return {commands, inputs, value: 0n};
}
