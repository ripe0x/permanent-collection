// Per-IP rate limiter for /api/rpc. Fixed-window counter held in module
// memory — survives across requests within a warm function instance, resets
// on cold start. This is defense in depth, NOT a hard guarantee:
//
//   - Netlify/Vercel can run multiple concurrent function instances under
//     load; each has its own bucket, so an attacker hitting different
//     instances would see ~N×limit aggregate. The upstream provider's
//     own rate limits are the authoritative defense.
//   - Cold starts reset the buckets — but cold starts are rare and a
//     freshly-spun instance is the same cost as any other.
//
// The realistic threat this catches: a single misbehaving client (script,
// scraper, infinite-loop bug in someone else's integration) hammering the
// proxy. Even a per-instance cap stops that case dead.
//
// Tuning: default 300 req/min/IP. A normal page load with wagmi's many
// useReadContract hooks fires ~20-50 RPC requests, and a user clicking
// around does ~5-10 page loads per minute — comfortably under 300. Set
// RPC_RATE_LIMIT_PER_MIN to override; 0 disables limiting entirely.

const DEFAULT_LIMIT_PER_MINUTE = 300;
const WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 10_000;
const CLEANUP_EVERY = 100;

type Bucket = {count: number; windowEnd: number};

const buckets = new Map<string, Bucket>();
let cleanupCounter = 0;

function cleanup(now: number): void {
    // Drop windows that have fully expired (more than 1 window past end).
    for (const [ip, bucket] of buckets) {
        if (bucket.windowEnd < now - WINDOW_MS) buckets.delete(ip);
    }
    // Hard cap on map size. If we still have too many IPs after dropping
    // expired entries (someone is enumerating IPs), evict the oldest half.
    if (buckets.size > MAX_TRACKED_IPS) {
        const sorted = [...buckets.entries()].sort(
            (a, b) => a[1].windowEnd - b[1].windowEnd,
        );
        const keep = sorted.slice(-Math.floor(MAX_TRACKED_IPS / 2));
        buckets.clear();
        for (const [ip, bucket] of keep) buckets.set(ip, bucket);
    }
}

export type RateLimitResult =
    | {ok: true; remaining: number; limit: number}
    | {ok: false; retryAfterSeconds: number; limit: number};

function getLimit(): number {
    const raw = process.env.RPC_RATE_LIMIT_PER_MIN;
    if (raw === undefined) return DEFAULT_LIMIT_PER_MINUTE;
    const n = Number(raw);
    // Negative or NaN => fall back to default. 0 explicitly disables.
    if (!Number.isFinite(n) || n < 0) return DEFAULT_LIMIT_PER_MINUTE;
    return Math.floor(n);
}

/** Check + record a request from `ip`. Returns whether the request is
 *  allowed and (if blocked) how long the caller should wait.
 *
 *  Passing `0` for `limit` disables limiting and always returns ok. */
export function rateLimit(ip: string, limit: number = getLimit()): RateLimitResult {
    if (limit === 0) return {ok: true, remaining: Number.MAX_SAFE_INTEGER, limit: 0};

    const now = Date.now();
    cleanupCounter++;
    if (cleanupCounter >= CLEANUP_EVERY) {
        cleanupCounter = 0;
        cleanup(now);
    }

    let bucket = buckets.get(ip);
    if (!bucket || now >= bucket.windowEnd) {
        bucket = {count: 0, windowEnd: now + WINDOW_MS};
        buckets.set(ip, bucket);
    }
    bucket.count++;
    if (bucket.count > limit) {
        return {
            ok: false,
            retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowEnd - now) / 1000)),
            limit,
        };
    }
    return {ok: true, remaining: limit - bucket.count, limit};
}

/** Extract the client IP from a Request. Header priority:
 *    1. `x-nf-client-connection-ip` — Netlify sets this to the authoritative
 *       client IP at the edge (cannot be spoofed by the client).
 *    2. `x-forwarded-for` — generic forwarding header. We take the leftmost
 *       entry, which is the original client when the proxy chain is trusted.
 *       Netlify and Vercel both prepend to this header correctly.
 *    3. `x-real-ip` — some platforms use this instead.
 *
 *  Fallback `'unknown'` is shared by all callers without a recognised
 *  header (mainly localhost dev with no proxy in front). In production
 *  this should never hit since the platform always sets one. */
export function extractClientIp(req: Request): string {
    const netlifyIp = req.headers.get('x-nf-client-connection-ip');
    if (netlifyIp) return netlifyIp.trim();
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first;
    }
    const realIp = req.headers.get('x-real-ip');
    if (realIp) return realIp.trim();
    return 'unknown';
}

/** Test-only hook to wipe state between scenarios. Not exported via the
 *  public API surface in any production code path. */
export function _resetRateLimitForTests(): void {
    buckets.clear();
    cleanupCounter = 0;
}
