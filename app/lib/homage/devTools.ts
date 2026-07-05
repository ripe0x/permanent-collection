import { type Phase } from './phase';

// Dev-only mint-state preview. Gated to non-production builds (or an explicit opt-in via
// NEXT_PUBLIC_DEV_TOOLS=true) so it never ships to the live site. Lets you force the mint
// module into any window without touching the on-chain schedule — including the pre-mint
// state, which also renders with no contract deployed yet.
export const DEV_TOOLS =
    process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_DEV_TOOLS === 'true';

// null = live (use the real on-chain schedule); a Phase = force that window.
export type PhaseOverride = Phase | null;

// Toggle options in launch order. "closed" is the pre-mint / coming-soon state.
export const OVERRIDE_OPTIONS: { value: PhaseOverride; label: string }[] = [
    { value: null, label: 'Live' },
    { value: 'closed', label: 'Pre-mint' },
    { value: 'claim', label: 'Holder' },
    { value: 'allowlist', label: 'Allowlist' },
    { value: 'public', label: 'Public' },
];

const KEY = 'state';
const VALID: string[] = ['closed', 'claim', 'allowlist', 'public'];

/** Read the forced state from the URL (?state=...), or null for live. */
export function readOverrideFromUrl(): PhaseOverride {
    if (typeof window === 'undefined') return null;
    const p = new URLSearchParams(window.location.search).get(KEY);
    return p && VALID.includes(p) ? (p as Phase) : null;
}

/** Persist the forced state in the URL so a reload keeps it (dev convenience). */
export function writeOverrideToUrl(v: PhaseOverride) {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (v) url.searchParams.set(KEY, v);
    else url.searchParams.delete(KEY);
    window.history.replaceState(null, '', url.toString());
}
