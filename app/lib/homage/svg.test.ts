import {describe, expect, it} from 'vitest';

import {anySvgToSrc, decodeTokenURI, svgToSrc, trait} from '@/lib/homage/svg';

describe('decodeTokenURI', () => {
    const meta = {
        name: 'Homage 42',
        image: 'data:image/svg+xml;base64,PHN2Zy8+',
        attributes: [{trait_type: 'Status', value: 'Not For Sale'}],
    };

    it('decodes a base64 data URI (the on-chain tokenURI shape)', () => {
        const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(meta)).toString('base64')}`;
        expect(decodeTokenURI(uri)).toEqual(meta);
    });

    it('decodes a utf8/url-encoded data URI', () => {
        const uri = `data:application/json;utf8,${encodeURIComponent(JSON.stringify(meta))}`;
        expect(decodeTokenURI(uri)).toEqual(meta);
    });

    it('returns null on garbage instead of throwing', () => {
        expect(decodeTokenURI('not-a-data-uri')).toBeNull();
        expect(decodeTokenURI('data:application/json;base64,%%%')).toBeNull();
    });
});

describe('anySvgToSrc', () => {
    it('encodes a bare <svg> string', () => {
        expect(anySvgToSrc('<svg fill="#fff"/>')).toBe(svgToSrc('<svg fill="#fff"/>'));
        expect(anySvgToSrc('<svg fill="#fff"/>')).not.toContain('#');
    });

    it('re-encodes the unescaped utf8 data-URI shape (raw # would truncate an <img> src)', () => {
        const raw = 'data:image/svg+xml;utf8,<svg fill="#fff"/>';
        expect(anySvgToSrc(raw)).toBe(svgToSrc('<svg fill="#fff"/>'));
    });

    it('passes through an already-complete data URI', () => {
        const b64 = 'data:image/svg+xml;base64,PHN2Zy8+';
        expect(anySvgToSrc(b64)).toBe(b64);
    });
});

describe('trait', () => {
    it('finds a trait value by type and tolerates null metadata', () => {
        const m = {attributes: [{trait_type: 'Color Count', value: 7}]};
        expect(trait(m, 'Color Count')).toBe(7);
        expect(trait(m, 'Missing')).toBeUndefined();
        expect(trait(null, 'Anything')).toBeUndefined();
    });
});
