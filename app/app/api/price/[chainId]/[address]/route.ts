import type {NextRequest} from 'next/server';

/**
 * Server-side GeckoTerminal proxy for token price + 24h change.
 *
 * Mirrors the same shape as the artcoins repo's proxy at the same path
 * — the SwapBox's PriceStats / USD captions consume `{ priceUsd,
 * change24h }` and synthesize a fallback from on-chain pool spot ×
 * ETH/USD when GeckoTerminal hasn't indexed the token yet (common for
 * fresh artcoins like 111).
 *
 * Caching: edge-cached for 60s (`s-maxage=60`) with stale-while-
 * revalidate, so the page can hammer this endpoint without overrunning
 * GeckoTerminal's free-tier limits.
 */

export const runtime = 'edge';

const NETWORK_BY_CHAIN: Record<string, string> = {
    '1': 'eth',
    // Anvil/foundry forks (chain 31337) mirror real mainnet — same WETH
    // address, same indexed tokens. Route price lookups to the eth
    // network so the SwapBox shows live USD numbers during fork tests.
    '31337': 'eth',
};

interface PriceResponse {
    priceUsd: number | null;
    change24h: number | null;
}

const EMPTY: PriceResponse = {priceUsd: null, change24h: null};

async function fetchToken(
    network: string,
    address: string,
): Promise<{priceUsd: number | null; topPoolAddress: string | null}> {
    try {
        const r = await fetch(
            `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(address)}`,
            {next: {revalidate: 60}},
        );
        if (!r.ok) return {priceUsd: null, topPoolAddress: null};
        const data = await r.json();
        const priceRaw = data?.data?.attributes?.price_usd;
        const price = priceRaw ? parseFloat(priceRaw) : NaN;
        const topPoolId: string | undefined =
            data?.data?.relationships?.top_pools?.data?.[0]?.id;
        const poolAddress = topPoolId
            ? topPoolId.includes('_')
                ? topPoolId.split('_').slice(1).join('_')
                : topPoolId
            : null;
        return {
            priceUsd: Number.isFinite(price) ? price : null,
            topPoolAddress: poolAddress,
        };
    } catch {
        return {priceUsd: null, topPoolAddress: null};
    }
}

async function fetchPoolChange24h(
    network: string,
    poolAddress: string,
): Promise<number | null> {
    try {
        const r = await fetch(
            `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(poolAddress)}`,
            {next: {revalidate: 60}},
        );
        if (!r.ok) return null;
        const data = await r.json();
        const raw = data?.data?.attributes?.price_change_percentage?.h24 as
            | string
            | undefined;
        if (raw === undefined || raw === null) return null;
        const val = parseFloat(raw);
        return Number.isFinite(val) ? val : null;
    } catch {
        return null;
    }
}

export async function GET(
    _req: NextRequest,
    {params}: {params: Promise<{chainId: string; address: string}>},
) {
    const {chainId, address} = await params;

    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return Response.json(
            {error: 'address must be a 0x-prefixed 20-byte address'},
            {status: 400},
        );
    }
    const lcAddr = address.toLowerCase();

    const network = NETWORK_BY_CHAIN[chainId];
    if (!network) {
        return Response.json(EMPTY, {
            headers: {'Cache-Control': 's-maxage=60, stale-while-revalidate=600'},
        });
    }

    const {priceUsd, topPoolAddress} = await fetchToken(network, lcAddr);
    const change24h = topPoolAddress
        ? await fetchPoolChange24h(network, topPoolAddress)
        : null;

    return Response.json({priceUsd, change24h} satisfies PriceResponse, {
        headers: {'Cache-Control': 's-maxage=60, stale-while-revalidate=600'},
    });
}
