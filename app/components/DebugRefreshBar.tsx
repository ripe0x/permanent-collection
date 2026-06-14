'use client';

/* Refresh controls for the server-rendered distribution debug dashboard.
 * The page reads all status + history server-side on each render; this bar
 * re-runs that render via router.refresh() either on demand or on an
 * interval, and shows how stale the current snapshot is. Built for the
 * local-fork walkthrough: advance a stage in a test, hit refresh (or leave
 * auto on), watch the numbers move. */

import {useEffect, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';

const INTERVAL_MS = 4000;

export function DebugRefreshBar({asOfMs, asOfBlock}: {asOfMs: number; asOfBlock: number}) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [auto, setAuto] = useState(false);
    const [now, setNow] = useState(asOfMs);

    const refresh = () => startTransition(() => router.refresh());

    // Tick a clock so "updated Ns ago" stays current without re-fetching.
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    // Auto-refresh loop.
    useEffect(() => {
        if (!auto) return;
        const t = setInterval(() => startTransition(() => router.refresh()), INTERVAL_MS);
        return () => clearInterval(t);
    }, [auto, router]);

    const ageS = Math.max(0, Math.round((now - asOfMs) / 1000));

    return (
        <div className="drb">
            <button type="button" className="drb-btn" onClick={refresh} disabled={isPending}>
                {isPending ? 'Refreshing…' : 'Refresh'}
            </button>
            <label className="drb-auto">
                <input
                    type="checkbox"
                    checked={auto}
                    onChange={(e) => setAuto(e.target.checked)}
                />
                Auto ({INTERVAL_MS / 1000}s)
            </label>
            <span className="drb-meta">
                block <span className="drb-mono">{asOfBlock || '—'}</span> · updated {ageS}s ago
                {isPending && auto ? ' · …' : ''}
            </span>
            <style>{styles}</style>
        </div>
    );
}

const styles = `
.drb {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    margin: 18px 0 8px;
}
.drb-btn {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    padding: 8px 16px;
    border: 1px solid var(--ink);
    background: var(--ink);
    color: var(--bg);
    cursor: pointer;
}
.drb-btn:disabled { opacity: 0.55; cursor: default; }
.drb-auto {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
}
.drb-meta {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
}
.drb-mono { color: var(--ink); }
`;
