/**
 * Encode `PCSwapData` attribution into the V4 hookData byte string the
 * permanent-collection-aware hook expects.
 *
 * # The encoding gotcha
 *
 * The hook decodes `swapData` as a **1-tuple struct**:
 *
 *   abi.decode(swapData, (PoolSwapData))
 *
 * where `PoolSwapData = { bytes mevModuleSwapData; bytes poolExtensionSwapData; }`.
 *
 * Solidity's ABI encoder for a single struct argument writes a 32-byte
 * pointer (offset) followed by the struct body. If callers (frontends,
 * routers, aggregators) instead pass a 2-tuple `(bytes mev, bytes inner)`
 * — i.e. `abi.encode(bytes(""), inner)` — the byte stream is off by 32
 * bytes of outer-offset and the hook's `abi.decode` silently throws,
 * which the multi-layer try/catch in `_decodeAttribution` interprets
 * as "no attribution." The swap completes; the referral path is
 * skipped. Hard to spot without tests because nothing reverts.
 *
 * This module is the one place that gets the encoding right. Use
 * `encodeAttributionHookData` everywhere the frontend builds hookData.
 *
 * # The referral path
 *
 * The hook routes the referral leg according to:
 *
 *   referral = min(volume × min(att.referralBps, maxReferralBpsOfVolume) / 100_000,
 *                  protocolShare)
 *
 * where `maxReferralBpsOfVolume = 250` (0.25% of swap volume) is set at
 * pool initialization and is admin-tunable up to 1% thereafter. The
 * referrer is credited from the first swap whenever the swap carries
 * attribution. With no referrer attributed, the slice stays in the
 * protocol leg.
 *
 * Encoded attribution that names no valid referrer is ignored silently
 * by the hook — no revert, no wasted gas (the decode is cheap).
 */

import {encodeAbiParameters, type Hex, getAddress, isAddress} from 'viem';

import {FEES} from '@/lib/protocol-params';

/** Maximum referral bps the hook will honor, capped against per-volume.
 *  Set at pool init via SkimHookFeeData.maxReferralBpsOfVolume (0.25% of
 *  volume in 100k-denom). Higher requests are clamped at the hook; the
 *  frontend defaults to this cap. Single source of truth: protocol-params. */
export const MAX_REFERRAL_BPS_OF_VOLUME: number = FEES.referralCapBpsOfVolume;

/** ABI fragment for the OUTER PoolSwapData struct — what `abi.decode`
 *  consumes at the hook entry point. The struct is encoded as a single
 *  argument (1-tuple). */
const POOL_SWAP_DATA_ABI = [
    {
        type: 'tuple',
        components: [
            {name: 'mevModuleSwapData', type: 'bytes'},
            {name: 'poolExtensionSwapData', type: 'bytes'},
        ],
    },
] as const;

/** ABI fragment for the INNER PCSwapData struct, nested under
 *  `poolExtensionSwapData`. */
const PC_SWAP_DATA_ABI = [
    {
        type: 'tuple',
        components: [
            {
                name: 'attribution',
                type: 'tuple',
                components: [
                    {name: 'sourceId', type: 'bytes32'},
                    {name: 'referrer', type: 'address'},
                    {name: 'campaignId', type: 'bytes16'},
                    {name: 'referralBps', type: 'uint24'},
                ],
            },
            {name: 'extensionPayload', type: 'bytes'},
        ],
    },
] as const;

export interface AttributionArgs {
    /** Arbitrary 32-byte identifier for the swap source (e.g. a hash
     *  of "permanent-collection-app"). Optional. */
    sourceId?: Hex;
    /** Referrer address — receives credit in `ReferralPayout`. Optional;
     *  pass undefined or zero address to omit. */
    referrer?: `0x${string}`;
    /** 16-byte campaign tag, e.g. a UTM-style marker. Optional. */
    campaignId?: Hex;
    /** Requested referral bps of volume (in 100k-denom). Clamped at the
     *  hook to `maxReferralBpsOfVolume`. Defaults to the max (250). */
    referralBpsOfVolume?: number;
}

const ZERO_BYTES32: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';
const ZERO_BYTES16: Hex = '0x00000000000000000000000000000000';
const ZERO_ADDRESS: `0x${string}` = '0x0000000000000000000000000000000000000000';

/** Build the inner `PCSwapData` bytes that nest inside `PoolSwapData.poolExtensionSwapData`. */
function encodePCSwapData(args: AttributionArgs): Hex {
    // Accept any-case address (matches the permissive parser in useReferrer)
    // — viem's strict default would reject mixed-case addresses with bad
    //   EIP-55 checksums, silently dropping legitimate referral URLs.
    const referrerNorm: `0x${string}` =
        args.referrer && isAddress(args.referrer, {strict: false})
            ? getAddress(args.referrer)
            : ZERO_ADDRESS;
    return encodeAbiParameters(PC_SWAP_DATA_ABI, [
        {
            attribution: {
                sourceId: args.sourceId ?? ZERO_BYTES32,
                referrer: referrerNorm,
                campaignId: args.campaignId ?? ZERO_BYTES16,
                referralBps: args.referralBpsOfVolume ?? MAX_REFERRAL_BPS_OF_VOLUME,
            },
            extensionPayload: '0x',
        },
    ]);
}

/**
 * Build the full `hookData` to pass into a V4 swap routed through
 * `ArtCoinsHookSkimFee`. The encoding is a single-argument
 * `PoolSwapData` struct (1-tuple) — see file docs for the gotcha.
 *
 * Pass the result as `hookData` on `SwapExecuteParams`. If you don't
 * need attribution at all, pass `'0x'` instead of calling this function.
 */
export function encodeAttributionHookData(args: AttributionArgs): Hex {
    const inner = encodePCSwapData(args);
    return encodeAbiParameters(POOL_SWAP_DATA_ABI, [
        {
            mevModuleSwapData: '0x',
            poolExtensionSwapData: inner,
        },
    ]);
}

/** Returns true iff the args carry at least one identifying attribution
 *  field (referrer, sourceId, or campaignId). Useful for gating "should
 *  we bother encoding" decisions in the SwapBox. */
export function hasAnyAttribution(args: AttributionArgs): boolean {
    if (
        args.referrer &&
        args.referrer !== ZERO_ADDRESS &&
        isAddress(args.referrer, {strict: false})
    ) {
        return true;
    }
    if (args.sourceId && args.sourceId !== ZERO_BYTES32) return true;
    if (args.campaignId && args.campaignId !== ZERO_BYTES16) return true;
    return false;
}
