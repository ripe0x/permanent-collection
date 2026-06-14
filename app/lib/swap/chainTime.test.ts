import {afterEach, describe, expect, it, vi} from 'vitest';
import type {PublicClient} from 'viem';

import {chainDeadlineBaseSeconds} from '@/lib/swap/chainTime';

// `chainDeadlineBaseSeconds` is the "what timestamp will the next mined block
// carry" base used by both the swap/permit deadlines AND the auction countdown
// (via `getChainTimeSeconds`). It must return max(pending, latest, wallClock)
// so the countdown advances with real time — and so a page reload recomputes a
// fresh, monotonically-advancing "now" instead of snapping back to a frozen
// chain head. These tests pin that behavior across the regimes the countdown
// runs in.

const WALL_SEC = 1_700_000_000;

/** Minimal viem client stub returning canned timestamps per blockTag. */
function clientWith(opts: {
    latest: number;
    pending?: number | 'throw';
}): PublicClient {
    return {
        getBlock: vi.fn(async ({blockTag}: {blockTag: 'pending' | 'latest'}) => {
            if (blockTag === 'pending') {
                if (opts.pending === 'throw' || opts.pending === undefined) {
                    throw new Error('pending not served');
                }
                return {timestamp: BigInt(opts.pending)};
            }
            return {timestamp: BigInt(opts.latest)};
        }),
    } as unknown as PublicClient;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('chainDeadlineBaseSeconds — next-block timestamp base', () => {
    it('mainnet: pending leads by ~one block and wins', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(WALL_SEC * 1000);
        const client = clientWith({latest: WALL_SEC, pending: WALL_SEC + 12});
        expect(await chainDeadlineBaseSeconds(client)).toBe(WALL_SEC + 12);
    });

    it('frozen fork: latest is stale, wall clock advances "now"', async () => {
        // anvil idle: latest frozen 1h ago; pending tracks elapsed wall time.
        vi.spyOn(Date, 'now').mockReturnValue(WALL_SEC * 1000);
        const frozenLatest = WALL_SEC - 3_600;
        const client = clientWith({latest: frozenLatest, pending: WALL_SEC});
        // max(pending=WALL, latest=WALL-3600, wall=WALL) === WALL, not the frozen head.
        expect(await chainDeadlineBaseSeconds(client)).toBe(WALL_SEC);
    });

    it('warped-ahead fork: chain leads wall clock and wins (window reads its true position)', async () => {
        // dev warp: chain is ~72h ahead of real time; pending carries the warp + elapsed.
        vi.spyOn(Date, 'now').mockReturnValue(WALL_SEC * 1000);
        const warp = WALL_SEC + 72 * 3_600;
        const client = clientWith({latest: warp, pending: warp + 30});
        expect(await chainDeadlineBaseSeconds(client)).toBe(warp + 30);
    });

    it('pending unavailable: falls back to max(latest, wallClock)', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(WALL_SEC * 1000);
        // frozen fork, no pending served → wall clock still advances "now".
        const client = clientWith({latest: WALL_SEC - 3_600, pending: 'throw'});
        expect(await chainDeadlineBaseSeconds(client)).toBe(WALL_SEC);
    });

    it('reload stability: a later wall instant never goes backward', async () => {
        const frozenLatest = WALL_SEC - 3_600; // chain frozen
        const client = clientWith({latest: frozenLatest, pending: 'throw'});

        vi.spyOn(Date, 'now').mockReturnValue(WALL_SEC * 1000);
        const t0 = await chainDeadlineBaseSeconds(client);
        vi.spyOn(Date, 'now').mockReturnValue((WALL_SEC + 600) * 1000); // reload 10 min later
        const t1 = await chainDeadlineBaseSeconds(client);

        expect(t1).toBe(t0 + 600); // advanced by real elapsed, not reset to the frozen head
        expect(t1).toBeGreaterThan(t0);
    });
});
