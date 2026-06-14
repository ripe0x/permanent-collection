'use client';

/* Live-ticking countdown for an active return auction.

   Server seeds with `endsAt` (chain timestamp) and `nowSecondsInitial`
   (the server's view of "now" at render time). The client computes the
   offset between server-now and wall-now once on mount, then re-renders
   every second against wall time so the clock visibly ticks down without
   drifting from chain time. */

import {formatCountdownPrecise} from '@/lib/format';
import {useNowSeconds} from '@/lib/useNowSeconds';

interface Props {
    endsAt: bigint;
    nowSecondsInitial: bigint;
    label?: string;
}

export function AuctionCountdown({endsAt, nowSecondsInitial, label = 'time remaining'}: Props) {
    const now = useNowSeconds(nowSecondsInitial);
    const remaining = endsAt > now ? endsAt - now : 0n;
    const ended = remaining === 0n;

    return (
        <div className={`countdown ${ended ? 'countdown-ended' : ''}`} role="timer" aria-live="polite">
            <span className="countdown-label">{label}</span>
            <span className="countdown-value tnum">
                {ended ? 'auction ended' : formatCountdownPrecise(remaining)}
            </span>
            <style>{styles}</style>
        </div>
    );
}

const styles = `
.countdown {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.countdown-label {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
}
.countdown-value {
    font-family: var(--mono);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 500;
    color: var(--ink);
    letter-spacing: -0.02em;
    line-height: 1;
}
.countdown-ended .countdown-value {
    color: var(--accent);
}
`;
