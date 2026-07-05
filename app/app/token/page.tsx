import type {Metadata} from 'next';
import Link from 'next/link';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {getChainId, getContractAddresses, getTokenTicker, isProtocolLive} from '@/lib/config';
import {ADMIN, CLEARED_SPLIT, FEES, TAX, TOKEN, fmtPct} from '@/lib/protocol-params';
import {ARTCOINS_FEE_PCT_OF_VOLUME, TEAM_PCT_OF_VOLUME} from '@/lib/fees';
import {getEvmNowAddressUrl} from '@/lib/format';
import {buildMeta} from '@/lib/meta';

/* "About the token": a fast, scannable read for someone trying to decide
   whether $111 is a fair / safe coin before buying. Foregrounds the
   structural facts a buyer checks first (no team allocation, fair launch,
   locked liquidity, fixed supply, immutable contracts), is honest about the
   transfer tax and the risks, and points to on-chain verification. Numbers
   come from `@/lib/protocol-params` (the deploy-constant source of truth);
   nothing is hardcoded here. Copy follows docs/LANGUAGE_STYLE_GUIDE.md and
   the voice rules: contractions, no trailing periods on bullets, no dashes. */

const TICKER = getTokenTicker();

export const metadata: Metadata = buildMeta({
    title: `${TICKER} token`,
    description: `What ${TICKER} is and how to judge it: no team allocation, fair launch, 100% locked liquidity, fixed supply, immutable contracts. Plus the honest risks.`,
    path: '/token',
});

export const dynamic = 'force-dynamic';

const BADGES = [
    'No team allocation',
    'No presale',
    '100% liquidity',
    'Fixed supply',
    'Liquidity locked',
    'Immutable contracts',
];

export default function TokenPage() {
    const live = isProtocolLive();
    const {token} = getContractAddresses();
    const chainId = getChainId();
    const tokenUrl = live ? getEvmNowAddressUrl(token, chainId) : null;

    return (
        <>
            <Header />
            <main id="top" className="tok">
                {/* Hero */}
                <section className="tok-hero">
                    <div className="wrap">
                        <div className="kicker">The token</div>
                        <h1 className="tok-h1">
                            {TICKER} <span className="tok-h1-sym">{TOKEN.name}</span>
                        </h1>
                        <p className="tok-lede">
                            {live ? (
                                <>
                                    {TICKER} is the artcoin that powers the Permanent
                                    Collection. It launched fair, with no insider allocation
                                    and its entire supply seeded as locked liquidity. Every
                                    trade funds a standing ETH bid that buys CryptoPunks into a
                                    permanent, un-withdrawable vault.
                                </>
                            ) : (
                                <>
                                    {TICKER} is the artcoin that will power the Permanent
                                    Collection. It launches fair: no insider allocation, and
                                    its entire supply is seeded as locked liquidity at deploy.
                                    Every trade will fund a standing ETH bid that buys
                                    CryptoPunks into a permanent, un-withdrawable vault.
                                </>
                            )}
                        </p>
                        <div className="tok-badges" aria-label="At a glance">
                            {BADGES.map((b) => (
                                <span key={b} className="tok-badge">
                                    {b}
                                </span>
                            ))}
                        </div>
                        {!live && (
                            <aside className="tok-prelaunch" role="note">
                                <span className="tok-dot" aria-hidden="true" />
                                <span>
                                    <strong>{TICKER} isn&apos;t live yet.</strong> The
                                    contracts aren&apos;t deployed, so there&apos;s nothing to
                                    trade or verify on-chain yet. This page describes the
                                    launch design; the values and links go live the moment it
                                    deploys.
                                </span>
                            </aside>
                        )}
                    </div>
                </section>

                {/* Snapshot */}
                <section className="tok-section" aria-label="Snapshot">
                    <div className="wrap">
                        <h2 className="tok-h2">Snapshot</h2>
                        <dl className="tok-snap">
                            <Snap k="Ticker" v={TICKER} good />
                            <Snap k="Total supply" v={`${TOKEN.totalSupplyDisplay}, fixed`} good />
                            <Snap k="Team / insider allocation" v="0%" good />
                            <Snap k="Presale / private round" v="None" good />
                            <Snap k="Liquidity" v="100% of supply, locked" good />
                            <Snap k="Mint after launch" v="None" good />
                            <Snap k="Contracts" v="Immutable, no upgrade path" good />
                            <Snap
                                k="Admin"
                                v={`No withdrawal path, auto-locks after ~${ADMIN.lockYears} year`}
                                good
                            />
                            <Snap
                                k="Holder governance"
                                v="None (the coin powers art, not a DAO)"
                            />
                            <Snap
                                k="Transfer tax"
                                v={`${fmtPct(TAX.launchPct)} on side-pool buys only (official pool is exempt)`}
                                warn
                            />
                        </dl>
                    </div>
                </section>

                {/* Fair launch */}
                <section className="tok-section" aria-label="Fair launch">
                    <div className="wrap tok-grid">
                        <div className="tok-sec-label">Fair launch</div>
                        <div className="tok-sec-body">
                            {live ? (
                                <p>
                                    {TICKER} was deployed in a single transaction through the
                                    artcoins factory. The factory minted the whole{' '}
                                    {TOKEN.totalSupplyCompact} supply and placed all of it into
                                    the official pool as liquidity. Nobody, the team included,
                                    received tokens ahead of the public. From the first block,
                                    everyone buys from the same pool on the same terms.
                                </p>
                            ) : (
                                <p>
                                    {TICKER} launches in a single transaction through the
                                    artcoins factory. The factory mints the whole{' '}
                                    {TOKEN.totalSupplyCompact} supply and places all of it into
                                    the official pool as liquidity. Nobody, the team included,
                                    receives tokens ahead of the public. From the first block,
                                    everyone will buy from the same pool on the same terms.
                                </p>
                            )}
                            <ul className="tok-list">
                                <li>No presale, no private round, no vesting cliffs</li>
                                <li>No team, treasury, advisor, or marketing wallet</li>
                                <li>No airdrop and no post-launch mint, the supply is fixed</li>
                                <li>
                                    An anti-sniper window keeps the first ~30 minutes from
                                    being front-run: the swap fee starts high and decays to
                                    the baseline, and the overage feeds the live bid
                                </li>
                            </ul>
                        </div>
                    </div>
                </section>

                {/* Allocation */}
                <section className="tok-section" aria-label="Allocation">
                    <div className="wrap tok-grid">
                        <div className="tok-sec-label">Allocation</div>
                        <div className="tok-sec-body">
                            <p>
                                {live
                                    ? `There is nothing to unlock and nobody with a head start. 100% of ${TICKER} is liquidity.`
                                    : `There will be nothing to unlock and nobody with a head start. 100% of ${TICKER} is liquidity at launch.`}
                            </p>
                            <div className="tok-alloc" aria-hidden="true">
                                <div className="tok-alloc-bar">
                                    <span className="tok-alloc-fill" style={{width: '100%'}}>
                                        Liquidity 100%
                                    </span>
                                </div>
                            </div>
                            <ul className="tok-alloc-legend">
                                <li>
                                    <span className="tok-pct">100%</span> Liquidity (locked in the
                                    conversion locker, fees route to the live bid)
                                </li>
                                <li>
                                    <span className="tok-pct tok-pct-zero">0%</span> Team /
                                    founders
                                </li>
                                <li>
                                    <span className="tok-pct tok-pct-zero">0%</span> Presale /
                                    investors
                                </li>
                                <li>
                                    <span className="tok-pct tok-pct-zero">0%</span> Treasury /
                                    reserve
                                </li>
                                <li>
                                    <span className="tok-pct tok-pct-zero">0%</span> Airdrop /
                                    marketing
                                </li>
                            </ul>
                            <p className="tok-note">
                                The liquidity {live ? 'sits' : 'will sit'} in the conversion
                                locker whose reward recipient is permanently fixed to the live
                                bid (admin set to the dead address), so the LP can&apos;t be
                                pulled and its fees flow back into buying Punks.
                            </p>
                        </div>
                    </div>
                </section>

                {/* What the fees do */}
                <section className="tok-section" aria-label="What the fees do">
                    <div className="wrap tok-grid">
                        <div className="tok-sec-label">What the fees do</div>
                        <div className="tok-sec-body">
                            <p>
                                Every swap {live ? 'pays' : 'will pay'} a{' '}
                                {fmtPct(FEES.totalSwapFeePct)} fee. Unlike most coins, the bulk
                                of it doesn&apos;t go to a team, it goes to work for the
                                mission:
                            </p>
                            <ul className="tok-list">
                                <li>
                                    <strong>{fmtPct(FEES.bidLegPct)} to the live bid</strong>,
                                    the standing ETH offer that acquires Punks into the vault
                                </li>
                                <li>
                                    <strong>{fmtPct(FEES.lpFeePct)} LP fee</strong>, which at
                                    launch routes to the live bid too (the locker holds all
                                    the liquidity)
                                </li>
                                <li>
                                    <strong>{TEAM_PCT_OF_VOLUME.toFixed(2)}% to the team</strong>
                                </li>
                                <li>
                                    <strong>
                                        {fmtPct(FEES.referralCapPct)} to swap referrer
                                    </strong>
                                </li>
                                <li>
                                    <strong>
                                        {ARTCOINS_FEE_PCT_OF_VOLUME.toFixed(2)}% to a $LAYER
                                        buy-and-burn
                                    </strong>
                                    , the artcoins protocol&apos;s share
                                </li>
                            </ul>
                            <p className="tok-note">
                                None of the fee {live ? 'is' : 'will be'} paid out to {TICKER}{' '}
                                holders. The value it creates is a growing, on-chain collection
                                of Punks that can never leave the vault.{' '}
                                <Link href="/about">How it all works →</Link>
                            </p>
                        </div>
                    </div>
                </section>

                {/* Buy and burn */}
                <section className="tok-section" aria-label="Buy and burn">
                    <div className="wrap tok-grid">
                        <div className="tok-sec-label">Buy &amp; burn</div>
                        <div className="tok-sec-body">
                            <p>
                                When a return auction is won, the proceeds{' '}
                                {live ? 'are' : 'will be'} split on-chain:{' '}
                                {fmtPct(CLEARED_SPLIT.liveBidPct)} refills the live bid,{' '}
                                {fmtPct(CLEARED_SPLIT.buybackBurnPct)} buys {TICKER} and burns
                                it, and {fmtPct(CLEARED_SPLIT.vaultBurnPct)} feeds a separate
                                burn pool. Burned {TICKER} goes to the dead address, gone from
                                supply for good.
                            </p>
                        </div>
                    </div>
                </section>

                {/* Transfer tax */}
                <section className="tok-section" aria-label="Transfer tax">
                    <div className="wrap tok-grid">
                        <div className="tok-sec-label">Know the tax</div>
                        <div className="tok-sec-body">
                            <p>
                                <strong>
                                    The {fmtPct(TAX.launchPct)} tax {live ? 'is' : 'will be'} on
                                    side pools only. It is never charged on the canonical
                                    (official) {TICKER}/ETH pool.
                                </strong>{' '}
                                Its one job is to keep trading on the canonical pool, where the
                                fee funds the mission, so it fires only on a{' '}
                                <strong>buy from an unofficial side pool</strong>. It does not
                                touch:
                            </p>
                            <ul className="tok-list">
                                <li>
                                    Any buy or sell on the canonical (official) {TICKER}/ETH
                                    pool (exempt by design)
                                </li>
                                <li>Any sell, on any venue</li>
                                <li>Wallet-to-wallet sends, bridges, lending, and CEX moves</li>
                            </ul>
                            <p className="tok-note">
                                Taxed tokens are burned, never sold. The rate is tunable by
                                the admin within a hard {fmtPct(TAX.capPct)} ceiling and can
                                never go higher. The simple rule: buy on the official pool and
                                you pay no tax.
                            </p>
                            {live ? (
                                <Link href="/trade" className="tok-inline-cta">
                                    Buy on the official pool →
                                </Link>
                            ) : null}
                        </div>
                    </div>
                </section>

                {/* Risks */}
                <section className="tok-section" aria-label="Honest risks">
                    <div className="wrap tok-grid">
                        <div className="tok-sec-label">Honest risks</div>
                        <div className="tok-sec-body">
                            <p>
                                Structural fairness isn&apos;t a promise of price. {TICKER} is
                                a speculative token and this isn&apos;t financial advice. Go in
                                clear-eyed:
                            </p>
                            <ul className="tok-list">
                                <li>The price is volatile and can go to zero</li>
                                <li>{TICKER} doesn&apos;t redeem for vaulted Punks or any asset</li>
                                <li>Holders have no governance, no vote, and no fee share</li>
                                <li>
                                    A few bounded parameters (the seller allowlist and a couple
                                    of fee-rate knobs) stay admin-tunable within hard limits for
                                    about {ADMIN.lockYears} year, then lock. The admin can never
                                    move funds
                                </li>
                                <li>
                                    Trading fees fund the live bid and buy-and-burns, not
                                    payouts to holders
                                </li>
                            </ul>
                        </div>
                    </div>
                </section>

                {/* Verify */}
                <section className="tok-section" aria-label="Verify it yourself">
                    <div className="wrap tok-grid">
                        <div className="tok-sec-label">Verify it yourself</div>
                        <div className="tok-sec-body">
                            {live ? (
                                <>
                                    <p>Don&apos;t trust the copy, read the chain:</p>
                                    <ul className="tok-links">
                                        <li>
                                            <Link href="/docs/introduction/addresses">All contract addresses →</Link>
                                        </li>
                                        {tokenUrl && (
                                            <li>
                                                <a href={tokenUrl} target="_blank" rel="noreferrer">
                                                    The {TICKER} token contract →
                                                </a>
                                            </li>
                                        )}
                                        <li>
                                            <Link href="/proofs">The Proofs the vault has issued →</Link>
                                        </li>
                                        <li>
                                            <Link href="/about">The full protocol overview →</Link>
                                        </li>
                                    </ul>
                                </>
                            ) : (
                                <>
                                    <p>
                                        Every claim here becomes checkable on-chain the moment{' '}
                                        {TICKER} deploys: contract addresses, the token, and the
                                        vaulted Proofs. Until then, read the design:
                                    </p>
                                    <ul className="tok-links">
                                        <li>
                                            <Link href="/about">The full protocol overview →</Link>
                                        </li>
                                        <li>
                                            <Link href="/protocol">The protocol spec →</Link>
                                        </li>
                                        <li>
                                            <Link href="/collection">The 111-trait artwork →</Link>
                                        </li>
                                    </ul>
                                </>
                            )}
                        </div>
                    </div>
                </section>

                {/* CTA */}
                <section className="tok-section tok-cta-section" aria-label="Next steps">
                    <div className="wrap">
                        <div className="tok-cta">
                            {live ? (
                                <Link href="/trade" className="primary">
                                    Trade {TICKER}
                                </Link>
                            ) : (
                                <Link href="/about" className="primary">
                                    How it works
                                </Link>
                            )}
                            <Link href="/collection" className="secondary">
                                View the collection
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

function Snap({k, v, good, warn}: {k: string; v: string; good?: boolean; warn?: boolean}) {
    return (
        <div className={`tok-snap-row${good ? ' is-good' : ''}${warn ? ' is-warn' : ''}`}>
            <dt>{k}</dt>
            <dd>{v}</dd>
        </div>
    );
}

const styles = `
.tok-hero {
    padding-top: clamp(48px, 8vh, 96px);
    padding-bottom: clamp(28px, 4vh, 48px);
}
.tok-h1 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(40px, 7vw, 76px);
    line-height: 1;
    letter-spacing: -0.04em;
    margin: 10px 0 20px;
}
.tok-h1-sym {
    font-family: var(--mono);
    font-size: 0.34em;
    letter-spacing: 0.04em;
    color: var(--muted);
    vertical-align: middle;
    margin-left: 12px;
    text-transform: none;
}
.tok-lede {
    font-family: var(--sans);
    font-size: clamp(17px, 2vw, 20px);
    line-height: 1.6;
    color: var(--muted);
    max-width: 62ch;
}
.tok-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 26px;
}
.tok-badge {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink);
    border: 1px solid var(--line);
    background: var(--panel);
    padding: 7px 11px;
}
.tok-badge::before {
    content: "✓";
    color: var(--accent);
    margin-right: 7px;
}
.tok-prelaunch {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-top: 26px;
    padding: 14px 16px;
    max-width: 60ch;
    border: 1px solid var(--line);
    background: rgba(0,0,0,0.025);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.55;
    color: var(--ink);
}
.tok-dot { width: 8px; height: 8px; margin-top: 7px; flex: 0 0 auto; background: var(--accent); border-radius: 50%; }
.tok-prelaunch strong { font-weight: 600; }

.tok-section {
    padding: clamp(26px, 4vh, 44px) 0;
    border-top: 1px solid var(--line);
}
.tok-h2 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(24px, 3vw, 34px);
    letter-spacing: -0.02em;
    margin: 0 0 22px;
}
.tok-grid {
    display: grid;
    grid-template-columns: minmax(150px, 190px) minmax(0, 1fr);
    gap: clamp(24px, 5vw, 60px);
    align-items: start;
}
.tok-sec-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    padding-top: 4px;
}
.tok-sec-body {
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.7;
    color: var(--ink);
    max-width: 64ch;
    display: flex;
    flex-direction: column;
    gap: 16px;
}
.tok-sec-body p { margin: 0; }
.tok-sec-body strong { font-weight: 600; }
.tok-sec-body a { color: var(--ink); border-bottom: 1px solid var(--accent); }
.tok-sec-body a:hover { color: var(--accent); }
.tok-note { color: var(--muted); font-size: 15px; }
.tok-inline-cta {
    align-self: flex-start;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    border-bottom: none !important;
    color: var(--accent) !important;
}

.tok-list, .tok-links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.tok-list li {
    position: relative;
    padding-left: 22px;
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink);
}
.tok-list li::before {
    content: "→";
    position: absolute;
    left: 0;
    color: var(--accent);
}
.tok-links li { font-family: var(--mono); font-size: 13px; }

/* Snapshot table */
.tok-snap {
    margin: 0;
    border: 1px solid var(--line);
    border-bottom: none;
    max-width: 760px;
}
.tok-snap-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
    gap: 16px;
    padding: 13px 16px;
    border-bottom: 1px solid var(--line);
    align-items: baseline;
}
.tok-snap-row dt {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0;
}
.tok-snap-row dd {
    margin: 0;
    font-family: var(--sans);
    font-size: 15px;
    color: var(--ink);
}
.tok-snap-row.is-good dd { font-weight: 600; }
.tok-snap-row.is-good dd::after {
    content: "✓";
    color: var(--accent);
    margin-left: 8px;
    font-weight: 400;
}
.tok-snap-row.is-warn dd::after {
    content: "!";
    display: inline-block;
    margin-left: 8px;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 50%;
    width: 15px;
    height: 15px;
    line-height: 14px;
    text-align: center;
    font-size: 10px;
    font-family: var(--mono);
}

/* Allocation bar */
.tok-alloc-bar {
    height: 38px;
    display: flex;
    border: 1px solid var(--line);
    background: var(--panel);
    overflow: hidden;
}
.tok-alloc-fill {
    background: var(--accent);
    color: var(--bg);
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    padding: 0 14px;
}
.tok-alloc-legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.tok-alloc-legend li {
    font-family: var(--sans);
    font-size: 14px;
    color: var(--ink);
    display: flex;
    align-items: baseline;
    gap: 10px;
}
.tok-pct {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--accent);
    min-width: 44px;
}
.tok-pct-zero { color: var(--muted); }

.tok-cta-section { border-top: 1px solid var(--line); }
.tok-cta { display: flex; flex-wrap: wrap; gap: 14px; }
.tok-cta .primary, .tok-cta .secondary {
    font-family: var(--mono);
    font-size: 13px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 12px 20px;
    border: 1px solid var(--ink);
}
.tok-cta .primary { background: var(--ink); color: var(--bg); }
.tok-cta .primary:hover { background: var(--accent); border-color: var(--accent); }
.tok-cta .secondary { color: var(--ink); }
.tok-cta .secondary:hover { background: var(--ink); color: var(--bg); }

@media (max-width: 760px) {
    .tok-grid { grid-template-columns: 1fr; gap: 10px; }
    .tok-snap-row { grid-template-columns: 1fr; gap: 4px; }
}
`;
