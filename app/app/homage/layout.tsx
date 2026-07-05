import type {Metadata} from 'next';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {buildMeta} from '@/lib/meta';
import './homage.css';

// PC's root layout (app/app/layout.tsx) does not render Header/Footer
// globally — every route composes them itself. Homage pages share that
// convention here so every page under /homage gets consistent site chrome.
//
// Header/Footer sit OUTSIDE `.homage-root` so they render with pure PC
// styling; only the page content is wrapped in the scope. Wrapping the
// chrome too would leak homage's font-family + the scoped input/button
// font rule into the header (the connect button and live-bid chip pick up
// homage's mono/sans instead of PC's IBM Plex).
export const metadata: Metadata = buildMeta({
    title: 'Homage to the Punk',
    description: 'A homage for every punk — onchain generative art, redeemable anytime.',
    path: '/homage',
});

export default function HomageLayout({children}: {children: React.ReactNode}) {
    return (
        <>
            <Header />
            <div className="homage-root">{children}</div>
            <Footer />
        </>
    );
}
