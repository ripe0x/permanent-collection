'use client';

/**
 * Live status of the Design B extension binding. Reads three on-chain
 * values via wagmi:
 *
 *  - pcSwapContext.authorizedExtension          — the address allowed to flip the inSwap flag
 *  - pcSwapContext.authorizedExtensionLocked    — one-way lock; once true, the binding is permanent
 *  - hook.poolExtension(poolId)                 — the dispatcher currently bound to the pool
 *
 * At launch all three are at their pre-bind defaults (address(0) and
 * false). The /builders page surfaces this transparently so anyone
 * reading the page can see the protocol is in its "extension-not-bound"
 * state.
 *
 * When a Design B dispatcher gets bound (post-audit, via
 * TokenAdminPoker.bindExtension), the three values change in lockstep:
 *
 *   1. Owner calls pcSwapContext.setAuthorizedExtension(dispatcher)
 *      → authorizedExtension becomes the dispatcher's address
 *   2. Artcoins owner allowlists the dispatcher (off-chain perimeter check)
 *   3. Owner calls tokenAdminPoker.bindExtension(hook, poolKey, dispatcher)
 *      → hook.poolExtension(poolId) becomes the dispatcher's address
 *   4. (Optional) owner calls lockExtension + lockAuthorizedExtension
 *      → authorizedExtensionLocked = true, binding frozen forever
 */

import {useMemo} from 'react';
import {useReadContract} from 'wagmi';

import {abi as pcSwapContextAbi} from '@/lib/abis/PCSwapContext';
import {abi as hookAbi} from '@/lib/abis/ArtCoinsHookSkimFee';
import {getChainId, getContractAddresses} from '@/lib/config';
import {buildPoolKey, computePoolId} from '@/lib/swap/poolKey';
import {getEvmNowAddressUrl, shortAddress} from '@/lib/format';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export function DesignBStatus() {
    const chainId = getChainId();
    const addrs = useMemo(() => getContractAddresses(), []);
    const poolKey = useMemo(() => buildPoolKey(addrs.token), [addrs.token]);
    const poolId = useMemo(() => computePoolId(poolKey), [poolKey]);
    const pcSwapContextAddr = addrs.pcSwapContext;

    const authorizedExt = useReadContract({
        address: pcSwapContextAddr,
        abi: pcSwapContextAbi,
        functionName: 'authorizedExtension',
        chainId,
        query: {enabled: Boolean(pcSwapContextAddr)},
    });
    const locked = useReadContract({
        address: pcSwapContextAddr,
        abi: pcSwapContextAbi,
        functionName: 'authorizedExtensionLocked',
        chainId,
        query: {enabled: Boolean(pcSwapContextAddr)},
    });
    const poolExt = useReadContract({
        address: poolKey.hooks,
        abi: hookAbi,
        functionName: 'poolExtension',
        args: [poolId],
        chainId,
    });

    const extAddr = (authorizedExt.data as `0x${string}` | undefined) ?? ZERO_ADDRESS;
    const lockedFlag = (locked.data as boolean | undefined) ?? false;
    const poolExtAddr = (poolExt.data as `0x${string}` | undefined) ?? ZERO_ADDRESS;

    const isBound = extAddr !== ZERO_ADDRESS || poolExtAddr !== ZERO_ADDRESS;

    // Tri-state for the header chip: "unbound · launch state" / "bound (audit
    // window)" / "bound + locked forever". The third is the terminal state.
    const phase = lockedFlag
        ? 'bound + locked forever'
        : isBound
            ? 'bound (audit window — re-bindable until lockExtension)'
            : 'unbound — launch state';

    return (
        <div className="design-b-status" data-phase={phase}>
            <div className="status-head">
                <span className="status-label">Live status</span>
                <span className={`status-pill status-${lockedFlag ? 'locked' : isBound ? 'bound' : 'unbound'}`}>
                    {phase}
                </span>
            </div>
            <dl className="status-grid">
                <div>
                    <dt>PCSwapContext.authorizedExtension</dt>
                    <dd>{renderAddr(extAddr, chainId)}</dd>
                </div>
                <div>
                    <dt>PCSwapContext.authorizedExtensionLocked</dt>
                    <dd>{lockedFlag ? 'true (one-way lock fired)' : 'false (re-bindable)'}</dd>
                </div>
                <div>
                    <dt>hook.poolExtension(poolId)</dt>
                    <dd>{renderAddr(poolExtAddr, chainId)}</dd>
                </div>
                <div>
                    <dt>Hook</dt>
                    <dd>
                        <a
                            href={getEvmNowAddressUrl(poolKey.hooks, chainId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="tnum"
                        >
                            {shortAddress(poolKey.hooks)}
                        </a>
                    </dd>
                </div>
            </dl>
            <style jsx>{`
                .design-b-status {
                    border: 1px solid var(--line);
                    background: var(--panel);
                    padding: 20px 22px;
                    margin: 18px 0 28px;
                    font-family: var(--mono);
                    font-size: 12px;
                }
                .status-head {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    margin-bottom: 14px;
                    padding-bottom: 12px;
                    border-bottom: 1px solid var(--line);
                }
                .status-label {
                    color: var(--muted);
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    font-size: 11px;
                }
                .status-pill {
                    padding: 3px 10px;
                    border: 1px solid var(--line);
                    color: var(--ink);
                    font-size: 11px;
                }
                .status-pill.status-unbound {
                    color: var(--muted);
                }
                .status-pill.status-bound {
                    color: #d4a017;
                    border-color: #d4a017;
                }
                .status-pill.status-locked {
                    color: #2a8a3e;
                    border-color: #2a8a3e;
                }
                .status-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 12px 24px;
                    margin: 0;
                }
                .status-grid > div {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                dt {
                    color: var(--muted);
                    font-size: 10.5px;
                }
                dd {
                    color: var(--ink);
                    margin: 0;
                }
                dd a {
                    color: inherit;
                    border-bottom: 1px dotted var(--muted);
                    text-decoration: none;
                }
                @media (max-width: 700px) {
                    .status-grid {
                        grid-template-columns: 1fr;
                    }
                }
            `}</style>
        </div>
    );
}

function renderAddr(addr: `0x${string}`, chainId: number) {
    if (addr === ZERO_ADDRESS) {
        return <span style={{color: 'var(--muted)'}}>0x0000…0000 · not set</span>;
    }
    return (
        <a
            href={getEvmNowAddressUrl(addr, chainId)}
            target="_blank"
            rel="noopener noreferrer"
            className="tnum"
        >
            {shortAddress(addr)}
        </a>
    );
}
