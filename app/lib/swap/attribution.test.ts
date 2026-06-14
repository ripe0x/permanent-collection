/**
 * Unit tests for `encodeAttributionHookData` and `hasAnyAttribution`.
 *
 * The critical contract is that the produced bytes round-trip through
 * the same ABI shape the hook decodes — a 1-tuple `PoolSwapData`
 * struct, NOT a 2-tuple of `(bytes, bytes)`. If a future viem version
 * subtly changes ABI encoding, this is the test that catches it before
 * it lands in production and silently nulls every swap's attribution.
 */

import {describe, expect, it} from 'vitest';
import {decodeAbiParameters, getAddress, type Hex} from 'viem';

import {
    encodeAttributionHookData,
    hasAnyAttribution,
    MAX_REFERRAL_BPS_OF_VOLUME,
} from './attribution';

const POOL_SWAP_DATA_ABI = [
    {
        type: 'tuple',
        components: [
            {name: 'mevModuleSwapData', type: 'bytes'},
            {name: 'poolExtensionSwapData', type: 'bytes'},
        ],
    },
] as const;

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

const SAMPLE_REFERRER = '0x1234567890123456789012345678901234567890' as const;
const SAMPLE_SOURCE_ID =
    '0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899' as const;
const SAMPLE_CAMPAIGN_ID = '0xdeadbeefcafef00d1234567890abcdef' as const;

describe('encodeAttributionHookData', () => {
    it('produces bytes that decode as a 1-tuple PoolSwapData struct', () => {
        const hookData = encodeAttributionHookData({referrer: SAMPLE_REFERRER});
        // Should not throw — the outer envelope decodes cleanly.
        const [outer] = decodeAbiParameters(POOL_SWAP_DATA_ABI, hookData);
        expect(outer.mevModuleSwapData).toBe('0x');
        expect(outer.poolExtensionSwapData).not.toBe('0x');
    });

    it('round-trips the full attribution payload', () => {
        const hookData = encodeAttributionHookData({
            referrer: SAMPLE_REFERRER,
            sourceId: SAMPLE_SOURCE_ID,
            campaignId: SAMPLE_CAMPAIGN_ID,
            referralBpsOfVolume: 250,
        });
        const [outer] = decodeAbiParameters(POOL_SWAP_DATA_ABI, hookData);
        const [inner] = decodeAbiParameters(
            PC_SWAP_DATA_ABI,
            outer.poolExtensionSwapData as Hex,
        );
        expect(inner.attribution.referrer.toLowerCase()).toBe(
            SAMPLE_REFERRER.toLowerCase(),
        );
        expect(inner.attribution.sourceId).toBe(SAMPLE_SOURCE_ID);
        expect(inner.attribution.campaignId).toBe(SAMPLE_CAMPAIGN_ID);
        expect(inner.attribution.referralBps).toBe(250);
        expect(inner.extensionPayload).toBe('0x');
    });

    it('checksums the referrer via viem getAddress', () => {
        const hookData = encodeAttributionHookData({referrer: SAMPLE_REFERRER});
        const [outer] = decodeAbiParameters(POOL_SWAP_DATA_ABI, hookData);
        const [inner] = decodeAbiParameters(
            PC_SWAP_DATA_ABI,
            outer.poolExtensionSwapData as Hex,
        );
        // viem stores addresses normalized; assert it matches getAddress output.
        expect(inner.attribution.referrer).toBe(getAddress(SAMPLE_REFERRER));
    });

    it('defaults referralBps to MAX_REFERRAL_BPS_OF_VOLUME (250) when omitted', () => {
        const hookData = encodeAttributionHookData({referrer: SAMPLE_REFERRER});
        const [outer] = decodeAbiParameters(POOL_SWAP_DATA_ABI, hookData);
        const [inner] = decodeAbiParameters(
            PC_SWAP_DATA_ABI,
            outer.poolExtensionSwapData as Hex,
        );
        expect(inner.attribution.referralBps).toBe(MAX_REFERRAL_BPS_OF_VOLUME);
        expect(MAX_REFERRAL_BPS_OF_VOLUME).toBe(250);
    });

    it('zeros the referrer field when none provided', () => {
        const hookData = encodeAttributionHookData({sourceId: SAMPLE_SOURCE_ID});
        const [outer] = decodeAbiParameters(POOL_SWAP_DATA_ABI, hookData);
        const [inner] = decodeAbiParameters(
            PC_SWAP_DATA_ABI,
            outer.poolExtensionSwapData as Hex,
        );
        expect(inner.attribution.referrer).toBe(
            '0x0000000000000000000000000000000000000000',
        );
        // sourceId still carries through — the hook will emit a
        // SwapAttribution event even without a referrer.
        expect(inner.attribution.sourceId).toBe(SAMPLE_SOURCE_ID);
    });

    it('rejects malformed referrer by zeroing it (mirrors useReferrer permissive parser)', () => {
        const hookData = encodeAttributionHookData({
            referrer: 'not-an-address' as `0x${string}`,
        });
        const [outer] = decodeAbiParameters(POOL_SWAP_DATA_ABI, hookData);
        const [inner] = decodeAbiParameters(
            PC_SWAP_DATA_ABI,
            outer.poolExtensionSwapData as Hex,
        );
        expect(inner.attribution.referrer).toBe(
            '0x0000000000000000000000000000000000000000',
        );
    });

    // Regression guard: the SwapBox uses encodeAttributionHookData and
    // passes its result directly to the V4 swap. If a future viem upgrade
    // changes the encoding (e.g. switches from 1-tuple to bare tuple),
    // the hook's _decodeAttribution returns referrer = address(0) — silent
    // failure. This test holds the byte layout stable by comparing
    // structure rather than exact bytes (viem may legally choose pointer
    // layouts as long as they decode the same).
    it('outer bytes are NOT the 2-tuple shape (catches the silent-fail gotcha)', () => {
        const hookData = encodeAttributionHookData({referrer: SAMPLE_REFERRER});
        // The wrong shape would be `abi.encode(bytes(""), inner)` —
        // decoding that as a 1-tuple struct produces a referrer = 0.
        // We decode as the correct 1-tuple here; if encoding ever
        // regresses to 2-tuple, the next assertion fails (referrer = 0).
        const [outer] = decodeAbiParameters(POOL_SWAP_DATA_ABI, hookData);
        const [inner] = decodeAbiParameters(
            PC_SWAP_DATA_ABI,
            outer.poolExtensionSwapData as Hex,
        );
        expect(inner.attribution.referrer.toLowerCase()).toBe(
            SAMPLE_REFERRER.toLowerCase(),
        );
    });
});

describe('hasAnyAttribution', () => {
    const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
    const ZERO_32 =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
    const ZERO_16 = '0x00000000000000000000000000000000' as const;

    it('returns true when a valid non-zero referrer is provided', () => {
        expect(hasAnyAttribution({referrer: SAMPLE_REFERRER})).toBe(true);
    });

    it('returns false for zero address', () => {
        expect(hasAnyAttribution({referrer: ZERO_ADDR})).toBe(false);
    });

    it('returns false for empty args', () => {
        expect(hasAnyAttribution({})).toBe(false);
    });

    it('returns true when only sourceId is set', () => {
        expect(hasAnyAttribution({sourceId: SAMPLE_SOURCE_ID})).toBe(true);
    });

    it('returns false when sourceId is all zeros', () => {
        expect(hasAnyAttribution({sourceId: ZERO_32})).toBe(false);
    });

    it('returns true when only campaignId is set', () => {
        expect(hasAnyAttribution({campaignId: SAMPLE_CAMPAIGN_ID})).toBe(true);
    });

    it('returns false when campaignId is all zeros', () => {
        expect(hasAnyAttribution({campaignId: ZERO_16})).toBe(false);
    });
});
