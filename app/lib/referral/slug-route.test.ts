/**
 * Unit test for the `/r/[slug]` resolver route handler.
 *
 * Lives under lib/ (vitest's include glob covers lib + components, not the
 * app/ route tree) and imports the GET handler directly. Drives resolution
 * via the REFERRAL_ALIASES_JSON seed (Blobs is unavailable under vitest).
 * The key guarantees: a known slug 307s to `/trade?ref=<checksummed>`, an
 * unknown slug 307s to `/trade` with NO ref — the safe default — and the
 * redirect lands on the canonical origin when NEXT_PUBLIC_SITE_URL is set
 * (behind Netlify's proxy `req.url` carries the internal deploy host, which
 * would pin visitors to a frozen deploy and persist the sticky referrer on
 * the wrong origin).
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {getAddress} from 'viem';

import {GET} from '@/app/r/[slug]/route';

const ADDR = '0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4';

function call(slug: string) {
    return GET(new Request(`http://localhost/r/${slug}`), {
        params: Promise.resolve({slug}),
    });
}

describe('/r/[slug] resolver', () => {
    let prevAliases: string | undefined;
    let prevSiteUrl: string | undefined;
    beforeEach(() => {
        prevAliases = process.env.REFERRAL_ALIASES_JSON;
        prevSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
        process.env.REFERRAL_ALIASES_JSON = JSON.stringify({alice: ADDR});
        delete process.env.NEXT_PUBLIC_SITE_URL;
    });
    afterEach(() => {
        if (prevAliases === undefined) delete process.env.REFERRAL_ALIASES_JSON;
        else process.env.REFERRAL_ALIASES_JSON = prevAliases;
        if (prevSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
        else process.env.NEXT_PUBLIC_SITE_URL = prevSiteUrl;
    });

    it('redirects a known slug to /trade?ref=<checksummed address>', async () => {
        const res = await call('alice');
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toBe(
            `http://localhost/trade?ref=${getAddress(ADDR)}`,
        );
    });

    it('redirects an unknown slug to /trade with no ref (safe default)', async () => {
        const res = await call('nobody');
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toBe('http://localhost/trade');
    });

    it('uses the canonical origin when NEXT_PUBLIC_SITE_URL is set', async () => {
        process.env.NEXT_PUBLIC_SITE_URL = 'https://canonical.test/';
        const res = await call('alice');
        expect(res.status).toBe(307);
        // Not the request's http://localhost — the canonical origin, with
        // the trailing slash stripped.
        expect(res.headers.get('location')).toBe(
            `https://canonical.test/trade?ref=${getAddress(ADDR)}`,
        );
    });

    it('falls back to the request origin on a malformed NEXT_PUBLIC_SITE_URL', async () => {
        process.env.NEXT_PUBLIC_SITE_URL = 'not-a-url';
        const res = await call('nobody');
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toBe('http://localhost/trade');
    });
});
