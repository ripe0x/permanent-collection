import {Artwork} from '@/components/Artwork';
import {getTokenTicker} from '@/lib/config';
import {AUCTION, COLLECTION, FEES, fmtPct} from '@/lib/protocol-params';

const TICKER = getTokenTicker();

/* Long-form essay describing the work and its mechanics. Pure content —
   accepts the renderer SVG as a prop so the page handler controls the
   data source.

   The `artwork` slot replaces the default `<Artwork svgMarkup={...}>`
   embed entirely (pass a real `<TraitGrid>` to show all 111 trait icons);
   leave it unset so the on-chain SVG (or its placeholder grid) renders.

   The optional `footer` slot lets the page handler append a route-specific
   nav; the standalone /why route leaves it empty. */
export function WhyEssay({
    svgMarkup,
    artwork,
    artworkCaption,
    footer,
}: {
    svgMarkup?: string | null;
    artwork?: React.ReactNode;
    artworkCaption?: React.ReactNode;
    footer?: React.ReactNode;
}) {
    return (
        <>
            <main id="top" className="why">
                <article className="why-article">
                    <header className="why-header">
                        <div className="why-kicker">Permanent Collection</div>
                        <h1 className="why-h1">
                            An onchain protocol building an immutable collection of Punks.
                        </h1>
                        <p className="why-lede">
                            Every {TICKER} trade feeds a public ETH bid for any
                            Punk carrying an uncollected trait. Accepted Punks enter
                            a {AUCTION.durationHours}-hour return auction. Punks not bid
                            back into circulation enter the vault, and their trait becomes
                            permanent. The work completes when all{' '}
                            {COLLECTION.totalTraits} distinct traits are vaulted.
                        </p>
                    </header>

                    <section className="why-prose">
                        <p>
                            Punks gives the work its count: {COLLECTION.totalTraits}{' '}
                            traits across types, head variants, attribute counts, and
                            accessories.
                        </p>
                        <p>Each trait has one slot in the collection.</p>
                        <p>
                            Open slots show isolated traits. Pending slots show traits
                            carried by accepted Punks in return auction. Permanent slots
                            show the vaulted Punk that made the trait permanent.
                        </p>
                        <p>
                            The collection advances through a live bid, a return auction,
                            and a vault with no exit.
                        </p>
                        <p>No deadline, no admin pause, no upgrade path.</p>
                    </section>

                    <section className="why-section" aria-label="How it works">
                        <h2 className="why-h2">How it works</h2>
                        <ol className="why-steps">
                            <li>
                                <strong>Live bid:</strong> one global ETH offer, funded by
                                every {TICKER} swap, standing open to any owner of
                                an eligible Punk
                            </li>
                            <li>
                                <strong>Accept:</strong> an owner whose Punk carries an
                                uncollected trait accepts the bid, and the Punk enters
                                a {AUCTION.durationHours}-hour return auction
                            </li>
                            <li>
                                <strong>Return auction:</strong> anyone can buy the Punk
                                back by bidding above the reserve; if no one does, the
                                Punk enters the vault and the trait becomes permanent
                            </li>
                        </ol>
                    </section>

                    <section className="why-section" aria-label="The live bid">
                        <h2 className="why-h2">The live bid</h2>
                        <div className="why-prose">
                            <p>Official pool trading feeds the live bid.</p>
                            <p>
                                An eligible Punk carries at least one open trait. The owner
                                can accept the bid. The owner is paid the listed price, and a
                                {' '}{AUCTION.durationHours}-hour return auction opens for that
                                Punk.
                            </p>
                            <p>
                                During those {AUCTION.durationHours} hours, anyone can
                                return the Punk to circulation by bidding above the reserve.
                            </p>
                            <p>
                                Returned Punks leave the protocol. Their pending traits stay
                                open.
                            </p>
                            <p>
                                Unreturned Punks enter the vault. One chosen trait becomes
                                permanent.
                            </p>
                        </div>
                    </section>

                    <figure className="why-artwork" aria-label="Live state of the work">
                        {artwork ?? <Artwork svgMarkup={svgMarkup} />}
                        <figcaption className="why-artwork-caption">
                            {artworkCaption ?? <>The token renders the collection&apos;s current state.</>}
                        </figcaption>
                    </figure>

                    <section className="why-section" aria-label="The artcoin">
                        <h2 className="why-h2">The artcoin</h2>
                        <div className="why-prose">
                            <p>{TICKER} is the artcoin for Permanent Collection.</p>
                            <p>
                                Artcoins are ERC20 artworks on Ethereum with an official
                                pool, fee routing, and live tokenURI rendering. The token
                                can render its own state, and the official pool can route
                                trading activity into actions inside the work.
                            </p>
                            <p>For {TICKER}, that action is the live bid.</p>
                            <p>
                                Every swap pays a {fmtPct(FEES.totalSwapFeePct)} fee:{' '}
                                {fmtPct(FEES.lpFeePct)} is the V4 LP fee paid to liquidity
                                providers, plus {fmtPct(FEES.baselineSkimPct)} is a baseline
                                skim the hook splits inside the same swap:
                            </p>
                            <ul className="why-fees">
                                <li>
                                    <strong>{fmtPct(FEES.bidLegPct)}</strong> feeds the
                                    live bid
                                </li>
                                <li>
                                    <strong>{fmtPct(FEES.protocolLegPct)}</strong> covers
                                    protocol operations
                                </li>
                            </ul>
                            <p>
                                At launch the {fmtPct(FEES.lpFeePct)} LP fee also feeds the
                                live bid: a conversion locker holds 100% of LP positions
                                and routes its share to the live-bid adapter until public
                                LPs add depth.
                            </p>
                            <p>
                                The market around the artwork funds the attempt to collect
                                the {COLLECTION.totalTraits} traits. The same token renders
                                the collection state as it changes.
                            </p>
                            <p>
                                {TICKER} doesn&apos;t redeem for vaulted Punks. It doesn&apos;t
                                control the vault. It&apos;s the liquid artwork and market layer that
                                powers the acquisition system.
                            </p>
                        </div>
                    </section>

                    <section className="why-section" aria-label="The vault">
                        <h2 className="why-h2">The vault</h2>
                        <div className="why-prose">
                            <p>A Punk in return auction can still go back to circulation.</p>
                            <p>A Punk in the vault can&apos;t.</p>
                            <ul className="why-list">
                                <li>No admin withdrawal</li>
                                <li>No governance withdrawal</li>
                                <li>No emergency exit</li>
                                <li>No upgrade path that can reach it</li>
                            </ul>
                            <p>
                                The vault holds Punks through a contract that can&apos;t move
                                them. This is asserted at the bytecode level: no transfer,
                                withdraw, rescue, or sweep selector exists in the deployed
                                contract.
                            </p>
                            <p>
                                That contract structure gives permanent traits their meaning.
                                A trait becomes permanent because the Punk representing it
                                has entered custody without an exit path.
                            </p>
                            <p>The sequence stays public.</p>
                            <ul className="why-list">
                                <li>A trade feeds the bid</li>
                                <li>An owner accepts</li>
                                <li>A return auction opens</li>
                                <li>A Punk returns to circulation</li>
                                <li>A Punk enters the vault</li>
                                <li>A trait becomes permanent</li>
                            </ul>
                        </div>
                    </section>

                    <section className="why-section" aria-label="Open state">
                        <h2 className="why-h2">Open state</h2>
                        <div className="why-prose">
                            <p>
                                The protocol runs until every trait is represented by a
                                vaulted Punk, or until the remaining eligible Punks stay
                                outside the protocol.
                            </p>
                            <p>
                                Some traits may move quickly. Others may sit open for years.
                                The last traits may never enter.
                            </p>
                            <p>The record keeps updating.</p>
                            <ul className="why-list">
                                <li>What trading funded</li>
                                <li>What owners accepted</li>
                                <li>What the market returned</li>
                                <li>What entered the vault</li>
                                <li>What became permanent</li>
                            </ul>
                        </div>
                    </section>

                    <section className="why-section" aria-label="What to know">
                        <h2 className="why-h2">What to know</h2>
                        <div className="why-prose">
                            <p>{TICKER} is a speculative token. A few things worth saying plainly:</p>
                            <ul className="why-list">
                                <li>{TICKER} doesn&apos;t redeem for vaulted Punks</li>
                                <li>No governance: no DAO, no vote, no parameter change</li>
                                <li>Most economic parameters lock one year after launch</li>
                                <li>The {fmtPct(FEES.totalSwapFeePct)} swap fee is how the protocol runs; most grows the live bid, a thin protocol leg funds a PC treasury and a LAYER burn, and {TICKER} holders receive none of it</li>
                            </ul>
                        </div>
                    </section>

                    {footer}
                </article>
            </main>
            <style>{styles}</style>
        </>
    );
}

const styles = `
.why {
    background: var(--bg);
    color: var(--ink);
    padding: clamp(56px, 10vh, 120px) var(--pad) clamp(80px, 12vh, 160px);
}
/* Cancel the global section { padding; border-top } rule so the essay
   reads as one continuous flow — the article controls its own rhythm. */
.why section {
    padding: 0;
    border-top: none;
}
.why-article {
    max-width: 640px;
    margin: 0 auto;
    font-family: var(--sans);
}
.why-header {
    margin-bottom: clamp(48px, 7vh, 80px);
}
.why-kicker {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: clamp(28px, 5vh, 48px);
}
.why-h1 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(36px, 5.4vw, 64px);
    line-height: 1.02;
    letter-spacing: -0.035em;
    margin-bottom: clamp(20px, 3vh, 32px);
}
.why-lede {
    font-family: var(--sans);
    font-size: clamp(20px, 2vw, 24px);
    line-height: 1.5;
    color: var(--ink);
    max-width: 36ch;
}
.why-section {
    margin-top: clamp(48px, 7vh, 80px);
}
.why-h2 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(24px, 2.6vw, 32px);
    line-height: 1.15;
    letter-spacing: -0.02em;
    margin-bottom: clamp(20px, 3vh, 28px);
}
.why-prose {
    display: flex;
    flex-direction: column;
    gap: 18px;
    font-family: var(--sans);
    font-size: 19px;
    line-height: 1.62;
    color: var(--ink);
}
.why-prose p {
    margin: 0;
}
.why-list {
    list-style: none;
    padding: 0;
    margin: 4px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.why-list li {
    padding-left: 18px;
    position: relative;
}
.why-list li::before {
    content: '—';
    position: absolute;
    left: 0;
    color: var(--muted);
}
.why-steps {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
    counter-reset: step;
    font-family: var(--sans);
    font-size: 19px;
    line-height: 1.6;
    color: var(--ink);
}
.why-steps li {
    counter-increment: step;
    padding-left: 38px;
    position: relative;
}
.why-steps li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: 1px;
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 500;
    color: var(--accent);
    letter-spacing: 0.05em;
}
.why-steps strong {
    font-weight: 600;
}
.why-fees {
    list-style: none;
    padding: 0;
    margin: 4px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.why-fees li {
    padding-left: 18px;
    position: relative;
}
.why-fees li::before {
    content: '—';
    position: absolute;
    left: 0;
    color: var(--muted);
}
.why-fees strong {
    font-weight: 600;
    color: var(--ink);
    font-family: var(--mono);
    font-size: 0.94em;
    margin-right: 4px;
}
.why-artwork {
    margin: clamp(56px, 8vh, 96px) 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
}
.why-artwork-caption {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
@media (max-width: 760px) {
    .why-prose {
        font-size: 17px;
    }
    .why-lede {
        font-size: 19px;
    }
}
`;
