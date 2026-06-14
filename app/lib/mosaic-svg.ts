// SERVER-ONLY. Builds the homepage mosaic image as a single SVG string,
// reproducing PermanentCollectionMosaicRenderer._renderSvg's layout (canvas,
// cell geometry, colors, pulled-out cell, pixel-font footer) but sourcing
// every cell's artwork from lib/trait-tile.ts — the SAME module the
// /collection grid renders from. That shared source is what makes the two
// surfaces agree by construction, including the six "rotation" type/head
// cells the on-chain renderer cycles per block: both draw the fixed
// canonical exemplar here, so the homepage and /collection never diverge.
//
// The homepage image is deliberately NOT a per-block-faithful copy of the
// live renderer (its rotation cells change every block); it mirrors what the
// collection page shows.

import {canonicalPunkId} from './canonical-punks';
import type {TraitView} from './data/types';
import {renderPunkTileContent, renderTraitTileContent} from './trait-tile';
import {GRID_COLS, GRID_ROWS, PULLED_TRAIT_ID, traitAt} from './trait-grid-layout';

// Geometry — mirrors the on-chain renderer's constants exactly.
const PUNK_DIM = 24;
const CELL = 28; // 24px punk + 4px gap
const PAD = 24;
const WIDTH = GRID_COLS * CELL + PAD * 2; // 356
const HEIGHT = WIDTH; // square; bottom slot holds footer + pulled cell
const OUTPUT_SCALE = 8; // large intrinsic size for crisp "Copy Image"
const OUTPUT_WIDTH = WIDTH * OUTPUT_SCALE; // 2848
const OUTPUT_HEIGHT = HEIGHT * OUTPUT_SCALE;
const PULLED_CELL_X = 306; // PAD + (COLS-1)*CELL + 2
const PULLED_CELL_Y = 306; // PAD + ROWS*CELL + 2

// Colors — mirror the on-chain renderer.
const BG_COLOR = '#000';
const TEXT_COLOR = '#f5f5f5';
const DIM_TEXT = '#6a6a6a';
const UNCOLLECTED_COLOR = '#1c1c1c';
const PENDING_STROKE = '#454545';
const COLLECTED_COLOR = '#8F918B';

function flatCell(cx: number, cy: number, fill: string): string {
    return `<rect x="${cx}" y="${cy}" width="${PUNK_DIM}" height="${PUNK_DIM}" fill="${fill}"/>`;
}

function dashedBorder(cx: number, cy: number): string {
    // Half-pixel offset + 25×25 rect so the 1px stroke snaps to the pixel
    // ring immediately outside the cell under crispEdges.
    return (
        `<rect x="${cx - 1}.5" y="${cy - 1}.5" width="${PUNK_DIM + 1}" height="${PUNK_DIM + 1}"` +
        ` fill="none" stroke="${PENDING_STROKE}" stroke-dasharray="2 2"/>`
    );
}

/** One mosaic cell. Uses trait-tile.ts for the artwork so it matches the
 *  /collection grid cell for the same trait + state. */
function cell(t: TraitView, cx: number, cy: number): string {
    if (t.state === 'permanent') {
        const punk = t.firstVaultedPunkId ?? canonicalPunkId(t.traitId);
        return (
            flatCell(cx, cy, COLLECTED_COLOR) +
            `<g transform="translate(${cx} ${cy})">${renderPunkTileContent(punk)}</g>`
        );
    }
    const icon = `<g transform="translate(${cx} ${cy})">${renderTraitTileContent(t.traitId)}</g>`;
    const border = t.state === 'pending' ? dashedBorder(cx, cy) : '';
    return flatCell(cx, cy, UNCOLLECTED_COLOR) + icon + border;
}

// ────────── pixel-font footer (mirrors the on-chain 5×7 glyph table) ──────────

// 27 glyphs × 7 rows, 5 bits/row. Index order matches the renderer's
// _glyphIndex: space, 0-9, /, A, C, D, E, F, I, L, M, N, O, P, R, S, T, U.
const GLYPHS = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // space
    0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e, // 0
    0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e, // 1
    0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f, // 2
    0x1e, 0x01, 0x01, 0x0e, 0x01, 0x01, 0x1e, // 3
    0x11, 0x11, 0x11, 0x1f, 0x01, 0x01, 0x01, // 4
    0x1f, 0x10, 0x10, 0x1e, 0x01, 0x01, 0x1e, // 5
    0x0e, 0x11, 0x10, 0x1e, 0x11, 0x11, 0x0e, // 6
    0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08, // 7
    0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e, // 8
    0x0e, 0x11, 0x11, 0x0f, 0x01, 0x11, 0x0e, // 9
    0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10, // /
    0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11, // A
    0x0f, 0x10, 0x10, 0x10, 0x10, 0x10, 0x0f, // C
    0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e, // D
    0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f, // E
    0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10, // F
    0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1f, // I
    0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f, // L
    0x11, 0x1b, 0x15, 0x11, 0x11, 0x11, 0x11, // M
    0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11, // N
    0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e, // O
    0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10, // P
    0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11, // R
    0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e, // S
    0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, // T
    0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e, // U
];

function glyphIndex(c: number): number {
    if (c === 0x20) return 0; // space
    if (c >= 0x30 && c <= 0x39) return 1 + (c - 0x30); // 0..9
    if (c === 0x2f) return 11; // /
    const map: Record<number, number> = {
        0x41: 12, // A
        0x43: 13, // C
        0x44: 14, // D
        0x45: 15, // E
        0x46: 16, // F
        0x49: 17, // I
        0x4c: 18, // L
        0x4d: 19, // M
        0x4e: 20, // N
        0x4f: 21, // O
        0x50: 22, // P
        0x52: 23, // R
        0x53: 24, // S
        0x54: 25, // T
        0x55: 26, // U
    };
    return map[c] ?? 0;
}

function pixelText(text: string, x0: number, y0: number, color: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const cx = x0 + i * 6;
        const base = glyphIndex(text.charCodeAt(i)) * 7;
        for (let row = 0; row < 7; row++) {
            const bits = GLYPHS[base + row];
            if (bits === 0) continue;
            let runStart = 0;
            let inRun = false;
            for (let col = 0; col < 5; col++) {
                const on = ((bits >> (4 - col)) & 1) === 1;
                if (on && !inRun) {
                    runStart = col;
                    inRun = true;
                } else if (!on && inRun) {
                    out += `<rect x="${cx + runStart}" y="${y0 + row}" width="${col - runStart}" height="1" fill="${color}"/>`;
                    inRun = false;
                }
            }
            if (inRun) {
                out += `<rect x="${cx + runStart}" y="${y0 + row}" width="${5 - runStart}" height="1" fill="${color}"/>`;
            }
        }
    }
    return out;
}

function footer(count: number): string {
    return (
        pixelText(`${count} / 111`, 26, 312, DIM_TEXT) +
        pixelText('PERMANENT COLLECTION', 26, 323, TEXT_COLOR)
    );
}

/**
 * Build the full mosaic SVG for the given trait states. The output mirrors
 * the on-chain renderer's tokenURI() image, but every cell is drawn from
 * lib/trait-tile.ts so it stays pixel-consistent with the /collection grid.
 *
 * @param traits the 111 trait states (any order; indexed by traitId).
 */
export function buildMosaicSvg(traits: TraitView[]): string {
    const byTraitId = new Map(traits.map((t) => [t.traitId, t]));
    const get = (id: number): TraitView => byTraitId.get(id) ?? {traitId: id, state: 'uncollected'};

    let cells = '';
    for (let pos = 0; pos < GRID_COLS * GRID_ROWS; pos++) {
        const traitId = traitAt(pos);
        const col = pos % GRID_COLS;
        const row = Math.floor(pos / GRID_COLS);
        const cx = PAD + col * CELL + 2;
        const cy = PAD + row * CELL + 2;
        cells += cell(get(traitId), cx, cy);
    }
    // Pulled-out "final type" cell beneath the grid.
    cells += cell(get(PULLED_TRAIT_ID), PULLED_CELL_X, PULLED_CELL_Y);

    const count = traits.filter((t) => t.state === 'permanent').length;

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_WIDTH}" height="${OUTPUT_HEIGHT}"` +
        ` viewBox="0 0 ${WIDTH} ${HEIGHT}" shape-rendering="crispEdges">` +
        `<rect width="100%" height="100%" fill="${BG_COLOR}"/>` +
        cells +
        footer(count) +
        '</svg>'
    );
}
