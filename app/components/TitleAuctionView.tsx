'use client';

/* Vault Title Auction page (`/title`).

   The Title is a one-of-one ERC721 (PunkVault tokenId 111) that becomes
   transferable via a permissionless english auction once the protocol has
   collected at least `KICKOFF_THRESHOLD` traits (22 on launch; see
   PunkVaultTitleAuction.sol). The auction loops indefinitely on
   no-bidder settles — never strands the Title.

   Phases this view handles:
     - pre-threshold     : awaiting threshold. Single explanatory line.
     - kickoff-ready     : threshold met. Permissionless "Start the auction" CTA.
     - live              : countdown, current high, bid composer, bid history.
     - settleable        : same as live, but bidding closed and a "Call settle"
                           CTA visible (cleared if a bid exists; restart
                           otherwise — both run via the same `settle()`).
     - settled           : winner display, final price, proceeds claim panel
                           for Patron + payoutRecipient.
     - not-deployed      : env var missing — surface a soft "not deployed yet"
                           rather than crashing the page.

   The pre-threshold state is intentionally minimal (per user direction —
   no live progress meter, no kickoff teasers); all other states get the
   full layout. */

import Link from 'next/link';
import {useState} from 'react';
import {AuctionCountdown} from './AuctionCountdown';
import {TitleBidPanel} from './TitleBidPanel';
import {TitleBidHistory} from './TitleBidHistory';
import {useTitleAuctionActions} from './useTitleAuctionActions';
import {ConnectButton} from './ConnectButton';
import {formatEth, getEvmNowAddressUrl, getEvmNowTxUrl, shortAddress} from '@/lib/format';
import type {Address} from '@/lib/data/types';
import {COLLECTION, TITLE} from '@/lib/protocol-params';

interface Wire {
    phase:
        | 'not-deployed'
        | 'pre-threshold'
        | 'kickoff-ready'
        | 'live'
        | 'settleable'
        | 'settled';
    collectedCount: number;
    isKickoffReady: boolean;
    isLive: boolean;
    isSettleable: boolean;
    kickedOff: boolean;
    settled: boolean;
    endsAt: string;
    highBidWei: string;
    highBidder?: string;
    minNextBidWei: string;
    restartCount: number;
    extensionsThisRound: number;
    pendingProceedsByAddr: {patron: string; payoutRecipient: string};
    patronAddr: string;
    payoutRecipientAddr: string;
    pendingRefundForCaller?: string;
}

interface BidWire {
    bidder: string;
    amount: string;
    endsAt: string;
    extended: boolean;
    blockNumber: string;
    timestamp: string;
    txHash: string;
}

interface Props {
    state: Wire;
    bids: BidWire[];
    nowSeconds: string;
    chainId: number;
    titleAuctionAddr?: string;
    titleSvg?: string | null;
}

export function TitleAuctionView({state, bids, nowSeconds, chainId, titleAuctionAddr, titleSvg}: Props) {
    const titleAuction = titleAuctionAddr as Address | undefined;
    const actions = useTitleAuctionActions(titleAuction);

    // ───── pre-threshold (and not-deployed) — the one-liner-only state ─────
    if (state.phase === 'pre-threshold' || state.phase === 'not-deployed') {
        return (
            <section className="title-page title-page-quiet">
                <div className="wrap title-quiet-wrap">
                    <div className="kicker">The Title</div>
                    <h1 className="title-quiet-headline">
                        The Title unlocks once the protocol has collected its first{' '}
                        {TITLE.kickoffThreshold} traits.
                    </h1>
                    <p className="title-quiet-copy">
                        A one-of-one ERC-721 — the role-of-record for the vaulted Punks —
                        becomes auctionable once {TITLE.kickoffThreshold} of{' '}
                        {COLLECTION.totalTraits} traits are permanently collected. Until then
                        there is nothing to bid on.
                    </p>
                    <div className="title-quiet-actions">
                        <Link className="secondary" href="/">
                            Back to home
                        </Link>
                        <Link className="secondary" href="/collection">
                            Browse traits
                        </Link>
                    </div>
                </div>
                <style>{styles}</style>
            </section>
        );
    }

    // ───── full layout (kickoff-ready, live, settleable, settled) ─────
    const endsAt = BigInt(state.endsAt);
    const now = BigInt(nowSeconds);
    const highBidWei = BigInt(state.highBidWei);
    const minNextBidWei = BigInt(state.minNextBidWei);
    const payoutPending = BigInt(state.pendingProceedsByAddr.payoutRecipient);
    const refundForCaller =
        state.pendingRefundForCaller !== undefined ? BigInt(state.pendingRefundForCaller) : 0n;
    const hasHigh = highBidWei > 0n;

    return (
        <section className="title-page">
            <div className="wrap title-grid">
                <div className="title-art-col">
                    <div
                        className="title-art"
                        role="img"
                        aria-label="The Title — PunkVault token 111. Same on-chain mosaic that records the permanent collection's state."
                    >
                        {titleSvg ? (
                            <div
                                className="title-art-svg"
                                // SVG comes from our own on-chain renderer (tokenURI(111)); safe to inline.
                                dangerouslySetInnerHTML={{__html: titleSvg}}
                            />
                        ) : (
                            <TitleArtFallback />
                        )}
                    </div>
                    <dl className="title-meta">
                        <div className="title-meta-row">
                            <dt>Token id</dt>
                            <dd>PunkVault #111 (Title)</dd>
                        </div>
                        <div className="title-meta-row">
                            <dt>Collected so far</dt>
                            <dd className="tnum">{state.collectedCount} / 111</dd>
                        </div>
                        <div className="title-meta-row">
                            <dt>Round</dt>
                            <dd className="tnum">
                                #{state.restartCount + 1}
                                {state.restartCount > 0 && (
                                    <span className="title-meta-tag">no-bid restart</span>
                                )}
                            </dd>
                        </div>
                        <div className="title-meta-row">
                            <dt>Extensions this round</dt>
                            <dd className="tnum">{state.extensionsThisRound}</dd>
                        </div>
                        <div className="title-meta-row">
                            <dt>Payout (100%)</dt>
                            <dd>
                                <a
                                    href={getEvmNowAddressUrl(state.payoutRecipientAddr, chainId)}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {shortAddress(state.payoutRecipientAddr)}
                                </a>
                            </dd>
                        </div>
                    </dl>
                </div>

                <div className="title-sidebar">
                    <div className="title-headline">
                        <div className="kicker">The Title · vault tokenId 111</div>
                        <h1 className="title-h1">The Title is for sale.</h1>
                        <PhaseHint state={state} />
                    </div>

                    {state.phase === 'kickoff-ready' && (
                        <KickoffPanel
                            connected={actions.connected}
                            onKickoff={actions.kickoff}
                            phase={actions.phase}
                            chainId={chainId}
                        />
                    )}

                    {(state.phase === 'live' || state.phase === 'settleable') && (
                        <>
                            <AuctionCountdown endsAt={endsAt} nowSecondsInitial={now} />
                            <div className="title-stat-grid">
                                <Stat
                                    label={hasHigh ? 'current bid' : 'no bid yet'}
                                    value={hasHigh ? formatEth(highBidWei) : '—'}
                                    primary
                                />
                                <Stat
                                    label="high bidder"
                                    value={
                                        state.highBidder ? shortAddress(state.highBidder) : '—'
                                    }
                                />
                            </div>
                            <TitleBidPanel
                                minNextBidWei={minNextBidWei}
                                closed={state.phase === 'settleable'}
                                hasHigh={hasHigh}
                            />
                            {state.phase === 'settleable' && (
                                <SettlePanel
                                    hasHigh={hasHigh}
                                    onSettle={actions.settle}
                                    connected={actions.connected}
                                    phase={actions.phase}
                                    chainId={chainId}
                                />
                            )}
                        </>
                    )}

                    {state.phase === 'settled' && (
                        <SettledPanel
                            state={state}
                            chainId={chainId}
                            payoutPending={payoutPending}
                            onWithdraw={actions.withdrawProceeds}
                            actionPhase={actions.phase}
                        />
                    )}

                    <RefundPanel
                        refundWei={refundForCaller}
                        connected={actions.connected}
                        phase={actions.phase}
                        onWithdraw={actions.withdrawRefund}
                        chainId={chainId}
                    />

                    <TitleBidHistory initial={bids} chainId={chainId} />
                </div>
            </div>
            <style>{styles}</style>
        </section>
    );
}

function PhaseHint({state}: {state: Wire}) {
    if (state.phase === 'kickoff-ready') {
        return (
            <p className="title-sub">
                The collection has passed {TITLE.kickoffThreshold} permanent traits. The
                Title can now be auctioned — anyone can start it.
            </p>
        );
    }
    if (state.phase === 'live') {
        return (
            <p className="title-sub">
                A {TITLE.durationHours}-hour english auction. 100% of proceeds go to the
                immutable payout address; the live bid receives nothing from the Title.
                No reserve; each new bid must be at least {TITLE.minIncreasePct}% above the
                current high.
            </p>
        );
    }
    if (state.phase === 'settleable' && state.highBidder) {
        return (
            <p className="title-sub">
                Bidding window closed. Anyone can now finalize the sale to the high
                bidder.
            </p>
        );
    }
    if (state.phase === 'settleable') {
        return (
            <p className="title-sub">
                No bids in this round. Calling settle restarts the auction for another
                {' '}{TITLE.durationHours} hours — the Title can&apos;t be stranded.
            </p>
        );
    }
    if (state.phase === 'settled') {
        return (
            <p className="title-sub">
                The Title has been sold and transferred to the winner. The payout address
                can pull the proceeds.
            </p>
        );
    }
    return null;
}

function Stat({
    label,
    value,
    primary,
}: {
    label: string;
    value: string;
    primary?: boolean;
}) {
    return (
        <div className={`title-stat ${primary ? 'title-stat-primary' : ''}`}>
            <span className="title-stat-label">{label}</span>
            <strong className="title-stat-value tnum">{value}</strong>
        </div>
    );
}

function KickoffPanel({
    connected,
    onKickoff,
    phase,
    chainId,
}: {
    connected: boolean;
    onKickoff: () => Promise<void>;
    phase: ReturnType<typeof useTitleAuctionActions>['phase'];
    chainId: number;
}) {
    const inFlight =
        phase.kind === 'wallet' ||
        phase.kind === 'submitted' ||
        phase.kind === 'confirming';
    const isKickoffPhase = 'action' in phase && phase.action === 'kickoff';
    return (
        <aside className="title-action-panel" aria-label="Start the Title Auction">
            <h2 className="title-action-title">Start the auction.</h2>
            <p className="title-action-copy">
                The threshold (≥{TITLE.kickoffThreshold} traits collected) is met. Calling
                kickoff mints the Title to the auction contract and starts a{' '}
                {TITLE.durationHours}-hour clock. Permissionless — anyone, no fee.
            </p>
            <button
                type="button"
                className="primary title-action-cta"
                onClick={onKickoff}
                disabled={!connected || inFlight}
            >
                {inFlight && isKickoffPhase
                    ? phase.kind === 'wallet'
                        ? 'Confirm in wallet…'
                        : phase.kind === 'submitted'
                          ? 'Submitting…'
                          : 'Confirming…'
                    : 'Start the Title Auction'}
            </button>
            <ActionStateLine phase={phase} chainId={chainId} forAction="kickoff" />
            {!connected && (
                <span className="title-action-connect">
                    Connect a wallet to call kickoff. <ConnectButton />
                </span>
            )}
            <style>{actionStyles}</style>
        </aside>
    );
}

function SettlePanel({
    hasHigh,
    onSettle,
    connected,
    phase,
    chainId,
}: {
    hasHigh: boolean;
    onSettle: () => Promise<void>;
    connected: boolean;
    phase: ReturnType<typeof useTitleAuctionActions>['phase'];
    chainId: number;
}) {
    const inFlight =
        phase.kind === 'wallet' ||
        phase.kind === 'submitted' ||
        phase.kind === 'confirming';
    const isSettlePhase = 'action' in phase && phase.action === 'settle';
    return (
        <aside className="title-action-panel" aria-label="Settle the auction">
            <h2 className="title-action-title">
                {hasHigh ? 'Finalize the sale.' : 'Restart the auction.'}
            </h2>
            <p className="title-action-copy">
                {hasHigh
                    ? 'Transfers the Title to the high bidder and credits the payout address for pull.'
                    : `Restarts the auction for another ${TITLE.durationHours}-hour round. The Title is never stranded — the auction loops indefinitely until someone bids.`}{' '}
                Permissionless — anyone can call settle.
            </p>
            <button
                type="button"
                className="primary title-action-cta"
                onClick={onSettle}
                disabled={!connected || inFlight}
            >
                {inFlight && isSettlePhase
                    ? phase.kind === 'wallet'
                        ? 'Confirm in wallet…'
                        : phase.kind === 'submitted'
                          ? 'Submitting…'
                          : 'Confirming…'
                    : 'Call settle()'}
            </button>
            <ActionStateLine phase={phase} chainId={chainId} forAction="settle" />
            {!connected && (
                <span className="title-action-connect">
                    Connect a wallet to call settle. <ConnectButton />
                </span>
            )}
            <style>{actionStyles}</style>
        </aside>
    );
}

function SettledPanel({
    state,
    chainId,
    payoutPending,
    onWithdraw,
    actionPhase,
}: {
    state: Wire;
    chainId: number;
    payoutPending: bigint;
    onWithdraw: (recipient: Address) => Promise<void>;
    actionPhase: ReturnType<typeof useTitleAuctionActions>['phase'];
}) {
    const highBidWei = BigInt(state.highBidWei);
    const [pulling, setPulling] = useState(false);
    const inFlight =
        actionPhase.kind === 'wallet' ||
        actionPhase.kind === 'submitted' ||
        actionPhase.kind === 'confirming';

    async function pull() {
        setPulling(true);
        await onWithdraw(state.payoutRecipientAddr as Address);
        setPulling(false);
    }

    return (
        <aside className="title-action-panel" aria-label="Settled">
            <h2 className="title-action-title">Sold.</h2>
            <p className="title-action-copy">
                Final price <strong className="tnum">{formatEth(highBidWei)}</strong> ·
                winner{' '}
                <a
                    href={getEvmNowAddressUrl(state.highBidder ?? '0x', chainId)}
                    target="_blank"
                    rel="noreferrer"
                >
                    {state.highBidder ? shortAddress(state.highBidder) : '—'}
                </a>
                . The Title NFT is now in the winner&apos;s wallet.
            </p>
            <div className="title-proceeds">
                <ProceedsRow
                    label="Payout (100%)"
                    addr={state.payoutRecipientAddr}
                    pending={payoutPending}
                    onClaim={pull}
                    chainId={chainId}
                    disabled={inFlight || payoutPending === 0n}
                />
            </div>
            <p className="title-action-copy title-action-quiet">
                Anyone can trigger the pull — proceeds always land at the credited
                payout address. The contract never pushes ETH on settle (audit F10), so a
                non-payable recipient can&apos;t brick the title transfer.
            </p>
            <ActionStateLine
                phase={actionPhase}
                chainId={chainId}
                forAction="withdrawProceeds"
            />
            {pulling && actionPhase.kind === 'idle' && (
                <span className="title-action-hint">Sent to wallet…</span>
            )}
            <style>{actionStyles}</style>
        </aside>
    );
}

function ProceedsRow({
    label,
    addr,
    pending,
    onClaim,
    chainId,
    disabled,
}: {
    label: string;
    addr: string;
    pending: bigint;
    onClaim: () => Promise<void>;
    chainId: number;
    disabled: boolean;
}) {
    return (
        <div className="title-proceeds-row">
            <div className="title-proceeds-meta">
                <span className="title-proceeds-label">{label}</span>
                <a
                    className="title-proceeds-addr"
                    href={getEvmNowAddressUrl(addr, chainId)}
                    target="_blank"
                    rel="noreferrer"
                >
                    {shortAddress(addr)}
                </a>
            </div>
            <div className="title-proceeds-amount tnum">
                {pending > 0n ? formatEth(pending) : '0 ETH'}
            </div>
            <button
                type="button"
                className="secondary title-proceeds-claim"
                disabled={disabled}
                onClick={onClaim}
            >
                {pending === 0n ? 'Claimed' : 'Claim'}
            </button>
        </div>
    );
}

function RefundPanel({
    refundWei,
    connected,
    phase,
    onWithdraw,
    chainId,
}: {
    refundWei: bigint;
    connected: boolean;
    phase: ReturnType<typeof useTitleAuctionActions>['phase'];
    onWithdraw: () => Promise<void>;
    chainId: number;
}) {
    if (!connected || refundWei === 0n) return null;
    const inFlight =
        phase.kind === 'wallet' ||
        phase.kind === 'submitted' ||
        phase.kind === 'confirming';
    const isRefundPhase = 'action' in phase && phase.action === 'withdrawRefund';
    return (
        <aside className="title-refund-panel" aria-label="Refund available">
            <div className="title-refund-row">
                <div>
                    <h3 className="title-refund-title">Refund queued</h3>
                    <p className="title-refund-copy">
                        You were outbid earlier and the push refund failed. Pull{' '}
                        <strong className="tnum">{formatEth(refundWei)}</strong> from the
                        auction.
                    </p>
                </div>
                <button
                    type="button"
                    className="secondary"
                    onClick={onWithdraw}
                    disabled={inFlight}
                >
                    {inFlight && isRefundPhase
                        ? phase.kind === 'wallet'
                            ? 'Confirm…'
                            : 'Confirming…'
                        : 'Withdraw refund'}
                </button>
            </div>
            <ActionStateLine phase={phase} chainId={chainId} forAction="withdrawRefund" />
            <style>{refundStyles}</style>
        </aside>
    );
}

function ActionStateLine({
    phase,
    chainId,
    forAction,
}: {
    phase: ReturnType<typeof useTitleAuctionActions>['phase'];
    chainId: number;
    forAction: 'kickoff' | 'settle' | 'withdrawProceeds' | 'withdrawRefund';
}) {
    if (!('action' in phase)) return null;
    if (phase.action !== forAction) return null;
    if (phase.kind === 'success') {
        return (
            <span className="title-action-success">
                Confirmed.{' '}
                <a
                    className="tx-link"
                    href={getEvmNowTxUrl(phase.hash, chainId)}
                    target="_blank"
                    rel="noreferrer"
                >
                    view tx
                </a>
            </span>
        );
    }
    if (phase.kind === 'rejected') {
        return <span className="title-action-error">{phase.message}</span>;
    }
    if (phase.kind === 'failed') {
        return (
            <span className="title-action-error">
                {phase.message}{' '}
                {phase.hash && (
                    <a
                        className="tx-link"
                        href={getEvmNowTxUrl(phase.hash, chainId)}
                        target="_blank"
                        rel="noreferrer"
                    >
                        view tx
                    </a>
                )}
            </span>
        );
    }
    if (phase.kind === 'submitted' || phase.kind === 'confirming') {
        return (
            <span className="title-action-info">
                {phase.kind === 'submitted' ? 'Submitted' : 'Confirming'}.{' '}
                <a
                    className="tx-link"
                    href={getEvmNowTxUrl(phase.hash, chainId)}
                    target="_blank"
                    rel="noreferrer"
                >
                    view tx
                </a>
            </span>
        );
    }
    return null;
}

/** Fallback artwork shown when the on-chain renderer is unreachable
 *  (pre-deploy, network failure, etc). A museum-plate placard that
 *  identifies the token without pretending to be the live mosaic — the
 *  page reads `tokenURI(111)` for the real artwork and only falls
 *  through to this when that read returns null. */
function TitleArtFallback() {
    return (
        <svg
            viewBox="0 0 240 240"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label="Vault Title — renderer unavailable, showing placeholder placard"
        >
            <rect width="240" height="240" fill="#1a1a1a" />
            <g
                fill="none"
                stroke="#d4a955"
                strokeWidth="1.5"
                opacity="0.7"
            >
                <rect x="20" y="20" width="200" height="200" />
                <rect x="32" y="32" width="176" height="176" />
            </g>
            <text
                x="120"
                y="100"
                textAnchor="middle"
                fontFamily="Georgia, serif"
                fontSize="22"
                fill="#d4a955"
                letterSpacing="2"
            >
                THE TITLE
            </text>
            <text
                x="120"
                y="130"
                textAnchor="middle"
                fontFamily="ui-monospace, monospace"
                fontSize="10"
                fill="#888"
                letterSpacing="1"
            >
                PUNK VAULT · TOKEN ID 111
            </text>
            <text
                x="120"
                y="160"
                textAnchor="middle"
                fontFamily="Georgia, serif"
                fontStyle="italic"
                fontSize="12"
                fill="#aaa"
            >
                role of record
            </text>
            <g fill="#d4a955">
                {[60, 90, 120, 150, 180].map((x) => (
                    <rect key={x} x={x - 2} y="195" width="4" height="4" />
                ))}
            </g>
        </svg>
    );
}

const styles = `
.title-page {
    padding-top: clamp(40px, 6vh, 72px);
    padding-bottom: clamp(80px, 12vh, 160px);
    border-top: none;
}
.title-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(360px, 0.9fr);
    gap: clamp(36px, 5vw, 72px);
    align-items: start;
}
.title-page-quiet {
    padding-top: clamp(80px, 12vh, 160px);
    padding-bottom: clamp(80px, 12vh, 160px);
}
.title-quiet-wrap {
    max-width: 640px;
    margin: 0 auto;
    text-align: center;
}
.title-quiet-headline {
    font-family: var(--serif);
    font-size: clamp(32px, 4vw, 48px);
    line-height: 1.1;
    letter-spacing: -0.025em;
    margin: 12px 0 18px;
    font-weight: 300;
}
.title-quiet-copy {
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0 auto 28px;
    max-width: 520px;
}
.title-quiet-actions {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
}
.title-art-col {
    display: flex;
    flex-direction: column;
    gap: 22px;
}
.title-art {
    line-height: 0;
    width: 100%;
    aspect-ratio: 1;
    background: #000;
    border: 1px solid var(--line);
    overflow: hidden;
}
.title-art-svg {
    width: 100%;
    height: 100%;
    line-height: 0;
}
.title-art svg {
    width: 100%;
    height: 100%;
    display: block;
}
.title-meta {
    margin: 0;
    display: grid;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.title-meta-row {
    background: var(--panel);
    padding: 14px 16px;
    display: flex;
    justify-content: space-between;
    gap: 18px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.title-meta-row dd {
    margin: 0;
    color: var(--ink);
    display: inline-flex;
    align-items: center;
    gap: 8px;
}
.title-meta-row a {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px dotted var(--muted);
}
.title-meta-row a:hover {
    border-bottom-color: var(--accent);
    color: var(--accent);
}
.title-meta-tag {
    border: 1px solid var(--accent);
    color: var(--accent);
    padding: 1px 6px;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}
.title-sidebar {
    display: flex;
    flex-direction: column;
    gap: 22px;
}
.title-sidebar .bid-panel {
    position: static;
    top: auto;
}
.title-headline .kicker {
    margin-bottom: 8px;
}
.title-h1 {
    font-family: var(--serif);
    font-size: clamp(36px, 4.5vw, 56px);
    font-weight: 300;
    letter-spacing: -0.035em;
    line-height: 1;
    margin: 0;
}
.title-sub {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.55;
    color: var(--muted);
    margin: 12px 0 0;
    max-width: 56ch;
}
.title-stat-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.title-stat {
    background: var(--panel);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.title-stat-label {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
}
.title-stat-value {
    font-family: var(--mono);
    font-size: 18px;
    color: var(--ink);
}
.title-stat-primary .title-stat-value {
    font-size: 24px;
    color: var(--accent);
}
@media (max-width: 900px) {
    .title-grid {
        grid-template-columns: 1fr;
    }
}
`;

const actionStyles = `
.title-action-panel {
    border: 1px solid var(--ink);
    padding: clamp(20px, 2.8vw, 28px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--bg);
}
.title-action-title {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 300;
    letter-spacing: -0.02em;
    margin: 0;
}
.title-action-copy {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0;
}
.title-action-quiet {
    font-size: 11px;
    opacity: 0.8;
}
.title-action-cta {
    width: 100%;
    padding: 14px 18px;
    font-family: var(--mono);
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
}
.title-action-success,
.title-action-error,
.title-action-info,
.title-action-hint {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 8px;
}
.title-action-success {
    color: var(--ink);
}
.title-action-error {
    color: var(--accent);
}
.title-action-connect {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}
.tx-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
.title-proceeds {
    display: grid;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    margin-top: 4px;
}
.title-proceeds-row {
    background: var(--panel);
    padding: 12px 14px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 14px;
}
.title-proceeds-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.title-proceeds-label {
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
}
.title-proceeds-addr {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
    text-decoration: none;
    border-bottom: 1px dotted var(--muted);
}
.title-proceeds-addr:hover {
    color: var(--accent);
    border-bottom-color: var(--accent);
}
.title-proceeds-amount {
    font-family: var(--mono);
    font-size: 14px;
    color: var(--accent);
}
.title-proceeds-claim {
    padding: 8px 14px;
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
}
@media (max-width: 560px) {
    .title-proceeds-row {
        grid-template-columns: 1fr auto;
        row-gap: 6px;
    }
    .title-proceeds-amount {
        grid-column: 1 / -1;
    }
}
`;

const refundStyles = `
.title-refund-panel {
    border: 1px dashed var(--accent);
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--bg);
}
.title-refund-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
}
.title-refund-title {
    font-family: var(--serif);
    font-size: 18px;
    font-weight: 300;
    letter-spacing: -0.02em;
    margin: 0;
}
.title-refund-copy {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.55;
    color: var(--muted);
    margin: 2px 0 0;
}
`;
