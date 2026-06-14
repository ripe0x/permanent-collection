// Hand-written ABI fragment for the canonical Permit2 singleton at
// 0x000000000022D473030F116dDEE9F6B43aC78BA3 (same address on every chain).
//
// We need:
//   - `allowance` to read the user's current Permit2 → UniversalRouter
//     allowance + nonce before signing a fresh PermitSingle.
//   - `approve` so the legacy fallback can grant Permit2 a non-infinite
//     allowance if the token doesn't auto-grant one (defensive — Solady
//     artcoins like 111 grant infinite ERC20 → Permit2 allowance, so this
//     path is unreachable in practice. Kept for completeness in case the
//     factory changes its ERC20 base.)
export const abi = [
    {
        type: 'function',
        name: 'allowance',
        inputs: [
            {name: 'owner', type: 'address'},
            {name: 'token', type: 'address'},
            {name: 'spender', type: 'address'},
        ],
        outputs: [
            {name: 'amount', type: 'uint160'},
            {name: 'expiration', type: 'uint48'},
            {name: 'nonce', type: 'uint48'},
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'approve',
        inputs: [
            {name: 'token', type: 'address'},
            {name: 'spender', type: 'address'},
            {name: 'amount', type: 'uint160'},
            {name: 'expiration', type: 'uint48'},
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
] as const;
