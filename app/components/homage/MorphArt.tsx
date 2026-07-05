'use client';

import { useMemo } from 'react';
import { parseHomage } from '@/lib/homage/homageGeom';
import { HomageSvg } from './HomageSvg';

/**
 * Draws the homage inline (parsed from the classic SVG) so the squares can *morph* to
 * circles on the client, no extra fetch. Thin wrapper over {@link HomageSvg}; the sizing
 * study reuses the same parser + renderer via {@link CompareArt}.
 */
export function MorphArt({ src, circle, className }: { src: string; circle: boolean; className?: string }) {
    const parsed = useMemo(() => parseHomage(src), [src]);
    if (!parsed) return null;
    return <HomageSvg ground={parsed.ground} rects={parsed.rects} circle={circle} className={className} />;
}
