/* Server-side snapshot of the value-distribution pipeline, for the
   /debug/distribution dashboard. For each distro location it reports the
   CURRENT amount it holds (balance / pending / queued) plus the TOTAL it has
   distributed over its lifetime (summed from its events), and below the
   stations a merged, newest-first history of every value-movement event.

   Server-only on purpose: it reads straight from `getRpcUrls()` (the local
   anvil fork in fork mode, mainnet otherwise) rather than the browser's
   `/api/rpc` proxy, so it isn't subject to the proxy's getLogs span cap and
   can pull the full history from the deploy block, exactly like the fork
   data adapter does. Every value is formatted to a display string here so
   the page never has to ship bigints across the RSC boundary. */

import {createPublicClient, fallback, http, type Address} from 'viem';
import {mainnet} from 'viem/chains';

import {abi as ArtCoinsHookSkimFeeAbi} from '@/lib/abis/ArtCoinsHookSkimFee';
import {abi as BuybackBurnerAbi} from '@/lib/abis/BuybackBurner';
import {abi as LiveBidAdapterAbi} from '@/lib/abis/LiveBidAdapter';
import {abi as PatronAbi} from '@/lib/abis/Patron';
import {abi as PermanentCollectionAbi} from '@/lib/abis/PermanentCollection';
import {abi as ProtocolFeePhaseAdapterAbi} from '@/lib/abis/ProtocolFeePhaseAdapter';
import {abi as ReferralPayoutAbi} from '@/lib/abis/ReferralPayout';
import {abi as ReturnAuctionModuleAbi} from '@/lib/abis/ReturnAuctionModule';
import {abi as VaultBurnPoolAbi} from '@/lib/abis/VaultBurnPool';
import {getContractAddresses, getRpcUrls, isProtocolLive} from '@/lib/config';
import {formatEth, formatEthBare, shortAddress} from '@/lib/format';
import {FEES} from '@/lib/protocol-params';
import {buildPoolKey, computePoolId} from '@/lib/swap/poolKey';
import {evaluateKeeperTargets, type KeeperContract, type KeeperTarget} from '@/lib/keeper/targets';

const ZERO = '0x0000000000000000000000000000000000000000';

/** Minimal ABI for the artcoins fee escrow — the protocol leg sits here
 *  under the ProtocolFeePhaseAdapter's address until it sweeps. The escrow
 *  address isn't in the frontend config, so it's discovered at runtime via
 *  `ProtocolFeePhaseAdapter.feeEscrow()`. */
const escrowAbi = [
    {
        type: 'function',
        name: 'availableFees',
        stateMutability: 'view',
        inputs: [{type: 'address'}, {type: 'address'}],
        outputs: [{type: 'uint256'}],
    },
] as const;

/** Minimal ABI for the artcoins `ProtocolFeeController` (PCController). Not in
 *  the frontend config or ABI set, so the protocol-leg tail (split → LAYER
 *  burn) is read via these view getters. */
const controllerAbi = [
    {type: 'function', name: 'treasuryBps', stateMutability: 'view', inputs: [], outputs: [{type: 'uint16'}]},
    {type: 'function', name: 'burnBps', stateMutability: 'view', inputs: [], outputs: [{type: 'uint16'}]},
    {type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    {type: 'function', name: 'burnRouter', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    // Emitted once per processNativeFees() — the only path money reaches the
    // team. `treasuryAmount` is the team's slice; summing these = lifetime to team.
    {
        type: 'event',
        name: 'NativeFeesProcessed',
        inputs: [
            {name: 'totalAmount', type: 'uint256', indexed: false},
            {name: 'treasuryAmount', type: 'uint256', indexed: false},
            {name: 'burnAmount', type: 'uint256', indexed: false},
        ],
    },
    // ERC20 path (PC's protocol leg is native ETH, but summed for completeness
    // so a stray token distribution still counts toward the team total).
    {
        type: 'event',
        name: 'FeesProcessed',
        inputs: [
            {name: 'token', type: 'address', indexed: true},
            {name: 'totalAmount', type: 'uint256', indexed: false},
            {name: 'treasuryAmount', type: 'uint256', indexed: false},
            {name: 'burnAmount', type: 'uint256', indexed: false},
        ],
    },
] as const;

/** Minimal ABI for the artcoins LAYER `BurnRouter` — the protocol leg's
 *  terminal buy-and-burn. Discovered at runtime via `controller.burnRouter()`. */
const burnRouterAbi = [
    {type: 'function', name: 'layerToken', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    {type: 'function', name: 'weth', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    {type: 'function', name: 'minProcessThreshold', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'minLayerOutPerWeth', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {
        type: 'function',
        name: 'heldBalance',
        stateMutability: 'view',
        inputs: [{type: 'address'}],
        outputs: [{type: 'uint256'}],
    },
] as const;

export interface DistroRow {
    k: string;
    v: string;
}

/** A permissionless keeper call that moves value out of a station. The page
 *  renders one execute button per action. Args are decimal strings so no
 *  bigint crosses the RSC boundary — the client `BigInt()`s them back. */
export interface KeeperAction {
    /** Which ABI the client uses to encode the call. */
    contract: KeeperContract;
    address: Address;
    functionName: string;
    /** Numeric args as decimal strings (client converts to bigint). */
    args: string[];
    /** Button label. */
    label: string;
    /** True when the call has something to do right now (e.g. buffer non-empty
     *  and off cooldown). A non-actionable action still renders, disabled. */
    actionable: boolean;
}

export interface DistroStation {
    key: string;
    label: string;
    role: string;
    address: Address | null;
    present: boolean;
    /** CURRENT amount held (balance / pending / queued), formatted. */
    currentLabel: string;
    currentValue: string;
    /** TOTAL distributed over the contract's lifetime, formatted. `null`
     *  total when there's no meaningful lifetime figure for this step. */
    totalLabel: string;
    totalValue: string;
    /** Optional action-readiness chip (sweep / step callable now). */
    ready: {label: string; ok: boolean} | null;
    rows: DistroRow[];
    /** Set when this station relies on a permissionless keeper call to move
     *  value downstream — the page tags it "keeper" and renders an execute
     *  button per action. `null` for stations that flow automatically (the
     *  per-swap hook), are driven by another contract (VaultBurnPool), or are
     *  spent by user actions (Patron). */
    keeper: {hint: string; actions: KeeperAction[]} | null;
}

export interface DistroEvent {
    id: string;
    block: number;
    /** Estimated unix seconds for this event, derived from its block height at
     *  ~12s/block anchored to the snapshot's block+time. RPC-free (no per-block
     *  timestamp fetch); accurate to a few seconds on post-merge mainnet, which
     *  is plenty for relative-time display. */
    tsSecs: number;
    logIndex: number;
    contract: string;
    name: string;
    summary: string;
    txHash: string | null;
}

export interface DistroSnapshot {
    live: boolean;
    asOfBlock: number;
    asOfMs: number;
    stations: DistroStation[];
    history: DistroEvent[];
    /** Soft read failures (one leg unreachable shouldn't blank the page). */
    notes: string[];
    /** Top-level lifetime totals, surfaced prominently above the pipeline.
     *  `teamEarned` is cumulative ETH paid to the PC treasury (the team's take),
     *  summed from the controller's NativeFeesProcessed events. */
    headline: {teamEarned: string; teamRecipient: string; layerBurned: string; volume: string};
}

function getRpc() {
    const urls = getRpcUrls();
    const transports = urls.map((u) => http(u, {timeout: 30_000}));
    return createPublicClient({
        chain: mainnet,
        transport: transports.length > 1 ? fallback(transports) : transports[0],
    });
}

type Rpc = ReturnType<typeof getRpc>;

async function rd<T>(p: Promise<T>): Promise<T | undefined> {
    try {
        return await p;
    } catch {
        return undefined;
    }
}

const eth = (w: bigint | undefined, d = 4): string => (w === undefined ? '—' : formatEth(w, d));
const ethBare = (w: bigint | undefined, d = 4): string =>
    w === undefined ? '?' : formatEthBare(w, d);

function isSet(a: Address | undefined | null): a is Address {
    return !!a && a.toLowerCase() !== ZERO;
}

/** Only value-movement + lifecycle events make the history feed AND the
 *  lifetime totals — setup, config, and wiring events are filtered out. */
const HISTORY_EVENTS = new Set([
    'SkimSplit',
    'LegForwarded',
    'ReferralForwarded',
    'ReferralFoldedToProtocol',
    'Swept',
    'Contribution',
    'BareTopUp',
    'PoolReplenished',
    'KeeperReward',
    'ActivationThresholdSynced',
    'Forwarded',
    'BidAccepted',
    'ListingAccepted',
    'SurplusForwarded',
    'ReturnAuctionStarted',
    'BidPlaced',
    'ReturnAuctionCleared',
    'ReturnAuctionExtended',
    'PunkVaulted',
    'RefundQueued',
    'RefundWithdrawn',
    'BurnEthDeposited',
    'TokensBurned',
    'ExecutionRewardPaid',
    'ReferralCredited',
    'ReferralClaimed',
    'NativeFeesProcessed',
    'FeesProcessed',
]);

interface RawEvent {
    contract: string;
    name: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any;
    block: number;
    logIndex: number;
    txHash: string | null;
}

/** Lifetime totals per leg, summed from the full event set. */
interface DistroTotals {
    hookBid: bigint;
    hookProtocol: bigint;
    hookRef: bigint;
    hookVolume: bigint;
    adapterForwarded: bigint;
    patronSpent: bigint;
    protocolForwarded: bigint;
    referralCredited: bigint;
    referralClaimed: bigint;
    auctionSettled: bigint;
    vaultBurnSwept: bigint;
    teamTotal: bigint;
    layerBurnTotal: bigint;
}

function zeroTotals(): DistroTotals {
    return {
        hookBid: 0n,
        hookProtocol: 0n,
        hookRef: 0n,
        hookVolume: 0n,
        adapterForwarded: 0n,
        patronSpent: 0n,
        protocolForwarded: 0n,
        referralCredited: 0n,
        referralClaimed: 0n,
        auctionSettled: 0n,
        vaultBurnSwept: 0n,
        teamTotal: 0n,
        layerBurnTotal: 0n,
    };
}

const big = (x: unknown): bigint => (typeof x === 'bigint' ? x : 0n);

function aggregateTotals(events: RawEvent[]): DistroTotals {
    const t = zeroTotals();
    for (const e of events) {
        const a = e.args ?? {};
        switch (e.name) {
            case 'SkimSplit':
                t.hookVolume += big(a.quoteVolume);
                t.hookBid += big(a.bountyAmount);
                t.hookProtocol += big(a.protocolNet);
                t.hookRef += big(a.referralPaid);
                break;
            case 'Swept':
                if (e.contract === 'LiveBidAdapter') t.adapterForwarded += big(a.ethForwarded);
                else if (e.contract === 'VaultBurnPool') t.vaultBurnSwept += big(a.amount);
                break;
            case 'BidAccepted':
                t.patronSpent += big(a.payout);
                break;
            case 'ListingAccepted':
                t.patronSpent += big(a.minValue);
                break;
            case 'Forwarded':
                t.protocolForwarded += big(a.amount);
                break;
            case 'NativeFeesProcessed':
            case 'FeesProcessed':
                t.teamTotal += big(a.treasuryAmount);
                t.layerBurnTotal += big(a.burnAmount);
                break;
            case 'ReferralCredited':
                t.referralCredited += big(a.amount);
                break;
            case 'ReferralClaimed':
                t.referralClaimed += big(a.amount);
                break;
            case 'ReturnAuctionCleared':
                t.auctionSettled += big(a.highBidWei);
                break;
        }
    }
    return t;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarize(name: string, a: any): string {
    const ad = (x?: string) => (x ? shortAddress(x) : '?');
    switch (name) {
        case 'SkimSplit':
            return `vol ${ethBare(a.quoteVolume)} → bid ${ethBare(a.bountyAmount)} · protocol ${ethBare(a.protocolNet)} · ref ${ethBare(a.referralPaid)}`;
        case 'LegForwarded':
            return `leg ${a.leg} → ${ad(a.recipient)} ${ethBare(a.amount)}`;
        case 'ReferralForwarded':
            return `→ ${ad(a.referrer)} ${ethBare(a.amount)}`;
        case 'ReferralFoldedToProtocol':
            return `folded → protocol ${ethBare(a.amount)}`;
        case 'Swept':
            return a.ethSwept !== undefined
                ? `swept ${ethBare(a.ethSwept)} · forwarded ${ethBare(a.ethForwarded)} · buffered ${ethBare(a.ethBuffered)}`
                : `swept ${ethBare(a.amount)} → burner`;
        case 'Contribution':
            return `${ethBare(a.amount)} from ${ad(a.contributor)} (ref ${ethBare(a.referrerShare)})`;
        case 'BareTopUp':
            return `${ethBare(a.amount)} from ${ad(a.sender)}`;
        case 'PoolReplenished':
            return `punk #${a.punkId} → ${ethBare(a.amount)}`;
        case 'KeeperReward':
            return `${ethBare(a.amount)} → ${ad(a.caller)}`;
        case 'ActivationThresholdSynced':
            return `clearing ${ethBare(a.clearingPrice)} → threshold ${ethBare(a.applied)}`;
        case 'Forwarded':
            return `→ ${ad(a.recipient)} ${ethBare(a.amount)}`;
        case 'BidAccepted':
            return `punk #${a.punkId} payout ${ethBare(a.payout)}`;
        case 'ListingAccepted':
            return `punk #${a.punkId} value ${ethBare(a.minValue)} · finder ${ethBare(a.finderFee)}`;
        case 'SurplusForwarded':
            return `surplus ${ethBare(a.amount)} → ${ad(a.caller)}`;
        case 'ReturnAuctionStarted':
            return `punk #${a.punkId} cost ${ethBare(a.acquisitionCost)} · reserve ${ethBare(a.reserveWei)}`;
        case 'BidPlaced':
            return `punk #${a.punkId} ${ethBare(a.amount)} by ${ad(a.bidder)}`;
        case 'ReturnAuctionCleared':
            return `punk #${a.punkId} hi ${ethBare(a.highBidWei)} → bid ${ethBare(a.liveBidShare)} · burn ${ethBare(a.burnShare)} · vault ${ethBare(a.vaultBurnShare)} · ref ${ethBare(a.referrerShare)}`;
        case 'ReturnAuctionExtended':
            return `punk #${a.punkId} extended`;
        case 'PunkVaulted':
            return `punk #${a.punkId} vaulted (trait permanent)`;
        case 'RefundQueued':
            return `refund ${ethBare(a.amount)} → ${ad(a.bidder)}`;
        case 'RefundWithdrawn':
            return `refund ${ethBare(a.amount)} by ${ad(a.bidder)}`;
        case 'BurnEthDeposited':
            return `+${ethBare(a.amount)} (queued ${ethBare(a.remainingEth)})`;
        case 'TokensBurned':
            return `spent ${ethBare(a.ethSpent)} → burned ${ethBare(a.tokensBurned, 2)} $111`;
        case 'ExecutionRewardPaid':
            return `reward ${ethBare(a.amount)} → ${ad(a.caller)}`;
        case 'ReferralCredited':
            return `+${ethBare(a.amount)} → ${ad(a.referrer)}`;
        case 'ReferralClaimed':
            return `${ethBare(a.amount)} by ${ad(a.referrer)}`;
        default:
            return name;
    }
}

export async function getDistributionSnapshot(): Promise<DistroSnapshot> {
    const asOfMs = Date.now();
    const live = isProtocolLive();
    const addrs = getContractAddresses();
    const notes: string[] = [];

    if (!live) {
        return {
            live: false,
            asOfBlock: 0,
            asOfMs,
            stations: [],
            history: [],
            notes: ['Protocol not live (no token configured). Deploy on a fork to populate.'],
            headline: {teamEarned: '—', teamRecipient: '—', layerBurned: '—', volume: '—'},
        };
    }

    const rpc = getRpc();
    const currentBlock = (await rd(rpc.getBlockNumber())) ?? 0n;
    const deployBlock =
        (await rd(
            rpc.readContract({
                address: addrs.permanentCollection,
                abi: PermanentCollectionAbi,
                functionName: 'deployedAtBlock',
            }) as Promise<bigint>,
        )) ?? 0n;

    // Discover the escrow + controller (not in the frontend config) from the
    // protocol-leg adapter, and the conversion locker from the hook — so those
    // downstream / upstream steps are readable.
    let escrow: Address | undefined;
    let controller: Address | undefined;
    if (isSet(addrs.protocolFeePhaseAdapter)) {
        escrow = (await rd(
            rpc.readContract({
                address: addrs.protocolFeePhaseAdapter,
                abi: ProtocolFeePhaseAdapterAbi,
                functionName: 'feeEscrow',
            }) as Promise<Address>,
        )) as Address | undefined;
        controller = (await rd(
            rpc.readContract({
                address: addrs.protocolFeePhaseAdapter,
                abi: ProtocolFeePhaseAdapterAbi,
                functionName: 'controller',
            }) as Promise<Address>,
        )) as Address | undefined;
    }
    // Team-fee recipient (the treasury slice destination) — read off the
    // discovered controller for the headline + the recipients list. (A second
    // read happens inside buildStations; the overlap is acceptable here per the
    // note below.)
    let teamRecipient: Address | undefined;
    if (controller && isSet(controller)) {
        teamRecipient = (await rd(
            rpc.readContract({address: controller, abi: controllerAbi, functionName: 'treasury'}) as Promise<Address>,
        )) as Address | undefined;
    }
    let locker: Address | undefined;
    if (isSet(addrs.artcoinsHook) && isSet(addrs.token)) {
        // Guarded: a malformed/odd-checksum configured address would make
        // computePoolId throw, and that must not 500 the whole dashboard.
        try {
            const poolId = computePoolId(buildPoolKey(addrs.token));
            locker = (await rd(
                rpc.readContract({
                    address: addrs.artcoinsHook,
                    abi: ArtCoinsHookSkimFeeAbi,
                    functionName: 'locker',
                    args: [poolId],
                }) as Promise<Address>,
            )) as Address | undefined;
        } catch {
            locker = undefined;
        }
    }

    // One pass of event reads feeds BOTH the lifetime totals and the history.
    const events = await collectEvents(rpc, addrs, controller, deployBlock, notes);
    const totals = aggregateTotals(events);

    // Which return auctions are past their deadline and not yet settled — each
    // is one settle() keeper call. Derived from the ReturnAuctionStarted set
    // (dedup'd: a re-auctioned Punk recurs) then confirmed live via
    // isSettleable, so a cleared/vaulted Punk drops out.
    const settleablePunks = await findSettleablePunks(rpc, addrs.returnAuctionModule, events);

    // Single source of keeper readiness, shared with scripts/keeper.ts. Pass the
    // already-discovered escrow/controller and the settleable set so the
    // evaluator doesn't re-discover or re-scan auction history. (A handful of
    // cheap view reads do overlap with the per-station display reads below —
    // acceptable on this low-traffic debug page in exchange for one definition
    // of the readiness predicates.)
    const keeperTargets = await evaluateKeeperTargets(
        rpc,
        {
            permanentCollection: addrs.permanentCollection,
            liveBidAdapter: addrs.liveBidAdapter,
            protocolFeePhaseAdapter: addrs.protocolFeePhaseAdapter,
            buybackBurner: addrs.buybackBurner,
            returnAuctionModule: addrs.returnAuctionModule,
            token: addrs.token,
        },
        {currentBlock, escrow, controller, settleablePunks},
    );

    const stations = await buildStations(
        rpc,
        addrs,
        escrow,
        controller,
        locker,
        totals,
        settleablePunks,
        keeperTargets,
        notes,
    );

    // Estimate each event's time from its block height (no per-block timestamp
    // fetch): ~12s/block back from the snapshot's current block + time.
    const asOfBlockNum = Number(currentBlock);
    const nowSecs = Math.floor(asOfMs / 1000);
    const history = [...events]
        .sort((a, b) => b.block - a.block || b.logIndex - a.logIndex)
        .slice(0, 150)
        .map((e) => ({
            id: `${e.txHash ?? e.block}-${e.logIndex}`,
            block: e.block,
            tsSecs: nowSecs - Math.max(0, asOfBlockNum - e.block) * 12,
            logIndex: e.logIndex,
            contract: e.contract,
            name: e.name,
            summary: summarize(e.name, e.args),
            txHash: e.txHash,
        }));

    return {
        live: true,
        asOfBlock: Number(currentBlock),
        asOfMs,
        stations,
        history,
        notes,
        headline: {
            teamEarned: eth(totals.teamTotal),
            teamRecipient: teamRecipient && isSet(teamRecipient) ? teamRecipient : '—',
            layerBurned: eth(totals.layerBurnTotal),
            volume: eth(totals.hookVolume),
        },
    };
}

/** Return-auction punkIds that are past their deadline and not yet settled.
 *  Pulls the candidate set from the ReturnAuctionStarted history (so we never
 *  scan all 10k ids), then confirms each via the on-chain `isSettleable` view
 *  so re-auctions and already-settled sales resolve correctly. */
async function findSettleablePunks(
    rpc: Rpc,
    module: Address | undefined,
    events: RawEvent[],
): Promise<number[]> {
    if (!isSet(module)) return [];
    const ids = new Set<number>();
    for (const e of events) {
        if (e.contract === 'ReturnAuction' && e.name === 'ReturnAuctionStarted') {
            ids.add(Number(big(e.args?.punkId)));
        }
    }
    if (ids.size === 0) return [];
    const list = [...ids];
    const checks = await Promise.all(
        list.map((id) =>
            rd(
                rpc.readContract({
                    address: module,
                    abi: ReturnAuctionModuleAbi,
                    functionName: 'isSettleable',
                    args: [id],
                }) as Promise<boolean>,
            ),
        ),
    );
    return list.filter((_, i) => checks[i] === true).sort((a, b) => a - b);
}

async function buildStations(
    rpc: Rpc,
    addrs: ReturnType<typeof getContractAddresses>,
    escrow: Address | undefined,
    controller: Address | undefined,
    locker: Address | undefined,
    totals: DistroTotals,
    settleablePunks: number[],
    keeperTargets: KeeperTarget[],
    notes: string[],
): Promise<DistroStation[]> {
    const stations: DistroStation[] = [];

    // Map the shared evaluator's targets into the dashboard's KeeperAction shape
    // (drops the bot-only key/reason/reward). Readiness + call args come from the
    // shared module so the execute buttons match what scripts/keeper.ts would send.
    const toAction = (t: KeeperTarget): KeeperAction => ({
        contract: t.contract,
        address: t.address,
        functionName: t.functionName,
        args: t.args,
        label: t.label,
        actionable: t.actionable,
    });
    const actionsByPrefix = (prefix: string): KeeperAction[] =>
        keeperTargets.filter((t) => t.key === prefix || t.key.startsWith(`${prefix}.`)).map(toAction);
    const isReady = (key: string): boolean => keeperTargets.find((t) => t.key === key)?.actionable ?? false;

    // 1. Hook — the skim source.
    stations.push({
        key: 'hook',
        label: 'Hook (skim)',
        role: `Takes the ${FEES.baselineSkimPct}% baseline skim on every swap and splits it bid / protocol / referral in the same tx.`,
        address: isSet(addrs.artcoinsHook) ? addrs.artcoinsHook : null,
        present: isSet(addrs.artcoinsHook),
        currentLabel: 'Transient (per-swap)',
        currentValue: eth(isSet(addrs.artcoinsHook) ? await rd(rpc.getBalance({address: addrs.artcoinsHook!})) : undefined),
        totalLabel: 'Skimmed total',
        totalValue: eth(totals.hookBid + totals.hookProtocol + totals.hookRef),
        ready: null,
        rows: [
            {k: 'Total volume', v: eth(totals.hookVolume)},
            {k: 'Total → bid', v: eth(totals.hookBid)},
            {k: 'Total → protocol', v: eth(totals.hookProtocol)},
            {k: 'Total → referral', v: eth(totals.hookRef)},
        ],
        keeper: null, // Splits + flushes inside every swap's tx. No keeper.
    });

    // 2. Conversion locker — holds the LP positions, routes LP fees to the adapter.
    stations.push({
        key: 'locker',
        label: 'Conversion locker (LP)',
        role: 'Holds 100% of LP at launch; its LP-fee share routes to the live-bid adapter. (Outflow is captured in the adapter total.)',
        address: locker && isSet(locker) ? locker : null,
        present: !!locker && isSet(locker),
        currentLabel: 'Balance',
        currentValue: eth(locker && isSet(locker) ? await rd(rpc.getBalance({address: locker})) : undefined),
        totalLabel: 'Forwarded',
        totalValue: '— (via adapter)',
        ready: null,
        rows: [],
        // The locker is an artcoins contract; its LP-fee collection keeper
        // isn't wired into this dashboard (no ABI bound here).
        keeper: null,
    });

    // 3. LiveBidAdapter — bid buffer + metering.
    if (isSet(addrs.liveBidAdapter)) {
        const a = addrs.liveBidAdapter;
        const [buffer, threshold, lastSweep, nextSweep, maxSweep, minBlocks] = await Promise.all([
            rd(rpc.readContract({address: a, abi: LiveBidAdapterAbi, functionName: 'bufferedEth'}) as Promise<bigint>),
            rd(rpc.readContract({address: a, abi: LiveBidAdapterAbi, functionName: 'activationThreshold'}) as Promise<bigint>),
            rd(rpc.readContract({address: a, abi: LiveBidAdapterAbi, functionName: 'lastSweepBlock'}) as Promise<bigint>),
            rd(rpc.readContract({address: a, abi: LiveBidAdapterAbi, functionName: 'nextSweepBlock'}) as Promise<bigint>),
            rd(rpc.readContract({address: a, abi: LiveBidAdapterAbi, functionName: 'maxSweepWei'}) as Promise<bigint>),
            rd(rpc.readContract({address: a, abi: LiveBidAdapterAbi, functionName: 'minBlocksBetweenSweeps'}) as Promise<bigint>),
        ]);
        const canSweep = isReady('liveBidAdapter.sweep');
        stations.push({
            key: 'liveBidAdapter',
            label: 'LiveBidAdapter',
            role: 'Buffers every bid-bound inflow and meters it into the live bid via sweep().',
            address: a,
            present: true,
            currentLabel: 'Buffered',
            currentValue: eth(buffer),
            totalLabel: 'Forwarded to bid',
            totalValue: eth(totals.adapterForwarded),
            ready: {label: canSweep ? 'Sweep ready' : 'Sweep on cooldown', ok: canSweep},
            rows: [
                {k: 'Activation threshold', v: eth(threshold)},
                {k: 'Max sweep / forward', v: eth(maxSweep)},
                {k: 'Min blocks between', v: minBlocks?.toString() ?? '—'},
                {k: 'Last sweep block', v: lastSweep?.toString() ?? '—'},
                {k: 'Next sweep block', v: nextSweep?.toString() ?? '—'},
            ],
            keeper: {
                hint: 'sweep() meters the buffered ETH into the live bid. Pays the caller a small keeper reward. Throttled above the activation threshold.',
                actions: actionsByPrefix('liveBidAdapter.sweep'),
            },
        });
    } else {
        stations.push(missingStation('liveBidAdapter', 'LiveBidAdapter', 'Buffers bid-bound inflow and meters it into the live bid.'));
    }

    // 4. Patron — the live bid.
    if (isSet(addrs.patron)) {
        const p = addrs.patron;
        const [accounted, raw] = await Promise.all([
            rd(rpc.readContract({address: p, abi: PatronAbi, functionName: 'accountedLiveBidWei'}) as Promise<bigint>),
            rd(rpc.getBalance({address: p})),
        ]);
        const surplus = accounted !== undefined && raw !== undefined ? raw - accounted : undefined;
        stations.push({
            key: 'patron',
            label: 'Patron (live bid)',
            role: 'Holds the standing ETH bid that acquires Punks. Spends only via acceptBid / acceptListing.',
            address: p,
            present: true,
            currentLabel: 'Live bid',
            currentValue: eth(accounted),
            totalLabel: 'Spent acquiring',
            totalValue: eth(totals.patronSpent),
            ready: null,
            rows: [
                {k: 'Raw balance', v: eth(raw)},
                {k: 'Unaccounted surplus', v: eth(surplus)},
            ],
            // Spent only by user-initiated acceptBid / acceptListing — not a
            // keeper-pumped step.
            keeper: null,
        });
    } else {
        stations.push(missingStation('patron', 'Patron (live bid)', 'Holds the standing ETH bid.'));
    }

    // 5. ProtocolFeePhaseAdapter — protocol leg, pending in escrow.
    if (isSet(addrs.protocolFeePhaseAdapter)) {
        const a = addrs.protocolFeePhaseAdapter;
        const [raw, pending] = await Promise.all([
            rd(rpc.getBalance({address: a})),
            escrow
                ? rd(rpc.readContract({address: escrow, abi: escrowAbi, functionName: 'availableFees', args: [a, ZERO]}) as Promise<bigint>)
                : Promise.resolve(undefined),
        ]);
        if (escrow && pending === undefined) notes.push('Could not read protocol-leg pending from the fee escrow.');
        const canSweepProtocol = isReady('protocolFeeAdapter.sweep');
        stations.push({
            key: 'protocolFeeAdapter',
            label: 'ProtocolFeePhaseAdapter',
            role: 'Receives the protocol leg into the fee escrow, then sweeps it to the controller.',
            address: a,
            present: true,
            currentLabel: 'Pending in escrow',
            currentValue: eth(pending),
            totalLabel: 'Forwarded to controller',
            totalValue: eth(totals.protocolForwarded),
            ready: {label: canSweepProtocol ? 'Sweep ready' : 'Nothing to sweep', ok: canSweepProtocol},
            rows: [
                {k: 'Raw balance', v: eth(raw)},
                {k: 'Fee escrow', v: escrow ? shortAddress(escrow) : '—'},
                {k: 'Controller', v: controller ? shortAddress(controller) : '—'},
            ],
            keeper: {
                hint: 'sweep() claims the protocol leg from the fee escrow and forwards it to the controller. Permissionless, no reward, no cooldown.',
                actions: actionsByPrefix('protocolFeeAdapter.sweep'),
            },
        });
    } else {
        stations.push(missingStation('protocolFeeAdapter', 'ProtocolFeePhaseAdapter', 'Receives the protocol leg, sweeps to the controller.'));
    }

    // 6. PCController — treasury / LAYER-burn split (artcoins contract). Held
    //    ETH only splits when processNativeFees() is poked, so it IS a keeper
    //    step; we read the real split off-chain and discover the BurnRouter for
    //    the next station.
    let burnRouter: Address | undefined;
    if (controller && isSet(controller)) {
        const c = controller;
        const [cBal, tBps, bBps, treasury, br] = await Promise.all([
            rd(rpc.getBalance({address: c})),
            rd(rpc.readContract({address: c, abi: controllerAbi, functionName: 'treasuryBps'}) as Promise<number>),
            rd(rpc.readContract({address: c, abi: controllerAbi, functionName: 'burnBps'}) as Promise<number>),
            rd(rpc.readContract({address: c, abi: controllerAbi, functionName: 'treasury'}) as Promise<Address>),
            rd(rpc.readContract({address: c, abi: controllerAbi, functionName: 'burnRouter'}) as Promise<Address>),
        ]);
        burnRouter = br && isSet(br) ? br : undefined;
        const canSplit = isReady('pcController.processNativeFees');
        const pct = (bps: number | undefined) => (bps === undefined ? '—' : `${(Number(bps) / 100).toFixed(2)}%`);
        stations.push({
            key: 'pcController',
            label: 'PCController',
            role: 'Splits the protocol leg to the PC treasury and the LAYER buy-and-burn router. Held ETH splits only when processNativeFees() is called.',
            address: c,
            present: true,
            currentLabel: 'Balance (unsplit)',
            currentValue: eth(cBal),
            totalLabel: 'Received',
            totalValue: eth(totals.protocolForwarded),
            ready: {label: canSplit ? 'Split ready' : 'Nothing to split', ok: canSplit},
            rows: [
                {k: 'Treasury share', v: pct(tBps)},
                {k: 'LAYER burn share', v: pct(bBps)},
                {k: 'Total to team (lifetime)', v: eth(totals.teamTotal)},
                {k: 'Total → LAYER burn (lifetime)', v: eth(totals.layerBurnTotal)},
                {k: 'Treasury', v: treasury && isSet(treasury) ? shortAddress(treasury) : '—'},
                {k: 'BurnRouter', v: burnRouter ? shortAddress(burnRouter) : '—'},
            ],
            keeper: {
                hint: 'processNativeFees() splits the held ETH: treasury share → treasury (kept as ETH), burn share → the LAYER BurnRouter. Permissionless, no keeper reward. Artcoins-side.',
                actions: actionsByPrefix('pcController.processNativeFees'),
            },
        });
    } else {
        stations.push(missingStation('pcController', 'PCController', 'Splits the protocol leg treasury / LAYER-burn.'));
    }

    // 7. LAYER BurnRouter — the protocol leg's terminal buy-and-burn. Burns
    //    LAYER (the artcoins platform token), NOT $111. Discovered from the
    //    controller; only shown when wired.
    if (burnRouter) {
        const r = burnRouter;
        const [rBal, layer, weth, minThresh] = await Promise.all([
            rd(rpc.getBalance({address: r})),
            rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'layerToken'}) as Promise<Address>),
            rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'weth'}) as Promise<Address>),
            rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'minProcessThreshold'}) as Promise<bigint>),
        ]);
        const heldWeth =
            weth && isSet(weth)
                ? await rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'heldBalance', args: [weth]}) as Promise<bigint>)
                : undefined;
        const heldLayer =
            layer && isSet(layer)
                ? await rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'heldBalance', args: [layer]}) as Promise<bigint>)
                : undefined;
        // processBurnWeth wraps native ETH on entry, so burnable = native + held WETH.
        const burnable = (rBal ?? 0n) + (heldWeth ?? 0n);
        const canBurn = isReady('burnRouter.processBurnWeth');
        stations.push({
            key: 'burnRouter',
            label: 'LAYER BurnRouter',
            role: 'Terminal of the protocol-fee leg: wraps held ETH → WETH, swaps WETH → LAYER, and burns it. Burns LAYER (the artcoins platform token) — NOT $111.',
            address: r,
            present: true,
            currentLabel: 'ETH + WETH held',
            currentValue: eth(burnable),
            totalLabel: 'LAYER burned',
            totalValue: '— (LAYER-side)',
            ready: {label: canBurn ? 'Burn ready' : 'Below threshold', ok: canBurn},
            rows: [
                {k: 'Native ETH', v: eth(rBal)},
                {k: 'Held WETH', v: eth(heldWeth)},
                {k: 'Held LAYER', v: heldLayer === undefined ? '—' : ethBare(heldLayer, 2)},
                {k: 'Min threshold', v: eth(minThresh)},
                {k: 'LAYER token', v: layer && isSet(layer) ? shortAddress(layer) : '—'},
            ],
            keeper: {
                hint: 'processBurnWeth(minLayerOut) wraps ETH→WETH, swaps to LAYER and burns it. Pays the caller 0.5% (≤0.01 ETH). The live router enforces its floor on-chain (internal spot floor + ~1% swap-impact cap), so minLayerOut is sent as 0.',
                actions: actionsByPrefix('burnRouter'),
            },
        });
    }

    // 7. ReferralPayout — per-referrer ledger.
    stations.push({
        key: 'referralPayout',
        label: 'ReferralPayout',
        role: 'Pull-based per-referrer ledger. Credited from the protocol leg when a swap carries a referrer.',
        address: isSet(addrs.referralPayout) ? addrs.referralPayout! : null,
        present: isSet(addrs.referralPayout),
        currentLabel: 'Unclaimed',
        currentValue: eth(isSet(addrs.referralPayout) ? await rd(rpc.getBalance({address: addrs.referralPayout!})) : undefined),
        totalLabel: 'Credited',
        totalValue: eth(totals.referralCredited),
        ready: null,
        rows: [{k: 'Total claimed', v: eth(totals.referralClaimed)}],
        // Pull-based: each referrer claims their own credited balance. Not a
        // keeper-pumped pipeline step (see the /referrals page).
        keeper: null,
    });

    // 8. ReturnAuctionModule — auction settlement splits.
    if (isSet(addrs.returnAuctionModule)) {
        const m = addrs.returnAuctionModule;
        const [raw, escrowAddr] = await Promise.all([
            rd(rpc.getBalance({address: m})),
            rd(rpc.readContract({address: m, abi: ReturnAuctionModuleAbi, functionName: 'escrow'}) as Promise<Address>),
        ]);
        const settleCount = settleablePunks.length;
        stations.push({
            key: 'returnAuction',
            label: 'ReturnAuctionModule',
            role: 'On a cleared settle, splits cost 65% live bid / 25% buy-and-burn / 10% vault-burn (+ premium). On silence, vaults the Punk.',
            address: m,
            present: true,
            currentLabel: 'Held',
            currentValue: eth(raw),
            totalLabel: 'Settled (high bids)',
            totalValue: eth(totals.auctionSettled),
            ready: {
                label:
                    settleCount === 0
                        ? 'No auctions to settle'
                        : `${settleCount} ready to settle`,
                ok: settleCount > 0,
            },
            rows: [{k: 'Settlement escrow', v: escrowAddr ? shortAddress(escrowAddr) : '—'}],
            keeper: {
                hint: 'settle(punkId) finalizes an ended return auction — clearing to the bidder (proceeds split to the live bid / burner / vault-burn) or vaulting the Punk on silence. Anyone may call.',
                actions: actionsByPrefix('returnAuction.settle'),
            },
        });
    } else {
        stations.push(missingStation('returnAuction', 'ReturnAuctionModule', 'Splits settled-auction proceeds.'));
    }

    // 9. VaultBurnPool.
    if (isSet(addrs.vaultBurnPool)) {
        const v = addrs.vaultBurnPool;
        const bal = await rd(rpc.readContract({address: v, abi: VaultBurnPoolAbi, functionName: 'balance'}) as Promise<bigint>);
        stations.push({
            key: 'vaultBurnPool',
            label: 'VaultBurnPool',
            role: 'Accumulates the vault-burn slice from settled auctions; swept to the burner on each vault-path settle.',
            address: v,
            present: true,
            currentLabel: 'Balance',
            currentValue: eth(bal),
            totalLabel: 'Swept to burner',
            totalValue: eth(totals.vaultBurnSwept),
            ready: null,
            rows: [],
            // Drained only by ReturnAuctionModule during a vault-path settle —
            // no standalone keeper call (sweep() is module-only). Triggered via
            // the ReturnAuctionModule settle keeper above.
            keeper: null,
        });
    } else {
        stations.push(missingStation('vaultBurnPool', 'VaultBurnPool', 'Accumulates the vault-burn slice.'));
    }

    // 10. BuybackBurner — the swapper: buys $111 with queued ETH and burns it.
    if (isSet(addrs.buybackBurner)) {
        const b = addrs.buybackBurner;
        const [queued, totalEthBurned, totalTokensBurned, lastStep, nextStep, quote, maxStep, minBlocks] =
            await Promise.all([
                rd(rpc.readContract({address: b, abi: BuybackBurnerAbi, functionName: 'remainingEth'}) as Promise<bigint>),
                rd(rpc.readContract({address: b, abi: BuybackBurnerAbi, functionName: 'totalEthBurned'}) as Promise<bigint>),
                rd(rpc.readContract({address: b, abi: BuybackBurnerAbi, functionName: 'totalTokensBurned'}) as Promise<bigint>),
                rd(rpc.readContract({address: b, abi: BuybackBurnerAbi, functionName: 'lastStepBlock'}) as Promise<bigint>),
                rd(rpc.readContract({address: b, abi: BuybackBurnerAbi, functionName: 'nextExecutableBlock'}) as Promise<bigint>),
                rd(rpc.readContract({address: b, abi: BuybackBurnerAbi, functionName: 'quoteStepAmount'}) as Promise<bigint>),
                rd(rpc.readContract({address: b, abi: BuybackBurnerAbi, functionName: 'maxStepWei'}) as Promise<bigint>),
                rd(rpc.readContract({address: b, abi: BuybackBurnerAbi, functionName: 'minBlocksBetweenSteps'}) as Promise<bigint>),
            ]);
        const canStep = isReady('buybackBurner.executeStep');
        stations.push({
            key: 'buybackBurner',
            label: 'BuybackBurner (swapper)',
            role: 'Swaps queued ETH → $111 and burns it. Paced; permissionless executeStep().',
            address: b,
            present: true,
            currentLabel: 'Queued ETH',
            currentValue: eth(queued),
            totalLabel: 'ETH burned',
            totalValue: eth(totalEthBurned),
            ready: {label: canStep ? 'Step ready' : 'Step on cooldown', ok: canStep},
            rows: [
                {k: 'Total $111 burned', v: ethBare(totalTokensBurned, 2)},
                {k: 'Next step amount', v: eth(quote)},
                {k: 'Max step', v: eth(maxStep)},
                {k: 'Min blocks between', v: minBlocks?.toString() ?? '—'},
                {k: 'Last step block', v: lastStep?.toString() ?? '—'},
                {k: 'Next executable block', v: nextStep?.toString() ?? '—'},
            ],
            keeper: {
                hint: 'executeStep() swaps the next queued ETH slice → $111 and burns it. Paced by min-blocks-between-steps; the on-chain 5% price-impact cap bounds slippage, so minOut is sent as 0. Pays the caller a small reward.',
                actions: actionsByPrefix('buybackBurner.executeStep'),
            },
        });
    } else {
        stations.push(missingStation('buybackBurner', 'BuybackBurner (swapper)', 'Swaps queued ETH → $111 and burns it.'));
    }

    return stations;
}

function missingStation(key: string, label: string, role: string): DistroStation {
    return {
        key,
        label,
        role,
        address: null,
        present: false,
        currentLabel: '—',
        currentValue: 'not deployed',
        totalLabel: 'Total',
        totalValue: '—',
        ready: null,
        rows: [],
        keeper: null,
    };
}

async function collectEvents(
    rpc: Rpc,
    addrs: ReturnType<typeof getContractAddresses>,
    controller: Address | undefined,
    fromBlock: bigint,
    notes: string[],
): Promise<RawEvent[]> {
    const sources: Array<{label: string; address: Address | undefined; abi: unknown}> = [
        {label: 'Hook', address: addrs.artcoinsHook, abi: ArtCoinsHookSkimFeeAbi},
        {label: 'LiveBidAdapter', address: addrs.liveBidAdapter, abi: LiveBidAdapterAbi},
        {label: 'ProtocolFeeAdapter', address: addrs.protocolFeePhaseAdapter, abi: ProtocolFeePhaseAdapterAbi},
        {label: 'Patron', address: addrs.patron, abi: PatronAbi},
        {label: 'ReturnAuction', address: addrs.returnAuctionModule, abi: ReturnAuctionModuleAbi},
        {label: 'VaultBurnPool', address: addrs.vaultBurnPool, abi: VaultBurnPoolAbi},
        {label: 'BuybackBurner', address: addrs.buybackBurner, abi: BuybackBurnerAbi},
        {label: 'ReferralPayout', address: addrs.referralPayout, abi: ReferralPayoutAbi},
        // PCController is runtime-discovered (not in the static config), so it's
        // passed in. Its NativeFeesProcessed events are the team/LAYER-burn totals.
        {label: 'PCController', address: controller, abi: controllerAbi},
    ];

    const results = await Promise.allSettled(
        sources
            .filter((s) => isSet(s.address))
            .map(async (s) => {
                const logs = (await rpc.getContractEvents({
                    address: s.address!,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    abi: s.abi as any,
                    fromBlock,
                    toBlock: 'latest',
                })) as Array<{
                    eventName?: string;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    args?: any;
                    blockNumber?: bigint;
                    logIndex?: number;
                    transactionHash?: string;
                }>;
                return {label: s.label, logs};
            }),
    );

    const events: RawEvent[] = [];
    for (const r of results) {
        if (r.status === 'rejected') {
            notes.push('A history read failed (RPC may not support getLogs over this range).');
            continue;
        }
        for (const log of r.value.logs) {
            const name = log.eventName ?? '';
            if (!HISTORY_EVENTS.has(name)) continue;
            events.push({
                contract: r.value.label,
                name,
                args: log.args ?? {},
                block: log.blockNumber !== undefined ? Number(log.blockNumber) : 0,
                logIndex: log.logIndex ?? 0,
                txHash: log.transactionHash ?? null,
            });
        }
    }
    return events;
}
