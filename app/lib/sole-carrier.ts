// Sole-carrier guard reads (hard invariant #22). The single on-chain source
// of truth is `PermanentCollection.soleCarrierConstraint(punkId)` — we never
// re-derive the pinned punk/bit off-chain so that if the guard ever covers
// more forced edges, this UI follows automatically.
//
// These are a UX defence-in-depth layer; the contract is the actual guarantee.
// Every read therefore FAILS OPEN: an RPC hiccup yields `{required: false}` so
// the UI never blocks a legitimate acquisition on a transient error. The
// contract still reverts a genuinely-wrong target regardless.
//
// Server-side only (takes a viem PublicClient). Callers fold the single-read
// into an existing per-Punk fetch, or batch via multicall for listings.
import type {PublicClient} from 'viem';
import {abi as PermanentCollectionAbi} from '@/lib/abis/PermanentCollection';
import type {Address, SoleCarrierConstraint} from '@/lib/data/types';

const NONE: SoleCarrierConstraint = {required: false, requiredTraitId: 0};

/** Normalize whatever shape viem returns for the 2-output view into our type.
 *  viem returns positional outputs as a tuple, but tolerate an object shape
 *  too (named outputs) so a viem version bump can't silently break the guard. */
export function normalizeSoleCarrier(raw: unknown): SoleCarrierConstraint {
    if (Array.isArray(raw)) {
        return {required: Boolean(raw[0]), requiredTraitId: Number(raw[1] ?? 0)};
    }
    if (raw && typeof raw === 'object' && 'required' in raw) {
        const o = raw as {required: unknown; requiredTraitId?: unknown};
        return {required: Boolean(o.required), requiredTraitId: Number(o.requiredTraitId ?? 0)};
    }
    return NONE;
}

/** Read the constraint for a single Punk. Fail-open on any error. */
export async function readSoleCarrier(
    rpc: PublicClient,
    permanentCollection: Address,
    punkId: number,
): Promise<SoleCarrierConstraint> {
    try {
        const raw = await rpc.readContract({
            address: permanentCollection,
            abi: PermanentCollectionAbi,
            functionName: 'soleCarrierConstraint',
            args: [punkId],
        });
        return normalizeSoleCarrier(raw);
    } catch {
        return NONE;
    }
}

/** Read the constraint for many Punks in a single multicall round-trip.
 *  Per-item fail-open (allowFailure), and whole-call fail-open on throw, so a
 *  degraded RPC never blocks listings. Returns one entry per input id, in
 *  order. */
export async function readSoleCarrierBatch(
    rpc: PublicClient,
    permanentCollection: Address,
    punkIds: number[],
): Promise<SoleCarrierConstraint[]> {
    if (punkIds.length === 0) return [];
    try {
        const results = await rpc.multicall({
            contracts: punkIds.map((punkId) => ({
                address: permanentCollection,
                abi: PermanentCollectionAbi,
                functionName: 'soleCarrierConstraint' as const,
                args: [punkId] as const,
            })),
            allowFailure: true,
        });
        return results.map((r) =>
            r.status === 'success' ? normalizeSoleCarrier(r.result) : NONE,
        );
    } catch {
        return punkIds.map(() => NONE);
    }
}
