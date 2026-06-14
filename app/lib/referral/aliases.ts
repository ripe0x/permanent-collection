/**
 * Operator-curated referral aliases (server-only).
 *
 * A vanity slug (`/r/<slug>`) is a purely COSMETIC label that resolves to a
 * referrer address. On-chain attribution always uses the resolved address;
 * a stale / unknown / hijacked slug can never misroute funds — the worst
 * case is an unresolved slug, which the `/r/[slug]` route turns into the
 * safe no-`ref` default (the slice stays in the protocol leg).
 *
 * There is intentionally NO public claiming / ownership system: ordinary
 * referrers just share `?ref=<their address>`. Slugs exist for partners /
 * launchpads and are curated by the operator. The only thing curation buys
 * is namespace / brand hygiene, which a non-public write surface gives for
 * free — no signatures, no profanity filter, no squatting policy.
 *
 * Resolution merges three sources (later wins), so a runtime edit overrides
 * a deploy-time seed:
 *   1. the committed `config/referral-aliases.json` (auditable seed)
 *   2. the `REFERRAL_ALIASES_JSON` env var (a flat {slug: address} JSON;
 *      a no-rebuild deploy-time override, same spirit as DEFAULT_REFERRER)
 *   3. the Netlify Blobs store (the live operator surface; writes land here)
 *
 * Blobs is unavailable outside the Netlify runtime (local dev, tests), so
 * every Blobs call degrades to an empty map and the committed/env seeds
 * still resolve. This module is imported only by route handlers — never
 * ship it to the client (it reads server-only env + Netlify Blobs).
 */

import {getAddress, isAddress} from 'viem';

import aliasesConfig from '@/config/referral-aliases.json';

const BLOB_STORE = 'referral-aliases';
const BLOB_KEY = 'map';

/** Slug charset: lowercase alphanumerics + hyphen, 1–32 chars. Keeps slugs
 *  URL-clean and predictable; rejects anything that could confuse the
 *  `/r/[slug]` route or look like an address. */
const SLUG_RE = /^[a-z0-9-]{1,32}$/;

export function normalizeSlug(raw: string): string | null {
    const s = raw.trim().toLowerCase();
    return SLUG_RE.test(s) ? s : null;
}

function normalizeAddress(raw: unknown): `0x${string}` | null {
    if (typeof raw !== 'string' || !isAddress(raw, {strict: false})) return null;
    try {
        const a = getAddress(raw);
        return a === '0x0000000000000000000000000000000000000000' ? null : a;
    } catch {
        return null;
    }
}

function committedMap(): Record<string, unknown> {
    const a = (aliasesConfig as {aliases?: unknown}).aliases;
    return a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
}

function envMap(): Record<string, unknown> {
    const raw = process.env.REFERRAL_ALIASES_JSON;
    if (!raw) return {};
    try {
        const o = JSON.parse(raw);
        return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

async function blobMap(): Promise<Record<string, unknown>> {
    try {
        const {getStore} = await import('@netlify/blobs');
        const store = getStore(BLOB_STORE);
        const json = await store.get(BLOB_KEY, {type: 'json'});
        return json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    } catch {
        // Not in the Netlify runtime (local dev / tests) — degrade cleanly.
        return {};
    }
}

/** The merged, validated slug → address map. Invalid slugs/addresses are
 *  dropped silently so a bad seed can never produce a malformed redirect. */
async function mergedMap(): Promise<Map<string, `0x${string}`>> {
    const raw = {...committedMap(), ...envMap(), ...(await blobMap())};
    const out = new Map<string, `0x${string}`>();
    for (const [slug, addr] of Object.entries(raw)) {
        const s = normalizeSlug(slug);
        const a = normalizeAddress(addr);
        if (s && a) out.set(s, a);
    }
    return out;
}

/** Resolve a slug to its referrer address, or null if unknown/invalid. */
export async function resolveSlug(slug: string): Promise<`0x${string}` | null> {
    const s = normalizeSlug(slug);
    if (!s) return null;
    return (await mergedMap()).get(s) ?? null;
}

/** Reverse lookup: the slug pointing at an address, if any (first match,
 *  stable insertion order). Used to surface a referrer's vanity link. */
export async function slugForAddress(address: string): Promise<string | null> {
    const a = normalizeAddress(address);
    if (!a) return null;
    for (const [slug, mapped] of await mergedMap()) {
        if (mapped === a) return slug;
    }
    return null;
}

/** Operator write: set/overwrite a slug → address mapping in the Blobs
 *  store (the only mutable layer). Returns an error string on failure
 *  (e.g. Blobs unavailable). */
export async function setAlias(
    slug: string,
    address: string,
): Promise<{ok: boolean; error?: string}> {
    const s = normalizeSlug(slug);
    if (!s) return {ok: false, error: 'invalid slug (use a-z, 0-9, -, 1–32 chars)'};
    const a = normalizeAddress(address);
    if (!a) return {ok: false, error: 'invalid address'};
    try {
        const {getStore} = await import('@netlify/blobs');
        const store = getStore(BLOB_STORE);
        const current =
            ((await store.get(BLOB_KEY, {type: 'json'})) as Record<string, string> | null) ??
            {};
        current[s] = a;
        await store.setJSON(BLOB_KEY, current);
        return {ok: true};
    } catch (e) {
        return {ok: false, error: `blobs unavailable: ${String(e)}`};
    }
}

/** Operator write: remove a slug from the Blobs store. */
export async function removeAlias(slug: string): Promise<{ok: boolean; error?: string}> {
    const s = normalizeSlug(slug);
    if (!s) return {ok: false, error: 'invalid slug'};
    try {
        const {getStore} = await import('@netlify/blobs');
        const store = getStore(BLOB_STORE);
        const current =
            ((await store.get(BLOB_KEY, {type: 'json'})) as Record<string, string> | null) ??
            {};
        delete current[s];
        await store.setJSON(BLOB_KEY, current);
        return {ok: true};
    } catch (e) {
        return {ok: false, error: `blobs unavailable: ${String(e)}`};
    }
}
