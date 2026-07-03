/* Expanded footer. Server component that reads protocol state so the
   "Current state" panel stays current. Two column groups on desktop:
   navigation links + Current state. Fee routing lives in dedicated UI
   surfaces (/trade, the homepage TokenSection, the about page) where
   it's phase-aware via the FeeBreakdown component — keeping it out of
   the footer avoids stale "1.00% protocol" everywhere on the site.
   Collapses to single column on mobile.

   Pre-launch (before the protocol is live — `isProtocolLive()` false, i.e.
   no token address configured yet) renders a slimmed variant: brand + nav +
   artcoins link, no chain-read panel (there are no contract addresses to read
   yet). */
import Link from 'next/link';
import {LiveBidPending, LiveBidStat} from '@/components/LiveBidStat';
import {DexscreenerLink} from '@/components/DexscreenerLink';
import {FooterColophon} from '@/components/FooterColophon';
import {getContractAddresses, getTokenTicker, isProtocolLive} from '@/lib/config';
import {getDataAdapter} from '@/lib/data';

const TOKEN_SYMBOL = getTokenTicker();

export async function Footer() {
    // Pre-deploy: the slim footer (no contract-address links to render yet).
    if (!isProtocolLive()) return <PreLaunchFooter />;

    const adapter = getDataAdapter();
    // Best-effort. If the indexer is down, the footer should still render
    // — the alternative is every page in the app 500's because of a
    // sub-component dependency.
    const [state, auctions] = await Promise.all([
        adapter.getProtocolState().catch(() => null),
        adapter.getActiveAuctions().catch(() => null),
    ]);
    const auctionCount = auctions?.length ?? null;
    const {token} = getContractAddresses();
    return (
        <footer className="footer">
            <div className="footer-inner">
                <div className="footer-cols">
                    <div className="footer-brand">Permanent Collection</div>

                    <div className="footer-group">
                        <Link href="/collection">Collection</Link>
                        <Link href="/proofs">Proofs</Link>
                        <Link href="/auction">Auctions</Link>
                        <Link href="/bid">Accept the bid</Link>
                        <Link href="/trade">Trade {TOKEN_SYMBOL}</Link>
                        <Link href="/token">{TOKEN_SYMBOL} token</Link>
                        <Link href="/about">About</Link>
                        <Link href="/faq">FAQ</Link>
                        <Link href="/protocol">Protocol</Link>
                        <Link href="/docs">Docs</Link>
                        <Link href="/docs/introduction/addresses">Contracts</Link>
                        <Link href="/builders">Builders</Link>
                        <Link href="/stats">Stats</Link>
                        <DexscreenerLink token={token} />
                        <a href="https://artcoins.art" target="_blank" rel="noreferrer">
                            artcoins
                        </a>
                        <a
                            href="https://github.com/ripe0x/permanent-collection"
                            target="_blank"
                            rel="noreferrer"
                        >
                            GitHub
                        </a>
                    </div>

                    <div className="footer-group">
                        <div className="footer-title">Current state</div>
                        <div className="footer-line tnum footer-live-bid">
                            {state ? (
                                <>
                                    <LiveBidStat
                                        initialWei={state.liveBidWei.toString()}
                                        valueClassName="tnum"
                                    />{' '}
                                    live bid
                                    <LiveBidPending
                                        initialWei={state.liveBidPendingWei.toString()}
                                    />
                                </>
                            ) : (
                                '— live bid'
                            )}
                        </div>
                        <div className="footer-line tnum">
                            {state ? `${state.collectedCount} permanent traits` : '— permanent traits'}
                        </div>
                        <div className="footer-line tnum">
                            {auctionCount !== null
                                ? `${auctionCount} active return ${auctionCount === 1 ? 'auction' : 'auctions'}`
                                : '— active return auctions'}
                        </div>
                    </div>

                    <FooterColophon token={token} />
                </div>
            </div>
            <style>{styles}</style>
        </footer>
    );
}

function PreLaunchFooter() {
    return (
        <footer className="footer">
            <div className="footer-inner footer-inner-prelaunch">
                <div className="footer-cols">
                    <div className="footer-brand">Permanent Collection</div>

                    <div className="footer-group">
                        <Link href="/">Landing</Link>
                        <Link href="/about">About</Link>
                        <Link href="/collection">Collection</Link>
                        <Link href="/proofs">Proofs</Link>
                        <Link href="/token">Token</Link>
                        <Link href="/protocol">Protocol</Link>
                        <Link href="/docs">Docs</Link>
                        <a href="https://artcoins.art" target="_blank" rel="noreferrer">
                            artcoins
                        </a>
                        <a
                            href="https://github.com/ripe0x/permanent-collection"
                            target="_blank"
                            rel="noreferrer"
                        >
                            GitHub
                        </a>
                    </div>

                    <div className="footer-group">
                        <div className="footer-title">Not launched yet</div>
                        <div className="footer-line">
                            Contracts aren&apos;t deployed yet. Numbers and grids on this site are
                            offchain placeholders.
                        </div>
                    </div>

                    <FooterColophon />
                </div>
            </div>
            <style>{styles}</style>
        </footer>
    );
}

const styles = `
.footer {
    /* Horizontal padding lives on .footer-inner (mirroring the header inner /
       .wrap) so the footer content edges line up with the header content
       edges. Keeping it on .footer too would double the inset and make the
       footer columns narrower than the header. */
    padding: 56px 0 44px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.footer-inner {
    max-width: var(--max-wide);
    margin: 0 auto;
    padding: 0 var(--pad);
}
/* The grid + top rule live on an inner element INSIDE the padding so the
   rule spans exactly the content width (the columns), not the full padded
   inner — otherwise the line overhangs the content by one --pad each side. */
.footer-cols {
    display: grid;
    grid-template-columns: 1.1fr 1fr 1fr;
    gap: 36px;
    align-items: start;
    border-top: 1px solid var(--line);
    padding-top: 34px;
}
.footer-brand {
    color: var(--ink);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-size: 12px;
}
.footer-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.footer-title {
    color: var(--ink);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-size: 11px;
    margin-bottom: 4px;
}
.footer-group a {
    color: var(--muted);
    transition: color 120ms ease;
}
.footer-group a:hover {
    color: var(--ink);
}
.footer-line {
    line-height: 1.45;
}
@media (max-width: 900px) {
    .footer-cols {
        grid-template-columns: 1fr 1fr;
    }
}
@media (max-width: 560px) {
    .footer-cols {
        grid-template-columns: 1fr;
    }
}
`;
