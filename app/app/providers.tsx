'use client';

import '@rainbow-me/rainbowkit/styles.css';

import {RainbowKitProvider, lightTheme} from '@rainbow-me/rainbowkit';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {useMemo, type ReactNode} from 'react';
import {WagmiProvider} from 'wagmi';
import {buildWagmiConfig} from '@/lib/wagmi';
import {DevAutoConnect} from '@/components/DevAutoConnect';

// Brand tokens (see app/app/globals.css): --accent: #111111, --bg: #FFFFFF.
// Keep RainbowKit's modal visually close to the rest of the site.
const rainbowTheme = lightTheme({
    accentColor: '#111111',
    accentColorForeground: '#FFFFFF',
    borderRadius: 'none',
    fontStack: 'system',
    overlayBlur: 'small',
});

export function Providers({children}: {children: ReactNode}) {
    // Memoize so HMR doesn't tear the wagmi state every render. Both
    // wagmi and react-query expect stable instances across renders.
    const wagmi = useMemo(() => buildWagmiConfig(), []);
    const query = useMemo(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        // Opt-in polling. A blanket 30s default polled
                        // EVERY useReadContract / useBalance / useQuery
                        // on every mounted page (DesignBStatus, SwapBox
                        // background reads, etc.) — death by a thousand
                        // background reads against a paid RPC. Components
                        // that genuinely need live updates (the live-bid
                        // headline, bid history) set their own
                        // refetchInterval and route through cached API
                        // endpoints; everything else relies on
                        // refetchOnWindowFocus + manual refetch after a
                        // tx confirms.
                        refetchInterval: false,
                        staleTime: 15_000,
                        // Never spinner-of-doom on a flaky RPC — surface
                        // the last good value with a "stale" badge.
                        retry: 1,
                    },
                },
            }),
        [],
    );
    return (
        <WagmiProvider config={wagmi}>
            <QueryClientProvider client={query}>
                <RainbowKitProvider theme={rainbowTheme} modalSize="compact">
                    <DevAutoConnect />
                    {children}
                </RainbowKitProvider>
            </QueryClientProvider>
        </WagmiProvider>
    );
}
