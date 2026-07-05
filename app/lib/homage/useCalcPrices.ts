'use client';

// Live pricing for the mint-price calculator (/homage/calculator): the $111 spot price from the
// v4 pool (StateView.getSlot0) and ETH/USD from Chainlink, in one multicall. Read once on
// mount (no polling — RPC discipline); the page exposes a manual refresh. Falls back to
// seeded defaults in the page if the reads fail.

import {parseAbi} from 'viem';
import {useReadContracts} from 'wagmi';

import {getChainId, getV4Infrastructure} from '@/lib/config';
import {stateViewAbi, useHomagePoolKey} from './homage';

// Chainlink ETH/USD aggregator (mainnet, and therefore the fork). answer has 8 decimals.
const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const;
const chainlinkAbi = parseAbi(['function latestAnswer() view returns (int256)']);

const Q192 = 1n << 192n;
const WAD = 10n ** 18n;

export type CalcPrices = {
    /** $111 per 1 ETH (human units), from the pool spot price. undefined until loaded. */
    price111PerEth?: number;
    /** ETH price in USD, from Chainlink. undefined until loaded. */
    ethUsd?: number;
    isLoading: boolean;
    isError: boolean;
    refetch: () => void;
};

export function useCalcPrices(): CalcPrices {
    // The pool key comes from the Homage contract's immutables (or PC's canonical
    // 111 pool pre-deploy) — see useHomagePoolKey. When it resolves from contract
    // reads, this slot0 read and the pool-key read resolve in sequence rather than
    // one multicall; that's fine, both are one-shot on mount.
    const {poolId} = useHomagePoolKey();

    const r = useReadContracts({
        contracts: [
            {
                address: getV4Infrastructure().stateView,
                abi: stateViewAbi,
                functionName: 'getSlot0',
                args: poolId ? [poolId] : undefined,
                chainId: getChainId(),
            },
            {address: CHAINLINK_ETH_USD, abi: chainlinkAbi, functionName: 'latestAnswer', chainId: getChainId()},
        ],
        query: {enabled: poolId !== undefined},
    });

    const slot0 = r.data?.[0];
    const sqrtP =
        slot0?.status === 'success' ? (slot0.result as readonly [bigint, number, number, number])[0] : undefined;
    // price = currency1/currency0 = $111(1e18) per 1 ETH(1e18) = sqrtP^2 / 2^192; scale by WAD then
    // divide back out for a plain human number.
    const price111PerEth = sqrtP && sqrtP > 0n ? Number((sqrtP * sqrtP * WAD) / Q192) / 1e18 : undefined;

    const feed = r.data?.[1];
    const answer = feed?.status === 'success' ? (feed.result as bigint) : undefined;
    const ethUsd = answer && answer > 0n ? Number(answer) / 1e8 : undefined;

    return {price111PerEth, ethUsd, isLoading: r.isLoading, isError: r.isError, refetch: r.refetch};
}
