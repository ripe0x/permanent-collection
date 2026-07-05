/// Render an SVG string safely as an <img> source (no script execution).
export const svgToSrc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/// Turn renderer/punk SVG output into a safe <img> src.
/// - renderer renderSVG/previewSVG return a bare `<svg…>` string.
/// - CryptoPunksData.punkImageSvg returns `data:image/svg+xml;utf8,<svg…>` with the
///   body unescaped — raw `#`/`"` truncate or break it in an <img>, so re-encode it.
export const anySvgToSrc = (s: string) => {
    const utf8Prefix = 'data:image/svg+xml;utf8,';
    if (s.startsWith(utf8Prefix)) return svgToSrc(s.slice(utf8Prefix.length));
    if (s.startsWith('data:')) return s; // already base64 / otherwise complete
    return svgToSrc(s);
};

export type Trait = { trait_type: string; value: string | number; display_type?: string; href?: string };
export type TokenMeta = {
    name?: string;
    description?: string;
    image?: string;
    attributes?: Trait[];
};

/// Decode a `data:application/json;base64,…` (or utf8) token URI into its JSON.
export function decodeTokenURI(uri: string): TokenMeta | null {
    try {
        const comma = uri.indexOf(',');
        if (comma === -1) return null;
        const header = uri.slice(0, comma);
        const payload = uri.slice(comma + 1);
        const json = header.includes('base64')
            ? typeof atob !== 'undefined'
                ? atob(payload)
                : Buffer.from(payload, 'base64').toString('utf8')
            : decodeURIComponent(payload);
        return JSON.parse(json) as TokenMeta;
    } catch {
        return null;
    }
}

export const trait = (m: TokenMeta | null, type: string) =>
    (m?.attributes ?? []).find((t) => t.trait_type === type)?.value;
