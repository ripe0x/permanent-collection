import type {Metadata} from 'next';

import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {getTokenSymbol} from '@/lib/config';
import {buildMeta} from '@/lib/meta';
import {FEES, fmtPct} from '@/lib/protocol-params';

/** Baseline-skim sub-splits as whole-number percentages of the skim,
 *  derived from the config so they can't drift from `FEES`. */
const BID_SHARE_OF_SKIM_PCT = Math.round((FEES.bidLegPct / FEES.baselineSkimPct) * 100);
const PROTOCOL_SHARE_OF_SKIM_PCT = Math.round((FEES.protocolLegPct / FEES.baselineSkimPct) * 100);

const TOKEN_SYMBOL = getTokenSymbol();

// The root layout injects request-time runtime config and is `force-dynamic`;
// a `force-static` child would conflict. This page also renders Header/Footer,
// which gate on `isProtocolLive()`, so rendering per request keeps its launch
// state correct after a no-rebuild launch flip.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = buildMeta({
    title: 'Builders',
    description:
        'Compose with Permanent Collection. Attribution, referrals, and future on-chain extensions.',
    path: '/builders',
});

export default function BuildersPage() {
    return (
        <>
            <Header />
            <main id="top">
                <section className="builders-page">
                    <div className="wrap">
                        <div className="kicker">For builders</div>
                        <h1 className="section-title">Build on Permanent Collection.</h1>
                        <p className="section-copy">
                            The official {TOKEN_SYMBOL} pool is a composable host. Anyone can route swaps
                            through it, get credit on-chain, and earn a small builder fee — without
                            forking liquidity, without weakening the core, without permission.
                        </p>

                        <div className="card-grid">
                            <article className="card">
                                <h3>Attribution</h3>
                                <p>
                                    Every swap can carry a <code>sourceId</code> and{' '}
                                    <code>referrer</code> field via <code>hookData</code>. The
                                    official hook emits a <code>SwapAttribution</code> event for
                                    every attributed swap. Permissionless, live from day one.
                                </p>
                            </article>
                            <article className="card">
                                <h3>Referral fee</h3>
                                <p>
                                    Up to <strong>0.25% of swap volume</strong> can flow to the{' '}
                                    <code>referrer</code> on every attributed swap. The payment comes
                                    exclusively from the protocol slice; live-bid funding stays{' '}
                                    <em>structurally</em> untouched.
                                </p>
                            </article>
                        </div>

                        <h2 className="section-heading">The three-leg fee split</h2>
                        <p className="section-copy">
                            Every swap takes a {fmtPct(FEES.baselineSkimPct)} baseline skim. The hook
                            splits it at swap time into three legs. The math is enforced on-chain:{' '}
                            <em>no path</em> exists for a referral payment to reduce live-bid funding.
                        </p>

                        <div className="leg-grid">
                            <div className="leg leg-bounty">
                                <span className="leg-pct">{FEES.bidLegPct.toFixed(2)}%</span>
                                <span className="leg-name">of volume</span>
                                <span className="leg-target">→ Patron (live bid)</span>
                                <span className="leg-note">{BID_SHARE_OF_SKIM_PCT}% of skim</span>
                            </div>
                            <div className="leg leg-protocol">
                                <span className="leg-pct">≤ {FEES.protocolLegPct.toFixed(2)}%</span>
                                <span className="leg-name">of volume</span>
                                <span className="leg-target">→ Protocol controller</span>
                                <span className="leg-note">
                                    {PROTOCOL_SHARE_OF_SKIM_PCT}% of skim, minus any referral
                                </span>
                            </div>
                            <div className="leg leg-referral">
                                <span className="leg-pct">≤ {fmtPct(FEES.referralCapPct)}</span>
                                <span className="leg-name">of volume</span>
                                <span className="leg-target">→ ReferralPayout (your address)</span>
                                <span className="leg-note">paid from the protocol slice only</span>
                            </div>
                        </div>

                        <h2 className="section-heading">Quick start — frontend integration</h2>
                        <p className="section-copy">
                            Pass attribution data as the <code>hookData</code> argument of any
                            Uniswap V4 swap on the {TOKEN_SYMBOL} pool. Bad encoding falls through — the
                            swap never reverts on malformed hookData.
                        </p>

                        <pre className="code-block">
                            <code>{`import { encodeAbiParameters } from "viem";

// Both envelopes are encoded as 1-tuple structs (not 2-tuples of
// bytes). The hook decodes the OUTER bytes as
// \`abi.decode(swapData, (PoolSwapData))\` — a single struct argument.
// Encoding as a 2-tuple silently fails to decode and attribution is
// treated as empty.

const pcSwapData = encodeAbiParameters(
  [
    {
      type: "tuple",
      components: [
        {
          name: "attribution",
          type: "tuple",
          components: [
            { name: "sourceId",    type: "bytes32" },
            { name: "referrer",    type: "address" },
            { name: "campaignId",  type: "bytes16" },
            { name: "referralBps", type: "uint24"  },
          ],
        },
        { name: "extensionPayload", type: "bytes" },
      ],
    },
  ],
  [
    {
      attribution: {
        sourceId:    "0x...32-byte builder id...",
        referrer:    "0xYourPayoutAddress",
        campaignId:  "0x...16-byte campaign id (or zeros)...",
        referralBps: 250, // 0.25% of volume — clamped at the hook
      },
      extensionPayload: "0x", // reserved for future use
    },
  ],
);

const hookData = encodeAbiParameters(
  [
    {
      type: "tuple",
      components: [
        { name: "mevModuleSwapData",     type: "bytes" },
        { name: "poolExtensionSwapData", type: "bytes" },
      ],
    },
  ],
  [{ mevModuleSwapData: "0x", poolExtensionSwapData: pcSwapData }],
);

// Pass \`hookData\` as the final argument of your V4 swap call.`}</code>
                        </pre>

                        <h2 className="section-heading">Claiming referral payouts</h2>
                        <p className="section-copy">
                            Referrals land in <code>ReferralPayout</code> within the same tx as
                            the attributed swap — the hook flushes the credited referrer&apos;s
                            accrual at the end of <code>_afterSwap</code>. No separate flush
                            call is needed in normal operation; the balance is immediately
                            claimable.
                        </p>

                        <pre className="code-block">
                            <code>{`// View balance any time — populated by the credited swap
const owed = await referralPayout.balances(referrerAddress);

// Claim — by the referrer, or by anyone on the referrer's behalf
referralPayout.claim();                 // pulls msg.sender's balance
referralPayout.claimFor(referrerAddr);  // sends balance to referrerAddr

// There are no hook-side retry hatches: the hook flushes each swap's
// referral fresh inside _afterSwap and holds no balance between swaps.
// If a payout ever fails (reverting recipient / out of gas) the hook
// folds that swap's slice back into the protocol leg, nothing to retry.`}</code>
                        </pre>

                        <h2 className="section-heading">Events to index</h2>
                        <pre className="code-block">
                            <code>{`event SwapAttribution(
    PoolId  indexed poolId,
    address indexed swapper,
    address indexed referrer,
    bytes32 sourceId,
    bytes16 campaignId,
    uint256 quoteVolume,
    uint256 referralPaid
);

event SkimSplit(
    PoolId indexed poolId,
    uint256 quoteVolume,
    uint256 bountyAmount,
    uint256 protocolNet,
    uint256 referralPaid
);

event ReferralCredited (address indexed referrer, uint256 amount);
event ReferralClaimed  (address indexed referrer, uint256 amount);`}</code>
                        </pre>

                        <h2 className="section-heading">What&apos;s locked vs. configurable</h2>
                        <div className="lock-grid">
                            <div className="lock-col">
                                <h4>🔒 Locked forever</h4>
                                <ul>
                                    <li>Baseline skim: {fmtPct(FEES.baselineSkimPct)}</li>
                                    <li>Live-bid leg: {BID_SHARE_OF_SKIM_PCT}% of skim</li>
                                    <li>Max referral: {fmtPct(FEES.referralCapPct)} of volume</li>
                                    <li>Live-bid invariance</li>
                                    <li>Referral pulled from the protocol leg only</li>
                                    <li>Permanent vault Punk immobility</li>
                                </ul>
                            </div>
                            <div className="lock-col">
                                <h4>🔓 Configurable (until 1y lock)</h4>
                                <ul>
                                    <li>Adapter throttle parameters</li>
                                    <li>Finder fee caps</li>
                                    <li>Seller allowlist (no lock — forever)</li>
                                    <li>Burn-step pacing</li>
                                    <li>Extension binding (one-shot, then lockable)</li>
                                </ul>
                            </div>
                        </div>

                        <h2 className="section-heading">The invariant, in plain code</h2>
                        <p className="section-copy">
                            For every swap S on the {TOKEN_SYMBOL} pool:
                        </p>
                        <pre className="code-block invariant">
                            <code>{`bountyInflow(S)     ==  volume(S) × ${fmtPct(FEES.bidLegPct)}   +  antiSniperExtra(S)
protocolInflow(S)
  +  referralPaid(S) ==  volume(S) × ${fmtPct(FEES.protocolLegPct)}

referralPaid(S)     <=  volume(S) × min(hookData.referralBps, ${FEES.referralCapBpsOfVolume}) / 100_000
referralPaid(S)     ==  0   if  no referrer is attributed (stays in protocol leg)`}</code>
                        </pre>

                        <h2 className="section-heading">Source</h2>
                        <p className="section-copy">
                            Everything this page summarizes is open source under MIT: the
                            contracts, the deploy scripts, the fork-test suite, and the full
                            builder spec.
                        </p>
                        <ul className="resource-list">
                            <li>
                                <a
                                    href="https://github.com/ripe0x/permanent-collection"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    github.com/ripe0x/permanent-collection
                                </a>
                                : the protocol contracts, ABIs, and{' '}
                                <code>docs/COMPOSABILITY.md</code> (the full builder spec this
                                page summarizes)
                            </li>
                            <li>
                                <a
                                    href="https://github.com/ripe0x/artcoins"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    github.com/ripe0x/artcoins
                                </a>
                                : the artcoins launcher the pool runs on, including the V4 skim
                                hook (<code>ArtCoinsHookSkimFee</code>), factory, and lockers
                            </li>
                        </ul>

                    </div>
                </section>
            </main>
            <Footer />
            <style>{styles}</style>
        </>
    );
}

const styles = `
.builders-page {
    padding-top: clamp(60px, 9vh, 100px);
    padding-bottom: clamp(80px, 12vh, 160px);
    border-top: none;
}
.builders-page .wrap {
    display: flex;
    flex-direction: column;
    gap: 32px;
    max-width: 980px;
    margin: 0 auto;
    padding: 0 24px;
}
.builders-page .section-copy {
    max-width: 64ch;
    line-height: 1.6;
}
.builders-page .section-heading {
    margin-top: 24px;
    font-size: 22px;
    font-weight: 600;
}
.builders-page code {
    background: rgba(0, 0, 0, 0.05);
    padding: 1px 6px;
    font-size: 0.92em;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.builders-page .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 16px;
    margin-top: 8px;
}
.builders-page .card {
    border: 1px solid rgba(0, 0, 0, 0.12);
    padding: 18px;
    background: rgba(0, 0, 0, 0.015);
}
.builders-page .card h3 {
    margin: 0 0 8px;
    font-size: 16px;
    font-weight: 600;
}
.builders-page .card p {
    margin: 0;
    line-height: 1.5;
    font-size: 14.5px;
}
.builders-page .leg-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    margin-top: 8px;
}
.builders-page .leg {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 16px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    background: rgba(0, 0, 0, 0.015);
}
.builders-page .leg-pct {
    font-size: 26px;
    font-weight: 700;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.builders-page .leg-name {
    font-size: 13px;
    opacity: 0.7;
}
.builders-page .leg-target {
    font-size: 14.5px;
    font-weight: 500;
    margin-top: 6px;
}
.builders-page .leg-note {
    font-size: 12px;
    opacity: 0.6;
}
.builders-page .leg-bounty   { background: rgba(255, 220, 100, 0.16); }
.builders-page .leg-vault    { background: rgba(150, 200, 220, 0.16); }
.builders-page .leg-protocol { background: rgba(140, 200, 140, 0.16); }
.builders-page .leg-referral { background: rgba(200, 140, 220, 0.16); }
.builders-page .code-block {
    background: #0e1116;
    color: #e1e7ef;
    padding: 16px 18px;
    overflow-x: auto;
    font-size: 13px;
    line-height: 1.55;
}
.builders-page .code-block.invariant {
    background: #0e1a16;
    color: #d4f0d4;
}
.builders-page .code-block code {
    background: none;
    padding: 0;
    color: inherit;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.builders-page .lock-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
}
@media (max-width: 640px) {
    .builders-page .lock-grid {
        grid-template-columns: 1fr;
    }
}
.builders-page .lock-col h4 {
    margin: 0 0 8px;
    font-size: 15px;
    font-weight: 600;
}
.builders-page .lock-col ul {
    margin: 0;
    padding-left: 20px;
    line-height: 1.6;
}
.builders-page .lock-col li {
    font-size: 14px;
}
.builders-page .resource-list {
    margin: 0;
    padding-left: 0;
    list-style: none;
    line-height: 1.8;
}
.builders-page .resource-list a {
    text-decoration: underline;
    color: inherit;
}
`;
