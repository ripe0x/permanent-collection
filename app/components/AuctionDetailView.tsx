'use client';

/* Return auction detail page.

   Layout (≥900px):
     ┌──────────────┬─────────────────────┐
     │              │  countdown          │
     │   PUNK ART   │  high bid / reserve │
     │              │  PlaceBidPanel      │
     │  trait card  │                     │
     │  metadata    │  bid history        │
     └──────────────┴─────────────────────┘

   Below 900px: stacks single-column.

   Auction-page-specific copy decisions per issue #7:
   - No "Punk #N can still return." headline.
   - No "block 25175455 · 7m ago" stamp.
   - No "bid above the reserve" framing in the bid composer.
   - "Opening reserve" only surfaces when no bid has cleared yet.
*/

import Link from 'next/link';
import {useCallback, useEffect, useState} from 'react';
import type {Hash} from 'viem';
import {useQueryClient} from '@tanstack/react-query';
import {useAccount, usePublicClient, useWalletClient} from 'wagmi';
import {AuctionBidHistory, type TerminalAllocationRow} from './AuctionBidHistory';
import {AuctionCountdown} from './AuctionCountdown';
import {ConnectButton} from './ConnectButton';
import {PlaceBidPanel} from './PlaceBidPanel';
import {abi as ReturnAuctionAbi} from '@/lib/abis/ReturnAuctionModule';
import {getContractAddresses} from '@/lib/config';
import {auctionBidsKey, useAuctionBids, type BidEntry} from '@/lib/data/useAuctionBids';
import {useNowSeconds} from '@/lib/useNowSeconds';
import {formatEth, formatPunk, formatTraitName, getEvmNowTxUrl, shortAddress} from '@/lib/format';

interface Wire {
    punkId: number;
    targetTraitId: number;
    acquisitionCostWei: string;
    reserveWei: string;
    highBidWei: string;
    highBidder?: string;
    startedAt: string;
    endsAt: string;
    extensions: number;
    attemptCount: number;
}

interface ResolvedWire {
    punkId: number;
    targetTraitId: number;
    outcome: 'cleared' | 'vaulted';
    finalBidWei: string;
    acquisitionPriceWei?: string;
    /** Cleared-path split of the winning bid (event-sourced); vault-burn is the
     *  remainder. Absent for vaulted or legacy rows. */
    liveBidShareWei?: string;
    burnShareWei?: string;
    settledAt: string;
}

interface Props {
    auction: Wire | null;
    /** Set when there's no active auction but the Punk has a SETTLED one. The
     *  page then shows the outcome + bid history instead of a not-found state. */
    resolved?: ResolvedWire | null;
    punkId: number;
    nowSeconds: string;
    chainId: number;
    traitNames: readonly string[];
    /** Server-rendered <PunkSvg> for this Punk. Passed as children so the
     *  2.4MB pixel SDK never lands in the client bundle. */
    punkImage: React.ReactNode;
}

export function AuctionDetailView({auction, resolved, punkId, nowSeconds, chainId, traitNames, punkImage}: Props) {
    // Live bid list — shares its react-query cache with <AuctionBidHistory/>
    // (one fetch). Lets the current bid + high bidder update the moment a new
    // bid lands (the viewer's own bid invalidates it from PlaceBidPanel; a 30s
    // poll catches everyone else's), instead of staying pinned to the SSR
    // snapshot until reload.
    const bidsQuery = useAuctionBids(punkId);

    if (!auction) {
        // Settled: show the outcome + bid history rather than a dead end.
        if (resolved) {
            return (
                <SettledAuctionView
                    resolved={resolved}
                    punkId={punkId}
                    chainId={chainId}
                    traitNames={traitNames}
                    punkImage={punkImage}
                />
            );
        }
        return (
            <section className="auction-page">
                <div className="wrap auction-empty">
                    <div className="kicker">Return auction</div>
                    <div className="auction-art auction-art-classic">{punkImage}</div>
                    <h1 className="section-title">{formatPunk(punkId)}</h1>
                    <p className="section-copy">
                        No live return auction for this Punk. No one has accepted the bid for it yet.
                    </p>
                    <div className="actions">
                        <Link className="primary" href="/">Back to home</Link>
                        <Link className="secondary" href="/collection">Browse traits</Link>
                    </div>
                </div>
                <style>{styles}</style>
            </section>
        );
    }

    const reserveWei = BigInt(auction.reserveWei);
    const ssrHighBidWei = BigInt(auction.highBidWei);
    // The latest indexed bid wins when it's higher than the SSR snapshot —
    // covers both the viewer's own just-placed bid and anyone else's between
    // renders. Take the max by amount so we don't depend on list ordering.
    const topBid = (bidsQuery.data ?? []).reduce<BidEntry | undefined>(
        (m, b) => (!m || b.amount > m.amount ? b : m),
        undefined,
    );
    const bidAhead = topBid !== undefined && topBid.amount > ssrHighBidWei;
    const highBidWei = bidAhead ? topBid.amount : ssrHighBidWei;
    const highBidder = bidAhead ? topBid.bidder : auction.highBidder;
    const endsAt = BigInt(auction.endsAt);
    const now = BigInt(nowSeconds);
    const hasHigh = highBidWei > 0n;
    // Subsequent bids must clear the contract's 1% minimum increment over the
    // current high bid (ReturnAuctionModule.minBidIncrementBps = 100, denom
    // 10_000), not a bare +1 wei. A bid between highBid+1 and highBid×1.01
    // passes a +1 floor but reverts on-chain with BidBelowMinIncrement. The
    // first bid only needs to meet the reserve. (BidComposer rounds whichever
    // floor this is up to display precision for the input default.)
    const minNextBid = hasHigh ? highBidWei + (highBidWei * 100n) / 10_000n : reserveWei;
    const traitName = formatTraitName(auction.targetTraitId, traitNames);

    return (
        <section className="auction-page">
            <div className="wrap auction-grid">
                <div className="auction-art-col">
                    <div className="auction-art auction-art-classic">{punkImage}</div>
                    <dl className="auction-meta">
                        <div className="auction-meta-row">
                            <dt>Target trait</dt>
                            <dd>{traitName}</dd>
                        </div>
                        <div className="auction-meta-row">
                            <dt>Paid at acquisition</dt>
                            <dd className="tnum">{formatEth(BigInt(auction.acquisitionCostWei))}</dd>
                        </div>
                        <div className="auction-meta-row">
                            <dt>Attempt</dt>
                            <dd className="tnum">#{auction.attemptCount}</dd>
                        </div>
                    </dl>
                </div>

                <div className="auction-sidebar">
                    <div className="auction-headline">
                        <div className="kicker">Return auction · {traitName}</div>
                        <h1 className="auction-title">{formatPunk(auction.punkId)}</h1>
                    </div>

                    <AuctionCountdown endsAt={endsAt} nowSecondsInitial={now} />

                    <div className="auction-stat-grid">
                        <Stat
                            label={hasHigh ? 'current bid' : 'reserve'}
                            value={hasHigh ? formatEth(highBidWei) : formatEth(reserveWei)}
                            primary
                        />
                        <Stat
                            label="high bidder"
                            value={highBidder ? shortAddress(highBidder) : '—'}
                        />
                    </div>

                    <AuctionActionSlot
                        punkId={auction.punkId}
                        targetTraitId={auction.targetTraitId}
                        traitNames={traitNames}
                        minNextBidWei={minNextBid}
                        reserveWei={reserveWei}
                        highBidWei={highBidWei}
                        highBidder={highBidder}
                        endsAt={endsAt}
                        nowInitial={now}
                        chainId={chainId}
                    />

                    <AuctionBidHistory
                        punkId={auction.punkId}
                        chainId={chainId}
                        highBidExists={highBidWei > 0n}
                    />
                </div>
            </div>
            <style>{styles}</style>
        </section>
    );
}

function Stat({label, value, primary}: {label: string; value: string; primary?: boolean}) {
    return (
        <div className={`auction-stat ${primary ? 'auction-stat-primary' : ''}`}>
            <span className="auction-stat-label">{label}</span>
            <strong className="auction-stat-value tnum">{value}</strong>
        </div>
    );
}

/** Terminal view for a Punk whose return auction has settled. Reuses the active
 *  page's two-column layout, states the outcome (returned to the market, or
 *  vaulted with the trait made permanent), and keeps the full bid history so the
 *  page is a record rather than a dead end. */
function SettledAuctionView({
    resolved,
    punkId,
    chainId,
    traitNames,
    punkImage,
}: {
    resolved: ResolvedWire;
    punkId: number;
    chainId: number;
    traitNames: readonly string[];
    punkImage: React.ReactNode;
}) {
    const cleared = resolved.outcome === 'cleared';
    const traitName = formatTraitName(resolved.targetTraitId, traitNames);
    const finalBidWei = BigInt(resolved.finalBidWei);
    const acqWei = resolved.acquisitionPriceWei ? BigInt(resolved.acquisitionPriceWei) : undefined;

    // Cleared-path distribution of the winning bid. Prefer the event-sourced
    // shares; fall back to the contract constants off the acquisition cost
    // (65% of cost → live bid, 25% → buy-and-burn). Vault-burn is the remainder
    // — it also absorbs any referral share of the premium.
    const liveBidShare =
        resolved.liveBidShareWei != null
            ? BigInt(resolved.liveBidShareWei)
            : acqWei !== undefined
              ? (acqWei * 6500n) / 10000n
              : undefined;
    const burnShare =
        resolved.burnShareWei != null
            ? BigInt(resolved.burnShareWei)
            : acqWei !== undefined
              ? (acqWei * 2500n) / 10000n
              : undefined;
    const showDistro = cleared && liveBidShare !== undefined && burnShare !== undefined;
    const vaultBurnShare =
        showDistro && finalBidWei > liveBidShare! + burnShare!
            ? finalBidWei - liveBidShare! - burnShare!
            : undefined;

    // Terminal allocation rows for the auction history below — where the
    // winning bid went on settle. Mirrors the distribution panel but as
    // chronological history entries.
    const allocRows: TerminalAllocationRow[] | undefined = showDistro
        ? [
              {label: 'Returned to the live bid', amountWei: liveBidShare!, tag: 'to bid'},
              {label: 'Bought and burned', amountWei: burnShare!, tag: 'burned'},
              ...(vaultBurnShare !== undefined
                  ? [{label: 'Vault burn', amountWei: vaultBurnShare, tag: 'burned'}]
                  : []),
          ]
        : undefined;

    return (
        <section className="auction-page">
            <div className="wrap auction-grid">
                <div className="auction-art-col">
                    <div className="auction-art auction-art-classic">{punkImage}</div>
                    <dl className="auction-meta">
                        <div className="auction-meta-row">
                            <dt>Target trait</dt>
                            <dd>{traitName}</dd>
                        </div>
                        {acqWei !== undefined && (
                            <div className="auction-meta-row">
                                <dt>Paid at acquisition</dt>
                                <dd className="tnum">{formatEth(acqWei)}</dd>
                            </div>
                        )}
                    </dl>
                </div>

                <div className="auction-sidebar">
                    <div className="auction-headline">
                        <div className="kicker">Settled · {traitName}</div>
                        <h1 className="auction-title">{formatPunk(punkId)}</h1>
                    </div>

                    <div className={`settled-banner ${cleared ? '' : 'settled-banner-vault'}`}>
                        <span className="settled-banner-label">outcome</span>
                        <strong className="settled-banner-value">
                            {cleared ? 'Returned to the market' : 'Vaulted'}
                        </strong>
                        <p className="settled-banner-copy">
                            {cleared ? (
                                <>
                                    A bid above the reserve returned {formatPunk(punkId)} to the market.{' '}
                                    {traitName} stays open for a future Punk.
                                </>
                            ) : (
                                <>
                                    No bid cleared the reserve, so {formatPunk(punkId)} entered the vault
                                    permanently and <strong>{traitName}</strong> is now a permanent trait.
                                </>
                            )}
                        </p>
                    </div>

                    <div className="auction-stat-grid">
                        <Stat
                            label={cleared ? 'winning bid' : 'paid at acquisition'}
                            value={
                                cleared
                                    ? formatEth(finalBidWei)
                                    : acqWei !== undefined
                                      ? formatEth(acqWei)
                                      : '—'
                            }
                            primary
                        />
                        <Stat label="result" value={cleared ? 'returned' : 'permanent'} />
                    </div>

                    {showDistro && (
                        <dl className="settled-distro" aria-label="Where the winning bid went">
                            <div className="settled-distro-head">
                                Where the {formatEth(finalBidWei)} winning bid went
                            </div>
                            <div className="settled-distro-row">
                                <dt>Returned to the live bid</dt>
                                <dd className="tnum">{formatEth(liveBidShare!)}</dd>
                            </div>
                            <div className="settled-distro-row">
                                <dt>Bought and burned</dt>
                                <dd className="tnum">{formatEth(burnShare!)}</dd>
                            </div>
                            {vaultBurnShare !== undefined && (
                                <div className="settled-distro-row">
                                    <dt>To the vault-burn pool</dt>
                                    <dd className="tnum">{formatEth(vaultBurnShare)}</dd>
                                </div>
                            )}
                            <p className="settled-distro-note">
                                The vault-burn share also covers any referral cut of the premium
                                over the protocol&apos;s acquisition cost.
                            </p>
                        </dl>
                    )}

                    <div className="settled-actions">
                        <Link className="secondary" href={`/collection/${resolved.targetTraitId}`}>
                            View the trait
                        </Link>
                        <Link className="secondary" href="/auction">All auctions</Link>
                    </div>

                    <AuctionBidHistory
                        punkId={punkId}
                        chainId={chainId}
                        highBidExists={finalBidWei > 0n}
                        terminalRows={allocRows}
                    />
                </div>
            </div>
            <style>{styles}</style>
            <style>{settledStyles}</style>
        </section>
    );
}

/** The right-column action slot. Shows the bid composer while the auction is
 *  live and flips to the settlement panel the moment the 72-hour window closes.
 *  Keeps a live clock here (rather than the SSR `now`) so a viewer watching the
 *  countdown sees the swap at zero without reloading. */
function AuctionActionSlot({
    punkId,
    targetTraitId,
    traitNames,
    minNextBidWei,
    reserveWei,
    highBidWei,
    highBidder,
    endsAt,
    nowInitial,
    chainId,
}: {
    punkId: number;
    targetTraitId: number;
    traitNames: readonly string[];
    minNextBidWei: bigint;
    reserveWei: bigint;
    highBidWei: bigint;
    highBidder?: string;
    endsAt: bigint;
    nowInitial: bigint;
    chainId: number;
}) {
    const now = useNowSeconds(nowInitial);
    // Match the contract's settle gate exactly: settle() succeeds when
    // block.timestamp >= endsAt (ReturnAuctionModule.isSettleable).
    const expired = now >= endsAt;

    if (!expired) {
        return (
            <PlaceBidPanel
                punkId={punkId}
                minNextBidWei={minNextBidWei}
                reserveWei={reserveWei}
                highBidWei={highBidWei}
                closed={false}
            />
        );
    }
    return (
        <SettlePanel
            punkId={punkId}
            targetTraitId={targetTraitId}
            traitNames={traitNames}
            highBidWei={highBidWei}
            highBidder={highBidder}
            chainId={chainId}
        />
    );
}

type SettlePhase =
    | {kind: 'idle'}
    | {kind: 'wallet'}
    | {kind: 'confirming'; hash: Hash}
    | {kind: 'success'; hash: Hash}
    | {kind: 'rejected'; message: string}
    | {kind: 'failed'; hash?: Hash; message: string};

/** Settlement panel for a closed return auction. The 72-hour window is over;
 *  the only remaining step is the permissionless `settle(punkId)`. The outcome
 *  is already decided by whether any bid cleared the reserve:
 *    - a high bidder exists  -> the Punk returns to them, the trait stays open
 *    - no bid                -> the Punk is vaulted, the target trait is made
 *                               permanent (no undo)
 *  We state which one will happen before the user signs, run the tx lifecycle,
 *  then show the result. */
function SettlePanel({
    punkId,
    targetTraitId,
    traitNames,
    highBidWei,
    highBidder,
    chainId,
}: {
    punkId: number;
    targetTraitId: number;
    traitNames: readonly string[];
    highBidWei: bigint;
    highBidder?: string;
    chainId: number;
}) {
    const {address} = useAccount();
    const pub = usePublicClient();
    const {data: wallet} = useWalletClient();
    const queryClient = useQueryClient();
    const [phase, setPhase] = useState<SettlePhase>({kind: 'idle'});

    // Any accepted bid is >= reserve (sub-reserve bids are rejected on-chain),
    // so a non-zero high bid means the auction clears (Punk returns to bidder).
    const willClear = highBidWei > 0n;
    const traitName = formatTraitName(targetTraitId, traitNames);
    const bidderLabel = highBidder ? shortAddress(highBidder) : 'the high bidder';

    const submit = useCallback(async () => {
        if (!wallet || !address) return;
        setPhase({kind: 'wallet'});
        try {
            const hash = await wallet.writeContract({
                abi: ReturnAuctionAbi,
                address: getContractAddresses().returnAuctionModule,
                functionName: 'settle',
                args: [punkId],
                account: address,
                chain: wallet.chain,
            });
            setPhase({kind: 'confirming', hash});
        } catch (e) {
            setPhase({kind: 'rejected', message: classifySettleError(e)});
        }
    }, [wallet, address, punkId]);

    // Receipt watch — narrow dep on the hash so a kind->kind transition doesn't
    // re-fire the effect and cancel the in-flight wait.
    const confirmingHash = phase.kind === 'confirming' ? phase.hash : undefined;
    useEffect(() => {
        if (!confirmingHash || !pub) return;
        let cancelled = false;
        pub.waitForTransactionReceipt({hash: confirmingHash})
            .then((r) => {
                if (cancelled) return;
                if (r.status === 'success') {
                    setPhase({kind: 'success', hash: confirmingHash});
                    // Bid history / high-bid stat now reflect a terminal sale.
                    void queryClient.invalidateQueries({queryKey: auctionBidsKey(punkId)});
                } else {
                    setPhase({kind: 'failed', hash: confirmingHash, message: 'Settlement reverted on-chain.'});
                }
            })
            .catch((e) => {
                if (cancelled) return;
                setPhase({kind: 'failed', hash: confirmingHash, message: classifySettleError(e)});
            });
        return () => {
            cancelled = true;
        };
    }, [confirmingHash, pub, punkId, queryClient]);

    const inFlight = phase.kind === 'wallet' || phase.kind === 'confirming';

    if (phase.kind === 'success') {
        return (
            <aside className="settle-panel" aria-label="Auction settled">
                <h3 className="settle-title">{willClear ? 'Returned.' : 'Vaulted.'}</h3>
                <p className="settle-copy">
                    {willClear ? (
                        <>
                            {formatPunk(punkId)} went to the auction winner, {bidderLabel}, for{' '}
                            <strong className="tnum">{formatEth(highBidWei)}</strong>. {traitName} stays open
                            for a future Punk.
                        </>
                    ) : (
                        <>
                            {formatPunk(punkId)} is in the vault permanently and{' '}
                            <strong>{traitName}</strong> is now a permanent trait.
                        </>
                    )}
                </p>
                <span className="settle-state settle-state-ok" aria-live="polite">
                    Settled.{' '}
                    <a className="tx-link" href={getEvmNowTxUrl(phase.hash, chainId)} target="_blank" rel="noreferrer">
                        view tx
                    </a>
                </span>
                <div className="settle-actions">
                    {willClear ? (
                        <Link className="secondary" href="/">Back to home</Link>
                    ) : (
                        <Link className="secondary" href="/collection">See the collection</Link>
                    )}
                </div>
                <style>{settleStyles}</style>
            </aside>
        );
    }

    return (
        <aside className="settle-panel" aria-label="Settle the auction">
            <div className="settle-head">
                <span className="settle-kicker">window closed</span>
            </div>
            <h3 className="settle-title">{willClear ? 'Finalize the return.' : 'Send to the vault.'}</h3>
            <p className="settle-copy">
                The 72-hour window has closed. Settling is the final step, and anyone can call it.
            </p>
            <div className={`settle-outcome ${willClear ? '' : 'settle-outcome-vault'}`}>
                {willClear ? (
                    <>
                        A bid cleared the reserve, so settling sends {formatPunk(punkId)} to the auction winner,{' '}
                        {bidderLabel}, for{' '}
                        <strong className="tnum">{formatEth(highBidWei)}</strong>. {traitName} stays open for a
                        future Punk.
                    </>
                ) : (
                    <>
                        No one bid above the reserve. Settling sends {formatPunk(punkId)} to the vault permanently
                        and makes <strong>{traitName}</strong> a permanent trait. There is no undo.
                    </>
                )}
            </div>
            <button
                type="button"
                className="primary settle-submit"
                onClick={submit}
                disabled={!address || inFlight}
            >
                {inFlight
                    ? phase.kind === 'wallet'
                        ? 'Confirm in wallet…'
                        : 'Settling…'
                    : phase.kind === 'rejected' || phase.kind === 'failed'
                      ? 'Retry settle'
                      : 'Settle the auction'}
            </button>
            <div className="settle-state-row" aria-live="polite">
                {phase.kind === 'confirming' && (
                    <span className="settle-state">
                        Confirming on-chain…{' '}
                        <a className="tx-link" href={getEvmNowTxUrl(phase.hash, chainId)} target="_blank" rel="noreferrer">
                            view tx
                        </a>
                    </span>
                )}
                {phase.kind === 'rejected' && <span className="settle-state settle-state-err">{phase.message}</span>}
                {phase.kind === 'failed' && (
                    <span className="settle-state settle-state-err">
                        {phase.message}{' '}
                        {phase.hash && (
                            <a className="tx-link" href={getEvmNowTxUrl(phase.hash, chainId)} target="_blank" rel="noreferrer">
                                view tx
                            </a>
                        )}
                    </span>
                )}
                {!address && (
                    <span className="settle-connect">
                        Connect a wallet to settle. <ConnectButton />
                    </span>
                )}
            </div>
            <p className="settle-fineprint">
                {willClear
                    ? 'Settling is permissionless and pays no caller reward. The winning bid is distributed by the protocol; most of it refills the live bid.'
                    : 'Settling is permissionless and pays no caller reward. The trait’s Proof mints to the Punk’s original seller at the same moment.'}
            </p>
            <style>{settleStyles}</style>
        </aside>
    );
}

/** Flatten a viem/wallet error's cause chain into searchable text. The useful
 *  revert reason is usually nested 2-3 levels deep, not in the top message. */
function errText(e: unknown): string {
    const parts: string[] = [];
    let cur: unknown = e;
    let depth = 0;
    while (cur && depth < 6) {
        if (cur instanceof Error) {
            const a = cur as Error & {
                shortMessage?: string;
                metaMessages?: string[];
                details?: string;
                cause?: unknown;
            };
            if (a.shortMessage) parts.push(a.shortMessage);
            if (a.metaMessages?.length) parts.push(...a.metaMessages);
            if (a.details) parts.push(a.details);
            if (!a.shortMessage && !a.details) parts.push(a.message);
            cur = a.cause;
        } else {
            parts.push(String(cur));
            break;
        }
        depth++;
    }
    return parts.join(' ');
}

function classifySettleError(e: unknown): string {
    const t = errText(e);
    if (/user rejected|user denied/i.test(t)) return 'You declined in your wallet.';
    if (/AlreadySettled/i.test(t)) return 'This auction was already settled by someone else.';
    if (/SaleLive/i.test(t)) return 'The auction is still live — the window has not closed yet.';
    if (/SaleMissing/i.test(t)) return 'No settleable auction was found for this Punk.';
    if (/insufficient funds/i.test(t)) return 'Not enough ETH to cover gas.';
    const first = t.split('\n')[0].trim();
    if (!first) return 'Settlement failed. Try again.';
    return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

const CRYPTOPUNKS_BLUE = 'var(--punk-blue)';

const styles = `
.auction-page {
    padding-top: clamp(40px, 6vh, 72px);
    padding-bottom: clamp(80px, 12vh, 160px);
    border-top: none;
}
.auction-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(360px, 0.9fr);
    gap: clamp(36px, 5vw, 72px);
    align-items: start;
}
.auction-empty {
    max-width: 640px;
    margin: 0 auto;
    text-align: center;
    padding: clamp(48px, 8vh, 80px) var(--pad);
}
.auction-art {
    line-height: 0;
    width: 100%;
    aspect-ratio: 1;
}
.auction-art-classic {
    background: ${CRYPTOPUNKS_BLUE};
}
.auction-art .punk-svg {
    width: 100% !important;
    height: 100% !important;
}
.auction-art .punk-svg svg {
    width: 100% !important;
    height: 100% !important;
}
.auction-art-col {
    display: flex;
    flex-direction: column;
    gap: 22px;
}
.auction-meta {
    margin: 0;
    display: grid;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.auction-meta-row {
    background: var(--panel);
    padding: 14px 16px;
    display: flex;
    justify-content: space-between;
    gap: 18px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.auction-meta-row dd {
    margin: 0;
    color: var(--ink);
}
.auction-sidebar {
    display: flex;
    flex-direction: column;
    gap: 22px;
}
/* Bid panel inherits sticky from PlaceBidPanel's base styles. In the
   detail-page layout the art is the sticky element, so flatten the
   panel back to normal flow so the bid-history section below it
   scrolls past naturally. */
.auction-sidebar .bid-panel {
    position: static;
    top: auto;
}
.auction-headline .kicker {
    margin-bottom: 8px;
}
.auction-title {
    font-family: var(--serif);
    font-size: clamp(36px, 4.5vw, 56px);
    font-weight: 300;
    letter-spacing: -0.035em;
    line-height: 1;
    margin: 0;
}
.auction-stat-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.auction-stat {
    background: var(--panel);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.auction-stat-label {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
}
.auction-stat-value {
    font-family: var(--mono);
    font-size: 18px;
    color: var(--ink);
}
.auction-stat-primary .auction-stat-value {
    font-size: 24px;
    color: var(--accent);
}
@media (max-width: 900px) {
    .auction-grid {
        grid-template-columns: 1fr;
    }
    .auction-art-col {
        position: static;
    }
}
`;

const settleStyles = `
.settle-panel {
    border: 1px solid var(--ink);
    padding: clamp(20px, 2.8vw, 28px);
    display: flex;
    flex-direction: column;
    gap: 14px;
    position: sticky;
    top: 78px;
    background: var(--bg);
}
.settle-head {
    display: flex;
    justify-content: flex-start;
}
.settle-kicker {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--muted);
}
.settle-title {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 300;
    letter-spacing: -0.02em;
    margin: 0;
}
.settle-copy {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0;
}
.settle-outcome {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.6;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 2px solid var(--accent);
    padding: 12px 16px;
}
.settle-outcome-vault {
    border-left-color: var(--ink);
}
.settle-outcome strong {
    font-weight: 600;
}
.settle-submit {
    width: 100%;
    padding: 14px 18px;
    font-family: var(--mono);
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
}
.settle-state-row {
    min-height: 20px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
}
.settle-state {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 8px;
}
.settle-state-ok {
    color: var(--ink);
}
.settle-state-err {
    color: var(--accent);
}
.settle-connect {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}
.settle-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}
.settle-fineprint {
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.55;
    color: var(--muted);
    opacity: 0.85;
    margin: 0;
}
.settle-panel .tx-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
`;

const settledStyles = `
.settled-banner {
    border: 1px solid var(--line);
    border-left: 2px solid var(--accent);
    background: var(--panel);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.settled-banner-vault {
    border-left-color: var(--ink);
}
.settled-banner-label {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--muted);
}
.settled-banner-value {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 300;
    letter-spacing: -0.02em;
    color: var(--ink);
}
.settled-banner-copy {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0;
}
.settled-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}
.settled-distro {
    margin: 0;
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
}
.settled-distro-head {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
}
.settled-distro-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 14px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
}
.settled-distro-row dt {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
    margin: 0;
}
.settled-distro-row dd {
    font-family: var(--mono);
    font-size: 14px;
    color: var(--ink);
    margin: 0;
}
.settled-distro-note {
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.5;
    color: var(--muted);
    opacity: 0.8;
    margin: 0;
    padding: 10px 14px;
}
`;
