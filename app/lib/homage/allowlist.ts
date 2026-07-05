// Allowlist Merkle proofs for the window-2 mint. The tree + root are built offline by
// scripts/build-allowlist.mjs from data/allowlist.json, which emits data/allowlist-proofs.json
// (address -> proof) imported here. The on-chain Homage.allowlistRoot must be set to `ALLOWLIST_ROOT`
// (via setAllowlistRoot) for these proofs to verify.
//
// ⚠️ SINGLE-SOURCED ARTIFACT — data/allowlist-proofs.json is vendored BYTE-IDENTICAL across THREE
// repos: the homage repo (the source of truth, where scripts/build-allowlist.mjs regenerates it),
// the PND repo (ripe0x/pin: apps/web/src/data/homage-allowlist-proofs.json), and permanent-collection
// (this file's app/lib/homage/data/allowlist-proofs.json). If you regenerate the tree in the homage
// repo, copy the new file into the other two verbatim in the same change — all frontends must always
// verify against the same onchain root.
import proofsData from './data/allowlist-proofs.json';

type ProofFile = { root: `0x${string}`; count: number; proofs: Record<string, `0x${string}`[]> };
const data = proofsData as ProofFile;

export const ALLOWLIST_ROOT = data.root;
export const ALLOWLIST_COUNT = data.count;

/** The Merkle proof for `address`, or null if it isn't on the allowlist (case-insensitive). */
export function allowlistProofFor(address: string): `0x${string}`[] | null {
    return data.proofs[address.toLowerCase()] ?? null;
}
