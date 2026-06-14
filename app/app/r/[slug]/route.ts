/**
 * `/r/<slug>` — cosmetic vanity referral resolver.
 *
 * Looks up the slug in the operator-curated alias store and 307-redirects
 * to `/trade?ref=<address>`, where the existing `useReferrer` hook reads
 * and persists the `?ref=`. The slug is cosmetic: on-chain attribution
 * always uses the resolved address. An unknown / invalid slug redirects to
 * `/trade` with NO `?ref` — the safe default (the referral slice stays in
 * the protocol leg), never a malformed attribution.
 *
 * 307 (temporary) is deliberate — alias mappings can change, so the
 * redirect must not be cached permanently by the browser.
 */

import {NextResponse} from 'next/server';

import {resolveSlug} from '@/lib/referral/aliases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Redirect base. Behind Netlify's proxy `req.url` carries the INTERNAL
 *  deploy host (`<id>--site.netlify.app`) — redirecting there pins the
 *  visitor to a frozen deploy permalink AND persists the `?ref` in
 *  localStorage on the wrong origin, so the sticky referrer never follows
 *  them to the canonical site. Prefer the canonical origin from
 *  `NEXT_PUBLIC_SITE_URL` (set in production); fall back to the request
 *  origin for local dev / e2e where the env var is unset. */
function redirectBase(req: Request): string {
    const canonical = process.env.NEXT_PUBLIC_SITE_URL;
    if (canonical && /^https?:\/\//.test(canonical)) {
        return canonical.replace(/\/$/, '');
    }
    return new URL(req.url).origin;
}

export async function GET(
    req: Request,
    ctx: {params: Promise<{slug: string}>},
): Promise<Response> {
    const {slug} = await ctx.params;
    const address = await resolveSlug(slug);
    const dest = address ? `/trade?ref=${address}` : '/trade';
    return NextResponse.redirect(new URL(dest, redirectBase(req)), 307);
}
