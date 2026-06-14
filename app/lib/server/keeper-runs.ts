/* Server-only persistence for keeper pass reports. The keeper POSTs each pass
 * to /api/keeper-report (→ saveKeeperRun); /debug/fees reads them back
 * (getRecentKeeperRuns). Both degrade cleanly when no backend is reachable so
 * nothing 500s.
 *
 * Backend: Netlify Blobs in production (the same store the referral aliases
 * use). For local dev / tests where the Netlify runtime isn't present, set
 * KEEPER_RUNS_FILE to a JSON path and it read/writes that file instead — a
 * read-write analogue of the REFERRAL_ALIASES_JSON env override.
 *
 * A single rolling-array record (not one-per-run) keeps the page read to a
 * single fetch. Writes are read-modify-write, safe here because there is
 * exactly one poster: the PC keeper's single active Fly machine, sequentially,
 * once per pass. */

import {KEEPER_RUNS_MAX, type KeeperRunReport} from '@/lib/keeper/report';

const STORE = 'keeper';
const KEY = 'recent-runs';

async function readAll(): Promise<KeeperRunReport[]> {
    const file = process.env.KEEPER_RUNS_FILE?.trim();
    if (file) {
        try {
            const {readFile} = await import('node:fs/promises');
            const parsed = JSON.parse(await readFile(file, 'utf8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return []; // missing/unreadable file on first write
        }
    }
    try {
        const {getStore} = await import('@netlify/blobs');
        const store = getStore(STORE);
        const json = (await store.get(KEY, {type: 'json'})) as KeeperRunReport[] | null;
        return Array.isArray(json) ? json : [];
    } catch {
        return []; // not in the Netlify runtime
    }
}

async function writeAll(runs: KeeperRunReport[]): Promise<void> {
    const file = process.env.KEEPER_RUNS_FILE?.trim();
    if (file) {
        const {writeFile} = await import('node:fs/promises');
        await writeFile(file, JSON.stringify(runs));
        return;
    }
    const {getStore} = await import('@netlify/blobs');
    const store = getStore(STORE);
    await store.setJSON(KEY, runs);
}

export async function saveKeeperRun(run: KeeperRunReport): Promise<{ok: boolean; error?: string}> {
    try {
        const current = await readAll();
        await writeAll([run, ...current].slice(0, KEEPER_RUNS_MAX));
        return {ok: true};
    } catch (e) {
        return {ok: false, error: `keeper-runs store unavailable: ${String(e)}`};
    }
}

export async function getRecentKeeperRuns(limit = 40): Promise<KeeperRunReport[]> {
    return (await readAll()).slice(0, limit);
}
