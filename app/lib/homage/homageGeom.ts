// Client-side homage geometry: parse a rendered classic SVG into its ground + ordered
// nested squares.
//
// The renderer emits the nested squares in document order (outer -> inner), each with its
// own fill, so the classic SVG already carries the punk's ordered palette.

export type Shape = { x: number; y: number; s: number; fill: string };

/** Pull the ground fill + nested squares (x, y, side, fill) out of a homage SVG
 *  (bare or a data URI, base64 or utf8). Nested rects are square (width == height). */
export function parseHomage(src: string): { ground: string; rects: Shape[] } | null {
    let svg = src;
    const b = src.indexOf(';base64,');
    const u = src.indexOf(';utf8,');
    if (b >= 0) {
        try {
            svg = atob(src.slice(b + 8));
        } catch {
            return null;
        }
    } else if (u >= 0) {
        svg = decodeURIComponent(src.slice(u + 6));
    }
    const rects: Shape[] = [];
    let ground = '#000000';
    const re = /<rect\s+(?:x="(\d+)"\s+y="(\d+)"\s+)?width="(\d+)"\s+height="(\d+)"\s+fill="(#[0-9a-fA-F]{3,8})"\s*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(svg)) !== null) {
        if (m[1] === undefined) ground = m[5]; // the ground rect has no x/y
        else rects.push({ x: +m[1], y: +m[2], s: +m[3], fill: m[5] });
    }
    return rects.length ? { ground, rects } : null;
}
