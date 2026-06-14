/* 11×10 trait grid + one pulled-out "final type" cell — mirrors
   PermanentCollectionMosaicRenderer._traitAt exactly so the page matches what
   tokenURI() renders.

     rows 0..6  cols 0..10   Accessories 24..100      (77 cells)
     row  7     cols 0..9    Accessories 101..110     (10 cells)
     row  7     col  10      AttributeCount 16        ( 1 cell)
     row  8     cols 0..6    AttributeCounts 17..23   ( 7 cells)
     row  8     cols 7..10   HeadVariants 5..8        ( 4 cells)
     row  9     cols 0..6    HeadVariants 9..15       ( 7 cells)
     row  9     cols 7..10   Types 0..3               ( 4 cells)
     — pulled out beneath the grid (bottom-right) — Type 4 (Zombie)

   Per-cell artwork:
   - permanent   → actual vaulted Punk on #8F918B (collection tile color)
   - pending     → isolated trait visual on dim bg + 1-px dashed #454545 border
   - uncollected → isolated trait visual on dim bg

   Hover (and keyboard-focus) on a cell reveals a flyout card with the
   trait's name, kind, state, supply and rarity. Pure CSS — no JS. Cells
   in the top half pop the flyout DOWN, bottom half pop UP, so it never
   leaves the grid container.
*/
import Link from 'next/link';
import {canonicalPunkId} from '@/lib/canonical-punks';
import type {TraitView} from '@/lib/data/types';
import {formatEth, formatPunk} from '@/lib/format';
import {getPunksSdk} from '@/lib/punks-sdk';
import {renderPunkTileContent, renderTraitTileContent} from '@/lib/trait-tile';
import {
    GRID_COLS as COLS,
    GRID_ROWS as ROWS,
    PULLED_TRAIT_ID,
    traitAt,
} from '@/lib/trait-grid-layout';

const TOTAL_PUNKS = 10_000;

export function TraitGrid({traits}: {traits: TraitView[]}) {
    const sdk = getPunksSdk();
    const traitRecords = new Map(sdk.dataset.traits().map((t) => [t.id, t]));
    const byTraitId = new Map(traits.map((t) => [t.traitId, t]));
    const buildCell = (
        traitId: number,
        key: string,
        flyoutSide: 'up' | 'down',
        pulled = false,
    ): React.ReactNode => {
        const t = byTraitId.get(traitId)!;
        const rec = traitRecords.get(traitId);
        const traitName = rec?.name ?? `Trait #${traitId}`;
        const supply = rec?.supply ?? 0;
        const rarityPct = (supply / TOTAL_PUNKS) * 100;
        const kind = rec?.kind ?? '';

        let svgInner: string;
        let representativePunk: number | undefined;
        if (t.state === 'permanent') {
            representativePunk = t.firstVaultedPunkId ?? canonicalPunkId(traitId);
            svgInner = renderPunkTileContent(representativePunk);
        } else {
            svgInner = renderTraitTileContent(traitId);
            representativePunk = canonicalPunkId(traitId);
        }
        // The flyout's preview tile reuses the grid-cell artwork.
        const flyoutPreview = svgInner;

        const stateLabel =
            t.state === 'permanent'
                ? 'Permanent'
                : t.state === 'pending'
                  ? 'In return auction'
                  : 'Uncollected';

        const aria =
            t.state === 'permanent'
                ? `${traitName} — permanent, Punk #${representativePunk}`
                : t.state === 'pending'
                  ? `${traitName} — in return auction`
                  : `${traitName} — uncollected`;

        return (
            <div
                key={key}
                className={`grid-cell-wrap grid-cell-flyout-${flyoutSide}${pulled ? ' grid-cell-pulled' : ''}`}
            >
                <Link
                    href={`/collection/${traitId}`}
                    className={`grid-cell grid-cell-${t.state}`}
                    aria-label={aria}
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        shapeRendering="crispEdges"
                        dangerouslySetInnerHTML={{__html: svgInner}}
                    />
                </Link>
                <div className="cell-flyout" role="tooltip" aria-hidden="true">
                    <div className={`flyout-preview flyout-preview-${t.state}`}>
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            shapeRendering="crispEdges"
                            dangerouslySetInnerHTML={{__html: flyoutPreview}}
                        />
                    </div>
                    <div className="flyout-body">
                        <div className="flyout-head">
                            <span className="flyout-name">{traitName}</span>
                            <span className="flyout-meta">
                                {kind} · #{traitId}
                            </span>
                        </div>
                        <div className={`flyout-state flyout-state-${t.state}`}>
                            <span className="flyout-state-dot" aria-hidden="true" />
                            {stateLabel}
                        </div>
                        <dl className="flyout-stats">
                            <div className="flyout-stat">
                                <dt>Supply</dt>
                                <dd className="tnum">
                                    {supply.toLocaleString()}
                                    <span className="dim"> / 10,000</span>
                                </dd>
                            </div>
                            <div className="flyout-stat">
                                <dt>Rarity</dt>
                                <dd className="tnum">{rarityPct.toFixed(2)}%</dd>
                            </div>
                            {t.state === 'permanent' && t.firstVaultedPunkId !== undefined && (
                                <div className="flyout-stat">
                                    <dt>Vaulted</dt>
                                    <dd>{formatPunk(t.firstVaultedPunkId)}</dd>
                                </div>
                            )}
                            {t.state === 'permanent' && t.acceptedBidWei !== undefined && (
                                <div className="flyout-stat">
                                    <dt>For</dt>
                                    <dd className="tnum">{formatEth(t.acceptedBidWei)}</dd>
                                </div>
                            )}
                            {/* Owned-by-viewer and floor-price are wishlist fields.
                                Wallet ownership: needs the connected address's Punk
                                holdings (no ERC-721 enumerable on 2017 punks, so this
                                wants a Reservoir/Alchemy lookup, not RPC). Floor:
                                cheapest live listing for any Punk carrying this trait
                                — also a Reservoir-style call. Both are placeholder
                                rows for now; wire them up to a real source later. */}
                            <div className="flyout-stat flyout-stat-pending">
                                <dt>You own</dt>
                                <dd className="dim">—</dd>
                            </div>
                            <div className="flyout-stat flyout-stat-pending">
                                <dt>Floor</dt>
                                <dd className="dim">—</dd>
                            </div>
                        </dl>
                        <div className="flyout-foot">Click to open</div>
                    </div>
                </div>
            </div>
        );
    };

    const cells: React.ReactNode[] = [];
    for (let pos = 0; pos < COLS * ROWS; pos++) {
        const row = Math.floor(pos / COLS);
        // Top half pops the flyout down, bottom half up, so it stays in-grid.
        cells.push(buildCell(traitAt(pos), String(pos), row <= 4 ? 'down' : 'up'));
    }
    // The "final type" (Type 4) is pulled out beneath the grid's bottom-right,
    // exactly as the on-chain renderer composes it.
    cells.push(buildCell(PULLED_TRAIT_ID, 'pulled', 'up', true));

    return (
        <div className="trait-grid-wrap">
            <div className="trait-grid-legend" aria-label="Trait state legend">
                <span className="legend-row">
                    <span className="legend-swatch legend-permanent" aria-hidden="true" />
                    <span>Permanent</span>
                </span>
                <span className="legend-row">
                    <span className="legend-swatch legend-pending" aria-hidden="true" />
                    <span>In return auction</span>
                </span>
                <span className="legend-row">
                    <span className="legend-swatch legend-uncollected" aria-hidden="true" />
                    <span>Uncollected</span>
                </span>
            </div>
            <div
                role="grid"
                aria-label="111 trait slots"
                aria-rowcount={11}
                aria-colcount={11}
                className="trait-grid"
            >
                {cells}
            </div>
            <style>{styles}</style>
        </div>
    );
}

const PERMANENT_BG = '#8F918B';
const UNCOLLECTED_BG = '#1c1c1c';
// Pending tiles share UNCOLLECTED_BG and add a 1-px dashed border in
// PENDING_STROKE, matching the on-chain Mosaic renderer's pending visual.
const PENDING_STROKE = '#454545';
const GRID_BG = '#0a0a0a';
const FLYOUT_BG = '#0a0a0a';
const FLYOUT_TEXT = '#f5f5f5';
const FLYOUT_DIM = '#9a9a9a';

const styles = `
.trait-grid-wrap {
    display: flex;
    flex-direction: column;
    gap: 20px;
    align-items: stretch;
    width: 100%;
}
.trait-grid-legend {
    display: flex;
    gap: 24px;
    flex-wrap: wrap;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
}
.legend-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
}
.legend-swatch {
    width: 14px;
    height: 14px;
    display: inline-block;
}
.legend-permanent { background: ${PERMANENT_BG}; }
.legend-pending {
    background: ${UNCOLLECTED_BG};
    outline: 1px dashed ${PENDING_STROKE};
    outline-offset: 1px;
}
.legend-uncollected { background: ${UNCOLLECTED_BG}; }

.trait-grid {
    display: grid;
    grid-template-columns: repeat(11, 1fr);
    gap: 6px;
    width: 100%;
    padding: 24px;
    background: ${GRID_BG};
    /* Allow the hover flyout to escape the grid bounds. */
    overflow: visible;
    position: relative;
}
.grid-cell-wrap {
    position: relative;
    aspect-ratio: 1;
}
.grid-cell {
    display: block;
    width: 100%;
    height: 100%;
    background: ${UNCOLLECTED_BG};
    transition: transform 90ms ease, outline-color 90ms ease;
    outline: 1px solid transparent;
    position: relative;
    z-index: 0;
}
.grid-cell-wrap:hover .grid-cell,
.grid-cell-wrap:focus-within .grid-cell {
    transform: scale(1.08);
    z-index: 2;
    outline-color: rgba(245, 245, 245, 0.55);
}
.grid-cell-permanent { background: ${PERMANENT_BG}; }
.grid-cell-pending {
    background: ${UNCOLLECTED_BG};
    outline-style: dashed;
    outline-color: ${PENDING_STROKE};
    outline-offset: 1px;
}
.grid-cell-uncollected { background: ${UNCOLLECTED_BG}; }
.grid-cell svg {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    shape-rendering: crispEdges;
}
/* The "final type" cell pulled out beneath the grid's bottom-right,
   mirroring the on-chain renderer's pulled-out tile. It lands in the last
   column of an 11th grid row; the standard grid gap keeps its spacing
   consistent with every other row. */
.grid-cell-pulled {
    grid-column: 11;
}

/* ── Hover flyout ────────────────────────────────────────────────── */

.cell-flyout {
    position: absolute;
    left: 50%;
    transform: translateX(-50%) scale(0.96);
    width: 240px;
    background: ${FLYOUT_BG};
    color: ${FLYOUT_TEXT};
    border: 1px solid #2a2a2a;
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.55);
    padding: 0;
    z-index: 50;
    opacity: 0;
    pointer-events: none;
    transition: opacity 110ms ease, transform 110ms ease;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
}
.grid-cell-flyout-down .cell-flyout {
    top: calc(100% + 10px);
}
.grid-cell-flyout-up .cell-flyout {
    bottom: calc(100% + 10px);
}
.grid-cell-wrap:hover .cell-flyout,
.grid-cell-wrap:focus-within .cell-flyout {
    opacity: 1;
    transform: translateX(-50%) scale(1);
}
/* Clamp flyout near the left/right grid edges so it doesn't clip off. */
.grid-cell-wrap:nth-child(11n + 1) .cell-flyout,
.grid-cell-wrap:nth-child(11n + 2) .cell-flyout {
    left: 0;
    transform: translateX(0) scale(0.96);
}
.grid-cell-wrap:nth-child(11n + 1):hover .cell-flyout,
.grid-cell-wrap:nth-child(11n + 1):focus-within .cell-flyout,
.grid-cell-wrap:nth-child(11n + 2):hover .cell-flyout,
.grid-cell-wrap:nth-child(11n + 2):focus-within .cell-flyout {
    transform: translateX(0) scale(1);
}
.grid-cell-wrap:nth-child(11n + 10) .cell-flyout,
.grid-cell-wrap:nth-child(11n) .cell-flyout {
    left: auto;
    right: 0;
    transform: translateX(0) scale(0.96);
}
.grid-cell-wrap:nth-child(11n + 10):hover .cell-flyout,
.grid-cell-wrap:nth-child(11n + 10):focus-within .cell-flyout,
.grid-cell-wrap:nth-child(11n):hover .cell-flyout,
.grid-cell-wrap:nth-child(11n):focus-within .cell-flyout {
    transform: translateX(0) scale(1);
}
/* The pulled-out cell is the 111th child (so the 11n+1 left-clamp above
   would otherwise catch it) but sits in the right-most column — clamp its
   flyout to the right edge and pop it upward. Placed last so it wins the
   specificity tie with the nth-child rule above. */
.trait-grid .grid-cell-pulled .cell-flyout {
    left: auto;
    right: 0;
    top: auto;
    bottom: calc(100% + 10px);
    transform: translateX(0) scale(0.96);
}
.trait-grid .grid-cell-pulled:hover .cell-flyout,
.trait-grid .grid-cell-pulled:focus-within .cell-flyout {
    transform: translateX(0) scale(1);
}

.flyout-preview {
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    line-height: 0;
}
.flyout-preview svg {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    shape-rendering: crispEdges;
    display: block;
}
.flyout-preview-permanent { background: ${PERMANENT_BG}; }
.flyout-preview-pending {
    background: ${UNCOLLECTED_BG};
    outline: 1px dashed ${PENDING_STROKE};
    outline-offset: 1px;
}
.flyout-preview-uncollected { background: ${UNCOLLECTED_BG}; }

.flyout-body {
    padding: 14px 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.flyout-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.flyout-name {
    font-family: var(--serif);
    font-size: 18px;
    letter-spacing: -0.02em;
    color: ${FLYOUT_TEXT};
}
.flyout-meta {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: ${FLYOUT_DIM};
}
.flyout-state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
}
.flyout-state-dot {
    width: 8px;
    height: 8px;
    display: inline-block;
}
.flyout-state-permanent .flyout-state-dot { background: ${PERMANENT_BG}; }
.flyout-state-pending .flyout-state-dot { background: var(--pending); }
.flyout-state-uncollected .flyout-state-dot { background: ${UNCOLLECTED_BG}; border: 1px solid #2a2a2a; }
.flyout-stats {
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    column-gap: 12px;
    row-gap: 6px;
    border-top: 1px solid #1c1c1c;
    padding-top: 10px;
}
.flyout-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}
.flyout-stat dt {
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: ${FLYOUT_DIM};
}
.flyout-stat dd {
    margin: 0;
    font-size: 12px;
    color: ${FLYOUT_TEXT};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.flyout-stat .dim {
    color: ${FLYOUT_DIM};
    font-size: 10px;
}
.flyout-stat-pending dd {
    color: ${FLYOUT_DIM};
}
.flyout-foot {
    margin-top: 4px;
    padding-top: 8px;
    border-top: 1px solid #1c1c1c;
    font-size: 9px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: ${FLYOUT_DIM};
    text-align: center;
}

@media (max-width: 720px) {
    .trait-grid { padding: 12px; gap: 3px; }
    .cell-flyout { width: 200px; }
}
`;
