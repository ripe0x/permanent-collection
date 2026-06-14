/** Next.js startup hook (runs once per server boot, before any request).
 *
 *  Refuses to boot a production server that is serving a LIVE protocol
 *  without INDEXER_URL. That misconfiguration once shipped silently: every
 *  indexer query fell back to the dev-default localhost URL, failed, and the
 *  per-slice resilience rendered empty states indistinguishable from "no
 *  activity yet" for days. Failing the boot makes it impossible to miss.
 *
 *  Pre-launch deploys (no token configured) and `next build` are exempt —
 *  the indexer is required exactly when the protocol is live, and a build
 *  must never fail on a serving-time concern. See assertIndexerConfigured.
 */
export async function register(): Promise<void> {
    // The data layer only exists in the Node server runtime.
    if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
    const {assertIndexerConfigured} = await import('@/lib/data/indexer-client');
    assertIndexerConfigured();
}
