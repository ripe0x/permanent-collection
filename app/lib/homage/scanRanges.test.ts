import {describe, expect, it} from 'vitest';

import {homageScanRanges} from '@/lib/homage/useHomageMint';

// The /api/rpc proxy fails closed on any eth_getLogs with toBlock:'latest'
// (fixed fromBlock) or a span over 5000 blocks — every range the scan emits
// must be numeric, inclusive, ≤5000 wide, contiguous, and cover [from, latest]
// exactly. These tests pin that contract.

function assertCovers(ranges: Array<[bigint, bigint]>, from: bigint, latest: bigint) {
    expect(ranges[0][0]).toBe(from);
    expect(ranges[ranges.length - 1][1]).toBe(latest);
    for (const [r0, r1] of ranges) {
        expect(r1 - r0 + 1n).toBeLessThanOrEqual(5_000n);
        expect(r0 <= r1).toBe(true);
    }
    for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1n); // contiguous, no overlap, no gap
    }
}

describe('homageScanRanges', () => {
    it('emits a single range when the window fits one chunk', () => {
        expect(homageScanRanges(100n, 100n)).toEqual([[100n, 100n]]);
        expect(homageScanRanges(0n, 4_999n)).toEqual([[0n, 4_999n]]);
    });

    it('splits an exact multiple into full chunks', () => {
        const ranges = homageScanRanges(10_000n, 19_999n);
        expect(ranges).toEqual([
            [10_000n, 14_999n],
            [15_000n, 19_999n],
        ]);
    });

    it('covers a ragged window contiguously with a short tail', () => {
        const from = 25_446_000n;
        const latest = from + 12_345n;
        const ranges = homageScanRanges(from, latest);
        expect(ranges).toHaveLength(3);
        assertCovers(ranges, from, latest);
        expect(ranges[2]).toEqual([from + 10_000n, latest]);
    });

    it('returns nothing for an inverted window', () => {
        expect(homageScanRanges(10n, 9n)).toEqual([]);
    });

    it('range starts are stable as latest advances (cache keys key off rangeStart)', () => {
        const from = 1_000n;
        const early = homageScanRanges(from, 12_000n).map(([r0]) => r0);
        const later = homageScanRanges(from, 26_000n).map(([r0]) => r0);
        expect(later.slice(0, early.length)).toEqual(early);
    });
});
