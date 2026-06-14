/**
 * Component tests for ReferralShare. Covers the render surface (link text,
 * copy button) and the connected/empty states. The clipboard + native-share
 * side effects are exercised end-to-end in the Playwright suite, where a real
 * browser provides those APIs.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
// Registers the DOM matchers (toBeInTheDocument, toHaveAttribute, …) and
// their type augmentation for this file. No global setup file exists, so
// the import is local — matching the repo's per-file test convention.
import '@testing-library/jest-dom/vitest';

import {ReferralShare} from './ReferralShare';

const ADDR = '0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4';

describe('ReferralShare', () => {
    let prev: string | undefined;
    beforeEach(() => {
        prev = process.env.NEXT_PUBLIC_SITE_URL;
        process.env.NEXT_PUBLIC_SITE_URL = 'https://example.test';
    });
    afterEach(() => {
        cleanup();
        if (prev === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
        else process.env.NEXT_PUBLIC_SITE_URL = prev;
    });

    it('renders the connect prompt when no referrer is set', () => {
        render(<ReferralShare />);
        expect(screen.getByText(/connect a wallet/i)).toBeInTheDocument();
    });

    it('renders nothing in compact mode without a referrer', () => {
        const {container} = render(<ReferralShare compact />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders the link and copy button for a referrer, with no social intents or QR', () => {
        render(<ReferralShare referrer={ADDR} />);

        // Link display (protocol stripped).
        expect(
            screen.getByText(`example.test/trade?ref=${ADDR}`),
        ).toBeInTheDocument();

        // Copy button.
        expect(screen.getByRole('button', {name: /copy/i})).toBeInTheDocument();

        // The social compose intents and QR were removed.
        expect(screen.queryByRole('link', {name: /share on x/i})).toBeNull();
        expect(screen.queryByRole('link', {name: /share on farcaster/i})).toBeNull();
        expect(document.querySelector('svg')).toBeNull();
    });

    it('shows the vanity link plus the raw address link when a slug is set', () => {
        render(<ReferralShare referrer={ADDR} slug="alice" />);
        expect(screen.getByText('example.test/r/alice')).toBeInTheDocument();
        expect(
            screen.getByText(`example.test/trade?ref=${ADDR}`),
        ).toBeInTheDocument();
    });

    it('minimal variant: link + copy + note, no QR or social intents', () => {
        render(<ReferralShare referrer={ADDR} minimal />);
        expect(screen.getByText(`example.test/trade?ref=${ADDR}`)).toBeInTheDocument();
        expect(screen.getByRole('button', {name: /^copy$/i})).toBeInTheDocument();
        expect(screen.queryByRole('link', {name: /share on x/i})).toBeNull();
        expect(document.querySelector('svg')).toBeNull();

        // The note explains what they get + where to claim.
        expect(screen.getByText(/send up to/i)).toBeInTheDocument();
        expect(screen.getByText(/of volume to you/i)).toBeInTheDocument();
        const claim = screen.getByRole('link', {name: /claim on the referrals page/i});
        expect(claim).toHaveAttribute('href', '/referrals');
    });

    it('minimal variant renders nothing without a referrer', () => {
        const {container} = render(<ReferralShare minimal />);
        expect(container).toBeEmptyDOMElement();
    });
});
