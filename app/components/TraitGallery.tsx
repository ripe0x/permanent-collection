'use client';

/* The trait gallery grid. SSR'd with its first page (instant paint + SEO),
   then appends further pages from /api/punks-with-trait on "Load more". The
   tile SVGs are rendered server-side and shipped as inner content so the
   client never imports the ~2.4 MB punks-sdk pixel bundle. */

import Link from 'next/link';
import {useCallback, useState} from 'react';

interface Props {
    traitId: number;
    /** Full count of Punks carrying the trait — drives the "X of N" label
     *  and whether more pages remain. */
    total: number;
    initialIds: number[];
    initialSvgs: Record<number, string>;
    pageSize: number;
}

export function TraitGallery({traitId, total, initialIds, initialSvgs, pageSize}: Props) {
    const [ids, setIds] = useState<number[]>(initialIds);
    const [svgs, setSvgs] = useState<Record<number, string>>(initialSvgs);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const remaining = Math.max(0, total - ids.length);

    const loadMore = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(
                `/api/punks-with-trait?traitId=${traitId}&offset=${ids.length}&limit=${pageSize}`,
            );
            if (!res.ok) throw new Error(`Couldn't load more (${res.status})`);
            const data = (await res.json()) as {
                punkIds: number[];
                svgsByPunkId: Record<string, string>;
            };
            setIds((cur) => [...cur, ...data.punkIds]);
            setSvgs((cur) => {
                const next = {...cur};
                for (const [k, v] of Object.entries(data.svgsByPunkId)) next[Number(k)] = v;
                return next;
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [traitId, ids.length, pageSize]);

    return (
        <>
            <ul className="gallery-grid">
                {ids.map((pid) => (
                    <li key={pid} className="gallery-tile">
                        <Link href={`/punk/${pid}`} aria-label={`Punk ${pid}`}>
                            <span className="gallery-punk" role="img" aria-label={`Punk ${pid}`}>
                                <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 24 24"
                                    shapeRendering="crispEdges"
                                    dangerouslySetInnerHTML={{__html: svgs[pid] ?? ''}}
                                />
                            </span>
                            <span className="gallery-id tnum">{pid}</span>
                        </Link>
                    </li>
                ))}
            </ul>
            {remaining > 0 && (
                <div className="gallery-more">
                    <button
                        type="button"
                        className="secondary"
                        onClick={loadMore}
                        disabled={loading}
                    >
                        {loading ? 'Loading…' : `Load ${Math.min(pageSize, remaining)} more`}
                    </button>
                    <span className="gallery-more-count tnum" aria-live="polite">
                        Showing {ids.length} of {total}
                    </span>
                    {error && <span className="gallery-more-error">{error}</span>}
                </div>
            )}
        </>
    );
}
