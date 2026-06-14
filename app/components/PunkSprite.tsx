/* Renders a CryptoPunk as a 24x24 pixel SVG from PunksData's
   indexedPixelsOf + paletteRgbaBytes. Server-rendered so the page ships
   with the image already drawn (no FOUC, no extra round-trip). */

interface Props {
    /** Row-major palette indices (576 bytes for the 24x24 sprite). */
    indexed: Uint8Array;
    /** Concatenated RGBA bytes the indices look into (4 bytes per color). */
    palette: Uint8Array;
    /** Render size in pixels. Defaults to 480 (20x per pixel). */
    size?: number;
    /** A short alt label. */
    label: string;
}

const W = 24;

export function PunkSprite({indexed, palette, size = 480, label}: Props) {
    const cells: string[] = [];
    for (let i = 0; i < indexed.length; i++) {
        const colorId = indexed[i];
        if (colorId === 0) continue; // transparent
        const r = palette[colorId * 4 + 0];
        const g = palette[colorId * 4 + 1];
        const b = palette[colorId * 4 + 2];
        const a = palette[colorId * 4 + 3];
        if (a === 0) continue;
        const x = i % W;
        const y = Math.floor(i / W);
        const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${hex}"/>`);
    }
    const inner = cells.join('');
    return (
        <div
            className="punk-sprite"
            role="img"
            aria-label={label}
            style={{width: size, height: size}}
        >
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox={`0 0 ${W} ${W}`}
                width={size}
                height={size}
                shapeRendering="crispEdges"
                dangerouslySetInnerHTML={{__html: inner}}
            />
            <style>{styles}</style>
        </div>
    );
}

const styles = `
.punk-sprite {
    background: var(--panel);
    border: 1px solid var(--line);
    display: inline-block;
    line-height: 0;
    image-rendering: pixelated;
}
.punk-sprite svg {
    display: block;
    image-rendering: pixelated;
}
`;
