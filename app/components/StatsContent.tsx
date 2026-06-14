'use client';

/* Renders the /stats data grids from the cached `/api/stats` endpoint via
 * `useProtocolStats` (SSR-seeded, then polled). All presentation lives
 * here; the page is just the server shell (header, title, copy, styles).
 */

import {useProtocolStats} from '@/lib/data/useProtocolStats';
import type {ProtocolStatsSnapshot} from '@/lib/data/protocolStats';
import {formatEth, ratioPct} from '@/lib/format';
import {getTokenTicker} from '@/lib/config';

const TOTAL_TRAITS = 111;

interface Stat {
    label: string;
    value: string;
    /** Optional supporting line under the value. */
    sub?: string;
    /** Renders the muted "pending indexer" treatment. */
    pending?: boolean;
}

export function StatsContent({initialData}: {initialData: ProtocolStatsSnapshot}) {
    const {ok, reachable, hasContributionVolume, counter} = useProtocolStats(initialData);

    // Unreachable indexer ≠ quiet protocol. The two used to share one empty
    // state, which made an outage (or a misconfigured INDEXER_URL) read as
    // "no activity yet" — keep them visibly distinct. `reachable` is absent
    // on payloads from builds that predate the field; treat missing as
    // reachable so only a definitive outage shows the degraded copy.
    if (reachable === false) {
        return (
            <div className="stats-empty" role="status">
                Indexed totals are temporarily unavailable. The indexer is not responding;
                lifetime totals reappear once it recovers.
            </div>
        );
    }

    if (!ok || !counter) {
        return (
            <div className="stats-empty">
                No indexed activity yet. Once the protocol is live and the indexer has caught up,
                the totals appear here.
            </div>
        );
    }

    const collected = counter.collectedCount;

    const collection: Stat[] = [
        {
            label: 'Permanent traits',
            value: `${collected} / ${TOTAL_TRAITS}`,
            sub: `${ratioPct(BigInt(collected), BigInt(TOTAL_TRAITS), 1)}% of the full set`,
        },
        {label: 'Punks accepted', value: counter.acquisitionCount.toLocaleString()},
        {label: 'Punks vaulted', value: counter.vaultedCount.toLocaleString()},
        {label: 'Punks returned', value: counter.clearedCount.toLocaleString()},
        {label: 'Proofs minted', value: counter.proofsMinted.toLocaleString()},
    ];

    const flows: Stat[] = [
        {
            label: 'Live bid inflow',
            value: formatEth(BigInt(counter.totalBountyInflowsWei)),
            sub: 'ETH that has fed the live bid',
        },
        {
            label: 'Contribution volume',
            value: hasContributionVolume
                ? formatEth(BigInt(counter.totalContributionVolumeWei ?? '0'))
                : '—',
            sub: hasContributionVolume
                ? 'gross ETH through contribute(), referrer share included'
                : 'pending indexer',
            pending: !hasContributionVolume,
        },
        {
            // Whole-token count with thousands separators — fractional dust is
            // noise at burn scale, and BigInt.toLocaleString() groups digits.
            label: `${getTokenTicker()} burned`,
            value: `${(BigInt(counter.totalTokensBurned) / 10n ** 18n).toLocaleString()} ${getTokenTicker()}`,
            sub: 'bought from the pool and burned',
        },
        {
            label: 'ETH used to buy & burn',
            value: formatEth(BigInt(counter.totalEthBurned)),
            sub: `ETH spent acquiring ${getTokenTicker()} to burn`,
        },
        {
            label: 'Buy-and-burn ETH swept',
            value: formatEth(BigInt(counter.totalVaultBurnSweptWei)),
            sub: 'from vaulted-Punk auction proceeds',
        },
    ];

    return (
        <>
            <h2 className="stats-h2">Collection</h2>
            <StatGrid stats={collection} />

            <h2 className="stats-h2">Economic flows</h2>
            <StatGrid stats={flows} />

            <p className="stats-asof">
                Indexed through block {BigInt(counter.lastUpdatedAt).toString()}.
            </p>
        </>
    );
}

function StatGrid({stats}: {stats: Stat[]}) {
    return (
        <div className="stats-grid">
            {stats.map((s) => (
                <div className="stats-card" key={s.label}>
                    <div className="stats-card-label">{s.label}</div>
                    <div className={`stats-card-value tnum${s.pending ? ' is-pending' : ''}`}>
                        {s.value}
                    </div>
                    {s.sub ? <div className="stats-card-sub">{s.sub}</div> : null}
                </div>
            ))}
        </div>
    );
}
