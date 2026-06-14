/* Ingest endpoint for keeper pass reports. The keeper (scripts/keeper.ts on
 * Fly) POSTs one of these per pass; /debug/fees renders the recent ones.
 *
 * Auth is a shared secret (KEEPER_REPORT_SECRET) sent in the x-keeper-secret
 * header — set the same value on the keeper (Fly) and the app (Netlify env).
 * Fail-closed: if the secret isn't configured on the app, every POST is
 * rejected, so the feature is inert until both sides are wired. Requests are
 * per-IP rate limited (the same limiter the rpc proxy uses) and the body is
 * size-capped + clamped/sanitized before storage, so a flood or a malformed /
 * oversized POST can't amplify into Blobs writes or bloat the store. */

import {createHash, timingSafeEqual} from 'node:crypto';

import {NextResponse} from 'next/server';

import {KEEPER_ROWS_MAX, type KeeperReportRow, type KeeperReportStatus, type KeeperRunReport} from '@/lib/keeper/report';
import {extractClientIp, rateLimit} from '@/lib/rate-limit';
import {saveKeeperRun} from '@/lib/server/keeper-runs';

export const dynamic = 'force-dynamic';

/** Tight per-IP cap — the one legit poster sends ~twice an hour. */
const RATE_LIMIT_PER_MIN = 20;
/** Reject bodies larger than this before parsing (rows are clamped after). */
const MAX_BODY_BYTES = 64 * 1024;

const STATUSES: ReadonlySet<KeeperReportStatus> = new Set([
    'idle',
    'disabled',
    'simulated',
    'confirmed',
    'reverted',
    'failed',
]);

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v : String(v ?? '')).slice(0, max);
const num = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Constant-time secret compare (hash to equalise length, no early-out / no
 *  length leak). */
function secretMatches(provided: string | null, expected: string): boolean {
    if (!provided) return false;
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
    const rl = rateLimit(extractClientIp(req), RATE_LIMIT_PER_MIN);
    if (!rl.ok) {
        return NextResponse.json({error: 'rate limited'}, {status: 429, headers: {'X-RateLimit-Limit': String(rl.limit)}});
    }

    const secret = process.env.KEEPER_REPORT_SECRET;
    if (!secret) return NextResponse.json({error: 'reporting not configured'}, {status: 503});
    if (!secretMatches(req.headers.get('x-keeper-secret'), secret)) {
        return NextResponse.json({error: 'unauthorized'}, {status: 401});
    }

    const len = Number(req.headers.get('content-length') ?? 0);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
        return NextResponse.json({error: 'payload too large'}, {status: 413});
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({error: 'invalid json'}, {status: 400});
    }
    const b = body as Partial<KeeperRunReport> | null;
    if (!b || typeof b !== 'object' || !Array.isArray(b.rows) || typeof b.block !== 'string') {
        return NextResponse.json({error: 'bad shape'}, {status: 400});
    }

    const rows: KeeperReportRow[] = b.rows.slice(0, KEEPER_ROWS_MAX).map((raw) => {
        const r = (raw ?? {}) as Partial<KeeperReportRow>;
        const status: KeeperReportStatus = STATUSES.has(r.status as KeeperReportStatus)
            ? (r.status as KeeperReportStatus)
            : 'idle';
        const txHash = typeof r.txHash === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(r.txHash) ? r.txHash : undefined;
        const gasUsed = typeof r.gasUsed === 'string' && /^[0-9]{1,24}$/.test(r.gasUsed) ? r.gasUsed : undefined;
        return {hop: str(r.hop, 64), status, detail: str(r.detail, 300), txHash, gasUsed};
    });

    const run: KeeperRunReport = {
        app: str(b.app ?? 'PC', 16),
        title: str(b.title, 200),
        block: str(b.block, 24),
        chainId: num(b.chainId, 1),
        tsMs: num(b.tsMs, Date.now()),
        actionable: num(b.actionable, 0),
        sent: num(b.sent, 0),
        failed: num(b.failed, 0),
        rows,
    };

    const res = await saveKeeperRun(run);
    if (!res.ok) {
        console.error(`[keeper-report] store failed: ${res.error}`);
        return NextResponse.json({error: 'store unavailable'}, {status: 500});
    }
    return NextResponse.json({ok: true});
}
