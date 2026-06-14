/* 111 token section (dark variant). Fee routing is rendered by the
   shared `<FeeBreakdown>` component. The routed breakdown is phase-
   independent: every leg routes the same way from block one (the protocol
   leg to PCController, the referral slice to the referrer on attributed
   swaps), so this component just renders the legs without re-deriving bps.
   Bps live in lib/fees.ts (single source of truth; they MUST match
   `Deploy.s.sol:_buildFactoryConfig`). */
import Link from 'next/link';
import {SwapBox} from './SwapBox';
import {FeeBreakdown} from './FeeBreakdown';
import {getTokenSymbol} from '@/lib/config';
import {FEES, fmtPct} from '@/lib/protocol-params';
import {getCurrentFeePhase} from '@/lib/server/fee-phase';

const TOKEN_SYMBOL = getTokenSymbol();

export async function TokenSection() {
    const phase = await getCurrentFeePhase();
    return (
        <section className="token-section" id="trade" aria-label={`${TOKEN_SYMBOL} token`}>
            <div className="wrap token-grid">
                <div className="token-header">
                    <div className="kicker">{TOKEN_SYMBOL}</div>
                    <h2 className="section-title">The artcoin for Permanent Collection.</h2>
                </div>
                <div className="swap-side">
                    <SwapBox />
                </div>
                <div className="token-body">
                    <p className="token-copy">
                        Official {TOKEN_SYMBOL} trading feeds the live bid, funds {TOKEN_SYMBOL}
                        burns, and backs the artcoins protocol leg that supports PC&apos;s treasury +
                        the artcoins LAYER burn. Up to {fmtPct(FEES.referralCapPct)} of volume
                        can route to a referrer if a swap carries attribution.
                    </p>
                    <p className="token-copy">
                        The tokenURI renders the live state of the collection. As the protocol runs, the artwork
                        updates.
                    </p>
                    <p className="token-copy">
                        {TOKEN_SYMBOL} is the ownable token for the work. It does not redeem for
                        vaulted Punks and does not control the vault.
                    </p>
                    <div className="fee-box">
                        <FeeBreakdown phase={phase} variant="compact" surface="dark" collapsible showPhaseLabel={false} />
                    </div>
                    <p className="fee-note">
                        Only the official pool feeds the protocol.{' '}
                        <Link href="/trade" className="fee-note-link">
                            Open full trade page →
                        </Link>
                    </p>
                </div>
            </div>
            <style>{styles}</style>
        </section>
    );
}

const styles = `
.token-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 0.9fr);
    grid-template-areas:
        "header swap"
        "body   swap";
    column-gap: clamp(34px, 6vw, 88px);
    row-gap: 0;
    align-items: start;
}
.token-header {
    grid-area: header;
    min-width: 0;
}
.token-body {
    grid-area: body;
    min-width: 0;
}
.swap-side {
    grid-area: swap;
    min-width: 0;
    /* The SwapBox brings its own light surface — by design it pops against
       the dark token section like a card on a stage. */
    align-self: start;
}
.token-header .section-title {
    overflow-wrap: anywhere;
}
.token-copy {
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.7;
    max-width: 570px;
    margin-bottom: 18px;
    color: #C8C8C8;
}
.fee-box {
    margin-top: 26px;
    border: 1px solid #3A3A3A;
    background: #1A1A1A;
    /* The collapsible breakdown inside carries its own padding so its
       whole strip is the click target. */
    padding: 0;
}
.fee-note {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: #9A9A9A;
    margin: 14px 0 0;
}
.fee-note-link {
    color: var(--bg);
    text-decoration: underline;
    text-underline-offset: 3px;
    margin-left: 4px;
}
.fee-note-link:hover {
    color: var(--accent);
}
@media (max-width: 980px) {
    .token-grid {
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas:
            "header"
            "swap"
            "body";
        row-gap: 32px;
    }
}
`;
