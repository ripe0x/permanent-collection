// Lightweight GraphQL client for the Ponder indexer. Uses graphql-request so
// we don't bring in a full Apollo/Relay setup for what is essentially a
// read-only query surface.
//
// This module is also the single place indexer failures become VISIBLE:
//   - A production runtime serving a live protocol without INDEXER_URL is a
//     deploy misconfiguration, not an outage. It throws IndexerUrlMissingError
//     (and instrumentation.ts refuses to boot the server at all) instead of
//     silently querying the dev-default localhost URL — which once broke every
//     indexer-backed surface for days while the per-slice fallbacks rendered
//     empty states indistinguishable from "no activity yet".
//   - A runtime outage (indexer unreachable / 5xx) is logged loudly on every
//     failed query and recorded in a module-level health flag, so server pages
//     can surface a degraded-data notice instead of plausible empties.

import {ClientError, GraphQLClient} from 'graphql-request';
import {isProtocolLive} from '@/lib/config';

const DEFAULT_DEV_URL = 'http://127.0.0.1:42069';

/** Thrown when a production runtime is serving a LIVE protocol but
 *  INDEXER_URL is unset. Misconfiguration, not outage: callers that degrade
 *  gracefully on an indexer outage must rethrow this (see
 *  {@link rethrowIfIndexerMisconfigured}) so the broken deploy fails loud
 *  instead of rendering empty states that read as "no activity yet". */
export class IndexerUrlMissingError extends Error {
    constructor() {
        super(
            'INDEXER_URL is not set in a production runtime while the protocol is live. ' +
                'Every indexer-backed surface (auctions, accepted bids, stats, history) ' +
                'would silently render empty states. Set INDEXER_URL on the hosting ' +
                'platform and restart the runtime.',
        );
        this.name = 'IndexerUrlMissingError';
    }
}

/** True when this process is a production SERVING runtime (Netlify functions,
 *  `next start`, any NODE_ENV=production server). `next build` also runs with
 *  NODE_ENV=production but is excluded via NEXT_PHASE: CI builds the app with
 *  no runtime env, and a build must never fail on a serving-time concern —
 *  instrumentation.ts and the per-request check catch the real runtime. */
function isProductionRuntime(): boolean {
    if (process.env.NEXT_PHASE === 'phase-production-build') return false;
    if (process.env.NODE_ENV === 'production') return true;
    // Netlify deploy contexts keep NODE_ENV=production anyway; this is a
    // belt-and-suspenders signal in case a runtime ever drops it.
    return process.env.NETLIFY === 'true' && process.env.NETLIFY_DEV !== 'true';
}

/** Resolve the indexer URL from env. Pre-launch (protocol not live) the
 *  indexer is legitimately absent, so the dev default passes through and the
 *  existing per-caller fallbacks behave as before. Once the protocol is live,
 *  a production runtime without INDEXER_URL fails loud on every call. */
export function getIndexerUrl(): string {
    const url = process.env.INDEXER_URL;
    if (url) return url;
    if (isProductionRuntime() && isProtocolLive()) {
        const err = new IndexerUrlMissingError();
        // Loud on every request, not just at boot: instrumentation.ts kills a
        // misconfigured startup, but if a runtime skips the register hook this
        // still leaves an unmissable trail in the server logs.
        console.error(`[indexer] ${err.message}`);
        recordIndexerFailure(err.message);
        throw err;
    }
    return DEFAULT_DEV_URL;
}

/** Startup assertion for instrumentation.ts: throw before serving a single
 *  request when the deploy is live-without-indexer. Same predicate as
 *  {@link getIndexerUrl}, minus the per-request logging. */
export function assertIndexerConfigured(): void {
    if (!process.env.INDEXER_URL && isProductionRuntime() && isProtocolLive()) {
        throw new IndexerUrlMissingError();
    }
}

/** Call first inside any catch that degrades an indexer failure to a fallback
 *  value. An OUTAGE should degrade gracefully; a MISCONFIGURED deploy must
 *  propagate — otherwise the resilient fallbacks mask the bug as "no activity
 *  yet" (exactly the failure mode this module exists to prevent). */
export function rethrowIfIndexerMisconfigured(e: unknown): void {
    if (e instanceof IndexerUrlMissingError) throw e;
}

// ---------------------------------------------------------------------------
// Indexer health. Module-level because "indexer down" is a global condition,
// not a per-request one: any failure inside the window marks the whole
// process degraded, and server pages read the flag after their data fetches
// resolve (same request, same process). Resets naturally on instance restart.

const DEGRADED_WINDOW_MS = 60_000;
let lastFailureAtMs = 0;

/** True when an indexer query failed (transport error, 5xx, or missing
 *  INDEXER_URL) within the last minute. Server components call this after
 *  awaiting their data to decide whether to render a degraded-data notice. */
export function isIndexerDegraded(): boolean {
    return lastFailureAtMs !== 0 && Date.now() - lastFailureAtMs < DEGRADED_WINDOW_MS;
}

function recordIndexerFailure(message: string): void {
    lastFailureAtMs = Date.now();
    // The caller logs context-specific detail; nothing else to store — the
    // flag's only consumer is the boolean above.
    void message;
}

/** Outage-class failures mark the indexer degraded: transport errors (DNS,
 *  refused connection, timeout — graphql-request throws the raw fetch error)
 *  and 5xx responses. GraphQL-level errors (a 2xx/4xx with an errors array)
 *  do NOT: the indexer is up and the query shape is the issue — that is the
 *  deliberate schema-compat retry pattern in protocolStats.ts /
 *  getProtocolState, not an outage. */
function isOutageError(e: unknown): boolean {
    if (e instanceof ClientError) return e.response.status >= 500;
    return true;
}

function describeError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    // ClientError messages embed the whole response + query; keep the log to
    // one scannable line.
    return msg.split('\n')[0].slice(0, 300);
}

/** Build a fresh client each call. graphql-request is cheap to construct; the
 *  cost is negligible vs the network roundtrip, and re-reading the env on
 *  every call means hot-reloads of `.env.local` take effect without restart.
 *  The returned client's `request` is wrapped so every failure is logged and
 *  classified here, no matter which caller issued it. */
export function getIndexerClient(): GraphQLClient {
    const client = new GraphQLClient(getIndexerUrl(), {
        headers: {'content-type': 'application/json'},
    });
    const rawRequest = client.request.bind(client) as (...args: unknown[]) => Promise<unknown>;
    client.request = (async (...args: unknown[]) => {
        try {
            return await rawRequest(...args);
        } catch (e) {
            if (isOutageError(e)) {
                recordIndexerFailure(describeError(e));
                console.error(`[indexer] query failed: ${describeError(e)}`);
            } else {
                console.warn(`[indexer] query rejected (indexer reachable): ${describeError(e)}`);
            }
            throw e;
        }
    }) as typeof client.request;
    return client;
}
