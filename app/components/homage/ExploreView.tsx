'use client';

// The explore experience — the /explore page, and (in preview site mode) the homepage,
// where it renders without the header as the pre-mint face of the collection.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocalSample, useLocalPunk } from '@/lib/homage/local/local';
import { useDebounced } from '@/lib/homage/hooks';
import { Traits } from '@/components/homage/Traits';
import { MorphArt } from '@/components/homage/MorphArt';
import { Flap } from '@/components/homage/Flap';
import { type TokenMeta } from '@/lib/homage/svg';

const rnd = () => Math.floor(Math.random() * 10000);
const rndSet = (n: number) => {
    const s = new Set<number>();
    while (s.size < n) s.add(rnd());
    return [...s];
};
const CYCLE_MS = 3200;

export function ExploreView({ preview = false }: { preview?: boolean }) {
    const configured = true; // homages render locally from the SDK — no contract/RPC needed

    const [currentId, setCurrentId] = useState<number>(635); // fixed for SSR; replaced on mount
    const [idText, setIdText] = useState<string>('635');
    const [playing, setPlaying] = useState(true);
    // PFP (circles) output — hidden for now; restore the state + button below to re-enable.
    // const [pfp, setPfp] = useState(false);
    const pfp = false;
    // show the raw punk instead of its homage; flips back to the homage whenever the id changes
    const [punkView, setPunkView] = useState(false);
    const editingRef = useRef(false); // true while the id input is focused (don't sync over typing)

    const cycleRef = useRef<number[]>([]);
    const ciRef = useRef(0);

    // show() only moves the load target; the id label, title, traits, and art all follow
    // `shown` (the fully-loaded punk) so they flip together rather than the id changing first.
    const show = useCallback((id: number) => {
        setCurrentId(id);
    }, []);

    // mount: build the auto-cycle set (client-only, avoids an SSR mismatch) and show the first
    useEffect(() => {
        cycleRef.current = rndSet(8);
        ciRef.current = 0;
        show(cycleRef.current[0]);
    }, [show]);

    // auto-cycle through the set, the same way the homepage hero does
    useEffect(() => {
        if (!playing) return;
        const t = setInterval(() => {
            const arr = cycleRef.current;
            if (!arr.length) return;
            ciRef.current = (ciRef.current + 1) % arr.length;
            show(arr[ciRef.current]);
        }, CYCLE_MS);
        return () => clearInterval(t);
    }, [playing, show]);

    // a new punk always re-enters as its homage
    useEffect(() => {
        setPunkView(false);
    }, [currentId]);

    // commit a looked-up id (debounced) while paused
    const dId = useDebounced(idText, 350);
    useEffect(() => {
        const n = Number(dId);
        if (dId.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 9999 && n !== currentId) setCurrentId(n);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dId]);

    const pick = useCallback(
        (id: number) => {
            setPlaying(false);
            show(id);
        },
        [show]
    );
    const random = useCallback(() => pick(rnd()), [pick]);
    const valid = idText.trim() === '' || (Number.isInteger(Number(idText)) && Number(idText) >= 0 && Number(idText) <= 9999);

    // Always fetch the classic (squares) art; the PFP (circle) form is derived on the
    // client by morphing each square's corner radius, so toggling needs no extra read.
    const preview_ = useLocalSample(currentId);

    // Hold the last fully-loaded output so the rotator never collapses to a loading
    // state mid-cycle: art + traits + id stay mounted and always describe one punk,
    // so nothing is removed/re-added between outputs (keeps the layout from jumping).
    const [shown, setShown] = useState<{ id: number; src: string; meta: TokenMeta } | null>(null);
    useEffect(() => {
        if (preview_.src && preview_.meta) setShown({ id: currentId, src: preview_.src, meta: preview_.meta });
    }, [preview_.src, preview_.meta, currentId]);

    // the raw punk, rendered on demand while the punk view is on (local SDK pixels, no RPC)
    const punk = useLocalPunk(punkView && shown ? shown.id : null);

    const togglePunk = useCallback(() => {
        setPunkView((v) => {
            if (!v) setPlaying(false); // looking at one punk — stop the rotation under it
            return !v;
        });
    }, []);

    // Keep the id input in step with the displayed punk (not the load target), unless the
    // user is actively typing — so the id flips together with the art and traits.
    useEffect(() => {
        if (shown && !editingRef.current) setIdText(String(shown.id));
    }, [shown]);

    // Loading cue: a random/looked-up punk is usually uncached, so its on-chain read
    // (cold archive fetch + heavy SVG) can take a beat. Pulse the art once a requested
    // punk is slow to arrive, so the click feels acknowledged. Cached cycle reads resolve
    // before the threshold, so the auto-cycle never flickers.
    const pendingId = shown != null && currentId !== shown.id;
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!pendingId) {
            setBusy(false);
            return;
        }
        const t = setTimeout(() => setBusy(true), 180);
        return () => clearTimeout(t);
    }, [pendingId, currentId]);

    // Right-hand traits: the homage's own axes lead (Color Count, then live Market Status),
    // then the punk id link and the punk's provenance metadata in their usual order.
    const displayMeta: TokenMeta | null = shown
        ? (() => {
              const attrs = shown.meta.attributes ?? [];
              const colorCount = attrs.filter((a) => a.trait_type === 'Color Count');
              const status = attrs
                  .filter((a) => a.trait_type === 'Status')
                  .map((a) => ({ ...a, trait_type: 'Market Status' }));
              const rest = attrs.filter((a) => a.trait_type !== 'Color Count' && a.trait_type !== 'Status');
              return {
                  ...shown.meta,
                  attributes: [
                      ...colorCount,
                      ...status,
                      {
                          trait_type: 'Punk',
                          value: String(shown.id),
                          href: `https://cryptopunks.app/cryptopunks/details/${shown.id}`,
                      },
                      ...rest,
                  ],
              };
          })()
        : null;

    const showPunk = punkView && !!punk.src;

    return (
        <div className="atelier min-h-screen">
            {!preview && (
                <>
                    <header className="mx-auto max-w-[1120px] px-6 sm:px-8 h-16 flex items-center justify-between">
                        <Link href="/homage" className="font-mono text-[11px] tracking-[0.28em] uppercase text-ink">homage to the punk</Link>
                        <Link href="/homage" className="font-mono text-[12px] text-dim hover:text-ink">mint →</Link>
                    </header>
                    <div className="h-px bg-line" />
                </>
            )}

            <main className="mx-auto max-w-[1120px] px-6 sm:px-8 pb-24">
                {/* hero-style left / right */}
                <section className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-10 lg:gap-16 items-start py-12 sm:py-16">
                    {/* art (auto-cycling) */}
                    <div className="flex flex-col items-center lg:items-start">
                        <div className={`art-mount ${busy ? 'animate-pulse' : ''}`}>
                            <div className="art-frame">
                                {shown ? (
                                    showPunk ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img key={`punk-${shown.id}`} src={punk.src} alt={`punk #${shown.id}`} className="art-img art-fade" />
                                    ) : (
                                        <MorphArt key={shown.id} src={shown.src} circle={pfp} className="art-img art-fade" />
                                    )
                                ) : (
                                    <div className="art-skeleton" />
                                )}
                            </div>
                        </div>
                        {/* id nav — below the image, kept understated */}
                        <div className="art-mount mt-5">
                            <div className="flex items-center gap-4 flex-wrap justify-center lg:justify-start font-mono text-[11px]">
                                <input
                                    type="number"
                                    min={0}
                                    max={9999}
                                    value={idText}
                                    placeholder="id"
                                    onFocus={() => {
                                        editingRef.current = true;
                                        setPlaying(false);
                                    }}
                                    onChange={(e) => {
                                        setPlaying(false);
                                        setIdText(e.target.value);
                                    }}
                                    onBlur={() => {
                                        editingRef.current = false;
                                        if (shown) setIdText(String(shown.id));
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const n = Number(idText);
                                            if (Number.isInteger(n) && n >= 0 && n <= 9999) pick(n);
                                        }
                                    }}
                                    className="w-[54px] bg-transparent border-b border-line text-center text-[12px] text-dim outline-none focus:text-ink focus:border-ink [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                    aria-label="punk id"
                                />
                                <button onClick={random} className="text-faint hover:text-ink tracking-[0.1em] transition-colors">↻ random</button>
                                <button onClick={() => setPlaying((p) => !p)} className="text-faint hover:text-ink tracking-[0.1em] transition-colors" title="auto-cycle">
                                    {playing ? '⏸ auto' : '▶ auto'}
                                </button>
                                <button
                                    onClick={togglePunk}
                                    className={`tracking-[0.1em] transition-colors ${punkView ? 'text-ink' : 'text-faint hover:text-ink'}`}
                                    title="show the punk this homage reads"
                                    aria-pressed={punkView}
                                >
                                    {punkView ? '●' : '○'} punk
                                </button>
                                {/* PFP (circles) toggle — hidden for now; uncomment (and the pfp state above) to restore.
                                <button
                                  onClick={() => setPfp((p) => !p)}
                                  className={`tracking-[0.1em] transition-colors ${pfp ? "text-ink" : "text-faint hover:text-ink"}`}
                                  title="toggle PFP (circles) output"
                                  aria-pressed={pfp}
                                >
                                  {pfp ? "●" : "○"} pfp
                                </button>
                                */}
                            </div>
                            {!valid && <div className="mt-2 text-[10px] text-[#b4431f] text-center lg:text-left">enter a punk id from 0 to 9999</div>}
                        </div>
                    </div>

                    {/* title + description + full traits */}
                    <div>
                        <div className="eyebrow-a">generative preview</div>
                        <h1 className="display mt-3">
                            {shown ? (
                                <>Homage to Punk <Flap value={String(shown.id)} trigger={shown.id} className="tabular-nums" /></>
                            ) : (
                                'Homage to the Punk'
                            )}
                        </h1>
                        <p className="text-[14px] leading-[1.5] text-dim mt-3 max-w-[42ch]">
                            One onchain homage for every punk
                        </p>

                        {!configured && (
                            <div className="mt-5 border border-[#b4431f] text-[#b4431f] text-[12px] font-mono p-3">
                                Renderer not configured. Run scripts/dev.sh.
                            </div>
                        )}

                        <div className="mt-7">
                            <div className="eyebrow-a">traits</div>
                            {/* Reserve height for the full trait set so a punk with fewer accessories
                                doesn't shrink the column and shift everything below it. */}
                            <div className="min-h-[316px]">
                                {displayMeta ? (
                                    <Traits meta={displayMeta} animate trigger={shown?.id} />
                                ) : (
                                    <p className="font-mono text-[11px] text-faint mt-3">{preview_.isLoading ? 'reading…' : '—'}</p>
                                )}
                            </div>
                        </div>
                    </div>
                </section>
            </main>
        </div>
    );
}
