import {encodeAbiParameters, keccak256, zeroAddress, type Address} from 'viem';
import {getContractAddresses} from '@/lib/config';

/** V4 dynamic-fee sentinel — tells PoolManager the LP fee is decided by the
 *  hook on each swap. Matches `Deploy.s.sol:DYNAMIC_FEE_FLAG`. */
export const DYNAMIC_FEE_FLAG = 0x800000;

/** Tick spacing chosen at 111 launch — matches `Deploy.s.sol:TICK_SPACING`. */
export const POOL_TICK_SPACING = 200;

/** The artcoins V4 hook the 111 pool launched on. Under the three-leg
 *  skim redesign this is a per-launch contract (CREATE2-mined for v4's
 *  hook-permission-flag bits), not a canonical address. It's resolved through
 *  the runtime config (server: request-time env; client: the layout-injected
 *  `window.__PC_RUNTIME_CONFIG__`) so it flips together with the other launch
 *  addresses without a client rebuild.
 *
 *  Before the protocol is deployed the hook isn't configured, so this returns
 *  the zero address: trade components that compute a pool key still mount —
 *  their wagmi reads against 0x0 resolve to empty/null, the correct "not
 *  launched yet" state (and the swap CTA is disabled via `isProtocolLive`).
 *  Resolved at call time (not module load) so the runtime config injected by
 *  the layout is available. */
export function getArtcoinsHook(): Address {
    return getContractAddresses().artcoinsHook ?? zeroAddress;
}

export interface PoolKey {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
}

/** Build the canonical 111 PoolKey. The pool is native-ETH-paired, so
 *  currency0 is always `address(0)` (it sorts below any real token address)
 *  and the token is currency1. */
export function buildPoolKey(token: Address): PoolKey {
    return {
        currency0: zeroAddress,
        currency1: token,
        fee: DYNAMIC_FEE_FLAG,
        tickSpacing: POOL_TICK_SPACING,
        hooks: getArtcoinsHook(),
    };
}

/** keccak256 of the ABI-encoded PoolKey — the V4 PoolManager's pool identifier. */
export function computePoolId(key: PoolKey): `0x${string}` {
    const encoded = encodeAbiParameters(
        [
            {type: 'address'},
            {type: 'address'},
            {type: 'uint24'},
            {type: 'int24'},
            {type: 'address'},
        ],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    );
    return keccak256(encoded);
}

/** For PC the token is always currency1 (currency0 = native ETH, which sorts
 *  below any real address) — exported as a named constant so the swap engine
 *  reads naturally without re-deriving from the pool key. */
export const TOKEN_IS_TOKEN_0 = false;
