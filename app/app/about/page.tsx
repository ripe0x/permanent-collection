import type {Metadata} from 'next';
import Link from 'next/link';
import {FeeBreakdown} from '@/components/FeeBreakdown';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {TraitGrid} from '@/components/TraitGrid';
import {getTokenTicker, isProtocolLive} from '@/lib/config';
import {getDataAdapter} from '@/lib/data';
import {ANTI_SNIPER, AUCTION, COLLECTION, FEES, fmtPct} from '@/lib/protocol-params';
import {buildMeta} from '@/lib/meta';
import {getCurrentFeePhase} from '@/lib/server/fee-phase';

const TICKER = getTokenTicker();

export const dynamic = 'force-dynamic';

/* About: the "I just landed here, what is this?" page. Plain-language
   overview of the protocol's claim, the loop (bid → accept → 72h return
   auction → vault), the vault, the fees, and what to know before buying
   $111. Technical depth (full spec, contract addresses, audit) lives in
   docs/. A short paragraph explains what an artcoin is and links to the
   artcoins site. Copy follows the language guide at
   docs/LANGUAGE_STYLE_GUIDE.md and the user's voice rules (contractions,
   no bullet periods, no dashes in text). Every fee number, duration,
   and percentage comes from `@/lib/protocol-params` so site-wide
   changes happen in one place. */

export const metadata: Metadata = buildMeta({
    title: 'About · Permanent Collection',
    description: `A plain-language overview of the Permanent Collection protocol: what it is, how it works, and what to know before buying ${TICKER}.`,
    path: '/about',
});

export default async function AboutPage() {
    const adapter = getDataAdapter();
    const [traits, phase] = await Promise.all([
        adapter.getTraitGrid().catch(() => null),
        getCurrentFeePhase(),
    ]);
    return (
        <>
            <Header />
            <main id="top">
                <section className="about-hero" aria-label="About Permanent Collection">
                    <div className="wrap">
                        <div className="kicker">About</div>
                        <h1 className="about-h1">
                            An onchain protocol building an immutable collection of Punks.
                        </h1>
                        <p className="about-lede">
                            Every {TICKER} trade feeds a public ETH bid for any Punk
                            carrying an uncollected trait. Accepted Punks enter a{' '}
                            {AUCTION.durationHours}-hour return auction. Unreturned Punks
                            enter the vault, and their trait becomes permanent. The work
                            completes when all {COLLECTION.totalTraits} distinct traits are
                            vaulted.
                        </p>
                        {!isProtocolLive() && (
                            <aside
                                className="about-prelaunch"
                                role="note"
                                aria-label="Pre-launch notice"
                            >
                                <span className="about-prelaunch-dot" aria-hidden="true" />
                                <span>
                                    <strong>{TICKER} isn&apos;t live yet.</strong> The
                                    contracts haven&apos;t been deployed. This site
                                    walks through the protocol decisions ahead of launch.
                                    Nothing here is tradeable today.
                                </span>
                            </aside>
                        )}
                    </div>
                </section>

                <section className="about-section" aria-label="What it is">
                    <div className="wrap about-grid">
                        <div className="about-sec-label">What it is</div>
                        <div className="about-sec-body">
                            <p>
                                Punks have <strong>{COLLECTION.totalTraits}</strong>{' '}
                                trait slots in the protocol&apos;s taxonomy: 5 types
                                (Alien, Ape, Female, Male, Zombie), 11 head variants, 8
                                attribute counts, and 87 accessories. Not every slot
                                renders a distinct visual. The Alien type and the Alien
                                head variant share a sprite, the same for Ape and
                                Zombie, and attribute counts are numerical rather than
                                something you see on a Punk. The Permanent Collection is
                                a protocol whose goal is to assemble a vault of Punks
                                that, together, cover every one of those slots.
                            </p>
                            <p>
                                The artwork is the system. The on-chain renderer paints an
                                11×10 mosaic of every trait plus the pulled-out final type
                                beneath it (uncollected, in return auction, and permanent),
                                and the picture updates as the protocol runs.
                            </p>
                            <p>
                                No deadline, no admin pause, no upgrade path. The protocol completes
                                when the full set is vaulted or reaches an equilibrium where the
                                remaining traits are held by owners who refuse the bid.
                            </p>
                        </div>
                    </div>
                </section>

                {traits && (
                    <section className="about-artwork" aria-label="The 111 trait slots">
                        <div className="wrap">
                            <figure className="about-artwork-figure">
                                <TraitGrid traits={traits} />
                                <figcaption className="about-artwork-caption">
                                    The {COLLECTION.totalTraits} trait slots. Each shows its
                                    isolated trait until a Punk vaults the slot.
                                </figcaption>
                            </figure>
                        </div>
                    </section>
                )}

                <section className="about-section" aria-label="How it works">
                    <div className="wrap about-grid">
                        <div className="about-sec-label">How it works</div>
                        <div className="about-sec-body">
                            <ol className="about-steps">
                                <li>
                                    <strong>The live bid:</strong> one global ETH offer, standing
                                    open to any owner of an eligible Punk, funded by every{' '}
                                    {TICKER} swap
                                </li>
                                <li>
                                    <strong>Accept:</strong> an owner whose Punk carries an
                                    uncollected trait accepts the bid, and the Punk enters a{' '}
                                    {AUCTION.durationHours}-hour return auction. Punks listed
                                    by allowlisted peer protocols (PunkStrategy at launch,
                                    others as added) can also be bridged in by anyone for a
                                    finder fee
                                </li>
                                <li>
                                    <strong>{AUCTION.durationHours}-hour return auction:</strong>{' '}
                                    anyone can bid to return the Punk to circulation. A bid
                                    above the reserve sends the Punk back to the market and
                                    refills the live bid; no bid sends the Punk to the vault
                                    and the chosen trait becomes permanent
                                </li>
                                <li>
                                    <strong>Proof NFT:</strong> each first-vaulted trait mints
                                    a Proof NFT to the address that gave up the Punk, one
                                    permanent record per trait, capped at{' '}
                                    {COLLECTION.proofTokenCount}
                                </li>
                            </ol>
                        </div>
                    </div>
                </section>

                <section className="about-section" aria-label="The vault">
                    <div className="wrap about-grid">
                        <div className="about-sec-label">The vault</div>
                        <div className="about-sec-body">
                            <p>
                                <strong>PunkVault</strong> is immutable. There&apos;s no admin
                                path that can move a Punk out; the contract has no transfer,
                                withdraw, rescue, or sweep selector. This is asserted at the
                                bytecode level.
                            </p>
                            <p>
                                The vault is also the issuer of the protocol&apos;s{' '}
                                {COLLECTION.proofTokenCount + 1} named tokens:{' '}
                                {COLLECTION.proofTokenCount} Proofs (one per trait, minted to
                                the original seller of the vaulted Punk) and one Title NFT
                                (auctioned separately as the role-of-record for the entire
                                work).
                            </p>
                            <p>
                                The Punks themselves aren&apos;t ERC721 tokens; they live at the
                                canonical 2017 Punks market contract, where the vault holds
                                them at its address indefinitely.
                            </p>
                        </div>
                    </div>
                </section>

                <section className="about-section" aria-label="Fees">
                    <div className="wrap about-grid">
                        <div className="about-sec-label">Fees</div>
                        <div className="about-sec-body">
                            <p>
                                Every swap pays a {fmtPct(FEES.baselineSkimPct)}{' '}
                                protocol fee on top of the {fmtPct(FEES.lpFeePct)} V4 LP
                                fee. The hook routes each leg to a fixed destination from
                                block one:
                            </p>
                            <FeeBreakdown phase={phase} variant="detailed" />
                            <p>
                                The referral slice comes out of the protocol leg, not on
                                top of it, and never reduces the live bid. At launch the
                                conversion locker holds 100% of LP positions and forwards
                                its share to the live bid until public LPs add depth.
                            </p>

                            <h3 className="about-phase-label">
                                Anti-sniper window (first ~{ANTI_SNIPER.durationMin} minutes after launch)
                            </h3>
                            <p>
                                For the first ~{ANTI_SNIPER.durationMin} minutes after
                                launch, the protocol fee starts at{' '}
                                {fmtPct(ANTI_SNIPER.peakPct)} and decays linearly to
                                the {fmtPct(ANTI_SNIPER.baselinePct)} baseline at{' '}
                                {fmtPct(ANTI_SNIPER.decayPctPerMin)} per minute.
                                Everything above the baseline (the &quot;overage&quot;)
                                routes 100% to the live bid. The baseline split above
                                runs underneath the overage during the window, and on
                                its own once the window closes.
                            </p>
                        </div>
                    </div>
                </section>

                <section className="about-section" aria-label="What is an artcoin">
                    <div className="wrap about-grid">
                        <div className="about-sec-label">What&apos;s an artcoin?</div>
                        <div className="about-sec-body">
                            <p>
                                {TICKER} is an <strong>artcoin</strong>: a token whose
                                purpose is to power a piece of on-chain art, not governance
                                or utility. The artwork is the protocol; trading the coin
                                is what makes the protocol run.
                            </p>
                            <p>
                                Permanent Collection is launched on the artcoins platform: the
                                token, the pool, and the LP locker are deployed via the artcoins
                                factory.{' '}
                                <a
                                    href="https://artcoins.art"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="about-link"
                                >
                                    Read more about artcoins →
                                </a>
                            </p>
                        </div>
                    </div>
                </section>

                <section className="about-section" aria-label={`Before you buy ${TICKER}`}>
                    <div className="wrap about-grid">
                        <div className="about-sec-label">Before you buy</div>
                        <div className="about-sec-body">
                            <p>
                                {TICKER} is a speculative token. A few honest disclaimers:
                            </p>
                            <ul className="about-fees">
                                <li>
                                    {TICKER} <strong>doesn&apos;t redeem</strong> for
                                    vaulted Punks
                                </li>
                                <li>
                                    {TICKER} holders <strong>don&apos;t govern</strong>{' '}
                                    the protocol: no DAO, no vote, no parameter change
                                </li>
                                <li>
                                    Economic parameters lock about a year after deployment. The
                                    admin can renew that timer or burn the role to make the lock
                                    permanent, and can never move funds either way. A few bounded
                                    carve-outs stay editable past the lock (the seller allowlist,
                                    plus a couple of fee-rate knobs the admin can tune within hard
                                    limits) so the protocol can track market conditions over time
                                </li>
                                <li>
                                    The {fmtPct(FEES.totalSwapFeePct)} swap fee is how the protocol
                                    runs. The bulk grows the live bid; a thin protocol leg funds a
                                    PC treasury and a LAYER buy-and-burn from block one, and the
                                    Vault Title auction&apos;s proceeds go to the project. None of
                                    it is distributed to {TICKER} holders
                                </li>
                            </ul>
                            <p>
                                Read the full protocol spec, the audit, and the contract addresses
                                before depositing any meaningful capital.
                            </p>
                        </div>
                    </div>
                </section>

                <section className="about-section about-section-cta" aria-label="Next steps">
                    <div className="wrap">
                        <div className="about-cta">
                            <Link href="/trade" className="primary">
                                Trade {TICKER}
                            </Link>
                            <Link href="/collection" className="secondary">
                                View the collection
                            </Link>
                            <Link href="/builders" className="secondary">
                                Builder docs
                            </Link>
                        </div>
                    </div>
                </section>
            </main>
            <Footer />

            <style>{styles}</style>
        </>
    );
}

const styles = `
.about-hero {
    padding-top: clamp(60px, 9vh, 100px);
    padding-bottom: clamp(40px, 6vh, 70px);
    border-top: none;
}
.about-h1 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(34px, 5vw, 60px);
    line-height: 1.04;
    letter-spacing: -0.035em;
    margin: 12px 0 24px;
    max-width: 32ch;
}
.about-lede {
    font-family: var(--sans);
    font-size: 18px;
    line-height: 1.62;
    color: var(--muted);
    max-width: 60ch;
}
.about-prelaunch {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-top: 28px;
    padding: 16px 18px;
    max-width: 60ch;
    border: 1px solid var(--line);
    background: rgba(0, 0, 0, 0.025);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink);
}
.about-prelaunch strong {
    font-weight: 600;
    color: var(--ink);
}
.about-prelaunch-dot {
    width: 8px;
    height: 8px;
    margin-top: 8px;
    flex: 0 0 auto;
    background: var(--accent);
    border-radius: 50%;
}
.about-artwork {
    padding: clamp(20px, 4vh, 48px) 0 clamp(40px, 6vh, 72px);
    border-top: none;
}
.about-artwork-figure {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
}
.about-artwork-caption {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--muted);
    line-height: 1.55;
    max-width: 60ch;
}
.about-grid {
    display: grid;
    grid-template-columns: minmax(160px, 200px) minmax(0, 1fr);
    gap: clamp(28px, 5vw, 64px);
    align-items: start;
}
.about-sec-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    padding-top: 6px;
}
.about-sec-body {
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.7;
    color: var(--ink);
    max-width: 60ch;
    display: flex;
    flex-direction: column;
    gap: 14px;
}
.about-sec-body strong { font-weight: 600; }
.about-sec-body em { font-style: italic; color: var(--accent); }
.about-steps {
    margin: 0;
    padding-left: 22px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.about-steps li { padding-left: 4px; }
.about-fees {
    margin: 0;
    padding-left: 22px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.about-phase-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink);
    margin: 18px 0 4px;
    font-weight: 500;
}
.about-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
.about-link:hover { color: var(--ink); }
.about-section-cta {
    padding: clamp(60px, 9vh, 100px) 0;
}
.about-cta {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
}
@media (max-width: 760px) {
    .about-grid {
        grid-template-columns: 1fr;
        gap: 14px;
    }
    .about-sec-label {
        padding-top: 0;
    }
}
`;
