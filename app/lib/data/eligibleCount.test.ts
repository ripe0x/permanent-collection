import {describe, expect, it} from 'vitest';

import {countEligiblePunks, maskFromTraitIds} from './eligibleCount';
import {PUNK_MASKS} from '@/lib/punkMasks';

const ALL_TRAITS = maskFromTraitIds(Array.from({length: 111}, (_, i) => i));

describe('countEligiblePunks', () => {
    it('counts every Punk at the zero state (nothing collected, nothing pending)', () => {
        // Every Punk carries at least one trait, so with no bits blocked the
        // whole dataset is eligible.
        expect(countEligiblePunks(0n, 0n, [])).toBe(10_000);
    });

    it('counts zero when every trait bit is blocked', () => {
        expect(countEligiblePunks(ALL_TRAITS, 0n, [])).toBe(0);
        expect(countEligiblePunks(0n, ALL_TRAITS, [])).toBe(0);
    });

    it('excludes Punks in protocol custody one-for-one', () => {
        // With no bits blocked all 10,000 are otherwise eligible, so each
        // blocked Punk id removes exactly one.
        expect(countEligiblePunks(0n, 0n, [0, 1, 2])).toBe(9_997);
        // Duplicates collapse (a Punk can't be blocked twice).
        expect(countEligiblePunks(0n, 0n, [5, 5, 5])).toBe(9_999);
    });

    it('treats collected and pending bits identically and monotonically', () => {
        // Blocking more bits can only shrink (never grow) the eligible set,
        // and splitting the same bits across the two masks changes nothing.
        let prev = 10_000;
        let mask = 0n;
        for (let t = 0; t < 111; t += 10) {
            mask |= 1n << BigInt(t);
            const viaCollected = countEligiblePunks(mask, 0n, []);
            const viaPending = countEligiblePunks(0n, mask, []);
            expect(viaCollected).toBe(viaPending);
            expect(viaCollected).toBeLessThanOrEqual(prev);
            prev = viaCollected;
        }
    });

    it('a Punk is ineligible once all its traits are blocked', () => {
        // Block exactly Punk #0's traits: #0 must drop out of the count
        // without being in the custody set.
        const without = countEligiblePunks(PUNK_MASKS[0], 0n, []);
        const withCustody = countEligiblePunks(PUNK_MASKS[0], 0n, [0]);
        expect(without).toBe(withCustody);
    });
});
