// Dev-only screenshot capture endpoint. POSTs a base64-encoded PNG
// from the browser (via html2canvas) and writes it to
// `docs/screenshots/<name>.png` so the UI test report can embed real
// screenshots. Guarded against running in production.
//
// Usage from preview_eval:
//   const blob = await html2canvas(document.body).then(c =>
//     new Promise(r => c.toBlob(b => {
//       const reader = new FileReader();
//       reader.onload = () => r(reader.result.split(',')[1]);
//       reader.readAsDataURL(b);
//     }, 'image/png'))
//   );
//   await fetch('/api/save-screenshot', {
//     method: 'POST',
//     headers: {'content-type': 'application/json'},
//     body: JSON.stringify({name: 't1-initial-load', base64: blob}),
//   });

import {NextRequest, NextResponse} from 'next/server';
import {writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SAFE_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/i;
const SAFE_SUBDIR = /^[a-z0-9][a-z0-9-_]{0,31}$/i;

export async function POST(req: NextRequest) {
    // Fail loud if anyone tries to enable this in a non-anvil build.
    if (process.env.NEXT_PUBLIC_CHAIN_ID !== '31337') {
        return NextResponse.json(
            {error: 'save-screenshot is dev-only (anvil 31337)'},
            {status: 403},
        );
    }
    let body: {name?: string; base64?: string; subdir?: string};
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({error: 'invalid JSON'}, {status: 400});
    }
    const {name, base64, subdir} = body;
    if (!name || !SAFE_NAME.test(name)) {
        return NextResponse.json(
            {error: 'name must match /^[a-z0-9][a-z0-9-_]{0,63}$/i'},
            {status: 400},
        );
    }
    if (subdir !== undefined && !SAFE_SUBDIR.test(subdir)) {
        return NextResponse.json(
            {error: 'subdir must match /^[a-z0-9][a-z0-9-_]{0,31}$/i'},
            {status: 400},
        );
    }
    if (!base64 || base64.length > 16 * 1024 * 1024) {
        return NextResponse.json({error: 'missing or oversized base64 body'}, {status: 400});
    }
    // Mirror the e2e-screenshot route: read the base from an env var, not
    // a static `path.join('docs', 'screenshots', ...)`. The sibling route's
    // header explains why (Next file tracer + 250 MB Lambda cap). This one
    // writes — NFT doesn't trace writes — but keeping the shape identical
    // means there's only one config knob to set in dev.
    const devScreenshotsDir = process.env.PC_DEV_SCREENSHOTS_DIR;
    if (!devScreenshotsDir) {
        return NextResponse.json(
            {error: 'PC_DEV_SCREENSHOTS_DIR not set (dev-only env var)'},
            {status: 503},
        );
    }
    const baseDir = path.resolve(devScreenshotsDir);
    const targetDir = subdir ? path.join(baseDir, subdir) : baseDir;
    const target = path.join(targetDir, `${name}.png`);
    if (!target.startsWith(baseDir + path.sep)) {
        return NextResponse.json({error: 'path traversal blocked'}, {status: 400});
    }
    try {
        await mkdir(targetDir, {recursive: true});
        const buf = Buffer.from(base64, 'base64');
        await writeFile(target, buf);
        return NextResponse.json({
            ok: true,
            path: path.relative(baseDir, target),
            bytes: buf.length,
        });
    } catch (err) {
        return NextResponse.json(
            {error: 'write failed', detail: String(err)},
            {status: 500},
        );
    }
}
