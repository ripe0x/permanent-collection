/**
 * Emit Solidity hex-literal constants for the Alien/Ape/Zombie rotation
 * pools used by `PermanentCollectionMosaicRenderer._pickRotationPunk()`
 * (and the V4 parity fixture). Ids are packed big-endian uint16 (2 bytes
 * each) for cheap indexed reads via byte slicing.
 *
 * The values are FROZEN at deploy time. Re-running this script is only
 * useful if the renderer needs to be re-deployed against a different
 * PunksData dataset hash (it never will — PunksData is sealed).
 *
 *     cd app && node --experimental-strip-types --no-warnings scripts/emit-rotation-pools.ts
 */
import {createPunksSdk} from '@networked-art/punks-sdk';
import {bundledOfflinePunksDataWithPixels} from '@networked-art/punks-sdk/offline-pixel-data';

const TYPES = ['Alien', 'Ape', 'Zombie'] as const;

function pack(ids: number[]): string {
    const parts: string[] = [];
    for (const id of ids) {
        if (id < 0 || id > 0xffff) throw new Error(`id out of u16 range: ${id}`);
        parts.push(id.toString(16).padStart(4, '0'));
    }
    return parts.join('');
}

async function main() {
    const punks = createPunksSdk({dataset: bundledOfflinePunksDataWithPixels});
    for (const t of TYPES) {
        const ids = punks.search({type: [t], sort: 'id'});
        console.log(`// ${ids.length} ${t}s, ids sorted asc`);
        const packed = pack(ids);
        const chunks: string[] = [];
        for (let i = 0; i < packed.length; i += 64) chunks.push(packed.slice(i, i + 64));
        console.log(`bytes private constant ${t.toUpperCase()}_IDS =`);
        for (let i = 0; i < chunks.length; i++) {
            const sep = i === chunks.length - 1 ? ';' : '';
            console.log(`    hex"${chunks[i]}"${sep}`);
        }
        console.log();
    }
}

main().catch((e) => {
    console.error('FAILED:', e?.message || e);
    process.exit(1);
});
