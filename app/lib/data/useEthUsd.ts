'use client';

/* Shared ETH/USD spot hook. One react-query entry — keyed on the WETH pair
 * through the /api/price GeckoTerminal proxy — feeds every dollar annotation
 * in the app (SwapBox captions, BidCalculator, the live-bid USD lines), so a
 * page issues at most one price fetch per staleTime window no matter how many
 * components render a dollar figure. The key matches the historical inline
 * queries in SwapBox/BidCalculator so any remaining inline use shares the
 * cache rather than refetching.
 *
 * Returns null until the first response lands or when the upstream can't
 * price the pair; callers hide their USD line on null instead of blocking. */

import {useQuery} from '@tanstack/react-query';
import {getChainId, getV4Infrastructure} from '@/lib/config';

export interface EthUsdQuote {
    priceUsd: number | null;
    change24h: number | null;
}

/** Current ETH/USD spot (null until known). */
export function useEthUsd(): number | null {
    return useEthUsdQuote().priceUsd;
}

/** Full quote — spot plus 24h change — for callers that show both. */
export function useEthUsdQuote(): EthUsdQuote {
    const chainId = getChainId();
    const {weth} = getV4Infrastructure();
    const query = useQuery({
        queryKey: ['gt-price', chainId, weth.toLowerCase()],
        queryFn: async () => {
            const r = await fetch(`/api/price/${chainId}/${weth}`);
            return (await r.json()) as EthUsdQuote;
        },
        staleTime: 60_000,
    });
    return {
        priceUsd: query.data?.priceUsd ?? null,
        change24h: query.data?.change24h ?? null,
    };
}
