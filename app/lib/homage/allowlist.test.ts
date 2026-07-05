import {describe, expect, it} from 'vitest';

import {ALLOWLIST_COUNT, ALLOWLIST_ROOT, allowlistProofFor} from '@/lib/homage/allowlist';

// The proofs file is a vendored byte-identical artifact (see allowlist.ts) —
// these tests exercise the LOOKUP semantics against whatever data ships, not
// specific addresses, so a regenerated allowlist doesn't break them.

describe('allowlist proofs', () => {
    it('exposes a 32-byte root and a positive count consistent with the data', () => {
        expect(ALLOWLIST_ROOT).toMatch(/^0x[0-9a-f]{64}$/i);
        expect(ALLOWLIST_COUNT).toBeGreaterThan(0);
    });

    it('resolves a listed address case-insensitively', () => {
        // Any address in the vendored file works; grab one via a known-listed
        // deployer used by the test allowlist. If the file is regenerated and
        // this address drops off, swap it for any key in the JSON.
        const listed = '0xcb43078c32423f5348cab5885911c3b5fae217f9';
        const lower = allowlistProofFor(listed);
        const upper = allowlistProofFor(listed.toUpperCase().replace('0X', '0x'));
        const checksummy = allowlistProofFor('0xCB43078C32423F5348Cab5885911C3B5faE217F9');
        expect(lower).not.toBeNull();
        expect(lower!.length).toBeGreaterThan(0);
        expect(upper).toEqual(lower);
        expect(checksummy).toEqual(lower);
        for (const node of lower!) expect(node).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('returns null for an unlisted address', () => {
        expect(allowlistProofFor('0x000000000000000000000000000000000000dEaD')).toBeNull();
    });
});
