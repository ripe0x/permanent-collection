'use client';

import {getDefaultConfig} from '@rainbow-me/rainbowkit';
import {createConfig, http} from 'wagmi';
import {mainnet} from 'wagmi/chains';
import {mock} from 'wagmi/connectors';
import {defineChain} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {getChainId} from './config';

// Local anvil fork chain — same id (31337) used everywhere in the repo.
export const anvilFork = defineChain({
    id: 31_337,
    name: 'Anvil (mainnet fork)',
    nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
    rpcUrls: {
        default: {http: ['http://127.0.0.1:8545']},
    },
});

/** WalletConnect Cloud project id. Required by RainbowKit's WC, Rainbow, and
 *  Coinbase Wallet (mobile) connectors. Falls back to a placeholder for
 *  local-only dev — anything that actually opens a WC session needs a real
 *  id from cloud.walletconnect.com. Document in `.env.example`. */
function getWalletConnectProjectId(): string {
    return process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'LOCAL_DEV_PLACEHOLDER';
}

/** Build the wagmi config (via RainbowKit's `getDefaultConfig`).
 *
 *  Connector set comes from RainbowKit's default wallet list (MetaMask,
 *  Rainbow, WalletConnect, Coinbase Wallet, + injected fallback) — no
 *  hand-rolled connector array.
 *
 *  Chains: mainnet is always present; `anvilFork` (and therefore
 *  RainbowKit's multi-chain switcher) only appears in a localhost dev build
 *  — i.e. `next dev` (`NODE_ENV !== 'production'`) AND
 *  `NEXT_PUBLIC_CHAIN_ID=31337`. A production build (`next build`/`next
 *  start`, what ships) is always mainnet-only and can never offer "Anvil"
 *  as a switchable chain, even if `NEXT_PUBLIC_CHAIN_ID` is misconfigured.
 *  The "wrong network → switch to mainnet" helper in ConnectButton is a
 *  separate, always-on affordance (it gets users onto mainnet); it is not
 *  a multi-chain picker.
 *
 *  Read traffic for the EXPECTED chain routes through the same-origin
 *  `/api/rpc` proxy. That keeps the paid RPC API key (Alchemy/Infura/etc.)
 *  off the client bundle — only the server-side route handler at
 *  `app/app/api/rpc/route.ts` sees the upstream URL.
 *
 *  Writes still go straight from the user's wallet to the upstream node,
 *  never through us. */
/** Local-dev autosign PK. When set, the frontend builds a wagmi `mock`
 *  connector instead of RainbowKit's wallet picker — the entire UI sees
 *  it as a connected wallet that auto-signs every tx (no MetaMask popup,
 *  no extension dependency). This is the dev-fork equivalent of having
 *  a connected wallet, used by MCP-driven UI tests and by local dev
 *  when you want to skip the wallet UX.
 *
 *  Hard guard: only honoured when `NEXT_PUBLIC_CHAIN_ID === '31337'`. If
 *  someone sets DEV_AUTOSIGN_PK against any real chain, `buildWagmiConfig`
 *  throws on import so the app never boots with that misconfiguration. */
function getDevAutosignPk(): `0x${string}` | undefined {
    const pk = process.env.NEXT_PUBLIC_DEV_AUTOSIGN_PK;
    if (!pk) return undefined;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
        throw new Error(
            'NEXT_PUBLIC_DEV_AUTOSIGN_PK is set but not a 32-byte hex string. ' +
                'Expected 0x-prefixed 64-char hex. Unset it or fix the value.',
        );
    }
    return pk as `0x${string}`;
}

export function buildWagmiConfig() {
    const expectedChainId = getChainId();
    const proxyTransport = http('/api/rpc');
    const mainnetPublicTransport = http('https://ethereum-rpc.publicnode.com');
    const appName = 'Permanent Collection';
    const appDescription =
        'An on-chain protocol assembling a permanent collection of Punks.';
    const projectId = getWalletConnectProjectId();
    const devAutosignPk = getDevAutosignPk();

    // The anvil fork chain — and the multi-chain wallet switcher that comes
    // with it — is a localhost dev affordance only. Require BOTH a dev build
    // (`next dev`) AND the explicit fork chain id, so a production build can
    // never include it (and so a misconfigured `NEXT_PUBLIC_CHAIN_ID=31337`
    // on a deployed build silently falls back to mainnet-only instead of
    // surfacing the switcher). `process.env.NODE_ENV` is inlined at build
    // time, so this is identical on the server and the client (no hydration
    // split).
    const isLocalDevBuild = process.env.NODE_ENV !== 'production';
    const forkMode = expectedChainId === 31_337 && isLocalDevBuild;

    // Fail-loud: the autosign mock connector embeds a hot-wallet PK in the
    // client bundle, so it must ONLY ever exist in a localhost fork build.
    // Anything else (a real chain, or a production build) is a
    // misconfiguration — throw rather than silently ship the PK.
    if (devAutosignPk && !forkMode) {
        throw new Error(
            'NEXT_PUBLIC_DEV_AUTOSIGN_PK is set outside a localhost anvil fork. ' +
                'It is honoured only when NODE_ENV is development AND ' +
                'NEXT_PUBLIC_CHAIN_ID=31337. Unset it or run the local fork.',
        );
    }

    // Dev-autosign path: hand-roll the wagmi config with the mock
    // connector. RainbowKit's `getDefaultConfig` doesn't expose a clean
    // way to inject a mock connector, so we drop it for this mode.
    // RainbowKitProvider still works against this config — its modal
    // just lists no wallets, but `useAccount()` etc. still see the
    // mock account as connected (auto-connect lives in `DevAutoConnect`).
    if (devAutosignPk && forkMode) {
        const account = privateKeyToAccount(devAutosignPk);
        return createConfig({
            chains: [anvilFork, mainnet] as const,
            connectors: [mock({accounts: [account.address]})],
            transports: {
                [anvilFork.id]: proxyTransport,
                [mainnet.id]: mainnetPublicTransport,
            },
            ssr: true,
        });
    }

    // Normal path: RainbowKit wallet picker. Branch on chain so chains
    // + transports stay aligned for the typechecker. Read traffic for
    // the EXPECTED chain routes through the same-origin `/api/rpc`
    // proxy (keeps paid RPC keys server-side); the other chain (when
    // present) uses a free public RPC.
    if (forkMode) {
        return getDefaultConfig({
            appName,
            appDescription,
            projectId,
            chains: [anvilFork, mainnet] as const,
            transports: {
                [anvilFork.id]: proxyTransport,
                [mainnet.id]: mainnetPublicTransport,
            },
            ssr: true,
        });
    }
    return getDefaultConfig({
        appName,
        appDescription,
        projectId,
        chains: [mainnet] as const,
        transports: {
            [mainnet.id]: proxyTransport,
        },
        ssr: true,
    });
}

/** True when the autosign mock connector is active. UI code can branch
 *  on this to skip the connect-wallet dance and present the auto-connected
 *  account directly. */
export function isDevAutosignActive(): boolean {
    return (
        getDevAutosignPk() !== undefined &&
        getChainId() === 31_337 &&
        process.env.NODE_ENV !== 'production'
    );
}
