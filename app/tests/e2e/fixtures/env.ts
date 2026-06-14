/**
 * Single source of truth for the e2e harness's hardcoded knobs. Anything
 * a spec or another fixture needs to know about ports / accounts / pin
 * blocks lives here. Touching this file is the only place to bump those
 * defaults — every other fixture should consume from `E2E_ENV`.
 *
 * Env-var overrides exist for CI matrices (e.g. testing a new FORK_BLOCK)
 * but defaults are baked in so a clean checkout runs the suite without
 * configuration.
 */

import {privateKeyToAccount} from 'viem/accounts';
import type {Address, Hex} from 'viem';

const REPO_ROOT = process.cwd().endsWith('/app')
    ? `${process.cwd()}/..`
    : process.cwd();

export const E2E_ENV = {
    /** Anvil RPC port. Separate from dev's 8545 so `pnpm dev:up` and
     *  `pnpm test:e2e` don't clobber each other on a dev machine. */
    anvilPort: Number(process.env.E2E_ANVIL_PORT ?? '8645'),

    /** Next dev-server port for the test app. Separate from :3000 so a
     *  developer's `pnpm app:dev` can keep running while tests execute. */
    appPort: Number(process.env.E2E_APP_PORT ?? '3100'),

    /** chainId the test anvil exposes. The repo's whole fork toolchain
     *  uses 31337 (NEXT_PUBLIC_CHAIN_ID, getChainId() guards, the wagmi
     *  config's anvilFork chain) — don't deviate. */
    chainId: 31_337 as const,

    /** Mainnet block we pin the fork to. Matches `.env.example`'s
     *  FORK_BLOCK so the Foundry RPC cache at
     *  `~/.foundry/cache/rpc/mainnet/${forkBlock}/` is shared with the
     *  contracts test suite. Bump every ~4 weeks in a dedicated PR
     *  (`docs/E2E_TESTING.md` recipe). */
    forkBlock: Number(process.env.E2E_FORK_BLOCK ?? '25133816'),

    /** Fork upstream. Tenderly public gateway by default — archive
     *  state at arbitrary blocks, no paid CU, survives the fork-
     *  instantiation read burst. See ~/.claude/CLAUDE.md "RPC Provider
     *  Strategy" + scripts/start-dev-fork.sh's UPSTREAM doc-block. */
    forkUpstream:
        process.env.E2E_FORK_UPSTREAM ?? 'https://gateway.tenderly.co/public/mainnet',

    /** Test EOA. Anvil's account #1, prefunded with 10000 ETH by
     *  anvil's default genesis. Account #0 is reserved for the
     *  deploy broadcast (start-dev-fork.sh hardcodes it), so account
     *  #1 sidesteps any nonce desync between the deploy and the test
     *  wallet. PK is anvil's well-known default — not a secret. */
    testAccount: privateKeyToAccount(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex,
    ),

    /** Repo root (absolute). Fixtures call out to `scripts/start-dev-fork.sh`
     *  and `pnpm --filter app dev`; both need a stable absolute path
     *  regardless of where `npx playwright test` was invoked from. */
    repoRoot: REPO_ROOT,
} as const;

export type E2EEnv = typeof E2E_ENV;

/** Derived: the anvil RPC URL the fixtures hand to the dev server +
 *  mock provider. */
export function anvilRpcUrl(): string {
    return `http://127.0.0.1:${E2E_ENV.anvilPort}`;
}

/** Derived: the app base URL the smoke test navigates to. */
export function appBaseUrl(): string {
    return `http://127.0.0.1:${E2E_ENV.appPort}`;
}

/** Type re-export for fixtures that hand Address values around without
 *  taking a dep on viem directly. */
export type {Address};
