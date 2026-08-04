// grouporders.ts — GroupPullStandingOrder crank evaluation for the keeper, alongside pullorders.ts.
// Runs on the SAME process, wallet, and nonce stream; returns KeeperTarget[] in the shared shape, one
// per order whose crank() would enter this round. The shared sender simulates each before sending, so
// a stale-readiness revert (AlreadyEntered, RoundCovered, …) costs no gas.
//
// A GroupPullStandingOrder is a subscription: it holds one owner's ETH and enters their tickets into
// each GroupPull ("packs") round when someone calls its permissionless crank(). crank() pays the
// caller `crankFee`, but that fee is small (<= 0.01 ETH) — below gas at any real base fee — so no MEV
// searcher runs it. Without a keeper the entry never happens. This evaluator is that keeper.
//
// The predicates mirror GroupPullStandingOrder.crank() (fwa-roll repo) exactly, so `actionable`
// matches what the on-chain crank would do. Only the factory address is configured; the group is read
// from the factory's GROUP() getter.
import type {Address, PublicClient} from 'viem';

import type {KeeperTarget} from './targets';

const UINT256_MAX = (1n << 256n) - 1n;

// Factory registry read: every order this factory deployed, and the group it targets.
const factoryAbi = [
    {type: 'function', name: 'GROUP', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    {type: 'function', name: 'allOrders', stateMutability: 'view', inputs: [], outputs: [{type: 'address[]'}]},
] as const;

// Group (GroupPull, via its IPacks surface) reads the crank consults: pause state, the live round,
// and that round's coverage need / pricing.
const groupReadAbi = [
    {type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
    {type: 'function', name: 'liveRound', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {
        type: 'function',
        name: 'ticketsNeeded',
        stateMutability: 'view',
        inputs: [{name: 'roundId', type: 'uint256'}],
        outputs: [{type: 'uint256'}],
    },
    {
        type: 'function',
        name: 'ticketCost',
        stateMutability: 'view',
        inputs: [{name: 'roundId', type: 'uint256'}],
        outputs: [{type: 'uint256'}],
    },
    {
        type: 'function',
        name: 'ticketCostFor',
        stateMutability: 'view',
        inputs: [
            {name: 'roundId', type: 'uint256'},
            {name: 'buyer', type: 'address'},
            {name: 'quantity', type: 'uint32'},
        ],
        outputs: [{type: 'uint256'}],
    },
] as const;

// The one crank the sender calls per order, plus the reads needed to evaluate it. No args to crank:
// the order names its own recipient and quantity.
export const groupPullStandingOrderKeeperAbi = [
    {type: 'function', name: 'crank', stateMutability: 'nonpayable', inputs: [], outputs: []},
    {type: 'function', name: 'recipient', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    {type: 'function', name: 'crankFee', stateMutability: 'view', inputs: [], outputs: [{type: 'uint96'}]},
    {type: 'function', name: 'ticketsPerRound', stateMutability: 'view', inputs: [], outputs: [{type: 'uint32'}]},
    {type: 'function', name: 'maxSpendPerRound', stateMutability: 'view', inputs: [], outputs: [{type: 'uint96'}]},
    {
        type: 'function',
        name: 'minSecondsBetweenBuys',
        stateMutability: 'view',
        inputs: [],
        outputs: [{type: 'uint64'}],
    },
    {type: 'function', name: 'lastRoundEntered', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'lastBuyAt', stateMutability: 'view', inputs: [], outputs: [{type: 'uint64'}]},
] as const;

const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt((v as number | string) ?? 0));
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
// Bound the registry scan so an ever-growing factory can't make one pass unbounded. The newest
// MAX_ORDERS are the ones still cranking; old fully-withdrawn orders simulate to InsufficientBalance.
const MAX_ORDERS = Math.max(1, Number(process.env.KEEPER_GROUPORDERS_MAX ?? '500'));

async function readAll(client: PublicClient, contracts: readonly unknown[]): Promise<unknown[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await client.multicall({contracts: contracts as any, allowFailure: true});
    return res.map((r) => (r.status === 'success' ? r.result : undefined));
}

/** For each standing order the factory knows, decide whether crank() would enter this round and emit
 *  one KeeperTarget. Contract is 'groupPullStandingOrder' and address is the ORDER (not the group), so
 *  the shared sender encodes crank() from KEEPER_ABIS.groupPullStandingOrder against each order. */
export async function evaluateGroupOrderTargets(
    client: PublicClient,
    factory: Address,
): Promise<KeeperTarget[]> {
    const [groupRaw, ordersRaw] = await readAll(client, [
        {address: factory, abi: factoryAbi, functionName: 'GROUP'},
        {address: factory, abi: factoryAbi, functionName: 'allOrders'},
    ]);
    const group = groupRaw as Address | undefined;
    const allOrders = (ordersRaw as Address[] | undefined) ?? [];
    if (!group || allOrders.length === 0) return [];
    // Newest first, bounded: the tail of the registry is where active orders live.
    const orders = allOrders.slice(-MAX_ORDERS).reverse();

    const groupBase = {address: group, abi: groupReadAbi} as const;
    const [pausedRaw, liveRoundRaw] = await readAll(client, [
        {...groupBase, functionName: 'paused'},
        {...groupBase, functionName: 'liveRound'},
    ]);
    // Paused group: crank reverts GroupPaused for every order. Nothing to emit.
    if (pausedRaw === true) return [];
    const liveRound = (liveRoundRaw as bigint | undefined) ?? 0n;

    // No live round: every order reverts NoLiveRound. Still worth reporting as non-actionable, same as
    // pullorders reports non-actionable reasons rather than omitting the row.
    let needed: bigint | undefined;
    let ticketCost: bigint | undefined;
    if (liveRound !== 0n) {
        const [neededRes, costRes] = await readAll(client, [
            {...groupBase, functionName: 'ticketsNeeded', args: [liveRound]},
            {...groupBase, functionName: 'ticketCost', args: [liveRound]},
        ]);
        needed = neededRes as bigint | undefined;
        ticketCost = costRes as bigint | undefined;
    }

    // Per-order state, batched.
    const orderBase = (o: Address) => ({address: o, abi: groupPullStandingOrderKeeperAbi}) as const;
    const orderState = (await readAll(
        client,
        orders.flatMap((o) => [
            {...orderBase(o), functionName: 'recipient'},
            {...orderBase(o), functionName: 'crankFee'},
            {...orderBase(o), functionName: 'ticketsPerRound'},
            {...orderBase(o), functionName: 'maxSpendPerRound'},
            {...orderBase(o), functionName: 'minSecondsBetweenBuys'},
            {...orderBase(o), functionName: 'lastRoundEntered'},
            {...orderBase(o), functionName: 'lastBuyAt'},
        ]),
    )) as (Address | bigint | number | undefined)[];
    const balances = await Promise.all(orders.map((o) => client.getBalance({address: o}).catch(() => 0n)));

    // ticketCostFor is per-order (buyer + quantity), so it can only be read after ticketsPerRound and
    // maxSpendPerRound clamp the quantity per order. Build a second batched pass, one call per order
    // that reaches this step; the rest short-circuit on an earlier predicate with no extra read.
    type Pending = {i: number; recipient: Address; quantity: bigint; cap: bigint};
    const pending: Pending[] = [];
    const skip = new Map<number, string>();
    const FIELDS = 7;
    const ts = nowSec();

    for (let i = 0; i < orders.length; i++) {
        const recipient = orderState[i * FIELDS] as Address | undefined;
        const crankFeeRaw = orderState[i * FIELDS + 1];
        const ticketsPerRoundRaw = orderState[i * FIELDS + 2];
        const maxSpendRaw = orderState[i * FIELDS + 3];
        const minSecondsRaw = orderState[i * FIELDS + 4];
        const lastRoundEnteredRaw = orderState[i * FIELDS + 5];
        const lastBuyAtRaw = orderState[i * FIELDS + 6];
        if (
            recipient === undefined ||
            crankFeeRaw === undefined ||
            ticketsPerRoundRaw === undefined ||
            maxSpendRaw === undefined ||
            minSecondsRaw === undefined ||
            lastRoundEnteredRaw === undefined ||
            lastBuyAtRaw === undefined
        ) {
            skip.set(i, 'order read failed');
            continue;
        }
        const minSeconds = big(minSecondsRaw);
        const lastBuyAt = big(lastBuyAtRaw);
        if (lastBuyAt !== 0n && ts < lastBuyAt + minSeconds) {
            skip.set(i, `pacing: next entry at ${lastBuyAt + minSeconds}`);
            continue;
        }
        if (liveRound === 0n) {
            skip.set(i, 'no live round');
            continue;
        }
        const lastRoundEntered = big(lastRoundEnteredRaw);
        if (liveRound === lastRoundEntered) {
            skip.set(i, `round #${liveRound} already entered`);
            continue;
        }
        if (needed === undefined || needed === UINT256_MAX) {
            skip.set(i, `round #${liveRound} FWA not pricing`);
            continue;
        }
        if (needed === 0n) {
            skip.set(i, `round #${liveRound} already covered`);
            continue;
        }
        let quantity = big(ticketsPerRoundRaw);
        if (needed < quantity) quantity = needed;
        const cap = big(maxSpendRaw);
        if (cap !== 0n) {
            if (ticketCost === undefined || ticketCost === 0n) {
                skip.set(i, `round #${liveRound} ticket cost unavailable`);
                continue;
            }
            const affordable = cap / ticketCost;
            if (affordable === 0n) {
                skip.set(i, 'spend cap below one ticket');
                continue;
            }
            if (affordable < quantity) quantity = affordable;
        }
        pending.push({i, recipient, quantity, cap});
    }

    const costResults = (await readAll(
        client,
        pending.map((p) => ({...groupBase, functionName: 'ticketCostFor', args: [liveRound, p.recipient, p.quantity]})),
    )) as (bigint | undefined)[];

    const targets: KeeperTarget[] = [];
    for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        const reasonSkip = skip.get(i);
        let actionable = false;
        let reason = reasonSkip ?? '';

        if (!reasonSkip) {
            const p = pending.find((x) => x.i === i)!;
            const idx = pending.indexOf(p);
            const cost = costResults[idx];
            const crankFee = big(orderState[i * FIELDS + 1]);
            const balance = balances[i];
            if (cost === undefined) {
                reason = 'ticketCostFor read failed';
            } else if (p.cap !== 0n && cost > p.cap) {
                reason = 'spend cap too low for priced cost';
            } else if (balance < cost + crankFee) {
                reason = 'balance below entry cost + crank fee';
            } else {
                actionable = true;
                reason = `round #${liveRound} needs ${needed}, entering ${p.quantity}`;
            }
        }

        targets.push({
            key: `groupPullStandingOrder.crank.${order.toLowerCase()}`,
            contract: 'groupPullStandingOrder',
            address: order,
            functionName: 'crank',
            args: [],
            label: `packs standing order crank ${order.slice(0, 10)}…`,
            actionable,
            reason,
            // crank() refunds the caller `crankFee`, but it is too small to draw a searcher, so this
            // is a must-run-ourselves call, not a contested bounty.
            reward: false,
        });
    }

    return targets;
}
