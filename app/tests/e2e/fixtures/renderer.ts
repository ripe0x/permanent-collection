/**
 * Per-test Playwright fixtures that compose anvil + mock provider + dev
 * server into a single `e2eTest` value specs import.
 *
 * Usage:
 *   import {e2eTest, expect} from './fixtures/renderer';
 *   e2eTest('xyz', async ({page, state}) => {
 *     await page.goto('/');
 *     // page already has window.ethereum injected, RainbowKit picks
 *     // it up; state.deployments has the contract addresses.
 *   });
 *
 * What each fixture provides:
 *   • `state`: parsed contents of the globalSetup state file (anvil
 *     URL, deployments, ports). Cheap — read once per test, no I/O
 *     beyond the JSON parse.
 *   • `page`: standard Playwright Page, with `addInitScript(mock
 *     provider)` already run so `window.ethereum` exists before the
 *     first navigation's HTML is parsed. This is THE critical
 *     synchronization guarantee — RainbowKit / wagmi mount their
 *     connectors from a `useEffect`, but the provider object is
 *     captured at module-eval time inside RainbowKit's
 *     `getDefaultConfig`. addInitScript runs before any of that.
 */

import {test as base, expect, type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {STATE_FILE, type GlobalState} from './globalSetup';
import {
    defaultMockProviderConfig,
    getMockProviderScript,
    type MockProviderConfig,
} from './mockProvider';

interface E2EFixtures {
    /** Shared state from globalSetup — anvil URL, deployments, ports. */
    state: GlobalState;
    /** Override the mock provider config per-test if needed (e.g. flip
     *  atomic capability via the config rather than runtime hook).
     *  Default uses anvil's account #1 + 'supported' atomic capability. */
    mockProviderConfig: MockProviderConfig;
}

function loadState(): GlobalState {
    try {
        return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as GlobalState;
    } catch (e) {
        throw new Error(
            `e2e: state file ${STATE_FILE} missing or invalid — did globalSetup run? ${String(e)}`,
        );
    }
}

/** The exported test object spec files use. The `use` callback in each
 *  fixture body is Playwright's fixture-yield mechanism, not React's
 *  `use` hook — disable rules-of-hooks accordingly. */
/* eslint-disable react-hooks/rules-of-hooks */
export const e2eTest = base.extend<E2EFixtures>({
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
    state: async ({}, use) => {
        await use(loadState());
    },
    mockProviderConfig: async ({state}, use) => {
        await use(defaultMockProviderConfig(state.rpcUrl));
    },
    // Override `page` to inject the mock provider before any navigation.
    // Playwright's fixture chain replaces the base `page` with this one;
    // every spec receives a page that already has `window.ethereum`.
    page: async ({page, mockProviderConfig}, use) => {
        await page.addInitScript(getMockProviderScript(mockProviderConfig));
        await use(page);
    },
});
/* eslint-enable react-hooks/rules-of-hooks */

export {expect};
export type {Page};
