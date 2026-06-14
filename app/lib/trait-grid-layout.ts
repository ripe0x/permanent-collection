/* Single source of truth for the 11×10 trait-grid layout, shared by the
   /collection page's <TraitGrid> and the homepage mosaic image
   (lib/mosaic-svg.ts). Mirrors PermanentCollectionMosaicRenderer._traitAt
   exactly so both surfaces — and the on-chain renderer — agree on which
   trait occupies each cell.

     rows 0..6  cols 0..10   Accessories 24..100      (77 cells)
     row  7     cols 0..9    Accessories 101..110     (10 cells)
     row  7     col  10      AttributeCount 16        ( 1 cell)
     row  8     cols 0..6    AttributeCounts 17..23   ( 7 cells)
     row  8     cols 7..10   HeadVariants 5..8        ( 4 cells)
     row  9     cols 0..6    HeadVariants 9..15       ( 7 cells)
     row  9     cols 7..10   Types 0..3               ( 4 cells)
     — pulled out beneath the grid (bottom-right) — Type 4 (Zombie)
*/

export const GRID_COLS = 11;
export const GRID_ROWS = 10; // main grid; the 111th trait (Type 4) is pulled out
/** The "final type" (NormalizedType 4 / Zombie) rendered beneath the grid. */
export const PULLED_TRAIT_ID = 4;

/** Trait id occupying main-grid position `pos` (0..109). The 110 cells pack
 *  with no gaps; Type 4 is pulled out separately. */
export function traitAt(pos: number): number {
    if (pos < 87) return 24 + pos; // accessories 24..110 (pos 0..86)
    if (pos < 95) return 16 + (pos - 87); // attribute counts 16..23 (pos 87..94)
    if (pos < 106) return 5 + (pos - 95); // head variants 5..15 (pos 95..105)
    return pos - 106; // types 0..3 (pos 106..109)
}
