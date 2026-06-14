/**
 * Playwright globalTeardown. Kills the Next dev server + anvil
 * spawned by globalSetup.
 *
 * Idempotent: missing state file is treated as "nothing to clean up"
 * rather than a hard error, so a failing globalSetup doesn't cascade
 * into a confusing teardown error that masks the real failure.
 */

import {spawn} from 'node:child_process';
import {existsSync, readFileSync, unlinkSync} from 'node:fs';
import {STATE_FILE, type GlobalState} from './globalSetup';

async function globalTeardown(): Promise<void> {
    if (!existsSync(STATE_FILE)) {
        process.stderr.write('[e2e] globalTeardown: no state file, skipping\n');
        return;
    }
    let state: GlobalState;
    try {
        state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as GlobalState;
    } catch (e) {
        process.stderr.write(`[e2e] globalTeardown: bad state file: ${String(e)}\n`);
        try {
            unlinkSync(STATE_FILE);
        } catch {
            /* ignore */
        }
        return;
    }
    process.stderr.write('[e2e] globalTeardown: shutting down dev server + anvil\n');
    await killPid(state.appPid);
    await killOnPort(state.appPort);
    await killOnPort(state.anvilPort);
    try {
        unlinkSync(STATE_FILE);
    } catch {
        /* ignore */
    }
}

/** Graceful kill: SIGTERM first (lets the child run shutdown hooks),
 *  then SIGKILL after 2s if it's still alive. SIGTERM cascades to a
 *  detached child's process group via `kill -- -${pid}`, so this kills
 *  pnpm + next + turbopack together instead of leaving zombies. */
async function killPid(pid: number): Promise<void> {
    if (!pid) return;
    await new Promise<void>((resolve) => {
        const child = spawn(
            'bash',
            [
                '-c',
                `kill -TERM -${pid} 2>/dev/null; for i in 1 2 3 4; do kill -0 ${pid} 2>/dev/null || exit 0; sleep 0.5; done; kill -KILL -${pid} 2>/dev/null; true`,
            ],
            {stdio: 'ignore'},
        );
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
    });
}

async function killOnPort(port: number): Promise<void> {
    await new Promise<void>((resolve) => {
        const child = spawn(
            'bash',
            [
                '-c',
                // Same SIGTERM-then-SIGKILL pattern as killPid for any
                // straggler bound to the port that didn't die from the
                // pid kill above.
                //
                // `-sTCP:LISTEN` is LOAD-BEARING: a bare `lsof -ti tcp:${port}`
                // returns EVERY process with a socket on the port — listeners
                // AND connected clients. This teardown runs INSIDE the
                // Playwright runner, which holds keep-alive client sockets to
                // the dev server (and anvil) from globalSetup's fetch warmups.
                // Without the LISTEN filter, `kill -TERM` reaps the runner
                // itself, so `playwright test` exits non-zero (SIGTERM) even
                // when every test passed — turning a green run red. Restricting
                // to listening sockets kills only the server we spawned.
                `pids=$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null); if [ -n "$pids" ]; then echo "$pids" | xargs kill -TERM 2>/dev/null; for i in 1 2 3 4; do still=$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null); [ -z "$still" ] && exit 0; sleep 0.5; done; echo "$pids" | xargs kill -KILL 2>/dev/null; fi; true`,
            ],
            {stdio: 'ignore'},
        );
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
    });
}

export default globalTeardown;
