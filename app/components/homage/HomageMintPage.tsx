'use client';

import {useCallback, useEffect, useMemo, useState, type ReactNode} from 'react';
import Link from 'next/link';
import {ConnectButton} from '@rainbow-me/rainbowkit';
import {formatEther} from 'viem';

import {getChainId} from '@/lib/config';
import {getEvmNowTxUrl} from '@/lib/format';
import {useHomageMint, useHomageArt, useSampleArt, usePunkOwnership, SUPPLY} from '@/lib/homage/useHomageMint';
import {PHASE_LABEL, fmtCountdown} from '@/lib/homage/phase';
import {DevPhaseToggle} from '@/components/homage/DevPhaseToggle';
import {type PhaseOverride, readOverrideFromUrl, writeOverrideToUrl} from '@/lib/homage/devTools';
import {allowlistProofFor} from '@/lib/homage/allowlist';

/* sample punks shown cycling in the hero (any id renders; abstract either way) */
const SAMPLE_IDS = [635, 2140, 3542, 5577, 7804, 9414];

const eth = (x?: bigint, dp = 4) => (x === undefined ? '—' : Number(formatEther(x)).toFixed(dp));
const shortAddr = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

export function HomageMintPage() {
    // Dev-only mint-state override (Live by default). Read from the URL after mount to stay
    // SSR-safe; the toggle writes it back to the URL so a reload keeps the forced state.
    const [devPhase, setDevPhase] = useState<PhaseOverride>(null);
    useEffect(() => setDevPhase(readOverrideFromUrl()), []);
    const setDev = useCallback((v: PhaseOverride) => {
        setDevPhase(v);
        writeOverrideToUrl(v);
    }, []);
    const m = useHomageMint(devPhase);

    // ---- load a handful of sample homages for the hero (hidden readers lift their src) ----
    const [samples, setSamples] = useState<Record<number, string>>({});
    const onSample = useCallback((id: number, src: string) => {
        setSamples((s) => (s[id] === src ? s : {...s, [id]: src}));
    }, []);
    const sampleItems = useMemo(
        () => SAMPLE_IDS.map((id) => ({id, src: samples[id]})).filter((x): x is {id: number; src: string} => !!x.src),
        [samples]
    );

    const drawing = [m.mintStatus, m.claimStatus, m.allowlistStatus].some((s) => s === 'confirm' || s === 'pending');
    // whichever mint path just succeeded — its id drives the hero artwork
    const revealedId =
        m.mintStatus === 'success' ? m.drawnId
        : m.claimStatus === 'success' ? m.claimedId
        : m.allowlistStatus === 'success' ? m.allowlistDrawnId
        : null;

    return (
        <div className="atelier min-h-screen">
            {SAMPLE_IDS.map((id) => (
                <SampleSlot key={id} id={id} onLoad={onSample} />
            ))}

            {/* top bar */}
            <header className="mx-auto max-w-[1120px] px-6 sm:px-8 h-16 flex items-center justify-between">
                <div className="font-mono text-[11px] tracking-[0.28em] uppercase text-ink">homage to the punk</div>
                <div className="flex items-center gap-5">
                    <span className="hidden sm:inline font-mono text-[11px] tracking-[0.1em] text-dim tabular">
                        {m.minted ?? '—'} / {SUPPLY.toLocaleString()} minted
                    </span>
                    <Connect />
                </div>
            </header>

            <div className="h-px bg-line" />

            {/* hero */}
            <main className="mx-auto max-w-[1120px] px-6 sm:px-8">
                <section className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] gap-10 lg:gap-16 items-center py-12 sm:py-16 lg:py-20">
                    {/* art stage */}
                    <ArtStage items={sampleItems} drawing={drawing} revealedId={revealedId} />

                    {/* pitch + mint */}
                    <div>
                        <div className="eyebrow-a">onchain · generative · one per punk</div>
                        <h1 className="display mt-4">A homage for every punk.</h1>
                        <p className="text-[16px] leading-[1.5] text-dim mt-5 max-w-[34ch]">
                            Living onchain art, generated from each punk.
                        </p>

                        <MintModule m={m} />
                        <AllowlistChecker m={m} />
                    </div>
                </section>

                {/* about / faq */}
                <section className="py-14 sm:py-20 border-t border-line">
                    <div className="eyebrow-a">about</div>
                    <div className="grid md:grid-cols-2 gap-x-16 gap-y-10 mt-8 max-w-[860px]">
                        <Qa q="What am I minting?" a="A one-of-a-kind onchain homage to one of the 10,000 punks. The art is generated from that punk's own colors and live market state, so it keeps changing. It reads the punk; it never copies it." />
                        <Qa q="When can I mint?" a="Minting opens in order: punk owners first mint the homage carrying their own punk's id, then allowlisted wallets mint, then it opens to everyone." />
                        <Qa q="Which punk do I get?" a="In the public and allowlist mints, a random one, drawn the moment you mint and never issued twice. If you hold a punk, the first window lets you mint the homage for its exact id. One homage per punk." />
                        <Qa q="What does “backed” mean?" a="Every homage holds 50,000 $111 locked inside it. That's its floor. Redeem the piece anytime to take the full 50,000 back." />
                        <Qa q="What am I paying for?" a="Your ETH buys 50,000 $111 and locks it into the piece, plus a small ETH fee. In the public mint that fee rises a little with each piece from the same wallet, so it's a gentle throttle, not a cap. Anything extra is refunded; redeeming later costs a small ETH fee." />
                        <Qa q="Do I own the punk?" a="No. It's a separate collectible and grants no rights to any punk." />
                        <Qa q="What is $111?" a="The onchain coin every homage is backed by and the mint buys. Trading it funds the project treasury and a pool that bids on real punks, perpetually." />
                    </div>
                </section>

                <footer className="py-12 mt-6 border-t border-line flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <p className="text-[11px] leading-relaxed text-faint max-w-[60ch]">
                        It reads the punk to render itself and never reproduces it. A separate collectible that confers no rights in
                        any punk; its floor is the 50,000&nbsp;$111 locked inside, redeemable in full at any time.
                    </p>
                    <nav className="flex gap-5 font-mono text-[11px] text-dim shrink-0">
                        <Link href="/homage/explore" className="underline-offset-2 hover:underline">explore</Link>
                        <Link href="/homage/redeem" className="underline-offset-2 hover:underline">redeem</Link>
                        <Link href="/homage/calculator" className="underline-offset-2 hover:underline">calculator</Link>
                        <a href="https://github.com/ripe0x/permanence" target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">github</a>
                    </nav>
                </footer>
            </main>

            <DevPhaseToggle value={devPhase} onChange={setDev} />
        </div>
    );
}

/* ─────────────────────────── art stage (cycling / drawing / revealed) ─────────────────────────── */
function ArtStage({
    items,
    drawing,
    revealedId,
}: {
    items: {id: number; src: string}[];
    drawing: boolean;
    revealedId: number | null;
}) {
    const revealed = revealedId !== null;
    const drawn = useHomageArt(revealedId);
    const [i, setI] = useState(0);

    // cycle: slow when idle, fast ("slot machine") while a mint is in flight
    useEffect(() => {
        if (revealed || items.length === 0) return;
        const period = drawing ? 110 : 3200;
        const t = setInterval(() => setI((x) => (x + 1) % items.length), period);
        return () => clearInterval(t);
    }, [drawing, revealed, items.length]);

    const showDrawn = revealed && drawn.src;
    const cur = items.length ? items[i % items.length] : undefined;
    const src = showDrawn ? drawn.src : cur?.src;
    const loading = items.length === 0 && !showDrawn;

    return (
        <div className="flex flex-col items-center lg:items-start">
            <div className="art-mount">
                <div className="art-frame">
                    {src ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            key={showDrawn ? `drawn-${revealedId}` : `s-${cur?.id}`}
                            src={src}
                            alt=""
                            className={`art-img ${showDrawn ? 'art-pop' : drawing ? '' : 'art-fade'}`}
                        />
                    ) : (
                        <div className="art-skeleton" />
                    )}
                </div>
            </div>
            <div className="mt-4 font-mono text-[11px] text-faint tracking-[0.1em] h-4">
                {showDrawn ? (
                    <span className="text-ink">your homage · #{revealedId}</span>
                ) : drawing ? (
                    'drawing your punk…'
                ) : loading ? (
                    'loading samples…'
                ) : (
                    <>
                        live sample · <span className="text-dim">punk #{cur?.id}</span>
                    </>
                )}
            </div>
        </div>
    );
}

/* ─────────────────────────── mint module (phase-aware) ─────────────────────────── */
type M = ReturnType<typeof useHomageMint>;

function MintModule({m}: {m: M}) {
    const publicRevealed = m.mintStatus === 'success' && m.drawnId !== null;
    const claimRevealed = m.claimStatus === 'success' && m.claimedId !== null;
    const allowlistRevealed = m.allowlistStatus === 'success' && m.allowlistDrawnId !== null;

    // no quote is on screen once a reveal replaces the mint form → pause the interval poll (RPC
    // discipline); resume when the user goes back to mint another.
    const revealed = publicRevealed || claimRevealed || allowlistRevealed;
    const setQuoteActive = m.setQuoteActive; // stable useState setter
    useEffect(() => {
        setQuoteActive(!revealed);
    }, [revealed, setQuoteActive]);

    let body: ReactNode;
    if (publicRevealed) body = <Reveal id={m.drawnId!} title="You drew" onAnother={m.resetMint} anotherLabel="Mint another" hash={m.mintHash} />;
    else if (claimRevealed) body = <Reveal id={m.claimedId!} title="You minted" onAnother={m.resetClaim} anotherLabel="Mint another" hash={m.claimHash} />;
    else if (allowlistRevealed) body = <Reveal id={m.allowlistDrawnId!} title="You drew" onAnother={m.resetAllowlist} anotherLabel="Mint another" hash={m.allowlistHash} />;
    else if (m.phase === 'claim') body = <ClaimPanel m={m} />;
    else if (m.phase === 'allowlist') body = <AllowlistPanel m={m} />;
    else if (m.phase === 'public') body = <PublicPanel m={m} />;
    else body = <ClosedPanel m={m} />;

    return (
        <div className="mt-8 border border-line bg-card p-5 sm:p-6">
            <PhaseBanner m={m} />
            {body}
        </div>
    );
}

function PhaseBanner({m}: {m: M}) {
    // time left in the CURRENT window = seconds until the next one opens (null in public / unscheduled)
    const secsLeft = m.nextPhase ? Math.max(m.nextPhase.at - m.nowSec, 0) : null;
    return (
        <div className="flex items-center justify-between gap-3 pb-4 mb-4 border-b border-line">
            <div className="flex items-center gap-2">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${m.phase === 'closed' ? 'bg-faint' : 'bg-ink'}`} />
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink">{PHASE_LABEL[m.phase]}</span>
            </div>
            {secsLeft !== null && m.nextPhase && (
                <span className="font-mono text-[11px] text-dim tracking-[0.1em] tabular">
                    {fmtCountdown(secsLeft)} <span className="text-faint">→ {PHASE_LABEL[m.nextPhase.to].toLowerCase()}</span>
                </span>
            )}
        </div>
    );
}

function PriceRow({m}: {m: M}) {
    // public escalates per wallet (mintFeeOf, folded into totalValue); holder + allowlist pay the
    // flat baseFee. Pre-mint shows the base price it'll open at.
    const price = m.quote ? (m.phase === 'public' ? m.quote.totalValue : m.quote.ethForSwap + m.baseFee) : undefined;
    return (
        <div className="flex items-end justify-between gap-4">
            <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">price</div>
                <div className="price mt-1">
                    {price !== undefined ? eth(price) : m.quoting ? '…' : '—'} <span className="price-unit">ETH</span>
                </div>
            </div>
            <button onClick={m.refreshQuote} disabled={m.quoting} title="refresh quote" className="font-mono text-[11px] text-dim hover:text-ink disabled:opacity-40 mb-2">
                ↻
            </button>
        </div>
    );
}

/* the quote broken out: what the ETH buys ($111 escrow via the swap), the ETH fee, the total,
   and the refund note. `flat` = claim/allowlist (pay baseFee, no per-wallet escalation);
   otherwise the public escalating fee (mintFeeOf, already folded into quote.totalValue). */
function QuoteBreakdown({m, flat}: {m: M; flat?: boolean}) {
    if (m.quoteErr) {
        return (
            <p className="font-mono text-[11px] mt-2 leading-relaxed text-[#b4431f]">
                Live price unavailable ({m.quoteErr}). Minting is paused until the quote recovers.
            </p>
        );
    }
    if (!m.quote) return null;
    const fee = flat ? m.baseFee : m.quote.fee;
    const total = m.quote.ethForSwap + fee;
    const rows: {label: string; value: string; hint?: string}[] = [
        {label: 'buys 50,000 $111', value: `${eth(m.quote.ethForSwap)} ETH`, hint: 'swapped onchain, escrowed in the piece'},
        {label: flat ? 'mint fee' : 'mint fee (this wallet)', value: `${eth(fee)} ETH`, hint: flat ? undefined : 'rises a little each public mint'},
    ];
    return (
        <div className="mt-3 border-t border-line pt-3">
            <div className="space-y-1.5">
                {rows.map((r) => (
                    <div key={r.label} className="flex items-baseline justify-between gap-3">
                        <span className="font-mono text-[11px] text-dim">
                            {r.label}
                            {r.hint && <span className="block text-[10px] text-faint leading-tight">{r.hint}</span>}
                        </span>
                        <span className="font-mono text-[11px] text-ink tabular shrink-0">{r.value}</span>
                    </div>
                ))}
                <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
                    <span className="font-mono text-[11px] text-ink">total</span>
                    <span className="font-mono text-[12px] text-ink tabular shrink-0">{eth(total)} ETH</span>
                </div>
            </div>
            <p className="font-mono text-[10px] text-faint mt-2 leading-relaxed">
                Includes a {(m.quote.safetyBps / 100).toFixed(1)}% headroom over 50,000 $111; any extra $111 and leftover ETH are refunded to you in the same transaction.
            </p>
        </div>
    );
}

function Progress({m}: {m: M}) {
    const pct = m.minted !== undefined ? (m.minted / SUPPLY) * 100 : 0;
    return (
        <div className="mt-5">
            <div className="flex justify-between font-mono text-[10px] text-faint tracking-[0.1em]">
                <span>{(m.minted ?? 0).toLocaleString()} minted</span>
                <span>{(m.remaining ?? SUPPLY).toLocaleString()} left</span>
            </div>
            <div className="progress mt-1.5">
                <div className="progress-fill" style={{width: `${Math.max(pct, 0.6)}%`}} />
            </div>
        </div>
    );
}

/* window 3 — public random mint */
function PublicPanel({m}: {m: M}) {
    return (
        <>
            <PriceRow m={m} />
            <p className="font-mono text-[11px] text-dim mt-1.5 leading-relaxed">
                A random punk, drawn at mint. The fee rises a little with each mint from your wallet.
            </p>
            <QuoteBreakdown m={m} />
            <MintButton m={m} />
            <Progress m={m} />
            <TxNote status={m.mintStatus} hash={m.mintHash} error={m.mintError} pendingMsg="drawing your punk…" confirmMsg="confirm in your wallet…" />
        </>
    );
}

/* closed / pre-mint — nothing open yet; the banner shows the countdown to the first window */
function ClosedPanel({m}: {m: M}) {
    return (
        <div>
            <PriceRow m={m} />
            <p className="font-mono text-[12px] text-dim leading-relaxed mt-2">
                {m.nextPhase
                    ? 'Minting opens in order: punk owners mint their own ids first, then allowlisted wallets, then everyone.'
                    : 'Minting isn’t scheduled yet — check back soon.'}
            </p>
            <Progress m={m} />
        </div>
    );
}

/* window 1 — punk owners mint the homage for a punk they hold. The id field stays visible but
   is disabled until a wallet is connected (there's nothing to verify ownership against otherwise). */
function ClaimPanel({m}: {m: M}) {
    const connected = m.isConnected && !m.wrongChain && m.configured;
    const [idText, setIdText] = useState('');
    const id = /^\d{1,4}$/.test(idText) ? Number(idText) : null;
    const valid = id !== null && id >= 0 && id <= 9999;
    const own = usePunkOwnership(connected && valid ? id : null, m.address);
    // direct holder, or a delegate.xyz delegate of the holder (then the homage mints to the vault)
    const viaVault = !own.isHolder && own.delegated ? own.holder : undefined;
    const ready = connected && valid && (own.isHolder || own.delegated) && own.alreadyMinted === false;
    const picks = m.ownedPunks;

    return (
        <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">mint your punk’s homage</div>
            <p className="font-mono text-[11px] text-dim mt-1.5 leading-relaxed">
                Own a punk? Mint the homage that carries its id, before the public draw.
            </p>
            <div className="mt-3">
                <PriceRow m={m} />
                <QuoteBreakdown m={m} flat />
            </div>

            {/* picker: the wallet's punks with an unminted homage (raw + wrapped) */}
            {connected && (
                <div className="mt-4">
                    <div className="flex items-center justify-between">
                        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">your claimable punks</div>
                        {picks.status === 'loading' && <span className="font-mono text-[10px] text-faint">scanning…</span>}
                    </div>
                    {picks.status === 'loading' ? (
                        <div className="font-mono text-[11px] text-faint mt-2">looking up the punks in this wallet…</div>
                    ) : picks.punks.length > 0 ? (
                        <>
                            <div className="flex flex-wrap gap-1.5 mt-2">
                                {picks.punks.map((p) => (
                                    <button
                                        key={p.id}
                                        onClick={() => setIdText(String(p.id))}
                                        className={`font-mono text-[11px] px-2 py-1 border ${id === p.id ? 'border-ink text-ink' : 'border-line text-dim hover:border-ink hover:text-ink'}`}
                                        title={p.vault ? `delegated by vault ${p.vault} — mints to the vault` : p.wrapped ? 'wrapped punk' : 'punk'}
                                    >
                                        #{p.id}
                                        {p.wrapped ? <span className="text-faint"> ⌾</span> : null}
                                        {p.vault ? <span className="text-faint"> · vault</span> : null}
                                    </button>
                                ))}
                            </div>
                            {picks.status === 'partial' && (
                                <p className="font-mono text-[10px] text-faint mt-2 leading-relaxed">
                                    Showing punks found in a recent scan. Hold an older one? Enter its id below.
                                </p>
                            )}
                        </>
                    ) : (
                        <p className="font-mono text-[11px] text-faint mt-2 leading-relaxed">
                            {picks.status === 'error'
                                ? "Couldn't list this wallet's punks. Enter a punk id below to claim."
                                : 'No claimable punks found in this wallet from a recent scan. Hold one? Enter its id below.'}
                        </p>
                    )}
                </div>
            )}

            <input
                value={idText}
                onChange={(e) => setIdText(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                placeholder="your punk id"
                inputMode="numeric"
                disabled={!connected}
                className="mt-3 w-full bg-transparent border border-line px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-ink disabled:opacity-40 disabled:cursor-not-allowed"
            />
            <div className="font-mono text-[11px] mt-2 min-h-4">
                {!connected ? <span className="text-faint">connect to check ownership</span>
                    : idText === '' ? <span className="text-faint">enter the id of a punk you hold</span>
                    : !valid ? <span className="text-[#b4431f]">enter a punk id 0–9999</span>
                    : own.loading ? <span className="text-faint">checking…</span>
                    : own.alreadyMinted ? <span className="text-[#b4431f]">#{id} has already been minted</span>
                    : own.isHolder ? <span className="text-ink">you hold #{id}{own.isWrapped ? ' (wrapped)' : ''} ✓</span>
                    : own.delegated ? <span className="text-ink">delegated to you ✓ · mints to vault {shortAddr(own.holder)}</span>
                    : <span className="text-[#b4431f]">this wallet doesn’t hold #{id} (and holds no delegation for it)</span>}
            </div>
            {ready && <ClaimPreview id={id!} />}
            {connected ? (
                <button onClick={() => id !== null && m.claim(id, viaVault)} disabled={!ready || !m.canClaim} className="btn-primary mt-4 w-full">
                    {(m.claimStatus === 'confirm' || m.claimStatus === 'pending') && <span className="spinner" />}
                    {m.claimStatus === 'confirm' ? 'Confirm in wallet…' : m.claimStatus === 'pending' ? 'Minting…' : valid ? `Mint #${id}` : 'Mint'}
                </button>
            ) : (
                <WalletGate m={m}>{null}</WalletGate>
            )}
            <TxNote status={m.claimStatus} hash={m.claimHash} error={m.claimError} pendingMsg="minting…" confirmMsg="confirm in your wallet…" />
        </div>
    );
}

function ClaimPreview({id}: {id: number}) {
    const {src} = useSampleArt(id);
    if (!src) return null;
    return (
        <div className="art-frame art-frame--sm mt-3 max-w-[128px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={`homage for punk #${id}`} className="art-img" />
        </div>
    );
}

/* window 2 — allowlisted addresses mint a random homage */
function AllowlistPanel({m}: {m: M}) {
    return (
        <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">allowlist mint</div>
            <PriceRow m={m} />
            <QuoteBreakdown m={m} flat />
            <div className="font-mono text-[11px] mt-2 min-h-4">
                {!m.isConnected ? <span className="text-faint">connect to check eligibility</span>
                    : m.isAllowlisted ? <span className="text-ink">on the allowlist · {m.allowlistRemaining ?? '—'} of {m.maxPerAllowlisted ?? '—'} left</span>
                    : <span className="text-[#b4431f]">this wallet isn’t on the allowlist</span>}
            </div>
            <WalletGate m={m}>
                <button onClick={m.allowlistMint} disabled={!m.canAllowlistMint} className="btn-primary mt-4 w-full">
                    {(m.allowlistStatus === 'confirm' || m.allowlistStatus === 'pending') && <span className="spinner" />}
                    {m.allowlistStatus === 'confirm' ? 'Confirm in wallet…' : m.allowlistStatus === 'pending' ? 'Drawing your punk…' : 'Mint a random homage'}
                </button>
            </WalletGate>
            <TxNote status={m.allowlistStatus} hash={m.allowlistHash} error={m.allowlistError} pendingMsg="drawing your punk…" confirmMsg="confirm in your wallet…" />
        </div>
    );
}

/* always-present allowlist lookup — check any address against the Merkle allowlist, in every
   phase. Pure client-side (proofs are baked in at build time), so no RPC. Prefills with the
   connected wallet until the user edits it. */
function AllowlistChecker({m}: {m: M}) {
    const [edited, setEdited] = useState(false);
    const [text, setText] = useState('');
    const value = edited ? text : m.address ?? '';
    const q = value.trim();
    const isAddr = /^0x[0-9a-fA-F]{40}$/.test(q);
    const listed = isAddr ? allowlistProofFor(q) !== null : null;

    return (
        <div className="mt-4 border border-line p-3 sm:p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">allowlist checker</div>
            <input
                value={value}
                onChange={(e) => {
                    setEdited(true);
                    setText(e.target.value);
                }}
                placeholder="0x… address"
                spellCheck={false}
                className="mt-2 w-full bg-transparent border border-line px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
            />
            <div className="font-mono text-[11px] mt-1.5 min-h-4">
                {q === '' ? <span className="text-faint">paste an address to check the allowlist</span>
                    : !isAddr ? <span className="text-[#b4431f]">not a valid address</span>
                    : listed ? <span className="text-ink">✓ on the allowlist</span>
                    : <span className="text-dim">not on the allowlist</span>}
            </div>
        </div>
    );
}

/* connect / switch-network gate shared by the claim + allowlist actions */
function WalletGate({m, children}: {m: M; children: ReactNode}) {
    if (!m.configured) return <div className="mt-4 font-mono text-[11px] text-faint">No contract deployed yet — preview only.</div>;
    if (!m.isConnected)
        return (
            <ConnectButton.Custom>
                {({openConnectModal}) => (
                    <button onClick={openConnectModal} className="btn-primary mt-4 w-full">Connect wallet</button>
                )}
            </ConnectButton.Custom>
        );
    if (m.wrongChain)
        return (
            <ConnectButton.Custom>
                {({openChainModal}) => (
                    <button onClick={openChainModal} className="btn-primary mt-4 w-full">Switch to {m.chainName}</button>
                )}
            </ConnectButton.Custom>
        );
    return <>{children}</>;
}

function MintButton({m}: {m: ReturnType<typeof useHomageMint>}) {
    if (!m.configured) {
        return <div className="mt-5 font-mono text-[11px] text-faint">No contract deployed yet — preview only.</div>;
    }
    if (!m.isConnected) {
        return (
            <ConnectButton.Custom>
                {({openConnectModal}) => (
                    <button onClick={openConnectModal} className="btn-primary mt-5">
                        Connect wallet to mint
                    </button>
                )}
            </ConnectButton.Custom>
        );
    }
    if (m.wrongChain) {
        return (
            <ConnectButton.Custom>
                {({openChainModal}) => (
                    <button onClick={openChainModal} className="btn-primary mt-5">
                        Switch to {m.chainName}
                    </button>
                )}
            </ConnectButton.Custom>
        );
    }
    const label =
        m.mintStatus === 'confirm'
            ? 'Confirm in wallet…'
            : m.mintStatus === 'pending'
              ? 'Drawing your punk…'
              : `Mint a random homage`;
    return (
        <button onClick={m.mint} disabled={!m.canMint} className="btn-primary mt-5">
            {(m.mintStatus === 'confirm' || m.mintStatus === 'pending') && <span className="spinner" />}
            {label}
        </button>
    );
}

/* ─────────────────────────── reveal (shown on a successful mint / claim) ─────────────────────────── */
function Reveal({id, title, onAnother, anotherLabel, hash}: {id: number; title: string; onAnother: () => void; anotherLabel: string; hash?: string}) {
    const {meta} = useHomageArt(id);
    const attrs = meta?.attributes ?? [];
    const type = attrs.find((a) => a.trait_type === 'Punk Type')?.value;
    const colors = attrs.find((a) => a.trait_type === 'Color Count')?.value;
    const status = attrs.find((a) => a.trait_type === 'Status')?.value;
    return (
        <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">minted ✓</div>
            <div className="display-sm mt-1">{title} #{id}</div>
            <div className="flex flex-wrap gap-1.5 mt-3">
                {[type, colors !== undefined ? `${colors} colors` : undefined, status].filter(Boolean).map((v, i) => (
                    <span key={i} className="chip">{String(v)}</span>
                ))}
            </div>
            <p className="font-mono text-[11px] text-dim mt-3 leading-relaxed">
                Generated live from the punk. It keeps changing on its own.
            </p>
            <button onClick={onAnother} className="btn-primary w-full mt-4">{anotherLabel}</button>
            {hash && (
                <a className="block mt-3 font-mono text-[11px] text-dim underline-offset-2 hover:underline" href={getEvmNowTxUrl(hash, getChainId())} target="_blank" rel="noreferrer">
                    view transaction ↗
                </a>
            )}
        </div>
    );
}

/* ─────────────────────────── small bits ─────────────────────────── */
function Qa({q, a}: {q: string; a: string}) {
    return (
        <div>
            <div className="text-[15px] font-medium text-ink">{q}</div>
            <p className="text-[14px] leading-[1.6] text-dim mt-2">{a}</p>
        </div>
    );
}

function TxNote({
    status,
    hash,
    error,
    pendingMsg,
    confirmMsg,
    okMsg,
}: {
    status: string;
    hash?: string;
    error?: string | null;
    pendingMsg: string;
    confirmMsg: string;
    okMsg?: string;
}) {
    if (status === 'idle' && !error) return null;
    return (
        <div className="mt-3 font-mono text-[11px] leading-relaxed">
            {status === 'confirm' && <span className="text-dim">{confirmMsg}</span>}
            {status === 'pending' && <span className="text-dim">{pendingMsg}</span>}
            {status === 'success' && okMsg && <span className="text-ink">{okMsg}</span>}
            {error && <span className="text-[#b4431f] break-words">{error}</span>}
            {hash && (status === 'pending' || status === 'success') && (
                <a className="ml-2 text-dim underline-offset-2 hover:underline" href={getEvmNowTxUrl(hash, getChainId())} target="_blank" rel="noreferrer">
                    {hash.slice(0, 10)}…
                </a>
            )}
        </div>
    );
}

function Connect() {
    return (
        <ConnectButton.Custom>
            {({account, chain, openConnectModal, openAccountModal, openChainModal, mounted}) => {
                const ready = mounted;
                if (!ready) return <div className="btn-connect opacity-0">connect</div>;
                if (!account) return <button onClick={openConnectModal} className="btn-connect">Connect</button>;
                if (chain?.unsupported) return <button onClick={openChainModal} className="btn-connect">Wrong network</button>;
                return (
                    <button onClick={openAccountModal} className="btn-connect">
                        {account.displayName}
                    </button>
                );
            }}
        </ConnectButton.Custom>
    );
}

/* hidden reader: loads one sample homage and lifts its src to the hero */
function SampleSlot({id, onLoad}: {id: number; onLoad: (id: number, src: string) => void}) {
    const {src} = useSampleArt(id);
    useEffect(() => {
        if (src) onLoad(id, src);
    }, [src, id, onLoad]);
    return null;
}
