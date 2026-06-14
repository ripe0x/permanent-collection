/* Serves PNG screenshots from `docs/screenshots/{e2e,e2e-rerun}/` to the
 * /e2e review page. Strictly read-only and path-validated. Dev-only —
 * production builds wire NEXT_PUBLIC_CHAIN_ID != 31337 and we 403 to
 * keep dev-test artifacts out of any deployed surface.
 *
 * The base directory is read from `PC_DEV_SCREENSHOTS_DIR` rather than
 * built from a static `path.join('docs', 'screenshots', ...)` call.
 * Next's file tracer follows a literal join and pulls every file under
 * docs/screenshots/ (~162 MB) into the server-handler Lambda, which
 * lands over AWS Lambda's 250 MB unzipped cap and the Netlify deploy
 * step rejects the function with `Invalid AWS Lambda parameters used in
 * this request`. The env var is set by `pnpm dev`; production deploys
 * leave it unset and the 503 below short-circuits before any file read.
 */

import {NextRequest, NextResponse} from 'next/server';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_SUBDIRS = new Set(['e2e', 'e2e-rerun', 'e2e-fullpage']);

export async function GET(req: NextRequest, ctx: {params: Promise<{path: string[]}>}) {
    if (process.env.NEXT_PUBLIC_CHAIN_ID !== '31337') {
        return NextResponse.json({error: 'dev-only (anvil 31337)'}, {status: 403});
    }
    const devScreenshotsDir = process.env.PC_DEV_SCREENSHOTS_DIR;
    if (!devScreenshotsDir) {
        return NextResponse.json(
            {error: 'PC_DEV_SCREENSHOTS_DIR not set (dev-only env var)'},
            {status: 503},
        );
    }
    const {path: segments} = await ctx.params;
    if (!Array.isArray(segments) || segments.length !== 2) {
        return NextResponse.json({error: 'expected /{subdir}/{name}.png'}, {status: 400});
    }
    const [subdir, name] = segments;
    if (!ALLOWED_SUBDIRS.has(subdir)) {
        return NextResponse.json({error: 'unknown subdir'}, {status: 400});
    }
    if (!/^[a-z0-9][a-z0-9-_]{0,63}\.png$/i.test(name)) {
        return NextResponse.json({error: 'bad filename'}, {status: 400});
    }
    const baseDir = path.resolve(devScreenshotsDir, subdir);
    const target = path.join(baseDir, name);
    if (!target.startsWith(baseDir + path.sep)) {
        return NextResponse.json({error: 'path traversal blocked'}, {status: 400});
    }
    try {
        const buf = await readFile(target);
        return new NextResponse(buf, {
            status: 200,
            headers: {
                'content-type': 'image/png',
                'cache-control': 'public, max-age=300',
            },
        });
    } catch (err) {
        return NextResponse.json(
            {error: 'not found', detail: String(err).slice(0, 200)},
            {status: 404},
        );
    }
}
