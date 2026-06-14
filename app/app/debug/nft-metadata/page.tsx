/* NFT metadata debug surface. Direct contract reads of tokenURI /
 * contractURI on PunkVault (ERC-721 Proofs + Title) and the artcoin ERC-20,
 * with raw URI + parsed metadata. Hidden from search. */

import type {Metadata} from 'next';

import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {NftMetadataDebug} from '@/components/NftMetadataDebug';
import {buildMeta} from '@/lib/meta';

export const metadata: Metadata = {
    ...buildMeta({
        title: 'Debug — NFT metadata',
        description: 'Direct tokenURI / contractURI reads for the Proofs, Title, and token.',
        path: '/debug/nft-metadata',
    }),
    robots: {index: false, follow: false},
};

export const dynamic = 'force-dynamic';

export default function NftMetadataDebugPage() {
    return (
        <>
            <Header />
            <main id="top">
                <section className="nftdbg-page">
                    <div className="wrap">
                        <div className="kicker">Debug</div>
                        <h1 className="section-title">NFT metadata.</h1>
                        <p className="nftdbg-intro">
                            Direct <code>eth_call</code> reads of <code>tokenURI</code> and{' '}
                            <code>contractURI</code> on <code>PunkVault</code> (the ERC-721 Proofs +
                            Title) and the ERC-20 token. Shows the raw returned data URI and the
                            parsed metadata (name, attributes, image).
                        </p>
                        <NftMetadataDebug />
                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

const styles = `
.nftdbg-page {
    padding-top: clamp(40px, 6vh, 80px);
    padding-bottom: clamp(80px, 12vh, 160px);
}
.nftdbg-intro {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.65;
    color: var(--muted);
    max-width: 640px;
    margin: 14px 0 28px;
}
.nftdbg-intro code {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
    background: var(--panel);
    padding: 1px 5px;
}
`;
