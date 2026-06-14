/* "block 25109682 · 2s ago" badge. Always visible where live numbers are
   shown so the user can tell whether they're looking at a live read or a
   stale snapshot. Plain mono, no spinner. */
import {formatRelative} from '@/lib/format';

export function AsOfBadge({
    block,
    timestamp,
    stale,
    degraded,
}: {
    block: bigint;
    timestamp: bigint;
    stale?: boolean;
    /** True when indexer-sourced data on the surrounding page failed to load
     *  this request (see isIndexerDegraded), so indexer-backed sections may be
     *  incomplete even though the on-chain block read is fresh. */
    degraded?: boolean;
}) {
    return (
        <>
            <span
                className="as-of"
                data-stale={stale || degraded ? 'true' : undefined}
                aria-live="polite"
                aria-atomic="true"
                title={`Block ${block.toString()}`}
                suppressHydrationWarning
            >
                block {block.toString()} ·{' '}
                <span suppressHydrationWarning>{formatRelative(timestamp)}</span>
                {stale ? ' · stale' : ''}
                {degraded ? ' · indexed data unavailable' : ''}
            </span>
            <style>{styles}</style>
        </>
    );
}

const styles = `
.as-of {
    display: inline-block;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.04em;
}
.as-of[data-stale="true"] {
    color: var(--accent);
}
`;
