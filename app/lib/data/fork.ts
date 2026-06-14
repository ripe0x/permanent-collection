// Local-fork data adapter — reads EVERYTHING straight from chain, no indexer.
//
// Why this exists: the production `LiveAdapter` sources auctions, the trait
// grid's pending/attribution data, accepted-bid events, and listings from the
// Ponder indexer (GraphQL). Running Ponder against a throwaway anvil fork is a
// hassle, so for local dev we read the same facts directly from the protocol
// contracts. The data volumes on a fork are tiny (we create every acquisition,
// sale, and listing ourselves), so the chain-direct reads that would be
// reckless on mainnet — iterating the acquisition log, `getLogs` from the
// deploy block — are cheap here.
//
// DEV-ONLY. `getDataAdapterKind()` throws if `NEXT_PUBLIC_DATA_ADAPTER=fork`
// is set in a production build. Mainnet must use `LiveAdapter` + the indexer.
//
// What's reused vs. replaced (vs. LiveAdapter):
//   • Reused by composition (already chain-direct, identical): getTraitNames,
//     getPunkSprite, getRendererSvg.
//   • Replaced with chain reads: getProtocolState (counters), getTraitGrid
//     (pendingMask + acquisition-log attribution), getActiveAuctions
//     (InReturnAuction acquisitions → getSale), getRecentResolutions /
//     getRecentAcceptedBids (getLogs), getPunkEligibility (pendingMask),
//     getPunkStrategyListings / getMarketReference (PunkOffered logs),
//     getPunksOwnedBy (10k Multicall3 scan).

import {createPublicClient, fallback, http} from 'viem';
import {mainnet} from 'viem/chains';

import {abi as BuybackBurnerAbi} from '@/lib/abis/BuybackBurner';
import {abi as CryptoPunksMarketAbi} from '@/lib/abis/CryptoPunksMarket';
import {abi as ReturnAuctionModuleAbi} from '@/lib/abis/ReturnAuctionModule';
import {abi as PatronAbi} from '@/lib/abis/Patron';
import {abi as PermanentCollectionAbi} from '@/lib/abis/PermanentCollection';
import {abi as PunksDataAbi} from '@/lib/abis/PunksData';
import {abi as ReferralPayoutAbi} from '@/lib/abis/ReferralPayout';
import {abi as ArtCoinsHookSkimFeeAbi} from '@/lib/abis/ArtCoinsHookSkimFee';
import {getContractAddresses, getRpcUrls} from '@/lib/config';
import {chainDeadlineBaseSeconds} from '@/lib/swap/chainTime';
import {buildPoolKey, computePoolId} from '@/lib/swap/poolKey';
import {buildMosaicSvg} from '@/lib/mosaic-svg';
import {
    extractSvgFromDataUri,
    fetchOwnedFromCryptopunksApi,
    fetchPunkMarketHistory,
    LiveAdapter,
    marketReferenceFromFloorPunk,
    ZERO_PROTOCOL_STATE,
} from './live';
import {clearedSplitProvenanceEvents} from './clearedSplit';
import {countEligiblePunks} from './eligibleCount';
import {canonicalTarget, rarestFirst} from '@/lib/rarity';
import {readSoleCarrier, readSoleCarrierBatch} from '@/lib/sole-carrier';
import {buildTraitOptions, type TraitOptionEntry} from '@/lib/trait-options';
import type {
    AcceptedBidEvent,
    ActiveAuction,
    Address,
    AuctionDetail,
    DataAdapter,
    Hex,
    MarketReference,
    ProtocolState,
    PunkEligibility,
    PunkProvenance,
    PunkProvenanceEvent,
    PunkStrategyListing,
    ResolvedAuction,
    TraitOption,
    TraitView,
} from './types';

/** IPermanentCollection.Custody enum (None=0, then strictly forward). */
const CUSTODY = {None: 0, InReturnAuction: 1, ReturnedToMarket: 2, Vaulted: 3} as const;

const ALL_BITS = (1n << 111n) - 1n;
const MIN_BID_FOR_LISTING = 5n * 10n ** 17n; // 0.5 ETH

const erc20Abi = [
    {
        type: 'function',
        name: 'totalSupply',
        stateMutability: 'view',
        inputs: [],
        outputs: [{type: 'uint256'}],
    },
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function getRpcClient() {
    // Mirrors LiveAdapter's transport: 30s timeout because a cold anvil fork
    // fills each uncached slot from a (possibly rate-limited) upstream. The
    // declared `chain: mainnet` is cosmetic — every read is `eth_call` /
    // `eth_getLogs` against whatever the RPC_URL points at (the local fork).
    const urls = getRpcUrls();
    const transports = urls.map((u) => http(u, {timeout: 30_000}));
    return createPublicClient({
        chain: mainnet,
        transport: transports.length > 1 ? fallback(transports) : transports[0],
    });
}

/** Current chain time in seconds, for countdown rendering. Returns the best
 *  estimate of the timestamp the next mined block will carry —
 *  `max(pendingBlockTs, latestBlockTs, wallClock)` (the same base
 *  `chainDeadlineBaseSeconds` uses for swap/permit deadlines). This is also the
 *  value the auction settle gate keys off (`block.timestamp >= endsAt`), so the
 *  countdown flips to "settleable" exactly when settle becomes possible.
 *
 *  Reading `latest` alone is wrong on a local anvil fork: anvil only advances
 *  chain time on a mined block, so an idle (or time-warped) fork freezes
 *  `latest.timestamp`. A countdown re-seeded from that frozen value then resets
 *  to its full span on every page reload (only the in-session wall-clock tick
 *  advances it, and a reload discards that). Folding in the `pending` block (anvil
 *  stamps it with elapsed wall time, carrying any warp offset) and the wall clock
 *  keeps "now" advancing with real time, so the countdown ticks down
 *  monotonically across reloads in every regime — frozen fork, warped fork, and
 *  mainnet alike.
 *
 *  Falls back to wall-clock on any RPC failure: a page must never 500 because the
 *  time read failed on a throttled public RPC (the fallback drifts by at most a
 *  block, far better than a dead page). */
export async function getChainTimeSeconds(): Promise<bigint> {
    try {
        return BigInt(await chainDeadlineBaseSeconds(getRpcClient()));
    } catch {
        return BigInt(Math.floor(Date.now() / 1000));
    }
}

type Rpc = ReturnType<typeof getRpcClient>;

/** A decoded `PermanentCollection.getAcquisition(i)` record. */
interface Acquisition {
    punkId: number;
    targetTraitId: number;
    mask: bigint;
    acquirer: Address;
    priceWei: bigint;
    acquiredAtBlock: bigint;
    custody: number;
}

/** Placeholder labels when `PunksData.traitName()` can't be read on a public
 *  fork (its name-store's archive state isn't served at the pin block). Mirrors
 *  the real PunksData bit layout — 5 normalized types, 11 head variants, 8
 *  attribute counts, 87 accessories — so the grid reads sensibly even though
 *  accessory names are generic. */
function fallbackTraitNames(): string[] {
    const types = ['Alien', 'Ape', 'Female', 'Male', 'Zombie'];
    const names: string[] = [];
    for (let i = 0; i < 111; i++) {
        if (i < 5) names.push(types[i]);
        else if (i < 16) names.push(`Head variant ${i - 4}`);
        else if (i < 24) names.push(`${i - 16} attribute${i - 16 === 1 ? '' : 's'}`);
        else names.push(`Accessory ${i - 23}`);
    }
    return names;
}

export class ForkAdapter implements DataAdapter {
    // Compose a LiveAdapter to reuse its chain-direct, indexer-free reads
    // (trait names, sprite pixels, the on-chain Title SVG). Those never touch
    // the indexer, so delegating is safe and avoids duplicating their (cached)
    // implementations. getRendererSvg is the exception: LiveAdapter builds it
    // off an indexer-backed grid, so this adapter composes the homepage mosaic
    // off its OWN chain-direct getTraitGrid (below) instead.
    private live = new LiveAdapter();
    private traitNamesCache: string[] | null = null;

    async getTraitNames(): Promise<string[]> {
        if (this.traitNamesCache) return this.traitNamesCache;
        try {
            this.traitNamesCache = await this.live.getTraitNames();
        } catch {
            // `PunksData.traitName()` reads its name strings from a separate
            // store (0x6e89f8A4…) whose ARCHIVE state a public fork RPC
            // (publicnode) can't serve at the pinned block — so the call
            // reverts. `traitMaskOf()` reads PunksData's own storage and DOES
            // resolve, so the grid/eligibility/state stay correct; only the
            // labels fall back. To get real trait names, fork from an archive
            // RPC so these slots cache locally.
            this.traitNamesCache = fallbackTraitNames();
        }
        return this.traitNamesCache;
    }
    getPunkSprite(punkId: number): Promise<{indexed: Uint8Array; palette: Uint8Array}> {
        return this.live.getPunkSprite(punkId);
    }
    async getRendererSvg(): Promise<string | null> {
        // Build the homepage mosaic off THIS adapter's chain-direct
        // getTraitGrid (collected + pending straight from chain). Do NOT
        // delegate to LiveAdapter.getRendererSvg — its getTraitGrid queries the
        // Ponder indexer, which isn't running against a local fork, so it would
        // throw and the art would degrade to the placeholder. buildMosaicSvg is
        // the same off-chain compose LiveAdapter uses.
        return buildMosaicSvg(await this.getTraitGrid());
    }
    getTitleSvg(): Promise<string | null> {
        return this.live.getTitleSvg();
    }

    // ──────────────── core chain reads ────────────────

    /** Read the full append-only acquisition log via one Multicall3 aggregate.
     *  On a fork the count is small (we create every acquisition), so reading
     *  all records is cheap and gives us custody, attribution, and prices in
     *  one shot. */
    private async readAcquisitions(rpc: Rpc, pc: Address): Promise<Acquisition[]> {
        const count = Number(
            (await rpc.readContract({
                address: pc,
                abi: PermanentCollectionAbi,
                functionName: 'acquisitionCount',
            })) as bigint,
        );
        if (count === 0) return [];
        const contracts = Array.from({length: count}, (_, i) => ({
            address: pc,
            abi: PermanentCollectionAbi,
            functionName: 'getAcquisition' as const,
            args: [BigInt(i)] as const,
        }));
        const tuples = (await rpc.multicall({contracts, allowFailure: false})) as Array<{
            punkId: number | bigint;
            targetTraitId: number | bigint;
            mask: bigint;
            pendingMaskAtAcquisition: bigint;
            acquirer: Address;
            priceWei: bigint;
            acquiredAtBlock: bigint;
            custody: number | bigint;
        }>;
        return tuples.map((t) => ({
            punkId: Number(t.punkId),
            targetTraitId: Number(t.targetTraitId),
            mask: t.mask,
            acquirer: t.acquirer,
            priceWei: t.priceWei,
            acquiredAtBlock: t.acquiredAtBlock,
            custody: Number(t.custody),
        }));
    }

    /** Block timestamps for a set of block numbers, fetched once each. */
    private async blockTimestamps(rpc: Rpc, blocks: bigint[]): Promise<Map<bigint, bigint>> {
        const unique = [...new Set(blocks.map((b) => b.toString()))].map((s) => BigInt(s));
        const entries = await Promise.all(
            unique.map(async (bn) => {
                const blk = await rpc.getBlock({blockNumber: bn});
                return [bn, blk.timestamp] as const;
            }),
        );
        return new Map(entries);
    }

    async getProtocolState(): Promise<ProtocolState> {
        // Pre-deploy fallback: in PRELAUNCH the protocol addresses are pre-baked
        // (so isProtocolLive() is true address-wise) but the contracts have no
        // bytecode yet. The chain reads throw, and the /bid page (no slice
        // wrapper) crashes through to the global error boundary. Return honest
        // zeros so every surface renders the pre-launch state — same shape
        // live.ts produces when !isProtocolLive().
        try {
            return await this._getProtocolState();
        } catch {
            return ZERO_PROTOCOL_STATE;
        }
    }

    private async _getProtocolState(): Promise<ProtocolState> {
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        // "Pending" = fee in flight to the live bid. Only the bid leg is
        // bid-bound, so only the LiveBidAdapter counts. It routes to Patron via
        // `LiveBidAdapter.sweep()`, and it's fed by its own receive() (the
        // hook's bid leg + the locker's LP-fee share) rather than an escrow
        // claim — so its balance IS its pending, with no escrow slot to add. The
        // ProtocolFeePhaseAdapter (protocol leg) sweeps to PCController from
        // block 1 and NEVER reaches the live bid, so it isn't read here. The
        // hook flushes accruals within each swap's own tx, so it holds no claim
        // balance between swaps. Mirrors live.ts:getProtocolState.
        const [
            liveBidWei,
            liveBidAdapterBal,
            blockNumber,
            block,
            collectedCount,
            isComplete,
            supply,
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
        // Derive acquisition/vaulted/cleared counts from the on-chain log.
        const acqs = await this.readAcquisitions(rpc, addrs.permanentCollection);

        const liveBidPendingWei = liveBidAdapterBal;
        // The protocol leg is never bid-bound, so this is always 0. Kept in the
        // shape so older clients (and the sweep affordance) don't break.
        const liveBidProtocolLegPendingWei = 0n;

        return {
            liveBidWei,
            liveBidPendingWei,
            liveBidProtocolLegPendingWei,
            asOfBlock: blockNumber,
            asOfTimestamp: block.timestamp,
            collectedCount: Number(collectedCount),
            totalTraits: 111,
            acquisitionCount: acqs.length,
            vaultedCount: acqs.filter((a) => a.custody === CUSTODY.Vaulted).length,
            clearedCount: acqs.filter((a) => a.custody === CUSTODY.ReturnedToMarket).length,
            proofsMintedCount: 0, // Fork adapter: not wired up; live & UI count via PunkVault.totalProofsMinted directly.
            totalTokenSupplyWei: supply,
            totalTokenBurnedWei: burned,
            isComplete,
            // Fork adapter is indexer-free, and the SkimSplit totals only live
            // in the indexer — unknown here, so the UI hides the figure.
            totalSwapVolumeWei: null,
            swapCount: null,
        };
    }

    async getEligiblePunkCount(): Promise<number | null> {
        // Chain-direct mirror of LiveAdapter.getEligiblePunkCount: masks from
        // PermanentCollection, blocked Punks (in-auction or vaulted) from the
        // on-chain acquisition log. Pre-deploy / transient RPC failure → null
        // (callers hide the figure).
        try {
            const addrs = getContractAddresses();
            const rpc = getRpcClient();
            const [collectedMask, pendingMask, acqs] = await Promise.all([
                rpc.readContract({
                    address: addrs.permanentCollection,
                    abi: PermanentCollectionAbi,
                    functionName: 'collectedMask',
                }) as Promise<bigint>,
                rpc.readContract({
                    address: addrs.permanentCollection,
                    abi: PermanentCollectionAbi,
                    functionName: 'pendingMask',
                }) as Promise<bigint>,
                this.readAcquisitions(rpc, addrs.permanentCollection),
            ]);
            const blocked = acqs
                .filter(
                    (a) =>
                        a.custody === CUSTODY.InReturnAuction || a.custody === CUSTODY.Vaulted,
                )
                .map((a) => a.punkId);
            return countEligiblePunks(collectedMask, pendingMask, blocked);
        } catch {
            return null;
        }
    }

    async getTraitGrid(): Promise<TraitView[]> {
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        // Pre-deploy fallback: in PRELAUNCH the protocol addresses are
        // pre-baked (so isProtocolLive() is true address-wise) but the
        // contracts have no bytecode yet. The chain reads below would throw
        // and the SSR fallback would render the placeholder mosaic. Default
        // to all-uncollected so the loop produces a real 111-entry grid —
        // the homepage hero renders the honest empty mosaic until the
        // contracts deploy, then real state takes over.
        let collectedMask = 0n;
        let pendingMask = 0n;
        let acqs: Acquisition[] = [];
        try {
            [collectedMask, pendingMask, acqs] = await Promise.all([
                rpc.readContract({
                    address: addrs.permanentCollection,
                    abi: PermanentCollectionAbi,
                    functionName: 'collectedMask',
                }) as Promise<bigint>,
                rpc.readContract({
                    address: addrs.permanentCollection,
                    abi: PermanentCollectionAbi,
                    functionName: 'pendingMask',
                }) as Promise<bigint>,
                this.readAcquisitions(rpc, addrs.permanentCollection),
            ]);
        } catch {
            // Contract has no code (PRELAUNCH) or RPC transient — keep zeros.
        }

        // Attribution: the vaulted acquisition whose target == this trait.
        const vaultedByTrait = new Map<number, Acquisition>();
        for (const a of acqs) {
            if (a.custody === CUSTODY.Vaulted) vaultedByTrait.set(a.targetTraitId, a);
        }

        const out: TraitView[] = [];
        for (let i = 0; i < 111; i++) {
            const bit = 1n << BigInt(i);
            if ((collectedMask & bit) !== 0n) {
                const acq = vaultedByTrait.get(i);
                out.push({
                    traitId: i,
                    state: 'permanent',
                    firstVaultedPunkId: acq?.punkId,
                    acceptedBidWei: acq?.priceWei,
                });
            } else if ((pendingMask & bit) !== 0n) {
                out.push({traitId: i, state: 'pending'});
            } else {
                out.push({traitId: i, state: 'uncollected'});
            }
        }
        return out;
    }

    async getActiveAuctions(): Promise<ActiveAuction[]> {
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const acqs = await this.readAcquisitions(rpc, addrs.permanentCollection);
        const live = acqs.filter((a) => a.custody === CUSTODY.InReturnAuction);
        if (live.length === 0) return [];

        const [sales, trials] = await Promise.all([
            rpc.multicall({
                contracts: live.map((a) => ({
                    address: addrs.returnAuctionModule,
                    abi: ReturnAuctionModuleAbi,
                    functionName: 'getSale' as const,
                    args: [a.punkId] as const,
                })),
                allowFailure: false,
            }) as Promise<
                Array<{
                    acquisitionCost: bigint;
                    highBidWei: bigint;
                    highBidder: Address;
                    startedAt: bigint;
                    endsAt: bigint;
                    reserveWei: bigint;
                    targetTraitId: number | bigint;
                    settled: boolean;
                }>
            >,
            rpc.multicall({
                contracts: live.map((a) => ({
                    address: addrs.permanentCollection,
                    abi: PermanentCollectionAbi,
                    functionName: 'attemptCount' as const,
                    args: [a.targetTraitId] as const,
                })),
                allowFailure: false,
            }) as Promise<Array<number | bigint>>,
        ]);

        // `getSale` doesn't expose an extension counter; count
        // `ReturnAuctionExtended` event emissions per punkId since each
        // bid in the snipe window emits one. One getLogs call for the
        // whole module covers all active auctions.
        const extensionsByPunk = new Map<number, number>();
        try {
            const logs = await rpc.getLogs({
                address: addrs.returnAuctionModule,
                event: {
                    type: 'event',
                    name: 'ReturnAuctionExtended',
                    inputs: [
                        {type: 'uint16', name: 'punkId', indexed: true},
                        {type: 'uint64', name: 'newEndsAt', indexed: false},
                    ],
                },
                fromBlock: 'earliest',
                toBlock: 'latest',
            });
            for (const log of logs) {
                const pid = Number((log as unknown as {args: {punkId: number}}).args.punkId);
                extensionsByPunk.set(pid, (extensionsByPunk.get(pid) ?? 0) + 1);
            }
        } catch {
            // getLogs unsupported on this RPC — leave counts at 0.
        }

        return live
            .map((a, idx) => {
                const s = sales[idx];
                const hasBid = s.highBidder.toLowerCase() !== ZERO_ADDRESS;
                return {
                    punkId: a.punkId,
                    targetTraitId: a.targetTraitId,
                    acquisitionCostWei: s.acquisitionCost,
                    reserveWei: s.reserveWei,
                    highBidWei: s.highBidWei,
                    highBidder: hasBid ? s.highBidder : undefined,
                    startedAt: s.startedAt,
                    endsAt: s.endsAt,
                    extensions: extensionsByPunk.get(a.punkId) ?? 0,
                    attemptCount: Number(trials[idx]) || 1,
                };
            })
            .sort((a, b) => (a.endsAt < b.endsAt ? -1 : 1));
    }

    async getAuctionByPunkId(punkId: number): Promise<AuctionDetail | null> {
        const all = await this.getActiveAuctions();
        return all.find((a) => a.punkId === punkId) ?? null;
    }

    async getResolvedAuctionByPunkId(punkId: number): Promise<ResolvedAuction | null> {
        // Fork reads events directly; reuse the resolution scan and pick the
        // latest match for this Punk (re-auctioned Punks have several).
        const all = await this.getRecentResolutions(10_000);
        const mine = all.filter((r) => r.punkId === punkId);
        if (mine.length === 0) return null;
        return mine.reduce((a, b) => (b.settledAt > a.settledAt ? b : a));
    }

    async getRecentResolutions(limit = 10): Promise<ResolvedAuction[]> {
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const fromBlock = await this.deployBlock(rpc, addrs.permanentCollection);

        const [clearedLogs, vaultedLogs, acqs] = await Promise.all([
            rpc.getContractEvents({
                address: addrs.returnAuctionModule,
                abi: ReturnAuctionModuleAbi,
                eventName: 'ReturnAuctionCleared',
                fromBlock,
                toBlock: 'latest',
            }) as Promise<EventLog[]>,
            rpc.getContractEvents({
                address: addrs.returnAuctionModule,
                abi: ReturnAuctionModuleAbi,
                eventName: 'PunkVaulted',
                fromBlock,
                toBlock: 'latest',
            }) as Promise<EventLog[]>,
            this.readAcquisitions(rpc, addrs.permanentCollection),
        ]);

        const targetByPunk = new Map(acqs.map((a) => [a.punkId, a.targetTraitId]));
        const priceByPunk = new Map(acqs.map((a) => [a.punkId, a.priceWei]));
        const tsMap = await this.blockTimestamps(
            rpc,
            [...clearedLogs, ...vaultedLogs].map((l) => l.blockNumber),
        );

        const resolved: ResolvedAuction[] = [];
        for (const l of clearedLogs) {
            const punkId = Number(l.args.punkId);
            resolved.push({
                punkId,
                targetTraitId: targetByPunk.get(punkId) ?? 0,
                outcome: 'cleared',
                finalBidWei: (l.args.highBidWei as bigint | undefined) ?? 0n,
                acquisitionPriceWei: priceByPunk.get(punkId),
                // Cleared-path split straight off the event (vault-burn is the
                // remainder, computed in the UI).
                liveBidShareWei: l.args.liveBidShare as bigint | undefined,
                burnShareWei: l.args.burnShare as bigint | undefined,
                settledAt: tsMap.get(l.blockNumber) ?? 0n,
                txHash: l.transactionHash,
            });
        }
        for (const l of vaultedLogs) {
            const punkId = Number(l.args.punkId);
            resolved.push({
                punkId,
                targetTraitId: targetByPunk.get(punkId) ?? 0,
                outcome: 'vaulted',
                finalBidWei: 0n,
                acquisitionPriceWei: priceByPunk.get(punkId),
                settledAt: tsMap.get(l.blockNumber) ?? 0n,
                txHash: l.transactionHash,
            });
        }
        return resolved.sort((a, b) => (a.settledAt < b.settledAt ? 1 : -1)).slice(0, limit);
    }

    async getRecentAcceptedBids(limit = 10): Promise<AcceptedBidEvent[]> {
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const fromBlock = await this.deployBlock(rpc, addrs.permanentCollection);

        const [bountyLogs, listingLogs] = await Promise.all([
            rpc.getContractEvents({
                address: addrs.patron,
                abi: PatronAbi,
                eventName: 'BidAccepted',
                fromBlock,
                toBlock: 'latest',
            }) as Promise<EventLog[]>,
            rpc.getContractEvents({
                address: addrs.patron,
                abi: PatronAbi,
                eventName: 'ListingAccepted',
                fromBlock,
                toBlock: 'latest',
            }) as Promise<EventLog[]>,
        ]);

        const tsMap = await this.blockTimestamps(
            rpc,
            [...bountyLogs, ...listingLogs].map((l) => l.blockNumber),
        );

        const events: AcceptedBidEvent[] = [];
        for (const l of bountyLogs) {
            events.push({
                kind: 'bidAccepted',
                punkId: Number(l.args.punkId),
                actor: l.args.seller as Address,
                amountWei: (l.args.payout as bigint | undefined) ?? 0n,
                blockNumber: l.blockNumber,
                timestamp: tsMap.get(l.blockNumber) ?? 0n,
                txHash: l.transactionHash,
            });
        }
        for (const l of listingLogs) {
            events.push({
                kind: 'listingAccepted',
                punkId: Number(l.args.punkId),
                actor: (l.args.caller ?? l.args.seller) as Address,
                amountWei: (l.args.minValue as bigint | undefined) ?? 0n,
                blockNumber: l.blockNumber,
                timestamp: tsMap.get(l.blockNumber) ?? 0n,
                txHash: l.transactionHash,
            });
        }
        return events.sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1)).slice(0, limit);
    }

    async getPunkEligibility(punkId: number, caller?: Address): Promise<PunkEligibility> {
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const [
            owner,
            mask,
            collectedMask,
            pendingMask,
            recordedCustody,
            listing,
            soleCarrier,
            liveBidWei,
        ] = await Promise.all([
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
                    functionName: 'pendingMask',
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
                // Sole-carrier guard (hard invariant #22) — fail-open.
                readSoleCarrier(rpc, addrs.permanentCollection, punkId),
                rpc.readContract({
                    address: addrs.patron,
                    abi: PatronAbi,
                    functionName: 'bidBalance',
                }) as Promise<bigint>,
            ]);

        const uncollectedBits: number[] = [];
        const pendingBits: number[] = [];
        for (let i = 0; i < 111; i++) {
            const bit = 1n << BigInt(i);
            if ((mask & bit) === 0n) continue;
            if ((collectedMask & bit) !== 0n) continue;
            uncollectedBits.push(i);
            if ((pendingMask & bit) !== 0n) pendingBits.push(i);
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
            uncollectedBits: rarestFirst(uncollectedBits),
            pendingBits,
            // Protocol-derived acceptance target (canonicalTargetOf mirror):
            // rarest uncollected non-pending bit. The caller no longer chooses.
            canonicalTargetId: canonicalTarget(uncollectedBits, pendingBits),
            listedToPatron,
            alreadyRecorded: Number(recordedCustody) !== CUSTODY.None,
            soleCarrier,
        };
    }

    async getOwnedTraitOptions(owner: Address): Promise<TraitOption[]> {
        const owned = await this.getPunksOwnedBy(owner);
        if (owned.length === 0) return [];

        const addrs = getContractAddresses();
        const rpc = getRpcClient();

        // Fork reads collected + pending straight from chain (no indexer).
        const [collectedMask, pendingMask] = await Promise.all([
            rpc.readContract({
                address: addrs.permanentCollection,
                abi: PermanentCollectionAbi,
                functionName: 'collectedMask',
            }) as Promise<bigint>,
            rpc.readContract({
                address: addrs.permanentCollection,
                abi: PermanentCollectionAbi,
                functionName: 'pendingMask',
            }) as Promise<bigint>,
        ]);
        const pendingBits = new Set<number>();
        for (let bit = 0; bit < 111; bit++) {
            if (((pendingMask >> BigInt(bit)) & 1n) === 1n) pendingBits.add(bit);
        }

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
        if (punkIds.length === 0) return [];
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
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
        const events: PunkProvenanceEvent[] = [];
        let currentListing: PunkProvenance['currentListing'];

        // Protocol lifecycle events (chain). Wrapped independently so a chain
        // hiccup still leaves the market history below intact.
        try {
            const addrs = getContractAddresses();
            const rpc = getRpcClient();
            const fromBlock = await this.deployBlock(rpc, addrs.permanentCollection);
            const [accepted, resolutions, bidLogs, offers, acqs] = await Promise.all([
                this.getRecentAcceptedBids(10_000),
                this.getRecentResolutions(10_000),
                rpc.getContractEvents({
                    address: addrs.returnAuctionModule,
                    abi: ReturnAuctionModuleAbi,
                    eventName: 'BidPlaced',
                    fromBlock,
                    toBlock: 'latest',
                }) as Promise<EventLog[]>,
                this.readOpenOffers(rpc, addrs),
                this.readAcquisitions(rpc, addrs.permanentCollection),
            ]);
            const targetTraitId = acqs.find((a) => a.punkId === punkId)?.targetTraitId;
            const punkBidLogs = bidLogs.filter((l) => Number(l.args.punkId) === punkId);
            const offer = offers.find(
                (o) => o.punkId === punkId && o.onlySellTo.toLowerCase() === ZERO_ADDRESS && o.minValue > 0n,
            );

            const tsMap = await this.blockTimestamps(rpc, [
                ...punkBidLogs.map((l) => l.blockNumber),
                ...(offer ? [offer.offeredAt] : []),
            ]);

            for (const a of accepted.filter((e) => e.punkId === punkId)) {
                events.push({
                    kind: 'acquired',
                    source: 'protocol',
                    amountWei: a.amountWei,
                    traitId: targetTraitId,
                    actor: a.actor,
                    timestamp: a.timestamp,
                    txHash: a.txHash,
                });
            }
            for (const l of punkBidLogs) {
                events.push({
                    kind: 'bid',
                    source: 'protocol',
                    amountWei: (l.args.amount as bigint | undefined) ?? 0n,
                    actor: l.args.bidder as Address,
                    timestamp: tsMap.get(l.blockNumber) ?? 0n,
                    txHash: l.transactionHash,
                });
            }
            for (const r of resolutions.filter((e) => e.punkId === punkId)) {
                if (r.outcome === 'vaulted') {
                    events.push({
                        kind: 'vaulted',
                        source: 'protocol',
                        traitId: targetTraitId,
                        timestamp: r.settledAt,
                        txHash: r.txHash,
                    });
                } else {
                    events.push({
                        kind: 'returned',
                        source: 'protocol',
                        amountWei: r.finalBidWei,
                        traitId: targetTraitId,
                        timestamp: r.settledAt,
                        txHash: r.txHash,
                    });
                    events.push(
                        ...clearedSplitProvenanceEvents({
                            finalBidWei: r.finalBidWei,
                            liveBidShareWei: r.liveBidShareWei,
                            burnShareWei: r.burnShareWei,
                            traitId: targetTraitId,
                            timestamp: r.settledAt,
                            txHash: r.txHash,
                        }),
                    );
                }
            }
            if (offer) {
                currentListing = {minValueWei: offer.minValue, seller: offer.seller};
                events.push({
                    kind: 'listed',
                    source: 'market',
                    amountWei: offer.minValue,
                    actor: offer.seller,
                    timestamp: tsMap.get(offer.offeredAt) ?? 0n,
                });
            }
        } catch {
            // Chain unreachable — fall through with whatever we have and still
            // attach market history below.
        }

        // Merge in recent public 2017-market history (cryptopunks.app — the
        // fork is a mainnet fork, so Punk ids are canonical mainnet Punks).
        // Dedupe by tx hash against protocol events.
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

    async getPunkStrategyListings(): Promise<PunkStrategyListing[]> {
        try {
            const addrs = getContractAddresses();
            const rpc = getRpcClient();
            const [bidBalance, collectedMask, pendingMask, finderFeeCapBps, finderFeeFixedCap] =
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
                        address: addrs.permanentCollection,
                        abi: PermanentCollectionAbi,
                        functionName: 'pendingMask',
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
                ]);
            if (bidBalance < MIN_BID_FOR_LISTING) return [];

            const offers = await this.readOpenOffers(rpc, addrs);
            if (offers.length === 0) return [];

            // Resolve seller allowlist activation for the distinct sellers.
            const sellers = [...new Set(offers.map((o) => o.seller.toLowerCase()))] as Address[];
            const nowSec = BigInt(Math.floor(Date.now() / 1000));
            const activeAts = (await rpc.multicall({
                contracts: sellers.map((s) => ({
                    address: addrs.patron,
                    abi: PatronAbi,
                    functionName: 'allowedSellerActiveAt' as const,
                    args: [s] as const,
                })),
                allowFailure: false,
            })) as bigint[];
            const activeSellers = new Set<string>();
            sellers.forEach((s, i) => {
                if (activeAts[i] !== 0n && nowSec >= activeAts[i]) activeSellers.add(s.toLowerCase());
            });

            const cap = (bidBalance * finderFeeCapBps) / 10000n;
            const finderFee = cap < finderFeeFixedCap ? cap : finderFeeFixedCap;
            const uncollected = ALL_BITS & ~collectedMask & ~pendingMask;

            const out: PunkStrategyListing[] = [];
            for (const o of offers) {
                if (o.minValue === 0n || o.minValue > bidBalance) continue;
                if (o.onlySellTo.toLowerCase() !== ZERO_ADDRESS) continue;
                if (!activeSellers.has(o.seller.toLowerCase())) continue;
                const eligible: number[] = [];
                const usable = o.traitMask & uncollected;
                for (let i = 0; i < 111; i++) {
                    if ((usable & (1n << BigInt(i))) !== 0n) eligible.push(i);
                }
                if (eligible.length === 0) continue;
                const ranked = rarestFirst(eligible);
                out.push({
                    punkId: o.punkId,
                    seller: o.seller,
                    minValueWei: o.minValue,
                    suggestedTraitId: ranked[0],
                    eligibleTraitIds: ranked,
                    finderFeeWei: finderFee,
                    bountyCostWei: o.minValue + finderFee,
                    listedAt: o.offeredAt,
                    soleCarrier: {required: false, requiredTraitId: 0},
                });
            }

            // Sole-carrier guard per listed Punk — one multicall, fail-open.
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
        } catch {
            return [];
        }
    }

    async getMarketReference(): Promise<MarketReference> {
        // The "cheapest eligible Punk" is a real-world mainnet figure — a local
        // fork can't represent the true floor without the full 2017-market
        // listing history (its `readOpenOffers` only scans PunkOffered since the
        // PC deploy block, so it misses older-but-live listings). Source it from
        // cryptopunks.app via the shared helper, exactly like the live adapter,
        // so dev matches production. Eligibility is checked against the fork's
        // own collectedMask. (Fork-seeded listings still drive the accept flows
        // — getPunkStrategyListings / getPunkEligibility — which read the fork.)
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

    async getPunksOwnedBy(owner: Address): Promise<number[]> {
        // Ownership on a fork the indexer-style way — NOT a 10k-slot scan.
        //
        // A fork inherits mainnet state at the fork block, then accrues local
        // transfers (the dev-wallet Punk seed uses `transferPunk`; acceptBid /
        // accept activity during testing uses `buyPunk`). So a wallet's
        // current holdings are:
        //     (mainnet holdings the fork inherited)            ← cryptopunks.app API
        //   ∪ (Punks that moved IN during local fork history)  ← getLogs, tiny range
        //   − (Punks that moved back OUT / were sold)          ← current-owner verify
        //
        // We gather candidates from the first two cheaply, then confirm each
        // candidate's CURRENT owner with ONE multicall bounded by the
        // candidate count (a handful), never the full 10k supply. The
        // cryptopunks.app API alone can't see the fork-local seed (it only
        // knows mainnet), and the local logs alone miss a real wallet's
        // pre-fork holdings — together they're complete. The full scan stays
        // as a hard-failure last resort only.
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const ownerLc = owner.toLowerCase();

        try {
            const candidates = new Set<number>();

            // (a) Mainnet-inherited holdings. Empty for the fresh dev test
            //     wallet; populated when a real wallet connects to the fork.
            try {
                for (const id of await fetchOwnedFromCryptopunksApi(owner)) {
                    candidates.add(id);
                }
            } catch {
                // API down/changed — the local-log path below still covers
                // the dev seed, which is the common dev:up case.
            }

            // (b) Punks that arrived at the wallet in LOCAL fork history.
            //     `to` / `toAddress` are indexed, so the node filters by topic;
            //     the range is [deployBlock, latest] — a few local blocks.
            const fromBlock = await this.deployBlock(rpc, addrs.permanentCollection);
            const [transfersIn, boughtIn] = await Promise.all([
                rpc.getContractEvents({
                    address: addrs.punksMarket,
                    abi: CryptoPunksMarketAbi,
                    eventName: 'PunkTransfer',
                    args: {to: owner},
                    fromBlock,
                    toBlock: 'latest',
                }),
                rpc.getContractEvents({
                    address: addrs.punksMarket,
                    abi: CryptoPunksMarketAbi,
                    eventName: 'PunkBought',
                    args: {toAddress: owner},
                    fromBlock,
                    toBlock: 'latest',
                }),
            ]);
            for (const log of [...transfersIn, ...boughtIn]) {
                const idx = (log.args as {punkIndex?: bigint}).punkIndex;
                if (idx !== undefined) candidates.add(Number(idx));
            }

            if (candidates.size === 0) return [];

            // Verify CURRENT ownership of just the candidates — handles Punks
            // that later moved out and any API staleness. Bounded multicall.
            const ids = [...candidates].sort((a, b) => a - b);
            const owners = (await rpc.multicall({
                contracts: ids.map((id) => ({
                    address: addrs.punksMarket,
                    abi: CryptoPunksMarketAbi,
                    functionName: 'punkIndexToAddress' as const,
                    args: [BigInt(id)] as const,
                })),
                allowFailure: false,
            })) as Address[];
            return ids.filter((_, i) => owners[i].toLowerCase() === ownerLc);
        } catch {
            // Both cheap paths failed (rare on local anvil) — fall back to the
            // exhaustive on-chain enumeration so correctness is never lost.
            return this._scanPunksOwnedByOnChain(owner);
        }
    }

    /** Last-resort ownership enumeration: walk all 10k `punkIndexToAddress`
     *  slots via Multicall3 in 250-slot batches. Only reached when both the
     *  cryptopunks.app API and the local-log scan fail — it's the slow path
     *  the fast path above exists to avoid. */
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
            const results = (await rpc.multicall({contracts, allowFailure: false})) as Address[];
            for (let j = 0; j < results.length; j++) {
                if (results[j].toLowerCase() === ownerLc) out.push(start + j);
            }
        }
        return out;
    }

    // ──────────────── private helpers ────────────────

    /** Lower bound for `getLogs`: the block PermanentCollection was deployed.
     *  Everything the protocol emits happens at/after this, and on a fork it's
     *  a local block — so the log scan never reaches into forked history. */
    private async deployBlock(rpc: Rpc, pc: Address): Promise<bigint> {
        try {
            return (await rpc.readContract({
                address: pc,
                abi: PermanentCollectionAbi,
                functionName: 'deployedAtBlock',
            })) as bigint;
        } catch {
            return 0n;
        }
    }

    /** Current open CryptoPunks offers created on this fork (post-deploy
     *  PunkOffered events), with live state re-read so withdrawn offers drop
     *  out. Pre-fork mainnet listings aren't visible — irrelevant locally,
     *  where the meaningful listings are the ones the seed scripts create. */
    private async readOpenOffers(
        rpc: Rpc,
        addrs: ReturnType<typeof getContractAddresses>,
    ): Promise<
        Array<{
            punkId: number;
            seller: Address;
            minValue: bigint;
            onlySellTo: Address;
            traitMask: bigint;
            offeredAt: bigint;
        }>
    > {
        const fromBlock = await this.deployBlock(rpc, addrs.permanentCollection);
        const offerLogs = (await rpc.getContractEvents({
            address: addrs.punksMarket,
            abi: CryptoPunksMarketAbi,
            eventName: 'PunkOffered',
            fromBlock,
            toBlock: 'latest',
        })) as EventLog[];
        const punkIds = [...new Set(offerLogs.map((l) => Number(l.args.punkIndex)))];
        if (punkIds.length === 0) return [];

        const [listings, masks] = await Promise.all([
            rpc.multicall({
                contracts: punkIds.map((id) => ({
                    address: addrs.punksMarket,
                    abi: CryptoPunksMarketAbi,
                    functionName: 'punksOfferedForSale' as const,
                    args: [BigInt(id)] as const,
                })),
                allowFailure: false,
            }) as Promise<Array<readonly [boolean, bigint, Address, bigint, Address]>>,
            rpc.multicall({
                contracts: punkIds.map((id) => ({
                    address: addrs.punksData,
                    abi: PunksDataAbi,
                    functionName: 'traitMaskOf' as const,
                    args: [id] as const,
                })),
                allowFailure: false,
            }) as Promise<bigint[]>,
        ]);
        const offeredAtByPunk = new Map<number, bigint>();
        for (const l of offerLogs) offeredAtByPunk.set(Number(l.args.punkIndex), l.blockNumber);

        const out = [];
        for (let i = 0; i < punkIds.length; i++) {
            const [isForSale, , seller, minValue, onlySellTo] = listings[i];
            if (!isForSale) continue;
            out.push({
                punkId: punkIds[i],
                seller,
                minValue,
                onlySellTo,
                traitMask: masks[i],
                offeredAt: offeredAtByPunk.get(punkIds[i]) ?? 0n,
            });
        }
        return out;
    }

    async getProofs(): Promise<import('./types').ProofView[]> {
        // Reads `proofsMintedMask` from PunkVault to find which Proofs have
        // minted, then pulls `proofMeta` + `ownerOf` for each set bit.
        // Mirrors the LiveAdapter implementation; viem multicalls the per-id
        // reads so a 56-vault state is still one network round-trip.
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const {abi: PunkVaultAbi} = await import('@/lib/abis/PunkVault');
        let mintedMask: bigint;
        try {
            mintedMask = (await rpc.readContract({
                address: addrs.punkVault,
                abi: PunkVaultAbi,
                functionName: 'proofsMintedMask',
            })) as bigint;
        } catch {
            mintedMask = 0n;
        }
        const traitNames = await this.getTraitNames();
        const out: import('./types').ProofView[] = new Array(111);
        const metaPromises: Promise<unknown>[] = [];
        const ownerPromises: Promise<unknown>[] = [];
        const mintedIds: number[] = [];
        for (let traitId = 0; traitId < 111; traitId++) {
            const bit = (mintedMask >> BigInt(traitId)) & 1n;
            if (bit === 1n) {
                mintedIds.push(traitId);
                metaPromises.push(
                    rpc.readContract({
                        address: addrs.punkVault,
                        abi: PunkVaultAbi,
                        functionName: 'proofMeta',
                        args: [BigInt(traitId)],
                    }),
                );
                ownerPromises.push(
                    rpc.readContract({
                        address: addrs.punkVault,
                        abi: PunkVaultAbi,
                        functionName: 'ownerOf',
                        args: [BigInt(traitId)],
                    }),
                );
            }
            out[traitId] = {
                tokenId: traitId,
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
        // Fetch on-chain SVG bytes for every Proof slot in parallel. The
        // proof renderer's `tokenURI(uint256)` returns the same museum-plate
        // for both minted (full inscription) and unminted (preview) states,
        // so we render artwork for all 111 cells. Each call is ~50-150M
        // gas; the parallel batch is comparable in wall time to the
        // heaviest renderer-svg fetch on the homepage. Mirrors the
        // LiveAdapter implementation — the prior comment ("fork adapter
        // doesn't fetch on-chain SVGs — the local anvil chain may not
        // have the renderer deployed") was stale: `Deploy.s.sol`
        // provisions the renderer on every fork.
        const svgPromises = Array.from({length: 111}, (_, traitId) =>
            this._fetchProofSvg(traitId),
        );
        const [metas, owners, svgs] = await Promise.all([
            Promise.all(metaPromises),
            Promise.all(ownerPromises),
            Promise.allSettled(svgPromises),
        ]);
        for (let i = 0; i < mintedIds.length; i++) {
            const traitId = mintedIds[i]!;
            const meta = metas[i] as readonly [number, number, number, bigint];
            const row = out[traitId]!;
            row.punkId = Number(meta[0]);
            row.sequence = Number(meta[2]);
            row.mintedAtBlock = meta[3];
            row.currentOwner = owners[i] as `0x${string}`;
        }
        for (let traitId = 0; traitId < 111; traitId++) {
            const s = svgs[traitId];
            if (s && s.status === 'fulfilled') out[traitId]!.svgMarkup = s.value;
        }
        return out;
    }

    /** Read `proofRenderer.tokenURI(traitId)` via raw eth_call so we can
     *  attach a generous gas budget — the renderer composes a full SVG
     *  inline and exceeds the default eth_call cap on most providers.
     *  Returns the inner SVG bytes after stripping the JSON envelope and
     *  the inner `data:image/svg+xml;base64,` data URI. Routes through the
     *  Mosaic renderer (which dispatches ids 0..110 to the proof renderer)
     *  so the call path matches `PunkVault.tokenURI(id)` exactly.
     *  Mirrors LiveAdapter._fetchProofSvg. */
    private async _fetchProofSvg(traitId: number): Promise<string | null> {
        try {
            const addrs = getContractAddresses();
            const rpc = getRpcClient();
            // selector(tokenURI(uint256)) + uint256(traitId) padded.
            const idHex = traitId.toString(16).padStart(64, '0');
            const callData = `0xc87b56dd${idHex}` as `0x${string}`;
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

    async getProofForTrait(_traitId: number): Promise<import('./types').ProofView | null> {
        return null;
    }

    // Both are pure chain reads (PunkVault + PermanentCollection) with no
    // indexer dependency, so the LiveAdapter implementation works verbatim
    // against the local fork's RPC — delegate rather than duplicate.
    getProofDetail(tokenId: number): Promise<import('./types').ProofDetail | null> {
        return this.live.getProofDetail(tokenId);
    }

    getTitleNft(): Promise<import('./types').TitleNftView> {
        return this.live.getTitleNft();
    }

    /** Chain-direct Title Auction state — no indexer involvement. The fork
     *  adapter is for the throwaway-anvil dev loop where Ponder isn't
     *  running. */
    async getTitleAuctionState(caller?: Address): Promise<import('./types').TitleAuctionState> {
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        const ZERO = '0x0000000000000000000000000000000000000000' as Address;
        const titleAuction = addrs.titleAuction;
        if (!titleAuction) {
            let collectedCount = 0;
            try {
                const n = (await rpc.readContract({
                    address: addrs.permanentCollection,
                    abi: PermanentCollectionAbi,
                    functionName: 'collectedCount',
                })) as bigint;
                collectedCount = Number(n);
            } catch {/* ignore */}
            return {
                phase: 'not-deployed',
                collectedCount,
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
                payoutRecipientAddr: ZERO,
            };
        }
        const {abi: PunkVaultTitleAuctionAbi} = await import('@/lib/abis/PunkVaultTitleAuction');
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
            collectedCountRaw,
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
            rpc.readContract({address: addrs.permanentCollection, abi: PermanentCollectionAbi, functionName: 'collectedCount'}) as Promise<bigint>,
        ]);
        const [patronPending, payoutPending, refundForCaller] = await Promise.all([
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'pendingProceeds', args: [patronAddr]}) as Promise<bigint>,
            rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'pendingProceeds', args: [payoutRecipientAddr]}) as Promise<bigint>,
            caller
                ? (rpc.readContract({address: titleAuction, abi: PunkVaultTitleAuctionAbi, functionName: 'pendingRefund', args: [caller]}) as Promise<bigint>)
                : Promise.resolve(undefined as unknown as bigint),
        ]);
        const {pickTitleAuctionPhase} = await import('./live');
        return {
            phase: pickTitleAuctionPhase({kickedOff, settled, isLive, isSettleable, isKickoffReady}),
            collectedCount: Number(collectedCountRaw),
            isKickoffReady,
            isLive,
            isSettleable,
            kickedOff,
            settled,
            endsAt,
            highBidWei,
            highBidder: highBidder === ZERO ? undefined : highBidder,
            minNextBidWei,
            // Fork adapter doesn't track restart/extension counts (no indexer).
            // The UI degrades to a generic "live" without round/extension callout.
            restartCount: 0,
            extensionsThisRound: 0,
            pendingProceedsByAddr: {patron: patronPending, payoutRecipient: payoutPending},
            patronAddr,
            payoutRecipientAddr,
            pendingRefundForCaller: caller ? (refundForCaller as bigint) : undefined,
        };
    }

    async getTitleAuctionBids(): Promise<import('./types').TitleAuctionBidEntry[]> {
        const addrs = getContractAddresses();
        const titleAuction = addrs.titleAuction;
        if (!titleAuction) return [];
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
            const uniq = Array.from(new Set(logs.map((l) => l.blockNumber!)));
            const blocks = await Promise.all(uniq.map((bn) => rpc.getBlock({blockNumber: bn})));
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

    async getReferralStatus(referrer: Address): Promise<import('./types').ReferralStatus> {
        // Fork adapter is chain-direct by design (no indexer in the local
        // dev loop). Three reads — referralPayout.balances, plus the two
        // hook reads — return zero when the contract isn't deployed on
        // this env (referralPayout is optional on a fresh fork).
        const addrs = getContractAddresses();
        const referralPayoutAddr = addrs.referralPayout;
        const empty: import('./types').ReferralStatus = {
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
        const [balance, accruedHook] = await Promise.all([
            rpc
                .readContract({
                    address: referralPayoutAddr,
                    abi: ReferralPayoutAbi,
                    functionName: 'balances',
                    args: [referrer],
                })
                .then((v) => v as bigint)
                .catch(() => 0n),
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
            balance,
            totalCredited: 0n,
            totalClaimed: 0n,
            stuckOnHookWei: accruedHook,
        };
    }

    async getReturnAuctionBids(punkId: number): Promise<import('./types').ReturnAuctionBidEntry[]> {
        // Fork adapter is chain-direct by design — there's no indexer on the
        // local dev loop. Bounded `getLogs` scan from the PermanentCollection
        // deploy block (which is local to the fork, so the scan never reaches
        // pre-fork mainnet history). `mainnet` adapter (lib/data/live.ts)
        // serves the indexer-backed path; production / `/api/auction-bids`
        // never lands here.
        const addrs = getContractAddresses();
        const rpc = getRpcClient();
        try {
            const fromBlock = await this.deployBlock(rpc, addrs.permanentCollection);
            const logs = await rpc.getLogs({
                address: addrs.returnAuctionModule,
                event: {
                    type: 'event',
                    name: 'BidPlaced',
                    inputs: [
                        {name: 'punkId', type: 'uint16', indexed: true},
                        {name: 'bidder', type: 'address', indexed: true},
                        {name: 'referrer', type: 'address', indexed: true},
                        {name: 'amount', type: 'uint256', indexed: false},
                        {name: 'tag', type: 'bytes32', indexed: false},
                        {name: 'endsAt', type: 'uint64', indexed: false},
                    ],
                },
                args: {punkId},
                fromBlock,
                toBlock: 'latest',
            });
            const uniq = Array.from(new Set(logs.map((l) => l.blockNumber!)));
            const blocks = await Promise.all(uniq.map((bn) => rpc.getBlock({blockNumber: bn})));
            const tsByBlock = new Map(blocks.map((b) => [b.number!, b.timestamp]));
            return logs
                .map((l) => ({
                    bidder: (l.args.bidder ?? '0x0') as Address,
                    amount: l.args.amount ?? 0n,
                    blockNumber: l.blockNumber!,
                    timestamp: tsByBlock.get(l.blockNumber!) ?? 0n,
                    txHash: l.transactionHash! as Hex,
                }))
                .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? 1 : -1));
        } catch {
            return [];
        }
    }
}

/** Minimal shape of a viem decoded event log we consume. `args` keys depend on
 *  the event; we read them defensively (cast at the call site). */
interface EventLog {
    args: Record<string, unknown> & {punkId?: unknown; punkIndex?: unknown};
    blockNumber: bigint;
    transactionHash: Hex;
}
