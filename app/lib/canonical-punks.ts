/* Canonical Punk-id-per-trait blob. Lifted verbatim from
   PermanentCollectionMosaicRenderer.sol's `CANONICAL_IDS` so the trait page's
   "representative Punk" matches the on-chain renderer's grid cell exactly.
   222 bytes total (111 traits × 2 bytes/uint16). Generated off-chain by
   scripts/pick-canonical-punks.ts in the contracts package. */

const CANONICAL_IDS_HEX =
    '0c1c09bb0002000608120b4a0174089c041a0281195702e501fe01190ceb067a' +
    '01190002000100000004002302f3209c0225005d015807ac06cd035f00600366' +
    '1532011002460087212b005907f90cd7061a12d1014f17cb018d0014001a0006' +
    '01180012003700b20b74068d1da4015103bd03800ff0002b0a600039003618c3' +
    '008c002f169401b4002c007101430069098d1c43148e0ad00b6f061600f90021' +
    '04d003460fb51851008601ac015a075b0024027523b900b700381bc714f0102f' +
    '031e00bb006a01a1001f004202c2035315ca02a90132071d00f100020019';

const CANONICAL_IDS_BYTES: number[] = (() => {
    const out: number[] = [];
    for (let i = 0; i < CANONICAL_IDS_HEX.length; i += 2) {
        out.push(Number.parseInt(CANONICAL_IDS_HEX.slice(i, i + 2), 16));
    }
    return out;
})();

export const TOTAL_TRAITS = 111;

/** Mirror of `PermanentCollectionMosaicRenderer._canonicalPunkId(traitId)`. */
export function canonicalPunkId(traitId: number): number {
    if (traitId < 0 || traitId >= TOTAL_TRAITS) {
        throw new Error(`canonical-punks: traitId ${traitId} out of range`);
    }
    const offset = traitId * 2;
    return (CANONICAL_IDS_BYTES[offset] << 8) | CANONICAL_IDS_BYTES[offset + 1];
}
