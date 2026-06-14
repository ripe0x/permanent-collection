#!/usr/bin/env node
/* State-aware E2E snap driver. Drives Playwright against a running dev
 * server (default :3000, override BASE=) at desktop + mobile viewports
 * and writes both:
 *
 *   docs/screenshots/e2e/s{NN}-{viewport}-{slug}.png         (above-fold)
 *   docs/screenshots/e2e-fullpage/fp-s{NN}-{viewport}-{slug}.png (full page)
 *
 * The state's route set comes from app/lib/e2e/state-routes.json
 * (per-state list, defaults to all 16 if not pinned). Run BEFORE driving
 * the chain to the next state — the snap reads the chain at the URL,
 * so the state must already be present.
 *
 * Usage:
 *   node app/scripts/snap-state.mjs s02              # snap S2 routes
 *   BASE=http://localhost:55371 node app/scripts/snap-state.mjs s07
 *   SKIP_MOBILE=1 node app/scripts/snap-state.mjs s12 # desktop only
 *   ONLY=home,collection node app/scripts/snap-state.mjs s12
 */
import {chromium} from '@playwright/test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir, readFile} from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const stateId = process.argv[2];
if (!stateId || !/^s\d{2}$/.test(stateId)) {
    console.error('usage: node snap-state.mjs s##  (e.g. s07)');
    process.exit(2);
}
const STATE = stateId;

const ALL_ROUTES = [
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

// Per-state route filter (optional). If a state appears here, only those
// routes are snapped — useful for states that don't change non-relevant
// surfaces (e.g. S20 allowlist add is only meaningful on /accept).
const STATE_ROUTE_FILTER = {
    s00: [], // cold: no server
    s01: [], // no contracts: just baseline page errors — skip
    s02: ALL_ROUTES.map((r) => r.slug),
    s03: ['home', 'trade'],
    s04: ['home', 'trade', 'debug-fees', 'builders', 'referrals'],
    s05: ['home', 'trade', 'debug-fees'],
    s06: ['home', 'accept'],
    s07: ['home', 'accept', 'auction-list'],
    s08: ['home', 'auction-list', 'referrals', 'collection', 'proofs'],
    s09: ['home', 'auction-list'],
    s10: ['home', 'auction-list'],
    s11: ['home', 'collection', 'auction-list', 'proofs'],
    s12: ['home', 'collection', 'proofs', 'title'],
    s13: ['home', 'about'],
    s14: ['home', 'about'],
    s15: ['home', 'title', 'collection'],
    s16: ['home', 'accept', 'proofs'],
    s17: ['home', 'auction-list'],
    s18: ['home', 'collection', 'proofs', 'title'],
    s19: ['home', 'referrals', 'builders', 'trade'],
    s20: ['home', 'accept'],
    s21: ['home', 'trade', 'about'],
    s22: ['home'], // admin-page disabled-state would be ideal but no admin route surfaced
};

const onlyEnv = (process.env.ONLY || '').trim();
const onlySlugs = onlyEnv
    ? new Set(onlyEnv.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
const filter = onlySlugs ?? new Set(STATE_ROUTE_FILTER[STATE] ?? ALL_ROUTES.map((r) => r.slug));
const ROUTES = ALL_ROUTES.filter((r) => filter.has(r.slug));

const VIEWPORTS = [
    {label: 'desktop', width: 1280, height: 800},
    ...(process.env.SKIP_MOBILE ? [] : [{label: 'mobile', width: 375, height: 812}]),
];

const BASE = process.env.BASE || 'http://localhost:3000';
const ABOVE_FOLD_DIR = path.join(REPO_ROOT, 'docs', 'screenshots', 'e2e');
const FULL_PAGE_DIR = path.join(REPO_ROOT, 'docs', 'screenshots', 'e2e-fullpage');

async function run() {
    if (ROUTES.length === 0) {
        console.log(`state ${STATE} has no routes to snap (skipped).`);
        return;
    }
    await mkdir(ABOVE_FOLD_DIR, {recursive: true});
    await mkdir(FULL_PAGE_DIR, {recursive: true});
    console.log(`snapping ${STATE} (${ROUTES.length} routes × ${VIEWPORTS.length} viewports) against ${BASE}`);

    const browser = await chromium.launch();
    let fails = 0;
    for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({
            viewport: {width: vp.width, height: vp.height},
            deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        for (const r of ROUTES) {
            const url = `${BASE}${r.path}`;
            const afOut = path.join(ABOVE_FOLD_DIR, `${STATE}-${vp.label}-${r.slug}.png`);
            const fpOut = path.join(FULL_PAGE_DIR, `fp-${STATE}-${vp.label}-${r.slug}.png`);
            try {
                // Soft wait — networkidle hangs on routes with open websockets.
                await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
                await page.waitForTimeout(2000);
                await page.screenshot({path: afOut, fullPage: false});
                await page.screenshot({path: fpOut, fullPage: true});
                console.log(`  ✓ ${vp.label} ${r.path}`);
            } catch (e) {
                console.error(`  ✗ ${vp.label} ${r.path}: ${e.message.slice(0, 120)}`);
                fails++;
            }
        }
        await ctx.close();
    }
    await browser.close();
    if (fails > 0) {
        console.error(`done with ${fails} failures.`);
        process.exit(1);
    }
    console.log('done.');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
