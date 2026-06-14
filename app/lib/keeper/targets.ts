/* Shared readiness logic for the permissionless value-distribution keeper.
 *
 * This is the SINGLE source of truth for "which keeper call is actionable
 * right now, and with what args". Two consumers import it:
 *   - the /debug/distribution dashboard (app/lib/server/distribution.ts), for
 *     the per-station `actionable` chips + execute buttons, and
 *   - the standalone bot (scripts/keeper.ts), which sends the actionable calls.
 * Keeping the predicates here means the dashboard and the bot can never drift.
 *
 * Deliberately framework-free: no next/server imports, no config import (the
 * caller passes the resolved addresses). ABIs are imported by RELATIVE path
 * (not the `@/` alias) so a bare `tsx` run of the keeper script resolves them
 * the same way Next.js does. viem is isomorphic, so this runs in an RSC, a
 * client island, or a Node script unchanged. */

import {erc20Abi, type Address} from 'viem';

import {abi as BuybackBurnerAbi} from '../abis/BuybackBurner';
import {abi as LiveBidAdapterAbi} from '../abis/LiveBidAdapter';
import {abi as PermanentCollectionAbi} from '../abis/PermanentCollection';
import {abi as ProtocolFeePhaseAdapterAbi} from '../abis/ProtocolFeePhaseAdapter';
import {abi as ReturnAuctionModuleAbi} from '../abis/ReturnAuctionModule';

const ZERO = '0x0000000000000000000000000000000000000000';

// ── inline ABIs for the contracts not in the generated set ─────────────────
// The artcoins-side fee tail (controller → burn router) and the LP-fee swapper
// aren't part of PC's ABI bundle, so the minimal read+write surface the keeper
// touches is inlined here (mirrors app/lib/server/distribution.ts).

/** Artcoins fee escrow — `availableFees(owner, token)` for the protocol leg's
 *  pending balance and the swapper's claimable artcoin. */
const escrowAbi = [
    {
        type: 'function',
        name: 'availableFees',
        stateMutability: 'view',
        inputs: [{type: 'address'}, {type: 'address'}],
        outputs: [{type: 'uint256'}],
    },
] as const;

/** Artcoins `ProtocolFeeController` (PCController). `processNativeFees()` is the
 *  permissionless split; `burnRouter()` discovers the next station. */
const controllerAbi = [
    {type: 'function', name: 'processNativeFees', stateMutability: 'nonpayable', inputs: [], outputs: []},
    {type: 'function', name: 'burnRouter', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
] as const;

/** Artcoins LAYER `BurnRouter`. `processBurnWeth(minOut)` / `processBurnLayer()`
 *  are the permissionless burns; the rest size the call. The live router is the
 *  impact-cap shape (internal spot floor + ~1% swap-impact clamp, no
 *  `minLayerOutPerWeth` view), so it accepts `minOut = 0`. The code still
 *  defensively supports an older linear-floor router: when `minLayerOutPerWeth`
 *  is present and > 0, `minOut` is computed against it; when that view reverts
 *  or is absent (the live router) `minOut` resolves to 0. Auto-detects either way. */
const burnRouterAbi = [
    {
        type: 'function',
        name: 'processBurnWeth',
        stateMutability: 'nonpayable',
        inputs: [{type: 'uint256'}],
        outputs: [{type: 'uint256'}, {type: 'uint256'}],
    },
    {type: 'function', name: 'processBurnLayer', stateMutability: 'nonpayable', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'weth', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    {type: 'function', name: 'layerToken', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
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

/** Artcoins `FeeAutoSwapper` — converts the locker's LP-fee artcoin to ETH and
 *  forwards it to the live-bid adapter (`endRecipient`). `convert(minOut)`
 *  self-claims from the escrow, paces on a cooldown, and enforces its own
 *  spot-derived output floor, so `minOut = 0` is safe. */
const feeAutoSwapperAbi = [
    {
        type: 'function',
        name: 'convert',
        stateMutability: 'nonpayable',
        inputs: [{type: 'uint256'}],
        outputs: [{type: 'uint256'}],
    },
    {type: 'function', name: 'lastConvertBlock', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'minBlocksBetweenConverts', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'feeLocker', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    {type: 'function', name: 'artCoin', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
] as const;

/** Contract → ABI for ENCODING the keeper write. Exported so every sender (the
 *  dashboard's KeeperPanel and scripts/keeper.ts) encodes from one definition. */
export const KEEPER_ABIS = {
    LiveBidAdapter: LiveBidAdapterAbi,
    ProtocolFeePhaseAdapter: ProtocolFeePhaseAdapterAbi,
    BuybackBurner: BuybackBurnerAbi,
    ReturnAuctionModule: ReturnAuctionModuleAbi,
    ProtocolFeeController: controllerAbi,
    BurnRouter: burnRouterAbi,
    FeeAutoSwapper: feeAutoSwapperAbi,
} as const;

export type KeeperContract = keyof typeof KEEPER_ABIS;

/** One permissionless keeper call. `args` are decimal strings so no bigint has
 *  to cross the RSC boundary; senders `BigInt()` them back (viem accepts a
 *  bigint for uint16/uint256 alike). */
export interface KeeperTarget {
    /** Stable id, e.g. `liveBidAdapter.sweep` or `returnAuction.settle.42`. */
    key: string;
    contract: KeeperContract;
    address: Address;
    functionName: string;
    args: string[];
    label: string;
    /** True when the call has something to do right now (off cooldown, buffer
     *  non-empty, auction ended, …). A non-actionable target still renders. */
    actionable: boolean;
    /** Human-readable reason, for the dashboard chip and the bot's log. */
    reason: string;
    /** Pays the caller a keeper reward (≈0.5%, ≤0.01 ETH). The reward-free
     *  calls are the ones we most want to run ourselves — no third party is
     *  paid to. */
    reward: boolean;
}

/** Addresses the evaluator needs. A superset of the dashboard's config and the
 *  keeper's deployments.json; every field optional so a partial deploy (or the
 *  dashboard's config, which omits `feeAutoSwapper`) just skips those targets. */
export interface KeeperAddresses {
    permanentCollection?: Address;
    liveBidAdapter?: Address;
    protocolFeePhaseAdapter?: Address;
    buybackBurner?: Address;
    returnAuctionModule?: Address;
    feeAutoSwapper?: Address;
    token?: Address;
}

/** Optional pre-fetched values so the dashboard (which already discovers these
 *  and scans auction history for its own panels) doesn't make the evaluator
 *  repeat the expensive work. The keeper passes none → the evaluator discovers
 *  and scans itself. */
export interface EvaluateOptions {
    currentBlock: bigint;
    escrow?: Address;
    controller?: Address;
    burnRouter?: Address;
    /** Settleable punkIds. If omitted, derived from `ReturnAuctionStarted`
     *  history confirmed via `isSettleable`. */
    settleablePunks?: number[];
    /** Lower bound for the auction-history scan. Defaults to
     *  `PermanentCollection.deployedAtBlock`. */
    fromBlock?: bigint;
}

/** Minimal viem-client surface the evaluator uses — satisfied structurally by
 *  any viem PublicClient (dashboard) or the keeper script's client. */
export interface KeeperRpc {
    getBalance(args: {address: Address}): Promise<bigint>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getContractEvents(args: any): Promise<any[]>;
}

function isSet(a: Address | undefined | null): a is Address {
    return !!a && a.toLowerCase() !== ZERO;
}

async function rd<T>(p: Promise<T>): Promise<T | undefined> {
    try {
        return await p;
    } catch {
        return undefined;
    }
}

const big = (x: unknown): bigint => (typeof x === 'bigint' ? x : 0n);

/** Discover the artcoins fee tail from the protocol-leg adapter:
 *  adapter → feeEscrow + controller, controller → burnRouter. Each is filled in
 *  only if the caller didn't already pass it. */
async function discover(
    rpc: KeeperRpc,
    addrs: KeeperAddresses,
    opts: EvaluateOptions,
): Promise<{escrow?: Address; controller?: Address; burnRouter?: Address}> {
    let escrow = opts.escrow;
    let controller = opts.controller;
    let burnRouter = opts.burnRouter;

    if (isSet(addrs.protocolFeePhaseAdapter) && (!escrow || !controller)) {
        const a = addrs.protocolFeePhaseAdapter;
        if (!escrow) {
            escrow = (await rd(
                rpc.readContract({address: a, abi: ProtocolFeePhaseAdapterAbi, functionName: 'feeEscrow'}),
            )) as Address | undefined;
        }
        if (!controller) {
            controller = (await rd(
                rpc.readContract({address: a, abi: ProtocolFeePhaseAdapterAbi, functionName: 'controller'}),
            )) as Address | undefined;
        }
    }
    if (!burnRouter && isSet(controller)) {
        burnRouter = (await rd(
            rpc.readContract({address: controller, abi: controllerAbi, functionName: 'burnRouter'}),
        )) as Address | undefined;
    }
    return {escrow, controller, burnRouter};
}

/** Return-auction punkIds past their deadline and not yet settled. Pulls the
 *  candidate set from `ReturnAuctionStarted` history (never scans all 10k ids),
 *  then confirms each via the on-chain `isSettleable` view so re-auctions and
 *  already-settled sales resolve correctly. Mirrors distribution.ts. */
async function findSettleablePunks(
    rpc: KeeperRpc,
    module: Address,
    fromBlock: bigint,
): Promise<number[]> {
    const logs = await rd(
        rpc.getContractEvents({
            address: module,
            abi: ReturnAuctionModuleAbi,
            eventName: 'ReturnAuctionStarted',
            fromBlock,
            toBlock: 'latest',
        }),
    );
    if (!logs) return [];
    const ids = new Set<number>();
    for (const log of logs) ids.add(Number(big(log?.args?.punkId)));
    if (ids.size === 0) return [];
    const list = [...ids];
    const checks = await Promise.all(
        list.map((id) =>
            rd(rpc.readContract({address: module, abi: ReturnAuctionModuleAbi, functionName: 'isSettleable', args: [id]})),
        ),
    );
    return list.filter((_, i) => checks[i] === true).sort((a, b) => a - b);
}

/** Evaluate every permissionless distribution hop and return one target per
 *  actionable-or-not call. Reward-free hops (protocol sweep, controller split)
 *  are the must-run-ourselves ones; the rest attract third-party keepers but we
 *  run them too. */
export async function evaluateKeeperTargets(
    rpc: KeeperRpc,
    addrs: KeeperAddresses,
    opts: EvaluateOptions,
): Promise<KeeperTarget[]> {
    const {currentBlock} = opts;
    const targets: KeeperTarget[] = [];

    const {escrow, controller, burnRouter} = await discover(rpc, addrs, opts);

    // 1. LiveBidAdapter.sweep() — meter buffered ETH into the live bid.
    if (isSet(addrs.liveBidAdapter)) {
        const a = addrs.liveBidAdapter;
        const [buffer, nextSweep] = await Promise.all([
            rd(rpc.readContract({address: a, abi: LiveBidAdapterAbi, functionName: 'bufferedEth'})) as Promise<bigint | undefined>,
            rd(rpc.readContract({address: a, abi: LiveBidAdapterAbi, functionName: 'nextSweepBlock'})) as Promise<bigint | undefined>,
        ]);
        const offCooldown = nextSweep !== undefined && currentBlock >= nextSweep;
        const hasBuffer = buffer !== undefined && buffer > 0n;
        targets.push({
            key: 'liveBidAdapter.sweep',
            contract: 'LiveBidAdapter',
            address: a,
            functionName: 'sweep',
            args: [],
            label: 'Sweep → live bid',
            actionable: hasBuffer && offCooldown,
            reason: !hasBuffer ? 'buffer empty' : !offCooldown ? `cooldown until block ${nextSweep}` : 'buffered ETH ready to meter',
            reward: true,
        });
    }

    // 2. ProtocolFeePhaseAdapter.sweep() — claim the protocol leg from escrow,
    //    forward to the controller. No reward, we're the beneficiary → must-run.
    if (isSet(addrs.protocolFeePhaseAdapter)) {
        const a = addrs.protocolFeePhaseAdapter;
        const [raw, pending] = await Promise.all([
            rd(rpc.getBalance({address: a})),
            isSet(escrow)
                ? (rd(rpc.readContract({address: escrow, abi: escrowAbi, functionName: 'availableFees', args: [a, ZERO]})) as Promise<bigint | undefined>)
                : Promise.resolve(undefined),
        ]);
        const has = (pending !== undefined && pending > 0n) || (raw !== undefined && raw > 0n);
        targets.push({
            key: 'protocolFeeAdapter.sweep',
            contract: 'ProtocolFeePhaseAdapter',
            address: a,
            functionName: 'sweep',
            args: [],
            label: 'Sweep → controller',
            actionable: has,
            reason: has ? 'protocol leg pending' : 'nothing pending',
            reward: false,
        });
    }

    // 3. PCController.processNativeFees() — split the protocol leg to treasury +
    //    LAYER burn. Reverts NothingToProcess on zero balance. No reward.
    if (isSet(controller)) {
        const bal = await rd(rpc.getBalance({address: controller}));
        const has = bal !== undefined && bal > 0n;
        targets.push({
            key: 'pcController.processNativeFees',
            contract: 'ProtocolFeeController',
            address: controller,
            functionName: 'processNativeFees',
            args: [],
            label: 'Split → treasury + burn',
            actionable: has,
            reason: has ? 'unsplit balance held' : 'nothing to split',
            reward: false,
        });
    }

    // 4. BurnRouter.processBurnWeth(minOut) — wrap ETH→WETH, buy & burn LAYER.
    if (isSet(burnRouter)) {
        const r = burnRouter;
        const [rBal, weth, minThresh, perWeth, layer] = await Promise.all([
            rd(rpc.getBalance({address: r})),
            rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'weth'})) as Promise<Address | undefined>,
            rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'minProcessThreshold'})) as Promise<bigint | undefined>,
            rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'minLayerOutPerWeth'})) as Promise<bigint | undefined>,
            rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'layerToken'})) as Promise<Address | undefined>,
        ]);
        const heldWeth = isSet(weth)
            ? ((await rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'heldBalance', args: [weth]}))) as bigint | undefined)
            : undefined;
        const heldLayer = isSet(layer)
            ? ((await rd(rpc.readContract({address: r, abi: burnRouterAbi, functionName: 'heldBalance', args: [layer]}))) as bigint | undefined)
            : undefined;
        // processBurnWeth wraps native ETH on entry, so burnable = native + held WETH.
        const burnable = (rBal ?? 0n) + (heldWeth ?? 0n);
        const canBurn = minThresh !== undefined && burnable >= minThresh && burnable > 0n;
        // minOut: the live router enforces its floor internally (spot floor +
        // swap-impact cap) and exposes no `minLayerOutPerWeth`, so perWeth reads
        // as absent and minOut resolves to 0 (correct for it). Defensive
        // back-compat for an older linear-floor router: when minLayerOutPerWeth
        // is present and > 0 it enforces a floor on the POST-wrap balance
        // (`burnable`) and reverts below it, so minOut is computed as
        // burnable × perWeth / 1e18 instead.
        const minOut = perWeth && perWeth > 0n ? (burnable * perWeth) / 10n ** 18n : 0n;
        targets.push({
            key: 'burnRouter.processBurnWeth',
            contract: 'BurnRouter',
            address: r,
            functionName: 'processBurnWeth',
            args: [minOut.toString()],
            label: 'Buy & burn LAYER',
            actionable: canBurn,
            reason: canBurn ? 'ETH+WETH over threshold' : 'below min threshold',
            reward: true,
        });
        if ((heldLayer ?? 0n) > 0n) {
            targets.push({
                key: 'burnRouter.processBurnLayer',
                contract: 'BurnRouter',
                address: r,
                functionName: 'processBurnLayer',
                args: [],
                label: 'Burn held LAYER',
                actionable: true,
                reason: 'held LAYER to burn',
                reward: false,
            });
        }
    }

    // 5. BuybackBurner.executeStep(0) — swap a queued ETH slice → $111, burn it.
    //    The on-chain 5% impact cap bounds slippage, so minOut = 0.
    if (isSet(addrs.buybackBurner)) {
        const b = addrs.buybackBurner;
        const [queued, nextStep] = await Promise.all([
            rd(rpc.readContract({address: b, abi: BuybackBurnerAbi, functionName: 'remainingEth'})) as Promise<bigint | undefined>,
            rd(rpc.readContract({address: b, abi: BuybackBurnerAbi, functionName: 'nextExecutableBlock'})) as Promise<bigint | undefined>,
        ]);
        const offCooldown = nextStep !== undefined && currentBlock >= nextStep;
        const hasQueued = queued !== undefined && queued > 0n;
        targets.push({
            key: 'buybackBurner.executeStep',
            contract: 'BuybackBurner',
            address: b,
            functionName: 'executeStep',
            args: ['0'],
            label: 'Execute step (buy & burn $111)',
            actionable: hasQueued && offCooldown,
            reason: !hasQueued ? 'no queued ETH' : !offCooldown ? `cooldown until block ${nextStep}` : 'queued ETH ready to burn',
            reward: true,
        });
    }

    // 6. ReturnAuctionModule.settle(punkId) — one per ended-but-unsettled
    //    auction. Self-incentivized on the cleared path; mission-aligned on the
    //    silence/vault path.
    if (isSet(addrs.returnAuctionModule)) {
        const m = addrs.returnAuctionModule;
        let punks = opts.settleablePunks;
        if (punks === undefined) {
            let fromBlock = opts.fromBlock;
            if (fromBlock === undefined && isSet(addrs.permanentCollection)) {
                fromBlock = (await rd(
                    rpc.readContract({address: addrs.permanentCollection, abi: PermanentCollectionAbi, functionName: 'deployedAtBlock'}),
                )) as bigint | undefined;
            }
            punks = await findSettleablePunks(rpc, m, fromBlock ?? 0n);
        }
        for (const id of punks) {
            targets.push({
                key: `returnAuction.settle.${id}`,
                contract: 'ReturnAuctionModule',
                address: m,
                functionName: 'settle',
                args: [String(id)],
                label: `Settle #${id}`,
                actionable: true,
                reason: 'auction ended, ready to settle',
                reward: false,
            });
        }
    }

    // 7. FeeAutoSwapper.convert(0) — convert the locker's LP-fee artcoin to ETH
    //    and forward to the live-bid adapter. Self-claims from escrow, paced,
    //    own spot floor (minOut = 0 safe). Only present when the address is
    //    supplied (the dashboard config omits it; the keeper reads it from JSON).
    if (isSet(addrs.feeAutoSwapper)) {
        const f = addrs.feeAutoSwapper;
        const [lastConvert, minBlocks, feeLocker, artCoin] = await Promise.all([
            rd(rpc.readContract({address: f, abi: feeAutoSwapperAbi, functionName: 'lastConvertBlock'})) as Promise<bigint | undefined>,
            rd(rpc.readContract({address: f, abi: feeAutoSwapperAbi, functionName: 'minBlocksBetweenConverts'})) as Promise<bigint | undefined>,
            rd(rpc.readContract({address: f, abi: feeAutoSwapperAbi, functionName: 'feeLocker'})) as Promise<Address | undefined>,
            rd(rpc.readContract({address: f, abi: feeAutoSwapperAbi, functionName: 'artCoin'})) as Promise<Address | undefined>,
        ]);
        // Convertible artcoin = what it already holds + what it can claim from
        // the escrow (convert() pulls the escrowed share itself before swapping).
        const held = isSet(artCoin)
            ? ((await rd(rpc.readContract({address: artCoin, abi: erc20Abi, functionName: 'balanceOf', args: [f]}))) as bigint | undefined)
            : undefined;
        const escrowed = isSet(feeLocker) && isSet(artCoin)
            ? ((await rd(rpc.readContract({address: feeLocker, abi: escrowAbi, functionName: 'availableFees', args: [f, artCoin]}))) as bigint | undefined)
            : undefined;
        const convertible = (held ?? 0n) + (escrowed ?? 0n);
        const nextConvert = lastConvert !== undefined && minBlocks !== undefined ? lastConvert + minBlocks : undefined;
        const offCooldown = nextConvert !== undefined && currentBlock >= nextConvert;
        const hasFees = convertible > 0n;
        targets.push({
            key: 'feeAutoSwapper.convert',
            contract: 'FeeAutoSwapper',
            address: f,
            functionName: 'convert',
            args: ['0'],
            label: 'Convert LP fees → live bid',
            actionable: hasFees && offCooldown,
            reason: !hasFees ? 'no LP-fee artcoin to convert' : !offCooldown ? `cooldown until block ${nextConvert}` : 'LP-fee artcoin ready to convert',
            reward: false,
        });
    }

    return targets;
}
