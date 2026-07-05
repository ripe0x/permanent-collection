'use client';

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
    useAccount,
    useChainId,
    usePublicClient,
    useReadContract,
    useReadContracts,
    useWaitForTransactionReceipt,
    useWriteContract,
} from 'wagmi';
import {parseEventLogs, zeroAddress, zeroHash} from 'viem';

import {getChainId} from '@/lib/config';
import {
    homageAbi,
    homageFlows,
    homageChainName,
    quoteMint,
    THRESHOLD,
    BASE_FEE,
    EXIT_FEE,
    CRYPTOPUNKS_MARKET,
    WRAPPED_PUNKS,
    DELEGATE_REGISTRY,
    delegateRegistryAbi,
    punksMarketAbi,
    wrappedPunksAbi,
    type MintQuote,
} from './homage';
import {getHomageAddress, getHomageRenderer, isHomageConfigured, getHomageDeployBlock} from './config';
import {rendererAbi, READ_RETRY} from './renderer';
import {anySvgToSrc, decodeTokenURI, type TokenMeta} from './svg';
import {shortErr} from './errors';
import {type Schedule, type Phase, currentPhase, nextTransition, demoNext} from './phase';
import {allowlistProofFor} from './allowlist';

export const SUPPLY = 10_000;
export {THRESHOLD, BASE_FEE, EXIT_FEE};

export type TxStatus = 'idle' | 'confirm' | 'pending' | 'success' | 'error';

function useTx() {
    const {writeContract, data: hash, isPending, error, reset} = useWriteContract();
    const receipt = useWaitForTransactionReceipt({hash, query: {enabled: !!hash}});
    const status: TxStatus = error
        ? 'error'
        : isPending
          ? 'confirm'
          : hash && receipt.isLoading
            ? 'pending'
            : receipt.isSuccess
              ? 'success'
              : 'idle';
    return {writeContract, hash, status, error, reset, receipt};
}

/**
 * Everything the mint UI needs, presentation-free. Wraps the (verified) contract
 * reads, the live pool quote, the mint + redeem writes with their reveal/refresh
 * wiring, and the owner's collection scan.
 */
export function useHomageMint(phaseOverride?: Phase | null) {
    const {address, isConnected} = useAccount();
    const chainId = useChainId();
    const wrongChain = isConnected && chainId !== getChainId();
    const configured = isHomageConfigured();
    const client = usePublicClient({chainId: getChainId()});
    const homage = getHomageAddress() ?? zeroAddress;

    // ---- collection stats ----
    const remainingRead = useReadContract({address: homage, abi: homageAbi, functionName: 'remaining', chainId: getChainId(), query: {enabled: configured}});
    const totalMintedRead = useReadContract({address: homage, abi: homageAbi, functionName: 'totalMinted', chainId: getChainId(), query: {enabled: configured}});
    const minted = totalMintedRead.data !== undefined ? Number(totalMintedRead.data) : undefined;
    const remaining = remainingRead.data !== undefined ? Number(remainingRead.data) : undefined;

    // ---- mint schedule + fee / allowlist config (one multicall) ----
    const cfg = useReadContracts({
        contracts: [
            {address: homage, abi: homageAbi, functionName: 'claimStart', chainId: getChainId()},
            {address: homage, abi: homageAbi, functionName: 'allowlistStart', chainId: getChainId()},
            {address: homage, abi: homageAbi, functionName: 'publicStart', chainId: getChainId()},
            {address: homage, abi: homageAbi, functionName: 'baseFee', chainId: getChainId()},
            {address: homage, abi: homageAbi, functionName: 'maxPerAllowlisted', chainId: getChainId()},
            {address: homage, abi: homageAbi, functionName: 'allowlistMinted', args: [address ?? zeroAddress], chainId: getChainId()},
            {address: homage, abi: homageAbi, functionName: 'exitFee', chainId: getChainId()},
        ],
        query: {enabled: configured},
    });
    const schedule: Schedule | null =
        cfg.data && cfg.data[0]?.status === 'success'
            ? {
                  claimStart: Number(cfg.data[0].result),
                  allowlistStart: Number(cfg.data[1].result),
                  publicStart: Number(cfg.data[2].result),
              }
            : null;
    const baseFee = cfg.data?.[3]?.status === 'success' ? (cfg.data[3].result as bigint) : BASE_FEE;
    const maxPerAllowlisted = cfg.data?.[4]?.status === 'success' ? Number(cfg.data[4].result) : undefined;
    const allowlistUsed = cfg.data?.[5]?.status === 'success' ? Number(cfg.data[5].result) : 0;
    const exitFee = cfg.data?.[6]?.status === 'success' ? (cfg.data[6].result as bigint) : EXIT_FEE;

    // ticking clock for the phase display (advisory only — the contract enforces the real gate)
    const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
    useEffect(() => {
        const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
        return () => clearInterval(t);
    }, []);
    // Real on-chain window; a dev override forces the DISPLAYED phase (and suppresses the
    // schedule countdown, since it no longer matches). Writes still target the real contract,
    // which enforces the true window regardless of the override.
    const realPhase: Phase = schedule ? currentPhase(schedule, nowSec) : 'closed';
    const phase: Phase = phaseOverride ?? realPhase;
    // countdown target = time left in the current window (until the next opens). Under a dev
    // override the real schedule is bypassed, so synthesize a ticking demo target.
    const nextPhase = phaseOverride ? demoNext(phaseOverride, nowSec) : schedule ? nextTransition(schedule, nowSec) : null;

    // allowlist eligibility — the Merkle proof is baked in at build time (lib/homage/allowlist.ts)
    const allowlistProof = address ? allowlistProofFor(address) : null;
    const isAllowlisted = !!allowlistProof;
    const allowlistRemaining = maxPerAllowlisted !== undefined ? Math.max(maxPerAllowlisted - allowlistUsed, 0) : undefined;

    // ---- live pool quote ----
    const [quote, setQuote] = useState<MintQuote | null>(null);
    const [quoteErr, setQuoteErr] = useState<string | null>(null);
    const [quoting, setQuoting] = useState(false);
    const refreshQuote = useCallback(async () => {
        if (!client || !configured) return;
        setQuoting(true);
        setQuoteErr(null);
        try {
            // Public mint fee escalates per wallet; quote the swap with the caller's mintFeeOf (the
            // headline price). Claim/allowlist mints reuse ethForSwap but pay the flat baseFee.
            const who = address ?? zeroAddress;
            const fee = (await client.readContract({address: homage, abi: homageAbi, functionName: 'mintFeeOf', args: [who]})) as bigint;
            setQuote(await quoteMint(client, fee));
        } catch (e) {
            setQuoteErr(shortErr(e));
            setQuote(null);
        } finally {
            setQuoting(false);
        }
    }, [client, configured, address, homage]);
    // Quote lifecycle (RPC discipline): fetch on mount, then refresh on an interval ONLY
    // while the mint panel is mounted AND the tab is visible — never per render. `quoteActive`
    // lets the UI (which knows whether a reveal has replaced the mint form) suppress polling
    // when no quote is on screen. A visibilitychange listener refreshes immediately on re-focus
    // if the last quote went stale while the tab was hidden.
    const [quoteActive, setQuoteActive] = useState(true);
    const QUOTE_INTERVAL_MS = 30_000;
    const lastQuoteAt = useRef(0);
    useEffect(() => {
        refreshQuote().then(() => {
            lastQuoteAt.current = Date.now();
        });
    }, [refreshQuote]);
    useEffect(() => {
        if (!configured || !quoteActive) return;
        const tick = () => {
            if (document.visibilityState !== 'visible') return;
            refreshQuote().then(() => {
                lastQuoteAt.current = Date.now();
            });
        };
        const iv = setInterval(tick, QUOTE_INTERVAL_MS);
        const onVis = () => {
            // returning to the tab after it was hidden past one interval → refresh now
            if (document.visibilityState === 'visible' && Date.now() - lastQuoteAt.current > QUOTE_INTERVAL_MS) tick();
        };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            clearInterval(iv);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, [configured, quoteActive, refreshQuote]);

    // ---- write flows ----
    const mintTx = useTx();
    const redeemTx = useTx();
    const [drawnId, setDrawnId] = useState<number | null>(null);
    const [galleryKey, setGalleryKey] = useState(0);

    const refresh = useCallback(() => {
        remainingRead.refetch();
        totalMintedRead.refetch();
        setGalleryKey((k) => k + 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // mint confirmed → drawn punk id from the Minted event
    useEffect(() => {
        if (!mintTx.receipt.isSuccess || !mintTx.receipt.data) return;
        const logs = parseEventLogs({abi: homageAbi, eventName: 'Minted', logs: mintTx.receipt.data.logs});
        const pid = (logs[0]?.args as {punkId?: bigint} | undefined)?.punkId;
        if (pid !== undefined) setDrawnId(Number(pid));
        refresh();
        refreshQuote();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mintTx.receipt.isSuccess]);

    // redeem confirmed → drop it from the reveal if it was showing
    const [redeemedId, setRedeemedId] = useState<number | null>(null);
    useEffect(() => {
        if (!redeemTx.receipt.isSuccess || !redeemTx.receipt.data) return;
        const logs = parseEventLogs({abi: homageAbi, eventName: 'Redeemed', logs: redeemTx.receipt.data.logs});
        const pid = (logs[0]?.args as {punkId?: bigint} | undefined)?.punkId;
        if (pid !== undefined) {
            setRedeemedId(Number(pid));
            setDrawnId((cur) => (cur === Number(pid) ? null : cur));
        }
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [redeemTx.receipt.isSuccess]);

    // ---- claim (window 1): mint the homage for a punk you hold (flat baseFee) ----
    const claimTx = useTx();
    const [claimedId, setClaimedId] = useState<number | null>(null);
    useEffect(() => {
        if (!claimTx.receipt.isSuccess || !claimTx.receipt.data) return;
        const logs = parseEventLogs({abi: homageAbi, eventName: 'Claimed', logs: claimTx.receipt.data.logs});
        const pid = (logs[0]?.args as {punkId?: bigint} | undefined)?.punkId;
        if (pid !== undefined) setClaimedId(Number(pid));
        refresh();
        refreshQuote();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [claimTx.receipt.isSuccess]);

    // ---- allowlist mint (window 2): random draw, Merkle-gated, flat baseFee ----
    const allowlistTx = useTx();
    const [allowlistDrawnId, setAllowlistDrawnId] = useState<number | null>(null);
    useEffect(() => {
        if (!allowlistTx.receipt.isSuccess || !allowlistTx.receipt.data) return;
        const logs = parseEventLogs({abi: homageAbi, eventName: 'Minted', logs: allowlistTx.receipt.data.logs});
        const pid = (logs[0]?.args as {punkId?: bigint} | undefined)?.punkId;
        if (pid !== undefined) setAllowlistDrawnId(Number(pid));
        refresh();
        refreshQuote();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allowlistTx.receipt.isSuccess]);

    const busy = (s: TxStatus) => s === 'confirm' || s === 'pending';
    const canMint = configured && isConnected && !wrongChain && !!quote && phase === 'public' && !busy(mintTx.status);
    const canClaim = configured && isConnected && !wrongChain && !!quote && phase === 'claim' && !busy(claimTx.status);
    const canAllowlistMint =
        configured && isConnected && !wrongChain && !!quote && phase === 'allowlist' && isAllowlisted && (allowlistRemaining ?? 0) > 0 && !busy(allowlistTx.status);

    const mint = useCallback(() => {
        if (!quote) return;
        setDrawnId(null);
        mintTx.writeContract({...homageFlows.mint(quote.totalValue), chainId: getChainId()});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [quote, mintTx.writeContract]);

    // `vault` set = a delegate.xyz claim: msg.sender transacts, the homage mints to the vault.
    const claim = useCallback(
        (punkId: number, vault?: `0x${string}`) => {
            if (!quote) return;
            setClaimedId(null);
            const value = quote.ethForSwap + baseFee;
            if (vault) claimTx.writeContract({...homageFlows.claimFor(BigInt(punkId), vault, value), chainId: getChainId()});
            else claimTx.writeContract({...homageFlows.claim(BigInt(punkId), value), chainId: getChainId()});
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [quote, baseFee, claimTx.writeContract]
    );

    const allowlistMint = useCallback(() => {
        if (!quote || !allowlistProof) return;
        setAllowlistDrawnId(null);
        allowlistTx.writeContract({...homageFlows.allowlistMint(allowlistProof, quote.ethForSwap + baseFee), chainId: getChainId()});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [quote, allowlistProof, baseFee, allowlistTx.writeContract]);

    const redeem = useCallback((id: number) => {
        setRedeemedId(null);
        redeemTx.writeContract({...homageFlows.redeem(BigInt(id), exitFee), chainId: getChainId()});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [exitFee, redeemTx.writeContract]);

    const owned = useOwnedHomages(address, galleryKey);
    // the connected wallet's claimable punks (unminted homages), fetched on connect / claim only
    const ownedPunks = useOwnedPunks(phase === 'claim' ? address : undefined, galleryKey);

    return {
        // wallet / config
        address,
        isConnected,
        wrongChain,
        configured,
        chainName: homageChainName(),
        chainId: getChainId(),
        // stats
        minted,
        remaining,
        supply: SUPPLY,
        // quote
        quote,
        quoting,
        quoteErr,
        refreshQuote,
        setQuoteActive, // pause/resume the interval poll (e.g. suppress while a reveal is shown)
        // mint schedule / phase
        phase,
        nextPhase,
        nowSec,
        schedule,
        baseFee,
        // public mint
        mint,
        canMint,
        mintStatus: mintTx.status,
        mintHash: mintTx.hash,
        mintError: mintTx.error ? shortErr(mintTx.error) : null,
        drawnId,
        resetMint: () => {
            mintTx.reset();
            setDrawnId(null);
        },
        // claim (window 1)
        claim,
        canClaim,
        claimStatus: claimTx.status,
        claimHash: claimTx.hash,
        claimError: claimTx.error ? shortErr(claimTx.error) : null,
        claimedId,
        resetClaim: () => {
            claimTx.reset();
            setClaimedId(null);
        },
        // allowlist mint (window 2)
        allowlistMint,
        canAllowlistMint,
        isAllowlisted,
        allowlistRemaining,
        maxPerAllowlisted,
        allowlistStatus: allowlistTx.status,
        allowlistHash: allowlistTx.hash,
        allowlistError: allowlistTx.error ? shortErr(allowlistTx.error) : null,
        allowlistDrawnId,
        resetAllowlist: () => {
            allowlistTx.reset();
            setAllowlistDrawnId(null);
        },
        // redeem
        redeem,
        redeemStatus: redeemTx.status,
        redeemHash: redeemTx.hash,
        redeemError: redeemTx.error ? shortErr(redeemTx.error) : null,
        redeemedId,
        resetRedeem: () => {
            redeemTx.reset();
            setRedeemedId(null);
        },
        // collection
        owned,
        ownedPunks,
    };
}

/* ---------- redeem flow (the /homage/redeem page) — owned homages + burn-to-reclaim ---------- */
// Self-contained (no mint quote / schedule reads) so the redeem page stays RPC-light.
export function useRedeem() {
    const {address, isConnected} = useAccount();
    const chainId = useChainId();
    const wrongChain = isConnected && chainId !== getChainId();
    const configured = isHomageConfigured();
    const homage = getHomageAddress() ?? zeroAddress;

    const [galleryKey, setGalleryKey] = useState(0);
    const owned = useOwnedHomages(address, galleryKey);

    // exit fee is owner-tunable → read it live so redeem sends the exact required value
    const exitFeeRead = useReadContract({
        address: homage, abi: homageAbi, functionName: 'exitFee', chainId: getChainId(),
        query: {enabled: configured},
    });
    const exitFee = (exitFeeRead.data as bigint | undefined) ?? EXIT_FEE;

    const redeemTx = useTx();
    const [redeemedId, setRedeemedId] = useState<number | null>(null);
    useEffect(() => {
        if (!redeemTx.receipt.isSuccess || !redeemTx.receipt.data) return;
        const logs = parseEventLogs({abi: homageAbi, eventName: 'Redeemed', logs: redeemTx.receipt.data.logs});
        const pid = (logs[0]?.args as {punkId?: bigint} | undefined)?.punkId;
        if (pid !== undefined) setRedeemedId(Number(pid));
        setGalleryKey((k) => k + 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [redeemTx.receipt.isSuccess]);

    const redeem = useCallback(
        (id: number) => {
            setRedeemedId(null);
            redeemTx.writeContract({...homageFlows.redeem(BigInt(id), exitFee), chainId: getChainId()});
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [exitFee, redeemTx.writeContract]
    );

    return {
        address,
        isConnected,
        wrongChain,
        configured,
        chainName: homageChainName(),
        owned,
        exitFee, // live, owner-tunable — shown before the tx and sent as the exact msg.value
        redeem,
        redeemStatus: redeemTx.status,
        redeemHash: redeemTx.hash,
        redeemError: redeemTx.error ? shortErr(redeemTx.error) : null,
        redeemedId,
        resetRedeem: () => {
            redeemTx.reset();
            setRedeemedId(null);
        },
    };
}

/* ---------- verify a wallet holds a given punk (mint eligibility) ---------- */
// Mirrors Homage._isPunkHolder: raw ownership via the market's punkIndexToAddress, or, when
// that's the WrappedPunks wrapper, the wrapper's ownerOf. Also reports whether the homage for
// that id is already minted, so the holder-mint UI can show "already minted".
export function usePunkOwnership(id: number | null, viewer?: `0x${string}`) {
    const homage = getHomageAddress() ?? zeroAddress;
    const enabled = id !== null && Number.isInteger(id) && id >= 0 && id <= 9999 && isHomageConfigured();
    const reads = useReadContracts({
        contracts: enabled
            ? [
                  {address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi, functionName: 'punkIndexToAddress', args: [BigInt(id as number)], chainId: getChainId()},
                  {address: homage, abi: homageAbi, functionName: 'isMinted', args: [BigInt(id as number)], chainId: getChainId()},
              ]
            : [],
        query: {enabled},
    });
    const rawOwner = reads.data?.[0]?.status === 'success' ? (reads.data[0].result as `0x${string}`) : undefined;
    const alreadyMinted = reads.data?.[1]?.status === 'success' ? (reads.data[1].result as boolean) : undefined;
    const isWrapped = rawOwner ? rawOwner.toLowerCase() === WRAPPED_PUNKS.toLowerCase() : false;

    // if wrapped, the true holder is the wrapper's ownerOf — one extra read, only when needed
    const wrappedRead = useReadContract({
        address: WRAPPED_PUNKS,
        abi: wrappedPunksAbi,
        functionName: 'ownerOf',
        args: [BigInt(enabled ? (id as number) : 0)],
        chainId: getChainId(),
        query: {enabled: enabled && isWrapped},
    });
    const holder = isWrapped
        ? wrappedRead.data === undefined
            ? undefined
            : (wrappedRead.data as `0x${string}`)
        : rawOwner;

    const isHolder = !!(viewer && holder && holder.toLowerCase() === viewer.toLowerCase());

    // Not the holder? Check delegate.xyz: the vault (holder) may have delegated the viewer —
    // wallet-wide, for the punk's contract, or for this token (one hierarchical read). Keyed
    // against the contract ownership lives in, mirroring Homage.claimFor.
    const source = isWrapped ? WRAPPED_PUNKS : CRYPTOPUNKS_MARKET;
    const wantDelegation = enabled && !!viewer && !!holder && !isHolder;
    const delegRead = useReadContract({
        address: DELEGATE_REGISTRY,
        abi: delegateRegistryAbi,
        functionName: 'checkDelegateForERC721',
        args: [viewer ?? zeroAddress, holder ?? zeroAddress, source, BigInt(enabled ? (id as number) : 0), zeroHash],
        chainId: getChainId(),
        query: {enabled: wantDelegation},
    });
    const delegated = wantDelegation && delegRead.data === true;

    const loading = reads.isLoading || (isWrapped && wrappedRead.isLoading) || (wantDelegation && delegRead.isLoading);
    return {holder, isHolder, isWrapped, delegated, alreadyMinted, loading};
}

// shared owned-scan status (used by the punk picker and the owned-homages scan).
type OwnedStatus = 'idle' | 'loading' | 'ok' | 'partial' | 'error';

/* ---------- claim picker: enumerate the wallet's punks whose homage is still unminted ---------- */
// Mirrors Homage claim eligibility for BOTH ownership sources, on connect / explicit refresh only:
//   • Wrapped punks — WrappedPunks is ERC-721Enumerable, so balanceOf + tokenOfOwnerByIndex
//     lists them directly (no log scan). The raw market reports the wrapper as owner for these,
//     so claim() still validates: it unwraps to ownerOf == the connected wallet.
//   • Raw punks — discovered via the server API (data adapter's raw `punkIndexToAddress`
//     ownership scan), confirmed against the live punkIndexToAddress. The manual-id entry
//     (which verifies ownership AND delegation per id) remains the catch-all when the API
//     is unreachable.
//   • Delegated punks — delegate.xyz vaults that delegated this wallet (wallet-wide / punk
//     contract / single token) contribute their punks too, tagged with the vault; claiming one
//     routes through claimFor and mints to the vault.
// Every candidate is filtered to `isMinted == false` (the homage tokenId == punkId), so the
// picker only ever offers ids the claim will accept.
type PunkPick = {id: number; wrapped: boolean; vault?: `0x${string}`};
const MAX_DELEGATION_VAULTS = 4; // vault-wide delegations enumerated per connect, RPC-bounded

/** Wrapped punks (enumerable, exact) + raw punks (server-API ownership, confirmed against
 *  live ownership) held by `who`. Returns id -> wrapped. `rawFailed` marks an API error. */
async function scanWalletPunks(
    client: NonNullable<ReturnType<typeof usePublicClient>>,
    who: `0x${string}`
): Promise<{held: Map<number, boolean>; rawFailed: boolean}> {
    // ── wrapped punks: enumerable, exact ──
    const wBal = (await client.readContract({
        address: WRAPPED_PUNKS,
        abi: wrappedPunksAbi,
        functionName: 'balanceOf',
        args: [who],
    })) as bigint;
    const wIds: bigint[] = [];
    if (wBal > 0n) {
        const idxReads = await client.multicall({
            contracts: Array.from({length: Number(wBal)}, (_, i) => ({
                address: WRAPPED_PUNKS,
                abi: wrappedPunksAbi,
                functionName: 'tokenOfOwnerByIndex',
                args: [who, BigInt(i)],
            }) as const),
            allowFailure: true,
        });
        for (const r of idxReads) if (r.status === 'success') wIds.push(r.result as bigint);
    }

    // ── raw punks: server API (data adapter), confirmed against live ownership ──
    let rawFailed = false;
    const rawCandidates = new Set<bigint>();
    try {
        const res = await fetch('/api/owned-punks?address=' + who);
        if (!res.ok) throw new Error(`owned-punks ${res.status}`);
        const body = (await res.json()) as {punkIds: number[]};
        for (const id of body.punkIds) rawCandidates.add(BigInt(id));
    } catch {
        rawFailed = true; // an API failure must not sink the wrapped enumeration
    }
    const rawIds = Array.from(rawCandidates);
    // the adapter's view can lag; confirm against live punkIndexToAddress before trusting it
    const rawOwnerReads = rawIds.length
        ? await client.multicall({
              contracts: rawIds.map((id) => ({address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi, functionName: 'punkIndexToAddress', args: [id]}) as const),
              allowFailure: true,
          })
        : [];
    const confirmedRaw = rawIds.filter((_, i) => {
        const r = rawOwnerReads[i];
        return r?.status === 'success' && (r.result as string).toLowerCase() === who.toLowerCase();
    });

    const held = new Map<number, boolean>(); // id -> wrapped
    for (const id of wIds) held.set(Number(id), true);
    for (const id of confirmedRaw) if (!held.has(Number(id))) held.set(Number(id), false);
    return {held, rawFailed};
}

/** Incoming delegate.xyz delegations relevant to punk claims: vaults that delegated `who`
 *  wallet-wide or for a punk contract (enumerate their punks), and token-level (id, vault)
 *  candidates. Rights-scoped delegations are skipped — Homage.claimFor checks empty rights. */
async function claimDelegations(
    client: NonNullable<ReturnType<typeof usePublicClient>>,
    who: `0x${string}`
): Promise<{vaults: `0x${string}`[]; tokens: {id: bigint; vault: `0x${string}`}[]}> {
    const raw = (await client.readContract({
        address: DELEGATE_REGISTRY,
        abi: delegateRegistryAbi,
        functionName: 'getIncomingDelegations',
        args: [who],
    })) as readonly {type_: number; from: `0x${string}`; rights: `0x${string}`; contract_: `0x${string}`; tokenId: bigint}[];
    const isPunkSource = (c: string) =>
        c.toLowerCase() === CRYPTOPUNKS_MARKET.toLowerCase() || c.toLowerCase() === WRAPPED_PUNKS.toLowerCase();
    const vaults = new Set<`0x${string}`>();
    const tokens: {id: bigint; vault: `0x${string}`}[] = [];
    for (const d of raw) {
        if (d.rights !== zeroHash) continue;
        // DelegationType: 1 = ALL, 2 = CONTRACT, 3 = ERC721
        if (d.type_ === 1 || (d.type_ === 2 && isPunkSource(d.contract_))) vaults.add(d.from);
        else if (d.type_ === 3 && isPunkSource(d.contract_) && d.tokenId <= 9_999n) tokens.push({id: d.tokenId, vault: d.from});
    }
    return {vaults: Array.from(vaults).slice(0, MAX_DELEGATION_VAULTS), tokens};
}

/* ---------- claim picker: the wallet's claimable punks — held directly, or via delegation ---------- */
// Mirrors Homage claim eligibility for BOTH ownership sources, on connect / explicit refresh only:
//   • Wrapped punks — WrappedPunks is ERC-721Enumerable, so balanceOf + tokenOfOwnerByIndex
//     lists them directly (no log scan). The raw market reports the wrapper as owner for these,
//     so claim() still validates: it unwraps to ownerOf == the connected wallet.
//   • Raw punks — discovered via the server API (data adapter), which is ownership-complete
//     (not window-bounded), then confirmed against the live punkIndexToAddress. Manual-id entry
//     (which verifies ownership AND delegation per id) remains the catch-all when the API is down.
//   • Delegated punks — delegate.xyz vaults that delegated this wallet (wallet-wide / punk
//     contract / single token) contribute their punks too, tagged with the vault; claiming one
//     routes through claimFor and mints to the vault.
// Every candidate is filtered to `isMinted == false` (the homage tokenId == punkId), so the
// picker only ever offers ids the claim will accept.
export function useOwnedPunks(
    address?: `0x${string}`,
    refreshKey?: number
): {punks: PunkPick[]; status: OwnedStatus} {
    const client = usePublicClient({chainId: getChainId()});
    const homage = getHomageAddress() ?? zeroAddress;
    const [state, setState] = useState<{punks: PunkPick[]; status: OwnedStatus}>({punks: [], status: 'idle'});

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!client || !address || !isHomageConfigured()) {
                setState({punks: [], status: 'idle'});
                return;
            }
            setState((s) => ({...s, status: 'loading'}));
            try {
                let partial = false;

                // ── the wallet's own punks ──
                const own = await scanWalletPunks(client, address);
                partial = partial || own.rawFailed;
                if (cancelled) return;

                // ── punks reachable through delegate.xyz (vault-wide + token-level) ──
                const merged = new Map<number, PunkPick>();
                for (const [id, wrapped] of own.held) merged.set(id, {id, wrapped});
                try {
                    const {vaults, tokens} = await claimDelegations(client, address);
                    for (const vault of vaults) {
                        if (cancelled) return;
                        const v = await scanWalletPunks(client, vault);
                        partial = partial || v.rawFailed;
                        for (const [id, wrapped] of v.held) if (!merged.has(id)) merged.set(id, {id, wrapped, vault});
                    }
                    // token-level delegations: confirm the vault still holds each punk (raw or wrapped)
                    const fresh = tokens.filter((t) => !merged.has(Number(t.id)));
                    if (fresh.length) {
                        const owners = await client.multicall({
                            contracts: fresh.map((t) => ({address: CRYPTOPUNKS_MARKET, abi: punksMarketAbi, functionName: 'punkIndexToAddress', args: [t.id]}) as const),
                            allowFailure: true,
                        });
                        const wrappedChecks = fresh.map((t, i) => ({t, raw: owners[i]?.status === 'success' ? (owners[i].result as string) : undefined}));
                        const needWrapped = wrappedChecks.filter((c) => c.raw?.toLowerCase() === WRAPPED_PUNKS.toLowerCase());
                        const wrappedOwners = needWrapped.length
                            ? await client.multicall({
                                  contracts: needWrapped.map((c) => ({address: WRAPPED_PUNKS, abi: wrappedPunksAbi, functionName: 'ownerOf', args: [c.t.id]}) as const),
                                  allowFailure: true,
                              })
                            : [];
                        for (const c of wrappedChecks) {
                            const id = Number(c.t.id);
                            if (!c.raw || merged.has(id)) continue;
                            if (c.raw.toLowerCase() === c.t.vault.toLowerCase()) merged.set(id, {id, wrapped: false, vault: c.t.vault});
                            else if (c.raw.toLowerCase() === WRAPPED_PUNKS.toLowerCase()) {
                                const wi = needWrapped.findIndex((n) => n.t === c.t);
                                const wo = wrappedOwners[wi];
                                if (wo?.status === 'success' && (wo.result as string).toLowerCase() === c.t.vault.toLowerCase()) {
                                    merged.set(id, {id, wrapped: true, vault: c.t.vault});
                                }
                            }
                        }
                    }
                } catch {
                    // registry unavailable -> own punks still shown; the manual path checks delegation per id
                }
                if (cancelled) return;

                // ── filter to unminted homages (tokenId == punkId) ──
                const ids = Array.from(merged.keys());
                const mintedReads = ids.length
                    ? await client.multicall({
                          contracts: ids.map((id) => ({address: homage, abi: homageAbi, functionName: 'isMinted', args: [BigInt(id)]}) as const),
                          allowFailure: true,
                      })
                    : [];
                if (cancelled) return;
                const punks: PunkPick[] = ids
                    .filter((_, i) => {
                        const r = mintedReads[i];
                        return r?.status === 'success' && r.result === false;
                    })
                    .map((id) => merged.get(id)!)
                    .sort((a, b) => a.id - b.id);

                setState({punks, status: partial ? 'partial' : 'ok'});
            } catch {
                if (!cancelled) setState({punks: [], status: 'error'});
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [client, address, refreshKey, homage]);

    return state;
}

/* ---------- read one homage's art + traits (minted ids: via the NFT's tokenURI) ---------- */
export function useHomageArt(id: number | null | undefined) {
    const homage = getHomageAddress() ?? zeroAddress;
    const enabled = id !== null && id !== undefined && Number.isInteger(id) && isHomageConfigured();
    const {data, isLoading, error} = useReadContract({
        address: homage,
        abi: homageAbi,
        functionName: 'tokenURI',
        args: [BigInt(enabled ? (id as number) : 0)],
        chainId: getChainId(),
        query: {enabled, staleTime: 60_000, ...READ_RETRY},
    });
    const meta = useMemo<TokenMeta | null>(() => (data ? decodeTokenURI(data as string) : null), [data]);
    const src = meta?.image ? anySvgToSrc(meta.image) : undefined;
    return {src, meta, isLoading, error};
}

/* ---------- read a sample (unminted) punk's homage straight from the renderer ---------- */
export function useSampleArt(id: number) {
    const renderer = getHomageRenderer() ?? zeroAddress;
    const enabled = !!getHomageRenderer() && Number.isInteger(id);
    const {data, isLoading} = useReadContract({
        address: renderer,
        abi: rendererAbi,
        functionName: 'renderSVG',
        args: [BigInt(id)],
        chainId: getChainId(),
        query: {enabled, staleTime: 5 * 60_000, ...READ_RETRY},
    });
    const src = data ? anySvgToSrc(data as string) : undefined;
    return {src, isLoading};
}

/* ---------- read a sample punk's homage WITH its full traits (renderer tokenURI) ---------- */
// `pfp` swaps to the circle (PFP) variant — same metadata/traits, art as circles.
export function useSamplePreview(id: number, pfp = false) {
    const renderer = getHomageRenderer() ?? zeroAddress;
    const enabled = !!getHomageRenderer() && Number.isInteger(id) && id >= 0 && id <= 9999;
    const {data, isLoading} = useReadContract({
        address: renderer,
        abi: rendererAbi,
        functionName: pfp ? 'tokenURIPfp' : 'tokenURI',
        args: [BigInt(enabled ? id : 0)],
        chainId: getChainId(),
        query: {enabled, staleTime: 5 * 60_000, ...READ_RETRY},
    });
    const meta = useMemo<TokenMeta | null>(() => (data ? decodeTokenURI(data as string) : null), [data]);
    const src = meta?.image ? anySvgToSrc(meta.image) : undefined;
    return {src, meta, isLoading};
}

/* ---------- owned homages: indexer API first, chunked Transfer(to=you) scan fallback ---------- */

/** Chunk [from, latest] into inclusive ≤5000-block ranges with NUMERIC bounds
 *  (the /api/rpc proxy fails closed on toBlock:'latest' or spans >5000). */
export function homageScanRanges(from: bigint, latest: bigint): Array<[bigint, bigint]> {
    const CHUNK = 5_000n;
    const ranges: Array<[bigint, bigint]> = [];
    if (from > latest) return ranges;
    let start = from;
    while (start <= latest) {
        const end = start + CHUNK - 1n > latest ? latest : start + CHUNK - 1n;
        ranges.push([start, end]);
        start = end + 1n;
    }
    return ranges;
}

// History is immutable, so a closed range (its end already below `latest` at fetch time) is
// cached for the rest of the session — a repeat scan pays the chunk walk once. The tail range
// (the one touching `latest`) is never cached, since it can still receive new events.
const homageRangeCache = new Map<string, bigint[]>();

/** Indexer-backed candidate ids via /api/homage/owned — one fetch replaces the
 *  closed-range chunk walk. Returns null on ANY failure (the route 503s when
 *  the indexer can't prove its homage tables are live), which sends the caller
 *  down the full log-scan fallback instead of trusting a hollow empty. */
async function fetchOwnedIdsFromApi(address: `0x${string}`): Promise<bigint[] | null> {
    try {
        const res = await fetch('/api/homage/owned?address=' + address);
        if (!res.ok) return null;
        const body = (await res.json()) as {ids?: unknown};
        if (!Array.isArray(body.ids) || !body.ids.every((id) => Number.isInteger(id))) return null;
        return (body.ids as number[]).map((id) => BigInt(id));
    } catch {
        return null;
    }
}

export async function fetchOwnedHomageIds(
    client: NonNullable<ReturnType<typeof usePublicClient>>,
    homage: `0x${string}`,
    address: `0x${string}`
): Promise<{ids: number[]; partial: boolean}> {
    const latest = await client.getBlockNumber();
    const deployBlock = getHomageDeployBlock();

    const candidates = new Set<bigint>();
    let partial = false;

    const indexed = await fetchOwnedIdsFromApi(address);
    if (indexed) {
        for (const id of indexed) candidates.add(id);
        // The indexer polls on the order of minutes, so a homage minted or
        // received moments ago can trail the API — one live tail chunk (the
        // same range the scan path never caches) closes that gap at constant
        // cost. Lag deeper than one chunk (~16h) is an indexer outage; the
        // ownerOf confirmation below keeps stale POSITIVES out regardless.
        const tailFrom = latest > 4_999n ? latest - 4_999n : 0n;
        const from = deployBlock !== undefined && BigInt(deployBlock) > tailFrom ? BigInt(deployBlock) : tailFrom;
        const logs = await client.getContractEvents({
            address: homage,
            abi: homageAbi,
            eventName: 'Transfer',
            args: {to: address},
            fromBlock: from,
            toBlock: latest,
        });
        for (const l of logs) {
            const id = (l.args as {tokenId?: bigint}).tokenId;
            if (id !== undefined) candidates.add(id);
        }
    } else {
        // Fallback: the full chunk walk from the deploy block.
        const from = deployBlock !== undefined ? BigInt(deployBlock) : (latest > 4_999n ? latest - 4_999n : 0n);
        partial = deployBlock === undefined;

        const chainId = getChainId();
        // Walk sequentially (not Promise.all) — the /api/rpc proxy per-IP-limits request bursts,
        // and history is immutable, so there's no benefit to racing the chunks.
        for (const [r0, r1] of homageScanRanges(from, latest)) {
            const cacheKey = `${chainId}:${homage}:${address}:${r0}`;
            const isTail = r1 >= latest;
            const cached = !isTail ? homageRangeCache.get(cacheKey) : undefined;
            if (cached) {
                for (const id of cached) candidates.add(id);
                continue;
            }
            const logs = await client.getContractEvents({
                address: homage,
                abi: homageAbi,
                eventName: 'Transfer',
                args: {to: address},
                fromBlock: r0,
                toBlock: r1,
            });
            const ids = logs
                .map((l) => (l.args as {tokenId?: bigint}).tokenId)
                .filter((x): x is bigint => x !== undefined);
            for (const id of ids) candidates.add(id);
            if (!isTail) homageRangeCache.set(cacheKey, ids);
        }
    }

    if (candidates.size === 0) return {ids: [], partial};

    const owners = await client.multicall({
        contracts: Array.from(candidates).map((id) => ({address: homage, abi: homageAbi, functionName: 'ownerOf', args: [id]}) as const),
        allowFailure: true,
    });
    const ids = Array.from(candidates)
        .filter((_, i) => {
            const r = owners[i];
            return r.status === 'success' && (r.result as string).toLowerCase() === address.toLowerCase();
        })
        .map(Number)
        .sort((a, b) => a - b);
    return {ids, partial};
}

// Candidates come from the indexer-backed /api/homage/owned (one fetch, mirroring how
// /api/owned-punks backs scanWalletPunks above) plus a live tail chunk; the chunked
// deploy-to-head scan remains as the fallback whenever the API can't serve. Either way,
// every candidate is confirmed against the live ownerOf multicall before display.
export function useOwnedHomages(address?: `0x${string}`, refreshKey?: number): {ids: number[]; status: OwnedStatus} {
    const client = usePublicClient({chainId: getChainId()});
    const homage = getHomageAddress() ?? zeroAddress;
    const [state, setState] = useState<{ids: number[]; status: OwnedStatus}>({ids: [], status: 'idle'});

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!client || !address || !isHomageConfigured()) {
                setState({ids: [], status: 'idle'});
                return;
            }
            setState((s) => ({...s, status: 'loading'}));
            try {
                const {ids, partial} = await fetchOwnedHomageIds(client, homage, address);
                if (cancelled) return;
                setState({ids, status: partial ? 'partial' : 'ok'});
            } catch {
                if (!cancelled) setState({ids: [], status: 'error'});
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [client, address, refreshKey, homage]);

    return state;
}
