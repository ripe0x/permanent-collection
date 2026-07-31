// pullorders.ts — PullStandingOrder crank evaluation for the keeper, alongside evaluatePullPoolTargets.
// Runs on the SAME process, wallet, and nonce stream; returns KeeperTarget[] in the shared shape, one
// per order whose crank() would buy this round. The shared sender simulates each before sending, so a
// stale-readiness revert (AlreadyBought, RoundCovered, …) costs no gas.
//
// A PullStandingOrder is a subscription: it holds one owner's ETH and buys their ticket into each
// PullPool round when someone calls its permissionless crank(). crank() pays the caller `crankFee`,
// but that fee is small (<= 0.01 ETH, typically ~0.0002) — below gas at any real base fee — so no MEV
// searcher runs it. Without a keeper the buy never happens: the order sits funded and its
// `lastRoundBought` never advances. This evaluator is that keeper.
//
// The predicates mirror PullStandingOrder.crank() (fwa-roll repo) exactly, so `actionable` matches
// what the on-chain crank would do. Only the factory address is configured; the pool is read from the
// factory's pool getter. A first-generation factory names it POOL(); the dual-pool factory that
// follows a migration names it pool(), and it answers with whichever generation its orders buy now.
import type {Address, PublicClient} from 'viem';

import type {KeeperTarget} from './targets';
import {roundTuple, roundTupleV2} from './pullpool';

const RoundState = {None: 0, Open: 1, Pulling: 2, Claimable: 3, Settled: 4, Refunding: 5} as const;
const UINT256_MAX = (1n << 256n) - 1n;

// Factory registry read: every order this factory deployed, in creation order.
const factoryAbi = [
    {type: 'function', name: 'POOL', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    {type: 'function', name: 'pool', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    {type: 'function', name: 'allOrders', stateMutability: 'view', inputs: [], outputs: [{type: 'address[]'}]},
] as const;

// The same reads against the newer getRound shape; only that one entry differs.
const poolReadAbiV2 = [
    {
        type: 'function',
        name: 'getRound',
        stateMutability: 'view',
        inputs: [{name: 'roundId', type: 'uint256'}],
        outputs: [roundTupleV2],
    },
] as const;

// Pool reads the crank consults: pause state, the current round id, that round's snapshot, its
// coverage need, and the live config the self-open path prices from.
const poolReadAbi = [
    {type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
    {type: 'function', name: 'roundCount', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    // Present only where several rounds may be open at once. Rounds pull out of id order, so the one
    // a buy lands in is the lowest still selling, which is not the newest.
    {type: 'function', name: 'currentOpenRound', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {
        type: 'function',
        name: 'getRound',
        stateMutability: 'view',
        inputs: [{name: 'roundId', type: 'uint256'}],
        outputs: [roundTuple],
    },
    {
        type: 'function',
        name: 'ticketsNeeded',
        stateMutability: 'view',
        inputs: [{name: 'roundId', type: 'uint256'}],
        outputs: [{type: 'uint256'}],
    },
    {
        type: 'function',
        name: 'config',
        stateMutability: 'view',
        inputs: [],
        outputs: [
            {name: 'ticketPrice', type: 'uint96'},
            {name: 'fundingDuration', type: 'uint64'},
            {name: 'headroomBps', type: 'uint16'},
            {name: 'feeCapBps', type: 'uint16'},
            {name: 'crankBountyCap', type: 'uint96'},
            {name: 'vrfAllowance', type: 'uint96'},
            {name: 'bountyTipWei', type: 'uint64'},
            {name: 'stallTimeout', type: 'uint64'},
            {name: 'maxTickets', type: 'uint32'},
        ],
    },
] as const;

// The one crank the sender calls per order. No args: the order names its own owner and quantity.
export const pullStandingOrderKeeperAbi = [
    {type: 'function', name: 'crank', stateMutability: 'nonpayable', inputs: [], outputs: []},
    {type: 'function', name: 'ticketsPerRound', stateMutability: 'view', inputs: [], outputs: [{type: 'uint32'}]},
    {type: 'function', name: 'crankFee', stateMutability: 'view', inputs: [], outputs: [{type: 'uint96'}]},
    {type: 'function', name: 'lastRoundBought', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
] as const;

const num = (v: unknown) => Number(v as bigint | number);
const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt((v as number | string) ?? 0));
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
// Bound the registry scan so an ever-growing factory can't make one pass unbounded. The newest
// MAX_ORDERS are the ones still cranking; old fully-withdrawn orders simulate to InsufficientBalance.
const MAX_ORDERS = Math.max(1, Number(process.env.KEEPER_PULLORDERS_MAX ?? '500'));

async function readAll(client: PublicClient, contracts: readonly unknown[]): Promise<unknown[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await client.multicall({contracts: contracts as any, allowFailure: true});
    return res.map((r) => (r.status === 'success' ? r.result : undefined));
}

type RoundTuple = Record<string, bigint | number | boolean>;

/** For each standing order the factory knows, decide whether crank() would buy this round and emit
 *  one KeeperTarget. Contract is 'pullStandingOrder' and address is the ORDER (not the pool), so the
 *  shared sender encodes crank() from KEEPER_ABIS.pullStandingOrder against each order in turn. */
export async function evaluatePullOrderTargets(
    client: PublicClient,
    factory: Address,
): Promise<KeeperTarget[]> {
    const [poolUpperRaw, poolLowerRaw, ordersRaw] = await readAll(client, [
        {address: factory, abi: factoryAbi, functionName: 'POOL'},
        {address: factory, abi: factoryAbi, functionName: 'pool'},
        {address: factory, abi: factoryAbi, functionName: 'allOrders'},
    ]);
    // Only one of the two exists on any given factory; the other read comes back undefined.
    const pool = (poolLowerRaw ?? poolUpperRaw) as Address | undefined;
    const allOrders = (ordersRaw as Address[] | undefined) ?? [];
    if (!pool || allOrders.length === 0) return [];
    // Newest first, bounded: the tail of the registry is where active orders live.
    const orders = allOrders.slice(-MAX_ORDERS).reverse();

    const poolBase = {address: pool, abi: poolReadAbi} as const;
    const [pausedRaw, roundCountRaw, configRaw, currentOpenRaw] = await readAll(client, [
        {...poolBase, functionName: 'paused'},
        {...poolBase, functionName: 'roundCount'},
        {...poolBase, functionName: 'config'},
        {...poolBase, functionName: 'currentOpenRound'},
    ]);
    // Paused pool: crank reverts PoolPaused for every order. Nothing to emit.
    if (pausedRaw === true) return [];
    const roundCount = (roundCountRaw as bigint | undefined) ?? 0n;
    // Where the pool tracks an open window, the buy lands in the lowest round still selling; zero
    // there means nothing in the window can sell and the next buy opens one. A pool without the
    // getter runs one round at a time, so the newest is the only candidate.
    const currentOpen = (currentOpenRaw as bigint | undefined) ?? 0n;
    const targetRound = currentOpen !== 0n ? currentOpen : roundCount;
    const config = configRaw as readonly unknown[] | undefined;
    const configPrice = config ? big(config[0]) : 0n;
    const configMaxTickets = config ? big(config[8]) : 0n;

    // The current round is the crank's target when Open; read its snapshot + coverage need once.
    let round: RoundTuple | undefined;
    let needed: bigint | undefined;
    if (targetRound !== 0n) {
        // getRound's struct differs by generation, and the wrong shape decodes plausible numbers out
        // of the wrong slots rather than failing. Read both and keep whichever returns a round.
        const [roundV2Res, roundV1Res, neededRes] = await readAll(client, [
            {address: pool, abi: poolReadAbiV2, functionName: 'getRound', args: [targetRound]},
            {...poolBase, functionName: 'getRound', args: [targetRound]},
            {...poolBase, functionName: 'ticketsNeeded', args: [targetRound]},
        ]);
        round = (roundV2Res ?? roundV1Res) as RoundTuple | undefined;
        needed = neededRes as bigint | undefined;
    }
    const roundOpen = !!round && num(round.state) === RoundState.Open;

    // Per-order state: quantity, fee, last round, and ETH balance (the balance gate).
    const orderBase = (o: Address) => ({address: o, abi: pullStandingOrderKeeperAbi}) as const;
    // viem decodes uint32 (ticketsPerRound) as number and uint96/uint256 as bigint; normalize below.
    const orderState = (await readAll(
        client,
        orders.flatMap((o) => [
            {...orderBase(o), functionName: 'ticketsPerRound'},
            {...orderBase(o), functionName: 'crankFee'},
            {...orderBase(o), functionName: 'lastRoundBought'},
        ]),
    )) as (bigint | number | undefined)[];
    const balances = await Promise.all(orders.map((o) => client.getBalance({address: o}).catch(() => 0n)));

    const ts = nowSec();
    const targets: KeeperTarget[] = [];

    for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        const ticketsPerRoundRaw = orderState[i * 3];
        const crankFeeRaw = orderState[i * 3 + 1];
        const lastRoundBoughtRaw = orderState[i * 3 + 2];
        const balance = balances[i];
        if (ticketsPerRoundRaw === undefined || crankFeeRaw === undefined || lastRoundBoughtRaw === undefined) {
            continue; // order read failed; skip rather than guess
        }
        const crankFee = big(crankFeeRaw);
        const lastRoundBought = big(lastRoundBoughtRaw);

        let quantity = big(ticketsPerRoundRaw);
        let price: bigint;
        let reason: string;
        let actionable = false;

        if (roundOpen && round) {
            price = big(round.ticketPrice);
            if (targetRound === lastRoundBought) {
                reason = `round #${targetRound} already bought`;
            } else if (ts > big(round.fundingDeadline)) {
                reason = `round #${targetRound} funding deadline passed`;
            } else if (needed === undefined || needed === UINT256_MAX) {
                reason = `round #${targetRound} FWA not pricing`;
            } else if (needed === 0n) {
                reason = `round #${targetRound} already covered`;
            } else {
                if (needed < quantity) quantity = needed;
                const capacity = big(round.maxTickets) - big(round.ticketsSold);
                if (capacity === 0n) {
                    reason = `round #${targetRound} ticket cap full`;
                } else {
                    if (capacity < quantity) quantity = capacity;
                    actionable = true;
                    reason = `round #${targetRound} needs ${needed}, buying ${quantity}`;
                }
            }
        } else {
            // No open round: crank self-opens one, priced from live config.
            price = configPrice;
            if (configMaxTickets === 0n) {
                reason = 'config ticket cap is zero';
            } else {
                if (configMaxTickets < quantity) quantity = configMaxTickets;
                actionable = true;
                reason = `no open round, self-opening and buying ${quantity}`;
            }
        }

        // Balance gate mirrors crank(): must cover the buy plus the fee.
        if (actionable) {
            const costPlusFee = quantity * price + crankFee;
            if (balance < costPlusFee) {
                actionable = false;
                reason = 'balance below buy + crank fee';
            }
        }

        targets.push({
            key: `pullStandingOrder.crank.${order.toLowerCase()}`,
            contract: 'pullStandingOrder',
            address: order,
            functionName: 'crank',
            args: [],
            label: `standing order crank ${order.slice(0, 10)}…`,
            actionable,
            reason,
            // crank() refunds the caller `crankFee`, but it is too small to draw a searcher, so this
            // is a must-run-ourselves call, not a contested bounty.
            reward: false,
        });
    }

    return targets;
}
