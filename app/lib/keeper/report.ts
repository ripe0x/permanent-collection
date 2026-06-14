/* Shared shape of a single keeper pass report, posted by the keeper
 * (scripts/keeper.ts, running on Fly) to /api/keeper-report and rendered on
 * /debug/fees. Pure types + constants only — isomorphic, imported by both the
 * Node keeper script and the Next.js app, so neither side can drift on the
 * wire format. */

export type KeeperReportStatus =
    | 'idle'
    | 'disabled'
    | 'simulated'
    | 'confirmed'
    | 'reverted'
    | 'failed';

export interface KeeperReportRow {
    /** Hop key, e.g. `liveBidAdapter.sweep`. */
    hop: string;
    status: KeeperReportStatus;
    /** Human reason / readiness detail (or the error on a failed send). */
    detail: string;
    /** Set for confirmed/reverted sends. */
    txHash?: string;
    /** Gas used, decimal string — set for confirmed/reverted sends. */
    gasUsed?: string;
}

export interface KeeperRunReport {
    /** Which keeper produced this — 'PC' for the permanent-collection keeper. */
    app: string;
    /** One-line headline, e.g. "PC keeper — block N · 1 sent, 0 failed". */
    title: string;
    /** Block the pass evaluated at (decimal string — bigint doesn't cross JSON). */
    block: string;
    chainId: number;
    /** Unix ms the run finished (the keeper stamps this; the API trusts/clamps it). */
    tsMs: number;
    actionable: number;
    sent: number;
    failed: number;
    rows: KeeperReportRow[];
}

/** Rolling history cap kept in the Blobs store. ~30h at the 30-min cadence. */
export const KEEPER_RUNS_MAX = 60;

/** Per-run row cap — bounds a single POST so a bad/huge body can't bloat Blobs. */
export const KEEPER_ROWS_MAX = 20;
