// grouppull.ts — GroupPull ("packs") crank evaluation for the keeper, alongside the PullPool hops.
// Runs on the SAME process, wallet, and nonce stream as evaluatePullPoolTargets, so the pack stream
// is kept without a second deployment. Returns KeeperTarget[] in the shared shape; the existing
// sender handles them via KEEPER_ABIS.groupPull.
//
// GroupPull is a per-round state machine, Selling -> Buying -> Collecting -> Distributing (+Expired),
// that advances only when a crank fires. This targets the GroupPull-contract cranks:
//   - openRound  keep the stream running; at most one round is live at a time (liveRound gate).
//   - close      the raise covers the target but no covering entry closed it (a live-price fall).
//   - submit     buy the round's pool rounds as the contract itself. Time-critical: the round closed
//                against a live price, and a rise before the buy lands refunds it.
//   - collect    draw each settled pool round's $FWA and ETH into the contract.
//   - abortRound / expireRound  the failure paths (buys ran out of submitWindow / the sale expired).
//
// The pool rounds a round buys are ordinary rounds on the same pool, so evaluatePullPoolTargets
// already cranks their pull/syncFwaResult/settle — this file does not duplicate that. The reward-epoch
// cranks (claimEpoch/creditRounds, which deliver a late reward into a collected round) are omitted
// here, as they are in ./pullpool.ts.
//
// Every predicate is precise so an emitted target is genuinely due; the sender still simulates each
// before sending, so a call the chain refuses is a backstop, not the routine case.
import type {Address, PublicClient} from 'viem';

import type {KeeperTarget} from './targets';
import {roundTupleV2} from './pullpool';

// GroupPull.RoundState. None is the zero value a never-opened id reads as.
const RoundState = {None: 0, Selling: 1, Buying: 2, Collecting: 3, Distributing: 4, Expired: 5} as const;
// PullPool.RoundState.Settled — a pool round whose $FWA and ETH are ready for the group to collect.
const PoolSettled = 4;

// getRound's tuple, named so viem decodes fields by name. Matches the deployed GroupPull.Round.
const groupRoundTuple = {
    type: 'tuple',
    components: [
        {name: 'entryPrice', type: 'uint96'},
        {name: 'incentivePerTicket', type: 'uint96'},
        {name: 'pullsPerRound', type: 'uint32'},
        {name: 'maxParticipants', type: 'uint32'},
        {name: 'sellsFrom', type: 'uint64'},
        {name: 'sellsUntil', type: 'uint64'},
        {name: 'entryDuration', type: 'uint64'},
        {name: 'submitWindow', type: 'uint64'},
        {name: 'ticketsSold', type: 'uint32'},
        {name: 'escrow', type: 'uint256'},
        {name: 'bountyPot', type: 'uint256'},
        {name: 'ethPool', type: 'uint256'},
        {name: 'ethPaid', type: 'uint256'},
        {name: 'fwaPot', type: 'uint256'},
        {name: 'fwaPaid', type: 'uint256'},
        {name: 'surchargePot', type: 'uint256'},
        {name: 'escalationThreshold', type: 'uint32'},
        {name: 'escalationRateBps', type: 'uint16'},
        {name: 'bought', type: 'uint32'},
        {name: 'pullsCollected', type: 'uint32'},
        {name: 'bountyShares', type: 'uint32'},
        {name: 'submitDeadline', type: 'uint64'},
        {name: 'aborted', type: 'bool'},
        {name: 'state', type: 'uint8'},
    ],
} as const;

// The reads the evaluator makes on GroupPull.
const groupPullReadAbi = [
    {type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
    {type: 'function', name: 'deprecated', stateMutability: 'view', inputs: [], outputs: [{type: 'bool'}]},
    {type: 'function', name: 'roundCount', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'liveRound', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'getRound', stateMutability: 'view', inputs: [{name: 'roundId', type: 'uint256'}], outputs: [groupRoundTuple]},
    {type: 'function', name: 'ticketsNeeded', stateMutability: 'view', inputs: [{name: 'roundId', type: 'uint256'}], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'poolRoundsOf', stateMutability: 'view', inputs: [{name: 'roundId', type: 'uint256'}], outputs: [{type: 'uint256[]'}]},
    {type: 'function', name: 'roundPool', stateMutability: 'view', inputs: [{name: 'roundId', type: 'uint256'}], outputs: [{type: 'address'}]},
] as const;

// The cranks the sender calls. openRound takes no args; the rest take a roundId, and submit/collect a
// maxPoolRounds page bound alongside it.
export const groupPullKeeperAbi = [
    {type: 'function', name: 'openRound', stateMutability: 'nonpayable', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'close', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'submit', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}, {name: 'maxPoolRounds', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'collect', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}, {name: 'maxPoolRounds', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'abortRound', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'expireRound', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
] as const;

// The pool getRound, read with the v2 tuple so a Collecting round's pool rounds decode their state.
const poolRoundReadAbi = [
    {type: 'function', name: 'getRound', stateMutability: 'view', inputs: [{name: 'roundId', type: 'uint256'}], outputs: [roundTupleV2]},
] as const;

const num = (v: unknown) => Number(v as bigint | number);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
// How many rounds back to look for work. A round is finished long before this many follow it.
const LOOKBACK = BigInt(Math.max(1, Number(process.env.KEEPER_GROUPPULL_LOOKBACK ?? '10')));

async function readAll(client: PublicClient, contracts: readonly unknown[]): Promise<unknown[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await client.multicall({contracts: contracts as any, allowFailure: true});
    return res.map((r) => (r.status === 'success' ? r.result : undefined));
}

type GroupRound = Record<string, bigint | number | boolean>;

/** Walk a bounded window of recent rounds and emit one KeeperTarget per actionable GroupPull crank.
 *  Contract is 'groupPull' and address is the GroupPull for all of them; the shared sender uses
 *  KEEPER_ABIS.groupPull. */
export async function evaluateGroupPullTargets(
    client: PublicClient,
    groupPull: Address,
    _opts: {currentBlock: bigint},
): Promise<KeeperTarget[]> {
    const base = {address: groupPull, abi: groupPullReadAbi} as const;
    const [pausedRaw, deprecatedRaw, roundCountRaw, liveRoundRaw] = await readAll(client, [
        {...base, functionName: 'paused'},
        {...base, functionName: 'deprecated'},
        {...base, functionName: 'roundCount'},
        {...base, functionName: 'liveRound'},
    ]);
    const paused = pausedRaw === true;
    const deprecated = deprecatedRaw === true;
    const roundCount = (roundCountRaw as bigint | undefined) ?? 0n;
    const liveRound = (liveRoundRaw as bigint | undefined) ?? 0n;

    const targets: KeeperTarget[] = [];
    const emit = (
        key: string,
        functionName: string,
        args: string[],
        reward: boolean,
        reason: string,
    ) =>
        targets.push({
            key,
            contract: 'groupPull',
            address: groupPull,
            functionName,
            args,
            label: `groupPull ${functionName}${args.length ? ` #${args[0]}` : ''}`,
            actionable: true,
            reason,
            reward,
        });

    // Keep the stream running. openRound reverts if a round is already live, so it is emitted only when
    // none is; the pricing/listing guards inside it are left to the sender's simulate.
    if (liveRound === 0n && !paused && !deprecated) {
        emit('groupPull.openRound', 'openRound', [], false, 'no round live; open the next');
    }

    if (roundCount === 0n) return targets;

    const first = roundCount > LOOKBACK ? roundCount - LOOKBACK + 1n : 1n;
    const ids: bigint[] = [];
    for (let id = first; id <= roundCount; id++) ids.push(id);

    const rounds = (await readAll(
        client,
        ids.map((id) => ({...base, functionName: 'getRound', args: [id]})),
    )) as (GroupRound | undefined)[];

    // Second-phase reads, batched: ticketsNeeded for Selling rounds, and the pool + pool-round states
    // for Collecting rounds so collect is emitted only when a settled pool round is waiting to draw.
    type Read = {id: bigint; kind: string; call: unknown};
    const reads: Read[] = [];
    for (let i = 0; i < ids.length; i++) {
        const r = rounds[i];
        if (!r) continue;
        const state = num(r.state);
        if (state === RoundState.Selling) {
            reads.push({id: ids[i], kind: 'needed', call: {...base, functionName: 'ticketsNeeded', args: [ids[i]]}});
        } else if (state === RoundState.Collecting) {
            reads.push({id: ids[i], kind: 'poolRounds', call: {...base, functionName: 'poolRoundsOf', args: [ids[i]]}});
            reads.push({id: ids[i], kind: 'pool', call: {...base, functionName: 'roundPool', args: [ids[i]]}});
        }
    }
    const readResults = await readAll(client, reads.map((x) => x.call));
    const byId = new Map<string, unknown>();
    reads.forEach((x, i) => byId.set(`${x.id}:${x.kind}`, readResults[i]));

    // For each Collecting round, count how many of its pool rounds have settled. More settled than the
    // round has collected means at least one is waiting, so collect will draw rather than revert.
    const settledCount = new Map<string, number>();
    const collectPoolReads: {id: bigint; call: unknown}[] = [];
    for (const id of ids) {
        const poolRounds = byId.get(`${id}:poolRounds`) as readonly bigint[] | undefined;
        const pool = byId.get(`${id}:pool`) as Address | undefined;
        if (!poolRounds || !pool) continue;
        for (const pr of poolRounds) {
            collectPoolReads.push({id, call: {address: pool, abi: poolRoundReadAbi, functionName: 'getRound', args: [pr]}});
        }
    }
    if (collectPoolReads.length > 0) {
        const prStates = (await readAll(client, collectPoolReads.map((x) => x.call))) as (GroupRound | undefined)[];
        collectPoolReads.forEach((x, i) => {
            const st = prStates[i];
            if (st && num(st.state) === PoolSettled) {
                settledCount.set(x.id.toString(), (settledCount.get(x.id.toString()) ?? 0) + 1);
            }
        });
    }

    const ts = nowSec();
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const r = rounds[i];
        if (!r) continue;
        const state = num(r.state);
        const pulls = r.pullsPerRound as bigint;

        if (state === RoundState.Selling) {
            const needed = byId.get(`${id}:needed`) as bigint | undefined;
            const sellsUntil = r.sellsUntil as bigint;
            if (needed !== undefined && needed === 0n) {
                emit(`groupPull.close.${id}`, 'close', [id.toString()], true, 'Selling, covered, no entry closed it');
            } else if (needed !== undefined && needed > 0n && sellsUntil !== 0n && ts > sellsUntil) {
                // Sold at least one ticket (sellsUntil set), past the sale deadline, still under target.
                // A never-sold round has no deadline and its expire is owner-only, so it is not emitted.
                emit(`groupPull.expireRound.${id}`, 'expireRound', [id.toString()], false, 'Selling, deadline lapsed under target');
            }
        } else if (state === RoundState.Buying) {
            const submitDeadline = r.submitDeadline as bigint;
            const bought = r.bought as bigint;
            if (ts <= submitDeadline && bought < pulls) {
                emit(`groupPull.submit.${id}`, 'submit', [id.toString(), pulls.toString()], true, 'Buying, pool rounds to buy inside submitWindow');
            } else if (ts > submitDeadline) {
                emit(`groupPull.abortRound.${id}`, 'abortRound', [id.toString()], false, 'Buying, submitWindow lapsed before the buys finished');
            }
        } else if (state === RoundState.Collecting) {
            const settled = settledCount.get(id.toString()) ?? 0;
            const collected = num(r.pullsCollected);
            if (settled > collected) {
                emit(`groupPull.collect.${id}`, 'collect', [id.toString(), pulls.toString()], true, `Collecting, ${settled - collected} settled pool round(s) to draw`);
            }
        }
    }

    return targets;
}
