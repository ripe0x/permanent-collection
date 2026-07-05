'use client';

// Fully-local homage rendering for /explore: the punk's pixels come from the networked-art SDK's
// bundled data (no RPC), and the homage is drawn by the parity-verified port (lib/homage/local/render.ts).
// Proven byte-identical to the on-chain renderer by scripts/parity-check.mts + scripts/parity-sdk.mts.
//
// The ~15MB pixel bundle is dynamic-imported, so it stays out of the initial page load and only
// loads when the first homage renders. All renders share one SDK instance.

import { useEffect, useState } from 'react';
import { distill, rings, svg, groundForStatus, hex } from './render';
import { anySvgToSrc, type TokenMeta } from '@/lib/homage/svg';

// This is the client-side lazy SDK instance: the pixel bundle loads on demand in the browser via
// dynamic import, one instance shared across every render. The `@/lib/punks-sdk` singleton is
// server-only (its pixel bundle must never reach the client bundle), so it's deliberately NOT
// reused here — this module needs its own lazily-loaded, browser-side instance.
type Loaded = {
    sdk: {
        dataset: { indexedPixels: (id: number) => Uint8Array; palette: () => { id: number; r: number; g: number; b: number; a: number }[] };
        render: { metadata: (id: number) => { attributes?: { trait_type: string; value: string | number }[] } };
    };
    palById: { r: number; g: number; b: number; a: number }[];
};

let loading: Promise<Loaded> | null = null;
function getSdk(): Promise<Loaded> {
    if (!loading) {
        loading = (async () => {
            const [{ createPunksSdk }, { bundledOfflinePunksDataWithPixels }] = await Promise.all([
                import('@networked-art/punks-sdk'),
                import('@networked-art/punks-sdk/offline-pixel-data'),
            ]);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sdk = createPunksSdk({ dataset: bundledOfflinePunksDataWithPixels }) as any;
            const palById: Loaded['palById'] = [];
            for (const e of sdk.dataset.palette()) palById[e.id] = e;
            return { sdk, palById };
        })();
    }
    return loading;
}

// Reconstruct the raw transparent-background RGBA (as CryptoPunksData.punkImage returns) from the
// SDK's indexed pixels + palette — index 0 is transparent. (render.rgba composites onto a solid
// background, which our distillation must not see.)
function pixels({ sdk, palById }: Loaded, id: number): Uint8Array {
    const idx = sdk.dataset.indexedPixels(id);
    const img = new Uint8Array(2304);
    for (let p = 0; p < 576; p++) {
        const e = palById[idx[p]];
        const o = p * 4;
        img[o] = e.r;
        img[o + 1] = e.g;
        img[o + 2] = e.b;
        img[o + 3] = e.a;
    }
    return img;
}

const STATUS_LABEL = ['Not For Sale', 'Wrapped', 'For Sale', 'Has Bid'];

export type LocalHomage = { svg: string; colorCount: number; type: string; accessories: string[] };

/** Render a punk's homage fully locally. `status` colours the ground (default 0 = not for sale). */
export async function localHomage(id: number, opts: { status?: number; circle?: boolean } = {}): Promise<LocalHomage> {
    const loaded = await getSdk();
    const img = pixels(loaded, id);
    const { cols, cnts } = distill(img);
    const svgStr = svg(groundForStatus(opts.status ?? 0), rings(cols, cnts), opts.circle ?? false);
    const attrs = loaded.sdk.render.metadata(id).attributes ?? [];
    const type = String(
        attrs.find((a) => a.trait_type === 'Head Variant')?.value ?? attrs.find((a) => a.trait_type === 'Type')?.value ?? ''
    );
    const accessories = attrs.filter((a) => a.trait_type === 'Accessory').map((a) => String(a.value));
    return { svg: svgStr, colorCount: cols.length, type, accessories };
}

function toMeta(h: LocalHomage, status: number): TokenMeta {
    return {
        image: h.svg,
        attributes: [
            { trait_type: 'Punk Type', value: h.type },
            ...h.accessories.map((a) => ({ trait_type: 'Punk Accessory', value: a })),
            { trait_type: 'Accessory Count', value: h.accessories.length },
            { trait_type: 'Color Count', value: h.colorCount },
            { trait_type: 'Status', value: STATUS_LABEL[status] ?? STATUS_LABEL[0] },
        ],
    };
}

/** /explore hero — same shape as useSamplePreview, rendered locally (classic SVG; MorphArt morphs to PFP). */
export function useLocalSample(id: number, status = 0) {
    const [state, setState] = useState<{ src?: string; meta?: TokenMeta; isLoading: boolean }>({ isLoading: true });
    useEffect(() => {
        let cancelled = false;
        setState((s) => ({ ...s, isLoading: true }));
        localHomage(id, { status })
            .then((h) => {
                if (cancelled) return;
                setState({ src: anySvgToSrc(h.svg), meta: toMeta(h, status), isLoading: false });
            })
            .catch(() => {
                if (!cancelled) setState({ isLoading: false });
            });
        return () => {
            cancelled = true;
        };
    }, [id, status]);
    return state;
}

/**
 * The actual punk, rendered locally from the SDK's bundled pixels: 24×24 crisp-edges SVG over
 * the same status ground the homage uses. Horizontal same-colour runs merge into one rect;
 * semi-transparent pixels (shades/beards) keep their alpha via fill-opacity.
 */
export async function localPunkSvg(id: number, status = 0): Promise<string> {
    const loaded = await getSdk();
    const img = pixels(loaded, id);
    let rects = '';
    for (let y = 0; y < 24; y++) {
        let x = 0;
        while (x < 24) {
            const o = (y * 24 + x) * 4;
            const a = img[o + 3];
            if (a === 0) {
                x++;
                continue;
            }
            const rgb = (img[o] << 16) | (img[o + 1] << 8) | img[o + 2];
            let run = 1;
            while (x + run < 24) {
                const o2 = (y * 24 + x + run) * 4;
                if (img[o2 + 3] !== a || ((img[o2] << 16) | (img[o2 + 1] << 8) | img[o2 + 2]) !== rgb) break;
                run++;
            }
            const op = a === 255 ? '' : ` fill-opacity="${(a / 255).toFixed(3)}"`;
            rects += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${hex(rgb)}"${op}/>`;
            x += run;
        }
    }
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">` +
        `<rect width="24" height="24" fill="${hex(groundForStatus(status))}"/>` +
        rects +
        `</svg>`
    );
}

/** /explore punk view — the raw punk for `id`, or nothing while `id` is null (view off). */
export function useLocalPunk(id: number | null, status = 0) {
    const [state, setState] = useState<{ id: number; src: string } | null>(null);
    useEffect(() => {
        if (id === null) return; // keep the last punk mounted so toggling off doesn't flash
        let cancelled = false;
        localPunkSvg(id, status)
            .then((s) => {
                if (!cancelled) setState({ id, src: anySvgToSrc(s) });
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [id, status]);
    return id !== null && state?.id === id ? { src: state.src } : { src: undefined };
}

/** /explore grid cell — just the classic src, rendered locally. */
export function useLocalArt(id: number, status = 0) {
    const [src, setSrc] = useState<string>();
    useEffect(() => {
        let cancelled = false;
        localHomage(id, { status })
            .then((h) => {
                if (!cancelled) setSrc(anySvgToSrc(h.svg));
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [id, status]);
    return { src };
}
