/**
 * Robust wrapper around viem's `waitForTransactionReceipt`. Races the
 * watcher against a `getTransactionReceipt` poll loop and returns
 * whichever resolves first — kept as defense in depth even though the
 * receipt-confirmation hang documented in issue #26 was traced to a
 * separate React effect-cleanup race in caller-side `useEffect` hooks,
 * not the watcher itself. Either path resolving cleanly is enough.
 */

import type {Hash, PublicClient, TransactionReceipt} from 'viem';

export interface WaitForReceiptOptions {
    /** Timeout the watcher path after this many ms and switch to the
     *  polling fallback. Default 30_000 (30s). */
    watcherTimeoutMs?: number;
    /** Poll interval (ms) used by the fallback path. Default 1_000. */
    pollIntervalMs?: number;
    /** Hard ceiling on the fallback path. Default 60_000 (60s). */
    fallbackTimeoutMs?: number;
}

/** Resolve the receipt for `hash`, racing viem's watcher against a
 *  direct-poll fallback. Throws if neither path resolves within the
 *  combined deadline. */
export async function waitForReceiptWithFallback(
    client: PublicClient,
    hash: Hash,
    opts: WaitForReceiptOptions = {},
): Promise<TransactionReceipt> {
    const {
        watcherTimeoutMs = 30_000,
        pollIntervalMs = 1_000,
        fallbackTimeoutMs = 60_000,
    } = opts;

    // Watcher path — wrapped in a manual timeout so we can fall back.
    const watcher = client
        .waitForTransactionReceipt({hash, timeout: watcherTimeoutMs})
        // If the watcher times out OR rejects, surface as a rejection so
        // `Promise.race` picks the fallback instead.
        .catch((err: unknown) => {
            throw err;
        });

    // Polling fallback path — call getTransactionReceipt every
    // pollIntervalMs until it returns a non-null receipt or we hit
    // fallbackTimeoutMs. Started immediately, so even if the watcher
    // is stuck, this path makes progress.
    const fallback = (async (): Promise<TransactionReceipt> => {
        const deadline = Date.now() + fallbackTimeoutMs;
        while (Date.now() < deadline) {
            try {
                const r = await client.getTransactionReceipt({hash});
                if (r) return r;
            } catch {
                // RpcRequestError when the tx isn't found yet — keep
                // polling.
            }
            await new Promise((res) => setTimeout(res, pollIntervalMs));
        }
        throw new Error(
            `waitForReceiptWithFallback: no receipt for ${hash} within ${
                fallbackTimeoutMs / 1000
            }s`,
        );
    })();

    return await Promise.race([watcher, fallback]);
}
