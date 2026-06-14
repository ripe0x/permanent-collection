/**
 * Unit tests for the operator-curated alias store.
 *
 * The committed config is empty and Netlify Blobs is unavailable under
 * vitest (degrades to {}), so we drive resolution through the
 * `REFERRAL_ALIASES_JSON` env seed — which is also the deploy-time
 * override path in production. Validates slug/address normalization, the
 * forward + reverse lookups, and that invalid entries are dropped (so a
 * bad seed can never produce a malformed redirect).
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {getAddress} from 'viem';

import {normalizeSlug, resolveSlug, slugForAddress} from './aliases';

const ADDR = '0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4';

describe('referral aliases', () => {
    let prev: string | undefined;
    beforeEach(() => {
        prev = process.env.REFERRAL_ALIASES_JSON;
        process.env.REFERRAL_ALIASES_JSON = JSON.stringify({
            alice: ADDR.toLowerCase(), // any-case address accepted
            'bad slug': ADDR, // invalid slug → dropped
            broken: 'not-an-address', // invalid address → dropped
        });
    });
    afterEach(() => {
        if (prev === undefined) delete process.env.REFERRAL_ALIASES_JSON;
        else process.env.REFERRAL_ALIASES_JSON = prev;
    });

    it('normalizeSlug accepts clean slugs and rejects junk', () => {
        expect(normalizeSlug('Alice')).toBe('alice');
        expect(normalizeSlug('cool-partner-1')).toBe('cool-partner-1');
        expect(normalizeSlug('bad slug')).toBeNull();
        expect(normalizeSlug('emoji😀')).toBeNull();
        expect(normalizeSlug('a'.repeat(33))).toBeNull();
        expect(normalizeSlug('')).toBeNull();
    });

    it('resolves a known slug case-insensitively to a checksummed address', async () => {
        expect(await resolveSlug('alice')).toBe(getAddress(ADDR));
        expect(await resolveSlug('ALICE')).toBe(getAddress(ADDR));
    });

    it('returns null for unknown slugs and slugs with invalid chars', async () => {
        expect(await resolveSlug('nobody')).toBeNull();
        expect(await resolveSlug('bad slug')).toBeNull();
    });

    it('drops entries whose address is invalid', async () => {
        expect(await resolveSlug('broken')).toBeNull();
    });

    it('reverse-looks-up the slug for an address (any case)', async () => {
        expect(await slugForAddress(ADDR)).toBe('alice');
        expect(await slugForAddress(ADDR.toLowerCase())).toBe('alice');
        expect(
            await slugForAddress('0x0000000000000000000000000000000000000001'),
        ).toBeNull();
    });
});
