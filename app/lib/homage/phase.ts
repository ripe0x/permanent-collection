// Mint schedule → current window + next transition. Mirrors Homage.sol's gating exactly:
//   claim     [claimStart, allowlistStart)   punk owners mint their own tokenId
//   allowlist [allowlistStart, publicStart)   allowlisted addrs, random draw
//   public    [publicStart, ∞)               anyone, random draw
// All-zero (unscheduled) or before the first boundary = closed. A window whose two bounds
// are equal is collapsed (skipped).

export type Schedule = {
    claimStart: number; // unix seconds (0 = unset/closed)
    allowlistStart: number;
    publicStart: number;
};

export type Phase = 'closed' | 'claim' | 'allowlist' | 'public';

export const PHASE_LABEL: Record<Phase, string> = {
    closed: 'Minting not open',
    claim: 'Punk owner mint',
    allowlist: 'Allowlist mint',
    public: 'Public mint',
};

/** The active window at `nowSec`, matching the contract's `_inXPhase()` checks. */
export function currentPhase(s: Schedule, nowSec: number): Phase {
    if (s.publicStart !== 0 && nowSec >= s.publicStart) return 'public';
    if (s.allowlistStart !== 0 && nowSec >= s.allowlistStart && nowSec < s.publicStart) return 'allowlist';
    if (s.claimStart !== 0 && nowSec >= s.claimStart && nowSec < s.allowlistStart) return 'claim';
    return 'closed';
}

/**
 * The next window boundary after `nowSec` (what a countdown ticks toward), or null if there's
 * nothing ahead (already public / open-ended, or fully unscheduled). Collapsed windows (equal
 * bounds) are skipped, so the countdown always targets a window that actually opens.
 */
export function nextTransition(s: Schedule, nowSec: number): { to: Phase; at: number } | null {
    const bounds: { to: Phase; at: number }[] = [];
    if (s.claimStart !== 0 && s.claimStart < s.allowlistStart) bounds.push({ to: 'claim', at: s.claimStart });
    if (s.allowlistStart !== 0 && s.allowlistStart < s.publicStart) bounds.push({ to: 'allowlist', at: s.allowlistStart });
    if (s.publicStart !== 0) bounds.push({ to: 'public', at: s.publicStart });
    for (const b of bounds) if (b.at > nowSec) return b;
    return null;
}

/** A synthetic "next window" for the dev-toggle preview (which bypasses the real schedule) so
 *  the countdown still renders. Ticks toward the next top-of-hour; null for public (open-ended). */
export function demoNext(p: Phase, nowSec: number): { to: Phase; at: number } | null {
    const to: Phase | null = p === 'closed' ? 'claim' : p === 'claim' ? 'allowlist' : p === 'allowlist' ? 'public' : null;
    if (!to) return null;
    return { to, at: (Math.floor(nowSec / 3600) + 1) * 3600 };
}

/** Format a positive second-delta as a compact countdown, e.g. "2d 4h", "3h 12m", "45s". */
export function fmtCountdown(secs: number): string {
    if (secs <= 0) return '0s';
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
