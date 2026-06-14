'use client';

import {useEffect, useState} from 'react';

import {getChainId, getContractAddresses, isProtocolConfirmedLive, isProtocolLive} from '@/lib/config';

// Local anvil fork. On mainnet a token only ever goes no-code → code once, so a
// permanent localStorage "live" cache is safe. On a local fork the SAME
// deterministic address flips code → no-code across runs (re-fork, snapshot/
// revert), so the permanent cache would wrongly show "live" on a fresh
// pre-launch fork. Skip the positive cache there and always re-read getCode.
const LOCAL_FORK_CHAIN_ID = 31337;

// Session-shared resolution so N gate-consumers (header, swap box, the whole
// /contracts list, …) trigger ONE `eth_getCode`, not N. `resolved` latches the
// confirmed value for this page session; `inflight` dedupes concurrent first
// calls. A positive result is also persisted to localStorage (keyed by token) so
// repeat visits skip the read entirely. A negative result is NOT persisted — only
// latched for the session — so a reload after the contracts deploy picks up
// "live" with no stale "no".
let resolved: boolean | null = null;
let inflight: Promise<boolean> | null = null;

async function resolveLive(): Promise<boolean> {
    if (resolved !== null) return resolved;
    if (inflight) return inflight;
    // No / zero token address → not live; no chain read.
    if (!isProtocolLive()) {
        resolved = false;
        return false;
    }
    const {token} = getContractAddresses();
    // On a local fork the deterministic token address flips code↔no-code across
    // runs, so the permanent positive cache is unreliable — always re-read.
    const useCache = getChainId() !== LOCAL_FORK_CHAIN_ID;
    const key = `pc:protocol-live:${token.toLowerCase()}`;
    if (useCache && window.localStorage?.getItem(key) === '1') {
        resolved = true;
        return true;
    }
    inflight = (async () => {
        try {
            const res = await fetch('/api/rpc', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'eth_getCode',
                    params: [token, 'latest'],
                }),
            });
            if (res.ok) {
                const json = (await res.json()) as {result?: string};
                const hasCode = typeof json.result === 'string' && json.result !== '0x';
                resolved = hasCode;
                if (hasCode && useCache) {
                    try {
                        window.localStorage?.setItem(key, '1');
                    } catch {
                        // localStorage unavailable (e.g. private mode) — skip persistence.
                    }
                }
                return hasCode;
            }
        } catch {
            // Network hiccup: don't latch, so a later mount retries.
        }
        inflight = null;
        return isProtocolLive();
    })();
    return inflight;
}

/**
 * Client-side "is the protocol live?" — the token address is configured AND the
 * token has bytecode on-chain. The code check runs after mount via `/api/rpc`
 * (deduped across all callers + cached), never during SSR, so it can't race the
 * server render. The first paint uses the address-based baseline (identical on
 * server and client); the code-confirmed value takes over once resolved.
 *
 * This lets a PRE-BAKED deterministic launch address render "not launched yet"
 * until the contracts actually deploy to it, then auto-flip live on the next
 * load — no env change, no redeploy.
 */
export function useProtocolLive(): boolean {
    // Permanent off-switch: once PC_PROTOCOL_LIVE=true the launch is settled, so
    // trust the address-based gate with NO chain read — the per-visitor getCode
    // is only needed during the pre-launch → live window.
    const confirmed = isProtocolConfirmedLive();
    const [live, setLive] = useState<boolean>(() =>
        confirmed ? isProtocolLive() : (resolved ?? isProtocolLive()),
    );
    useEffect(() => {
        if (confirmed) return;
        let cancelled = false;
        void resolveLive().then((v) => {
            if (!cancelled) setLive(v);
        });
        return () => {
            cancelled = true;
        };
    }, [confirmed]);
    return live;
}
