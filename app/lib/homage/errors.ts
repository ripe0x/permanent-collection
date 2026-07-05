/// viem buries the real revert reason in the `.cause` chain — the top-level message is
/// almost always opaque ("Execution reverted"). Walk the chain and collect the useful
/// fields into one de-duped line.
export function shortErr(e: unknown): string {
    const parts: string[] = [];
    let cur: unknown = e;
    let depth = 0;
    while (cur && depth < 6) {
        if (cur instanceof Error) {
            const a = cur as Error & { shortMessage?: string; metaMessages?: string[]; details?: string; cause?: unknown };
            if (a.shortMessage) parts.push(a.shortMessage);
            if (a.metaMessages?.length) parts.push(...a.metaMessages);
            if (a.details) parts.push(a.details);
            cur = a.cause;
        } else {
            parts.push(String(cur));
            break;
        }
        depth++;
    }
    // de-dupe consecutive repeats, cap length
    const seen = new Set<string>();
    const out = parts.filter((p) => p && !seen.has(p) && seen.add(p));
    return out.join(' · ') || 'transaction failed';
}
