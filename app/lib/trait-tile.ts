// SERVER-ONLY. JS port of PermanentCollectionMosaicRenderer._appendCell /
// _rlePunk / _rleDiff / _renderCountDots. Used by the collection grid to
// render each cell with the same artwork the on-chain renderer produces
// — so the page mirrors what tokenURI() shows.
//
// Output: SVG inner content (rects only — caller wraps in <svg viewBox>).

import {canonicalPunkId} from './canonical-punks';
import {getPunksSdk} from './punks-sdk';

const DIM = 24;

let _paletteBytes: Uint8Array | null = null;
function getPaletteBytes(): Uint8Array {
    if (_paletteBytes) return _paletteBytes;
    // OfflinePunksDataClient exposes the raw RGBA bytes (4 per palette
    // entry). The high-level dataset wrapper hides this, so reach
    // through `.source`.
    _paletteBytes = getPunksSdk().dataset.source.getPaletteRgbaBytesSync();
    return _paletteBytes;
}

function toHex(n: number): string {
    return n.toString(16).padStart(2, '0');
}

function colorHex(pal: Uint8Array, c: number): string {
    return `#${toHex(pal[c * 4])}${toHex(pal[c * 4 + 1])}${toHex(pal[c * 4 + 2])}`;
}

function emitRun(startCol: number, endCol: number, row: number, color: number, pal: Uint8Array): string {
    const w = endCol - startCol + 1;
    return `<rect x="${startCol}" y="${row}" width="${w}" height="1" fill="${colorHex(pal, color)}"/>`;
}

/** Mirror of MosaicRenderer._rlePunk — full silhouette, transparent pixels skipped. */
function rlePunk(pixels: Uint8Array, pal: Uint8Array): string {
    const out: string[] = [];
    for (let row = 0; row < DIM; row++) {
        let runStart = 0;
        let runColor = 0;
        let inRun = false;
        for (let col = 0; col < DIM; col++) {
            const c = pixels[row * DIM + col];
            const alpha = pal[c * 4 + 3];
            const opaque = alpha !== 0;
            if (!opaque) {
                if (inRun) {
                    out.push(emitRun(runStart, col - 1, row, runColor, pal));
                    inRun = false;
                }
            } else if (!inRun) {
                runStart = col;
                runColor = c;
                inRun = true;
            } else if (c !== runColor) {
                out.push(emitRun(runStart, col - 1, row, runColor, pal));
                runStart = col;
                runColor = c;
            }
        }
        if (inRun) out.push(emitRun(runStart, DIM - 1, row, runColor, pal));
    }
    return out.join('');
}

/** Mirror of MosaicRenderer._rleDiff — emits only pixels where canonical
 *  differs from the head-variant baseline AND canonical is opaque. */
function rleDiff(canonical: Uint8Array, baseline: Uint8Array, pal: Uint8Array): string {
    const out: string[] = [];
    for (let row = 0; row < DIM; row++) {
        let runStart = 0;
        let runColor = 0;
        let inRun = false;
        for (let col = 0; col < DIM; col++) {
            const i = row * DIM + col;
            const c = canonical[i];
            const b = baseline[i];
            const alpha = pal[c * 4 + 3];
            const emit = c !== b && alpha !== 0;
            if (!emit) {
                if (inRun) {
                    out.push(emitRun(runStart, col - 1, row, runColor, pal));
                    inRun = false;
                }
            } else if (!inRun) {
                runStart = col;
                runColor = c;
                inRun = true;
            } else if (c !== runColor) {
                out.push(emitRun(runStart, col - 1, row, runColor, pal));
                runStart = col;
                runColor = c;
            }
        }
        if (inRun) out.push(emitRun(runStart, DIM - 1, row, runColor, pal));
    }
    return out.join('');
}

/** Mirror of MosaicRenderer._renderCountDots — 7-dot strip with `count`
 *  filled. 7 is the maximum number of attributes any CryptoPunk carries,
 *  so the count-7 trait fills all dots. */
function renderCountDots(count: number): string {
    const dotSize = 2;
    const gap = 1;
    const totalDots = 7;
    const totalW = totalDots * dotSize + (totalDots - 1) * gap; // 20
    const startX = (DIM - totalW) / 2; // 2
    const yPos = (DIM - dotSize) / 2; // 11
    const out: string[] = [];
    for (let i = 0; i < totalDots; i++) {
        const x = startX + i * (dotSize + gap);
        const color = i < count ? '#f5f5f5' : '#2a2a2a';
        out.push(`<rect x="${x}" y="${yPos}" width="${dotSize}" height="${dotSize}" fill="${color}"/>`);
    }
    return out.join('');
}

/** Per-trait baselines for the head-variant diff path. Lazily populated. */
const _baselineCache = new Map<number, Uint8Array>();
function getHeadVariantBaseline(hv: number): Uint8Array {
    const cached = _baselineCache.get(hv);
    if (cached) return cached;
    const pid = canonicalPunkId(5 + hv);
    const pixels = getPunksSdk().dataset.indexedPixels(pid);
    _baselineCache.set(hv, pixels);
    return pixels;
}

/**
 * Render an "uncollected" trait tile — what the on-chain renderer draws
 * when a trait hasn't been vaulted yet. Returns SVG inner content
 * (rects), not a full <svg> element.
 *
 *   bits 0..4   Type           → canonical exemplar (a bald variant Punk)
 *   bits 5..15  HeadVariant    → canonical exemplar (bald variant Punk)
 *   bits 16..23 AttributeCount → 7-dot strip with N filled
 *   bits 24..110 Accessory     → diff against the head-variant baseline
 */
export function renderTraitTileContent(traitId: number): string {
    const sdk = getPunksSdk();
    const pal = getPaletteBytes();
    if (traitId < 0 || traitId > 110) {
        throw new Error(`renderTraitTileContent: out of range ${traitId}`);
    }
    if (traitId < 16) {
        // Type or HeadVariant — the canonical IS the trait (a bald head).
        const pid = canonicalPunkId(traitId);
        return rlePunk(sdk.dataset.indexedPixels(pid), pal);
    }
    if (traitId < 24) {
        return renderCountDots(traitId - 16);
    }
    // Accessory — diff against head-variant baseline.
    const pid = canonicalPunkId(traitId);
    const summary = sdk.get(pid);
    const baseline = getHeadVariantBaseline(summary.headVariant);
    return rleDiff(sdk.dataset.indexedPixels(pid), baseline, pal);
}

/** Render the full silhouette of a specific Punk. Used for permanent
 *  cells, which show the actual vaulted Punk that brought the trait
 *  into the collection. */
export function renderPunkTileContent(punkId: number): string {
    return rlePunk(getPunksSdk().dataset.indexedPixels(punkId), getPaletteBytes());
}

/**
 * Per-Punk trait tile — same layout as renderTraitTileContent but anchored to
 * a specific Punk so the tile shows the user *their* trait, not a canonical
 * exemplar. Used in the accept-the-bid step 2 grid: once the owner picks a
 * Punk, each trait card renders the trait as it appears on that Punk.
 *
 *   Type / HeadVariant (0..15): full picked-Punk silhouette — these traits
 *                               *are* the Punk's body, so the canonical
 *                               exemplar trick doesn't help.
 *   AttributeCount   (16..23):  N-of-7 dot strip — purely categorical, no
 *                               per-Punk pixel difference exists.
 *   Accessory       (24..110):  diff the picked Punk's pixels against the
 *                               picked Punk's own head-variant baseline so
 *                               only the accessory's pixels render — in the
 *                               picked Punk's colors, where the punk wears it.
 */
export function renderTraitTileForPunk(traitId: number, punkId: number): string {
    if (traitId < 0 || traitId > 110) {
        throw new Error(`renderTraitTileForPunk: trait out of range ${traitId}`);
    }
    if (!Number.isInteger(punkId) || punkId < 0 || punkId > 9999) {
        throw new Error(`renderTraitTileForPunk: punk out of range ${punkId}`);
    }
    const sdk = getPunksSdk();
    const pal = getPaletteBytes();
    if (traitId < 16) {
        return rlePunk(sdk.dataset.indexedPixels(punkId), pal);
    }
    if (traitId < 24) {
        return renderCountDots(traitId - 16);
    }
    const summary = sdk.get(punkId);
    const baseline = getHeadVariantBaseline(summary.headVariant);
    return rleDiff(sdk.dataset.indexedPixels(punkId), baseline, pal);
}
