// Indexer-backed owned-homage lookup for the /homage collection gallery.
// Replaces the client's closed-range Homage Transfer(to) chunk walk (which
// grows ~1.4 eth_getLogs chunks per day after deploy) with one fetch.
//
// SOURCE — the Ponder indexer's `homageToken` table (`currentOwner` patched by
// the Transfer handler, zeroed on redeem). The ids returned here are
// CANDIDATES: the client confirms each against the live `ownerOf` multicall
// and adds a one-chunk live tail scan for indexer lag, so this route only
// needs candidate-completeness for the indexed history.
//
// FAIL-CLOSED — an empty answer is only trustworthy when the indexer is
// provably homage-aware. The `homageStats` singleton exists iff the indexer
// deploy has processed at least one Homage event; absent row (older indexer
// schema, HOMAGE_ADDRESS unset, or a truly fresh collection) ⇒ 503, and the
// frontend falls back to its own full chunked scan instead of trusting a
// hollow empty. The zero-mints-ever window this misses costs one cheap scan
// over a near-empty block range.

import {NextResponse} from 'next/server';

import {getContractAddresses} from '@/lib/config';
import {getIndexerClient} from '@/lib/data/indexer-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ponder's GraphQL caps `limit` at 1000; follow the cursor for the (unlikely)
// wallet holding more.
const PAGE_SIZE = 1000;

type OwnedPage = {
    homageTokens: {
        items: {punkId: number}[];
        pageInfo: {hasNextPage: boolean; endCursor: string | null};
    };
};

export async function GET(req: Request) {
    const url = new URL(req.url);
    const raw = url.searchParams.get('address');
    if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
        return NextResponse.json({error: 'invalid address'}, {status: 400});
    }
    const ownerLc = raw.toLowerCase();

    if (!getContractAddresses().homage) {
        return NextResponse.json({error: 'homage not configured'}, {status: 503});
    }

    try {
        const client = getIndexerClient();

        // Marker: absent stats row ⇒ this indexer deploy has never seen a
        // Homage event ⇒ an empty owner query proves nothing.
        const {homageStats} = await client.request<{homageStats: {mintedCount: number} | null}>(
            `{ homageStats(id: "global") { mintedCount } }`,
        );
        if (!homageStats) {
            return NextResponse.json({error: 'homage not indexed'}, {status: 503});
        }

        const ids: number[] = [];
        let after: string | null = null;
        do {
            const page: OwnedPage = await client.request<OwnedPage>(
                `query Owned($owner: String!, $after: String) {
                    homageTokens(where: {currentOwner: $owner}, limit: ${PAGE_SIZE}, after: $after) {
                        items { punkId }
                        pageInfo { hasNextPage endCursor }
                    }
                }`,
                {owner: ownerLc, after},
            );
            ids.push(...page.homageTokens.items.map((i) => i.punkId));
            after = page.homageTokens.pageInfo.hasNextPage
                ? page.homageTokens.pageInfo.endCursor
                : null;
        } while (after);

        ids.sort((a, b) => a - b);
        return NextResponse.json({ids}, {headers: {'cache-control': 'no-store'}});
    } catch (err) {
        // Outage or a pre-homage indexer schema (GraphQL rejects the unknown
        // field) — either way the client's own scan is the honest answer.
        return NextResponse.json(
            {error: err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'lookup failed'},
            {status: 503},
        );
    }
}
