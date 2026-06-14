/* Debug index. Lists every debug surface in one place so future
 * additions don't sprawl. Hidden from search via robots metadata. */

import type {Metadata} from 'next';
import Link from 'next/link';

import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {buildMeta} from '@/lib/meta';

export const metadata: Metadata = {
    ...buildMeta({
        title: 'Debug',
        description: 'Internal debug surfaces for Permanent Collection.',
        path: '/debug',
    }),
    robots: {index: false, follow: false},
};

const PAGES: Array<{href: string; title: string; blurb: string}> = [
    {
        href: '/debug/fees',
        title: 'Fee phases',
        blurb: 'Walk through every fee-routing phase: pre/post-acquisition, pre/post-vault, MEV window.',
    },
    {
        href: '/debug/nft-metadata',
        title: 'NFT metadata',
        blurb: 'Direct tokenURI / contractURI reads for the Proofs, Title, and ERC-20 token — raw URI + parsed metadata.',
    },
    {
        href: '/debug/distribution',
        title: 'Value distribution',
        blurb: 'Live status of every fee/auction distribution step plus a merged event history — for walking through local fork stages.',
    },
    {
        href: '/e2e',
        title: 'E2E walkthrough',
        blurb: 'Browseable index of the 22-state end-to-end UI test pass — per-state writeup + desktop and mobile screenshots.',
    },
];

export default function DebugIndex() {
    return (
        <>
            <Header />
            <main id="top">
                <section className="debug-index">
                    <div className="wrap">
                        <div className="kicker">Debug</div>
                        <h1 className="section-title">Debug surfaces.</h1>
                        <ul className="debug-list">
                            {PAGES.map((p) => (
                                <li key={p.href} className="debug-list-item">
                                    <Link href={p.href} className="debug-list-link">
                                        <strong>{p.title}</strong>
                                        <span>{p.blurb}</span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

const styles = `
.debug-index {
    padding-top: clamp(60px, 9vh, 100px);
    padding-bottom: clamp(80px, 12vh, 160px);
}
.debug-list {
    margin-top: 28px;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.debug-list-link {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 16px 18px;
    background: var(--panel);
    border: 1px solid var(--line);
    color: var(--ink);
    transition: border-color 120ms ease;
}
.debug-list-link:hover { border-color: var(--ink); }
.debug-list-link strong {
    font-family: var(--mono);
    font-size: 13px;
    letter-spacing: 0.06em;
    color: var(--ink);
}
.debug-list-link span {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
`;
