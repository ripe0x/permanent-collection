// Client-side port of PermanenceRenderer.sol — byte-identical to the on-chain output.
//
// Input is the punk's raw pixels (DATA.punkImage(id): 2304 bytes RGBA, 576 pixels) + market
// status. Everything else (distillation, rec ordering, sized-to-count geometry, SVG string) is
// pure integer arithmetic on small numbers — no BigInt, no keccak, no adjacency grid (the rec
// ordering is deterministic, so `grid` and `seed` are unused on-chain too).
//
// Parity is verified against the deployed contract by scripts/parity-check.mts. Every integer op
// here mirrors Solidity's: `/` is floored division (Math.floor), `& 1` for even-ing, strict `>`
// comparisons keep the first index on ties (matching the contract's selection + stable sorts).

// ---- constants (must match the contract) ----
const MERGE_T = 24; // fold shades within this RGB Manhattan distance
const W_OUTER = (240 * 4) / 5; // 192, fixed outer field
const MIN_CENTER = 10;
const MAX_RINGS = W_OUTER / MIN_CENTER; // 19, palette cap
const W_CHROMA = 7;
const W_RARITY = 3;
const UNIT = 240;
const ANCHOR = 6;

// status ground colours (cryptopunks.app), matching the contract
const G_NONE = 0x6a8494;
const G_WRAP = 0x75a475;
const G_SALE = 0x8c5851;
const G_BID = 0x8970b1;

export function groundForStatus(status: number): number {
    if (status === 1) return G_WRAP;
    if (status === 2) return G_SALE;
    if (status === 3) return G_BID;
    return G_NONE;
}

const r8 = (c: number) => (c >> 16) & 0xff;
const g8 = (c: number) => (c >> 8) & 0xff;
const b8 = (c: number) => c & 0xff;

/** RGB Manhattan distance — the contract's `_dist`. */
function dist(a: number, b: number): number {
    return Math.abs(r8(a) - r8(b)) + Math.abs(g8(a) - g8(b)) + Math.abs(b8(a) - b8(b));
}

/** R+G+B luminance proxy — the contract's `_lum`. */
function lum(c: number): number {
    return r8(c) + g8(c) + b8(c);
}

/** "#rrggbb", lowercase, always 6 hex — the contract's `_hex`. */
export function hex(c: number): string {
    return '#' + (c >>> 0).toString(16).padStart(6, '0');
}

/**
 * `_colorsGrid` colour half: pixels -> distilled colours (value) + counts, count-descending.
 * The per-pixel `grid` the contract also builds is skipped: the rec ordering ignores it, so it
 * has no effect on cols/cnts or the SVG. Returns colours as 0xRRGGBB numbers.
 */
export function distill(img: Uint8Array): { cols: number[]; cnts: number[] } {
    const col: number[] = [];
    const cnt: number[] = [];
    let n = 0;
    for (let p = 0; p < 576; p++) {
        const o = p * 4;
        if (img[o + 3] < 128) continue; // transparent
        const rgb = (img[o] << 16) | (img[o + 1] << 8) | img[o + 2];
        let f = n;
        for (let k = 0; k < n; k++) {
            if (col[k] === rgb) {
                f = k;
                break;
            }
        }
        if (f === n) {
            col[n] = rgb;
            cnt[n] = 1;
            n++;
        } else {
            cnt[f]++;
        }
    }

    // order by count desc; stable (ties keep original index) — matches the contract's insertion sort
    const ord: number[] = [];
    for (let i = 0; i < n; i++) ord[i] = i;
    for (let i = 1; i < n; i++) {
        const v = ord[i];
        let j = i;
        while (j > 0 && cnt[ord[j - 1]] < cnt[v]) {
            ord[j] = ord[j - 1];
            j--;
        }
        ord[j] = v;
    }

    // distill: fold near-identical shades (Manhattan < MERGE_T); representative = the more common
    const mc: number[] = [];
    const mn: number[] = [];
    const used: boolean[] = new Array(n).fill(false);
    let m = 0;
    for (let a = 0; a < n; a++) {
        const i = ord[a];
        if (used[i]) continue;
        let c = cnt[i];
        for (let b = a + 1; b < n; b++) {
            const j = ord[b];
            if (!used[j] && dist(col[i], col[j]) < MERGE_T) {
                used[j] = true;
                c += cnt[j];
            }
        }
        mc[m] = col[i];
        mn[m] = c;
        m++;
    }

    // cap to MAX_RINGS: fold the two NEAREST distilled colours (rarer into the more common)
    const gone: boolean[] = new Array(m).fill(false);
    let liveN = m;
    while (liveN > MAX_RINGS) {
        let bi = 0;
        let bj = 0;
        let bestD = Infinity;
        for (let i = 0; i < m; i++) {
            if (gone[i]) continue;
            for (let j = i + 1; j < m; j++) {
                if (gone[j]) continue;
                const dd = dist(mc[i], mc[j]);
                if (dd < bestD) {
                    bestD = dd;
                    bi = i;
                    bj = j;
                }
            }
        }
        if (mn[bi] < mn[bj]) {
            const t = bi;
            bi = bj;
            bj = t;
        }
        mn[bi] += mn[bj];
        gone[bj] = true;
        liveN--;
    }

    // compact survivors in original distilled order (still count-desc from the distill pass)
    const cols: number[] = [];
    const cnts: number[] = [];
    for (let i = 0; i < m; i++) {
        if (!gone[i]) {
            cols.push(mc[i]);
            cnts.push(mn[i]);
        }
    }
    return { cols, cnts };
}

/**
 * `_rings` rec ordering: dominant colour (largest area) -> outer, accent (chroma+rarity) -> centre
 * jewel, the rest a value ramp flowing dominant -> accent. Deterministic (no shuffle).
 */
export function rings(cols: number[], cnts: number[]): number[] {
    const m = cols.length;
    if (m === 0) return [];
    if (m === 1) return [cols[0]];

    let maxCnt = 1;
    for (let i = 0; i < m; i++) if (cnts[i] > maxCnt) maxCnt = cnts[i];
    let bestAcc = 0;
    let acc = 0;
    for (let i = 0; i < m; i++) {
        const c = cols[i];
        const r = r8(c);
        const g = g8(c);
        const b = b8(c);
        let mx = r;
        if (g > mx) mx = g;
        if (b > mx) mx = b;
        let mnv = r;
        if (g < mnv) mnv = g;
        if (b < mnv) mnv = b;
        const score = (mx - mnv) * W_CHROMA + (255 - Math.floor((cnts[i] * 255) / maxCnt)) * W_RARITY;
        if (score > bestAcc) {
            bestAcc = score;
            acc = i;
        }
    }

    let dom = acc === 0 ? 1 : 0;
    for (let i = 0; i < m; i++) {
        if (i === acc) continue;
        if (cnts[i] > cnts[dom]) dom = i;
    }

    const mid: number[] = [];
    for (let i = 0; i < m; i++) if (i !== dom && i !== acc) mid.push(i);
    const asc = lum(cols[dom]) <= lum(cols[acc]);
    for (let i = 1; i < mid.length; i++) {
        const v = mid[i];
        const lv = lum(cols[v]);
        let j = i;
        while (j > 0 && (asc ? lum(cols[mid[j - 1]]) > lv : lum(cols[mid[j - 1]]) < lv)) {
            mid[j] = mid[j - 1];
            j--;
        }
        mid[j] = v;
    }

    const order: number[] = [cols[dom]];
    for (let i = 0; i < mid.length; i++) order.push(cols[mid[i]]);
    order.push(cols[acc]);
    return order;
}

/**
 * Pure-luminance ordering: distilled colours sorted darkest -> lightest (outer -> centre) — a plain
 * value ramp, ignoring the dominant/accent logic. NOT the on-chain order; offered on the preview
 * page for comparison. Stable sort, so equal-luminance colours keep their count-descending order.
 */
export function ringsLuminance(cols: number[]): number[] {
    return [...cols].sort((a, b) => lum(a) - lum(b));
}

/** One nested element — the contract's `_shape`. Widths are even, so circle centre/radius are exact. */
function shape(x: number, y: number, s: number, c: number, circle: boolean): string {
    if (circle) {
        const r = Math.floor(s / 2);
        return `<circle cx="${x + r}" cy="${y + r}" r="${r}" fill="${hex(c)}"/>`;
    }
    return `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${hex(c)}"/>`;
}

/** `_svg`: ground + N equal bands sized to the colour count, anchored low (Albers 1:2:3). */
export function svg(ground: number, order: number[], circles: boolean): string {
    const N = order.length;
    let inner = '';
    for (let k = 0; k < N; k++) {
        let w = Math.floor((W_OUTER * (N - k)) / N);
        w -= w & 1; // even width => exact circle centre + radius
        const mm = UNIT - w;
        inner += shape(Math.floor(mm / 2), Math.floor((ANCHOR * mm) / 8), w, order[k], circles);
    }
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"' +
        (circles ? '>' : ' shape-rendering="crispEdges">') +
        `<rect width="240" height="240" fill="${hex(ground)}"/>` +
        inner +
        '</svg>'
    );
}

/**
 * Full homage SVG from a punk's raw pixels + market status. With the default `order: "rec"` it's
 * byte-identical to renderSVG/previewSVG; `order: "luminance"` swaps in the pure-luminance ordering
 * (preview-only comparison, not on-chain).
 */
export function renderHomageSVG(
    img: Uint8Array,
    opts: { status?: number; circle?: boolean; order?: 'rec' | 'luminance' } = {}
): string {
    const { cols, cnts } = distill(img);
    const ordered = opts.order === 'luminance' ? ringsLuminance(cols) : rings(cols, cnts);
    return svg(groundForStatus(opts.status ?? 0), ordered, opts.circle ?? false);
}

/** Distilled colour count (= ring count) from raw pixels — the contract's `colorCount`. */
export function colorCountFromPixels(img: Uint8Array): number {
    return distill(img).cols.length;
}
