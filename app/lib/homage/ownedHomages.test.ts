import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {fetchOwnedHomageIds} from '@/lib/homage/useHomageMint';

// The owned-homages enumeration is indexer-API-first with the chunked log
// scan as fallback; BOTH paths confirm every candidate against the live
// ownerOf multicall. These tests pin that contract with a stubbed client +
// fetch: which ranges get scanned, how API candidates and tail-scan
// candidates merge, and that a failed/malformed API response falls back to
// the full walk instead of trusting a hollow empty.

let deployBlockMock: number | undefined;

vi.mock('@/lib/config', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/lib/config')>();
    return {
        ...mod,
        getHomageDeployBlock: () => deployBlockMock,
    };
});

const HOMAGE = '0x1111111111111111111111111111111111111111' as const;

type EventCall = {fromBlock: bigint; toBlock: bigint};

/** Stub viem client: fixed head, canned logs per scan call, and an ownerOf
 *  multicall that reports `ownedIds` as held by the queried address. */
function stubClient(opts: {latest: bigint; logsPerCall: bigint[][]; ownedIds: Set<bigint>; owner: string}) {
    const eventCalls: EventCall[] = [];
    let call = 0;
    const client = {
        getBlockNumber: async () => opts.latest,
        getContractEvents: async ({fromBlock, toBlock}: EventCall) => {
            eventCalls.push({fromBlock, toBlock});
            const ids = opts.logsPerCall[call++] ?? [];
            return ids.map((tokenId) => ({args: {tokenId}}));
        },
        multicall: async ({contracts}: {contracts: {args: readonly [bigint]}[]}) =>
            contracts.map((c) => ({
                status: 'success' as const,
                result: opts.ownedIds.has(c.args[0]) ? opts.owner : '0x000000000000000000000000000000000000dEaD',
            })),
    };
    return {client: client as never, eventCalls};
}

function stubFetch(response: {ok: boolean; body?: unknown} | 'throw') {
    return vi.fn(async () => {
        if (response === 'throw') throw new Error('network down');
        return {
            ok: response.ok,
            json: async () => response.body,
        } as Response;
    });
}

beforeEach(() => {
    deployBlockMock = 1_000;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('fetchOwnedHomageIds', () => {
    it('API path: one fetch + one live tail chunk, candidates merged, ownerOf-confirmed', async () => {
        vi.stubGlobal('fetch', stubFetch({ok: true, body: {ids: [1, 5]}}));
        const owner = '0xAAA0000000000000000000000000000000000001';
        // id 9 arrives only via the tail scan (indexer lag); id 5 fails the
        // ownerOf confirm (indexer staleness — since transferred away).
        const {client, eventCalls} = stubClient({
            latest: 20_000n,
            logsPerCall: [[9n]],
            ownedIds: new Set([1n, 9n]),
            owner,
        });

        const res = await fetchOwnedHomageIds(client, HOMAGE, owner as `0x${string}`);

        expect(res).toEqual({ids: [1, 9], partial: false});
        // exactly ONE log scan: the tail chunk [latest-4999, latest]
        expect(eventCalls).toEqual([{fromBlock: 15_001n, toBlock: 20_000n}]);
    });

    it('API path: a deploy block inside the tail window clamps the tail scan', async () => {
        vi.stubGlobal('fetch', stubFetch({ok: true, body: {ids: []}}));
        deployBlockMock = 19_500;
        const owner = '0xAAA0000000000000000000000000000000000002';
        const {client, eventCalls} = stubClient({latest: 20_000n, logsPerCall: [[]], ownedIds: new Set(), owner});

        await fetchOwnedHomageIds(client, HOMAGE, owner as `0x${string}`);

        expect(eventCalls).toEqual([{fromBlock: 19_500n, toBlock: 20_000n}]);
    });

    it('non-200 API response falls back to the full chunk walk from the deploy block', async () => {
        vi.stubGlobal('fetch', stubFetch({ok: false}));
        const owner = '0xAAA0000000000000000000000000000000000003';
        const {client, eventCalls} = stubClient({
            latest: 12_000n,
            logsPerCall: [[7n], [], []],
            ownedIds: new Set([7n]),
            owner,
        });

        const res = await fetchOwnedHomageIds(client, HOMAGE, owner as `0x${string}`);

        expect(res).toEqual({ids: [7], partial: false});
        // full walk: [1000..5999] [6000..10999] [11000..12000]
        expect(eventCalls).toEqual([
            {fromBlock: 1_000n, toBlock: 5_999n},
            {fromBlock: 6_000n, toBlock: 10_999n},
            {fromBlock: 11_000n, toBlock: 12_000n},
        ]);
    });

    it('malformed API body falls back to the scan instead of trusting it', async () => {
        vi.stubGlobal('fetch', stubFetch({ok: true, body: {ids: 'nope'}}));
        const owner = '0xAAA0000000000000000000000000000000000004';
        const {client, eventCalls} = stubClient({latest: 6_000n, logsPerCall: [[], []], ownedIds: new Set(), owner});

        const res = await fetchOwnedHomageIds(client, HOMAGE, owner as `0x${string}`);

        expect(res).toEqual({ids: [], partial: false});
        expect(eventCalls.length).toBe(2); // walked, not API-served
    });

    it('fetch throwing falls back and marks partial when no deploy block is configured', async () => {
        vi.stubGlobal('fetch', stubFetch('throw'));
        deployBlockMock = undefined;
        const owner = '0xAAA0000000000000000000000000000000000005';
        const {client, eventCalls} = stubClient({latest: 20_000n, logsPerCall: [[]], ownedIds: new Set(), owner});

        const res = await fetchOwnedHomageIds(client, HOMAGE, owner as `0x${string}`);

        // no deploy block -> only the last chunk is scannable -> partial
        expect(res).toEqual({ids: [], partial: true});
        expect(eventCalls).toEqual([{fromBlock: 15_001n, toBlock: 20_000n}]);
    });
});
