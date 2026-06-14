/**
 * For each of the 111 traits PunksData publishes, pick a "canonical" Punk
 * that exemplifies that trait — the Punk with the trait set AND the
 * smallest total trait count (so its silhouette is the cleanest
 * minimum-context rendering of that single trait).
 *
 * Output: `app/src/lib/canonicalPunks.ts` — a static const that the
 * frontend + the on-chain SVG renderer (Phase 1) both depend on.
 *
 * Run:
 *
 *     MAINNET_RPC_URL=... pnpm tsx scripts/pick-canonical-punks.ts
 */
import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPublicClient, http, parseAbi} from 'viem';
import {mainnet} from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUTPUT = join(ROOT, 'app', 'src', 'lib', 'canonicalPunks.ts');

const PUNKS_DATA = '0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C' as const;
const TOTAL_PUNKS = 10_000;
const TOTAL_TRAITS = 111;
const CHUNK = 500;

const PUNKS_DATA_ABI = parseAbi([
    'function traitMaskOf(uint16 punkId) view returns (uint256)',
    'function traitName(uint16 traitId) view returns (string)',
]);

function popcount(n: bigint): number {
    let count = 0;
    while (n !== 0n) {
        count += Number(n & 1n);
        n >>= 1n;
    }
    return count;
}

async function main() {
    const rpcUrl = process.env.MAINNET_RPC_URL || 'https://ethereum.publicnode.com';
    const client = createPublicClient({
        chain: mainnet,
        transport: http(rpcUrl, {batch: {batchSize: 50, wait: 16}}),
    });

    console.log(`Fetching trait masks for all ${TOTAL_PUNKS} Punks...`);
    const maskCalls = Array.from({length: TOTAL_PUNKS}, (_, i) => ({
        address: PUNKS_DATA,
        abi: PUNKS_DATA_ABI,
        functionName: 'traitMaskOf' as const,
        args: [i] as const,
    }));

    const masks: bigint[] = [];
    for (let start = 0; start < maskCalls.length; start += CHUNK) {
        const chunk = maskCalls.slice(start, start + CHUNK);
        const results = await client.multicall({contracts: chunk, allowFailure: false});
        for (const r of results) masks.push(r as bigint);
        process.stdout.write(`\r  fetched ${Math.min(start + CHUNK, maskCalls.length)} / ${maskCalls.length}`);
    }
    process.stdout.write('\n');

    console.log(`Fetching ${TOTAL_TRAITS} trait names...`);
    const nameCalls = Array.from({length: TOTAL_TRAITS}, (_, i) => ({
        address: PUNKS_DATA,
        abi: PUNKS_DATA_ABI,
        functionName: 'traitName' as const,
        args: [i] as const,
    }));
    const names = (await client.multicall({contracts: nameCalls, allowFailure: false})) as string[];

    console.log('Picking canonical Punk per trait...');
    interface Canonical {
        traitId: number;
        traitName: string;
        punkId: number;
        bitCount: number;
        mask: string; // 0x...
    }

    // Picking order matters because the head tier (bits 0..15) gets a
    // uniqueness constraint that depends on what's already been claimed:
    //
    //   1) HeadVariants (bits 5..15): plain lowest-popcount = bald
    //      exemplar of each of the 11 head variants. No constraint —
    //      these are the visually anchoring tiles.
    //
    //   2) Type traits (bits 0..4): require popcount >= 4 AND the Punk
    //      ID not already used in the head tier. The popcount floor
    //      forces an accessorized exemplar so the Type tile is
    //      visually distinct from any bald variant tile; the
    //      uniqueness rule prevents Alien/Ape/Zombie type tiles from
    //      sharing a Punk ID with their corresponding head variant
    //      (the only one possible for those types).
    //
    //   3) AttributeCount (bits 16..23): plain lowest-popcount. The
    //      renderer draws these as dot strips when unacquired so
    //      pixel duplication is invisible.
    //
    //   4) Accessory (bits 24..110): plain lowest-popcount.
    const pickOrder: number[] = [
        ...Array.from({length: 11}, (_, i) => 5 + i),
        ...Array.from({length: 5}, (_, i) => i),
        ...Array.from({length: 8}, (_, i) => 16 + i),
        ...Array.from({length: 87}, (_, i) => 24 + i),
    ];

    const usedInHeadTier = new Set<number>();
    const byTraitId = new Map<number, Canonical>();

    for (const t of pickOrder) {
        const isType = t < 5;
        const isHeadVariant = t >= 5 && t < 16;
        const traitBit = 1n << BigInt(t);
        let bestPunkId = -1;
        let bestBits = Number.MAX_SAFE_INTEGER;

        for (let p = 0; p < TOTAL_PUNKS; p++) {
            if ((masks[p] & traitBit) === 0n) continue;
            if (isType) {
                const bits = popcount(masks[p]);
                if (bits < 4) continue; // need at least 1 accessory
                if (usedInHeadTier.has(p)) continue;
            }
            const bits = popcount(masks[p]);
            if (bits < bestBits) {
                bestBits = bits;
                bestPunkId = p;
            }
        }
        if (bestPunkId < 0) {
            throw new Error(`No Punk found for trait ${t} ("${names[t]}")`);
        }
        byTraitId.set(t, {
            traitId: t,
            traitName: names[t],
            punkId: bestPunkId,
            bitCount: bestBits,
            mask: `0x${masks[bestPunkId].toString(16)}`,
        });
        if (isHeadVariant || isType) usedInHeadTier.add(bestPunkId);
    }

    const canonical: Canonical[] = Array.from({length: TOTAL_TRAITS}, (_, t) => {
        const c = byTraitId.get(t);
        if (!c) throw new Error(`Missing canonical for trait ${t}`);
        return c;
    });

    // Sanity: every trait covered, every canonical Punk actually has the trait.
    for (const c of canonical) {
        const m = masks[c.punkId];
        if ((m & (1n << BigInt(c.traitId))) === 0n) {
            throw new Error(`Canonical Punk #${c.punkId} doesn't have trait ${c.traitId}`);
        }
    }

    // Quick histogram for diagnostic output.
    const histogram: Record<number, number> = {};
    for (const c of canonical) histogram[c.bitCount] = (histogram[c.bitCount] ?? 0) + 1;
    console.log('\nCanonical Punks by trait-count of the chosen exemplar:');
    Object.keys(histogram)
        .map((k) => Number(k))
        .sort((a, b) => a - b)
        .forEach((k) => console.log(`  ${k} bits set: ${histogram[k]} traits`));

    // Write the TS file.
    const lines: string[] = [];
    lines.push('// AUTOGENERATED by scripts/pick-canonical-punks.ts — do not edit.');
    lines.push('//');
    lines.push('// For each of the 111 traits PunksData exposes, the canonical');
    lines.push('// Punk is the one with that trait set AND the smallest total');
    lines.push("// trait count (= cleanest minimal-context exemplar). Used by");
    lines.push('// the on-chain SVG renderer to render each trait cell.');
    lines.push('');
    lines.push('export interface CanonicalPunk {');
    lines.push('    /** Trait id 0..110, matching PunksData bit ordering. */');
    lines.push('    traitId: number;');
    lines.push('    /** Human-readable trait name from PunksData.traitName(). */');
    lines.push('    traitName: string;');
    lines.push('    /** Punk id 0..9999 chosen as the exemplar for this trait. */');
    lines.push('    punkId: number;');
    lines.push('    /** popcount(traitMaskOf(punkId)) — informational. */');
    lines.push('    bitCount: number;');
    lines.push("    /** The chosen Punk's full trait mask, hex-encoded. */");
    lines.push('    mask: `0x${string}`;');
    lines.push('}');
    lines.push('');
    lines.push('export const CANONICAL_PUNKS: readonly CanonicalPunk[] = [');
    for (const c of canonical) {
        lines.push(
            `    {traitId: ${c.traitId}, traitName: ${JSON.stringify(c.traitName)}, punkId: ${c.punkId}, bitCount: ${c.bitCount}, mask: ${JSON.stringify(c.mask)} as \`0x\${string}\`},`,
        );
    }
    lines.push('];');
    lines.push('');

    writeFileSync(OUTPUT, lines.join('\n'));
    console.log(`\nWrote ${OUTPUT}`);

    // Also emit the Solidity hex constant so we can paste it straight
    // into the on-chain renderer's CANONICAL_IDS.
    const hexBytes: string[] = [];
    for (const c of canonical) {
        hexBytes.push(c.punkId.toString(16).padStart(4, '0'));
    }
    const flatHex = hexBytes.join('');
    const hexLines: string[] = [];
    for (let i = 0; i < flatHex.length; i += 64) {
        hexLines.push(`        hex"${flatHex.slice(i, i + 64)}"`);
    }
    console.log('\nSolidity CANONICAL_IDS (paste into renderer):');
    console.log(hexLines.join('\n') + ';');

    // Diagnostic: show which Type/HeadVariant tiles ended up with distinct Punks.
    console.log('\nHead tier (bits 0..15) assignments:');
    for (let t = 0; t < 16; t++) {
        const c = byTraitId.get(t)!;
        const tier = t < 5 ? 'Type     ' : 'Variant  ';
        console.log(
            `  bit ${t.toString().padStart(2)} ${tier} ${c.traitName.padEnd(12)} → Punk #${c.punkId.toString().padStart(4)} (popcount ${c.bitCount})`,
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
