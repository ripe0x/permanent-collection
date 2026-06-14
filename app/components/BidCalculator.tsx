'use client';

/* Interactive bid-volume calculator. Pose: "given the protocol's fee split,
 * how much swap volume does the bid need to reach $TARGET ETH — and how much
 * also accrues to the other fee destinations along the way?" Scrub the knobs,
 * watch every output update live.
 *
 * Math:
 *   shareOfVolumePct[k] = totalFeePct × shareOfFeePct[k] / 100
 *   volumeEth           = max(0, target − current) ÷ (shareOfVolumePct[bounty] / 100)
 *   accrued[k]          = volumeEth × shareOfVolumePct[k] / 100
 *   (accrued[bounty] ≡ target − current by construction.)
 *
 * Defaults reflect the live deploy (steady state, post-MEV-window):
 *   baseline skim 6%, split ~83% bounty / ~17% artcoins protocol → 5.00%
 *   of volume to the bid, so 600 ETH grows the bid 0 → 30 ETH. Current bid
 *   can be seeded one-click from chain via the shared `useLiveBidBalance`
 *   poll. The artcoins-protocol leg is shown as a single destination
 *   routing to PCController.
 */

import {useState} from 'react';
import {formatEther} from 'viem';

import {getTokenTicker} from '@/lib/config';
import {useEthUsd} from '@/lib/data/useEthUsd';
import {useLiveBidBalance} from '@/lib/data/useLiveBidBalance';
import {formatUsdCompact as formatUsd} from '@/lib/format';
import {BOUNTY_BPS, PROTOCOL_BPS, POOL_FEE_PCT} from '@/lib/fees';
import {ANTI_SNIPER, CLEARED_SPLIT, fmtPct} from '@/lib/protocol-params';

/** The hook has no trading-fee vault-burn leg. VaultBurnPool is fed
 *  exclusively from cleared-auction proceeds in
 *  `ReturnAuctionModule.settle` (no trading-fee allocation), so the burn
 *  default here is 0. The dimension is kept in the calculator UI so a
 *  user can model what a hypothetical trading-fee burn slice would do
 *  to bid growth — they can drag it up and the remaining live-bid /
 *  artcoins shares rescale accordingly. */
const BURN_BPS = 0;

interface Props {
    /** SSR-seeded current bid in wei (string). Lets the page render the
     *  honest starting point on first paint; the user can also slide it. */
    initialCurrentWei: string;
}

const DAILY_RATES = [5, 10, 25, 50, 100, 250, 500];

type SplitKey = 'bounty' | 'burn' | 'artcoins';

interface FeeSplit {
    bounty: number;
    burn: number;
    artcoins: number;
}

/** Default split mirrors the deployed hook config — bps of baseline,
 *  rendered as % of the baseline (sum = 100). Values come from
 *  `lib/fees.ts` so a bps change to the hook only needs the single
 *  source-of-truth update. */
const DEFAULT_SPLIT: FeeSplit = {
    bounty: BOUNTY_BPS / 100,
    burn: BURN_BPS / 100,
    artcoins: PROTOCOL_BPS / 100,
};

const SPLIT_LABELS: Record<SplitKey, string> = {
    bounty: 'Live bid',
    burn: `${getTokenTicker()} burn pool (hypothetical trading-fee slice)`,
    artcoins: 'artcoins protocol',
};

/** ETH amount with adaptive precision: 866 / 12.5 / 0.123 / 0.000012. */
function formatEth(eth: number): string {
    if (!isFinite(eth)) return '∞';
    if (eth >= 10_000) return `${(eth / 1_000).toFixed(1)}K`;
    if (eth >= 100) return eth.toFixed(0);
    if (eth >= 10) return eth.toFixed(1);
    if (eth >= 0.1) return eth.toFixed(3);
    if (eth >= 0.0001) return eth.toFixed(5);
    return eth.toExponential(2);
}

export function BidCalculator({initialCurrentWei}: Props) {
    const initialCurrentEth = Number(formatEther(BigInt(initialCurrentWei)));
    const [target, setTarget] = useState(30);
    const [current, setCurrent] = useState(initialCurrentEth);
    const [totalFee, setTotalFee] = useState(POOL_FEE_PCT);
    const [split, setSplit] = useState<FeeSplit>(DEFAULT_SPLIT);

    // Live chain bid for the "use live" button. Polls the cached API like
    // every other LiveBidStat — no extra cost.
    const {value: chainBidWei} = useLiveBidBalance();
    const chainBidEth =
        chainBidWei !== undefined ? Number(formatEther(chainBidWei)) : null;

    // ETH/USD spot for the dollar annotations — the shared useEthUsd hook
    // (GeckoTerminal-backed /api/price proxy, one react-query entry app-wide).
    // Null until the first response lands or if the upstream can't price the
    // WETH pair, in which case USD annotations just stay hidden — never
    // blocks the math.
    const ethPriceUsd = useEthUsd();
    const usd = (eth: number): number | null =>
        ethPriceUsd == null || !isFinite(eth) ? null : eth * ethPriceUsd;

    // Each destination's share of total swap volume (e.g. bounty default
    // 6 × ~83.33 / 100 = 5.00% of volume).
    const volSharePct = (k: SplitKey) => (totalFee * split[k]) / 100;
    const bountyVolPct = volSharePct('bounty');
    const totalVolPct = volSharePct('bounty') + volSharePct('burn') + volSharePct('artcoins');

    const remaining = Math.max(0, target - current);
    const volumeEth = bountyVolPct > 0 ? remaining / (bountyVolPct / 100) : Infinity;

    // Each destination's accrued ETH at the computed volume. By construction
    // accrued.bounty === remaining (assuming bountyVolPct > 0).
    const accrued = (k: SplitKey) => (volumeEth * volSharePct(k)) / 100;
    const totalAccrued = accrued('bounty') + accrued('burn') + accrued('artcoins');

    const splitSum = split.bounty + split.burn + split.artcoins;
    const splitSumOff = Math.abs(splitSum - 100) > 0.05;

    const normalizeSplit = () => {
        if (splitSum === 0) {
            setSplit(DEFAULT_SPLIT);
            return;
        }
        const k = 100 / splitSum;
        setSplit({
            bounty: +(split.bounty * k).toFixed(2),
            burn: +(split.burn * k).toFixed(2),
            artcoins: +(split.artcoins * k).toFixed(2),
        });
    };

    const reset = () => {
        setTarget(30);
        setCurrent(initialCurrentEth);
        setTotalFee(POOL_FEE_PCT);
        setSplit(DEFAULT_SPLIT);
    };

    const setSplitKey = (k: SplitKey) => (v: number) => setSplit({...split, [k]: v});

    return (
        <div className="calc">
            <div className="calc-grid">
                <div className="calc-knobs">
                    <Knob
                        label="Pool fee"
                        unit="%"
                        min={0.5}
                        max={10}
                        step={0.1}
                        value={totalFee}
                        onChange={setTotalFee}
                        hint={`The baseline skim charged on every swap. Default ${fmtPct(POOL_FEE_PCT)} matches the deployed pool.`}
                    />
                    <div className="split-group">
                        <div className="split-header">
                            <span className="split-title">Fee split</span>
                            <span className={`split-sum ${splitSumOff ? 'split-sum-off' : ''}`}>
                                sum: {splitSum.toFixed(1)}%
                                {splitSumOff && (
                                    <button
                                        type="button"
                                        className="split-normalize"
                                        onClick={normalizeSplit}
                                        title="Rescale all 3 splits proportionally so they sum to 100%."
                                    >
                                        Normalize
                                    </button>
                                )}
                            </span>
                        </div>
                        {(['bounty', 'burn', 'artcoins'] as const).map((k) => (
                            <Knob
                                key={k}
                                label={`→ ${SPLIT_LABELS[k]}`}
                                unit="%"
                                min={0}
                                max={100}
                                step={0.5}
                                value={split[k]}
                                onChange={setSplitKey(k)}
                                compact
                                hint={`${volSharePct(k).toFixed(3)}% of swap volume`}
                            />
                        ))}
                    </div>
                    <Knob
                        label="Target bid"
                        unit="ETH"
                        min={1}
                        max={200}
                        step={1}
                        value={target}
                        onChange={setTarget}
                        unbounded
                        hint={
                            formatUsd(usd(target)) !== null
                                ? `~${formatUsd(usd(target))} at $${ethPriceUsd?.toFixed(0)}/ETH — slider caps at 200; type any value for rare-Punk floors.`
                                : "Set to your eligible-Punk floor. ~30 ETH is current floor territory; slider caps at 200, but you can type any value."
                        }
                    />
                    <Knob
                        label="Current bid"
                        unit="ETH"
                        min={0}
                        max={Math.max(target, 1)}
                        step={0.001}
                        value={current}
                        onChange={setCurrent}
                        hint={
                            chainBidEth !== null
                                ? `Live on-chain: ${chainBidEth.toFixed(3)} ETH${formatUsd(usd(chainBidEth)) ? ` (~${formatUsd(usd(chainBidEth))})` : ''}`
                                : 'Live chain pending…'
                        }
                        actionLabel={chainBidEth !== null ? 'Use live' : undefined}
                        onAction={
                            chainBidEth !== null ? () => setCurrent(chainBidEth) : undefined
                        }
                    />
                    <button className="calc-reset" type="button" onClick={reset}>
                        Reset to defaults
                    </button>
                </div>
                <div className="calc-output">
                    <div className="calc-out-block">
                        <div className="calc-out-label">Effective bid share of swap volume</div>
                        <div className="calc-out-mid tnum">
                            {bountyVolPct.toFixed(3)}<span className="calc-unit">%</span>
                        </div>
                        <div className="calc-out-fine">
                            {totalFee.toFixed(2)}% pool fee × {split.bounty.toFixed(1)}% to live bid
                        </div>
                    </div>
                    <div className="calc-out-block calc-out-headline">
                        <div className="calc-out-label">Cumulative trading volume needed</div>
                        <div className="calc-volume tnum">
                            {formatEth(volumeEth)}<span className="calc-unit"> ETH</span>
                        </div>
                        {formatUsd(usd(volumeEth)) && (
                            <div className="calc-volume-usd tnum">
                                ~{formatUsd(usd(volumeEth))}
                                {ethPriceUsd !== null && (
                                    <span className="calc-volume-usd-rate">
                                        {' '}at ${ethPriceUsd.toFixed(0)}/ETH
                                    </span>
                                )}
                            </div>
                        )}
                        <div className="calc-out-fine">
                            to grow the bid {remaining.toFixed(3)} ETH ({current.toFixed(3)} →{' '}
                            {target.toFixed(0)} ETH)
                        </div>
                    </div>
                    <div className="calc-flow">
                        <div className="calc-flow-head">Where the fees land</div>
                        <table className="calc-flow-table">
                            <thead>
                                <tr>
                                    <th>destination</th>
                                    <th className="num">ETH</th>
                                    <th className="num">USD</th>
                                    <th className="num">of volume</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(['bounty', 'burn', 'artcoins'] as const).map((k) => (
                                    <tr
                                        key={k}
                                        className={k === 'bounty' ? 'flow-row-headline' : ''}
                                    >
                                        <td>{SPLIT_LABELS[k]}</td>
                                        <td className="num tnum">{formatEth(accrued(k))}</td>
                                        <td className="num tnum">
                                            {formatUsd(usd(accrued(k))) ?? '—'}
                                        </td>
                                        <td className="num tnum calc-flow-pct">
                                            {volSharePct(k).toFixed(3)}%
                                        </td>
                                    </tr>
                                ))}
                                <tr className="flow-row-total">
                                    <td>total fees</td>
                                    <td className="num tnum">{formatEth(totalAccrued)}</td>
                                    <td className="num tnum">
                                        {formatUsd(usd(totalAccrued)) ?? '—'}
                                    </td>
                                    <td className="num tnum calc-flow-pct">
                                        {totalVolPct.toFixed(3)}%
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div className="calc-days">
                        <div className="calc-days-head">At a daily volume of…</div>
                        <ul>
                            {DAILY_RATES.map((rate) => {
                                const days = isFinite(volumeEth) ? volumeEth / rate : Infinity;
                                const dText = !isFinite(days)
                                    ? '∞'
                                    : days >= 365
                                      ? `${(days / 365).toFixed(1)} years`
                                      : days >= 30
                                        ? `${(days / 30).toFixed(1)} months`
                                        : days >= 10
                                          ? `${days.toFixed(0)} days`
                                          : `${days.toFixed(1)} days`;
                                const rateUsd = formatUsd(usd(rate));
                                return (
                                    <li key={rate}>
                                        <span>
                                            <span className="tnum">{rate}</span> ETH/day
                                            {rateUsd && (
                                                <span className="calc-days-usd">
                                                    {' '}(~{rateUsd})
                                                </span>
                                            )}
                                        </span>
                                        <span className="tnum">{dText}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </div>
            </div>
            <div className="calc-notes">
                <p>
                    <strong>Steady-state math, two real caveats:</strong>
                </p>
                <ul>
                    <li>
                        The <strong>anti-sniper window</strong> (first ~{ANTI_SNIPER.durationMin}{' '}
                        min after launch) ramps the skim {fmtPct(ANTI_SNIPER.peakPct)} →{' '}
                        {fmtPct(ANTI_SNIPER.baselinePct)} linearly, so early volume can contribute
                        far more to the bid than the steady-state numbers above. Not modeled.
                    </li>
                    <li>
                        Return-auction <strong>clear refills</strong>: when an acquired Punk
                        clears at the return auction, {fmtPct(CLEARED_SPLIT.liveBidPct)} of the
                        acquisition cost goes back to Patron. Not modeled — the volume number
                        above is the worst case where no Punk ever clears.
                    </li>
                    <li>
                        The bid leg flushes inside the same swap that earns it, so the
                        bid grows on every swap with no separate keeper step. While the
                        live bid is below the activation threshold it warms up uncapped;
                        above the threshold the buffered inflow meters in under a fixed
                        rate cap, so a large burst drips in rather than landing all at once.
                    </li>
                </ul>
            </div>
            <style>{styles}</style>
        </div>
    );
}

interface KnobProps {
    label: string;
    unit: string;
    min: number;
    max: number;
    step: number;
    value: number;
    onChange: (v: number) => void;
    hint?: string;
    actionLabel?: string;
    onAction?: () => void;
    /** Compact mode: smaller spacing + label width. Used inside the fee-split
     *  sub-group so four rows fit comfortably. */
    compact?: boolean;
    /** When true, the slider still uses `max` as its visual upper bound (for
     *  comfortable scrubbing) but the number input accepts any value ≥ min —
     *  the slider just visually saturates at `max` when the value exceeds it.
     *  Used for Target bid so you can model arbitrarily-priced Punks. */
    unbounded?: boolean;
}

function Knob({label, unit, min, max, step, value, onChange, hint, actionLabel, onAction, compact, unbounded}: KnobProps) {
    const clamp = (v: number) =>
        unbounded ? Math.max(min, v) : Math.max(min, Math.min(max, v));
    return (
        <div className={`knob ${compact ? 'knob-compact' : ''}`.trim()}>
            <div className="knob-row">
                <label className="knob-label">{label}</label>
                <div className="knob-readout">
                    <input
                        type="number"
                        inputMode="decimal"
                        min={min}
                        max={unbounded ? undefined : max}
                        step={step}
                        value={value}
                        onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!Number.isNaN(v)) onChange(clamp(v));
                        }}
                        className="knob-input tnum"
                    />
                    <span className="knob-unit">{unit}</span>
                </div>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
                className="knob-slider"
                aria-label={label}
            />
            <div className="knob-hint">
                <span>{hint}</span>
                {onAction && actionLabel && (
                    <button type="button" className="knob-action" onClick={onAction}>
                        {actionLabel}
                    </button>
                )}
            </div>
        </div>
    );
}

const styles = `
.calc {
    display: flex;
    flex-direction: column;
    gap: 32px;
}
.calc-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: clamp(24px, 4vw, 56px);
    align-items: start;
}
@media (max-width: 880px) {
    .calc-grid { grid-template-columns: 1fr; }
}

.calc-knobs {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 24px;
    background: var(--panel);
    border: 1px solid var(--line);
}
.knob { display: flex; flex-direction: column; gap: 8px; }
.knob-compact { gap: 4px; }
.knob-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
}
.knob-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.knob-compact .knob-label { text-transform: none; letter-spacing: 0.02em; font-size: 12px; }
.knob-readout {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
}
.knob-input {
    width: 5.5em;
    padding: 4px 8px;
    font-family: var(--mono);
    font-size: 16px;
    text-align: right;
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 0;
    outline: none;
}
.knob-compact .knob-input { width: 4.2em; font-size: 13px; padding: 2px 6px; }
.knob-input:focus { border-color: var(--ink); }
.knob-input::-webkit-inner-spin-button,
.knob-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.knob-input { -moz-appearance: textfield; }
.knob-unit {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--muted);
}
.knob-compact .knob-unit { font-size: 11px; }
.knob-slider {
    width: 100%;
    accent-color: var(--accent);
    cursor: ew-resize;
}
.knob-compact .knob-slider { height: 14px; }
.knob-hint {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    opacity: 0.85;
}
.knob-action {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    background: transparent;
    border: 1px solid var(--accent);
    padding: 3px 8px;
    cursor: pointer;
}
.knob-action:hover { background: var(--accent); color: #fff; }

.split-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px 16px;
    border: 1px dashed var(--line);
}
.split-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 6px;
}
.split-title {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink);
}
.split-sum {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
}
.split-sum-off { color: var(--accent); }
.split-normalize {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    background: transparent;
    border: 1px solid var(--accent);
    padding: 2px 6px;
    cursor: pointer;
}
.split-normalize:hover { background: var(--accent); color: #fff; }

.calc-reset {
    align-self: flex-start;
    margin-top: 4px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--line);
    padding: 6px 12px;
    cursor: pointer;
}
.calc-reset:hover { color: var(--ink); border-color: var(--ink); }

.calc-output {
    display: flex;
    flex-direction: column;
    gap: 18px;
}
.calc-out-block {
    padding: 20px 22px;
    background: var(--panel);
    border: 1px solid var(--line);
}
.calc-out-headline {
    border-color: var(--ink);
    background: var(--panel);
    box-shadow: 0 0 0 1px var(--ink) inset;
}
.calc-out-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
}
.calc-out-mid {
    font-family: var(--mono);
    font-size: 28px;
    color: var(--ink);
    letter-spacing: -0.01em;
}
.calc-volume {
    font-family: var(--mono);
    font-size: 44px;
    color: var(--ink);
    letter-spacing: -0.02em;
    line-height: 1.05;
}
.calc-unit {
    font-size: 0.55em;
    color: var(--muted);
    margin-left: 4px;
}
.calc-out-fine {
    margin-top: 6px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.calc-volume-usd {
    margin-top: 4px;
    font-family: var(--mono);
    font-size: 18px;
    color: var(--accent);
    letter-spacing: -0.01em;
}
.calc-volume-usd-rate {
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.04em;
}

.calc-flow {
    padding: 16px 22px 18px;
    background: var(--panel);
    border: 1px solid var(--line);
}
.calc-flow-head {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 10px;
}
.calc-flow-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink);
}
.calc-flow-table thead th {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    text-align: left;
    font-weight: 400;
    padding: 4px 6px 8px;
    border-bottom: 1px solid var(--line);
}
.calc-flow-table th.num { text-align: right; }
.calc-flow-table td {
    padding: 6px 6px;
    border-bottom: 1px dashed var(--line);
}
.calc-flow-table td.num { text-align: right; }
.calc-flow-pct { color: var(--muted); font-size: 12px; }
.flow-row-headline td { font-weight: 500; }
.flow-row-headline td:first-child { color: var(--ink); }
.flow-row-total td {
    padding-top: 10px;
    border-top: 1px solid var(--ink);
    border-bottom: none;
    color: var(--ink);
}
.flow-row-total td:first-child {
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
}

.calc-days {
    padding: 16px 22px 18px;
    background: var(--panel);
    border: 1px solid var(--line);
}
.calc-days-head {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 10px;
}
.calc-days ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.calc-days li {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink);
}
.calc-days li span:first-child { color: var(--muted); }
.calc-days-usd {
    color: var(--muted);
    opacity: 0.7;
    font-size: 11px;
}

.calc-notes {
    padding: 20px 22px;
    border: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    color: var(--muted);
}
.calc-notes p { margin: 0 0 8px; }
.calc-notes ul { margin: 0; padding-left: 20px; }
.calc-notes li { margin-bottom: 6px; }
.calc-notes strong { color: var(--ink); font-weight: 500; }
`;
