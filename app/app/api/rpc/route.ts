// Server-side JSON-RPC read proxy. Keeps a paid RPC API key (Alchemy,
// Infura, etc.) off the client bundle. Whitelist of read-only methods
// only — writes go directly from the user's wallet, never through here.
//
// Pattern adapted from NODE Foundation's open-source CryptoPunks
// marketplace reference client:
// github.com/Infinite-Node/cryptopunks-marketplace-open
//
// `app/lib/wagmi.ts` points the browser transport at `/api/rpc`. Set
// `RPC_URL` (server-only, no NEXT_PUBLIC_ prefix) to the upstream node
// — paid Alchemy/Infura for mainnet, `http://127.0.0.1:8545` for an
// anvil fork.
//
// Fallback chain: on mainnet, getRpcUrls() returns RPC_URL (if set) ahead
// of free public fallbacks (Tenderly → publicnode → llamarpc → cloudflare
// → RPC_URL_FALLBACK). We try them in order on transport failure, upstream
// 5xx, or `429 Too Many Requests`, so a paid-tier hiccup degrades to slow-
// but-working instead of an outage. On the fork (chain 31337) the list is
// the single local node — fork dev requires anvil to be up, no point
// pretending publicnode could substitute.

import {NextResponse} from 'next/server';
import {getRpcUrls} from '@/lib/config';
import {extractClientIp, rateLimit} from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

// Cap the block span a single `eth_getLogs` may scan. The per-IP limiter
// counts REQUESTS and caps body BYTES, but a single getLogs over a huge
// fromBlock→toBlock span (or one whose upper bound is `latest` while the
// lower bound is a fixed old block) is one cheap request that burns a large,
// unbounded amount of paid-RPC compute. This caps the per-request cost.
//
// 5_000 blocks ≈ ~16.7h of mainnet at ~12s/block — comfortably covers any
// "recent activity" read a page legitimately needs, while a deep historical
// scan (which is what runs the bill up) is pushed to the indexer. Anything
// the UI needs older than this window is already served by the Ponder
// indexer, not the chain. Conservative on purpose: a single-block or
// small-range getLogs stays allowed unchanged.
const MAX_GETLOGS_BLOCK_SPAN = 5_000;

const ALLOWED_METHODS = new Set<string>([
    'eth_blockNumber',
    'eth_call',
    'eth_chainId',
    'eth_estimateGas',
    'eth_feeHistory',
    'eth_gasPrice',
    'eth_getBalance',
    'eth_getBlockByHash',
    'eth_getBlockByNumber',
    'eth_getCode',
    'eth_getLogs',
    'eth_getStorageAt',
    'eth_getTransactionByHash',
    'eth_getTransactionCount',
    'eth_getTransactionReceipt',
    'eth_maxPriorityFeePerGas',
    'net_version',
    'web3_clientVersion',
]);

// Dev-only fork-control methods. anvil's nonce resets on every refork while
// the wallet's nonce cache drifts ahead, so the swap engine's auto-unstick
// (lib/swap/usePermit2SignSwap.ts) drops stale mempool txs and bumps anvil's
// state-nonce to match the submitted tx. Those calls route through here.
// ONLY permitted when the upstream is a local node (anvil); against a real
// paid RPC (production) they stay blocked — anvil_setNonce on mainnet is
// meaningless and these must never be reachable from a deployed app.
const DEV_FORK_METHODS = new Set<string>([
    'anvil_setNonce',
    'anvil_dropAllTransactions',
    'anvil_mine',
    'evm_mine',
]);

function isLocalUpstream(url: string): boolean {
    return /(?:127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\])/.test(url);
}

function rpcError(
    status: number,
    code: number,
    message: string,
    id: number | string | null = null,
) {
    return NextResponse.json(
        {jsonrpc: '2.0', id, error: {code, message}},
        {status},
    );
}

type JsonRpcCall = {id?: number | string | null; method?: unknown; params?: unknown};

// Parse a block tag from an eth_getLogs filter into a concrete block number,
// or a sentinel describing why it can't be statically bounded.
//   - a fixed number  → {kind: 'number', value}        (hex `0x..`, decimal, or numeric JSON)
//   - 'earliest'      → block 0                          ({kind: 'number', value: 0n})
//   - 'latest' | 'pending' | 'safe' | 'finalized'
//                     → moving head, unknown at request time → {kind: 'dynamic'}
//   - anything else / absent → {kind: 'unknown'}
// 'dynamic' and 'unknown' are both treated as un-boundable by the caller.
type BlockTag =
    | {kind: 'number'; value: bigint}
    | {kind: 'dynamic'}
    | {kind: 'unknown'};

function parseBlockTag(tag: unknown): BlockTag {
    // JSON numbers are legal in some clients (and viem may send them).
    if (typeof tag === 'number' && Number.isFinite(tag) && tag >= 0) {
        return {kind: 'number', value: BigInt(Math.floor(tag))};
    }
    if (typeof tag === 'string') {
        const t = tag.trim().toLowerCase();
        if (t === 'earliest') return {kind: 'number', value: 0n};
        // Moving heads — their height is not knowable at request time, so a
        // range that ends on one cannot be statically bounded.
        if (t === 'latest' || t === 'pending' || t === 'safe' || t === 'finalized') {
            return {kind: 'dynamic'};
        }
        try {
            if (t.startsWith('0x')) {
                // Reject bare '0x' (no digits) and any non-hex body.
                if (!/^0x[0-9a-f]+$/.test(t)) return {kind: 'unknown'};
                return {kind: 'number', value: BigInt(t)};
            }
            // Plain decimal string.
            if (/^[0-9]+$/.test(t)) return {kind: 'number', value: BigInt(t)};
        } catch {
            return {kind: 'unknown'};
        }
    }
    return {kind: 'unknown'};
}

// Bound the per-request cost of an eth_getLogs call. Returns an error string
// to reject with, or null if the call is within budget.
//
// Allowed cheaply:
//   - a blockHash filter (single block; fromBlock/toBlock ignored per spec)
//   - a fixed [fromBlock, toBlock] span ≤ MAX_GETLOGS_BLOCK_SPAN
//   - an absent fromBlock (defaults to 'latest', i.e. a recent single-ish block)
//     paired with an absent/recent toBlock
// Rejected:
//   - any span that resolves to more than MAX_GETLOGS_BLOCK_SPAN blocks
//   - any span that cannot be statically bounded — e.g. a fixed old fromBlock
//     with toBlock 'latest' (the classic unbounded historical scan), or an
//     unparseable tag. Fail closed: if we can't prove it's small, reject and
//     point the caller at the indexer.
function reasonIfGetLogsTooWide(params: unknown): string | null {
    const filter = Array.isArray(params) ? params[0] : params;
    if (!filter || typeof filter !== 'object') return null; // malformed; upstream will reject

    // blockHash pins the query to exactly one block; span is irrelevant.
    const blockHash = (filter as {blockHash?: unknown}).blockHash;
    if (typeof blockHash === 'string' && blockHash.length > 0) return null;

    const fromRaw = (filter as {fromBlock?: unknown}).fromBlock;
    const toRaw = (filter as {toBlock?: unknown}).toBlock;

    // Both omitted → defaults to latest..latest, a single recent block. Cheap.
    if (fromRaw === undefined && toRaw === undefined) return null;

    // toBlock omitted/dynamic with a fixed fromBlock is the unbounded case:
    // it scans from a known point up to the moving head.
    const from = fromRaw === undefined ? ({kind: 'dynamic'} as BlockTag) : parseBlockTag(fromRaw);
    const to = toRaw === undefined ? ({kind: 'dynamic'} as BlockTag) : parseBlockTag(toRaw);

    // A range anchored to the moving head (or an unparseable tag) on either
    // end can't be statically bounded — reject and route to the indexer.
    if (from.kind !== 'number' || to.kind !== 'number') {
        return 'eth_getLogs range cannot be statically bounded (open-ended or non-numeric block tag); use the indexer for historical logs';
    }

    const span = to.value - from.value; // inclusive of fromBlock; negative if reversed
    if (span > BigInt(MAX_GETLOGS_BLOCK_SPAN)) {
        return `eth_getLogs block span too large (${span.toString()} > ${MAX_GETLOGS_BLOCK_SPAN}); use the indexer for historical logs`;
    }
    return null;
}

// A rejection carries the HTTP status + JSON-RPC error code the caller should
// emit, so distinct failure classes (method not allowed vs. cost-budget) get
// the right shape rather than being collapsed to one status.
type RejectReason = {status: number; code: number; message: string};

function reasonIfDisallowed(payload: unknown, allowDevMethods: boolean): RejectReason | null {
    const calls: JsonRpcCall[] = Array.isArray(payload)
        ? (payload as JsonRpcCall[])
        : [payload as JsonRpcCall];
    for (const call of calls) {
        if (!call || typeof call !== 'object') {
            return {status: 403, code: -32601, message: 'malformed JSON-RPC call'};
        }
        const method = (call as JsonRpcCall).method;
        if (typeof method !== 'string') {
            return {status: 403, code: -32601, message: 'missing method'};
        }
        const ok = ALLOWED_METHODS.has(method) || (allowDevMethods && DEV_FORK_METHODS.has(method));
        if (!ok) return {status: 403, code: -32601, message: `method not allowed: ${method}`};
        // Bound the per-request cost of eth_getLogs (the per-IP limiter caps
        // request COUNT + body BYTES, not the compute a single wide-span scan
        // burns). Other expensive methods (eth_call against a heavy contract,
        // eth_estimateGas) would be weighted here too if a per-method cost
        // budget is ever added — getLogs span is the one with an unbounded,
        // statically-checkable blast radius today. Rejected as a bad request
        // (400 / -32602 invalid params), not a forbidden method.
        if (method === 'eth_getLogs') {
            const tooWide = reasonIfGetLogsTooWide((call as JsonRpcCall).params);
            if (tooWide) return {status: 400, code: -32602, message: tooWide};
        }
    }
    return null;
}

/** Try upstreams in order. Failover triggers on a transport throw (fetch
 *  rejected — DNS, TLS, connection refused), HTTP 5xx, or HTTP 429. On a
 *  200/4xx we surface the upstream response verbatim: a `eth_call` revert
 *  from one provider must not silently re-route to another that might
 *  succeed against stale state, and a 4xx is a client problem (bad params)
 *  that won't differ across providers. */
async function fetchWithFallback(
    urls: string[],
    body: string,
): Promise<Response> {
    let lastErr: unknown = null;
    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        try {
            const upstream = await fetch(url, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body,
            });
            // Failover only on 5xx / 429. Everything else (including upstream
            // JSON-RPC error payloads inside a 200) is the canonical answer.
            if (upstream.status >= 500 || upstream.status === 429) {
                if (i < urls.length - 1) {
                    // Drain so the connection can be reused; ignore content.
                    try {
                        await upstream.arrayBuffer();
                    } catch {
                        // Ignore.
                    }
                    lastErr = new Error(`upstream ${url} returned ${upstream.status}`);
                    continue;
                }
            }
            return upstream;
        } catch (e) {
            lastErr = e;
            // Transport-level failure; try the next URL.
        }
    }
    // All upstreams failed. Surface a 502 with the last error message — the
    // browser transport will see this as a transient and react-query's
    // retry: 1 default will give one more attempt before showing a stale value.
    return NextResponse.json(
        {
            jsonrpc: '2.0',
            id: null,
            error: {
                code: -32000,
                message:
                    'all upstream RPCs failed: ' +
                    (lastErr instanceof Error ? lastErr.message : String(lastErr)),
            },
        },
        {status: 502},
    );
}

export async function POST(req: Request) {
    let urls: string[];
    try {
        urls = getRpcUrls();
    } catch (e) {
        return rpcError(
            503,
            -32000,
            'RPC URLs are not configured on the server: ' +
                (e instanceof Error ? e.message : String(e)),
        );
    }

    // Per-IP rate limit. Skipped when the primary upstream is local (anvil
    // fork) — dev's auto-unstick path can burst many fork-control calls per
    // second and there's no shared quota to defend against. In every other
    // case (any real chain RPC behind the proxy) we apply the limit before
    // we even parse the body, so abusive clients shedding garbage are still
    // capped.
    if (!isLocalUpstream(urls[0])) {
        // The per-IP key is load-bearing for the rate limit. On Netlify (our
        // host) the authoritative key is the `x-nf-client-connection-ip` header,
        // which Netlify sets at the edge and a client CANNOT spoof — see
        // extractClientIp() in lib/rate-limit.ts. That helper falls back to
        // `x-forwarded-for` / `x-real-ip`, which ARE client-controllable: a
        // caller can forge them to rotate keys and defeat the limit. Those
        // fallbacks are safe ONLY because a verified Netlify edge sits in front
        // and sets the trusted header first. If this app is ever hosted off
        // Netlify, re-verify that the host populates a spoof-proof header (and
        // that the x-forwarded-for fallback is only trusted behind that edge)
        // before relying on this limiter.
        const ip = extractClientIp(req);
        const rl = rateLimit(ip);
        if (!rl.ok) {
            return NextResponse.json(
                {
                    jsonrpc: '2.0',
                    id: null,
                    error: {code: -32000, message: 'rate limit exceeded'},
                },
                {
                    status: 429,
                    headers: {
                        'Retry-After': String(rl.retryAfterSeconds),
                        'X-RateLimit-Limit': String(rl.limit),
                    },
                },
            );
        }
    }

    const body = await req.text();
    if (body.length > MAX_BODY_BYTES) {
        return rpcError(413, -32600, 'request body too large');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return rpcError(400, -32700, 'parse error');
    }

    // Dev fork-control methods (anvil_*, evm_mine) are only honoured when the
    // PRIMARY upstream is local. Otherwise they're blocked — anvil_setNonce
    // against a paid mainnet RPC is meaningless and must not be reachable
    // from a deployed app.
    const allowDev = isLocalUpstream(urls[0]);
    const reason = reasonIfDisallowed(parsed, allowDev);
    if (reason) {
        const id =
            !Array.isArray(parsed) &&
            parsed &&
            typeof parsed === 'object' &&
            'id' in parsed
                ? ((parsed as {id?: number | string | null}).id ?? null)
                : null;
        return rpcError(reason.status, reason.code, reason.message, id);
    }

    const upstream = await fetchWithFallback(urls, body);

    // `upstream` may already be a NextResponse from the all-failed path.
    if (upstream instanceof NextResponse) return upstream;

    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    return new Response(upstream.body, {
        status: upstream.status,
        headers: {'content-type': contentType},
    });
}
