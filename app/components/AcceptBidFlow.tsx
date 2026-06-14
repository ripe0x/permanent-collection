'use client';

/* The acceptBid flow. Punk-first:
     1. Pick Punk:  the caller picks which of THEIR Punks to make permanent.
                    Each Punk shows the protocol-derived target trait it will
                    be collected for (the rarest uncollected trait it carries) —
                    a read-only preview, NOT a choice. The protocol derives the
                    target; the caller does not pick it.
     2. Submit:     list → accept, signed as ─
                       (a) market.offerPunkForSaleToAddress(punkId, liveBidWei, patron)
                           — list the Punk EXCLUSIVELY to the protocol at the
                           current live bid (a real price, not 0), so only the
                           protocol can buy it. The listed price has to land
                           within 1% of the live bid; listing at exactly
                           `liveBidWei` satisfies that.
                       (b) patron.acceptBid(punkId, targetTraitId, expectedListingWei)
                           — anyone can finalize. The protocol buys the listing
                           via `buyPunk`. `expectedListingWei` (hard-set to
                           `liveBidWei`) is a caller-side overpay CAP, not a
                           payout floor.
                    where `targetTraitId` is the canonical target. Listing and
                    acceptance fit in one signing prompt when the wallet
                    supports EIP-5792 `wallet_sendCalls` (Coinbase Wallet, Safe,
                    EIP-7702 MetaMask); otherwise as two sequential txs. Each tx
                    renders its own lifecycle line (submitted → confirming →
                    success / rejected / failed).
     3. Claim:      the seller is paid by the 2017 CryptoPunks market, NOT by
                    the protocol. `buyPunk` credits the seller's
                    `pendingWithdrawals` on the market; the seller collects with
                    `market.withdraw()`. The Claim step is shown (inactive) from
                    the start so the seller knows payment is pull-based, and
                    activates once the market holds their proceeds. A final
                    summary links to the new /auction/[punkId].

   Why Punk-first: the on-chain target is now protocol-derived
   (`canonicalTargetOf` = the rarest uncollected, non-pending trait a Punk
   carries; `acceptBid` reverts `NotCanonicalTarget` for anything else). A
   trait-first picker would imply a choice the caller no longer has. So the
   caller picks the Punk; the UI shows what that Punk becomes permanent for.

   The brief: every async/empty/error state is designed in voice; reads
   work without a wallet; the consent gate is the one moment the deadpan
   goes fully serious. */

import Link from 'next/link';
import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {useAccount, useChainId, usePublicClient, useWalletClient} from 'wagmi';
import {decodeErrorResult, encodeFunctionData, parseAbi} from 'viem';
import type {Hash} from 'viem';
import {abi as PatronAbi} from '@/lib/abis/Patron';
import {abi as CryptoPunksMarketAbi} from '@/lib/abis/CryptoPunksMarket';
import {classifyCarrierTier} from '@/lib/carrierTier';
import {waitForReceiptWithFallback} from '@/lib/wallet/waitForReceipt';
import {ConnectButton} from './ConnectButton';
import {LiveBidSweepMover, LiveBidUsd} from './LiveBidStat';
import {ProgressBar} from './ProgressBar';
import {getContractAddresses, getTokenTicker} from '@/lib/config';
import {useLiveBidBalance} from '@/lib/data/useLiveBidBalance';
import {
    formatEth,
    formatEthBare,
    formatPunk,
    formatRelative,
    formatTraitName,
    getEvmNowTxUrl,
    ratioPct,
} from '@/lib/format';
import type {Address, PunkEligibility, SoleCarrierConstraint, TraitGroup, TraitOption} from '@/lib/data/types';

const TICKER = getTokenTicker();

/** Frontend gate: the accept flow stays inactive until the live bid reaches
 *  this. It's a UI-only minimum (NOT an on-chain constant) — acceptBid has no
 *  such floor — so accepting isn't surfaced while the bid is too small to be
 *  worth putting a Punk through a 72-hour return auction for. The flow
 *  activates automatically once the polled live bid crosses it. */
const MIN_ACCEPT_BID_WEI = 20n * 10n ** 18n; // 20 ETH

interface Props {
    liveBidWei: string;
    asOfBlock: string;
    asOfTimestamp: string;
    marketAvailable: boolean;
    cheapestEligibleWei?: string;
    /** True CryptoPunks collection floor (cheapest publicly-listed Punk,
     *  regardless of eligibility). Shown in the review modal for context. */
    floorWei?: string;
    traitNames: readonly string[];
}

/** One of the caller's Punks that can be made permanent, with its protocol-
 *  derived target trait. Built client-side from the rarest-first `TraitOption[]`
 *  the server returns: the FIRST (rarest) option a Punk appears under is its
 *  canonical target — byte-identical to `PermanentCollection.canonicalTargetOf`,
 *  because the aggregation is sorted rarest-first and bakes in the sole-carrier
 *  rule. A Punk that appears in no option carries no eligible trait and is
 *  omitted entirely (its on-chain `canonicalTargetOf` would revert
 *  `NoEligibleTarget`). */
interface OwnedPunkTarget {
    punkId: number;
    /** Protocol-derived target — the rarest uncollected, non-pending trait the
     *  Punk carries. Read-only; the caller does not choose it. */
    canonicalTargetId: number;
    /** On-chain carrier count of the target trait across the 10,000-Punk
     *  dataset (lower = rarer). Drives the few-carrier notice. */
    carrierCount: number;
    /** Target trait's taxonomy group, for the doubly-rare Alien / Ape flag. */
    group: TraitGroup;
    /** True iff this Punk is the unique carrier of its target trait
     *  (carrierCount === 1) — the forced edge (#8348 / "7 Attributes"). */
    uniqueCarrier: boolean;
}

/** Status shape shared by the single-tx steps and the EIP-5792 batch step.
 *  `hash` is the on-chain tx hash when known (single calls have it from
 *  the moment they're submitted; batched calls populate it after the first
 *  receipt arrives). `bundleId` is set only on the batch path. */
type TxStatus =
    | {kind: 'idle'}
    | {kind: 'wallet'}
    | {kind: 'submitted'; hash?: Hash; bundleId?: string}
    | {kind: 'confirming'; hash?: Hash; bundleId?: string}
    | {kind: 'success'; hash?: Hash; bundleId?: string}
    | {kind: 'rejected'; message: string}
    | {kind: 'failed'; hash?: Hash; bundleId?: string; message: string};

/** Result of `wallet_getCapabilities` per chain — viem maps the raw spec
 *  values to `'ready' | 'supported' | 'unsupported'`. We treat `'ready'`
 *  (EIP-7702 already armed) and `'supported'` (wallet will upgrade on
 *  send) identically. `'unknown'` means we haven't asked yet (no wallet
 *  connected). */
type AtomicStatus = 'unknown' | 'ready' | 'supported' | 'unsupported';

export function AcceptBidFlow(props: Props) {
    const {traitNames} = props;
    const {address} = useAccount();
    const pub = usePublicClient();
    const {data: wallet} = useWalletClient();
    // Keep the headline "current live bid" live: seed from the SSR prop, then
    // track Patron.bidBalance() via the shared cached poll so it reflects any
    // trade — and, crucially, the drop after THIS acceptance debits the bid.
    // Only the BidSummary headline uses this; the rest of the flow keeps the
    // page-load `liveBidWei` (the price the seller lists + accepts at), which
    // must not move mid-acceptance.
    const {value: liveBidValue, pending: liveBidPending, refetch: refetchLiveBid} = useLiveBidBalance();

    // Punk-first acquire. The caller picks which of their Punks to make
    // permanent; the target trait is protocol-derived (canonicalTargetOf) and
    // shown read-only. `done` flips after a successful acceptance.
    // `targetTraitId` is the canonical target the tx machinery passes to
    // acceptBid — never a user choice.
    const [done, setDone] = useState(false);
    // True when `done` was reached because SOMEONE ELSE finalized the
    // permissionless accept (not this session's own accept tx). Drives the
    // reassuring "someone finalized it for you" success copy. See
    // `detectExternalFinalize`.
    const [finalizedExternally, setFinalizedExternally] = useState(false);
    const [eligibility, setEligibility] = useState<PunkEligibility | null>(null);
    const [eligibilityError, setEligibilityError] = useState<string | null>(null);
    const [resolving, setResolving] = useState(false);
    const [targetTraitId, setTargetTraitId] = useState<number | null>(null);

    // The caller's pickable Punks, each with its protocol-derived target.
    // `null` = not yet fetched / wallet not connected; `[]` = none eligible.
    const [punkTargets, setPunkTargets] = useState<OwnedPunkTarget[] | null>(null);
    const [punkSilhouettes, setPunkSilhouettes] = useState<Record<number, string>>({});
    // Punks the caller has already listed to Patron (acceptBid pre-listing) but
    // not yet accepted. Lets the picker mark a mid-flow Punk after a reload.
    const [listedPunkIds, setListedPunkIds] = useState<Set<number>>(new Set());
    const [optionsError, setOptionsError] = useState<string | null>(null);
    const [loadingOptions, setLoadingOptions] = useState(false);
    const [selectedPunkId, setSelectedPunkId] = useState<number | null>(null);

    // Picked-Punk silhouette for the confirm panel (set when a Punk's
    // eligibility resolves).
    const [pickedSvgInner, setPickedSvgInner] = useState<string>('');
    const [consentAcknowledged, setConsentAcknowledged] = useState(false);
    const [listTx, setListTx] = useState<TxStatus>({kind: 'idle'});
    const [acceptTx, setAcceptTx] = useState<TxStatus>({kind: 'idle'});
    const [batchTx, setBatchTx] = useState<TxStatus>({kind: 'idle'});
    const [claimTx, setClaimTx] = useState<TxStatus>({kind: 'idle'});
    // Undo the listing (market.punkNoLongerForSale) before accepting. Available
    // while the Punk is listed-but-not-accepted; irreversible once acceptBid
    // lands (the Punk is then in its return auction).
    const [cancelTx, setCancelTx] = useState<TxStatus>({kind: 'idle'});
    // The seller's collectable proceeds sitting in the 2017 market's
    // `pendingWithdrawals`. acceptBid credits this; the seller pulls it with
    // `market.withdraw()` in the Claim step. `null` = not yet read.
    const [pendingClaim, setPendingClaim] = useState<bigint | null>(null);
    const [atomicStatus, setAtomicStatus] = useState<AtomicStatus>('unknown');

    // ─── Interstitial review modal ───────────────────────────────────
    // Before the Punk-committing signature fires, a review modal shows the
    // Punk, its traits, the market floor, and the EXACT amount the seller will
    // receive. The amount (`committedListingWei`) is captured fresh when the
    // modal opens — a direct `bidBalance()` read for a fresh listing, or the
    // locked on-chain listing price for an already-listed Punk — and is the
    // same value every downstream tx uses, so what the seller reads is what
    // they sign. `reviewAction` is which tx the Confirm button fires.
    const [reviewOpen, setReviewOpen] = useState(false);
    const [reviewAction, setReviewAction] = useState<'list' | 'batch' | 'accept' | null>(null);
    const [committedListingWei, setCommittedListingWei] = useState<bigint | null>(null);
    // Freshest live bid read at modal-open — used only to warn when a stale page
    // would list above the current bid (which would make the accept revert).
    const [reviewCurrentBidWei, setReviewCurrentBidWei] = useState<bigint | null>(null);
    const [reviewLoading, setReviewLoading] = useState(false);
    const [reviewError, setReviewError] = useState<string | null>(null);

    const liveBidWei = BigInt(props.liveBidWei);
    const floorWei = props.floorWei ? BigInt(props.floorWei) : undefined;
    const cheapestEligibleWei = props.cheapestEligibleWei ? BigInt(props.cheapestEligibleWei) : undefined;
    // The price every committing tx uses: BOTH the listing price (what the Punk
    // is offered to the protocol for) AND acceptBid's `expectedListingWei`
    // overpay cap, so the protocol pays exactly this and the seller receives it
    // (via the market's `pendingWithdrawals`, collected in the Claim step). It's
    // the `committedListingWei` frozen when the review modal opened — fresher
    // than the page-load `liveBidWei`, captured the moment the seller commits —
    // falling back to the page-load value only if a tx ever fires without a
    // modal (it shouldn't; the modal is the gate).
    const expectedListing = committedListingWei ?? liveBidWei;
    // Headline value: the polled on-chain bid once it's loaded, falling back to
    // the SSR seed for first paint. Updates as trades land and after this
    // acceptance debits the bid.
    const displayLiveBidWei = liveBidValue ?? liveBidWei;
    // The accept flow is inactive until the live bid reaches the UI minimum.
    // Keyed off the polled value so it flips active the moment the bid crosses
    // the minimum, without a reload.
    const belowMinBid = displayLiveBidWei < MIN_ACCEPT_BID_WEI;

    // ─── EIP-5792 capability detection ───────────────────────────────
    // Coinbase Wallet, Safe, and EIP-7702-enabled MetaMask collapse the
    // two-call sequence (list + acceptBid) into a single user-facing
    // signing prompt. Older wallets fall back to the two-tx flow below.
    useEffect(() => {
        if (!wallet || !address || !wallet.chain) {
            setAtomicStatus('unknown');
            return;
        }
        let cancelled = false;
        wallet.getCapabilities({account: address, chainId: wallet.chain.id})
            .then((caps) => {
                if (cancelled) return;
                const s = (caps as {atomic?: {status?: string}} | undefined)?.atomic?.status;
                setAtomicStatus(s === 'ready' || s === 'supported' ? s : 'unsupported');
            })
            .catch(() => {
                if (cancelled) return;
                // `wallet_getCapabilities` not implemented — treat as unsupported.
                setAtomicStatus('unsupported');
            });
        return () => {
            cancelled = true;
        };
    }, [wallet, address]);

    // ─── Seller account-type detection ───────────────────────────────
    // The connected wallet is the seller here, and the 2017 market pays
    // sellers through `withdraw()`, which forwards ETH under a strict 2300-gas
    // `.transfer`. A smart-contract or EIP-7702-delegated account can run code
    // when it receives ETH and revert that withdrawal, which would strand the
    // proceeds AFTER the Punk is already in its return auction. Read the
    // account's code so the flow can warn before the seller commits the Punk:
    // an EOA has empty code, a 7702 delegation is the `0xef0100<address>`
    // designator, and anything else with code is a contract account.
    const [sellerAccount, setSellerAccount] =
        useState<'unknown' | 'eoa' | 'delegated' | 'contract'>('unknown');
    useEffect(() => {
        if (!pub || !address) {
            setSellerAccount('unknown');
            return;
        }
        let cancelled = false;
        pub.getCode({address})
            .then((code) => {
                if (cancelled) return;
                if (!code || code === '0x') {
                    setSellerAccount('eoa');
                } else {
                    setSellerAccount(
                        code.toLowerCase().startsWith('0xef0100') ? 'delegated' : 'contract',
                    );
                }
            })
            .catch(() => {
                // Read failed — stay silent rather than show a possibly-wrong
                // warning. The generic claim-error path still covers a withdraw
                // that fails.
                if (!cancelled) setSellerAccount('unknown');
            });
        return () => {
            cancelled = true;
        };
    }, [pub, address]);
    // True when the seller's wallet runs code on receive (a contract or a 7702
    // delegated account), so the market's 2300-gas `withdraw()` may revert and
    // leave the proceeds unclaimable.
    const sellerAtRisk = sellerAccount === 'delegated' || sellerAccount === 'contract';

    // ─── The caller's pickable Punks ─────────────────────────────────
    // One call per address change to /api/owned-trait-options. The server fans
    // out across the wallet's Punks (single multicall — no per-Punk RPC
    // fan-out), annotates rarity, and pre-renders the Punk silhouettes so the
    // client never needs the punks-sdk pixel bundle. We invert the rarest-first
    // trait→Punks shape into Punk→canonicalTarget here: the FIRST (rarest)
    // option a Punk appears under is its protocol-derived target, matching
    // canonicalTargetOf exactly. No new RPC, no per-render reads.
    useEffect(() => {
        // Skip the (10k-Punk-scan) owned-options lookup entirely while the flow
        // is inactive — no point reading the user's Punks when they can't
        // accept yet. Re-runs and fetches once the bid crosses the minimum.
        if (!address || belowMinBid) {
            setPunkTargets(null);
            setPunkSilhouettes({});
            setListedPunkIds(new Set());
            setOptionsError(null);
            return;
        }
        let cancelled = false;
        setLoadingOptions(true);
        setOptionsError(null);
        (async () => {
            try {
                const res = await fetch(`/api/owned-trait-options?owner=${address}`, {cache: 'no-store'});
                if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
                const data = (await res.json()) as {
                    options: TraitOption[];
                    punkSilhouettes: Record<string, string>;
                    listedPunkIds?: number[];
                };
                if (cancelled) return;
                const sil: Record<number, string> = {};
                for (const [k, v] of Object.entries(data.punkSilhouettes)) sil[Number(k)] = v;
                setPunkTargets(derivePunkTargets(data.options));
                setPunkSilhouettes(sil);
                setListedPunkIds(new Set(data.listedPunkIds ?? []));
            } catch (e) {
                if (cancelled) return;
                setOptionsError(e instanceof Error ? e.message : String(e));
            } finally {
                if (!cancelled) setLoadingOptions(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [address, belowMinBid]);

    // Resolve a chosen Punk's eligibility for the confirm panel (the
    // listedToPatron gate + silhouette + authoritative canonical target). The
    // target the tx sends comes from the eligibility's `canonicalTargetId`
    // (the contract's own derivation, re-read at confirm time) — never a click.
    // `fallbackTargetId` (from the list view) is used only if the response
    // somehow omits the field, so the confirm panel never renders blank.
    const selectPunk = useCallback(
        async (punkId: number, fallbackTargetId: number) => {
            setSelectedPunkId(punkId);
            setEligibility(null);
            setEligibilityError(null);
            setPickedSvgInner('');
            setTargetTraitId(null);
            setConsentAcknowledged(false);
            setFinalizedExternally(false);
            setListTx({kind: 'idle'});
            setAcceptTx({kind: 'idle'});
            setBatchTx({kind: 'idle'});
            setClaimTx({kind: 'idle'});
            setCancelTx({kind: 'idle'});
            setPendingClaim(null);
            setReviewOpen(false);
            setReviewAction(null);
            setCommittedListingWei(null);
            setReviewCurrentBidWei(null);
            setReviewError(null);
            setResolving(true);
            try {
                const url = `/api/eligibility?punkId=${punkId}${address ? `&caller=${address}` : ''}`;
                const res = await fetch(url, {cache: 'no-store'});
                if (!res.ok) throw new Error(`Eligibility lookup failed (${res.status})`);
                const wire = (await res.json()) as PunkEligibilityWire;
                const elig = decodeEligibility(wire);
                setEligibility(elig);
                setTargetTraitId(elig.canonicalTargetId ?? fallbackTargetId);
                if (wire.punkSvgInner) setPickedSvgInner(wire.punkSvgInner);
            } catch (e) {
                setEligibilityError(e instanceof Error ? e.message : String(e));
            } finally {
                setResolving(false);
            }
        },
        [address],
    );

    // Clear the whole selection back to the Punk list.
    const resetSelection = useCallback(() => {
        setSelectedPunkId(null);
        setEligibility(null);
        setEligibilityError(null);
        setTargetTraitId(null);
        setPickedSvgInner('');
        setConsentAcknowledged(false);
        setFinalizedExternally(false);
        setListTx({kind: 'idle'});
        setAcceptTx({kind: 'idle'});
        setBatchTx({kind: 'idle'});
        setClaimTx({kind: 'idle'});
        setCancelTx({kind: 'idle'});
        setPendingClaim(null);
        setReviewOpen(false);
        setReviewAction(null);
        setCommittedListingWei(null);
        setReviewCurrentBidWei(null);
        setReviewError(null);
    }, []);

    // Re-read the selected Punk's eligibility in place (after a cancel un-lists
    // it) without resetting the rest of the selection. Flips
    // `eligibility.listedToPatron` back to false so the list step re-arms.
    const refreshEligibility = useCallback(async () => {
        if (selectedPunkId === null) return;
        try {
            const url = `/api/eligibility?punkId=${selectedPunkId}${address ? `&caller=${address}` : ''}`;
            const res = await fetch(url, {cache: 'no-store'});
            if (!res.ok) return;
            const wire = (await res.json()) as PunkEligibilityWire;
            setEligibility(decodeEligibility(wire));
        } catch {
            // Non-fatal: leave the prior eligibility; the cancel tx still landed.
        }
    }, [selectedPunkId, address]);

    // Re-fetch the caller's pickable Punks (used after a target-shift revert,
    // so the UI re-derives the canonical targets from fresh state) and drop
    // the in-flight selection.
    const refetchTargets = useCallback(() => {
        resetSelection();
        if (!address) return;
        setLoadingOptions(true);
        setOptionsError(null);
        (async () => {
            try {
                const res = await fetch(`/api/owned-trait-options?owner=${address}`, {cache: 'no-store'});
                if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
                const data = (await res.json()) as {
                    options: TraitOption[];
                    punkSilhouettes: Record<string, string>;
                    listedPunkIds?: number[];
                };
                const sil: Record<number, string> = {};
                for (const [k, v] of Object.entries(data.punkSilhouettes)) sil[Number(k)] = v;
                setPunkTargets(derivePunkTargets(data.options));
                setPunkSilhouettes(sil);
                setListedPunkIds(new Set(data.listedPunkIds ?? []));
            } catch (e) {
                setOptionsError(e instanceof Error ? e.message : String(e));
            } finally {
                setLoadingOptions(false);
            }
        })();
    }, [address, resetSelection]);

    // ─── Permissionless-accept race detection ────────────────────────
    // acceptBid is permissionless: once a Punk is listed exclusively to
    // Patron, ANYONE can finalize it. A keeper or bot may accept the listed
    // Punk before the lister clicks their own Accept. That's a success, not a
    // failure — the protocol pays the same listed price into the seller's
    // market `pendingWithdrawals` no matter who pushed the button. The
    // eligibility endpoint's `alreadyRecorded` (custody left None) flips true
    // the instant the acquisition is recorded by anyone; when it does without
    // this session firing its own accept, we route into the same `done` success
    // state (which highlights Claim) and flag `finalizedExternally` for the
    // reassuring copy — instead of letting the now-doomed accept revert with a
    // confusing error. Returns whether the race was detected.
    const detectExternalFinalize = useCallback(async (): Promise<boolean> => {
        if (selectedPunkId === null || !address) return false;
        try {
            const res = await fetch(
                `/api/eligibility?punkId=${selectedPunkId}&caller=${address}`,
                {cache: 'no-store'},
            );
            if (!res.ok) return false;
            const wire = (await res.json()) as PunkEligibilityWire;
            if (wire.alreadyRecorded) {
                setFinalizedExternally(true);
                setDone(true);
                return true;
            }
        } catch {
            // Non-fatal — the interval poll / preflight will retry.
        }
        return false;
    }, [selectedPunkId, address]);
    // Stash in a ref so the narrow-dep tx-receipt watchers can call it without
    // widening their dependency arrays (which would tear them down on every
    // selection change and drop in-flight receipts — see the list-tx watcher).
    const detectExternalFinalizeRef = useRef(detectExternalFinalize);
    useEffect(() => {
        detectExternalFinalizeRef.current = detectExternalFinalize;
    }, [detectExternalFinalize]);

    // ─── Step 2: txs ──────────────────────────────────────────────────
    // (a) list to Patron at the live bid (a real price, exclusively to the
    //     protocol's contract). The protocol buys it for `expectedListing` in
    //     the accept step; listing at exactly the live bid stays inside the
    //     contract's 1% near-bid tolerance.
    const submitListTx = useCallback(async () => {
        if (!wallet || !address || !eligibility) return;
        const addrs = getContractAddresses();
        setListTx({kind: 'wallet'});
        try {
            const hash = await wallet.writeContract({
                abi: parseAbi([
                    'function offerPunkForSaleToAddress(uint256, uint256, address)',
                ]),
                address: addrs.punksMarket,
                functionName: 'offerPunkForSaleToAddress',
                args: [BigInt(eligibility.punkId), expectedListing, addrs.patron],
                account: address,
                chain: wallet.chain,
            });
            // Go straight to 'confirming' — the receipt watcher effect picks
            // up from here. See the effect below for why we don't transition
            // through 'submitted' inside the effect.
            setListTx({kind: 'confirming', hash});
        } catch (e) {
            setListTx({kind: 'rejected', message: classify(e)});
        }
    }, [wallet, address, eligibility, expectedListing]);

    // Watch list-tx receipt.
    //
    // The dep array is intentionally narrow — `[listTxConfirmingHash, pub]` —
    // so that kind→kind transitions the effect causes do NOT re-fire the
    // effect. If we depended on the whole `listTx` (or even on `listTx.kind`
    // alone), the `setListTx({kind:'success'})` call inside `.then` would
    // tear down THIS effect before the setState batch commits — the cleanup
    // sets `cancelled = true`, the .then's success transition fires after
    // the cleanup, and the UI silently sticks on "Confirming…" with the
    // receipt thrown away. That's issue #26.
    const listTxConfirmingHash = listTx.kind === 'confirming' ? listTx.hash : undefined;
    useEffect(() => {
        if (!listTxConfirmingHash || !pub) return;
        const hash = listTxConfirmingHash;
        let cancelled = false;
        waitForReceiptWithFallback(pub, hash)
            .then((r) => {
                if (cancelled) return;
                if (r.status === 'success') setListTx({kind: 'success', hash});
                else setListTx({kind: 'failed', hash, message: 'Listing reverted on-chain.'});
            })
            .catch((e) => {
                if (cancelled) return;
                setListTx({kind: 'failed', hash, message: classify(e)});
            });
        return () => {
            cancelled = true;
        };
    }, [listTxConfirmingHash, pub]);

    // Cancel/undo the listing: revoke the 2017-market offer to Patron via
    // `punkNoLongerForSale`. Available while the Punk is listed-but-not-accepted;
    // once acceptBid lands the Punk is in its return auction and there's nothing
    // to undo. On success the list step resets and eligibility re-reads so
    // `listedToPatron` flips back to false.
    const submitCancelTx = useCallback(async () => {
        if (!wallet || !address || !eligibility) return;
        setCancelTx({kind: 'wallet'});
        try {
            const hash = await wallet.writeContract({
                abi: parseAbi(['function punkNoLongerForSale(uint256)']),
                address: getContractAddresses().punksMarket,
                functionName: 'punkNoLongerForSale',
                args: [BigInt(eligibility.punkId)],
                account: address,
                chain: wallet.chain,
            });
            setCancelTx({kind: 'confirming', hash});
        } catch (e) {
            setCancelTx({kind: 'rejected', message: classify(e)});
        }
    }, [wallet, address, eligibility]);

    const cancelTxConfirmingHash = cancelTx.kind === 'confirming' ? cancelTx.hash : undefined;
    useEffect(() => {
        if (!cancelTxConfirmingHash || !pub) return;
        const hash = cancelTxConfirmingHash;
        let cancelled = false;
        waitForReceiptWithFallback(pub, hash)
            .then((r) => {
                if (cancelled) return;
                if (r.status === 'success') {
                    setCancelTx({kind: 'success', hash});
                    setListTx({kind: 'idle'});
                    void refreshEligibility();
                } else {
                    setCancelTx({kind: 'failed', hash, message: 'Cancel reverted on-chain.'});
                }
            })
            .catch((e) => {
                if (cancelled) return;
                setCancelTx({kind: 'failed', hash, message: classify(e)});
            });
        return () => {
            cancelled = true;
        };
    }, [cancelTxConfirmingHash, pub, refreshEligibility]);


    // (b) acceptBid
    const submitAcceptTx = useCallback(async () => {
        if (!wallet || !address || !eligibility || targetTraitId === null) return;
        const addrs = getContractAddresses();
        setAcceptTx({kind: 'wallet'});
        try {
            const hash = await wallet.writeContract({
                abi: PatronAbi,
                address: addrs.patron,
                functionName: 'acceptBid',
                // Second arg is the protocol-derived canonical target — the
                // contract reverts `NotCanonicalTarget` unless it matches
                // `canonicalTargetOf(punkId)` at inclusion. Third arg
                // `expectedListingWei`: overpay cap, hard-set to the live bid
                // (the price the user just listed at).
                args: [eligibility.punkId, targetTraitId, expectedListing],
                account: address,
                chain: wallet.chain,
            });
            // Straight to 'confirming' — see the list-tx submitter above
            // for the rationale.
            setAcceptTx({kind: 'confirming', hash});
        } catch (e) {
            // The wallet's gas estimation reverts if someone already finalized
            // the permissionless accept. Don't show that as a failure: confirm
            // against custody state and route to success / claim if it landed.
            // (A genuine user decline never records anything, so detect returns
            // false and the normal message shows.)
            if (!isUserDeclined(e) && (await detectExternalFinalize())) return;
            setAcceptTx({kind: 'rejected', message: classifyAcceptError(e, traitNames)});
        }
    }, [wallet, address, eligibility, targetTraitId, expectedListing, traitNames, detectExternalFinalize]);

    // `traitNames` is a static prop (the 111 canonical trait labels) but
    // including it in the effect dep would re-fire whenever the parent
    // re-renders with a fresh array identity. Stash it in a ref so the
    // .catch can read the latest without forcing a re-watch.
    const traitNamesRef = useRef(traitNames);
    useEffect(() => {
        traitNamesRef.current = traitNames;
    }, [traitNames]);

    // Accept-preflight: `eth_call`-simulate acceptBid before the button goes
    // active, so it can't be signed against a listing the node hasn't indexed
    // yet. Without this, clicking Accept the instant the listing lands fires
    // MetaMask's own gas-estimation against a stale view of the chain; acceptBid
    // reverts (the Punk isn't listed to Patron from that node's perspective) and
    // the wallet surfaces a raw, reasonless "no code" error. The simulate runs
    // here against our RPC, retries a few times (the listing may be a block
    // behind), and only flips to 'ready' when acceptBid would actually succeed.
    // Re-run via `preflightNonce` (the Retry affordance bumps it).
    type AcceptPreflight = 'idle' | 'checking' | 'ready' | {error: string};
    const [acceptPreflight, setAcceptPreflight] = useState<AcceptPreflight>('idle');
    const [preflightNonce, setPreflightNonce] = useState(0);
    const listingConfirmed =
        listTx.kind === 'success' || eligibility?.listedToPatron === true;
    useEffect(() => {
        // Prerequisites for a meaningful simulate. Anything missing → idle (the
        // button stays disabled on its own gate too).
        if (done || !pub || !address || !eligibility || targetTraitId === null) {
            setAcceptPreflight('idle');
            return;
        }
        if (!consentAcknowledged || !listingConfirmed) {
            setAcceptPreflight('idle');
            return;
        }
        const addrs = getContractAddresses();
        let cancelled = false;
        setAcceptPreflight('checking');
        void (async () => {
            // Up to 4 attempts ~1.2s apart: a freshly-mined listing can lag the
            // node the simulate hits by a block or two on a local fork.
            for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
                try {
                    await pub.simulateContract({
                        address: addrs.patron,
                        abi: PatronAbi,
                        functionName: 'acceptBid',
                        args: [eligibility.punkId, targetTraitId, expectedListing],
                        account: address,
                    });
                    if (!cancelled) setAcceptPreflight('ready');
                    return;
                } catch (e) {
                    if (attempt < 3) {
                        await new Promise((r) => setTimeout(r, 1200));
                        continue;
                    }
                    if (!cancelled) {
                        // The simulate may be reverting because the
                        // permissionless accept was already finalized by
                        // someone else. Confirm against custody state before
                        // surfacing a scary error — if it's recorded, route to
                        // the success / claim state instead.
                        const raced = await detectExternalFinalize();
                        if (!cancelled && !raced) {
                            setAcceptPreflight({error: classifyAcceptError(e, traitNamesRef.current)});
                        }
                    }
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [
        done,
        pub,
        address,
        eligibility,
        targetTraitId,
        expectedListing,
        consentAcknowledged,
        listingConfirmed,
        preflightNonce,
        detectExternalFinalize,
    ]);

    const acceptTxConfirmingHash = acceptTx.kind === 'confirming' ? acceptTx.hash : undefined;
    useEffect(() => {
        if (!acceptTxConfirmingHash || !pub) return;
        const hash = acceptTxConfirmingHash;
        let cancelled = false;
        waitForReceiptWithFallback(pub, hash)
            .then((r) => {
                if (cancelled) return;
                if (r.status === 'success') {
                    setAcceptTx({kind: 'success', hash});
                    setDone(true);
                } else {
                    // Mined-but-reverted: most likely someone finalized the
                    // permissionless accept first. Confirm before erroring —
                    // if it's recorded, the success / claim state takes over.
                    void detectExternalFinalizeRef.current().then((raced) => {
                        if (!cancelled && !raced) {
                            setAcceptTx({kind: 'failed', hash, message: 'acceptBid reverted on-chain.'});
                        }
                    });
                }
            })
            .catch((e) => {
                if (cancelled) return;
                void detectExternalFinalizeRef.current().then((raced) => {
                    if (!cancelled && !raced) {
                        setAcceptTx({
                            kind: 'failed',
                            hash,
                            message: classifyAcceptError(e, traitNamesRef.current),
                        });
                    }
                });
            });
        return () => {
            cancelled = true;
        };
    }, [acceptTxConfirmingHash, pub]);

    // Watch for an EXTERNAL finalize while the Punk is listed-but-unaccepted.
    // Runs only when a listing is confirmed, nothing is accepted yet, and no
    // accept of ours is mid-air (the tx-receipt watchers own `done` in that
    // case). Polls the authoritative custody state on an interval and re-checks
    // when the tab regains focus, so a keeper finalizing the bid surfaces as
    // success (→ Claim) without a reload — and the user never sees a doomed
    // accept button or a confusing revert. Self-cancels the instant it flips
    // `done`. One scoped read per ~12s while idling on the step; stops on
    // unmount / selection change / done.
    useEffect(() => {
        const acceptInFlight =
            acceptTx.kind === 'wallet' || acceptTx.kind === 'submitted' || acceptTx.kind === 'confirming' ||
            batchTx.kind === 'wallet' || batchTx.kind === 'submitted' || batchTx.kind === 'confirming';
        if (done || !listingConfirmed || selectedPunkId === null || !address || acceptInFlight) {
            return;
        }
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const loop = async () => {
            if (cancelled) return;
            const raced = await detectExternalFinalize();
            if (cancelled || raced) return;
            timer = setTimeout(() => void loop(), 12_000);
        };
        void loop();
        const onFocus = () => void detectExternalFinalize();
        window.addEventListener('focus', onFocus);
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            window.removeEventListener('focus', onFocus);
        };
    }, [
        done,
        listingConfirmed,
        selectedPunkId,
        address,
        acceptTx.kind,
        batchTx.kind,
        detectExternalFinalize,
    ]);

    // (c) Atomic batch: list + acceptBid in a single EIP-5792
    //     `wallet_sendCalls` bundle. The wallet collapses it to one user
    //     signature; on-chain it's either one tx (EIP-7702 / Safe) or two
    //     sequential txs (older wallets via viem's experimental fallback).
    const submitBatchTx = useCallback(async () => {
        if (!wallet || !address || !eligibility || targetTraitId === null) return;
        const addrs = getContractAddresses();
        setBatchTx({kind: 'wallet'});
        try {
            const listData = encodeFunctionData({
                abi: parseAbi([
                    'function offerPunkForSaleToAddress(uint256, uint256, address)',
                ]),
                functionName: 'offerPunkForSaleToAddress',
                args: [BigInt(eligibility.punkId), expectedListing, addrs.patron],
            });
            const acceptData = encodeFunctionData({
                abi: PatronAbi,
                functionName: 'acceptBid',
                args: [eligibility.punkId, targetTraitId, expectedListing],
            });
            const {id} = await wallet.sendCalls({
                account: address,
                chain: wallet.chain,
                calls: [
                    {to: addrs.punksMarket, data: listData},
                    {to: addrs.patron, data: acceptData},
                ],
            });
            // Straight to 'confirming' — see the list-tx / accept-tx watchers
            // above for why we don't transition through 'submitted' inside
            // the polling effect.
            setBatchTx({kind: 'confirming', bundleId: id});
        } catch (e) {
            setBatchTx({kind: 'rejected', message: classifyAcceptError(e, traitNames)});
        }
    }, [wallet, address, eligibility, targetTraitId, expectedListing, traitNames]);

    // Poll the bundle's status. `getCallsStatus` returns `pending` → `success`
    // / `failure` with the receipts attached; we lift the first receipt's
    // tx hash so the UI can link to a block explorer.
    const batchTxConfirmingBundleId =
        batchTx.kind === 'confirming' ? batchTx.bundleId : undefined;
    useEffect(() => {
        if (!batchTxConfirmingBundleId || !wallet) return;
        const id = batchTxConfirmingBundleId;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const poll = async () => {
            try {
                const result = await wallet.getCallsStatus({id});
                if (cancelled) return;
                const firstHash = result.receipts?.[0]?.transactionHash as Hash | undefined;
                if (result.status === 'success') {
                    setBatchTx({kind: 'success', bundleId: id, hash: firstHash});
                    setDone(true);
                    return;
                }
                if (result.status === 'failure') {
                    // Bundle reverted: the listed Punk may have been finalized
                    // by someone else first (the accept is permissionless).
                    // Confirm before erroring — a detected race flips to the
                    // success / claim state instead.
                    void detectExternalFinalizeRef.current().then((raced) => {
                        if (!cancelled && !raced) {
                            setBatchTx({
                                kind: 'failed',
                                bundleId: id,
                                hash: firstHash,
                                message: 'Bundle reverted on-chain.',
                            });
                        }
                    });
                    return;
                }
                // Pending — retry in 2s.
                timer = setTimeout(() => void poll(), 2_000);
            } catch (e) {
                if (cancelled) return;
                void detectExternalFinalizeRef.current().then((raced) => {
                    if (!cancelled && !raced) {
                        setBatchTx({
                            kind: 'failed',
                            bundleId: id,
                            message: classifyAcceptError(e, traitNamesRef.current),
                        });
                    }
                });
            }
        };
        void poll();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [batchTxConfirmingBundleId, wallet]);

    // ─── Step 2c / 3: claim ──────────────────────────────────────────
    // The seller is paid by the 2017 CryptoPunks market, not by the protocol.
    // `buyPunk` (inside acceptBid) credits the seller's `pendingWithdrawals` on
    // the market; the seller pulls it with `market.withdraw()`. Read that
    // balance for the connected wallet (the lister/seller here) so the Claim
    // step can show the collectable amount and activate once it's non-zero.
    const refreshPendingClaim = useCallback(async () => {
        if (!pub || !address) return;
        const addrs = getContractAddresses();
        try {
            const pending = (await pub.readContract({
                address: addrs.punksMarket,
                abi: CryptoPunksMarketAbi,
                functionName: 'pendingWithdrawals',
                args: [address],
            })) as bigint;
            setPendingClaim(pending);
        } catch {
            // Non-fatal: leave the prior value. The Claim step stays in its
            // current state; the user can retry by re-confirming.
        }
    }, [pub, address]);

    // Once acceptBid confirms (`done` flips), the seller's proceeds are sitting
    // in the market. Read them so the Claim step activates with the amount.
    useEffect(() => {
        if (!done) return;
        void refreshPendingClaim();
        // The acceptance debited Patron's bid — bust the cached live-bid
        // endpoint and refetch so the headline reflects the new balance now,
        // not after the next 12s poll.
        void refetchLiveBid();
    }, [done, refreshPendingClaim, refetchLiveBid]);

    const submitClaimTx = useCallback(async () => {
        if (!wallet || !address) return;
        setClaimTx({kind: 'wallet'});
        try {
            const hash = await wallet.writeContract({
                abi: CryptoPunksMarketAbi,
                address: getContractAddresses().punksMarket,
                functionName: 'withdraw',
                args: [],
                account: address,
                chain: wallet.chain,
            });
            // Straight to 'confirming' — see the list-tx submitter above for
            // the rationale (kind→kind transitions don't re-fire the watcher).
            setClaimTx({kind: 'confirming', hash});
        } catch (e) {
            setClaimTx({kind: 'rejected', message: classify(e)});
        }
    }, [wallet, address]);

    const claimTxConfirmingHash = claimTx.kind === 'confirming' ? claimTx.hash : undefined;
    useEffect(() => {
        if (!claimTxConfirmingHash || !pub) return;
        const hash = claimTxConfirmingHash;
        let cancelled = false;
        waitForReceiptWithFallback(pub, hash)
            .then((r) => {
                if (cancelled) return;
                if (r.status === 'success') {
                    setClaimTx({kind: 'success', hash});
                    // Proceeds collected — the market balance drops to 0.
                    setPendingClaim(0n);
                } else {
                    setClaimTx({kind: 'failed', hash, message: 'Withdrawal reverted on-chain.'});
                }
            })
            .catch((e) => {
                if (cancelled) return;
                setClaimTx({kind: 'failed', hash, message: classify(e)});
            });
        return () => {
            cancelled = true;
        };
    }, [claimTxConfirmingHash, pub]);

    // The Claim step is enabled only once the market actually holds proceeds
    // for the connected wallet (after acceptBid lands), and stays complete once
    // withdrawn. Visible (inactive) from the start so the seller understands
    // payment is pull-based.
    const claimReady = (pendingClaim ?? 0n) > 0n || claimTx.kind === 'success';
    // The whole flow is "done" (show the celebratory stage) only once the
    // seller has collected their proceeds — until then the confirm stage stays
    // up so the Claim step remains reachable.
    const claimDone = claimTx.kind === 'success';

    // Derived: should the UI offer the atomic single-popup path? Only when
    // the wallet supports it AND the list step is still required (already
    // listed → no batch benefit, fall back to the single acceptBid tx).
    const useAtomic =
        (atomicStatus === 'ready' || atomicStatus === 'supported') &&
        eligibility !== null &&
        !eligibility.listedToPatron;

    // True if any leg of the signing flow is mid-air. Disables the step 2
    // Back button so the user can't navigate away from a tx the wallet has
    // already broadcast (which would leave them confused about whether it
    // succeeded). Idle / success / rejected / failed are all safe to leave.
    const txInFlight =
        listTx.kind === 'wallet' || listTx.kind === 'submitted' || listTx.kind === 'confirming' ||
        acceptTx.kind === 'wallet' || acceptTx.kind === 'submitted' || acceptTx.kind === 'confirming' ||
        batchTx.kind === 'wallet' || batchTx.kind === 'submitted' || batchTx.kind === 'confirming' ||
        cancelTx.kind === 'wallet' || cancelTx.kind === 'submitted' || cancelTx.kind === 'confirming';

    // The live-bid minimum gates STARTING an acceptance — it must never tear
    // down a flow already in progress. An acceptance debits the bid by the
    // listed price (≈ the whole bid), so right after accepting, the polled
    // `belowMinBid` flips true; without this guard the entire flow — including
    // the still-unclaimed Claim step — would be replaced by the "not open yet"
    // notice, stranding the seller's proceeds. Only show that notice when the
    // user is truly idle: no Punk picked, nothing accepted, nothing to claim.
    const flowActive = selectedPunkId !== null || done || claimDone;
    const showInactiveGate = belowMinBid && !flowActive;

    // ─── Review modal ────────────────────────────────────────────────
    // The standalone accept step (sequential path) routes through the review
    // modal only when the Punk was listed in a PRIOR session — a fresh listing
    // already showed the modal at list time, so its follow-up accept fires
    // directly. A pre-listed Punk never saw the modal, so its accept opens it.
    const acceptNeedsReview = eligibility?.listedToPatron === true && listTx.kind !== 'success';

    // Open the interstitial review just before a Punk-committing signature.
    // Captures the price the protocol will pay (= what the seller receives)
    // FRESH at open — a direct `bidBalance()` read for a fresh listing, or the
    // locked on-chain listing price for an already-listed Punk — and freezes it
    // into `committedListingWei`, the value the fired tx uses. So the amount the
    // seller reviews is exactly the amount they sign for.
    const openReview = useCallback(
        async (action: 'list' | 'batch' | 'accept') => {
            if (!pub || !eligibility) return;
            setReviewAction(action);
            setReviewError(null);
            setReviewCurrentBidWei(null);
            setReviewLoading(true);
            setReviewOpen(true);
            const addrs = getContractAddresses();
            try {
                // The freshest live bid — for the staleness cross-check, and the
                // listing price itself on a fresh listing.
                const currentBid = (await pub.readContract({
                    address: addrs.patron,
                    abi: PatronAbi,
                    functionName: 'bidBalance',
                })) as bigint;
                setReviewCurrentBidWei(currentBid);
                if (action === 'accept') {
                    // Already listed in a prior session: the price is the locked
                    // on-chain listing, not the current bid. Read it so the modal
                    // shows what the seller will actually receive and the accept
                    // caps at exactly that.
                    const offer = (await pub.readContract({
                        address: addrs.punksMarket,
                        abi: CryptoPunksMarketAbi,
                        functionName: 'punksOfferedForSale',
                        args: [BigInt(eligibility.punkId)],
                    })) as unknown as readonly [boolean, bigint, Address, bigint, Address];
                    // [isForSale, punkIndex, seller, minValue, onlySellTo] —
                    // minValue (index 3) is the locked listing price.
                    setCommittedListingWei(offer[3]);
                } else {
                    // Fresh listing: we set the price, so list at — and pay the
                    // seller — the live bid as it stands the moment they commit.
                    setCommittedListingWei(currentBid);
                }
            } catch (e) {
                setReviewError(e instanceof Error ? e.message : String(e));
            } finally {
                setReviewLoading(false);
            }
        },
        [pub, eligibility],
    );

    const closeReview = useCallback(() => {
        setReviewOpen(false);
        setReviewAction(null);
        // Keep `committedListingWei`: a freshly-listed Punk's price stays frozen
        // for the follow-up accept. Cancelling simply fires no tx.
    }, []);

    // Fire the tx the modal was opened for. `committedListingWei` is already set
    // (the Confirm button stays disabled until the open-time read resolves), so
    // the submitters close over the exact reviewed price via `expectedListing`.
    const confirmReview = useCallback(() => {
        const action = reviewAction;
        setReviewOpen(false);
        if (action === 'list') void submitListTx();
        else if (action === 'batch') void submitBatchTx();
        else if (action === 'accept') void submitAcceptTx();
    }, [reviewAction, submitListTx, submitBatchTx, submitAcceptTx]);

    // ─── Render ──────────────────────────────────────────────────────

    return (
        <div className="flow">
            <BidSummary
                liveBidWei={displayLiveBidWei}
                pendingWei={liveBidPending}
                asOfTimestamp={BigInt(props.asOfTimestamp)}
                marketAvailable={props.marketAvailable}
                cheapestEligibleWei={cheapestEligibleWei}
            />

            {/* Permissionless "move pending → live bid" affordance. Self-shows
                only when the adapter holds buffered fees (the pending counter
                above is > 0); a single `LiveBidAdapter.sweep()` meters it into
                the live bid and pays the caller the keeper reward. */}
            <LiveBidSweepMover />

            {showInactiveGate ? (
                <Stage title="Accepting isn't open yet">
                    <p className="stage-copy">
                        Accepting the live bid opens once it reaches{' '}
                        <strong className="tnum">{formatEth(MIN_ACCEPT_BID_WEI)}</strong>. Right
                        now it&apos;s{' '}
                        <strong className="tnum">{formatEth(displayLiveBidWei)}</strong>. Every{' '}
                        {TICKER} trade grows the live bid, so this opens on its own as the bid
                        climbs.
                    </p>
                    <div className="stage-line">
                        <Link className="secondary" href="/trade">
                            Trade {TICKER}
                        </Link>
                    </div>
                </Stage>
            ) : (
            <>
            {address && sellerAtRisk && (
                <SellerAccountWarning kind={sellerAccount === 'delegated' ? 'delegated' : 'contract'} />
            )}

            {!address && (
                <Stage title="Connect to begin">
                    <p className="stage-copy">
                        Connect a wallet to see which of your Punks can accept the live bid.
                    </p>
                    <div className="stage-line">
                        <ConnectButton />
                    </div>
                </Stage>
            )}

            {address && !done && !belowMinBid && (
                <Stage title="Choose a Punk to make permanent">
                    <p className="stage-copy">
                        These are your Punks that carry a trait the collection hasn&apos;t made permanent yet.
                        Each Punk enters a 72-hour return auction. If the market doesn&apos;t return it, the Punk
                        goes to the vault and the protocol makes permanent the rarest uncollected trait it carries.
                        The protocol derives that trait — you don&apos;t pick it.
                    </p>
                    {loadingOptions && <p className="stage-note">Reading your Punks…</p>}
                    {optionsError && <p className="stage-error">{optionsError}</p>}
                    {punkTargets && !loadingOptions && punkTargets.length === 0 && (
                        <p className="stage-note">
                            None of your Punks carry a trait the collection still needs — every trait they carry is
                            already permanent or in an active return auction.
                        </p>
                    )}
                    {punkTargets && punkTargets.length > 0 && (
                        <div className="punk-target-grid" role="radiogroup" aria-label="Choose a Punk">
                            {punkTargets.map((pt) => (
                                <PunkTargetCard
                                    key={pt.punkId}
                                    target={pt}
                                    svgInner={punkSilhouettes[pt.punkId] ?? ''}
                                    traitNames={traitNames}
                                    listed={listedPunkIds.has(pt.punkId)}
                                    selected={selectedPunkId === pt.punkId}
                                    loading={resolving && selectedPunkId === pt.punkId}
                                    onSelect={() => void selectPunk(pt.punkId, pt.canonicalTargetId)}
                                />
                            ))}
                        </div>
                    )}
                    {eligibilityError && <p className="stage-error">{eligibilityError}</p>}
                </Stage>
            )}

            {address && !claimDone && eligibility && targetTraitId !== null && selectedPunkId !== null && !eligibilityError && (
                <Stage title={done ? 'Collect your ETH' : 'Confirm and sign'}>
                    <PickedPunkBadge
                        punkId={eligibility.punkId}
                        svgInner={pickedSvgInner}
                        uncollectedCount={eligibility.uncollectedBits.length}
                        targetTraitId={targetTraitId}
                        traitNames={traitNames}
                        marketContext={undefined}
                        liveBidWei={liveBidWei}
                        soldClaimWei={done ? (pendingClaim ?? committedListingWei ?? liveBidWei) : undefined}
                        onChange={resetSelection}
                    />
                    {done ? (
                        // acceptBid landed — the Punk is in its return auction. The
                        // phased steps stay put; this inline confirmation reads as
                        // a success and points hard at the one remaining action
                        // (collecting the proceeds) so the claim is never lost.
                        // What's waiting is the price the protocol PAID (the
                        // locked listing → market `pendingWithdrawals`), not the
                        // live bid, which keeps moving; fall back to the committed
                        // listing price until the on-chain claim read resolves.
                        <div className="accept-confirm" role="status">
                            <p className="accept-confirm-head">
                                {finalizedExternally
                                    ? `Someone finalized the bid for you. Anyone can, once a Punk is listed. ${formatPunk(eligibility.punkId)} is in its 72-hour return auction.`
                                    : `Accepted. ${formatPunk(eligibility.punkId)} is in its 72-hour return auction.`}
                            </p>
                            <p className="accept-confirm-body">
                                One step left: your{' '}
                                <strong className="tnum">
                                    {formatEth(pendingClaim ?? committedListingWei ?? liveBidWei)}
                                </strong>{' '}
                                is waiting in the CryptoPunks market. Collect it with the highlighted Claim step
                                below — the protocol can&apos;t pay you any other way.
                            </p>
                        </div>
                    ) : (
                        <DerivedTargetNote
                            punkId={eligibility.punkId}
                            traitId={targetTraitId}
                            traitNames={traitNames}
                        />
                    )}
                    {!done &&
                        (() => {
                            // The selected Punk's target metadata (carrier count
                            // + group) comes from the list view, which already
                            // holds the server-computed values. The few-carrier
                            // notice is non-blocking — it informs, it doesn't
                            // gate. Only render it when the list-view target
                            // still matches the confirm-time canonical target,
                            // so a target shift between fetches can never
                            // mislabel the carrier count.
                            const pt = punkTargets?.find((p) => p.punkId === selectedPunkId);
                            if (!pt || pt.canonicalTargetId !== targetTraitId) return null;
                            return (
                                <FewCarrierNotice
                                    carrierCount={pt.carrierCount}
                                    group={pt.group}
                                    traitId={targetTraitId}
                                    traitNames={traitNames}
                                />
                            );
                        })()}
                    {!done && (
                        <ConsentBlock
                            punkId={eligibility.punkId}
                            traitId={targetTraitId}
                            traitNames={traitNames}
                            liveBidWei={liveBidWei}
                            acknowledged={consentAcknowledged}
                            onToggle={() => setConsentAcknowledged((v) => !v)}
                        />
                    )}

                    <div className="tx-stack">
                        {useAtomic ? (
                            <TxStep
                                num="2"
                                label="Accept the bid (one signature)"
                                hint={`Lists your Punk to the protocol at the ${formatEth(liveBidWei)} live bid (no one else can buy it) and accepts the bid in one signing prompt. The protocol buys your Punk and starts the 72-hour return auction; your ${formatEth(liveBidWei)} waits in the market, collect it in the Claim step.`}
                                status={batchTx}
                                disabled={!consentAcknowledged || !address}
                                onSubmit={() => void openReview('batch')}
                                buttonLabel="Sign acceptance"
                            />
                        ) : (
                            <>
                                <TxStep
                                    num="2a"
                                    label={
                                        eligibility.listedToPatron
                                            ? 'Listed to the protocol (already done)'
                                            : 'List your Punk to the protocol'
                                    }
                                    hint={`Lists your Punk to the protocol at the live bid (${formatEth(liveBidWei)}), only to the protocol's contract, so no one else can buy it. You collect the ETH in the Claim step after the protocol buys it.`}
                                    status={eligibility.listedToPatron ? {kind: 'success'} : listTx}
                                    disabled={!consentAcknowledged || !address || eligibility.listedToPatron}
                                    onSubmit={() => void openReview('list')}
                                    buttonLabel="Sign list"
                                />
                                <TxStep
                                    num="2b"
                                    label="Accept the bid"
                                    hint={`The protocol buys your Punk at the listed price and starts the 72-hour return auction. Your ${formatEth(liveBidWei)} waits in the market — collect it with Claim below.`}
                                    status={acceptTx}
                                    // Gate on a PASSING preflight simulate, not
                                    // just on the listing being confirmed: the
                                    // node the wallet estimates against can lag
                                    // the listing by a block, and signing into
                                    // that gap fails with a raw wallet error.
                                    disabled={
                                        !consentAcknowledged ||
                                        !address ||
                                        acceptPreflight !== 'ready'
                                    }
                                    onSubmit={
                                        acceptNeedsReview
                                            ? () => void openReview('accept')
                                            : submitAcceptTx
                                    }
                                    buttonLabel="Sign accept"
                                />
                                {listingConfirmed && acceptPreflight === 'checking' && (
                                    <p className="preflight-note">
                                        Confirming the listing is on-chain before you sign…
                                    </p>
                                )}
                                {typeof acceptPreflight === 'object' && (
                                    <p className="preflight-note preflight-error">
                                        {acceptPreflight.error}{' '}
                                        <button
                                            type="button"
                                            className="preflight-retry"
                                            onClick={() => setPreflightNonce((n) => n + 1)}
                                        >
                                            Retry
                                        </button>
                                    </p>
                                )}
                            </>
                        )}
                        <TxStep
                            num={useAtomic ? '3' : '2c'}
                            label="Claim your ETH"
                            hint="The protocol doesn't pay you directly — the CryptoPunks market holds your proceeds after it buys your Punk. Collect them here. This unlocks once the protocol has bought your Punk."
                            status={claimTx}
                            disabled={!claimReady || !address}
                            // Once the accept has landed and proceeds are waiting,
                            // this is the one remaining action — accent it so it
                            // can't be mistaken for finished work. (This stage only
                            // renders while !claimDone, so claimTx isn't 'success'.)
                            highlight={done && claimReady}
                            onSubmit={submitClaimTx}
                            buttonLabel={
                                pendingClaim !== null && pendingClaim > 0n
                                    ? `Claim ${formatEthBare(pendingClaim)} ETH`
                                    : 'Claim your ETH'
                            }
                        />
                    </div>

                    {!done && (eligibility.listedToPatron || listTx.kind === 'success') && (
                        <div className="cancel-listing">
                            <p className="cancel-listing-copy">
                                Changed your mind? You can undo the listing any time before you accept.
                                This revokes the offer so no one can buy {formatPunk(eligibility.punkId)};
                                it becomes irreversible only once you accept the bid.
                            </p>
                            <div className="cancel-listing-line">
                                <button
                                    type="button"
                                    className="secondary"
                                    onClick={submitCancelTx}
                                    disabled={
                                        !address ||
                                        cancelTx.kind === 'wallet' ||
                                        cancelTx.kind === 'confirming' ||
                                        cancelTx.kind === 'success'
                                    }
                                >
                                    {cancelTx.kind === 'wallet'
                                        ? 'Confirm in wallet…'
                                        : cancelTx.kind === 'confirming'
                                          ? 'Cancelling…'
                                          : cancelTx.kind === 'success'
                                            ? 'Listing cancelled'
                                            : cancelTx.kind === 'rejected' || cancelTx.kind === 'failed'
                                              ? 'Retry cancel'
                                              : 'Cancel the listing'}
                                </button>
                                <span className="cancel-listing-status" aria-live="polite">
                                    {cancelTx.kind === 'confirming' && (
                                        <>
                                            Confirming on-chain… <TxRef hash={cancelTx.hash} />
                                        </>
                                    )}
                                    {cancelTx.kind === 'success' && 'Listing cancelled.'}
                                    {cancelTx.kind === 'rejected' && (
                                        <span className="error">{cancelTx.message}</span>
                                    )}
                                    {cancelTx.kind === 'failed' && (
                                        <span className="error">
                                            {cancelTx.message} <TxRef hash={cancelTx.hash} />
                                        </span>
                                    )}
                                </span>
                            </div>
                        </div>
                    )}

                    {sellerAtRisk && (claimTx.kind === 'failed' || claimTx.kind === 'rejected') && (
                        <SellerClaimRecovery
                            kind={sellerAccount === 'delegated' ? 'delegated' : 'contract'}
                        />
                    )}

                    {!done && <AtomicHint useAtomic={useAtomic} />}

                    {!done && (
                        <div className="stage-actions">
                            <button
                                type="button"
                                className="secondary"
                                disabled={txInFlight}
                                onClick={resetSelection}
                                title={txInFlight ? 'Waiting for your wallet — let the current signature finish first.' : undefined}
                            >
                                {txInFlight ? 'Signing in progress…' : 'Start over'}
                            </button>
                        </div>
                    )}

                    {!done &&
                        (() => {
                            const lastErr =
                                useAtomic && (batchTx.kind === 'rejected' || batchTx.kind === 'failed')
                                    ? batchTx
                                    : acceptTx.kind === 'rejected' || acceptTx.kind === 'failed'
                                      ? acceptTx
                                      : null;
                            if (!lastErr || !('message' in lastErr) || !isTargetShiftMessage(lastErr.message)) {
                                return null;
                            }
                            return (
                                <div className="trait-busy">
                                    <p>
                                        The target trait for this Punk shifted before your transaction landed. Refresh
                                        to re-read the current target and try again.
                                    </p>
                                    <button type="button" className="secondary" onClick={refetchTargets}>
                                        Refresh and start over
                                    </button>
                                </div>
                            );
                        })()}

                    {done && (
                        <div className="stage-actions">
                            <Link className="secondary" href={`/auction/${eligibility.punkId}`}>
                                View the auction
                            </Link>
                        </div>
                    )}

                    {!address && (
                        <div className="stage-line">
                            <span>Connect to sign.</span>
                            <ConnectButton />
                        </div>
                    )}
                </Stage>
            )}

            {claimDone && eligibility && (() => {
                // The acceptance that started the auction — the atomic batch on
                // EIP-5792 wallets, otherwise the standalone acceptBid. Either
                // carries the confirmed tx hash (the batch also a bundle id).
                const confirmedTx =
                    batchTx.kind === 'success' ? batchTx : acceptTx.kind === 'success' ? acceptTx : null;
                return (
                    <Stage title="Done">
                        <p className="stage-copy">
                            {formatPunk(eligibility.punkId)} is in a 72-hour return auction and your ETH is collected.
                            If no one bids above the reserve, the Punk goes to the vault and{' '}
                            {targetTraitId !== null ? (
                                <strong>{formatTraitName(targetTraitId, traitNames)}</strong>
                            ) : (
                                'its rarest uncollected trait'
                            )}{' '}
                            becomes permanent.{' '}
                            <Link className="derived-target-link" href="/faq#which-trait-becomes-permanent">
                                How the trait is chosen
                            </Link>
                            . You can watch the auction below.
                        </p>
                        {confirmedTx && (confirmedTx.hash || confirmedTx.bundleId) && (
                            <p className="stage-tx">
                                Acceptance confirmed.{' '}
                                <TxRef hash={confirmedTx.hash} bundleId={confirmedTx.bundleId} />
                            </p>
                        )}
                        {claimTx.kind === 'success' && claimTx.hash && (
                            <p className="stage-tx">
                                ETH collected.{' '}
                                <TxRef hash={claimTx.hash} />
                            </p>
                        )}
                        <div className="stage-actions">
                            <Link className="primary" href={`/auction/${eligibility.punkId}`}>
                                View the auction
                            </Link>
                            <Link className="secondary" href="/">
                                Back to home
                            </Link>
                        </div>
                    </Stage>
                );
            })()}
            </>
            )}

            {reviewOpen && eligibility && targetTraitId !== null && (
                <ReviewModal
                    action={reviewAction}
                    punkId={eligibility.punkId}
                    svgInner={pickedSvgInner}
                    mask={eligibility.mask}
                    targetTraitId={targetTraitId}
                    traitNames={traitNames}
                    receiveWei={committedListingWei}
                    currentBidWei={reviewCurrentBidWei}
                    floorWei={floorWei}
                    cheapestEligibleWei={cheapestEligibleWei}
                    loading={reviewLoading}
                    error={reviewError}
                    // The accept leg simulates before it can fire; the modal's
                    // Confirm waits on that preflight just like the inline button.
                    preflightChecking={reviewAction === 'accept' && acceptPreflight === 'checking'}
                    preflightError={
                        reviewAction === 'accept' && typeof acceptPreflight === 'object'
                            ? acceptPreflight.error
                            : null
                    }
                    confirmReady={reviewAction !== 'accept' || acceptPreflight === 'ready'}
                    onCancel={closeReview}
                    onConfirm={confirmReview}
                />
            )}

            <style>{styles}</style>
        </div>
    );
}

// ──────────────── Sub-components ────────────────

/** Context strip pinned above step 2: thumbnail + Punk ID + the protocol-
 *  derived target trait. The "Change Punk" affordance hands control back to
 *  step 1, blowing away the picked-Punk state so the next pick starts clean. */
function PickedPunkBadge({
    punkId,
    svgInner,
    uncollectedCount,
    targetTraitId,
    traitNames,
    marketContext,
    liveBidWei,
    soldClaimWei,
    onChange,
}: {
    punkId: number;
    svgInner: string;
    uncollectedCount: number;
    targetTraitId?: number;
    traitNames?: readonly string[];
    marketContext?: PunkMarketContext;
    liveBidWei: bigint;
    /** Set once the Punk is accepted: the price the protocol PAID (waiting in
     *  the market to claim). When present, the header shows this instead of the
     *  live bid, which keeps moving after the listing locks the price. */
    soldClaimWei?: bigint;
    onChange: () => void;
}) {
    return (
        <aside className="picked-punk" aria-label="Selected Punk">
            <div
                className="picked-punk-tile"
                aria-hidden="true"
                dangerouslySetInnerHTML={{
                    __html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">${svgInner}</svg>`,
                }}
            />
            <div className="picked-punk-body">
                <div className="picked-punk-head">
                    <span className="picked-punk-id">{formatPunk(punkId)}</span>
                    <button
                        type="button"
                        className="picked-punk-change"
                        onClick={onChange}
                    >
                        Change Punk
                    </button>
                </div>
                <div className="picked-punk-meta">
                    {targetTraitId !== undefined && traitNames
                        ? `Permanent trait: ${formatTraitName(targetTraitId, traitNames)}`
                        : `${uncollectedCount} uncollected trait${uncollectedCount === 1 ? '' : 's'}`}
                </div>
                <div className="picked-punk-market">
                    <span>
                        {soldClaimWei !== undefined ? 'You collect' : 'Patron offer'}{' '}
                        <strong className="tnum">{formatEth(soldClaimWei ?? liveBidWei)}</strong>
                    </span>
                    {marketContext?.bidWei !== undefined && (
                        <span>
                            · open-market bid{' '}
                            <strong className="tnum">{formatEth(marketContext.bidWei)}</strong>
                        </span>
                    )}
                    {marketContext?.listingWei !== undefined && (
                        <span>
                            · your listing{' '}
                            <strong className="tnum">{formatEth(marketContext.listingWei)}</strong>
                        </span>
                    )}
                </div>
            </div>
        </aside>
    );
}

/** Per-Punk 2017-market context surfaced beneath the picked Punk. */
interface PunkMarketContext {
    /** Highest standing bid on the open 2017 market, in wei. */
    bidWei?: bigint;
    /** Public listing the owner has up for sale (if any), in wei. */
    listingWei?: bigint;
}

/** The read-only "this is the trait the protocol will make permanent"
 *  statement on the confirm panel. The target is derived, not chosen — this
 *  note exists to make that explicit. */
function DerivedTargetNote({
    punkId,
    traitId,
    traitNames,
}: {
    punkId: number;
    traitId: number;
    traitNames: readonly string[];
}) {
    return (
        <p className="derived-target" aria-live="polite">
            If {formatPunk(punkId)} isn&apos;t returned, the protocol makes{' '}
            <strong>{formatTraitName(traitId, traitNames)}</strong> permanent, the rarest uncollected trait this
            Punk carries. The protocol derives this target; you don&apos;t choose it.{' '}
            <Link className="derived-target-link" href="/faq#which-trait-becomes-permanent">
                How the trait is chosen
            </Link>
            .
        </p>
    );
}

/** Non-blocking notice when the protocol-derived target is a few-carrier trait.
 *  These traits have no on-chain target guard (only the single rarity-1 carrier
 *  does), so the notice explains what's at stake without gating the flow: very
 *  few Punks carry the trait, and for the Alien / Ape clusters the type and head
 *  share carriers, so this Punk is the only route to two permanent traits. */
function FewCarrierNotice({
    carrierCount,
    group,
    traitId,
    traitNames,
}: {
    carrierCount: number;
    group: TraitGroup;
    traitId: number;
    traitNames: readonly string[];
}) {
    const {tier, doublyRare} = classifyCarrierTier(carrierCount, group);
    if (tier !== 'few') return null;
    const traitName = formatTraitName(traitId, traitNames);
    return (
        <aside className="few-carrier" aria-label="Few-carrier trait notice">
            <p className="few-carrier-head">
                <strong>{traitName}</strong> is a rare trait. Only {carrierCount} of the 10,000 Punks carry it.
            </p>
            {doublyRare ? (
                <p className="few-carrier-body">
                    The Alien and Ape clusters are scarcer still: a Punk&apos;s type and head share the same few
                    carriers, so this Punk is one of the only routes to two permanent traits. The protocol makes just
                    the rarest one permanent when it&apos;s vaulted, so handle this Punk deliberately.
                </p>
            ) : (
                <p className="few-carrier-body">
                    Once a carrier is vaulted, the protocol makes just this one trait permanent. With so few carriers,
                    there&apos;s little margin to bring it in later, so handle this Punk deliberately.
                </p>
            )}
        </aside>
    );
}

/** One selectable Punk in the Punk-first list: silhouette + Punk ID + the
 *  protocol-derived target trait it will be made permanent for. The target is
 *  read-only — it labels the card, it isn't a control. */
function PunkTargetCard({
    target,
    svgInner,
    traitNames,
    listed,
    selected,
    loading,
    onSelect,
}: {
    target: OwnedPunkTarget;
    svgInner: string;
    traitNames: readonly string[];
    /** This Punk is already listed to the protocol (acceptBid pre-listing) —
     *  shown so a reload mid-flow surfaces the in-progress state. */
    listed: boolean;
    selected: boolean;
    loading: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            data-punk-id={target.punkId}
            className={`punk-target${selected ? ' punk-target-on' : ''}${loading ? ' punk-target-loading' : ''}${listed ? ' punk-target-listed' : ''}`}
            onClick={onSelect}
        >
            <div
                className="punk-target-tile"
                aria-hidden="true"
                dangerouslySetInnerHTML={{
                    __html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">${svgInner}</svg>`,
                }}
            />
            <div className="punk-target-label">
                <span className="punk-target-id">
                    {formatPunk(target.punkId)}
                    {listed && <span className="punk-target-flag">listed · resume</span>}
                </span>
                <span className="punk-target-trait">
                    {formatTraitName(target.canonicalTargetId, traitNames)}
                    {target.uniqueCarrier ? (
                        <span className="punk-target-badge">only carrier</span>
                    ) : (
                        classifyCarrierTier(target.carrierCount, target.group).tier === 'few' && (
                            <span className="punk-target-badge punk-target-badge-rare">rare trait</span>
                        )
                    )}
                </span>
            </div>
        </button>
    );
}

function BidSummary({
    liveBidWei,
    pendingWei,
    asOfTimestamp,
    marketAvailable,
    cheapestEligibleWei,
}: {
    liveBidWei: bigint;
    /** Fee ETH buffered in the LiveBidAdapter, not yet metered into the live
     *  bid — surfaced so the seller can see more is on the way. */
    pendingWei?: bigint;
    asOfTimestamp: bigint;
    marketAvailable: boolean;
    cheapestEligibleWei?: bigint;
}) {
    const pct = marketAvailable && cheapestEligibleWei !== undefined
        ? ratioPct(liveBidWei, cheapestEligibleWei)
        : null;
    return (
        <div className="summary">
            <div className="summary-header">
                <div className="bid-label">current live bid</div>
            </div>
            <div className="summary-value tnum">{formatEth(liveBidWei)}</div>
            {/* "≈ $X" dollar annotation — same polled live-bid read as
             *  `displayLiveBidWei` above, priced at the shared ETH/USD spot. */}
            <LiveBidUsd initialWei={liveBidWei.toString()} />
            {pendingWei !== undefined && pendingWei > 0n && (
                <p className="summary-pending tnum">
                    +{formatEth(pendingWei)} pending — buffered fees metering into the bid
                </p>
            )}
            {marketAvailable && cheapestEligibleWei !== undefined && (
                <ProgressBar
                    liveBidWei={liveBidWei}
                    cheapestEligibleWei={cheapestEligibleWei}
                    marketAvailable={marketAvailable}
                />
            )}
            {pct !== null && (
                <p className="summary-note">
                    {pct.toFixed(1)}% of the cheapest listed eligible Punk.
                    Updated {formatRelative(asOfTimestamp)}.
                </p>
            )}
        </div>
    );
}

function Stage({
    title,
    children,
    inactive,
}: {
    title: string;
    children: React.ReactNode;
    /** Dims the stage and marks it pending — used for steps that are visible
     *  from the start but not yet actionable. */
    inactive?: boolean;
}) {
    const titleId = useId();
    return (
        <section
            className={`stage${inactive ? ' stage-inactive' : ''}`}
            aria-labelledby={titleId}
        >
            <h2 id={titleId} className="stage-title">{title}</h2>
            {children}
        </section>
    );
}

function ConsentBlock({
    punkId,
    traitId,
    traitNames,
    liveBidWei,
    acknowledged,
    onToggle,
}: {
    punkId: number;
    traitId: number;
    traitNames: readonly string[];
    liveBidWei: bigint;
    acknowledged: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="consent-block" aria-label="Acceptance consent">
            <h3 className="consent-title">Read this before you sign.</h3>
            <ul>
                <li>
                    You will receive <strong>{formatEth(liveBidWei)}</strong> when {formatPunk(punkId)} enters the
                    return auction.
                </li>
                <li>
                    The auction lasts 72 hours. Anyone can bid above {formatEth((liveBidWei * 101n) / 100n)} (the
                    opening reserve) to <strong>return your Punk to the market</strong>.
                </li>
                <li>
                    If no one bids above the reserve, {formatPunk(punkId)} goes to the vault forever and{' '}
                    <strong>{formatTraitName(traitId, traitNames)} becomes permanent</strong>.
                </li>
                <li>
                    There is no undo. The vault has no withdrawal path.
                </li>
            </ul>
            <label className="consent-toggle">
                <input type="checkbox" checked={acknowledged} onChange={onToggle} />
                <span>
                    I understand. I want to accept the bid for {formatPunk(punkId)}, which makes{' '}
                    {formatTraitName(traitId, traitNames)} permanent if it isn&apos;t returned.
                </span>
            </label>
        </div>
    );
}

function TxStep({
    num,
    label,
    hint,
    status,
    disabled,
    onSubmit,
    buttonLabel,
    highlight = false,
}: {
    num: string;
    label: string;
    hint: string;
    status: TxStatus;
    disabled: boolean;
    onSubmit: () => void;
    buttonLabel: string;
    /** Accent the step as the single remaining action (used for the Claim step
     *  once the accept has landed and proceeds are waiting). */
    highlight?: boolean;
}) {
    return (
        <div className={`tx-step status-${status.kind}${highlight ? ' tx-step-highlight' : ''}`}>
            <div className="tx-step-head">
                <span className="tx-step-num">{num}</span>
                <span className="tx-step-label">{label}</span>
                {highlight && <span className="tx-step-next">next step</span>}
            </div>
            <p className="tx-step-hint">{hint}</p>
            <div className="tx-step-line">
                <button
                    type="button"
                    className="secondary"
                    disabled={disabled || status.kind === 'wallet' || status.kind === 'submitted' || status.kind === 'confirming' || status.kind === 'success'}
                    onClick={onSubmit}
                >
                    {buttonLabelFor(status, buttonLabel)}
                </button>
                <span className="tx-step-status" aria-live="polite">
                    {statusLine(status)}
                </span>
            </div>
        </div>
    );
}

function buttonLabelFor(s: TxStatus, fallback: string): string {
    switch (s.kind) {
        case 'wallet':
            return 'Confirm in wallet…';
        case 'submitted':
            return 'Submitting…';
        case 'confirming':
            return 'Confirming…';
        case 'success':
            return 'Signed';
        case 'rejected':
        case 'failed':
            return 'Retry';
        default:
            return fallback;
    }
}

function statusLine(s: TxStatus): React.ReactNode {
    switch (s.kind) {
        case 'idle':
            return '';
        case 'wallet':
            return 'Waiting on your wallet…';
        case 'submitted':
            return (
                <>
                    Submitted. <TxRef hash={s.hash} bundleId={s.bundleId} />
                </>
            );
        case 'confirming':
            return (
                <>
                    Confirming on-chain… <TxRef hash={s.hash} bundleId={s.bundleId} />
                </>
            );
        case 'success':
            return (
                <>
                    Confirmed. <TxRef hash={s.hash} bundleId={s.bundleId} />
                </>
            );
        case 'rejected':
            return <span className="error">{s.message}</span>;
        case 'failed':
            return (
                <span className="error">
                    {s.message} <TxRef hash={s.hash} bundleId={s.bundleId} />
                </span>
            );
    }
}

function TxRef({hash, bundleId}: {hash?: Hash; bundleId?: string}) {
    const chainId = useChainId();
    if (hash && hash !== ('0x' as Hash)) {
        return (
            <a
                href={getEvmNowTxUrl(hash, chainId)}
                target="_blank"
                rel="noreferrer"
                className="tx-link"
            >
                view tx
            </a>
        );
    }
    if (bundleId) {
        const short = bundleId.length > 16 ? `${bundleId.slice(0, 10)}…${bundleId.slice(-4)}` : bundleId;
        return <span className="tx-bundle">bundle {short}</span>;
    }
    return null;
}

function AtomicHint({useAtomic}: {useAtomic: boolean}) {
    if (!useAtomic) return null;
    return (
        <p className="atomic-hint" aria-live="polite">
            Your wallet supports atomic batching, so listing and acceptance fit in one signature.
        </p>
    );
}

/** Shown when the connected wallet (the seller) is a smart-contract or
 *  EIP-7702-delegated account. The 2017 market pays sellers through
 *  `withdraw()`, a 2300-gas `.transfer` that such accounts can revert — which
 *  would leave the proceeds stuck after the Punk is already in its return
 *  auction. We surface this before the seller commits, because by claim time
 *  the Punk is gone. It informs; it doesn't block (a contract that can accept a
 *  plain transfer is fine, and the seller may know their setup). */
function SellerAccountWarning({kind}: {kind: 'delegated' | 'contract'}) {
    return (
        <aside className="seller-warning" role="alert">
            <h3 className="seller-warning-title">Your wallet may not be able to collect.</h3>
            <p className="seller-warning-body">
                {kind === 'delegated'
                    ? 'This wallet is an EIP-7702 delegated account.'
                    : 'This wallet is a smart-contract account.'}{' '}
                The CryptoPunks market pays sellers through <code>withdraw()</code>, which forwards
                your ETH under a strict 2300-gas limit. An account that runs code when it receives ETH
                can make that withdrawal revert, and the protocol can&apos;t pay you any other way. Your
                Punk would already be in its 72-hour return auction, so the proceeds would sit
                unclaimable in the market.
            </p>
            <p className="seller-warning-body">
                The safe path is to accept from a plain wallet that isn&apos;t delegated or a contract.
                If you continue with this one and the Claim step fails, you can still collect by
                removing the delegation, or by claiming from an account that accepts a plain transfer.
            </p>
        </aside>
    );
}

/** Recovery guidance shown if the Claim withdrawal actually fails for a
 *  smart-contract / delegated seller. The acceptance has already landed, so the
 *  proceeds are real and waiting in the market; the seller just needs an account
 *  the market's 2300-gas payment can reach. */
function SellerClaimRecovery({kind}: {kind: 'delegated' | 'contract'}) {
    return (
        <aside className="seller-warning" role="alert">
            <h3 className="seller-warning-title">The withdrawal didn&apos;t go through.</h3>
            <p className="seller-warning-body">
                Your proceeds are safe in the CryptoPunks market. The withdrawal reverted because{' '}
                {kind === 'delegated'
                    ? 'this wallet has an EIP-7702 delegation'
                    : 'this wallet is a contract'}{' '}
                that the market&apos;s 2300-gas payment can&apos;t reach.{' '}
                {kind === 'delegated'
                    ? 'Remove the delegation from this wallet, then run Claim again.'
                    : 'Claim from an account that can receive a plain transfer; the market lets the owed address withdraw at any time.'}
            </p>
        </aside>
    );
}

/** Interstitial review shown right before a Punk-committing signature. The final
 *  cross-check: the Punk and its traits, the collection floor + cheapest eligible
 *  Punk for context, and — triple-checked — the EXACT amount the seller receives,
 *  which is the same `committedListingWei` the fired tx uses (display == tx). */
function ReviewModal({
    action,
    punkId,
    svgInner,
    mask,
    targetTraitId,
    traitNames,
    receiveWei,
    currentBidWei,
    floorWei,
    cheapestEligibleWei,
    loading,
    error,
    preflightChecking,
    preflightError,
    confirmReady,
    onCancel,
    onConfirm,
}: {
    action: 'list' | 'batch' | 'accept' | null;
    punkId: number;
    svgInner: string;
    mask: bigint;
    targetTraitId: number;
    traitNames: readonly string[];
    /** What the seller receives = the price the tx uses. Null until the
     *  open-time read resolves (Confirm stays disabled meanwhile). */
    receiveWei: bigint | null;
    /** Freshest live bid at open, for the stale-listing warning. */
    currentBidWei: bigint | null;
    floorWei?: bigint;
    cheapestEligibleWei?: bigint;
    loading: boolean;
    error: string | null;
    preflightChecking: boolean;
    preflightError: string | null;
    confirmReady: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const titleId = useId();
    const confirmRef = useRef<HTMLButtonElement>(null);
    // Esc cancels; focus the confirm button on open (matches the other dialogs).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        document.addEventListener('keydown', onKey);
        confirmRef.current?.focus();
        return () => document.removeEventListener('keydown', onKey);
    }, [onCancel]);

    const traitBits = traitBitsFromMask(mask);
    // A stale page that would list above the live bid makes the accept revert
    // (`ListingExceedsBid` / `ListingAboveExpected`). Only meaningful once both
    // reads resolve; for a fresh listing receive == currentBid so it never fires.
    const bidShortfall =
        receiveWei !== null && currentBidWei !== null && currentBidWei < receiveWei;
    const confirmLabel =
        action === 'batch'
            ? 'List and accept'
            : action === 'list'
              ? 'List to the protocol'
              : 'Accept the bid';
    const blocked =
        loading || receiveWei === null || bidShortfall || !confirmReady || error !== null;

    return (
        <div
            className="review-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => {
                if (e.target === e.currentTarget) onCancel();
            }}
        >
            <div className="review-card">
                <h2 id={titleId} className="review-title">Review before you sign.</h2>

                <div className="review-punk">
                    <div
                        className="review-punk-tile"
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{
                            __html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">${svgInner}</svg>`,
                        }}
                    />
                    <div className="review-punk-body">
                        <span className="review-punk-id">{formatPunk(punkId)}</span>
                        <div className="review-traits">
                            {traitBits.map((bit) => (
                                <span
                                    key={bit}
                                    className={`review-trait${bit === targetTraitId ? ' review-trait-target' : ''}`}
                                >
                                    {formatTraitName(bit, traitNames)}
                                    {bit === targetTraitId && <span className="review-trait-tag">target</span>}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="review-figures">
                    <div className="review-figure review-figure-primary">
                        <span className="review-figure-label">You receive</span>
                        <span className="review-figure-value tnum">
                            {loading || receiveWei === null ? 'reading…' : formatEth(receiveWei)}
                        </span>
                    </div>
                    <div className="review-figure">
                        <span className="review-figure-label">Collection floor</span>
                        <span className="review-figure-value tnum">
                            {floorWei !== undefined ? formatEth(floorWei) : '—'}
                        </span>
                    </div>
                    <div className="review-figure">
                        <span className="review-figure-label">Cheapest eligible</span>
                        <span className="review-figure-value tnum">
                            {cheapestEligibleWei !== undefined ? formatEth(cheapestEligibleWei) : '—'}
                        </span>
                    </div>
                </div>

                <p className="review-copy">
                    {action === 'accept'
                        ? 'This Punk is already listed to the protocol. Accepting starts its 72-hour return auction; you collect the listed price from the CryptoPunks market afterward.'
                        : 'Your Punk lists exclusively to the protocol at this price and the protocol buys it, starting a 72-hour return auction. You collect the ETH from the CryptoPunks market afterward.'}
                </p>

                {bidShortfall && currentBidWei !== null && (
                    <p className="review-warning">
                        The live bid has fallen to <strong className="tnum">{formatEth(currentBidWei)}</strong> since
                        this Punk was listed — below the listed price, so the accept would revert. Reload the page to
                        accept at the current bid.
                    </p>
                )}
                {error && <p className="review-warning">{error}</p>}
                {preflightError && <p className="review-warning">{preflightError}</p>}

                <div className="review-actions">
                    <button type="button" className="secondary" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        ref={confirmRef}
                        type="button"
                        className="primary"
                        disabled={blocked}
                        onClick={onConfirm}
                    >
                        {loading
                            ? 'Reading the bid…'
                            : preflightChecking
                              ? 'Checking the listing…'
                              : confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ──────────────── Helpers ────────────────

/** All trait bits set on a Punk's mask (indices 0..110), ascending. Drives the
 *  trait chips in the review modal. */
function traitBitsFromMask(mask: bigint): number[] {
    const bits: number[] = [];
    for (let i = 0; i < 111; i++) {
        if (((mask >> BigInt(i)) & 1n) === 1n) bits.push(i);
    }
    return bits;
}

/** Invert the rarest-first `TraitOption[]` into one row per pickable Punk with
 *  its protocol-derived target trait. The FIRST (rarest) option a Punk appears
 *  under is its `canonicalTargetOf` — the aggregation is already sorted
 *  rarest-first and bakes in the sole-carrier rule, so the rarest option a Punk
 *  is offered under equals the contract's canonical target. Punks that appear
 *  in no option carry no eligible trait and are omitted (their on-chain
 *  `canonicalTargetOf` would revert `NoEligibleTarget`). Result is sorted by
 *  Punk id for a stable grid. */
function derivePunkTargets(options: readonly TraitOption[]): OwnedPunkTarget[] {
    // options are rarest-first; the first time we see a Punk is its rarest
    // (= canonical) target.
    const byPunk = new Map<number, OwnedPunkTarget>();
    for (const opt of options) {
        for (const punkId of opt.punkIds) {
            if (byPunk.has(punkId)) continue;
            byPunk.set(punkId, {
                punkId,
                canonicalTargetId: opt.traitId,
                carrierCount: opt.carrierCount,
                group: opt.group,
                uniqueCarrier: opt.uniqueCarrier,
            });
        }
    }
    return [...byPunk.values()].sort((a, b) => a.punkId - b.punkId);
}

interface PunkEligibilityWire {
    punkId: number;
    owner: string;
    caller?: string;
    isOwnedByCaller: boolean;
    mask: string;
    uncollectedBits: number[];
    pendingBits: number[];
    /** Protocol-derived target (canonicalTargetOf mirror). May be absent on an
     *  older API response; the flow falls back to the list-view target. */
    canonicalTargetId?: number;
    listedToPatron: boolean;
    alreadyRecorded: boolean;
    /** Server-rendered SVG inner-content of the picked Punk's silhouette,
     *  used in the step 2 context strip. Optional so older API responses
     *  don't break the flow. */
    punkSvgInner?: string;
    /** Per-uncollected-bit trait tile inner SVG, anchored to *this* Punk's
     *  pixels. Keyed by traitId as string for JSON transport. */
    traitTilesByBit?: Record<string, string>;
    /** Sole-carrier guard (hard invariant #22). Optional so an older API
     *  response degrades to "unconstrained" rather than breaking the flow. */
    soleCarrier?: SoleCarrierConstraint;
}

function decodeEligibility(wire: PunkEligibilityWire): PunkEligibility {
    return {
        punkId: wire.punkId,
        owner: wire.owner as Address,
        caller: wire.caller as Address | undefined,
        isOwnedByCaller: wire.isOwnedByCaller,
        mask: BigInt(wire.mask),
        uncollectedBits: wire.uncollectedBits,
        pendingBits: wire.pendingBits,
        canonicalTargetId: wire.canonicalTargetId,
        listedToPatron: wire.listedToPatron,
        alreadyRecorded: wire.alreadyRecorded,
        soleCarrier: wire.soleCarrier ?? {required: false, requiredTraitId: 0},
    };
}

function classify(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    if (/user rejected|user denied/i.test(msg)) return 'You declined in your wallet.';
    if (/insufficient funds/i.test(msg)) return 'Not enough ETH for gas.';
    return msg;
}

/** Extract a 0x-prefixed `data:` field from a viem error chain — that's the
 *  raw revert data we need for `decodeErrorResult`. */
function extractRevertData(e: unknown): `0x${string}` | undefined {
    if (!e || typeof e !== 'object') return undefined;
    const candidates: unknown[] = [e];
    while (candidates.length > 0) {
        const cur = candidates.shift();
        if (!cur || typeof cur !== 'object') continue;
        const obj = cur as Record<string, unknown>;
        if (typeof obj.data === 'string' && obj.data.startsWith('0x')) {
            return obj.data as `0x${string}`;
        }
        if (obj.cause) candidates.push(obj.cause);
        if (Array.isArray(obj.metaMessages)) {
            // viem sometimes carries the data inline in metaMessages.
            for (const m of obj.metaMessages) {
                if (typeof m === 'string') {
                    const match = m.match(/0x[0-9a-fA-F]{8,}/);
                    if (match) return match[0] as `0x${string}`;
                }
            }
        }
    }
    return undefined;
}

/** Walk a viem error chain looking for an already-decoded custom revert.
 *  In viem 2.x, `ContractFunctionRevertedError` exposes the decoded result
 *  at `cause.data = {abiItem, args, errorName}` (an object, not a hex
 *  string), which `extractRevertData` skips because it only matches
 *  hex-string `data` fields. When viem successfully matches the revert
 *  selector against the ABI passed to `writeContract`, this is where the
 *  decoded info lives — so the recovery surfaces below (NotCanonicalTarget,
 *  PayoutBelowMin, etc.) can light up without round-tripping back through
 *  `decodeErrorResult`. */
function extractDecodedRevert(
    e: unknown,
): {errorName: string; args?: readonly unknown[]} | undefined {
    if (!e || typeof e !== 'object') return undefined;
    const candidates: unknown[] = [e];
    while (candidates.length > 0) {
        const cur = candidates.shift();
        if (!cur || typeof cur !== 'object') continue;
        const obj = cur as Record<string, unknown>;
        const d = obj.data as Record<string, unknown> | undefined;
        if (
            d &&
            typeof d === 'object' &&
            typeof d.errorName === 'string'
        ) {
            const args = Array.isArray(d.args) ? (d.args as readonly unknown[]) : undefined;
            return {errorName: d.errorName, args};
        }
        if (obj.cause) candidates.push(obj.cause);
    }
    return undefined;
}

/** Decode the revert and produce a user-facing message. The target trait is
 *  protocol-derived now, so the headline race is `NotCanonicalTarget` — the
 *  canonical target shifted between our read and inclusion (someone else's
 *  acceptance collected or pended what was the rarest trait). The UI offers a
 *  "refresh and start over" affordance when this (or the equivalent
 *  `TargetTraitPending`) fires. `NoEligibleTarget` means the Punk has nothing
 *  collectable left. */
function classifyAcceptError(e: unknown, traitNames?: readonly string[]): string {
    if (isUserDeclined(e)) return 'You declined in your wallet.';
    // Prefer viem's already-decoded shape if present (no re-decode needed).
    const decoded = extractDecodedRevert(e) ?? decodeFromRawData(e);
    if (decoded) {
        // Protocol-derived target shifted before inclusion. Both errors carry
        // [punkId, provided, canonical]; surface the new canonical trait.
        if (decoded.errorName === 'NotCanonicalTarget' || decoded.errorName === 'TargetNotCanonical') {
            const canonical = Number(decoded.args?.[2] ?? -1);
            const name = traitNames && traitNames[canonical];
            return name
                ? `The target trait shifted before your transaction landed (now ${name}). Refresh and try again.`
                : 'The target trait shifted before your transaction landed. Refresh and try again.';
        }
        if (decoded.errorName === 'NoEligibleTarget') {
            return 'This Punk has no collectable trait left — every trait it carries is already permanent or in an active return auction.';
        }
        if (decoded.errorName === 'TargetTraitPending') {
            const tid = Number(decoded.args?.[0] ?? -1);
            const name = traitNames && traitNames[tid];
            return name
                ? `${name} just entered another Punk's return auction. Refresh and try again.`
                : 'The target trait just entered another return auction. Refresh and try again.';
        }
        if (decoded.errorName === 'PayoutBelowMin') {
            return 'Live bid dropped below your minimum payout while the tx was in flight. Try again or lower the floor.';
        }
        if (decoded.errorName === 'TargetTraitAlreadyCollected') {
            return 'The target trait became permanent while you were signing. Refresh and try again.';
        }
        if (decoded.errorName === 'InvalidTargetTrait') {
            return `The Punk doesn't carry that trait. Refresh and try again.`;
        }
        if (decoded.errorName === 'SoleCarrierMustTargetTrait') {
            const rid = Number(decoded.args?.[1] ?? -1);
            const name = traitNames && traitNames[rid];
            return name
                ? `This Punk is the only carrier of ${name}, so the protocol can only make ${name} permanent through it.`
                : 'This Punk is the only carrier of an uncollected trait, so the protocol can only make that trait permanent through it.';
        }
        // Generic decoded error: surface the contract's name.
        return `Reverted: ${decoded.errorName}`;
    }
    return e instanceof Error ? e.message : String(e);
}

/** Fallback path when viem hasn't decoded the revert (raw-RPC errors from
 *  wallets / providers that bypass viem's contract simulation). Pulls the
 *  hex `data` out of the chain and re-decodes against PatronAbi. */
function decodeFromRawData(
    e: unknown,
): {errorName: string; args?: readonly unknown[]} | undefined {
    const data = extractRevertData(e);
    if (!data) return undefined;
    try {
        const decoded = decodeErrorResult({abi: PatronAbi, data});
        return {
            errorName: decoded.errorName,
            args: decoded.args as readonly unknown[] | undefined,
        };
    } catch {
        return undefined;
    }
}

function isUserDeclined(e: unknown): boolean {
    if (!e) return false;
    const msg = e instanceof Error ? e.message : String(e);
    return /user rejected|user denied/i.test(msg);
}

/** Pattern-match the "target shifted" user-facing messages so the surface
 *  knows when to offer the "refresh and start over" affordance. Kept dumb on
 *  purpose: the error message itself is the contract. Matches the
 *  canonical-target-shift, pending-race, and became-permanent phrasings — all
 *  resolved by re-reading the protocol-derived target. */
function isTargetShiftMessage(msg: string): boolean {
    return /shifted before your transaction|entered another (Punk's )?return auction|became permanent while/i.test(
        msg,
    );
}

const styles = `
.flow {
    margin-top: 38px;
    display: flex;
    flex-direction: column;
    gap: 38px;
    max-width: 720px;
}
.summary {
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    padding: 24px 0;
}
.summary-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
    margin-bottom: 10px;
}
.summary-value {
    font-family: var(--serif);
    font-weight: 300;
    font-size: clamp(48px, 7vw, 84px);
    line-height: 0.92;
    letter-spacing: -0.02em;
    color: var(--accent);
}
.summary-note {
    margin-top: 12px;
    font-family: var(--sans);
    font-size: 14px;
    color: var(--muted);
}
.summary-pending {
    margin-top: 6px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.bid-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.stage {
    border: 1px solid var(--line);
    padding: clamp(26px, 4vw, 42px);
    display: flex;
    flex-direction: column;
    gap: 22px;
}
/* A step that's visible from the start but not yet actionable. */
.stage-inactive {
    border-style: dashed;
}
.stage-inactive .stage-title {
    color: var(--muted);
}
.stage-title {
    font-family: var(--serif);
    font-size: clamp(26px, 3.4vw, 38px);
    font-weight: 300;
    letter-spacing: -0.035em;
    line-height: 1.05;
}
.stage-copy {
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.65;
    color: var(--muted);
}
.stage-note {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 10px 14px;
}
.stage-error {
    font-family: var(--sans);
    font-size: 14px;
    color: var(--danger);
    background: var(--bg);
    border: 1px solid var(--danger);
    padding: 12px 14px;
}
.stage-line {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
    flex-wrap: wrap;
}
.stage-actions {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
}
.stage-tx {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    color: var(--muted);
}
/* ── Derived-target note (confirm panel) ──────────────────────── */
.derived-target {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.6;
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 2px solid var(--accent);
    padding: 12px 16px;
}
.derived-target strong {
    color: var(--ink);
    font-weight: 600;
}
.derived-target-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
/* ── Few-carrier notice (confirm panel) ───────────────────────── */
.few-carrier {
    border: 1px solid var(--accent);
    border-left-width: 2px;
    background: var(--panel);
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.few-carrier-head {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.55;
    color: var(--ink);
}
.few-carrier-head strong {
    font-weight: 600;
}
.few-carrier-body {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.6;
    color: var(--muted);
}
/* ── Punk-first picker ────────────────────────────────────────── */
.punk-target-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px;
}
.punk-target {
    display: flex;
    flex-direction: column;
    padding: 0;
    background: var(--bg);
    border: 1px solid var(--line);
    color: var(--ink);
    cursor: pointer;
    text-align: left;
    transition: border-color 110ms ease, transform 110ms ease;
}
.punk-target:hover:not(:disabled) {
    border-color: var(--ink);
    transform: translateY(-1px);
}
.punk-target:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}
.punk-target-on {
    border-color: var(--accent);
    background: var(--panel);
}
.punk-target-loading {
    border-color: var(--accent);
}
.punk-target-tile {
    width: 100%;
    aspect-ratio: 1;
    background: var(--punk-blue); /* classic CryptoPunks bg, matches on-chain renderer */
    line-height: 0;
}
.punk-target-tile svg {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    shape-rendering: crispEdges;
}
.punk-target-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px;
    border-top: 1px solid var(--line);
    min-height: 56px;
}
.punk-target-id {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
}
.punk-target-trait {
    font-family: var(--serif);
    font-size: 15px;
    letter-spacing: -0.01em;
    line-height: 1.2;
    color: var(--ink);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.punk-target-badge {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--accent);
    padding: 1px 5px;
}
.punk-target-badge-rare {
    color: var(--muted);
    border-color: var(--muted);
}
/* A Punk the caller already listed to the protocol — surfaced so a reload
   mid-flow shows the in-progress state. */
.punk-target-listed {
    border-color: var(--accent);
}
.punk-target-flag {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--bg);
    background: var(--accent);
    padding: 1px 5px;
}

/* ── Cancel listing (confirm panel) ───────────────────────────── */
.cancel-listing {
    margin-top: 14px;
    padding: 12px 16px;
    border: 1px solid var(--line);
    border-left: 2px solid var(--muted);
    background: var(--panel);
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.cancel-listing-copy {
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0;
}
.cancel-listing-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
}
.cancel-listing-status {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 8px;
}
.cancel-listing-status .error {
    color: var(--accent);
}

/* ── Picked-Punk badge (confirm panel) ────────────────────────── */
.picked-punk {
    display: flex;
    gap: 18px;
    align-items: stretch;
    padding: 14px 16px;
    border: 1px solid var(--line);
    background: var(--panel);
}
.picked-punk-tile {
    width: 84px;
    height: 84px;
    flex-shrink: 0;
    background: var(--punk-blue);
    line-height: 0;
}
.picked-punk-tile svg {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    shape-rendering: crispEdges;
}
.picked-punk-body {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    flex: 1;
}
.picked-punk-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
}
.picked-punk-id {
    font-family: var(--serif);
    font-size: 20px;
    font-weight: 300;
    letter-spacing: -0.02em;
    color: var(--ink);
}
.picked-punk-change {
    background: transparent;
    border: none;
    padding: 0;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
}
.picked-punk-change:hover { color: var(--ink); }
.picked-punk-meta {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
}
.picked-punk-market {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
}
.picked-punk-market strong {
    color: var(--ink);
    font-weight: 500;
}

.consent-block {
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 22px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}
.consent-title {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 300;
    letter-spacing: -0.02em;
}
.consent-block ul {
    margin: 0;
    padding: 0 0 0 18px;
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.65;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.consent-block strong {
    color: var(--ink);
    font-weight: 500;
}
.consent-toggle {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.55;
    color: var(--ink);
    cursor: pointer;
}
.consent-toggle input[type="checkbox"] {
    margin-top: 3px;
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
    cursor: pointer;
}

.trait-busy {
    border: 1px solid var(--accent);
    background: var(--panel);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
}
.trait-busy p {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.55;
    color: var(--ink);
}

.tx-stack {
    display: flex;
    flex-direction: column;
    gap: 14px;
}
.tx-step {
    border: 1px solid var(--line);
    padding: 18px 20px;
    background: var(--bg);
}
.tx-step.status-success {
    border-color: var(--ink);
}
.tx-step.status-failed,
.tx-step.status-rejected {
    border-color: var(--accent);
}
.tx-step-head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 6px;
}
.tx-step-num {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
}
.tx-step-label {
    font-family: var(--serif);
    font-size: 18px;
    font-weight: 300;
    letter-spacing: -0.02em;
}
.tx-step-hint {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--muted);
    line-height: 1.55;
    margin-bottom: 14px;
}
.preflight-note {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    line-height: 1.5;
    margin: 6px 0 0;
}
.preflight-note.preflight-error {
    color: var(--ink);
}
.preflight-retry {
    font-family: var(--mono);
    font-size: 11px;
    text-decoration: underline;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
}
.tx-step-line {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
}
.tx-step-status {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.tx-step-status .error {
    color: var(--accent);
}
.tx-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
.tx-bundle {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
}
.atomic-hint {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0;
}
/* ── Seller account-type warning (contract / 7702-delegated sellers) ── */
.seller-warning {
    border: 1px solid var(--danger);
    border-left-width: 3px;
    background: var(--panel);
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.seller-warning-title {
    font-family: var(--serif);
    font-size: 19px;
    font-weight: 400;
    letter-spacing: -0.02em;
    color: var(--ink);
}
.seller-warning-body {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.6;
    color: var(--muted);
}
.seller-warning-body code {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
}
/* ── Post-accept inline confirmation (claim still pending) ─────── */
.accept-confirm {
    border: 1px solid var(--ink);
    border-left: 3px solid var(--accent);
    background: var(--panel);
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.accept-confirm-head {
    font-family: var(--serif);
    font-size: 19px;
    font-weight: 400;
    letter-spacing: -0.02em;
    color: var(--ink);
}
.accept-confirm-body {
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.6;
    color: var(--muted);
}
.accept-confirm-body strong {
    color: var(--ink);
    font-weight: 600;
}
/* ── Highlighted "next step" Claim step ───────────────────────── */
.tx-step-highlight {
    border-color: var(--accent);
    border-left-width: 3px;
    background: var(--panel);
}
.tx-step-next {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--bg);
    background: var(--accent);
    padding: 2px 6px;
    margin-left: auto;
}
/* ── Interstitial review modal ────────────────────────────────── */
.review-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.62);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    padding: var(--pad);
    overflow-y: auto;
}
.review-card {
    background: var(--bg);
    border: 1px solid var(--ink);
    max-width: 540px;
    width: 100%;
    padding: clamp(24px, 4vw, 40px);
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin: auto;
}
.review-title {
    font-family: var(--serif);
    font-size: clamp(24px, 3.4vw, 34px);
    font-weight: 300;
    letter-spacing: -0.035em;
    line-height: 1.05;
}
.review-punk {
    display: flex;
    gap: 16px;
    align-items: flex-start;
}
.review-punk-tile {
    width: 96px;
    height: 96px;
    flex-shrink: 0;
    background: var(--punk-blue);
    line-height: 0;
    border: 1px solid var(--line);
}
.review-punk-tile svg {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    shape-rendering: crispEdges;
}
.review-punk-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}
.review-punk-id {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 300;
    letter-spacing: -0.02em;
    color: var(--ink);
}
.review-traits {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
}
.review-trait {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--muted);
    border: 1px solid var(--line);
    padding: 2px 7px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
}
.review-trait-target {
    color: var(--ink);
    border-color: var(--accent);
}
.review-trait-tag {
    font-size: 8px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--bg);
    background: var(--accent);
    padding: 1px 4px;
}
.review-figures {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.review-figure {
    background: var(--bg);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 5px;
}
.review-figure-primary {
    background: var(--panel);
}
.review-figure-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
}
.review-figure-value {
    font-family: var(--mono);
    font-size: 15px;
    color: var(--ink);
}
.review-figure-primary .review-figure-value {
    color: var(--accent);
    font-size: 17px;
}
.review-copy {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.6;
    color: var(--muted);
}
.review-warning {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.55;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--danger);
    border-left-width: 3px;
    padding: 12px 14px;
}
.review-warning strong {
    font-weight: 600;
}
.review-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
}
`;
