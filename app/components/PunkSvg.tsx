/* Server-rendered Punk pixel-art tile. Wraps the raw SVG string the
   punks-sdk renders, sized by `size`. Replaces PunkSprite for /collection
   pages where the SDK is available. */

import {getPunksSdk} from '@/lib/punks-sdk';

export interface PunkSvgProps {
    punkId: number;
    /** Rendered pixel size of the square sprite. Default 480 (20x per pixel).
     *  Ignored when `fill` is true. */
    size?: number;
    /** A short alt label for assistive tech. */
    label: string;
    /** SVG background — defaults to transparent so the page bg shows through. */
    background?: 'classic' | 'transparent' | `#${string}`;
    /** Extra CSS class on the wrapper div. */
    className?: string;
    /** Fill the parent container instead of rendering at a fixed pixel size.
     *  The wrapper becomes width/height 100% (square via aspect-ratio); the
     *  inner SVG scales to 100% of the wrapper. Use this when the parent
     *  controls the size (grid cell, aspect-ratio box, fixed-size thumb). */
    fill?: boolean;
}

export function PunkSvg({
    punkId,
    size = 480,
    label,
    background = 'transparent',
    className,
    fill = false,
}: PunkSvgProps) {
    const sdk = getPunksSdk();
    const raw = sdk.render.svg(punkId, {background});
    // SDK returns a self-contained SVG. We re-attach a 100% size so it
    // scales to whichever box the wrapper sits in. The wrapper provides
    // the actual dimensions (either `size` px or 100% of parent).
    const sized = raw
        .replace('<svg ', `<svg width="100%" height="100%" `)
        .replace('shape-rendering=', 'style="display:block;image-rendering:pixelated" shape-rendering=');
    const wrapperStyle: React.CSSProperties = fill
        ? {width: '100%', height: '100%', aspectRatio: '1 / 1'}
        : {width: size, height: size};
    return (
        <div
            className={className ? `punk-svg ${className}` : 'punk-svg'}
            role="img"
            aria-label={label}
            style={wrapperStyle}
            dangerouslySetInnerHTML={{__html: sized}}
        />
    );
}
