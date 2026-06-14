/* Trait detail page hero.

   - Uncollected: render the isolated trait visual ONLY (no Punk).
     - Type / HeadVariant traits: the canonical exemplar Punk
       (which IS a clean visual of that trait).
     - AttributeCount: the 7-dot strip.
     - Accessory: just the accessory pixels (diffed against baseline).
   - Permanent / pending: render the vaulted-or-candidate Punk as the
     base layer with the isolated trait stacked on top, invisible by
     default. On hover (or keyboard focus) the Punk fades to 40%
     opacity and the trait overlay fades in to 100% — so the accessory
     pixels stay crisp while the surrounding Punk silhouette becomes
     a ghost.

   Pure CSS, no JS. Server-rendered SVG strings inlined.
*/
import {canonicalPunkId} from '@/lib/canonical-punks';
import {renderPunkTileContent, renderTraitTileContent} from '@/lib/trait-tile';

export interface TraitDetailHeroProps {
    traitId: number;
    state: 'permanent' | 'pending' | 'uncollected';
    /** The actual Punk to render as the base layer when state !== 'uncollected'.
     *  For permanent: firstVaultedPunkId. For pending: the auction Punk.
     *  Optional — falls back to the canonical exemplar (which keeps the
     *  trait visible in case the page is loaded before the indexer has
     *  resolved the live Punk id). */
    punkId?: number;
    /** Rendered size in CSS pixels. Defaults to 480. */
    size?: number;
    /** Short alt label for assistive tech. */
    label: string;
}

const PERMANENT_BG = '#8F918B';
const UNCOLLECTED_BG = '#1c1c1c';
// Pending hero shares UNCOLLECTED_BG (Punk-tile colour for the hero's
// in-auction Punk variant) and adds a 1-px dashed border in
// PENDING_STROKE, matching the on-chain renderer's pending visual.
const PENDING_STROKE = '#454545';

export function TraitDetailHero({
    traitId,
    state,
    punkId,
    size = 480,
    label,
}: TraitDetailHeroProps) {
    const showsPunk = state === 'permanent' || state === 'pending';
    const traitSvg = renderTraitTileContent(traitId);

    if (!showsPunk) {
        // Uncollected: trait alone on a dim surface — no Punk anywhere.
        return (
            <div
                className="trait-hero trait-hero-uncollected"
                style={{width: size, height: size}}
                role="img"
                aria-label={label}
            >
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    shapeRendering="crispEdges"
                    dangerouslySetInnerHTML={{__html: traitSvg}}
                />
                <style>{styles}</style>
            </div>
        );
    }

    const pid = punkId ?? canonicalPunkId(traitId);
    const punkSvg = renderPunkTileContent(pid);
    return (
        <div
            className={`trait-hero trait-hero-${state} trait-hero-interactive`}
            style={{width: size, height: size}}
            role="img"
            aria-label={label}
            tabIndex={0}
        >
            <svg
                className="hero-layer hero-punk"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                shapeRendering="crispEdges"
                aria-hidden="true"
                dangerouslySetInnerHTML={{__html: punkSvg}}
            />
            <svg
                className="hero-layer hero-trait"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                shapeRendering="crispEdges"
                aria-hidden="true"
                dangerouslySetInnerHTML={{__html: traitSvg}}
            />
            <style>{styles}</style>
        </div>
    );
}

const styles = `
.trait-hero {
    position: relative;
    line-height: 0;
    overflow: hidden;
    background: ${UNCOLLECTED_BG};
}
.trait-hero-permanent { background: ${PERMANENT_BG}; }
.trait-hero-pending {
    background: ${UNCOLLECTED_BG};
    outline: 1px dashed ${PENDING_STROKE};
    outline-offset: 1px;
}
.trait-hero-uncollected { background: ${UNCOLLECTED_BG}; }
.trait-hero > svg {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    shape-rendering: crispEdges;
}
.trait-hero-interactive { cursor: crosshair; }
.trait-hero-interactive:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
}
.hero-layer {
    position: absolute;
    inset: 0;
    transition: opacity 220ms ease;
}
.hero-punk { opacity: 1; }
.hero-trait { opacity: 0; }
.trait-hero-interactive:hover .hero-punk,
.trait-hero-interactive:focus-within .hero-punk,
.trait-hero-interactive:focus-visible .hero-punk {
    opacity: 0.4;
}
.trait-hero-interactive:hover .hero-trait,
.trait-hero-interactive:focus-within .hero-trait,
.trait-hero-interactive:focus-visible .hero-trait {
    opacity: 1;
}
`;
