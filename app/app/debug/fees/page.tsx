/* Fee-phase walkthrough. Server component; no RPC fires per render —
 * the phase is supplied entirely via URL search params with the
 * canonical current phase used as the fallback. Each named phase below
 * is rendered with the detailed FeeBreakdown variant so all three
 * dimensions (live-bid / artcoins-protocol / referral) plus their
 * routed destinations are visible side-by-side.
 *
 * URL params:
 *   ?acq=1|0    postFirstAcquisition override
 *   ?vault=1|0  postFirstVault override
 *   ?mev=1|0    mevWindowActive override
 *
 * When no overrides are supplied, "Current" reflects the live protocol
 * phase (via the cached server reader).
 */

import type {Metadata} from 'next';
import Link from 'next/link';

import {DistributionPanel} from '@/components/DistributionPanel';
import {KeeperRunsPanel} from '@/components/KeeperRunsPanel';
import {FeeBreakdown} from '@/components/FeeBreakdown';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {ORDERED_PHASES, describePhase} from '@/lib/fees';
import type {FeePhase} from '@/lib/fees-types';
import {applyPhaseOverride, getCurrentFeePhase} from '@/lib/server/fee-phase';
import {getDistributionSnapshot} from '@/lib/server/distribution';
import {getRecentKeeperRuns} from '@/lib/server/keeper-runs';
import {getTokenTicker} from '@/lib/config';
import {buildMeta} from '@/lib/meta';
import {FEES, fmtPct} from '@/lib/protocol-params';

export const dynamic = 'force-dynamic';

const TICKER = getTokenTicker();

export const metadata: Metadata = {
    ...buildMeta({
        title: 'Debug — fee phases',
        description: `Walk through every fee-routing phase of the ${TICKER} pool: pre-acquisition, post-acquisition, pre-/post-vault, MEV window.`,
        path: '/debug/fees',
    }),
    robots: {index: false, follow: false},
};

interface PageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DebugFeesPage({searchParams}: PageProps) {
    const params = await searchParams;
    const snap = await getDistributionSnapshot();
    const keeperRuns = await getRecentKeeperRuns();
    const current = await getCurrentFeePhase();
    const override = applyPhaseOverride(current, params);
    const overridden =
        override.postFirstAcquisition !== current.postFirstAcquisition ||
        override.postFirstVault !== current.postFirstVault ||
        override.mevWindowActive !== current.mevWindowActive;

    return (
        <>
            <Header />
            <main id="top">
                <section className="debug-page">
                    <div className="wrap">
                        <div className="kicker">Debug</div>
                        <h1 className="section-title">Fee phases.</h1>
                        <p className="section-copy">
                            The {TICKER} pool charges a {fmtPct(FEES.baselineSkimPct)} baseline skim
                            that splits three ways inside the hook: a bid leg, a protocol leg, and a
                            referral slice pulled from the protocol leg. This page renders every
                            phase so you can confirm the UI labels and routings against the spec.
                        </p>
                        <p className="section-copy">
                            Override the current phase via URL params:{' '}
                            <code>?acq=1&amp;vault=1&amp;mev=0</code>. Unset params fall back
                            to the live phase (cached server-side).
                        </p>
                        <h2 className="debug-h2">Distribution locations (live)</h2>
                        <p className="section-copy">
                            Every distro location (hook, adapter, swapper, escrow, controller,
                            pools) with its current holding and total distributed. Reads from
                            the configured RPC (the local fork in fork mode); refresh after
                            each stage to watch ETH move through.
                        </p>
                        <DistributionPanel snapshot={snap} />

                        <h2 className="debug-h2">Keeper runs</h2>
                        <p className="section-copy">
                            Each scheduled keeper pass — what it evaluated and any on-chain sends.
                            Idle passes collapse to a heartbeat line; passes that moved value
                            expand with their hops and evm.now tx links. Posted from the Fly
                            keeper every 30 minutes.
                        </p>
                        <KeeperRunsPanel runs={keeperRuns} />

                        <h2 className="debug-h2">Fee phases</h2>
                        <PhaseOverrideBar current={current} override={override} />

                        <h2 className="debug-h2">Current phase</h2>
                        <div className="debug-card">
                            <PhaseHeader
                                phase={overridden ? override : current}
                                label={overridden ? 'URL override' : 'Live'}
                            />
                            <FeeBreakdown
                                phase={overridden ? override : current}
                                variant="detailed"
                                showPhaseLabel={false}
                            />
                        </div>

                        <h2 className="debug-h2">All phases</h2>
                        <p className="section-copy">
                            Each phase is rendered with the same FeeBreakdown component the
                            production surfaces use — these are the exact labels and
                            destinations that ship.
                        </p>
                        <div className="debug-grid">
                            {ORDERED_PHASES.map((phase, i) => (
                                <div className="debug-card" key={i}>
                                    <PhaseHeader phase={phase} label={`Phase ${i + 1}`} />
                                    <FeeBreakdown
                                        phase={phase}
                                        variant="detailed"
                                        showPhaseLabel={false}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

function PhaseOverrideBar({current, override}: {current: FeePhase; override: FeePhase}) {
    const buttons: Array<{href: string; label: string; active: boolean}> = [
        {
            href: '/debug/fees',
            label: 'Reset to live',
            active:
                override.postFirstAcquisition === current.postFirstAcquisition &&
                override.postFirstVault === current.postFirstVault &&
                override.mevWindowActive === current.mevWindowActive,
        },
        {
            href: '/debug/fees?acq=0&vault=0&mev=1',
            label: 'Anti-sniper',
            active:
                !override.postFirstAcquisition &&
                !override.postFirstVault &&
                override.mevWindowActive,
        },
        {
            href: '/debug/fees?acq=0&vault=0&mev=0',
            label: 'Pre-acquisition',
            active:
                !override.postFirstAcquisition &&
                !override.postFirstVault &&
                !override.mevWindowActive,
        },
        {
            href: '/debug/fees?acq=1&vault=0&mev=0',
            label: 'Post-acq, pre-vault',
            active:
                override.postFirstAcquisition &&
                !override.postFirstVault &&
                !override.mevWindowActive,
        },
        {
            href: '/debug/fees?acq=1&vault=1&mev=0',
            label: 'Steady state',
            active:
                override.postFirstAcquisition &&
                override.postFirstVault &&
                !override.mevWindowActive,
        },
    ];
    return (
        <div className="debug-toolbar" role="tablist" aria-label="Fee phase override">
            {buttons.map((b) => (
                <Link
                    key={b.label}
                    href={b.href}
                    className={`debug-toolbar-btn${b.active ? ' is-active' : ''}`}
                    role="tab"
                    aria-selected={b.active}
                >
                    {b.label}
                </Link>
            ))}
        </div>
    );
}

function PhaseHeader({phase, label}: {phase: FeePhase; label: string}) {
    return (
        <div className="debug-phase-head">
            <span className="debug-phase-label">{label}</span>
            <span className="debug-phase-name">{describePhase(phase)}</span>
            <div className="debug-phase-flags">
                <Flag name="acq" on={phase.postFirstAcquisition} />
                <Flag name="vault" on={phase.postFirstVault} />
                <Flag name="mev" on={phase.mevWindowActive} />
            </div>
        </div>
    );
}

function Flag({name, on}: {name: string; on: boolean}) {
    return (
        <span className={`debug-flag${on ? ' debug-flag-on' : ''}`}>
            {name}={on ? '1' : '0'}
        </span>
    );
}

const styles = `
.debug-page {
    padding-top: clamp(60px, 9vh, 100px);
    padding-bottom: clamp(80px, 12vh, 160px);
}
.debug-h2 {
    margin-top: 36px;
    margin-bottom: 12px;
    font-family: var(--sans);
    font-size: 20px;
    color: var(--ink);
}
.debug-toolbar {
    margin: 24px 0 32px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}
.debug-toolbar-btn {
    display: inline-block;
    padding: 6px 12px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    border: 1px solid var(--line);
    background: var(--panel);
    transition: color 120ms ease, border-color 120ms ease;
}
.debug-toolbar-btn:hover {
    color: var(--ink);
    border-color: var(--ink);
}
.debug-toolbar-btn.is-active {
    color: var(--bg);
    background: var(--ink);
    border-color: var(--ink);
}
.debug-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 18px;
    align-items: start;
}
.debug-card {
    padding: 20px 22px;
    background: var(--panel);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 14px;
}
.debug-phase-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--line);
}
.debug-phase-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.debug-phase-name {
    font-family: var(--sans);
    font-size: 15px;
    color: var(--ink);
    font-weight: 500;
}
.debug-phase-flags {
    display: flex;
    gap: 6px;
    margin-top: 4px;
}
.debug-flag {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--muted);
    border: 1px solid var(--line);
    padding: 2px 6px;
    background: var(--bg);
    opacity: 0.7;
}
.debug-flag-on {
    color: var(--accent);
    border-color: var(--accent);
    opacity: 1;
}
code {
    font-family: var(--mono);
    font-size: 0.92em;
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 1px 6px;
}
`;
