import type { NextConfig } from "next";

// Content-Security-Policy. Single source of truth, mirrored verbatim into the
// netlify.toml `[[headers]]` block (keep the two in exact sync — EXCEPT the
// dev-only `localRpcConnectSrc` addition below, which is intentionally absent
// from prod/netlify; do NOT mirror it). Each directive
// is commented with WHY each origin is present so it can be audited and
// tightened. This is an ENFORCING policy (not report-only): in enforcing mode
// `upgrade-insecure-requests` is valid and silent, whereas report-only logs a
// console error for it that the e2e console-cleanliness check forbids.
//
// Inline-script/style necessity: this app has no nonce/middleware pipeline, and
// Next's App Router injects inline hydration/streaming bootstrap scripts
// (`self.__next_f.push(...)`) plus RainbowKit injects runtime inline styles. So
// `script-src`/`style-src` must allow `'unsafe-inline'`. Adding a nonce pipeline
// later is the path to dropping `'unsafe-inline'` from script-src.
// In LOCAL DEV ONLY, allow the in-page e2e mock wallet (and local-fork dev) to
// reach a local anvil node directly. A real wallet is a browser EXTENSION, not
// page context, so its RPC traffic is never subject to this page CSP — only the
// e2e harness's injected in-page mock provider is, and it `fetch`es anvil at
// 127.0.0.1:<port> (cross-origin from the dev server), which `connect-src 'self'`
// would otherwise block as "Failed to fetch". Production (NODE_ENV=production)
// and the netlify.toml mirror intentionally OMIT this — it's the one place the
// dev and prod policies deliberately diverge.
const localRpcConnectSrc =
  process.env.NODE_ENV === "production"
    ? ""
    : " http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*";

const cspDirectives = [
  // Lock the default to same-origin; every fetch class below narrows from here.
  "default-src 'self'",
  // Next.js inline hydration/streaming bootstrap has no nonce here, so inline
  // is required. 'self' covers the emitted /_next/static chunks. No
  // `'unsafe-eval'`: turbopack dev (the default `pnpm dev`) and prod builds
  // both run without `eval`.
  "script-src 'self' 'unsafe-inline'",
  // Tailwind ships a self-hosted stylesheet; RainbowKit + component style props
  // emit inline <style>/style="" at runtime, so inline is required.
  "style-src 'self' 'unsafe-inline'",
  // 'self' for local/app assets; data: for the on-chain renderer SVG/JSON data
  // URIs (data:image/svg+xml…, decoded in lib/data/live.ts); blob: as a
  // defensive allowance for any object-URL preview.
  "img-src 'self' data: blob:",
  // next/font self-hosts the IBM Plex / Inter faces at build time, so 'self'
  // covers them; data: for any inlined font face.
  "font-src 'self' data:",
  // XHR/fetch/WebSocket targets the CLIENT actually reaches:
  //  - 'self'                              → all same-origin /api/* incl. /api/rpc proxy
  //  - https://ethereum-rpc.publicnode.com → wagmi mainnet fallback transport (lib/wagmi.ts)
  //  - wss/https relay.walletconnect.*     → WalletConnect v2 relay (RainbowKit WC connector)
  //  - api.web3modal.org / pulse / explorer-api → WalletConnect/Reown HTTP APIs (wallet list, analytics, registry)
  //  - verify.walletconnect.*              → WalletConnect Verify API (scam-domain attestation)
  //  - cca-lite.coinbase.com / chain-proxy.wallet.coinbase.com → Coinbase Wallet SDK
  [
    "connect-src 'self'",
    "https://ethereum-rpc.publicnode.com",
    "wss://relay.walletconnect.com wss://relay.walletconnect.org",
    "https://relay.walletconnect.com https://relay.walletconnect.org",
    "https://api.web3modal.org https://pulse.walletconnect.org https://explorer-api.walletconnect.com",
    "https://verify.walletconnect.com https://verify.walletconnect.org",
    "https://cca-lite.coinbase.com https://chain-proxy.wallet.coinbase.com",
  ].join(" ") + localRpcConnectSrc,
  // WalletConnect Verify loads its attestation page in an iframe; Coinbase
  // Wallet SDK may iframe its connect popup. We never embed any other frame.
  "frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org https://*.coinbase.com",
  // RainbowKit/WalletConnect can spin a blob-backed web worker; a missing
  // worker-src is a common silent wallet-connect breakage, so allow it.
  "worker-src 'self' blob:",
  // No plugins/embeds.
  "object-src 'none'",
  // Pin <base href> to same-origin (blocks base-tag injection redirecting relative URLs).
  "base-uri 'self'",
  // Clickjacking defense (modern equivalent of X-Frame-Options: DENY).
  "frame-ancestors 'none'",
  // Restrict where this page can POST forms to.
  "form-action 'self'",
  // Auto-upgrade any stray http:// subresource to https. Valid + silent in
  // enforcing mode (only report-only logs a console error for this directive).
  "upgrade-insecure-requests",
].join("; ");

// Security response headers applied to every app route. These mirror the
// netlify.toml `[[headers]]` block (keep the two in sync).
const securityHeaders = [
  { key: "Content-Security-Policy", value: cspDirectives },
  { key: "X-Content-Type-Options", value: "nosniff" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Lets WalletConnect/Coinbase social-login popups read back to the opener
  // while still isolating the browsing context.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    // The accept flow lives at /bid now; keep old links working.
    return [{source: "/accept", destination: "/bid", permanent: true}];
  },
};

export default nextConfig;
