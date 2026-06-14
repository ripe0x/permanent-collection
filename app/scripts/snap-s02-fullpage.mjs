#!/usr/bin/env node
/* Re-snap S2 (pristine T₀) full-page screenshots. Drives Playwright
 * against the running dev server (localhost:3000) at desktop + mobile
 * viewports and saves to docs/screenshots/e2e-fullpage/.
 *
 * The chain must be at T₀ when this runs: 0 acquisitions, 0 traits,
 * 0 ETH bid. The prior fp-*.png set was captured at 56/111 + 34.99 ETH
 * which contradicted S2's pristine semantics in the /e2e report UI.
 *
 * Usage: node scripts/snap-s02-fullpage.mjs
 */
import {chromium} from '@playwright/test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// script lives at app/scripts/, so repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'screenshots', 'e2e-fullpage');

// Routes referenced by S2.surfaces[*].route in app/lib/e2e/states.ts —
// only those with a .fullPage entry (which is the post-simulation snap
// the user flagged). /auction is captured as 'auction-list' per the
// existing filename convention.
const ROUTES = [
    {path: '/', slug: 'home'},
    {path: '/collection', slug: 'collection'},
    {path: '/accept', slug: 'accept'},
    {path: '/auction', slug: 'auction-list'},
    {path: '/proofs', slug: 'proofs'},
    {path: '/title', slug: 'title'},
    {path: '/referrals', slug: 'referrals'},
    {path: '/builders', slug: 'builders'},
    {path: '/trade', slug: 'trade'},
    {path: '/about', slug: 'about'},
    {path: '/calculator', slug: 'calculator'},
    {path: '/why', slug: 'why'},
    {path: '/debug', slug: 'debug'},
    {path: '/debug/fees', slug: 'debug-fees'},
    {path: '/docs', slug: 'docs'},
    {path: '/contracts', slug: 'contracts'},
];

const VIEWPORTS = [
    {label: 'desktop', width: 1280, height: 800},
    {label: 'mobile', width: 375, height: 812},
];

const BASE = process.env.BASE || 'http://localhost:3000';

async function run() {
    await mkdir(OUT_DIR, {recursive: true});
    const browser = await chromium.launch();
    for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({
            viewport: {width: vp.width, height: vp.height},
            deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        for (const r of ROUTES) {
            const url = `${BASE}${r.path}`;
            const out = path.join(OUT_DIR, `fp-${vp.label}-${r.slug}.png`);
            try {
                await page.goto(url, {waitUntil: 'networkidle', timeout: 30000});
                // Brief settle for animations / lazy-loaded SVGs.
                await page.waitForTimeout(500);
                await page.screenshot({path: out, fullPage: true});
                console.log(`✓ ${vp.label} ${r.path} → ${path.relative(REPO_ROOT, out)}`);
            } catch (e) {
                console.error(`✗ ${vp.label} ${r.path}: ${e.message}`);
            }
        }
        await ctx.close();
    }
    await browser.close();
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
