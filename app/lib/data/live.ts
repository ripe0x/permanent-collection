// Production data adapter. Reads from the Ponder indexer GraphQL first;
// falls back to direct RPC reads via viem for protocol numbers that need
// sub-second freshness (currently: liveBidWei, since it's the headline
// number and must reflect actual live-bid balance as of the most recent
// block, not the last indexed block).

import {createPublicClient, http, fallback} from 'viem';
import {mainnet} from 'viem/chains';
import {abi as PatronAbi} from '@/lib/abis/Patron';
import {abi as PermanentCollectionAbi} from '@/lib/abis/PermanentCollection';
import {abi as BuybackBurnerAbi} from '@/lib/abis/BuybackBurner';
import {abi as PunkVaultAbi} from '@/lib/abis/PunkVault';
import {abi as PunkVaultTitleAuctionAbi} from '@/lib/abis/PunkVaultTitleAuction';
import {abi as PunksDataAbi} from '@/lib/abis/PunksData';
import {abi as CryptoPunksMarketAbi} from '@/lib/abis/CryptoPunksMarket';
import {abi as ReferralPayoutAbi} from '@/lib/abis/ReferralPayout';
import {abi as ArtCoinsHookSkimFeeAbi} from '@/lib/abis/ArtCoinsHookSkimFee';
import {getChainId, getContractAddresses, getRpcUrls, isProtocolLive} from '@/lib/config';
import {getIndexerClient, rethrowIfIndexerMisconfigured} from './indexer-client';
import {clearedSplitProvenanceEvents} from './clearedSplit';
import {countEligiblePunks, maskFromTraitIds} from './eligibleCount';
import {buildPoolKey, computePoolId} from '@/lib/swap/poolKey';
import {canonicalTarget, rarestFirst} from '@/lib/rarity';
import {readSoleCarrier, readSoleCarrierBatch} from '@/lib/sole-carrier';
import {buildTraitOptions, type TraitOptionEntry} from '@/lib/trait-options';
import {CATEGORIES} from '@/lib/categories';
import {PUNK_MASKS} from '@/lib/punkMasks';
import {buildMosaicSvg} from '@/lib/mosaic-svg';
import type {
    AcceptedBidEvent,
    ActiveAuction,
    AuctionDetail,
    DataAdapter,
    ReturnAuctionBidEntry,
    Hex,
    PunkStrategyListing,
    MarketReference,
    ProofView,
    ProofDetail,
    TitleNftView,
    ProtocolState,
    PunkEligibility,
    PunkProvenance,
    PunkProvenanceEvent,
    ReferralStatus,
    ResolvedAuction,
    TitleAuctionBidEntry,
    TitleAuctionPhase,
    TitleAuctionState,
    TraitOption,
    TraitView,
    Address,
} from './types';

const erc20Abi = [
    {
        type: 'function',
        name: 'totalSupply',
        stateMutability: 'view',
        inputs: [],
        outputs: [{type: 'uint256'}],
    },
] as const;

function getRpcClient() {
    const urls = getRpcUrls();
    // 30s timeout (vs viem's 10s default): a cold anvil fork serves big
    // multicalls by fetching each uncached slot from its upstream, which
    // on a rate-limited public RPC can take well past 10s. The longer
    // budget lets those reads land + cache instead of timing out. No
    // downside on a warm cache or a paid mainnet RPC (calls return fast).
    const transports = urls.map((u) => http(u, {timeout: 30_000}));
    return createPublicClient({
        chain: mainnet,
        transport: transports.length > 1 ? fallback(transports) : transports[0],
    });
}

// Honest all-zeros protocol state. Used two ways: the pre-deploy state (no
// protocol live → no chain reads, no fabricated numbers), and a safe fallback
// a caller can show if a live read fails rather than crashing the page.
export const ZERO_PROTOCOL_STATE: ProtocolState = {
    liveBidWei: 0n,
    liveBidPendingWei: 0n,
    liveBidProtocolLegPendingWei: 0n,
    asOfBlock: 0n,
    asOfTimestamp: 0n,
    collectedCount: 0,
    totalTraits: 111,
    acquisitionCount: 0,
    vaultedCount: 0,
    clearedCount: 0,
    proofsMintedCount: 0,
    totalTokenSupplyWei: 0n,
    totalTokenBurnedWei: 0n,
    isComplete: false,
    totalSwapVolumeWei: null,
    swapCount: null,
};

// Typed "not-deployed" Title auction state. Like ZERO_PROTOCOL_STATE: the
// pre-deploy state, and a safe fallback if a live Title read fails.
export function notDeployedTitleAuctionState(): TitleAuctionState {
    const addrs = getContractAddresses();
    return {
        phase: 'not-deployed',
        collectedCount: 0,
        isKickoffReady: false,
        isLive: false,
        isSettleable: false,
        kickedOff: false,
        settled: false,
        endsAt: 0n,
        highBidWei: 0n,
        minNextBidWei: 0n,
        restartCount: 0,
        extensionsThisRound: 0,
        pendingProceedsByAddr: {patron: 0n, payoutRecipient: 0n},
        patronAddr: addrs.patron,
        payoutRecipientAddr: '0x0000000000000000000000000000000000000000' as Address,
    };
}

/** Run an indexer GraphQL query, returning `fallback` if the indexer is
 *  unreachable. Keeps SSR pages rendering (degraded to the empty/pre-launch
 *  shape) instead of 500-ing on an indexer outage — the same posture as the
 *  home page's per-slice catch, but at the read level so every caller (pages +
 *  API routes) is covered. RPC-derived data in the same method is untouched.
 *  Never invents data: a failure yields the empty fallback, not a guess. Reads
 *  that already have their own RPC fallback keep that bespoke handling and do
 *  not route through here.
 *
 *  Only OUTAGES degrade. A misconfigured deploy (live protocol, production
 *  runtime, no INDEXER_URL) rethrows so the page fails loud instead of
 *  rendering empties that read as "no activity yet". */
async function indexerQuery<T>(query: string, fallback: T): Promise<T> {
    try {
        return await getIndexerClient().request<T>(query);
    } catch (e) {
        rethrowIfIndexerMisconfigured(e);
        return fallback;
    }
}

export class LiveAdapter implements DataAdapter {
    async getProtocolState(): Promise<ProtocolState> {
        // Pre-deploy: honest zeros, no chain reads, no fabricated numbers.
        if (!isProtocolLive()) {
            return ZERO_PROTOCOL_STATE;
        }
        const addrs = getContractAddresses();
        const rpc = getRpcClient();

        // Headline numbers come from chain (sub-second freshness). The rest
        // are read from the indexer to keep RPC budget tight.
        //
        // "Pending" = fee in flight to the live bid. Only the bid leg is
        // bid-bound, so only the LiveBidAdapter counts. It ALWAYS routes to
        // Patron via `LiveBidAdapter.sweep()`, and it's fed by its own
        // receive() (the hook's bid leg + the locker's LP-fee share) rather
        // than an escrow claim — so its balance IS its pending, with no escrow
        // slot to add. The ProtocolFeePhaseAdapter (protocol leg) sweeps to
        // PCController from block 1 and NEVER reaches the live bid, so it isn't
        // read here. The hook flushes accruals within each swap's own tx, so it
        // holds no claim balance between swaps.
        const [
            liveBidWei,
            liveBidAdapterBal,
            blockNumber,
            block,
            collectedCount,
            isComplete,
            tokenSupply,
            burned,
        ] = await Promise.all([
            rpc.readContract({
                address: addrs.patron,
                abi: PatronAbi,
                functionName: 'bidBalance',
            }) as Promise<bigint>,
            rpc.getBalance({address: addrs.liveBidAdapter}),
            rpc.getBlockNumber(),
            rpc.getBlock({blockTag: 'latest'}),
            rpc.readContract({
                address: addrs.permanentCollection,
                abi: PermanentCollectionAbi,
                functionName: 'collectedCount',
            }) as Promise<bigint>,
            rpc.readContract({
                address: addrs.permanentCollection,
                abi: PermanentCollectionAbi,
                functionName: 'isComplete',
            }) as Promise<boolean>,
            rpc.readContract({
                address: addrs.token,
                abi: erc20Abi,
                functionName: 'totalSupply',
            }) as Promise<bigint>,
            rpc.readContract({
                address: addrs.buybackBurner,
                abi: BuybackBurnerAbi,
                functionName: 'totalTokensBurned',
            }) as Promise<bigint>,
        ]);
        const liveBidPendingWei = liveBidAdapterBal;
        // The protocol leg is never bid-bound, so this is always 0. Kept in the
        // shape so older clients (and the sweep affordance) don't break.
        const liveBidProtocolLegPendingWei = 0n;

        // Counters come from the indexer. Queried with the swap-volume fields
        // first, then retried without them, so the page keeps its counts if
        // the deployed indexer predates `totalSwapVolumeWei`/`swapCount`
        // (added with the SkimSplit handler) — same resilience pattern as
        // protocolStats.ts.
        interface CounterRow {
            acquisitionCount: number;
            vaultedCount: number;
            clearedCount: number;
            totalSwapVolumeWei?: string;
            swapCount?: number;
        }
        const counterFields = 'acquisitionCount vaultedCount clearedCount';
        const protocolCounter = await (async (): Promise<CounterRow | null> => {
            try {
                const res = await getIndexerClient().request<{protocolCounter: CounterRow | null}>(
                    `{ protocolCounter(id: "global") { ${counterFields} totalSwapVolumeWei swapCount } }`,
                );
                return res.protocolCounter;
            } catch {
                const res = await indexerQuery<{protocolCounter: CounterRow | null}>(
                    `{ protocolCounter(id: "global") { ${counterFields} } }`,
                    {protocolCounter: null},
                );
                return res.protocolCounter;
            }
        })();

        // Proofs minted — read directly from PunkVault (single SLOAD); the
        // indexer counter is patched on each ProofMinted but the chain
        // value is what the UI's "issued" pill should reflect.
        let proofsMintedCount = 0;
        try {
            const count = (await rpc.readContract({
                address: addrs.punkVault,
                abi: PunkVaultAbi,
                functionName: 'totalProofsMinted',
            })) as bigint;
            proofsMintedCount = Number(count);
        } catch {
            // Vault not yet redeployed with the Proofs surface. Soft-fail.
            proofsMintedCount = 0;
        }

        return {
            liveBidWei,
            liveBidPendingWei,
            liveBidProtocolLegPendingWei,
            asOfBlock: blockNumber,
            asOfTimestamp: block.timestamp,
            collectedCount: Number(collectedCount),
            totalTraits: 111,
            acquisitionCount: protocolCounter?.acquisitionCount ?? 0,
            vaultedCount: protocolCounter?.vaultedCount ?? 0,
            clearedCount: protocolCounter?.clearedCount ?? 0,
            proofsMintedCount,
            totalTokenSupplyWei: tokenSupply,
            totalTokenBurnedWei: burned,
            isComplete,
            totalSwapVolumeWei:
                protocolCounter?.totalSwapVolumeWei != null
                    ? BigInt(protocolCounter.totalSwapVolumeWei)
                    : null,
            swapCount: protocolCounter?.swapCount ?? null,
        };
    }

    async getEligiblePunkCount(): Promise<number | null> {
        if (!isProtocolLive()) return null;
        // One indexer round-trip, zero chain reads. The collected bits are
        // exactly the vaulted Punks' recorded targets (only a vault-settle
        // sets a bit, and only the recorded target — hard invariant #6), and
        // the pending bits are the unsettled auctions' targets. Punks in an
        // unsettled auction or in the vault are in protocol custody and can't
        // accept; a rescued Punk (settled+cleared) is eligible again. limit
        // 1000 covers the protocol's whole life (≤111 vaultings, ≤111
        // concurrent auctions).
        const res = await indexerQuery<{
            vaultedPunks: {items: {punkId: number; collectedTraitId: number}[]};
            returnAuctions: {items: {punkId: number; targetTraitId: number}[]};
        } | null>(
            `{
            vaultedPunks(limit: 1000) { items { punkId collectedTraitId } }
            returnAuctions(where: {settled: false}, limit: 1000) { items { punkId targetTraitId } }
        }`,
            null,
        );
        // Indexer unreachable → unknown, not zero. Callers hide the figure.
        if (!res) return null;
        const collectedMask = maskFromTraitIds(
            res.vaultedPunks.items.map((v) => v.collectedTraitId),
        );
        const pendingMask = maskFromTraitIds(
            res.returnAuctions.items.map((a) => a.targetTraitId),
        );
        const blockedPunks = [
            ...res.vaultedPunks.items.map((v) => v.punkId),
            ...res.returnAuctions.items.map((a) => a.punkId),
        ];
        return countEligiblePunks(collectedMask, pendingMask, blockedPunks);
    }

    async getTraitGrid(): Promise<TraitView[]> {
        // The grid is the artwork: all 111 trait slots, drawn from PunksData
        // (a fixed external contract). Before the protocol is deployed there's
        // nothing collected — so the slots are all `uncollected` (mask 0) and
        // we skip the PC contract + indexer reads entirely. No fabricated data.
        let collectedMask = 0n;
        let pendingSet = new Set<number>();
        let acquisitionByPunk = new Map<
            number,
            {punkId: number; priceWei: string; targetTraitId: number}
        >();
        let firstVaulted = new Map<number, number>();
        if (isProtocolLive()) {
            const addrs = getContractAddresses();
            const rpc = getRpcClient();
            collectedMask = (await rpc.readContract({
                address: addrs.permanentCollection,
                abi: PermanentCollectionAbi,
                functionName: 'collectedMask',
            })) as bigint;

            // traitTrials carries each trait's contested-count (kept for a
            // future UI flourish; not surfaced in v1).
            await indexerQuery<{
                traitTrials: {items: {traitId: number; count: number}[]};
            }>(`{ traitTrials { items { traitId count } } }`, {traitTrials: {items: []}});

            const {returnAuctions} = await indexerQuery<{
                returnAuctions: {items: {targetTraitId: number; settled: boolean}[]};
            }>(
                `{ returnAuctions(where:{settled:false}) { items { targetTraitId settled } } }`,
                {returnAuctions: {items: []}},
            );
            pendingSet = new Set(
                returnAuctions.items.filter((s) => !s.settled).map((s) => s.targetTraitId),
            );

            const {vaultedPunks, acquisitions} = await indexerQuery<{
                vaultedPunks: {items: {punkId: number; collectedTraitId: number}[]};
                acquisitions: {items: {punkId: number; priceWei: string; targetTraitId: number}[]};
            }>(
                `{
                vaultedPunks { items { punkId collectedTraitId } }
                acquisitions { items { punkId priceWei targetTraitId } }
            }`,
                {vaultedPunks: {items: []}, acquisitions: {items: []}},
            );
            acquisitionByPunk = new Map(acquisitions.items.map((a) => [a.punkId, a]));
            firstVaulted = new Map(vaultedPunks.items.map((v) => [v.collectedTraitId, v.punkId]));
        }

        const out: TraitView[] = [];
        for (let i = 0; i < 111; i++) {
            const isCollected = (collectedMask >> BigInt(i)) & 1n;
            if (isCollected) {
                const punkId = firstVaulted.get(i);
                const acq = punkId !== undefined ? acquisitionByPunk.get(punkId) : undefined;
                out.push({
                    traitId: i,
                    state: 'permanent',
                    firstVaultedPunkId: punkId,
                    acceptedBidWei: acq ? BigInt(acq.priceWei) : undefined,
                });
            } else if (pendingSet.has(i)) {
                out.push({traitId: i, state: 'pending'});
            } else {
                out.push({traitId: i, state: 'uncollected'});
            }
        }
        return out;
    }

    async getActiveAuctions(): Promise<ActiveAuction[]> {
        if (!isProtocolLive()) return [];
        const {returnAuctions, traitTrials} = await indexerQuery<{
            returnAuctions: {
                items: {
                    punkId: number;
                    targetTraitId: number;
                    acquisitionCost: string;
                    reserveWei: string;
                    startedAt: string;
                    endsAt: string;
                    highBidWei: string;
                    highBidder?: string;
                    extensions: number;
                    settled: boolean;
                }[];
            };
            traitTrials: {items: {traitId: number; count: number}[]};
        }>(
            `{
            returnAuctions(where:{settled:false}) {
                items {
                    punkId targetTraitId acquisitionCost reserveWei
                    startedAt endsAt highBidWei highBidder extensions settled
                }
            }
            traitTrials { items { traitId count } }
        }`,
            {returnAuctions: {items: []}, traitTrials: {items: []}},
        );
        const trialByTrait = new Map(traitTrials.items.map((t) => [t.traitId, t.count]));
        return returnAuctions.items
            .filter((s) => !s.settled)
            .map((s) => ({
                punkId: s.punkId,
                targetTraitId: s.targetTraitId,
                acquisitionCostWei: BigInt(s.acquisitionCost),
                reserveWei: BigInt(s.reserveWei),
                highBidWei: BigInt(s.highBidWei),
                highBidder: s.highBidder as `0x${string}` | undefined,
                startedAt: BigInt(s.startedAt),
                endsAt: BigInt(s.endsAt),
                extensions: s.extensions,
                attemptCount: trialByTrait.get(s.targetTraitId) ?? 1,
            }))
            .sort((a, b) => (a.endsAt < b.endsAt ? -1 : 1));
    }

    async getRecentResolutions(limit = 10): Promise<ResolvedAuction[]> {
        if (!isProtocolLive()) return [];
        const {returnAuctions} = await indexerQuery<{
            returnAuctions: {
                items: {
                    punkId: number;
                    targetTraitId: number;
                    outcome: string;
                    highBidWei: string;
                    endsAt: string;
                }[];
            };
        }>(
            `{
            returnAuctions(where:{settled:true}, orderBy:"endsAt", orderDirection:"desc", limit:${limit}) {
                items { punkId targetTraitId outcome highBidWei endsAt }
            }
        }`,
            {returnAuctions: {items: []}},
        );
        const {acquisitions} = await indexerQuery<{
            acquisitions: {items: {punkId: number; priceWei: string}[]};
        }>(
            `{
            acquisitions { items { punkId priceWei } }
        }`,
            {acquisitions: {items: []}},
        );
        const priceByPunk = new Map(
            acquisitions.items.map((a) => [a.punkId, BigInt(a.priceWei)]),
        );
        return returnAuctions.items.map((s) => ({
            punkId: s.punkId,
            targetTraitId: s.targetTraitId,
            outcome: s.outcome === 'Cleared' ? 'cleared' : 'vaulted',
            finalBidWei: BigInt(s.highBidWei),
            acquisitionPriceWei: priceByPunk.get(s.punkId),
            settledAt: BigInt(s.endsAt),
            txHash: '0x' as `0x${string}`, // TODO: indexer needs to store settle tx hash
        }));
    }

    async getRecentAcceptedBids(limit = 10): Promise<AcceptedBidEvent[]> {
        if (!isProtocolLive()) return [];
        const {bidEvents} = await indexerQuery<{
            bidEvents: {
                items: {
                    kind: string;
                    punkId?: number;
                    seller?: string;
                    caller?: string;
                    amount: string;
                    blockNumber: string;
                    timestamp: string;
                    txHash: string;
                }[];
            };
        }>(
            `{
            bidEvents(
                where:{kind_in:["Accepted","ListingAccepted"]}
                orderBy:"blockNumber" orderDirection:"desc" limit:${limit}
            ) {
                items { kind punkId seller caller amount blockNumber timestamp txHash }
            }
        }`,
            {bidEvents: {items: []}},
        );
        return bidEvents.items
            .filter((e) => e.punkId !== undefined && e.punkId !== null)
            .map((e) => ({
                kind: e.kind === 'Accepted' ? ('bidAccepted' as const) : ('listingAccepted' as const),
                punkId: e.punkId as number,
                actor: (e.kind === 'Accepted' ? e.seller : e.caller) as `0x${string}`,
                amountWei: BigInt(e.amount),
                blockNumber: BigInt(e.blockNumber),
                timestamp: BigInt(e.timestamp),
                txHash: e.txHash as `0x${string}`,
            }));
    }

    async getAuctionByPunkId(punkId: number): Promise<AuctionDetail | null> {
        if (!isProtocolLive()) return null;
        const all = await this.getActiveAuctions();
        return all.find((a) => a.punkId === punkId) ?? null;
    }

    async getResolvedAuctionByPunkId(punkId: number): Promise<ResolvedAuction | null> {
        if (!isProtocolLive()) return null;
        // Latest settled auction for this Punk (a Punk can be re-auctioned, so
        // order by close time and take the most recent).
        const {returnAuctions} = await indexerQuery<{
            returnAuctions: {
                items: {
                    punkId: number;
                    targetTraitId: number;
                    outcome: string;
                    highBidWei: string;
                    bountyShareWei: string | null;
                    burnShareWei: string | null;
                    endsAt: string;
                }[];
            };
        }>(
            `{
            returnAuctions(where:{settled:true, punkId:${punkId}}, orderBy:"endsAt", orderDirection:"desc", limit:1) {
                items { punkId targetTraitId outcome highBidWei bountyShareWei burnShareWei endsAt }
            }
        }`,
            {returnAuctions: {items: []}},
        );
        const s = returnAuctions.items[0];
        if (!s) return null;
        // The acquisition price (live bid at acceptance) for the context line.
        const {acquisitions} = await indexerQuery<{
            acquisitions: {items: {punkId: number; priceWei: string}[]};
        }>(`{ acquisitions { items { punkId priceWei } } }`, {acquisitions: {items: []}});
        const acq = acquisitions.items.filter((a) => a.punkId === punkId).at(-1);
        return {
            punkId: s.punkId,
            targetTraitId: s.targetTraitId,
            outcome: s.outcome === 'Cleared' ? 'cleared' : 'vaulted',
            finalBidWei: BigInt(s.highBidWei),
            acquisitionPriceWei: acq ? BigInt(acq.priceWei) : undefined,
            // Cleared-path split (the indexer stores liveBidShare as
            // `bountyShareWei`). Vault-burn is the remainder, computed in the UI.
            liveBidShareWei: s.bountyShareWei != null ? BigInt(s.bountyShareWei) : undefined,
            burnShareWei: s.burnShareWei != null ? BigInt(s.burnShareWei) : undefined,
            settledAt: BigInt(s.endsAt),
            txHash: '0x' as `0x${string}`, // indexer doesn't store the settle tx hash yet
        };
    }

    async getPunkEligibility(punkId: number, caller?: Address): Promise<PunkEligibility> {
        if (!isProtocolLive()) {
            return {
                punkId,
                owner: '0x0000000000000000000000000000000000000000' as Address,
                caller,
                isOwnedByCaller: false,
                mask: 0n,
                uncollectedBits: [],
                pendingBits: [],
                canonicalTargetId: undefined,
                listedToPatron: false,
                alreadyRecorded: false,
                soleCarrier: {required: false, requiredTraitId: 0},
            };
        }
        const addrs = getContractAddresses();
        const rpc = getRpcClient();

        const [owner, mask, collectedMask, recordedCustody, listing, soleCarrier, liveBidWei] =
            await Promise.all([
                rpc.readContract({
                    address: addrs.punksMarket,
                    abi: CryptoPunksMarketAbi,
                    functionName: 'punkIndexToAddress',
                    args: [BigInt(punkId)],
                }) as Promise<Address>,
                rpc.readContract({
                    address: addrs.punksData,
                    abi: PunksDataAbi,
                    functionName: 'traitMaskOf',
                    args: [punkId],
                }) as Promise<bigint>,
                rpc.readContract({
                    address: addrs.permanentCollection,
                    abi: PermanentCollectionAbi,
                    functionName: 'collectedMask',
                }) as Promise<bigint>,
                rpc.readContract({
                    address: addrs.permanentCollection,
                    abi: PermanentCollectionAbi,
                    functionName: 'custodyOf',
                    args: [punkId],
                }) as Promise<number>,
                rpc.readContract({
                    address: addrs.punksMarket,
                    abi: CryptoPunksMarketAbi,
                    functionName: 'punksOfferedForSale',
                    args: [BigInt(punkId)],
                }) as Promise<readonly [boolean, bigint, Address, bigint, Address]>,
                // Sole-carrier guard (hard invariant #22) — single source of
                // truth, fail-open. Parallel with the rest so it adds no latency.
                readSoleCarrier(rpc, addrs.permanentCollection, punkId),
                rpc.readContract({
                    address: addrs.patron,
                    abi: PatronAbi,
                    functionName: 'bidBalance',
                }) as Promise<bigint>,
            ]);

        // Pending = uncollected bits that are targets of active return auctions.
        // Indexer-only; if it's unreachable, fall back to an empty pending set
        // (correct in the launch window — no auctions yet — and the on-chain
        // TargetTraitAlreadyPending guard is the real backstop later). All the
        // RPC-derived eligibility data above is unaffected, so accept-bid still
        // works during an indexer outage.
        const {returnAuctions} = await indexerQuery<{
            returnAuctions: {items: {targetTraitId: number; settled: boolean}[]};
        }>(
            `{ returnAuctions(where:{settled:false}) { items { targetTraitId settled } } }`,
            {returnAuctions: {items: []}},
        );
        const pendingSet = new Set(
            returnAuctions.items.filter((s) => !s.settled).map((s) => s.targetTraitId),
        );

        const uncollectedBits: number[] = [];
        const pendingBits: number[] = [];
        for (let i = 0; i < 111; i++) {
            if ((mask >> BigInt(i)) & 1n) {
                if ((collectedMask >> BigInt(i)) & 1n) continue;
                uncollectedBits.push(i);
                if (pendingSet.has(i)) pendingBits.push(i);
            }
        }

        const [isForSale, , , minValue, onlySellTo] = listing;
        // The Punk is "already listed to the hub, ready for acceptBid" exactly
        // when the 2017-market listing is the priced, hub-exclusive offer that
        // `Patron.acceptBid` will accept: exclusive to Patron, a NON-zero price
        // (a 0 price reverts `ZeroListingPrice`), and at-or-below the live bid
        // (`minValue > bid` reverts `ListingExceedsBid`). The acceptBid list
        // step lists at the live bid, so this matches a real pre-listing. (The
        // prior `minValue === 0n` predicate was the inverse of the on-chain
        // rule — a 0-price listing would never be acceptable — and never fired
        // for the priced-listing flow.)
        const listedToPatron =
            isForSale &&
            onlySellTo.toLowerCase() === addrs.patron.toLowerCase() &&
            minValue > 0n &&
            minValue <= liveBidWei;

        return {
            punkId,
            owner,
            caller,
            isOwnedByCaller: caller !== undefined && owner.toLowerCase() === caller.toLowerCase(),
            mask,
            // Rarest-first so the picker defaults to the rarest uncollected
            // trait. The sole carrier of a trait (count 1) always sorts first.
            uncollectedBits: rarestFirst(uncollectedBits),
            pendingBits,
            // Protocol-derived acceptance target (canonicalTargetOf mirror):
            // rarest uncollected non-pending bit. The caller no longer chooses.
            canonicalTargetId: canonicalTarget(uncollectedBits, pendingBits),
            listedToPatron,
            alreadyRecorded: recordedCustody !== 0,
            soleCarrier,
        };
    }

    async getOwnedTraitOptions(owner: Address): Promise<TraitOption[]> {
        if (!isProtocolLive()) return [];
        const owned = await this.getPunksOwnedBy(owner);
        if (owned.length === 0) return [];

        const addrs = getContractAddresses();
        const rpc = getRpcClient();

        // Global collected set (once) + in-flight pending targets (indexer).
        const [collectedMask, indexed] = await Promise.all([
            rpc.readContract({
                address: addrs.permanentCollection,
                abi: PermanentCollectionAbi,
                functionName: 'collectedMask',
            }) as Promise<bigint>,
            indexerQuery<{
                returnAuctions: {items: {targetTraitId: number; settled: boolean}[]};
            }>(
                `{ returnAuctions(where:{settled:false}) { items { targetTraitId settled } } }`,
                {returnAuctions: {items: []}},
            ),
        ]);
        const pendingBits = new Set(
            indexed.returnAuctions.items.filter((s) => !s.settled).map((s) => s.targetTraitId),
        );

        // Per-Punk mask + sole-carrier constraint, each batched into a single
        // multicall regardless of how many Punks the wallet holds (RPC
        // discipline — no per-Punk fan-out).
        const [masks, constraints] = await Promise.all([
            rpc.multicall({
                contracts: owned.map((punkId) => ({
                    address: addrs.punksData,
                    abi: PunksDataAbi,
                    functionName: 'traitMaskOf' as const,
                    args: [punkId] as const,
                })),
                allowFailure: false,
            }) as Promise<bigint[]>,
            readSoleCarrierBatch(rpc, addrs.permanentCollection, owned),
        ]);

        const entries: TraitOptionEntry[] = owned.map((punkId, i) => ({
            punkId,
            mask: masks[i],
            soleCarrier: constraints[i] ?? {required: false, requiredTraitId: 0},
        }));
        return buildTraitOptions(entries, collectedMask, pendingBits);
    }

    async getPunksListedToPatron(punkIds: number[]): Promise<number[]> {
        if (!isProtocolLive() || punkIds.length === 0) return [];
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        // One multicall over the candidates + a single live-bid read — no
        // per-Punk fan-out (RPC discipline).
        const [listings, liveBidWei] = await Promise.all([
            rpc.multicall({
                contracts: punkIds.map((punkId) => ({
                    address: addrs.punksMarket,
                    abi: CryptoPunksMarketAbi,
                    functionName: 'punksOfferedForSale' as const,
                    args: [BigInt(punkId)] as const,
                })),
                allowFailure: false,
            }) as Promise<readonly (readonly [boolean, bigint, Address, bigint, Address])[]>,
            rpc.readContract({
                address: addrs.patron,
                abi: PatronAbi,
                functionName: 'bidBalance',
            }) as Promise<bigint>,
        ]);
        const patron = addrs.patron.toLowerCase();
        const out: number[] = [];
        punkIds.forEach((punkId, i) => {
            // Same predicate as getPunkEligibility.listedToPatron: exclusive to
            // Patron, non-zero price, at or below the live bid.
            const [isForSale, , , minValue, onlySellTo] = listings[i];
            if (
                isForSale &&
                onlySellTo.toLowerCase() === patron &&
                minValue > 0n &&
                minValue <= liveBidWei
            ) {
                out.push(punkId);
            }
        });
        return out;
    }

    async getPunkProvenance(punkId: number): Promise<PunkProvenance> {
        if (!isProtocolLive()) return {punkId, events: []};
        const ZERO = ZERO_ADDRESS;
        const events: PunkProvenanceEvent[] = [];
        let currentListing: PunkProvenance['currentListing'];

        // Protocol lifecycle events (indexer). Wrapped independently so a
        // down/empty indexer still leaves the market history below intact.
        try {
            const data = await getIndexerClient().request<{
                acquisition: {targetTraitId: number} | null;
                returnAuction:
                    | {
                          targetTraitId: number;
                          endsAt: string;
                          highBidWei: string;
                          bountyShareWei: string | null;
                          burnShareWei: string | null;
                          settled: boolean;
                          outcome?: string | null;
                      }
                    | null;
                vaultedPunk: {collectedTraitId: number; txHash: string} | null;
                bidEvents: {
                    items: {kind: string; amount: string; seller?: string; caller?: string; timestamp: string; txHash: string}[];
                };
                bids: {items: {bidder: string; amount: string; timestamp: string; txHash: string}[]};
            }>(`{
                acquisition(id: ${punkId}) { targetTraitId }
                returnAuction(id: ${punkId}) { targetTraitId endsAt highBidWei bountyShareWei burnShareWei settled outcome }
                vaultedPunk(id: ${punkId}) { collectedTraitId txHash }
                bidEvents(where:{punkId:${punkId}, kind_in:["Accepted","ListingAccepted"]}) {
                    items { kind amount seller caller timestamp txHash }
                }
                bids(where:{punkId:${punkId}}) { items { bidder amount timestamp txHash } }
            }`);

            const targetTraitId = data.acquisition?.targetTraitId ?? data.returnAuction?.targetTraitId;

            for (const e of data.bidEvents.items) {
                events.push({
                    kind: 'acquired',
                    source: 'protocol',
                    amountWei: BigInt(e.amount),
                    traitId: targetTraitId,
                    actor: ((e.kind === 'Accepted' ? e.seller : e.caller) ?? undefined) as Address | undefined,
                    timestamp: BigInt(e.timestamp),
                    txHash: e.txHash as Hex,
                });
            }

            for (const b of data.bids.items) {
                events.push({
                    kind: 'bid',
                    source: 'protocol',
                    amountWei: BigInt(b.amount),
                    actor: b.bidder as Address,
                    timestamp: BigInt(b.timestamp),
                    txHash: b.txHash as Hex,
                });
            }

            const fs = data.returnAuction;
            if (fs?.settled) {
                if (fs.outcome === 'Vaulted') {
                    events.push({
                        kind: 'vaulted',
                        source: 'protocol',
                        traitId: data.vaultedPunk?.collectedTraitId ?? fs.targetTraitId,
                        timestamp: BigInt(fs.endsAt),
                        txHash: (data.vaultedPunk?.txHash ?? undefined) as Hex | undefined,
                    });
                } else if (fs.outcome === 'Cleared') {
                    events.push({
                        kind: 'returned',
                        source: 'protocol',
                        amountWei: BigInt(fs.highBidWei),
                        traitId: fs.targetTraitId,
                        timestamp: BigInt(fs.endsAt),
                    });
                    events.push(
                        ...clearedSplitProvenanceEvents({
                            finalBidWei: BigInt(fs.highBidWei),
                            liveBidShareWei: fs.bountyShareWei != null ? BigInt(fs.bountyShareWei) : undefined,
                            burnShareWei: fs.burnShareWei != null ? BigInt(fs.burnShareWei) : undefined,
                            traitId: fs.targetTraitId,
                            timestamp: BigInt(fs.endsAt),
                        }),
                    );
                }
            }
        } catch (e) {
            rethrowIfIndexerMisconfigured(e);
            // Indexer unreachable — fall through with whatever protocol events
            // we have (possibly none) and still attach market history below.
        }

        // Current public 2017-market offer — authoritative chain read (one
        // call). Surfaced as `currentListing` for the detail page; the timeline's
        // listing/sale/transfer events come from the market-history merge below.
        // Patron-targeted (private) offers from the acceptBid flow are skipped —
        // only public listings (onlySellTo == 0) are shown.
        try {
            const offer = (await getRpcClient().readContract({
                address: getContractAddresses().punksMarket,
                abi: CryptoPunksMarketAbi,
                functionName: 'punksOfferedForSale',
                args: [BigInt(punkId)],
            })) as readonly [boolean, bigint, Address, bigint, Address];
            const [isForSale, , seller, minValue, onlySellTo] = offer;
            if (isForSale && onlySellTo.toLowerCase() === ZERO && minValue > 0n) {
                currentListing = {minValueWei: minValue, seller};
            }
        } catch {
            // Market read failed — leave currentListing undefined.
        }

        // Merge in recent public 2017-market history (cryptopunks.app). Dedupe
        // by tx hash so a protocol acquisition or vault isn't also listed as a
        // raw market sale/transfer.
        const protocolTxs = new Set(
            events.map((e) => e.txHash?.toLowerCase()).filter((h): h is string => !!h),
        );
        for (const m of await fetchPunkMarketHistory(punkId)) {
            if (m.txHash && protocolTxs.has(m.txHash.toLowerCase())) continue;
            events.push(m);
        }

        events.sort((a, b) => (a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? 1 : -1));
        return {punkId, events, currentListing};
    }

    async getTraitNames(): Promise<string[]> {
        // Trait names come from PunksData, which is sealed (its datasetHash is
        // pinned) — so the 111 names are an immutable constant, snapshotted at
        // build time into categories.ts by scripts/snapshot-punksdata.ts. Read
        // them from that static snapshot rather than the chain: a per-render
        // 111-call multicall is both a needless chain fan-out for immutable
        // data and fragile — several public RPCs reject an aggregate that
        // size, so a single throw here would reject the whole page's
        // Promise.all and 500 the server render. CATEGORIES is contiguous over
        // bits 0..110; index by bit so the array lines up with traitId.
        const names: string[] = new Array(111).fill('');
        for (const c of CATEGORIES) {
            if (c.bit >= 0 && c.bit < 111) names[c.bit] = c.name;
        }
        return names;
    }

    async getPunkSprite(punkId: number): Promise<{indexed: Uint8Array; palette: Uint8Array}> {
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const [indexedHex, paletteHex] = await Promise.all([
            rpc.readContract({
                address: addrs.punksData,
                abi: PunksDataAbi,
                functionName: 'indexedPixelsOf',
                args: [punkId],
            }) as Promise<`0x${string}`>,
            getCachedPalette(addrs.punksData, rpc),
        ]);
        return {
            indexed: hexToBytes(indexedHex),
            palette: paletteHex,
        };
    }

    async getPunksOwnedBy(owner: Address): Promise<number[]> {
        // Ownership lookup, sourced cheapest-first (per the project's
        // "indexer/cache first, RPC last" rule). Enumerating ownership the
        // pure-RPC way means scanning all 10k punkIndexToAddress slots (the
        // 2017 contract has no enumerable interface) — ~10k reads *per
        // visit*, brutal on a cold or rate-limited node. We avoid that:
        //
        //   • Mainnet → cryptopunks.app's public account API. One cached
        //     call returns the wallet's complete holdings (no start-block
        //     gap, no backfill). It only knows mainnet state, so it's
        //     mainnet-only.
        //   • Last resort (non-mainnet, or API down) → the on-chain 10k-slot
        //     scan.
        if (getChainId() === 1) {
            try {
                return await fetchOwnedFromCryptopunksApi(owner);
            } catch {
                // API unreachable/changed — fall through to the on-chain scan.
            }
        }
        return this._scanPunksOwnedByOnChain(owner);
    }

    /** Fallback ownership enumeration: walk the 10k punkIndexToAddress slots
     *  via Multicall3. Only used when the indexer is unreachable — it's
     *  ~10k reads and slow on a cold/throttled node. 250-slot batches keep
     *  each aggregate call inside the RPC timeout on a cold anvil fork. */
    private async _scanPunksOwnedByOnChain(owner: Address): Promise<number[]> {
        const TOTAL = 10_000;
        const BATCH = 250;
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const ownerLc = owner.toLowerCase();
        const out: number[] = [];
        for (let start = 0; start < TOTAL; start += BATCH) {
            const end = Math.min(start + BATCH, TOTAL);
            const contracts = [];
            for (let i = start; i < end; i++) {
                contracts.push({
                    address: addrs.punksMarket,
                    abi: CryptoPunksMarketAbi,
                    functionName: 'punkIndexToAddress' as const,
                    args: [BigInt(i)] as const,
                });
            }
            const results = (await rpc.multicall({
                contracts,
                allowFailure: false,
            })) as Address[];
            for (let j = 0; j < results.length; j++) {
                if (results[j].toLowerCase() === ownerLc) {
                    out.push(start + j);
                }
            }
        }
        return out;
    }

    async getRendererSvg(): Promise<string | null> {
        // The homepage mosaic is built off-chain from the same trait state +
        // artwork source (lib/trait-tile.ts via buildMosaicSvg) that the
        // /collection grid renders from, so the two surfaces always agree.
        // It is deliberately NOT the live on-chain tokenURI(): that render
        // cycles its six rare type/head cells per block (see RotationPool),
        // which would re-diverge the homepage from /collection every block.
        // getTraitGrid() returns honest all-uncollected state pre-launch and
        // real collection progress once the protocol is live — both render
        // correctly here.
        return buildMosaicSvg(await this.getTraitGrid());
    }

    async getTitleSvg(): Promise<string | null> {
        // tokenURI(111) wraps the same mosaic SVG as the zero-arg tokenURI()
        // but inside the Title-flavored JSON envelope. Same gas profile —
        // the renderer composes all 111 trait visuals — so it uses the
        // same raw-call path with an explicit gas budget. Falls back to
        // null on revert/upstream error so the Title page shows its
        // placeholder instead of breaking.
        //
        // Calldata: selector(tokenURI(uint256)) + uint256(111) padded.
        return this._fetchRendererSvg(
            '0xc87b56dd000000000000000000000000000000000000000000000000000000000000006f',
        );
    }

    private async _fetchRendererSvg(callData: `0x${string}`): Promise<string | null> {
        try {
            const addrs = getContractAddresses();
            const rpc = getRpcClient();
            const {data} = await rpc.call({
                to: addrs.renderer,
                data: callData,
                gas: 600_000_000n,
            });
            if (!data || data === '0x') return null;
            // Decode the ABI-encoded string: 32-byte offset, 32-byte length,
            // then `length` bytes of UTF-8 payload (padded to 32-byte words).
            const hex = data.startsWith('0x') ? data.slice(2) : data;
            if (hex.length < 128) return null;
            const len = Number.parseInt(hex.slice(64, 128), 16);
            if (!Number.isFinite(len) || len <= 0) return null;
            const bytes = Buffer.from(hex.slice(128, 128 + len * 2), 'hex');
            const tokenUri = bytes.toString('utf8');
            return extractSvgFromDataUri(tokenUri);
        } catch {
            return null;
        }
    }

    async getPunkStrategyListings(): Promise<PunkStrategyListing[]> {
        if (!isProtocolLive()) return [];
        // Surface listings any visitor can accept via
        // `Patron.acceptListing(punkId, targetTraitId)`. The contract's
        // eligibility checks (Patron.sol lines 408-447): bounty ≥ 0.5 ETH,
        // seller in `allowedSellers` and past 24h activation, listing is
        // public (onlySellTo == zero), price > 0, target trait is on the
        // Punk's mask, uncollected, and not currently pending.
        //
        // The seller filter is the on-chain `allowedSellers` mapping —
        // PunkStrategy is the only allowlisted seller at launch, hence the
        // PunkStrategy-flavoured naming, but any future aligned listing
        // contract added to the allowlist will appear here too without a
        // frontend change.
        //
        // Wraps the whole pipeline in a try/catch: this is an opportunistic
        // surface, never a launch-blocker. If indexer or RPC are down the
        // section vanishes rather than breaking the homepage.
        try {
            return await this._getPunkStrategyListingsInner();
        } catch (e) {
            rethrowIfIndexerMisconfigured(e);
            return [];
        }
    }

    private async _getPunkStrategyListingsInner(): Promise<PunkStrategyListing[]> {
        const MIN_BOUNTY = 5n * 10n ** 17n;
        const ALL_BITS = (1n << 111n) - 1n;
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const nowSec = BigInt(Math.floor(Date.now() / 1000));

        const [bidBalance, collectedMask, finderFeeCapBps, finderFeeFixedCap, indexed] =
            await Promise.all([
                rpc.readContract({
                    address: addrs.patron,
                    abi: PatronAbi,
                    functionName: 'bidBalance',
                }) as Promise<bigint>,
                rpc.readContract({
                    address: addrs.permanentCollection,
                    abi: PermanentCollectionAbi,
                    functionName: 'collectedMask',
                }) as Promise<bigint>,
                rpc.readContract({
                    address: addrs.patron,
                    abi: PatronAbi,
                    functionName: 'finderFeeCapBps',
                }) as Promise<bigint>,
                rpc.readContract({
                    address: addrs.patron,
                    abi: PatronAbi,
                    functionName: 'finderFeeFixedCap',
                }) as Promise<bigint>,
                // Allowlist + in-flight targets come from the PC indexer (not the
                // 2017 market). The listing book itself is sourced from
                // cryptopunks.app below, per-active-seller.
                getIndexerClient().request<{
                    allowlistEntries: {items: {seller: string}[]};
                    returnAuctions: {items: {targetTraitId: number; settled: boolean}[]};
                }>(`{
                    allowlistEntries(where:{active:true}) { items { seller } }
                    returnAuctions(where:{settled:false}) { items { targetTraitId settled } }
                }`),
            ]);

        if (bidBalance < MIN_BOUNTY) return [];

        // Resolve per-seller activeAt via RPC (allowlist is small — single
        // digits expected). The indexer's `addedAt` is a block number, not a
        // wall-clock activation, so the contract's mapping is the source of
        // truth for the 24h delay check.
        const sellers = indexed.allowlistEntries.items.map((e) => e.seller as Address);
        const activeAts = await Promise.all(
            sellers.map(
                (s) =>
                    rpc.readContract({
                        address: addrs.patron,
                        abi: PatronAbi,
                        functionName: 'allowedSellerActiveAt',
                        args: [s],
                    }) as Promise<bigint>,
            ),
        );
        const activeSellers = new Set<string>();
        for (let i = 0; i < sellers.length; i++) {
            if (activeAts[i] !== 0n && nowSec >= activeAts[i]) {
                activeSellers.add(sellers[i].toLowerCase());
            }
        }
        if (activeSellers.size === 0) return [];

        // Enumerate each active seller's currently-listed punk ids from
        // cryptopunks.app (its per-row price is a presentation-formatted string,
        // so we take ids + offeredAt only), then read precise terms — wei price,
        // onlySellTo, on-chain seller — from the market contract in one
        // multicall. Per-seller fetch failures are swallowed: this surface is
        // opportunistic.
        const listed = (
            await Promise.all(
                [...activeSellers].map((s) =>
                    fetchSellerListedPunkIds(s as Address).catch(() => []),
                ),
            )
        ).flat();
        const offeredAtById = new Map<number, bigint>();
        for (const l of listed) {
            if (!offeredAtById.has(l.punkId)) offeredAtById.set(l.punkId, l.offeredAt);
        }
        const candidateIds = [...offeredAtById.keys()];
        if (candidateIds.length === 0) return [];

        const offers = (await rpc.multicall({
            contracts: candidateIds.map((punkId) => ({
                address: addrs.punksMarket,
                abi: CryptoPunksMarketAbi,
                functionName: 'punksOfferedForSale' as const,
                args: [BigInt(punkId)] as const,
            })),
            allowFailure: false,
        })) as readonly (readonly [boolean, bigint, Address, bigint, Address])[];

        const pendingSet = new Set(
            indexed.returnAuctions.items.filter((s) => !s.settled).map((s) => s.targetTraitId),
        );

        const a = (bidBalance * finderFeeCapBps) / 10000n;
        const finderFee = a < finderFeeFixedCap ? a : finderFeeFixedCap;

        const out: PunkStrategyListing[] = [];
        candidateIds.forEach((punkId, i) => {
            // Public listing (onlySellTo == 0), priced, at or below the live bid,
            // by a still-active allowlisted seller. The on-chain seller is the
            // source of truth — it guards against a stale API enumeration.
            const [isForSale, , offerSeller, minValue, onlySellTo] = offers[i];
            if (!isForSale) return;
            if (onlySellTo.toLowerCase() !== ZERO_ADDRESS) return;
            if (minValue === 0n || minValue > bidBalance) return;
            if (!activeSellers.has(offerSeller.toLowerCase())) return;

            const mask = PUNK_MASKS[punkId];
            if (mask === undefined) return;
            const uncollected = mask & ALL_BITS & ~collectedMask;
            const eligible: number[] = [];
            for (let bit = 0; bit < 111; bit++) {
                if (((uncollected >> BigInt(bit)) & 1n) && !pendingSet.has(bit)) {
                    eligible.push(bit);
                }
            }
            if (eligible.length === 0) return;

            const ranked = rarestFirst(eligible);
            out.push({
                punkId,
                seller: offerSeller,
                minValueWei: minValue,
                suggestedTraitId: ranked[0],
                eligibleTraitIds: ranked,
                finderFeeWei: finderFee,
                bountyCostWei: minValue + finderFee,
                listedAt: offeredAtById.get(punkId) ?? 0n,
                soleCarrier: {required: false, requiredTraitId: 0},
            });
        });

        // Sole-carrier guard per listed Punk — one multicall, fail-open. When a
        // listed Punk is the unique carrier of its target trait, default the
        // suggestion to that trait so the row can't pre-select a guaranteed
        // revert. (rarestFirst already floats a count-1 trait to the front, so
        // this is also defence-in-depth.)
        const constraints = await readSoleCarrierBatch(
            rpc,
            addrs.permanentCollection,
            out.map((o) => o.punkId),
        );
        for (let i = 0; i < out.length; i++) {
            const sc = constraints[i] ?? {required: false, requiredTraitId: 0};
            out[i].soleCarrier = sc;
            if (sc.required && out[i].eligibleTraitIds.includes(sc.requiredTraitId)) {
                out[i].suggestedTraitId = sc.requiredTraitId;
            }
        }
        return out.sort((a, b) => (a.minValueWei < b.minValueWei ? -1 : 1));
    }

    async getMarketReference(): Promise<MarketReference> {
        if (!isProtocolLive()) return {available: false};
        try {
            const collectedMask = (await getRpcClient().readContract({
                address: getContractAddresses().permanentCollection,
                abi: PermanentCollectionAbi,
                functionName: 'collectedMask',
            })) as bigint;
            return await marketReferenceFromFloorPunk(collectedMask);
        } catch {
            return {available: false};
        }
    }

    async getProofs(): Promise<ProofView[]> {
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        // Single SLOAD: bitmap of minted Proofs. Each bit i indicates
        // the Proof for trait i has been minted. Pre-launch (no vault
        // address) we skip the read and report all 111 slots unminted, so
        // the page still renders the full 111-slot structure instead of an
        // empty grid.
        let mintedMask: bigint;
        if (!isProtocolLive()) {
            mintedMask = 0n;
        } else {
            try {
                mintedMask = (await rpc.readContract({
                    address: addrs.punkVault,
                    abi: PunkVaultAbi,
                    functionName: 'proofsMintedMask',
                })) as bigint;
            } catch {
                // Vault not redeployed yet; report all unminted.
                mintedMask = 0n;
            }
        }
        // Static trait-name lookup is fine — PunksData is sealed.
        const traitNames = await this.getTraitNames();
        // For each minted Proof, read its `proofMeta`. Parallelize via
        // Multicall3 path (viem batches by default with `multicall: true`).
        const out: ProofView[] = new Array(111);
        const metaPromises: Promise<unknown>[] = [];
        const ownerPromises: Promise<unknown>[] = [];
        const mintedIds: number[] = [];
        for (let traitId = 0; traitId < 111; traitId++) {
            const bit = (mintedMask >> BigInt(traitId)) & 1n;
            const tokenId = traitId;
            if (bit === 1n) {
                mintedIds.push(traitId);
                metaPromises.push(
                    rpc.readContract({
                        address: addrs.punkVault,
                        abi: PunkVaultAbi,
                        functionName: 'proofMeta',
                        args: [BigInt(tokenId)],
                    }),
                );
                ownerPromises.push(
                    rpc.readContract({
                        address: addrs.punkVault,
                        abi: PunkVaultAbi,
                        functionName: 'ownerOf',
                        args: [BigInt(tokenId)],
                    }),
                );
            }
            out[traitId] = {
                tokenId,
                traitId,
                traitName: traitNames[traitId] ?? `Trait ${traitId}`,
                minted: bit === 1n,
                punkId: 0,
                sequence: 0,
                mintedAtBlock: 0n,
                currentOwner: null,
                svgMarkup: null,
            };
        }
        // Fetch on-chain SVG bytes for the MINTED Proofs only. An unminted
        // Proof has no tokenURI — the renderer reverts `ProofNotMinted`
        // (there is no preview envelope) — so its cell renders text-only.
        // Fetching only minted ids also avoids ~100 reverting eth_calls.
        // `svgs` is indexed parallel to `mintedIds`. Each call is
        // ~50-150M gas.
        const svgPromises = mintedIds.map((traitId) => this._fetchProofSvg(traitId));
        const [metas, owners, svgs] = await Promise.all([
            Promise.all(metaPromises),
            Promise.all(ownerPromises),
            Promise.allSettled(svgPromises),
        ]);
        for (let i = 0; i < mintedIds.length; i++) {
            const traitId = mintedIds[i]!;
            // ProofMeta returns a tuple: (punkId, traitId, sequence, mintedAtBlock)
            const meta = metas[i] as [number, number, number, bigint];
            const row = out[traitId]!;
            row.punkId = Number(meta[0]);
            row.sequence = Number(meta[2]);
            row.mintedAtBlock = meta[3];
            row.currentOwner = owners[i] as Address;
            const s = svgs[i];
            if (s && s.status === 'fulfilled') row.svgMarkup = s.value;
        }
        return out;
    }

    /** Read `proofRenderer.tokenURI(traitId)` via raw eth_call (so we can
     *  attach a generous gas budget — the renderer composes a full SVG
     *  inline and exceeds the default eth_call cap on most providers).
     *  Returns the inner SVG bytes after stripping the JSON envelope and
     *  the inner `data:image/svg+xml;base64,` data URI. The Proof
     *  renderer's dispatcher lives on the registry; we go through it so
     *  the call path matches `PunkVault.tokenURI(id)` exactly. */
    private async _fetchProofSvg(traitId: number): Promise<string | null> {
        try {
            const addrs = getContractAddresses();
            const rpc = getRpcClient();
            // selector(tokenURI(uint256)) + uint256(traitId) padded.
            const idHex = traitId.toString(16).padStart(64, '0');
            const callData = (`0xc87b56dd${idHex}`) as `0x${string}`;
            const {data} = await rpc.call({
                to: addrs.renderer,
                data: callData,
                gas: 600_000_000n,
            });
            if (!data || data === '0x') return null;
            const hex = data.startsWith('0x') ? data.slice(2) : data;
            if (hex.length < 128) return null;
            const len = Number.parseInt(hex.slice(64, 128), 16);
            if (!Number.isFinite(len) || len <= 0) return null;
            const bytes = Buffer.from(hex.slice(128, 128 + len * 2), 'hex');
            return extractSvgFromDataUri(bytes.toString('utf8'));
        } catch {
            return null;
        }
    }

    /** Title Auction state. Strategy: read everything chain-direct because
     *  the data is tiny (a single contract's small storage footprint) and
     *  the UI needs sub-second freshness on `isLive` / `endsAt` / `minNextBid`
     *  during an active round. The Ponder indexer carries the same data
     *  (singleton + bid log) and could front the bid history in `getTitleAuctionBids`,
     *  but the headline state is too time-sensitive to delegate. */
    async getTitleAuctionState(caller?: Address): Promise<TitleAuctionState> {
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const titleAuction = addrs.titleAuction;
        // Pre-deploy: surface a typed "not-deployed" state rather than reading
        // a zero address, so /title renders its pre-launch one-liner.
        if (!isProtocolLive() || !titleAuction) {
            return notDeployedTitleAuctionState();
        }

        const [
            kickedOff,
            settled,
            endsAt,
            highBidWei,
            highBidder,
            isKickoffReady,
            isLive,
            isSettleable,
            minNextBidWei,
            patronAddr,
            payoutRecipientAddr,
            collectedCount,
        ] = await Promise.all([
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'kickedOff'}) as Promise<boolean>,
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'settled'}) as Promise<boolean>,
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'endsAt'}) as Promise<bigint>,
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'highBidWei'}) as Promise<bigint>,
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'highBidder'}) as Promise<Address>,
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'isKickoffReady'}) as Promise<boolean>,
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'isLive'}) as Promise<boolean>,
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'isSettleable'}) as Promise<boolean>,
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'minNextBid'}) as Promise<bigint>,
            // The title auction's `patron` getter was removed (it now sends 100%
            // of cleared proceeds to payoutRecipient). That address was always the
            // protocol Patron, so read it from config; its title-auction pending
            // is structurally 0.
            Promise.resolve(addrs.patron as Address),
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'payoutRecipient'}) as Promise<Address>,
            this._readCollectedCountSafe(rpc, addrs.permanentCollection),
        ]);

        const [patronPending, payoutPending, refundForCaller] = await Promise.all([
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'pendingProceeds', args: [patronAddr]}) as Promise<bigint>,
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'pendingProceeds', args: [payoutRecipientAddr]}) as Promise<bigint>,
            caller
                ? (rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'pendingRefund', args: [caller]}) as Promise<bigint>)
                : Promise.resolve(undefined as unknown as bigint),
        ]);

        // restartCount + extensionsThisRound are indexer-tracked. Fall back to
        // 0/0 if the indexer can't answer — those fields are decorative
        // (round counter + extension count), never load-bearing.
        let restartCount = 0;
        let extensionsThisRound = 0;
        try {
            const {titleAuctionState} = await getIndexerClient().request<{
                titleAuctionState: {restartCount: number; extensionsThisRound: number} | null;
            }>(`{ titleAuctionState(id: "global") { restartCount extensionsThisRound } }`);
            if (titleAuctionState) {
                restartCount = titleAuctionState.restartCount;
                extensionsThisRound = titleAuctionState.extensionsThisRound;
            }
        } catch (e) {
            rethrowIfIndexerMisconfigured(e);
            // Indexer down or unaware — leave at 0. The chain-level views
            // above are the load-bearing source of truth.
        }

        const phase = pickTitleAuctionPhase({
            kickedOff,
            settled,
            isLive,
            isSettleable,
            isKickoffReady,
        });
        const zero = '0x0000000000000000000000000000000000000000' as Address;
        return {
            phase,
            collectedCount,
            isKickoffReady,
            isLive,
            isSettleable,
            kickedOff,
            settled,
            endsAt,
            highBidWei,
            highBidder: highBidder === zero ? undefined : highBidder,
            minNextBidWei,
            restartCount,
            extensionsThisRound,
            pendingProceedsByAddr: {patron: patronPending, payoutRecipient: payoutPending},
            patronAddr,
            payoutRecipientAddr,
            pendingRefundForCaller: caller ? (refundForCaller as bigint) : undefined,
        };
    }

    async getTitleAuctionBids(): Promise<TitleAuctionBidEntry[]> {
        if (!isProtocolLive()) return [];
        // Indexer-first (cheap GraphQL read). Fall back to a `getLogs` scan
        // from the deploy block if the indexer is unavailable so /title's
        // bid history is never blank when bids are actually on-chain.
        const addrs = getContractAddresses();
        const titleAuction = addrs.titleAuction;
        if (!titleAuction) return [];
        try {
            const {titleAuctionBids} = await getIndexerClient().request<{
                titleAuctionBids: {
                    items: {
                        bidder: string;
                        amount: string;
                        endsAt: string;
                        extended: boolean;
                        blockNumber: string;
                        timestamp: string;
                        txHash: string;
                    }[];
                };
            }>(`{
                titleAuctionBids(orderBy: "blockNumber", orderDirection: "desc", limit: 200) {
                    items { bidder amount endsAt extended blockNumber timestamp txHash }
                }
            }`);
            return titleAuctionBids.items.map((b) => ({
                bidder: b.bidder as Address,
                amount: BigInt(b.amount),
                endsAt: BigInt(b.endsAt),
                extended: b.extended,
                blockNumber: BigInt(b.blockNumber),
                timestamp: BigInt(b.timestamp),
                txHash: b.txHash as Hex,
            }));
        } catch (e) {
            rethrowIfIndexerMisconfigured(e);
            return this._titleBidsFromLogs(titleAuction);
        }
    }

    private async _titleBidsFromLogs(titleAuction: Address): Promise<TitleAuctionBidEntry[]> {
        const rpc = getRpcClient();
        try {
            const logs = await rpc.getLogs({
                address: titleAuction,
                event: {
                    type: 'event',
                    name: 'Bid',
                    inputs: [
                        {name: 'bidder', type: 'address', indexed: true},
                        {name: 'amount', type: 'uint256', indexed: false},
                        {name: 'endsAt', type: 'uint64', indexed: false},
                    ],
                },
                fromBlock: 0n,
                toBlock: 'latest',
            });
            const uniqBlocks = Array.from(new Set(logs.map((l) => l.blockNumber!)));
            const blocks = await Promise.all(uniqBlocks.map((bn) => rpc.getBlock({blockNumber: bn})));
            const tsByBlock = new Map(blocks.map((b) => [b.number!, b.timestamp]));
            return logs
                .map((l) => ({
                    bidder: (l.args.bidder ?? '0x0') as Address,
                    amount: l.args.amount ?? 0n,
                    endsAt: l.args.endsAt ?? 0n,
                    extended: false,
                    blockNumber: l.blockNumber!,
                    timestamp: tsByBlock.get(l.blockNumber!) ?? 0n,
                    txHash: l.transactionHash! as Hex,
                }))
                .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? 1 : -1));
        } catch {
            return [];
        }
    }

    async getReturnAuctionBids(punkId: number): Promise<ReturnAuctionBidEntry[]> {
        if (!isProtocolLive()) return [];
        // Indexer-only. The Bid table is populated by the
        // ReturnAuctionModule:BidPlaced handler in indexer/src/index.ts at
        // every return auction across the protocol's lifetime, so a single
        // GraphQL query returns the full per-Punk history at ~constant
        // upstream cost regardless of viewer count.
        //
        // No chain-direct fallback here on the mainnet adapter: the fork
        // adapter (lib/data/fork.ts) is the chain-direct path for the local
        // dev loop. If the indexer is down on mainnet, the bid history
        // returns empty and the panel shows the empty state — the API
        // route's cache cushions any transient indexer hiccup.
        try {
            const {bids} = await getIndexerClient().request<{
                bids: {
                    items: {
                        bidder: string;
                        amount: string;
                        blockNumber: string;
                        timestamp: string;
                        txHash: string;
                    }[];
                };
            }>(`{
                bids(where:{punkId:${punkId}}, orderBy:"blockNumber", orderDirection:"desc", limit: 500) {
                    items { bidder amount blockNumber timestamp txHash }
                }
            }`);
            return bids.items.map((b) => ({
                bidder: b.bidder as Address,
                amount: BigInt(b.amount),
                blockNumber: BigInt(b.blockNumber),
                timestamp: BigInt(b.timestamp),
                txHash: b.txHash as Hex,
            }));
        } catch (e) {
            rethrowIfIndexerMisconfigured(e);
            return [];
        }
    }

    async getReferralStatus(referrer: Address): Promise<ReferralStatus> {
        if (!isProtocolLive()) {
            return {
                referrer,
                balance: 0n,
                totalCredited: 0n,
                totalClaimed: 0n,
                stuckOnHookWei: 0n,
            };
        }
        const addrs = getContractAddresses();
        const referralPayoutAddr = addrs.referralPayout;
        const empty: ReferralStatus = {
            referrer,
            balance: 0n,
            totalCredited: 0n,
            totalClaimed: 0n,
            stuckOnHookWei: 0n,
        };
        if (!referralPayoutAddr) return empty;

        const rpc = getRpcClient();
        const poolKey = buildPoolKey(addrs.token);
        const poolId = computePoolId(poolKey);
        const referrerLc = referrer.toLowerCase();

        // Two reads in parallel. The ledger comes from the indexer (zero
        // RPC cost — N viewers per address collapse to 1 GraphQL hit
        // through the route's cache); `accruedReferral` is a chain read
        // (state-only, no event to index), expected to be 0 in normal
        // operation — it is a transient within-swap accrual that the
        // fresh-only settlement flushes by the end of every swap (there
        // is no held balance and no flush escape hatch any more).
        const [ledger, accruedHook] = await Promise.all([
            this._readReferrerLedger(rpc, referralPayoutAddr, referrer, referrerLc),
            rpc
                .readContract({
                    address: poolKey.hooks,
                    abi: ArtCoinsHookSkimFeeAbi,
                    functionName: 'accruedReferral',
                    args: [poolId, referrer],
                })
                .then((v) => v as bigint)
                .catch(() => 0n),
        ]);

        return {
            referrer,
            balance: ledger.balance,
            totalCredited: ledger.totalCredited,
            totalClaimed: ledger.totalClaimed,
            stuckOnHookWei: accruedHook,
            lastUpdatedAt: ledger.lastUpdatedAt,
        };
    }

    /** Read the per-referrer ledger row from the indexer first, then fall
     *  back to a single chain read of `referralPayout.balances(addr)` if
     *  the indexer is unreachable or has no row yet (a fresh referrer
     *  with zero credits). The fallback only fills `balance` — totals are
     *  left at 0 since the indexer is the only source for cumulative
     *  inflow/outflow. Never throws — returns zero-state on every
     *  failure path so the dashboard isn't blank. */
    private async _readReferrerLedger(
        rpc: ReturnType<typeof getRpcClient>,
        referralPayoutAddr: Address,
        referrer: Address,
        referrerLc: string,
    ): Promise<{
        balance: bigint;
        totalCredited: bigint;
        totalClaimed: bigint;
        lastUpdatedAt?: bigint;
    }> {
        try {
            const {referrer: row} = await getIndexerClient().request<{
                referrer: {
                    balance: string;
                    totalCredited: string;
                    totalClaimed: string;
                    lastUpdatedAt: string;
                } | null;
            }>(`{
                referrer(id: "${referrerLc}") {
                    balance totalCredited totalClaimed lastUpdatedAt
                }
            }`);
            if (row) {
                return {
                    balance: BigInt(row.balance),
                    totalCredited: BigInt(row.totalCredited),
                    totalClaimed: BigInt(row.totalClaimed),
                    lastUpdatedAt: BigInt(row.lastUpdatedAt),
                };
            }
        } catch (e) {
            rethrowIfIndexerMisconfigured(e);
            // Indexer unavailable — fall through to a chain read so the
            // panel still shows the headline balance.
        }
        try {
            const bal = (await rpc.readContract({
                address: referralPayoutAddr,
                abi: ReferralPayoutAbi,
                functionName: 'balances',
                args: [referrer],
            })) as bigint;
            return {balance: bal, totalCredited: 0n, totalClaimed: 0n};
        } catch {
            return {balance: 0n, totalCredited: 0n, totalClaimed: 0n};
        }
    }

    private async _readCollectedCountSafe(
        rpc: ReturnType<typeof getRpcClient>,
        pcAddr: Address,
    ): Promise<number> {
        try {
            const n = (await rpc.readContract({
                address: pcAddr,
                abi: PermanentCollectionAbi,
                functionName: 'collectedCount',
            })) as bigint;
            return Number(n);
        } catch {
            return 0;
        }
    }

    async getProofForTrait(traitId: number): Promise<ProofView | null> {
        if (!isProtocolLive()) return null;
        if (traitId < 0 || traitId >= 111) return null;
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        let isMinted = false;
        try {
            isMinted = (await rpc.readContract({
                address: addrs.punkVault,
                abi: PunkVaultAbi,
                functionName: 'isProofMinted',
                args: [traitId],
            })) as boolean;
        } catch {
            return null;
        }
        if (!isMinted) return null;
        const tokenId = traitId;
        const [meta, owner, traitNames, svgMarkup] = await Promise.all([
            rpc.readContract({
                address: addrs.punkVault,
                abi: PunkVaultAbi,
                functionName: 'proofMeta',
                args: [BigInt(tokenId)],
            }) as Promise<[number, number, number, bigint]>,
            rpc.readContract({
                address: addrs.punkVault,
                abi: PunkVaultAbi,
                functionName: 'ownerOf',
                args: [BigInt(tokenId)],
            }) as Promise<Address>,
            this.getTraitNames(),
            this._fetchProofSvg(traitId),
        ]);
        return {
            tokenId,
            traitId,
            traitName: traitNames[traitId] ?? `Trait ${traitId}`,
            minted: true,
            punkId: Number(meta[0]),
            sequence: Number(meta[2]),
            mintedAtBlock: meta[3],
            currentOwner: owner,
            svgMarkup,
        };
    }

    async getProofDetail(tokenId: number): Promise<ProofDetail | null> {
        if (tokenId < 0 || tokenId >= 111) return null;
        // The Proof view (mint record + art) is the trait-keyed read; the
        // Proof for trait t is token id t.
        const proof = await this.getProofForTrait(tokenId);
        if (!proof) return null;
        // Provenance: the acquisition that vaulted the Punk and minted this
        // Proof. `getAcquisitionFor` returns the (terminal, append-only)
        // Vaulted record — its originalSeller is the Proof recipient and its
        // priceWei is what the protocol paid. Best-effort: a read failure
        // degrades the page to the mint record alone rather than 500ing.
        let provenance: ProofDetail['provenance'] = null;
        try {
            const addrs = getContractAddresses();
            const rpc = getRpcClient();
            const acq = (await rpc.readContract({
                address: addrs.permanentCollection,
                abi: PermanentCollectionAbi,
                functionName: 'getAcquisitionFor',
                args: [proof.punkId],
            })) as {
                acquirer: Address;
                originalSeller: Address;
                priceWei: bigint;
                acquiredAtBlock: bigint;
            };
            provenance = {
                originalSeller: acq.originalSeller,
                acquirer: acq.acquirer,
                acquisitionPriceWei: acq.priceWei,
                acquiredAtBlock: acq.acquiredAtBlock,
                via:
                    acq.acquirer.toLowerCase() === acq.originalSeller.toLowerCase()
                        ? 'acceptBid'
                        : 'acceptListing',
            };
        } catch {
            provenance = null;
        }
        return {...proof, provenance};
    }

    async getTitleNft(): Promise<TitleNftView> {
        if (!isProtocolLive()) {
            return {minted: false, owner: null, svgMarkup: null};
        }
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        // `titleMinted` + `titleOwner()` are tiny reads; the art is the same
        // mosaic the homepage already fetches. All best-effort so the Title
        // card renders even if a leg is unreachable.
        const [mintedRes, ownerRes, svg] = await Promise.allSettled([
            rpc.readContract({
                address: addrs.punkVault,
                abi: PunkVaultAbi,
                functionName: 'titleMinted',
            }) as Promise<boolean>,
            rpc.readContract({
                address: addrs.punkVault,
                abi: PunkVaultAbi,
                functionName: 'titleOwner',
            }) as Promise<Address>,
            this.getTitleSvg(),
        ]);
        const minted = mintedRes.status === 'fulfilled' ? mintedRes.value : false;
        const ownerRaw = ownerRes.status === 'fulfilled' ? ownerRes.value : null;
        const owner =
            minted && ownerRaw && ownerRaw.toLowerCase() !== ZERO_ADDRESS ? ownerRaw : null;
        return {
            minted,
            owner,
            svgMarkup: svg.status === 'fulfilled' ? svg.value : null,
        };
    }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Browser-ish UA for cryptopunks.app fetches — its edge rejects obvious bot
 *  user-agents with a 403. */
const CRYPTOPUNKS_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Map raw contract booleans → the UI phase. Centralised so live + fork +
 *  mock adapters can't drift on this derivation. `pre-threshold` is the
 *  "fewer than 22 traits collected" path: kickoff cannot yet be called. */
export function pickTitleAuctionPhase(s: {
    kickedOff: boolean;
    settled: boolean;
    isLive: boolean;
    isSettleable: boolean;
    isKickoffReady: boolean;
}): TitleAuctionPhase {
    if (s.settled) return 'settled';
    if (s.isLive) return 'live';
    if (s.isSettleable) return 'settleable';
    if (s.isKickoffReady) return 'kickoff-ready';
    return 'pre-threshold';
}

/** Market bids below this are dust/spam on Punks worth many ETH — filtered
 *  out of the provenance timeline. 0.01 ETH. */
const DUST_BID_WEI = 10n ** 16n;

/** Fetch a wallet's CryptoPunks holdings from cryptopunks.app's public
 *  account API (mainnet only). One call returns the complete owned set; we
 *  only need the ids here. Cached for 5 min via Next's fetch cache so we
 *  don't hammer the upstream (it has "reasonable rate limits"). The www host
 *  is canonical (the apex 308-redirects) and a browser-ish UA avoids its
 *  bot 403. Throws on non-200 so the caller falls back to the on-chain scan. */
export async function fetchOwnedFromCryptopunksApi(owner: Address): Promise<number[]> {
    const url = `https://www.cryptopunks.app/api/account/${owner.toLowerCase()}?owned=true`;
    const res = await fetch(url, {
        headers: {'user-agent': CRYPTOPUNKS_UA, accept: 'application/json'},
        // Per-address, 5-min revalidate — ownership changes slowly and a
        // stale-by-minutes holdings list is fine for a picker.
        next: {revalidate: 300},
    });
    if (!res.ok) throw new Error(`cryptopunks account api ${res.status}`);
    const json = (await res.json()) as {
        success?: boolean;
        data?: {owned?: {index?: number}[]};
    };
    if (!json.success || !json.data?.owned) {
        throw new Error('cryptopunks account api: unexpected shape');
    }
    return json.data.owned
        .map((o) => o.index)
        .filter((i): i is number => Number.isInteger(i) && i! >= 0 && i! <= 9999)
        .sort((a, b) => a - b);
}

/** The current cheapest public offer on the 2017 CryptoPunks market, from
 *  cryptopunks.app's `action=floor-punk` (`data.currentPunkOffers.items[0]`).
 *  Wei-precise. Returns null when there is no current offer or the shape is
 *  unexpected; throws on a non-200 so the caller can degrade (hide the
 *  reference). Cached 60s via Next's fetch cache. */
export async function fetchFloorPunkFromCryptopunksApi(): Promise<
    {punkId: number; minValueWei: bigint; seller: Address; offeredAt: bigint; isPublic: boolean} | null
> {
    const url = 'https://www.cryptopunks.app/api/punks?action=floor-punk';
    const res = await fetch(url, {
        headers: {'user-agent': CRYPTOPUNKS_UA, accept: 'application/json'},
        next: {revalidate: 60},
    });
    if (!res.ok) throw new Error(`cryptopunks floor-punk api ${res.status}`);
    const json = (await res.json()) as {
        success?: boolean;
        data?: {
            currentPunkOffers?: {
                items?: {
                    punkId?: string | number;
                    seller?: string;
                    minValue?: string;
                    toAddress?: string;
                    offeredAt?: number;
                }[];
            };
        };
    };
    const row = json.data?.currentPunkOffers?.items?.[0];
    if (!json.success || !row) return null;
    const punkId = Number(row.punkId);
    if (!Number.isInteger(punkId) || punkId < 0 || punkId > 9999) return null;
    if (row.minValue === undefined) return null;
    let minValueWei: bigint;
    try {
        minValueWei = BigInt(row.minValue);
    } catch {
        return null;
    }
    if (minValueWei <= 0n) return null;
    return {
        punkId,
        minValueWei,
        seller: (row.seller ?? ZERO_ADDRESS) as Address,
        offeredAt: BigInt(Math.floor(Number(row.offeredAt ?? 0))),
        isPublic: (row.toAddress ?? ZERO_ADDRESS).toLowerCase() === ZERO_ADDRESS,
    };
}

/** Build the `/bid` market reference from the live CryptoPunks floor. The
 *  "cheapest eligible Punk" is a real-world mainnet figure (the cheapest current
 *  PUBLIC offer carrying an uncollected trait), so BOTH the live and fork
 *  adapters source it the same way — from cryptopunks.app's floor-punk endpoint
 *  + the sealed PUNK_MASKS snapshot + the caller's `collectedMask`. A local fork
 *  can't represent the real floor without the full 2017-market listing history,
 *  so it defers to the API here rather than scanning the fork. Throws propagate
 *  to the caller, which returns {available:false} so the UI hides the item.
 *
 *  floor-punk is the single cheapest public offer → `floorPriceWei` (the
 *  collection floor regardless of eligibility). It's also the cheapest *eligible*
 *  Punk iff it carries an uncollected trait; when it doesn't, this one endpoint
 *  can't surface the next-cheapest eligible Punk, so `cheapestEligiblePriceWei`
 *  is omitted (the floor is still shown) — only matters near set-completion,
 *  where the eligible-anchor matters least. */
export async function marketReferenceFromFloorPunk(
    collectedMask: bigint,
): Promise<MarketReference> {
    const floor = await fetchFloorPunkFromCryptopunksApi();
    if (!floor || !floor.isPublic) return {available: true};
    const ALL_BITS = (1n << 111n) - 1n;
    const uncollected = ALL_BITS & ~collectedMask;
    const mask = PUNK_MASKS[floor.punkId];
    const eligible = mask !== undefined && (mask & uncollected) !== 0n;
    return {
        available: true,
        floorPriceWei: floor.minValueWei,
        cheapestEligiblePriceWei: eligible ? floor.minValueWei : undefined,
        asOfTimestamp: floor.offeredAt > 0n ? floor.offeredAt : undefined,
    };
}

/** The punks an account currently lists for sale, from cryptopunks.app's
 *  account API (`data.forSale[]`). Its per-row price is a presentation-
 *  formatted string, so we take only the punk index + `offeredAt`; precise
 *  terms (wei price, onlySellTo, on-chain seller) are read from the market
 *  contract by the caller. Throws on a non-200 so the caller can degrade.
 *  Cached 60s. */
export async function fetchSellerListedPunkIds(
    seller: Address,
): Promise<{punkId: number; offeredAt: bigint}[]> {
    const url = `https://www.cryptopunks.app/api/account/${seller.toLowerCase()}`;
    const res = await fetch(url, {
        headers: {'user-agent': CRYPTOPUNKS_UA, accept: 'application/json'},
        next: {revalidate: 60},
    });
    if (!res.ok) throw new Error(`cryptopunks account api ${res.status}`);
    const json = (await res.json()) as {
        success?: boolean;
        data?: {forSale?: {index?: number; offeredAt?: number}[]};
    };
    const rows = json.data?.forSale;
    if (!json.success || !Array.isArray(rows)) return [];
    const out: {punkId: number; offeredAt: bigint}[] = [];
    for (const r of rows) {
        if (!Number.isInteger(r.index) || r.index! < 0 || r.index! > 9999) continue;
        out.push({punkId: r.index!, offeredAt: BigInt(Math.floor(Number(r.offeredAt ?? 0)))});
    }
    return out;
}

/** Recent public 2017-market history for a single Punk, from cryptopunks.app's
 *  `batch-recent-history` action. Mapped to `PunkProvenanceEvent`s tagged
 *  `source: 'market'`. The Punk space is always mainnet-canonical (production
 *  is mainnet; local dev is a mainnet fork), so the lookup is valid regardless
 *  of the configured chain id. Best-effort: returns [] on any error so the
 *  timeline degrades to protocol-only. Cached 5 min via Next's fetch cache. */
export async function fetchPunkMarketHistory(punkId: number): Promise<PunkProvenanceEvent[]> {
    try {
        const url = `https://www.cryptopunks.app/api/punks?action=batch-recent-history&punkIds=${punkId}`;
        const res = await fetch(url, {
            headers: {'user-agent': CRYPTOPUNKS_UA, accept: 'application/json'},
            next: {revalidate: 300},
        });
        if (!res.ok) return [];
        const json = (await res.json()) as {
            success?: boolean;
            data?: Record<string, MarketHistoryEntry[]>;
        };
        const rows = json.data?.[String(punkId)];
        if (!Array.isArray(rows)) return [];

        const out: PunkProvenanceEvent[] = [];
        for (const r of rows) {
            const ts = BigInt(Math.floor(Number(r.timestamp ?? r.bidAt ?? 0)));
            const tx = r.transactionHash as Hex | undefined;
            const value = r.value !== undefined ? BigInt(r.value) : undefined;
            switch ((r.type ?? '').toLowerCase()) {
                case 'sale':
                    out.push({
                        kind: 'sale',
                        source: 'market',
                        amountWei: value,
                        actor: r.seller as Address | undefined,
                        counterparty: r.buyer as Address | undefined,
                        timestamp: ts,
                        txHash: tx,
                    });
                    break;
                case 'transfer':
                    out.push({
                        kind: 'transfer',
                        source: 'market',
                        actor: r.from as Address | undefined,
                        counterparty: r.to as Address | undefined,
                        timestamp: ts,
                        txHash: tx,
                    });
                    break;
                case 'bid':
                    // Skip dust bids — sub-0.01 ETH offers on Punks worth many
                    // ETH are spam and only clutter the timeline.
                    if (value !== undefined && value < DUST_BID_WEI) break;
                    out.push({
                        kind: 'marketBid',
                        source: 'market',
                        amountWei: value,
                        actor: r.bidder as Address | undefined,
                        timestamp: ts,
                        txHash: tx,
                    });
                    break;
                case 'offer':
                case 'listed':
                    out.push({
                        kind: 'listed',
                        source: 'market',
                        amountWei: value,
                        actor: r.seller as Address | undefined,
                        timestamp: ts,
                        txHash: tx,
                    });
                    break;
                // Unknown / wrapped types are skipped — not meaningful here.
            }
        }
        return out;
    } catch {
        return [];
    }
}

interface MarketHistoryEntry {
    type?: string;
    seller?: string;
    buyer?: string;
    bidder?: string;
    from?: string;
    to?: string;
    value?: string;
    timestamp?: number | string;
    bidAt?: number | string;
    transactionHash?: string;
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
}

// Palette cache. PunksData's palette is immutable.
let _paletteCache: Uint8Array | null = null;
let _palettePromise: Promise<Uint8Array> | null = null;

async function getCachedPalette(
    punksData: Address,
    rpc: ReturnType<typeof getRpcClient>,
): Promise<Uint8Array> {
    if (_paletteCache) return _paletteCache;
    if (_palettePromise) return _palettePromise;
    _palettePromise = (async () => {
        const hex = (await rpc.readContract({
            address: punksData,
            abi: PunksDataAbi,
            functionName: 'paletteRgbaBytes',
        })) as `0x${string}`;
        _paletteCache = hexToBytes(hex);
        _palettePromise = null;
        return _paletteCache;
    })();
    return _palettePromise;
}

function popcount(x: bigint): number {
    let c = 0;
    while (x > 0n) {
        x &= x - 1n;
        c++;
    }
    return c;
}

/** Decode the renderer's `data:application/json;{base64|utf8},...` URI,
 *  extract the embedded `image` field (which is itself a data: URI for
 *  the SVG), and return the raw SVG markup. Returns null if anything is
 *  malformed. Supports both wrapper encodings — the mosaic renderer
 *  emits utf8 (smaller calldata, no base64 overhead); older renderers
 *  emit base64. */
export function extractSvgFromDataUri(tokenUri: string): string | null {
    const b64Prefix = 'data:application/json;base64,';
    const utf8Prefix = 'data:application/json;utf8,';
    let jsonStr: string;
    if (tokenUri.startsWith(b64Prefix)) {
        try {
            jsonStr = Buffer.from(tokenUri.slice(b64Prefix.length), 'base64').toString('utf8');
        } catch {
            return null;
        }
    } else if (tokenUri.startsWith(utf8Prefix)) {
        jsonStr = tokenUri.slice(utf8Prefix.length);
    } else {
        return null;
    }
    let parsed: {image?: string};
    try {
        parsed = JSON.parse(jsonStr) as {image?: string};
    } catch {
        return null;
    }
    const image = parsed.image;
    if (typeof image !== 'string') return null;
    const svgB64Prefix = 'data:image/svg+xml;base64,';
    const svgUtf8Prefix = 'data:image/svg+xml;utf8,';
    if (image.startsWith(svgB64Prefix)) {
        try {
            return Buffer.from(image.slice(svgB64Prefix.length), 'base64').toString('utf8');
        } catch {
            return null;
        }
    }
    if (image.startsWith(svgUtf8Prefix)) {
        return decodeURIComponent(image.slice(svgUtf8Prefix.length));
    }
    return null;
}
