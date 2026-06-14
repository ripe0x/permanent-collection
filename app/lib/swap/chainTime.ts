/**
 * Chain-time helpers for deadline computations.
 *
 * Swap + Permit2 deadlines are enforced by chain code against
 * `block.timestamp`, NOT against the browser's clock. Using
 * `Date.now() / 1000` works fine on mainnet (RPC keeps reasonably close
 * to wall time) but breaks on local anvil forks because:
 *
 *   - `start-dev-fork.sh` warps anvil 70 minutes past real time so the
 *     MEV anti-sniper window has fully decayed by the time the dev
 *     server boots.
 *   - anvil's chain time only advances on mined blocks (it doesn't tick
 *     forward like wall time), so dev users return to a stale dev session
 *     and find the chain "in the past" relative to their browser.
 *
 * Either way, a `Date.now()`-based deadline can land before
 * `block.timestamp`, and the swap reverts with `TransactionDeadlinePassed()`
 * BEFORE the wallet popup even shows. Reading the chain's notion of "now"
 * once per submit, then adding a buffer, is the structural fix.
 *
 * The two callers (`SwapBox.onSubmit` for the UR `execute()` deadline,
 * `usePermit2SignSwap` for `permit.details.expiration` + `sigDeadline`)
 * both expect seconds.
 */

import type {PublicClient} from 'viem';

/** Latest known `block.timestamp` in seconds, fetched via the public
 *  client. The caller is responsible for adding any buffer / offset. */
export async function chainNowSeconds(client: PublicClient): Promise<number> {
    const block = await client.getBlock({blockTag: 'latest'});
    return Number(block.timestamp);
}

/**
 * Base timestamp for a deadline that must hold against the *next* mined
 * block — i.e. `max(latestBlockTimestamp, wallClock)`.
 *
 * Reading `latest` alone is NOT enough on an idle anvil fork. anvil only
 * advances chain time on a mined block, so `latest.timestamp` is frozen at
 * the last block. But when the next block (the one that mines this tx) is
 * produced, anvil stamps it with REAL elapsed wall-clock time since fork
 * start — which leaps forward by however long the fork sat idle. A deadline
 * computed as `frozenBlockTs + buffer` then lands in the past relative to
 * the block that actually executes, and the swap reverts with
 * `TransactionDeadlinePassed()` having moved no funds.
 *
 * Taking the max of the chain's last-block timestamp and the browser's wall
 * clock covers every regime:
 *   - mainnet: the two are within seconds; either works.
 *   - anvil frozen + wall-stamping: wall clock predicts the next block ts.
 *   - anvil warped ahead of real time (the `start-dev-fork.sh` +70min MEV
 *     warp): the block timestamp leads wall clock, so it wins the max.
 */
export async function chainDeadlineBaseSeconds(client: PublicClient): Promise<number> {
    // The tx is executed by the NEXT block, so the deadline must clear that
    // block's timestamp — not the latest mined one. The `pending` block is
    // the chain's own projection of that next block: on mainnet it's
    // latest + ~12s; on a warped anvil fork it carries the warp offset
    // (e.g. wallclock + 70min), which a `latest`-or-`Date.now()` base does
    // NOT account for. We measured a fork where pending led wallclock by
    // ~940s while the frozen head trailed it — a `max(latest, wallClock)`
    // base then sat ~340s BEHIND the executing block, so every swap reverted
    // `TransactionDeadlinePassed` before the wallet popup (the buffer the
    // caller adds couldn't cover the offset). Taking the max of pending,
    // latest, and wall clock keeps the base ahead of the executing block in
    // every regime. `pending` isn't served by all providers, so fall back
    // gracefully.
    let pendingTs = 0;
    try {
        const pending = await client.getBlock({blockTag: 'pending'});
        pendingTs = Number(pending.timestamp);
    } catch {
        // provider doesn't serve a pending block — latest + wall clock below.
    }
    const latest = await client.getBlock({blockTag: 'latest'});
    return Math.max(pendingTs, Number(latest.timestamp), Math.floor(Date.now() / 1000));
}
