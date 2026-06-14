/**
 * Referral share-link helpers (client-safe).
 *
 * A referral link is the canonical site origin plus either the raw
 * `?ref=<address>` query the hook attribution reads, or a cosmetic
 * `/r/<slug>` vanity path that 307-redirects to the same `?ref=`.
 *
 * The origin resolves from `NEXT_PUBLIC_SITE_URL` (the same explicit
 * override `lib/meta.ts` honors first) and otherwise falls back to the
 * production domain. We deliberately do NOT use `window.location.origin`
 * — a link shared from a deploy preview or localhost should still point
 * at production, not leak the preview host.
 */

const PRODUCTION_ORIGIN = 'https://111.ripe.wtf';

/** Canonical origin for a shareable link, no trailing slash. */
export function referralShareOrigin(): string {
    const raw = process.env.NEXT_PUBLIC_SITE_URL;
    if (raw && /^https?:\/\//.test(raw)) return raw.replace(/\/$/, '');
    return PRODUCTION_ORIGIN;
}

/** Full `?ref=<address>` referral URL. Lands on the trade page — the surface
 *  where the attribution does its work — matching where `/r/<slug>` redirects. */
export function referralUrl(address: string): string {
    return `${referralShareOrigin()}/trade?ref=${address}`;
}

/** Full `/r/<slug>` vanity URL (resolves to a `?ref=` via the slug route). */
export function vanityUrl(slug: string): string {
    return `${referralShareOrigin()}/r/${slug}`;
}

/** Strip the protocol for a compact on-screen display of a link. */
export function displayLink(url: string): string {
    return url.replace(/^https?:\/\//, '');
}
