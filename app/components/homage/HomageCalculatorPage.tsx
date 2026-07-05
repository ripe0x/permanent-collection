'use client';

import Link from 'next/link';
import {useEffect, useRef, useState, type ReactNode} from 'react';

import {useCalcPrices} from '@/lib/homage/useCalcPrices';

// breakdown colours, from the homage art palette
const C = {backing: '#6a8494', skim: '#a85c4d', team: '#cba35f', bidpool: '#7d9466'};
const SUPPLY = 10_000;
const SEED_USD = 0.000128; // $111 USD price fallback until the live read resolves
const SEED_E = 1_694;

const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);
const fmtEth = (x: number) =>
    !isFinite(x) ? '-' : x === 0 ? '0' : x >= 1 ? x.toFixed(4) : x >= 0.001 ? x.toFixed(5) : x.toFixed(6);
const fmtEthT = (x: number) =>
    !isFinite(x) ? '-' : x >= 1000 ? Math.round(x).toLocaleString() : x >= 1 ? x.toFixed(2) : x.toFixed(5);
const fmtUsd = (x: number) =>
    !isFinite(x) ? '$-' : '$' + x.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fmtUsdT = (x: number) => (!isFinite(x) ? '$-' : x >= 10_000 ? '$' + Math.round(x).toLocaleString() : fmtUsd(x));
const fmtTok = (x: number) => x.toLocaleString(undefined, {notation: 'compact', maximumFractionDigits: 2});
const fmt111Usd = (x: number) => '$' + (x >= 0.01 ? x.toFixed(4) : x.toPrecision(3));
const pct = (part: number, total: number) => (total > 0 ? ((part / total) * 100).toFixed(1) + '%' : '-');

export function HomageCalculatorPage() {
    const live = useCalcPrices();
    const livePrice111 = live.price111PerEth ?? null; // $111 per ETH
    const liveEthUsd = live.ethUsd ?? null;
    const liveUsd111 = livePrice111 && liveEthUsd ? liveEthUsd / livePrice111 : null; // USD per $111

    const [tokens, setTokens] = useState(40_000);
    const [fee, setFee] = useState(0.005);
    const [skim, setSkim] = useState(6);
    const [bidshare, setBidshare] = useState(50);
    const [progress, setProgress] = useState(100);
    // $111 USD price + ETH USD price start null, adopt the live reads once, then the user owns them
    const [usd111, setUsd111] = useState<number | null>(null);
    const [eth, setEth] = useState<number | null>(null);
    useEffect(() => {
        if (usd111 === null && liveUsd111) setUsd111(Number(liveUsd111.toPrecision(4)));
    }, [liveUsd111, usd111]);
    useEffect(() => {
        if (eth === null && liveEthUsd) setEth(Math.round(liveEthUsd));
    }, [liveEthUsd, eth]);

    const U = usd111 ?? liveUsd111 ?? SEED_USD; // USD per $111
    const E = eth ?? liveEthUsd ?? SEED_E; // USD per ETH
    const P = U > 0 ? E / U : 0; // derived $111 per ETH (drives the ETH cost)
    const mult = liveUsd111 ? U / liveUsd111 : 1;
    const usdIsLive = liveUsd111 !== null && Math.abs(mult - 1) < 0.005;
    const resetLive = () => liveUsd111 && setUsd111(Number(liveUsd111.toPrecision(4)));

    const s = clamp(skim / 100, 0, 0.95);
    const bidFrac = clamp(bidshare / 100, 0, 1);
    const backing = P > 0 ? tokens / P : 0;
    const swap = P > 0 ? tokens / (P * (1 - s)) : 0;
    const skimEth = swap - backing;
    const mintPrice = swap + fee;
    const teamFee = fee * (1 - bidFrac);
    const bidFee = fee * bidFrac;
    const protocolCost = skimEth + fee;

    // projected totals across the selected mint progress
    const mints = Math.round((progress / 100) * SUPPLY);
    const tVol = mints * mintPrice;
    const tBacking = mints * backing;
    const tSkim = mints * skimEth;
    const tTeam = mints * teamFee;
    const tBid = mints * bidFee;
    const t111 = mints * tokens;

    const canvasRef = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        drawArt(canvasRef.current, [
            {v: mintPrice, c: C.backing},
            {v: skimEth + fee, c: C.skim},
            {v: fee, c: C.team},
            {v: bidFee, c: C.bidpool},
        ]);
    }, [mintPrice, skimEth, fee, bidFee]);

    return (
        <div className="atelier min-h-screen">
            <header className="mx-auto max-w-[1120px] px-6 sm:px-8 h-16 flex items-center justify-between">
                <Link href="/homage" className="font-mono text-[11px] tracking-[0.28em] uppercase text-ink">
                    homage to the punk
                </Link>
                <Link href="/homage" className="font-mono text-[12px] text-dim hover:text-ink">
                    mint →
                </Link>
            </header>
            <div className="h-px bg-line" />

            <main className="mx-auto max-w-[1120px] px-6 sm:px-8 pb-24">
                <section className="py-12 sm:py-16">
                    <div className="eyebrow-a">mint economics</div>
                    <h1 className="display mt-3">Mint-price calculator</h1>
                    <p className="text-[14px] leading-[1.5] text-dim mt-3 max-w-[56ch]">
                        A mint costs the ETH it takes to buy the escrowed $111, plus the pool skim, plus your flat fee. Adjust the
                        inputs and watch the price and the breakdown redraw.
                    </p>
                    <PriceStatus live={live} liveUsd111={liveUsd111} E={E} usdIsLive={usdIsLive} />

                    <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr] gap-8 lg:gap-12 mt-9">
                        {/* CONTROLS */}
                        <div className="flex flex-col gap-6">
                            <Field
                                label="$111 bought per mint"
                                unit="$111"
                                value={tokens}
                                onChange={setTokens}
                                min={0}
                                max={100_000}
                                step={1000}
                                cap="the $111 escrowed inside each homage, recoverable on redeem"
                            />
                            <Field
                                label="$111 price"
                                unit="USD"
                                value={U}
                                onChange={setUsd111}
                                min={0.00002}
                                max={0.0006}
                                step={0.000001}
                                cap={
                                    <>
                                        ${(U * 1e6).toLocaleString(undefined, {maximumFractionDigits: 2})} per 1M $111 &nbsp;·&nbsp;{' '}
                                        {mult.toFixed(2)}× live{' '}
                                        {!usdIsLive && liveUsd111 && (
                                            <button className="underline underline-offset-2 hover:text-ink" onClick={resetLive}>
                                                use live
                                            </button>
                                        )}
                                    </>
                                }
                            />
                            <Field
                                label="Static mint fee"
                                unit="ETH"
                                value={fee}
                                onChange={setFee}
                                min={0}
                                max={0.02}
                                step={0.0001}
                                cap={`≈ ${fmtUsd(teamFee * E)} team · ${fmtUsd(bidFee * E)} bid pool`}
                            />

                            <div className="flex flex-col gap-4 p-4 border border-line rounded-[10px] bg-card">
                                <div className="lab" style={{color: 'var(--faint)'}}>
                                    Assumptions
                                </div>
                                <MiniField label="Pool skim" unit="%" value={skim} onChange={setSkim} min={0} max={12} step={0.5} />
                                <div className="cap">the automatic 6% v4 skim to bid pool + team. Raises the ETH needed to net your $111.</div>
                                <MiniField
                                    label="Static fee to bid pool"
                                    unit="%"
                                    value={bidshare}
                                    onChange={setBidshare}
                                    min={0}
                                    max={100}
                                    step={5}
                                />
                                <div className="cap">the static fee splits between team and bid pool. Default 50/50.</div>
                                <MiniField label="ETH price" unit="$" value={E} onChange={setEth} prefixUnit slider={false} />
                                <div className="cap">seeded live from Chainlink; with the $111 price it sets how much ETH buys your $111.</div>
                            </div>

                            <div className="flex flex-wrap gap-2">
                                <Preset
                                    onClick={() => {
                                        setTokens(40_000);
                                        setFee(0.005);
                                    }}
                                >
                                    your defaults · 40k · 0.005
                                </Preset>
                                <Preset
                                    onClick={() => {
                                        setTokens(50_000);
                                        setFee(0.005);
                                    }}
                                >
                                    live contract · 50k · 0.005
                                </Preset>
                                {liveUsd111 && <Preset onClick={resetLive}>reset $111 to live</Preset>}
                            </div>
                        </div>

                        {/* PER-MINT OUTPUT */}
                        <div className="flex flex-col gap-5 lg:sticky lg:top-6 self-start w-full">
                            <div className="bg-card border border-line rounded-[10px] p-6">
                                <div className="eyebrow-a" style={{color: 'var(--dim)'}}>
                                    Mint price
                                </div>
                                <div className="price mt-2" style={{fontSize: 'clamp(40px,7vw,58px)'}}>
                                    {fmtEth(mintPrice)}
                                    <span className="price-unit ml-2">ETH</span>
                                </div>
                                <div className="font-mono text-[13px] text-dim tabular mt-1">≈ {fmtUsd(mintPrice * E)}</div>
                            </div>

                            <div className="bg-card border border-line rounded-[10px] p-[18px] grid grid-cols-[auto_1fr] gap-[18px] items-center max-[440px]:grid-cols-1">
                                <div
                                    className="w-[150px] aspect-square border border-line rounded-[4px] overflow-hidden"
                                    style={{background: '#211e18'}}
                                >
                                    <canvas ref={canvasRef} className="block w-full h-full" />
                                </div>
                                <div className="flex flex-col">
                                    <LegRow c={C.backing} label="$111 backing" sub="escrowed · recoverable" v={backing} price={mintPrice} />
                                    <LegRow c={C.skim} label="Pool skim" sub="protocol · bid pool + team" v={skimEth} price={mintPrice} />
                                    <LegRow c={C.team} label="Fee to team" sub="static fee share" v={teamFee} price={mintPrice} />
                                    <LegRow c={C.bidpool} label="Fee to bid pool" sub="static fee share" v={bidFee} price={mintPrice} />
                                    <div className="grid grid-cols-[12px_1fr_auto] gap-[10px] items-baseline pt-[7px]">
                                        <span className="w-[11px] h-[11px] rounded-[3px] self-center" style={{background: 'var(--ink)'}} />
                                        <span className="text-[12.5px] font-extrabold">Mint price</span>
                                        <span className="font-mono tabular text-[12.5px] font-bold">{fmtEth(mintPrice)} ETH</span>
                                    </div>
                                </div>
                            </div>

                            <div className="font-mono text-[11px] leading-[1.6] text-dim">
                                <p className="my-0">
                                    <Dot c={C.backing} />
                                    <b className="text-ink font-semibold">{fmtEth(backing)} ETH</b> comes back if you redeem (the $111, minus
                                    the exit fee).
                                </p>
                                <p className="my-0 mt-1.5">
                                    <Dot c={C.skim} />
                                    <Dot c={C.team} />
                                    <Dot c={C.bidpool} />
                                    true protocol cost = skim + fee ={' '}
                                    <b className="text-ink font-semibold">{fmtEth(protocolCost)} ETH</b> ({fmtUsd(protocolCost * E)}).
                                </p>
                                <p className="my-0 mt-1.5">
                                    the 6% skim itself also splits ~5.5% bid pool / ~0.87% team. the mint sends ~5% extra to absorb
                                    slippage, refunded as $111.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* PROJECTED TOTALS */}
                    <div className="mt-14 pt-10 border-t border-line">
                        <div className="flex flex-wrap items-end justify-between gap-3">
                            <div>
                                <div className="eyebrow-a">projected totals</div>
                                <h2 className="display-sm mt-2">At {progress}% minted</h2>
                            </div>
                            <div className="font-mono text-[12px] text-dim tabular">
                                {mints.toLocaleString()} / {SUPPLY.toLocaleString()} homages
                            </div>
                        </div>
                        <input
                            className="calc-slider mt-5 max-w-[560px]"
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={progress}
                            onChange={(e) => setProgress(Number(e.target.value))}
                            aria-label="percent of mint complete"
                        />

                        <div className="grid sm:grid-cols-2 gap-8 mt-9 max-w-[820px]">
                            <BigTotal label="Mint volume" sub="total ETH routed through mints" main={`${fmtEthT(tVol)} ETH`} usd={fmtUsdT(tVol * E)} />
                            <BigTotal label="$111 escrowed" sub="total locked as backing" main={`${fmtTok(t111)} $111`} usd={fmtUsdT(t111 * U)} />
                        </div>

                        <div className="mt-8 max-w-[580px] flex flex-col">
                            <BreakRow c={C.backing} label="Backing" sub="recoverable on redeem" eth={tBacking} usd={tBacking * E} />
                            <BreakRow c={C.skim} label="Pool skim" sub="to bid pool + team" eth={tSkim} usd={tSkim * E} />
                            <BreakRow c={C.team} label="Fee to team" eth={tTeam} usd={tTeam * E} />
                            <BreakRow c={C.bidpool} label="Fee to bid pool" eth={tBid} usd={tBid * E} />
                        </div>

                        <p className="cap mt-6 max-w-[72ch]">
                            assumes every mint at the price and fee above, held constant. in reality each mint nudges the $111 price up
                            and the per-wallet public fee escalates, so treat this as a straight-line projection.
                        </p>
                    </div>
                </section>
            </main>
        </div>
    );
}

/* ---------- pieces ---------- */

function PriceStatus({
    live,
    liveUsd111,
    E,
    usdIsLive,
}: {
    live: ReturnType<typeof useCalcPrices>;
    liveUsd111: number | null;
    E: number;
    usdIsLive: boolean;
}) {
    return (
        <div className="mt-4 font-mono text-[11.5px] text-faint tracking-[0.02em] flex items-center gap-2 flex-wrap">
            {live.isLoading ? (
                <span>reading live $111 price…</span>
            ) : live.isError || !liveUsd111 ? (
                <span>live price unavailable — using seeded defaults.</span>
            ) : (
                <>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full" style={{background: usdIsLive ? '#4a8a5a' : '#a59c89'}} />
                        live: $111 <b className="text-dim font-semibold">{fmt111Usd(liveUsd111)}</b> · ETH{' '}
                        <b className="text-dim font-semibold">${E.toLocaleString()}</b>
                    </span>
                    <button className="underline underline-offset-2 hover:text-ink" onClick={() => live.refetch()}>
                        ↻ refresh
                    </button>
                </>
            )}
        </div>
    );
}

function Field({
    label,
    unit,
    value,
    onChange,
    min,
    max,
    step,
    cap,
}: {
    label: string;
    unit: string;
    value: number;
    onChange: (n: number) => void;
    min: number;
    max: number;
    step: number;
    cap: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-[9px]">
            <div className="flex items-baseline justify-between gap-3">
                <label className="text-[14px] font-semibold text-ink">{label}</label>
                <div className="calc-val">
                    <input
                        className="calc-num"
                        type="number"
                        value={value}
                        min={min}
                        step={step}
                        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
                    />
                    <span className="font-mono text-[11px] text-dim">{unit}</span>
                </div>
            </div>
            <input
                className="calc-slider"
                type="range"
                min={min}
                max={max}
                step={step}
                value={clamp(value, min, max)}
                onChange={(e) => onChange(Number(e.target.value))}
                aria-label={label}
            />
            <div className="cap">{cap}</div>
        </div>
    );
}

function MiniField({
    label,
    unit,
    value,
    onChange,
    min = 0,
    max = 100,
    step = 1,
    slider = true,
    prefixUnit = false,
}: {
    label: string;
    unit: string;
    value: number;
    onChange: (n: number) => void;
    min?: number;
    max?: number;
    step?: number;
    slider?: boolean;
    prefixUnit?: boolean;
}) {
    return (
        <>
            <div className="flex items-center justify-between gap-3">
                <label className="text-[13px] font-medium text-ink">{label}</label>
                <div className="calc-val" style={{padding: '3px 9px'}}>
                    {prefixUnit && <span className="font-mono text-[11px] text-dim">{unit}</span>}
                    <input
                        className="calc-num"
                        style={{width: prefixUnit ? '6ch' : '5ch', textAlign: prefixUnit ? 'left' : 'right'}}
                        type="number"
                        value={value}
                        min={min}
                        max={max}
                        step={step}
                        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
                    />
                    {!prefixUnit && <span className="font-mono text-[11px] text-dim">{unit}</span>}
                </div>
            </div>
            {slider && (
                <input
                    className="calc-slider"
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={clamp(value, min, max)}
                    onChange={(e) => onChange(Number(e.target.value))}
                    aria-label={label}
                />
            )}
        </>
    );
}

function LegRow({c, label, sub, v, price}: {c: string; label: string; sub: string; v: number; price: number}) {
    return (
        <div className="grid grid-cols-[12px_1fr_auto] gap-[10px] items-baseline py-[7px] border-b border-dashed border-line">
            <span className="w-[11px] h-[11px] rounded-[3px] self-center" style={{background: c}} />
            <span className="text-[12.5px] font-semibold text-ink leading-tight">
                {label}
                <small className="block font-mono font-normal text-[10px] text-dim tracking-[0.02em] mt-px">{sub}</small>
            </span>
            <span className="font-mono tabular text-[12.5px] text-ink">
                {fmtEth(v)} <small className="text-dim text-[10.5px]">{pct(v, price)}</small>
            </span>
        </div>
    );
}

function BigTotal({label, sub, main, usd}: {label: string; sub: string; main: string; usd: string}) {
    return (
        <div className="border border-line rounded-[10px] bg-card p-5">
            <div className="lab" style={{color: 'var(--faint)'}}>
                {label}
            </div>
            <div className="font-sans font-semibold tabular text-ink mt-2" style={{fontSize: '26px', letterSpacing: '-0.01em'}}>
                {main}
            </div>
            <div className="font-mono text-[12px] text-dim tabular mt-0.5">≈ {usd}</div>
            <div className="cap mt-1">{sub}</div>
        </div>
    );
}

function BreakRow({c, label, sub, eth, usd}: {c: string; label: string; sub?: string; eth: number; usd: number}) {
    return (
        <div className="grid grid-cols-[12px_1fr_auto_auto] gap-x-3 items-baseline py-[9px] border-b border-dashed border-line">
            <span className="w-[11px] h-[11px] rounded-[3px] self-center" style={{background: c}} />
            <span className="text-[13px] font-semibold text-ink leading-tight">
                {label}
                {sub && <small className="block font-mono font-normal text-[10px] text-dim tracking-[0.02em] mt-px">{sub}</small>}
            </span>
            <span className="font-mono tabular text-[13px] text-ink text-right w-[11ch]">{fmtEthT(eth)} ETH</span>
            <span className="font-mono tabular text-[12px] text-dim text-right w-[11ch]">{fmtUsdT(usd)}</span>
        </div>
    );
}

function Preset({onClick, children}: {onClick: () => void; children: ReactNode}) {
    return (
        <button
            onClick={onClick}
            className="font-mono text-[11px] tracking-[0.02em] text-dim border border-line bg-card rounded-full px-3 py-1.5 hover:border-ink hover:bg-white"
        >
            {children}
        </button>
    );
}

function Dot({c}: {c: string}) {
    return <span className="inline-block w-[9px] h-[9px] rounded-[2px] align-middle mr-[3px]" style={{background: c}} />;
}

/* ---------- canvas: nested squares, Albers low-anchor (mirrors PermanenceRenderer._svg) ---------- */
function drawArt(canvas: HTMLCanvasElement | null, parts: {v: number; c: string}[]) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth || 150;
    const ch = canvas.clientHeight || 150;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#211e18';
    ctx.fillRect(0, 0, cw, ch);

    const total = parts[0].v;
    if (!(total > 0)) return;
    const field = Math.min(cw, ch) * 0.82;
    const sc = field / 240;
    const offX = (cw - field) / 2;
    const offY = (ch - field) / 2;

    for (const p of parts) {
        const frac = Math.max(p.v, 0) / total;
        const w = 240 * Math.sqrt(frac);
        if (w <= 0.5) continue;
        const m = 240 - w;
        ctx.fillStyle = p.c;
        ctx.fillRect(offX + (m / 2) * sc, offY + ((6 * m) / 8) * sc, w * sc, w * sc);
    }
}
