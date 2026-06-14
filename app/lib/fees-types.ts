// Types for the fee phase model. Split into its own file so server-only
// helpers (lib/server/fee-phase.ts) can pull them without dragging the
// pure-compute helpers in lib/fees.ts (which can run on the client) into
// places that don't need them.

/** Discrete state the protocol's lifecycle cares about. Used by the debug
 *  / phase tooling and UI surfaces — the routed fee breakdown itself is
 *  phase-independent (every leg routes the same way from block 1, incl.
 *  the swap-referral leg). Each transition is monotonic and one-way:
 *    - `postFirstAcquisition` flips true when the first Punk is acquired
 *      (PermanentCollection.acquisitionCount > 0). Retained as a lifecycle
 *      marker for the debug/phase walkthrough; it no longer gates any fee
 *      leg's routing (the protocol leg goes to PCController from block 1,
 *      and the swap-referral leg pays from the first swap).
 *    - `postFirstVault` flips true when the first Punk is vaulted at
 *      return-auction settle (collectedCount > 0). The hook no longer has
 *      a trading-fee vault-burn leg, but this flag is preserved for
 *      historical context + UI surfaces that show vault-burn-pool
 *      sweeping (the pool is fed by cleared-auction proceeds and only
 *      flushes on vault-path settles).
 *    - `mevWindowActive` is true while ArtCoinsMevLinearSkim is reporting
 *      an elevated skim. Auto-disables after ~30 min from pool init. */
export interface FeePhase {
    postFirstAcquisition: boolean;
    postFirstVault: boolean;
    mevWindowActive: boolean;
}

/** One routed line in the rendered breakdown. Pure data — components
 *  decide how to render it. */
export interface RoutedLeg {
    /** Stable identifier — use this for React keys and CSS hooks. */
    key: 'live-bid' | 'lp' | 'team' | 'artcoins-fee' | 'referral';
    /** Display label for the leg itself (e.g. "live bid"). */
    label: string;
    /** Share of swap volume in percent (e.g. 4.00 for 4.00%). */
    pct: number;
    /** Phase-routed destination summary, full prose. */
    destination: string;
    /** Phase-routed destination, short form for tight UI surfaces. */
    destinationShort: string;
    /** Long prose explainer for tooltips / debug page. */
    note?: string;
    /** When true the leg is conditional (e.g. referrer, only paid if a
     *  swap carries attribution). UI may want to render it differently. */
    optional?: boolean;
}
