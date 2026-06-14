/**
 * Unit tests for the referral share-link helpers.
 *
 * The contract: a referral link always resolves to the canonical
 * production origin (or an explicit NEXT_PUBLIC_SITE_URL override), never
 * the current browser origin — a link shared from a preview must point at
 * the live site. `?ref=` is the raw attribution form; `/r/<slug>` is the
 * cosmetic vanity form that redirects to the same `?ref=`.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {displayLink, referralShareOrigin, referralUrl, vanityUrl} from './share';

const ADDR = '0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4';

describe('referral share helpers', () => {
    let prev: string | undefined;
    beforeEach(() => {
        prev = process.env.NEXT_PUBLIC_SITE_URL;
    });
    afterEach(() => {
        if (prev === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
        else process.env.NEXT_PUBLIC_SITE_URL = prev;
    });

    it('falls back to the canonical origin when no override is set', () => {
        delete process.env.NEXT_PUBLIC_SITE_URL;
        expect(referralShareOrigin()).toBe('https://111.ripe.wtf');
        expect(referralUrl(ADDR)).toBe(`https://111.ripe.wtf/trade?ref=${ADDR}`);
        expect(vanityUrl('alice')).toBe('https://111.ripe.wtf/r/alice');
    });

    it('honors NEXT_PUBLIC_SITE_URL and strips a trailing slash', () => {
        process.env.NEXT_PUBLIC_SITE_URL = 'https://example.test/';
        expect(referralShareOrigin()).toBe('https://example.test');
        expect(referralUrl(ADDR)).toBe(`https://example.test/trade?ref=${ADDR}`);
    });

    it('ignores a non-http override and uses the canonical fallback', () => {
        process.env.NEXT_PUBLIC_SITE_URL = 'not-a-url';
        expect(referralShareOrigin()).toBe('https://111.ripe.wtf');
    });

    it('strips the protocol for display', () => {
        expect(displayLink('https://111.ripe.wtf/trade?ref=0xabc')).toBe(
            '111.ripe.wtf/trade?ref=0xabc',
        );
        expect(displayLink('http://localhost:3000/r/alice')).toBe(
            'localhost:3000/r/alice',
        );
    });
});
