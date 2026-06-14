'use client';

/* Live-ticking "chain now" in seconds.
 *
 * Seeds from the server's view of now (`initialNow`, a chain timestamp at
 * render time), measures the wall-clock offset once on mount, then re-renders
 * every second against wall time so callers track chain time without drifting
 * from it. Shared by the auction countdown and the detail page's
 * live-vs-settleable panel swap, so both flip at the same instant the window
 * closes — no reload needed. */

import {useEffect, useState} from 'react';

export function useNowSeconds(initialNow: bigint): bigint {
    // Offset = wall-now minus server-now at first paint. Add it back to wall-now
    // each tick to recover server/chain time.
    const [offset] = useState(() => BigInt(Math.floor(Date.now() / 1000)) - initialNow);
    const [now, setNow] = useState(initialNow);

    useEffect(() => {
        const tick = () => setNow(BigInt(Math.floor(Date.now() / 1000)) - offset);
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [offset]);

    return now;
}
