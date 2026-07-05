// Environment configuration. Every protocol address, chain id, and RPC URL
// flows through this module — components never inline constants. Production
// must fail loudly if any required value is missing.
//
// IMPORTANT: every `process.env.NEXT_PUBLIC_*` access here uses the literal
// key. Next.js statically inlines those at build time for client bundles,
// so the values reach client components without a runtime env lookup. A
// dynamic `process.env[key]` would compile to `undefined` on the client.

import type {Address} from './data/types';

const SUPPORTED_CHAIN_IDS = [1, 31_337] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

export interface ContractAddresses {
    permanentCollection: Address;
    patron: Address;
    returnAuctionModule: Address;
    punkVault: Address;
    buybackBurner: Address;
    liveBidAdapter: Address;
    vaultBurnPool: Address;
    /** Retired 2026-05-28 alongside the hook's vault-burn leg. Field is
     *  kept optional so frontend builds against older `deployments.json`
     *  files (which still emit it) don't break their type narrowing. New
     *  builds omit it; consumers must check for undefined. */
    vaultBurnAdapter?: Address;
    /** Receives the baseline protocol skim leg from the hook and sweeps it
     *  to PCController (PC-treasury / LAYER-burn split) from block 1 — a
     *  plain forwarder, no phase gate. Pre-redesign frontend builds didn't
     *  track this — optional for backward compat with stale .env.local
     *  files that predate the deploy re-run. UI code that needs it must
     *  check for undefined. */
    protocolFeePhaseAdapter?: Address;
    /** Pull-based per-referrer ETH ledger. Wired into the hook config at pool
     *  init; the hook calls `notify(referrer)` whenever a swap carries a
     *  valid referrer attribution (from the first swap). Referrers (or
     *  anyone via `claimFor`) pull via `claim`.
     *
     *  Optional in the config because the contract is part of the new
     *  permanent surface — local fork .env.local files predating the deploy
     *  re-run will not have it. Frontend code that needs it must check for
     *  undefined and surface a "not deployed yet" state. */
    referralPayout?: Address;
    /** Reentrancy-detection registry shared across PC contracts. Owner is
     *  the deployer EOA; `authorizedExtension == address(0)` at launch
     *  (the flag is permanently `false` until a Design B dispatcher binds
     *  later via `setAuthorizedExtension` + the artcoins allowlist +
     *  `TokenAdminPoker.bindExtension`). Optional for the same .env.local
     *  staleness reason as `referralPayout`. */
    pcSwapContext?: Address;
    /** PunkVaultTitleAuction — one-shot english auction for the vault Title
     *  (PunkVault tokenId 111). Permissionless `kickoff` once
     *  `collection.collectedCount() >= KICKOFF_THRESHOLD` (=22 at launch,
     *  per PunkVaultTitleAuction.sol). Optional in the config for backward
     *  compat with .env.local files that predate the Title Auction deploy —
     *  UI code that needs it must check for undefined and surface a "not
     *  deployed" state. */
    titleAuction?: Address;
    renderer: Address;
    token: Address;
    protocolAdmin: Address;
    /** The artcoins V4 hook the 111 pool launched on — a per-launch
     *  CREATE2-mined contract (not canonical), needed to compute the pool id.
     *  Read here so it flips together with `token` at launch (a live token
     *  paired with a zero hook would compute the wrong pool id). Optional for
     *  the same staleness reason as the others; pool-key consumers fall back
     *  to the zero address (the correct "not launched yet" state). */
    artcoinsHook?: Address;
    /** Homage to the Punk — self-contained ERC721 mint/redeem contract (each
     *  punk gets a generative homage backed by escrowed 111, redeemable
     *  anytime). Not yet deployed to mainnet: unset ⇒ the /homage section
     *  renders the local explore/preview experience and "mint not yet open";
     *  set ⇒ full mint/redeem goes live. */
    homage?: Address;
    /** PermanenceRenderer for the Homage collection (on-chain SVG + metadata).
     *  Distinct from `renderer` (PC's own RendererRegistry). Optional for the
     *  same pre-deploy reason as `homage`. */
    homageRenderer?: Address;
    // External (canonical mainnet, same address everywhere we care about).
    punksMarket: Address;
    punksData: Address;
}

/** Uniswap V4 + Permit2 infrastructure addresses. These are canonical and
 *  identical across mainnet and the local anvil fork (which is just a fork
 *  of mainnet state), so they live as constants — no env vars. */
export interface V4Infrastructure {
    /** Uniswap V4 PoolManager — the swap singleton. */
    poolManager: Address;
    /** Uniswap V4 Quoter — `quoteExactInputSingle` for price discovery. */
    quoter: Address;
    /** Uniswap V4 StateView — `getSlot0` for spot reference (price impact). */
    stateView: Address;
    /** Uniswap Universal Router — the entry point for V4 swaps. */
    universalRouter: Address;
    /** Permit2 — allowance manager used by Universal Router. Same address on every chain. */
    permit2: Address;
    /** Canonical WETH. Unused for the native-ETH-paired 111 pool but kept
     *  here so future WETH-pool work doesn't need a new accessor. */
    weth: Address;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

function asAddress(_key: string, v: string | undefined): Address {
    // Unset → the zero address. Before the protocol is deployed its contract
    // addresses simply aren't configured yet; the app detects that via
    // `isProtocolLive()` and renders the full UI with honest zeros (chain
    // reads against 0x0 resolve to empty/0) and "not launched yet" on the
    // action CTAs. Fixed external contracts (PunksData, V4 infra) are set
    // separately and always present, so the artwork still renders.
    if (!v) return ZERO_ADDRESS;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
        throw new Error(`config: ${_key} is not a 0x-prefixed 20-byte address: ${v}`);
    }
    return v as Address;
}

/** Soft variant of `asAddress`: returns undefined if the env var isn't set,
 *  throws only on a malformed value. Use for optional addresses (new
 *  contracts that may not be deployed yet in every environment). */
function asAddressOptional(key: string, v: string | undefined): Address | undefined {
    if (!v) return undefined;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
        throw new Error(`config: ${key} is not a 0x-prefixed 20-byte address: ${v}`);
    }
    return v as Address;
}

/** User-facing display symbol for the protocol's artcoin (e.g. "111").
 *  Pulled from NEXT_PUBLIC_TOKEN_SYMBOL so UI copy does not hard-code the
 *  symbol. Distinct from `token` in `ContractAddresses` which is the
 *  on-chain ERC20 address.
 *
 *  The stored symbol does NOT begin with `$` (user convention). Use
 *  `getTokenTicker()` when you want the "$"-prefixed display form (in
 *  trade buttons, market labels, anywhere the ticker reading
 *  disambiguates from a number). */
export function getTokenSymbol(): string {
    return process.env.NEXT_PUBLIC_TOKEN_SYMBOL ?? '111';
}

/** Ticker-form display reference for the artcoin: `$111`. Use this in
 *  user-facing copy instead of {@link getTokenSymbol} so the symbol
 *  reads as a ticker rather than the number 111. */
export function getTokenTicker(): string {
    return `$${getTokenSymbol()}`;
}

export function getChainId(): SupportedChainId {
    const raw = process.env.NEXT_PUBLIC_CHAIN_ID ?? '1';
    const id = Number(raw) as SupportedChainId;
    if (!(SUPPORTED_CHAIN_IDS as readonly number[]).includes(id)) {
        throw new Error(`config: unsupported chain id ${raw}`);
    }
    return id;
}

/** Server-only RPC URLs. Read from `RPC_URL` (+ optional `RPC_URL_FALLBACK`)
 *  with no `NEXT_PUBLIC_` prefix, so the paid endpoint never ships in the
 *  client bundle. Server components (`lib/data/live.ts`, API routes) call
 *  this directly. The client transport goes through `/api/rpc` instead;
 *  see `lib/wagmi.ts`.
 *
 *  Mainnet resolution: a single provider on the critical path has bitten
 *  this project before (Alchemy CU exhaustion, monthly cap, transient 5xx).
 *  We always include free public fallbacks behind the paid primary so a
 *  hiccup degrades to a slower-but-working response instead of an outage.
 *  Tenderly first per the project rule (archive-state friendly, no key,
 *  survives fork-init bursts where the rest fail). See ~/.claude/CLAUDE.md
 *  "RPC Provider Strategy".
 *
 *  Fork resolution: anvil mode resolves to RPC_URL only (must be set to
 *  the local node, e.g. http://127.0.0.1:8545). Appending public mainnet
 *  RPCs to a fork's fallback list would route reads off the fork — a
 *  silent data-source split. Documented behaviour: fork dev requires
 *  the local node to be up. */
export function getRpcUrls(): string[] {
    const chainId = getChainId();
    if (chainId === 31_337) {
        const primary = process.env.RPC_URL;
        if (!primary) {
            throw new Error(
                'config: RPC_URL must be set on the local fork (e.g. http://127.0.0.1:8545)',
            );
        }
        return [primary];
    }

    // Mainnet: paid primary (if set) → Tenderly public gateway → publicnode
    // → llamarpc → cloudflare → RPC_URL_FALLBACK (if set). De-duplicated so
    // an operator can set RPC_URL to one of the publics without doubling it.
    const primary = process.env.RPC_URL;
    const explicitFallback = process.env.RPC_URL_FALLBACK;
    const PUBLIC_MAINNET_FALLBACKS = [
        'https://gateway.tenderly.co/public/mainnet',
        'https://ethereum-rpc.publicnode.com',
        'https://eth.llamarpc.com',
        'https://cloudflare-eth.com',
    ];
    const ordered = [primary, ...PUBLIC_MAINNET_FALLBACKS, explicitFallback].filter(
        (x): x is string => typeof x === 'string' && x.length > 0,
    );
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const u of ordered) {
        const k = u.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        urls.push(u);
    }
    if (urls.length === 0) {
        // Unreachable: PUBLIC_MAINNET_FALLBACKS always has entries. Keep as a
        // belt-and-braces for future refactors that strip the constant.
        throw new Error('config: no RPC URLs resolved');
    }
    return urls;
}

// --- Runtime vs build-time address resolution -----------------------------
//
// Addresses must be able to flip from "pre-launch" (unset) to "live" without
// rebuilding the client bundle, so an operator can launch by changing an env
// var + restarting the Node runtime (sub-second on Vercel/Netlify) rather than
// triggering a 1-2 min rebuild. Two sources, layered:
//
//   1. SERVER (request time): `addressesFromRuntimeEnv()` reads a server-only
//      `PC_<NAME>` overriding the build-time `NEXT_PUBLIC_<NAME>`. Next.js does
//      NOT inline non-`NEXT_PUBLIC_` env, so `PC_*` is a true runtime lookup.
//   2. CLIENT: the root layout serializes the server-resolved config into
//      `window.__PC_RUNTIME_CONFIG__` (see `readRuntimePublicConfig`), and the
//      client reads from there — so nothing is baked into the JS bundle. If the
//      global is somehow absent it falls back to the build-time `NEXT_PUBLIC_*`
//      (`addressesFromNextPublic`), preserving the prior behavior.
//
// `getContractAddresses()` / `isProtocolLive()` keep their signatures and pick
// the right source per environment, so no call site changes.

const CANONICAL_PUNKS = {
    punksMarket: '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as Address,
    punksData: '0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C' as Address,
};

/** Build the address map from the build-time-inlined `NEXT_PUBLIC_*` env vars.
 *  CLIENT fallback only (used when `window.__PC_RUNTIME_CONFIG__` is absent).
 *  Keys are LITERAL so Next.js inlines them into the client bundle — a dynamic
 *  `process.env[key]` would compile to `undefined` on the client (see header). */
function addressesFromNextPublic(): ContractAddresses {
    return {
        permanentCollection: asAddress(
            'NEXT_PUBLIC_PERMANENT_COLLECTION_ADDRESS',
            process.env.NEXT_PUBLIC_PERMANENT_COLLECTION_ADDRESS,
        ),
        patron: asAddress('NEXT_PUBLIC_PATRON_ADDRESS', process.env.NEXT_PUBLIC_PATRON_ADDRESS),
        returnAuctionModule: asAddress(
            'NEXT_PUBLIC_RETURN_AUCTION_MODULE_ADDRESS',
            process.env.NEXT_PUBLIC_RETURN_AUCTION_MODULE_ADDRESS,
        ),
        punkVault: asAddress('NEXT_PUBLIC_PUNK_VAULT_ADDRESS', process.env.NEXT_PUBLIC_PUNK_VAULT_ADDRESS),
        buybackBurner: asAddress(
            'NEXT_PUBLIC_BUYBACK_BURNER_ADDRESS',
            process.env.NEXT_PUBLIC_BUYBACK_BURNER_ADDRESS,
        ),
        liveBidAdapter: asAddress(
            'NEXT_PUBLIC_LIVE_BID_ADAPTER_ADDRESS',
            process.env.NEXT_PUBLIC_LIVE_BID_ADAPTER_ADDRESS,
        ),
        vaultBurnPool: asAddress(
            'NEXT_PUBLIC_VAULT_BURN_POOL_ADDRESS',
            process.env.NEXT_PUBLIC_VAULT_BURN_POOL_ADDRESS,
        ),
        // VaultBurnAdapter was retired 2026-05-28. Field stays optional so
        // older `.env.local` files still narrow correctly.
        vaultBurnAdapter: asAddressOptional(
            'NEXT_PUBLIC_VAULT_BURN_ADAPTER_ADDRESS',
            process.env.NEXT_PUBLIC_VAULT_BURN_ADAPTER_ADDRESS,
        ),
        protocolFeePhaseAdapter: asAddressOptional(
            'NEXT_PUBLIC_PROTOCOL_FEE_PHASE_ADAPTER_ADDRESS',
            process.env.NEXT_PUBLIC_PROTOCOL_FEE_PHASE_ADAPTER_ADDRESS,
        ),
        referralPayout: asAddressOptional(
            'NEXT_PUBLIC_REFERRAL_PAYOUT_ADDRESS',
            process.env.NEXT_PUBLIC_REFERRAL_PAYOUT_ADDRESS,
        ),
        pcSwapContext: asAddressOptional(
            'NEXT_PUBLIC_PC_SWAP_CONTEXT_ADDRESS',
            process.env.NEXT_PUBLIC_PC_SWAP_CONTEXT_ADDRESS,
        ),
        titleAuction: asAddressOptional(
            'NEXT_PUBLIC_TITLE_AUCTION_ADDRESS',
            process.env.NEXT_PUBLIC_TITLE_AUCTION_ADDRESS,
        ),
        renderer: asAddress('NEXT_PUBLIC_RENDERER_ADDRESS', process.env.NEXT_PUBLIC_RENDERER_ADDRESS),
        token: asAddress('NEXT_PUBLIC_TOKEN_ADDRESS', process.env.NEXT_PUBLIC_TOKEN_ADDRESS),
        protocolAdmin: asAddress(
            'NEXT_PUBLIC_PROTOCOL_ADMIN_ADDRESS',
            process.env.NEXT_PUBLIC_PROTOCOL_ADMIN_ADDRESS,
        ),
        artcoinsHook: asAddressOptional(
            'NEXT_PUBLIC_ARTCOINS_HOOK_ADDRESS',
            process.env.NEXT_PUBLIC_ARTCOINS_HOOK_ADDRESS,
        ),
        homage: asAddressOptional(
            'NEXT_PUBLIC_HOMAGE_ADDRESS',
            process.env.NEXT_PUBLIC_HOMAGE_ADDRESS,
        ),
        homageRenderer: asAddressOptional(
            'NEXT_PUBLIC_HOMAGE_RENDERER_ADDRESS',
            process.env.NEXT_PUBLIC_HOMAGE_RENDERER_ADDRESS,
        ),
        ...CANONICAL_PUNKS,
    };
}

/** Resolve one address at request time: a server-only `PC_<base>` overrides the
 *  build-time `NEXT_PUBLIC_<base>`. `base` is the name WITHOUT the prefix (e.g.
 *  `TOKEN_ADDRESS`). Dynamic `process.env[...]` is safe here because this runs
 *  ONLY on the server (guarded by the `typeof window` check in the public
 *  accessors); server-side Next.js does not inline env and dynamic keys resolve
 *  normally. (Note: the optional `pcSwapContext` base is `PC_SWAP_CONTEXT_ADDRESS`,
 *  so its runtime override is the awkward-but-harmless `PC_PC_SWAP_CONTEXT_ADDRESS`.) */
function runtimeEnv(base: string): string | undefined {
    // `||` (not `??`) so an empty-string `PC_*` ("operator cleared it") falls
    // through to the build-time `NEXT_PUBLIC_*` instead of shadowing it with
    // "". Addresses are always non-empty `0x...`, so `||` never drops a real
    // value; an explicit zero-address override is still a non-empty string.
    return process.env[`PC_${base}`] || process.env[`NEXT_PUBLIC_${base}`] || undefined;
}

/** Build the address map from request-time env (SERVER ONLY). `PC_*` runtime
 *  vars override `NEXT_PUBLIC_*` build-time vars via {@link runtimeEnv}. */
function addressesFromRuntimeEnv(): ContractAddresses {
    return {
        permanentCollection: asAddress('PERMANENT_COLLECTION_ADDRESS', runtimeEnv('PERMANENT_COLLECTION_ADDRESS')),
        patron: asAddress('PATRON_ADDRESS', runtimeEnv('PATRON_ADDRESS')),
        returnAuctionModule: asAddress('RETURN_AUCTION_MODULE_ADDRESS', runtimeEnv('RETURN_AUCTION_MODULE_ADDRESS')),
        punkVault: asAddress('PUNK_VAULT_ADDRESS', runtimeEnv('PUNK_VAULT_ADDRESS')),
        buybackBurner: asAddress('BUYBACK_BURNER_ADDRESS', runtimeEnv('BUYBACK_BURNER_ADDRESS')),
        liveBidAdapter: asAddress('LIVE_BID_ADAPTER_ADDRESS', runtimeEnv('LIVE_BID_ADAPTER_ADDRESS')),
        vaultBurnPool: asAddress('VAULT_BURN_POOL_ADDRESS', runtimeEnv('VAULT_BURN_POOL_ADDRESS')),
        vaultBurnAdapter: asAddressOptional('VAULT_BURN_ADAPTER_ADDRESS', runtimeEnv('VAULT_BURN_ADAPTER_ADDRESS')),
        protocolFeePhaseAdapter: asAddressOptional(
            'PROTOCOL_FEE_PHASE_ADAPTER_ADDRESS',
            runtimeEnv('PROTOCOL_FEE_PHASE_ADAPTER_ADDRESS'),
        ),
        referralPayout: asAddressOptional('REFERRAL_PAYOUT_ADDRESS', runtimeEnv('REFERRAL_PAYOUT_ADDRESS')),
        pcSwapContext: asAddressOptional('PC_SWAP_CONTEXT_ADDRESS', runtimeEnv('PC_SWAP_CONTEXT_ADDRESS')),
        titleAuction: asAddressOptional('TITLE_AUCTION_ADDRESS', runtimeEnv('TITLE_AUCTION_ADDRESS')),
        renderer: asAddress('RENDERER_ADDRESS', runtimeEnv('RENDERER_ADDRESS')),
        token: asAddress('TOKEN_ADDRESS', runtimeEnv('TOKEN_ADDRESS')),
        protocolAdmin: asAddress('PROTOCOL_ADMIN_ADDRESS', runtimeEnv('PROTOCOL_ADMIN_ADDRESS')),
        artcoinsHook: asAddressOptional('ARTCOINS_HOOK_ADDRESS', runtimeEnv('ARTCOINS_HOOK_ADDRESS')),
        homage: asAddressOptional('HOMAGE_ADDRESS', runtimeEnv('HOMAGE_ADDRESS')),
        homageRenderer: asAddressOptional('HOMAGE_RENDERER_ADDRESS', runtimeEnv('HOMAGE_RENDERER_ADDRESS')),
        ...CANONICAL_PUNKS,
    };
}

/** Resolve the protocol contract addresses.
 *
 *  ISOMORPHIC. SERVER: reads request-time env (`PC_*` over `NEXT_PUBLIC_*`).
 *  CLIENT: reads the runtime config the root layout injected into
 *  `window.__PC_RUNTIME_CONFIG__` (so addresses are NOT in the client bundle
 *  and a launch flip needs no rebuild), falling back to the build-time
 *  `NEXT_PUBLIC_*` values if that global is absent. */
export function getContractAddresses(): ContractAddresses {
    if (typeof window !== 'undefined') {
        return window.__PC_RUNTIME_CONFIG__?.addresses ?? addressesFromNextPublic();
    }
    return addressesFromRuntimeEnv();
}

/** Uniswap V4 + Permit2 infrastructure. Same addresses on mainnet and the
 *  local anvil fork (which forks mainnet state). */
export function getV4Infrastructure(): V4Infrastructure {
    return {
        poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
        quoter: '0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203',
        stateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
        universalRouter: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
        permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
        weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    };
}

/** Is the protocol deployed and trading-live? Derived from whether the token
 *  address is configured (non-zero) — pre-launch the contract env vars are
 *  unset, so this is false. When false the app renders the full UI with
 *  honest zeros and shows "not launched yet" on the action CTAs; when true
 *  it reads live data and enables trading. No separate flag, no fake data.
 *  This is the single source of truth for the pre-launch vs live distinction. */
export function isProtocolLive(): boolean {
    if (typeof window !== 'undefined') {
        const injected = window.__PC_RUNTIME_CONFIG__;
        return injected ? injected.isProtocolLive : isLiveToken(process.env.NEXT_PUBLIC_TOKEN_ADDRESS);
    }
    return isLiveToken(runtimeEnv('TOKEN_ADDRESS'));
}

/** Operator override: when `PC_PROTOCOL_LIVE=true` the protocol is declared
 *  permanently live, so the client gate skips its per-visitor `eth_getCode`
 *  (pure address-based, zero RPC). Set this once the launch has settled — the
 *  code check is only needed during the pre-launch → live window. Isomorphic,
 *  mirroring `isProtocolLive`. */
export function isProtocolConfirmedLive(): boolean {
    if (typeof window !== 'undefined') {
        return (
            window.__PC_RUNTIME_CONFIG__?.confirmedLive ??
            process.env.NEXT_PUBLIC_PROTOCOL_LIVE === 'true'
        );
    }
    return runtimeEnv('PROTOCOL_LIVE') === 'true';
}

/** Whether a token-address string denotes a live protocol (set + non-zero). */
function isLiveToken(token: string | undefined): boolean {
    return (
        typeof token === 'string' &&
        /^0x[0-9a-fA-F]{40}$/.test(token) &&
        token.toLowerCase() !== '0x0000000000000000000000000000000000000000'
    );
}

/** The launch-flippable public config the server resolves per request and the
 *  root layout injects into the page for the client to read at runtime — so
 *  flipping pre-launch -> live (or correcting an address) is an env change +
 *  runtime restart, no client rebuild. */
export interface RuntimePublicConfig {
    addresses: ContractAddresses;
    isProtocolLive: boolean;
    /** Operator override: once the protocol is permanently live, set
     *  `PC_PROTOCOL_LIVE=true` so the client gate skips its per-visitor
     *  `eth_getCode` (pure address-based, zero RPC). The code check is only
     *  needed during the launch window; this turns it off afterward. */
    confirmedLive: boolean;
    /** First block of the Homage deploy — the lower bound for client-side
     *  Homage Transfer event scans (which must chunk to ≤5000-block ranges
     *  for the /api/rpc proxy). Unset until the mainnet deploy. */
    homageDeployBlock?: number;
}

/** SERVER-side reader: resolve the runtime public config from request-time env.
 *  The root layout calls this and serializes the result into a tiny inline
 *  `<script>` so client components resolve from `window.__PC_RUNTIME_CONFIG__`
 *  instead of build-time-inlined constants. Reading a `PC_*` / `NEXT_PUBLIC_*`
 *  env var does not by itself opt a route into dynamic rendering, so the root
 *  layout sets `dynamic = 'force-dynamic'` to guarantee this runs per request
 *  (otherwise a statically-rendered layout would bake build-time values). */
export function readRuntimePublicConfig(): RuntimePublicConfig {
    return {
        addresses: addressesFromRuntimeEnv(),
        isProtocolLive: isLiveToken(runtimeEnv('TOKEN_ADDRESS')),
        confirmedLive: runtimeEnv('PROTOCOL_LIVE') === 'true',
        homageDeployBlock: homageDeployBlockFromEnv(runtimeEnv('HOMAGE_DEPLOY_BLOCK')),
    };
}

/** Parse a Homage deploy-block env value. Undefined when unset; throws on a
 *  malformed value (mirrors the fail-loud posture of the address parsers). */
function homageDeployBlockFromEnv(v: string | undefined): number | undefined {
    if (!v) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`config: HOMAGE_DEPLOY_BLOCK is not a block number: ${v}`);
    }
    return n;
}

/** The Homage contract's deploy block — the lower bound for client-side
 *  Homage event scans. ISOMORPHIC, mirroring {@link getContractAddresses}:
 *  SERVER reads request-time env (`PC_HOMAGE_DEPLOY_BLOCK` over
 *  `NEXT_PUBLIC_HOMAGE_DEPLOY_BLOCK`); CLIENT reads the injected runtime
 *  config, falling back to the build-time `NEXT_PUBLIC_*` value. */
export function getHomageDeployBlock(): number | undefined {
    if (typeof window !== 'undefined') {
        return (
            window.__PC_RUNTIME_CONFIG__?.homageDeployBlock ??
            homageDeployBlockFromEnv(process.env.NEXT_PUBLIC_HOMAGE_DEPLOY_BLOCK)
        );
    }
    return homageDeployBlockFromEnv(runtimeEnv('HOMAGE_DEPLOY_BLOCK'));
}

declare global {
    interface Window {
        __PC_RUNTIME_CONFIG__?: RuntimePublicConfig;
    }
}

/** Which data adapter to wire in.
 *  - `mock`: hardcoded fixtures — DEV ONLY (never production; the site never
 *    serves fabricated data).
 *  - `fork`: read everything chain-direct from a local anvil fork, no indexer
 *    (dev only — see `lib/data/fork.ts`).
 *  - `live`: production path (Ponder indexer + RPC). Robust to a not-yet-live
 *    protocol — returns honest zeros for protocol state while still rendering
 *    PunksData art, so production is ALWAYS `live`. */
export type DataAdapterKind = 'mock' | 'fork' | 'live';
export function getDataAdapterKind(): DataAdapterKind {
    const v = process.env.NEXT_PUBLIC_DATA_ADAPTER;
    if (v === 'mock' || v === 'fork') {
        if (process.env.NODE_ENV === 'production') {
            throw new Error(
                `config: NEXT_PUBLIC_DATA_ADAPTER=${v} is forbidden in production builds (mock/fork are dev-only; production never serves fabricated data)`,
            );
        }
        return v;
    }
    return 'live';
}
