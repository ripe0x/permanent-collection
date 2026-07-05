'use client';

import { DEV_TOOLS, OVERRIDE_OPTIONS, type PhaseOverride } from '@/lib/homage/devTools';

/**
 * Dev-only floating control to force the mint module into any window (or Live) for quick
 * visual testing, without touching the on-chain schedule. Hidden in production builds. Renders
 * inside the page's `.atelier` scope so the theme utility classes apply.
 */
export function DevPhaseToggle({ value, onChange }: { value: PhaseOverride; onChange: (v: PhaseOverride) => void }) {
    if (!DEV_TOOLS) return null;
    return (
        <div className="fixed bottom-3 left-3 z-50 flex items-center gap-1 border border-line bg-card px-2 py-1.5 font-mono text-[10px] shadow-[0_2px_10px_rgba(0,0,0,0.06)]">
            <span className="text-faint uppercase tracking-[0.14em] pr-1 select-none">state</span>
            {OVERRIDE_OPTIONS.map((o) => {
                const active = value === o.value;
                return (
                    <button
                        key={o.label}
                        onClick={() => onChange(o.value)}
                        aria-pressed={active}
                        className={`px-1.5 py-0.5 tracking-[0.08em] transition-colors ${active ? 'bg-[#16140f] text-[#f4f1ea]' : 'text-dim hover:text-ink'}`}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}
