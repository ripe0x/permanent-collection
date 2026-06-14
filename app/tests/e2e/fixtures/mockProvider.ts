/**
 * Synthetic EIP-1193 + EIP-5792 provider, injected into the page before
 * any other script via Playwright's `page.addInitScript`.
 *
 * Design (per issue #88 + global CLAUDE.md best-long-term-solution rule):
 *
 *   • Reads forward to anvil verbatim — anvil is canonical, the provider
 *     holds no state.
 *
 *   • Writes (eth_sendTransaction, personal_sign, eth_signTypedData_v4)
 *     also forward to anvil verbatim. Anvil's prefunded accounts (the
 *     default 10) have their keys in anvil's genesis — `eth_sendTransaction`
 *     with `from = <prefunded account>` signs server-side. This is
 *     simpler than bundling viem signing into the injected script AND
 *     correct: the same prefunded-account semantics that `pnpm dev:up`
 *     relies on (`NEXT_PUBLIC_DEV_AUTOSIGN_PK` + the wagmi mock
 *     connector) are what tests need.
 *
 *   • EIP-5792 `wallet_sendCalls`: execute each call sequentially as
 *     `eth_sendTransaction` from the same EOA, awaiting each receipt
 *     before submitting the next. `msg.sender` semantics are identical
 *     to a real EIP-7702 / smart-wallet atomic bundle for our specific
 *     call set (`offerPunkForSaleToAddress` + `acceptBid` both require
 *     only `msg.sender = punkOwner`). Real EIP-7702 is a future-phase
 *     upgrade per the issue.
 *
 *   • Discovery: sets `window.ethereum` with `isMetaMask = true` so
 *     RainbowKit's injected detection surfaces us as "MetaMask" in the
 *     modal. ALSO emits the EIP-6963 `eip6963:announceProvider` event
 *     so modern discovery paths pick us up.
 *
 * Per-test toggle:
 *   • `window.__mockProvider.setAtomicCapability(status)` flips the
 *     `wallet_getCapabilities` reply between `'supported'` (default),
 *     `'ready'`, and `'unsupported'`. Phase 2's AcceptBidFlow tests
 *     use this to drive both the atomic + sequential UI paths.
 *   • `window.__mockProvider.setRejectNextTx(n)` arms the provider to
 *     reject the next `n` write attempts (`eth_sendTransaction` and the
 *     first call inside `wallet_sendCalls`) with EIP-1193 user-rejected
 *     (code 4001). The counter decrements per arming, so n=1 rejects
 *     exactly one tx and resets to off. Reset to 0 (or call with no
 *     argument) to disarm. Phase 2's user-rejection test uses this to
 *     drive the `rejected` UI state without modifying the production
 *     wallet flow.
 */

import type {Address, Hex} from 'viem';
import {E2E_ENV} from './env';

export interface MockProviderConfig {
    /** RPC URL the provider forwards JSON-RPC calls to. Defaults to the
     *  e2e anvil endpoint. */
    rpcUrl: string;
    /** chainId reported via eth_chainId. */
    chainId: number;
    /** The EOA `eth_accounts` returns and that signs all writes. Must be
     *  a prefunded anvil account so server-side signing succeeds. */
    address: Address;
    /** Initial atomic capability for wallet_getCapabilities. Tests can
     *  flip this at runtime via window.__mockProvider.setAtomicCapability. */
    atomicCapability?: 'supported' | 'ready' | 'unsupported';
}

/** Build the inline JS that Playwright injects via `addInitScript`. Returns
 *  a complete script — no globals required at runtime beyond `fetch` and
 *  the browser's standard DOM. */
export function getMockProviderScript(config: MockProviderConfig): string {
    const c = {
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        address: config.address,
        atomicCapability: config.atomicCapability ?? 'supported',
    };

    // The body below runs in the page; it's serialized verbatim by
    // Playwright. We use a string template (not a function expression)
    // because Playwright transmits via stringification — closures over
    // the surrounding Node scope wouldn't survive the round-trip anyway.
    return `
(() => {
  const CONFIG = ${JSON.stringify(c)};

  const chainIdHex = '0x' + CONFIG.chainId.toString(16);
  let atomicCapability = CONFIG.atomicCapability;
  // Counter of remaining write attempts to reject with EIP-1193 4001.
  // setRejectNextTx(n) sets this to n; each rejected write decrements
  // by 1. Affects eth_sendTransaction and the first call inside
  // wallet_sendCalls (the latter mirrors a real wallet — declining the
  // batch popup rejects the whole bundle before any tx is broadcast).
  let rejectRemaining = 0;

  // ── Local state ───────────────────────────────────────────────────
  const listeners = new Map();   // eventName → Set<fn>
  // bundleId → array of underlying tx hashes (for wallet_getCallsStatus)
  const bundles = new Map();

  function rejectUser(method) {
    const err = new Error('mock-provider: user rejected the ' + method + ' request');
    err.code = 4001;
    return err;
  }

  function emit(eventName, payload) {
    const subs = listeners.get(eventName);
    if (!subs) return;
    for (const fn of subs) {
      try { fn(payload); } catch (_) { /* a faulty subscriber must not crash the provider */ }
    }
  }

  // ── JSON-RPC plumbing ────────────────────────────────────────────
  let rpcId = 1;
  async function rpcCall(method, params) {
    const id = rpcId++;
    const res = await fetch(CONFIG.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
    });
    if (!res.ok) {
      throw new Error('mock-provider: anvil HTTP ' + res.status + ' on ' + method);
    }
    const body = await res.json();
    if (body.error) {
      const err = new Error(body.error.message || ('rpc error in ' + method));
      err.code = body.error.code;
      err.data = body.error.data;
      throw err;
    }
    return body.result;
  }

  // ── EIP-1193 request handler ─────────────────────────────────────
  async function handleRequest(method, params) {
    switch (method) {
      // Connection — return the test EOA. No user-interaction simulation.
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [CONFIG.address];

      // Chain.
      case 'eth_chainId':
        return chainIdHex;
      case 'net_version':
        return String(CONFIG.chainId);

      // Permissions surface RainbowKit pokes at on connect.
      case 'wallet_requestPermissions':
        return [{ parentCapability: 'eth_accounts', invoker: 'mock' }];
      case 'wallet_getPermissions':
        return [{ parentCapability: 'eth_accounts', invoker: 'mock' }];

      // Network-switch attempts: tests never need to leave 31337, so
      // we ack the switch without doing anything. Throws InvalidChain
      // if the request is for any chain other than ours.
      case 'wallet_switchEthereumChain': {
        const want = (params && params[0] && params[0].chainId) || '';
        if (typeof want === 'string' && want.toLowerCase() === chainIdHex.toLowerCase()) {
          return null;
        }
        const err = new Error('mock-provider: refusing to switch chain to ' + want);
        err.code = 4902; // unrecognized-chain
        throw err;
      }
      case 'wallet_addEthereumChain':
        return null;

      // ── EIP-5792 ───────────────────────────────────────────────
      case 'wallet_getCapabilities': {
        // Spec returns { [chainId]: { … } }. We answer for the
        // requested chains; other chains get an empty object.
        const targetChainIds = (params && params[1])
          ? params[1] // [account, [chainIdHex, …]]
          : [chainIdHex];
        const out = {};
        for (const cid of targetChainIds) {
          out[cid] =
            cid.toLowerCase() === chainIdHex.toLowerCase()
              ? { atomic: { status: atomicCapability } }
              : {};
        }
        return out;
      }
      case 'wallet_sendCalls': {
        // Spec params: [{ version, chainId, atomicRequired?, calls: [{to, data, value?}, …], from? }]
        const req = (params && params[0]) || {};
        const calls = Array.isArray(req.calls) ? req.calls : [];
        if (calls.length === 0) {
          throw new Error('mock-provider: wallet_sendCalls with no calls');
        }
        const from = (req.from || CONFIG.address).toLowerCase();
        if (from !== CONFIG.address.toLowerCase()) {
          throw new Error('mock-provider: wallet_sendCalls from must equal test EOA');
        }
        // Honor armed rejection — a real wallet's single batch popup
        // declines the whole bundle before any constituent tx broadcasts.
        if (rejectRemaining > 0) {
          rejectRemaining--;
          throw rejectUser('wallet_sendCalls');
        }
        const hashes = [];
        // Sequential — wait for each receipt before sending the next.
        // This is the documented v1 approximation; Phase 4 may swap in
        // real EIP-7702 via anvil's setCode delegation.
        for (const call of calls) {
          const txParams = {
            from: CONFIG.address,
            to: call.to,
            data: call.data || '0x',
          };
          if (call.value && call.value !== '0x' && call.value !== '0x0') {
            txParams.value = call.value;
          }
          const hash = await rpcCall('eth_sendTransaction', [txParams]);
          hashes.push(hash);
          // Poll for receipt. Anvil mines immediately under auto-mine
          // (the default), so this loop usually exits on the first read.
          // 60s ceiling so a stuck tx fails the test loudly.
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            const r = await rpcCall('eth_getTransactionReceipt', [hash]);
            if (r) break;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
        // Bundle id format: spec says it's opaque to the dapp. We use
        // 0x-prefixed hex so callers that introspect the id (e.g. for
        // logging) don't trip on a non-conformant string.
        const bundleId =
          '0x' +
          Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        bundles.set(bundleId, hashes);
        return { id: bundleId };
      }
      case 'wallet_getCallsStatus': {
        const id = params && params[0];
        const hashes = bundles.get(id);
        if (!hashes) {
          throw new Error('mock-provider: unknown bundle id ' + id);
        }
        const receipts = [];
        let anyPending = false;
        let anyFailed = false;
        for (const hash of hashes) {
          const r = await rpcCall('eth_getTransactionReceipt', [hash]);
          if (!r) {
            anyPending = true;
          } else {
            // viem's getCallsStatus expects { transactionHash, status, … }
            // where status is 0x1 / 0x0; anvil already returns it in that
            // shape, so the receipt is passthrough-compatible.
            if (r.status === '0x0') anyFailed = true;
            receipts.push(r);
          }
        }
        // EIP-5792 status codes: 100 = pending, 200 = success, 4xx/5xx fail.
        // The numeric codes are the spec; viem maps them to 'pending' /
        // 'success' / 'failure' internally. We mirror them directly.
        let status;
        if (anyPending) status = 100;
        else if (anyFailed) status = 500;
        else status = 200;
        return {
          version: '2.0.0',
          chainId: chainIdHex,
          id,
          status,
          atomic: atomicCapability === 'ready' || atomicCapability === 'supported',
          receipts,
        };
      }
      case 'wallet_showCallsStatus':
        // Dapp asks the wallet to surface the bundle UI. No-op.
        return null;

      // ── Writes that may be armed to reject ────────────────────
      case 'personal_sign':
      case 'eth_signTypedData_v4':
        if (rejectRemaining > 0) {
          rejectRemaining--;
          throw rejectUser(method);
        }
        return rpcCall(method, params || []);

      case 'eth_sendTransaction': {
        if (rejectRemaining > 0) {
          rejectRemaining--;
          throw rejectUser(method);
        }
        // Mirror real-wallet behaviour: simulate via eth_estimateGas
        // before broadcasting. Real wallets (MetaMask, Coinbase, Safe)
        // pre-simulate and surface decoded reverts to the dapp BEFORE
        // signing, so the dapp's catch-block path (e.g. AcceptBidFlow's
        // classifyAcceptError → TargetTraitPending decode → trait-busy
        // recovery panel) is the actual production code path. If we
        // just forward eth_sendTransaction blindly, anvil mines the
        // revert and the dapp only sees the generic post-inclusion
        // "reverted on-chain" branch — masking the real user-facing
        // behaviour. So we estimate first and re-throw on revert with
        // the same error shape (code, data) anvil produces, which is
        // what viem then walks via its cause chain. Per-tx cost is
        // ~one extra RPC roundtrip; anvil's estimate is local + fast.
        try {
          await rpcCall('eth_estimateGas', params || []);
        } catch (estErr) {
          throw estErr;
        }
        return rpcCall(method, params || []);
      }

      // ── Everything else forwards to anvil ─────────────────────
      default:
        return rpcCall(method, params || []);
    }
  }

  // ── Provider object ──────────────────────────────────────────────
  const provider = {
    isMetaMask: true,
    isConnected() { return true; },
    chainId: chainIdHex,
    selectedAddress: CONFIG.address,
    networkVersion: String(CONFIG.chainId),
    async request(arg) {
      const method = arg && arg.method;
      const params = arg && arg.params;
      if (!method) throw new Error('mock-provider: request missing method');
      return handleRequest(method, params);
    },
    on(eventName, fn) {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(fn);
    },
    removeListener(eventName, fn) {
      const s = listeners.get(eventName);
      if (s) s.delete(fn);
    },
    // Legacy compat — some libs still call .enable() on legacy MetaMask.
    async enable() { return [CONFIG.address]; },
  };

  // Test hooks. Tests grab \`window.__mockProvider\` to flip caps mid-run.
  // Marked non-enumerable so it doesn't appear in casual page inspection.
  Object.defineProperty(window, '__mockProvider', {
    configurable: true,
    enumerable: false,
    value: {
      setAtomicCapability(status) { atomicCapability = status; },
      setRejectNextTx(n) { rejectRemaining = typeof n === 'number' ? Math.max(0, n) : 1; },
      getBundleHashes(id) { return bundles.get(id) || []; },
    },
  });

  // ── Inject + announce ────────────────────────────────────────────
  window.ethereum = provider;

  // EIP-6963 multi-injected provider discovery. Dispatch on every
  // request and at boot so RainbowKit's listener picks us up regardless
  // of when it mounts.
  const info = {
    uuid: '00000000-0000-4000-8000-000000000001',
    name: 'Anvil Test Wallet',
    icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
    rdns: 'fork.anvil.test',
  };
  function announce() {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }),
    );
  }
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  // Signal we're ready before React boots. Tests can wait on this if
  // they want belt-and-suspenders synchronization, but addInitScript
  // already guarantees we run before page scripts.
  emit('connect', { chainId: chainIdHex });
})();
`.trim();
}

/** Default config for the smoke + Phase 2+ suites — anvil RPC, anvil's
 *  account #1 as the test EOA, atomic capability on. */
export function defaultMockProviderConfig(rpcUrl: string): MockProviderConfig {
    return {
        rpcUrl,
        chainId: E2E_ENV.chainId,
        address: E2E_ENV.testAccount.address as Address,
        atomicCapability: 'supported',
    };
}

// Augment the global Page type with the test hook so spec files can
// call `page.evaluate(() => window.__mockProvider.setAtomicCapability(…))`
// without a type cast. Augmentation is opt-in: only fixtures + specs
// importing this module pick it up.
declare global {
    interface Window {
        __mockProvider?: {
            setAtomicCapability(
                status: 'supported' | 'ready' | 'unsupported',
            ): void;
            /** Arm the provider to reject the next `n` write attempts
             *  (default 1) with EIP-1193 code 4001 ("user rejected").
             *  Affects eth_sendTransaction, personal_sign,
             *  eth_signTypedData_v4, and wallet_sendCalls. Set to 0 to
             *  disarm. The counter is read at the moment of the request,
             *  so arming pre-navigation persists across page interactions. */
            setRejectNextTx(n?: number): void;
            getBundleHashes(id: string): Hex[];
        };
    }
}
