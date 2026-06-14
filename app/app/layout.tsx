import type {Metadata} from 'next';
import {IBM_Plex_Mono, IBM_Plex_Serif, Inter} from 'next/font/google';
import {Providers} from './providers';
import './globals.css';

// next/font self-hosts these at build time — no Google CDN request from the
// browser, no layout shift, no FOUT on the hero number.
const ibmPlexSerif = IBM_Plex_Serif({
    variable: '--font-serif',
    subsets: ['latin'],
    weight: ['300', '400', '500'],
    style: ['normal', 'italic'],
    display: 'swap',
});

const inter = Inter({
    variable: '--font-sans',
    subsets: ['latin'],
    weight: ['400', '500', '600'],
    display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
    variable: '--font-mono',
    subsets: ['latin'],
    weight: ['400', '500'],
    display: 'swap',
});

import {buildMeta, TAGLINE} from '@/lib/meta';
import {readRuntimePublicConfig} from '@/lib/config';

// Render every route per request so the root layout reads runtime env
// (`PC_*` over `NEXT_PUBLIC_*`) at request time and injects it for the client.
// Without this a statically-rendered layout would bake build-time addresses
// into the page, defeating the no-rebuild launch flip. The app is already
// dynamic across its data-driven routes; this makes it uniform.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = buildMeta({
    title: 'Permanent Collection',
    bareTitle: true,
    description: TAGLINE,
    path: '/',
});

export default function RootLayout({children}: {children: React.ReactNode}) {
    // Resolve launch-flippable config from request-time env and hand it to the
    // client via a parser-blocking inline <script> placed before the app
    // bundle, so `getContractAddresses()` / `isProtocolLive()` read it from
    // `window.__PC_RUNTIME_CONFIG__` at runtime (no rebuild to go live). SSR
    // reads the same env this request, so server render and client hydration
    // agree. `<` is escaped to keep the inline JSON injection-safe.
    const runtimeConfig = readRuntimePublicConfig();
    const runtimeConfigJson = JSON.stringify(runtimeConfig).replace(/</g, '\\u003c');
    return (
        <html lang="en" className={`${ibmPlexSerif.variable} ${inter.variable} ${ibmPlexMono.variable}`}>
            <body>
                <script
                    id="__pc_runtime_config"
                    dangerouslySetInnerHTML={{
                        __html: `window.__PC_RUNTIME_CONFIG__=${runtimeConfigJson};`,
                    }}
                />
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
