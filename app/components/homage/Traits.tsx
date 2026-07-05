import { decodeTokenURI, type TokenMeta } from '@/lib/homage/svg';
import { Flap } from '@/components/homage/Flap';

/// Render the homage's attribute list (Punk Type, Punk Accessory ×N, Accessory
/// Count, Color Count, Status) from a token URI or a decoded meta object.
/// With `animate` + a `trigger` (e.g. the punk id), each row clatters over to its
/// new label/value split-flap style, staggered down the board, on every change.
export function Traits({
    uri,
    meta,
    animate,
    trigger,
}: {
    uri?: string;
    meta?: TokenMeta | null;
    animate?: boolean;
    trigger?: number | string;
}) {
    const m = meta ?? (uri ? decodeTokenURI(uri) : null);
    const attrs = m?.attributes ?? [];
    if (!attrs.length) return null;
    const flap = animate && trigger !== undefined;
    return (
        <div className="mt-3 font-mono text-[11px]">
            {attrs.map((t, i) => {
                // Labels stay put; only the values flap on change.
                const label = <span className="text-faint uppercase tracking-[0.12em]">{t.trait_type}</span>;
                const value = (cls?: string) =>
                    flap ? (
                        <Flap value={String(t.value)} trigger={trigger!} delay={i * 55} className={cls} />
                    ) : (
                        <span className={cls}>{String(t.value)}</span>
                    );
                const valueCell = t.href ? (
                    <a
                        href={t.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group inline-flex items-center gap-1 text-ink hover:text-dim transition-colors"
                    >
                        {value()}
                        <svg
                            viewBox="0 0 24 24"
                            width="9"
                            height="9"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="opacity-40 group-hover:opacity-80"
                            aria-hidden="true"
                        >
                            <line x1="7" y1="17" x2="17" y2="7" />
                            <polyline points="7 7 17 7 17 17" />
                        </svg>
                    </a>
                ) : (
                    value('text-ink text-right')
                );
                return (
                    <div key={i} className="flex justify-between gap-3 border-b border-line py-[6px]">
                        {label}
                        {valueCell}
                    </div>
                );
            })}
        </div>
    );
}
