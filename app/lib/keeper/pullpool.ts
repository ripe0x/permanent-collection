// pullpool.ts — PullPool crank evaluation for the keeper, alongside the permanent-collection hops.
// Runs on the SAME process, wallet, and nonce stream as evaluateKeeperTargets, so PullPool is kept
// without a second deployment. Returns KeeperTarget[] in the shared shape; the existing sender
// handles them via KEEPER_ABIS.pullPool.
//
// PullPool is a per-round state machine; rounds advance only when a crank is called. This targets
// the maintenance cranks no searcher runs (voidRound, claimFee, NFT recovery, reclaimRefund) plus a
// simulate-gated backstop on the contested bounty cranks (pull, syncFwaResult, settle,
// settleForcedEth). settleForcedEth in particular closes the Claimable -> FWA-listing-Settled case
// nothing else does. sweepShares/sweepRefunds and the epoch cranks (creditRounds/claimEpoch) are
// omitted: sweeps have no readable cursor, and creditRounds takes an array arg the shared sender
// (args.map(BigInt)) cannot encode. Every crank here takes a single roundId.
//
// The predicates mirror keeper/targets.ts in the fwa-roll repo; keep them in sync (separate repos,
// so this is a copy rather than an import). Only the pool address is configured; the FWA core is
// read from the pool's immutable getter.
import type {Address, PublicClient} from 'viem';

import type {KeeperTarget} from './targets';

const RoundState = {None: 0, Open: 1, Pulling: 2, Claimable: 3, Settled: 4, Refunding: 5} as const;
const Outcome = {None: 0, Tokens: 1, ForcedEth: 3, Refunded: 4} as const;
const ListingStatus = {None: 0, Active: 1, Allocated: 2, Withdrawn: 3, Settled: 4, Staged: 5} as const;
const AcquisitionStatus = {None: 0, Pending: 1, Fulfilled: 2, Expired: 3, Refunded: 4, Ready: 5, TimedOut: 6} as const;

// getRound's tuple, named so viem decodes fields by name. Matches the deployed PullPool.Round.
const roundTuple = {
    type: 'tuple',
    components: [
        {name: 'ticketPrice', type: 'uint96'},
        {name: 'feeBps', type: 'uint16'},
        {name: 'headroomBps', type: 'uint16'},
        {name: 'feeCapBps', type: 'uint16'},
        {name: 'crankBountyCap', type: 'uint96'},
        {name: 'vrfAllowance', type: 'uint96'},
        {name: 'bountyTipWei', type: 'uint64'},
        {name: 'stallTimeout', type: 'uint64'},
        {name: 'fundingDeadline', type: 'uint64'},
        {name: 'ticketsSold', type: 'uint32'},
        {name: 'maxTickets', type: 'uint32'},
        {name: 'minPoolWeightedValue', type: 'uint256'},
        {name: 'escrow', type: 'uint256'},
        {name: 'feeOwed', type: 'uint256'},
        {name: 'refundPool', type: 'uint256'},
        {name: 'ethPot', type: 'uint256'},
        {name: 'tokenPot', type: 'uint256'},
        {name: 'fwaRequestId', type: 'uint256'},
        {name: 'acquisitionSpent', type: 'uint256'},
        {name: 'bidValue', type: 'uint256'},
        {name: 'listingId', type: 'uint256'},
        {name: 'allocatedAt', type: 'uint64'},
        {name: 'pullingAt', type: 'uint64'},
        {name: 'state', type: 'uint8'},
        {name: 'outcome', type: 'uint8'},
        {name: 'fwaResolved', type: 'bool'},
        {name: 'feeClaimed', type: 'bool'},
        {name: 'nftHeld', type: 'bool'},
        {name: 'rewardCredited', type: 'bool'},
        {name: 'creditTaken', type: 'uint128'},
        {name: 'rewardAmount', type: 'uint128'},
    ],
} as const;

// Reads (getRound, ethPendingRound, ticketsNeeded) plus the pool immutable FWA() getter.
const pullPoolReadAbi = [
    {type: 'function', name: 'roundCount', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'ethPendingRound', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'FWA', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
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
] as const;

// The cranks the sender calls. Every one takes a single roundId.
export const pullPoolKeeperAbi = [
    {type: 'function', name: 'pull', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'syncFwaResult', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'settleForcedEth', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'voidRound', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'claimFee', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'syncNftCustody', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'retryNftRecovery', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'reclaimRefund', stateMutability: 'nonpayable', inputs: [{name: 'roundId', type: 'uint256'}], outputs: []},
] as const;

const fwaAbi = [
    {
        type: 'function',
        name: 'listings',
        stateMutability: 'view',
        inputs: [{name: 'listingId', type: 'uint256'}],
        outputs: [
            {name: 'collection', type: 'address'},
            {name: 'depositor', type: 'address'},
            {name: 'purchaser', type: 'address'},
            {name: 'tokenId', type: 'uint256'},
            {name: 'weight', type: 'uint256'},
            {name: 'value', type: 'uint256'},
            {name: 'feeShare', type: 'uint256'},
            {name: 'feeDebt', type: 'uint256'},
            {name: 'slot', type: 'uint256'},
            {name: 'allocatedAt', type: 'uint64'},
            {name: 'status', type: 'uint8'},
        ],
    },
    {
        type: 'function',
        name: 'acquisitions',
        stateMutability: 'view',
        inputs: [{name: 'requestId', type: 'uint256'}],
        outputs: [
            {name: 'purchaser', type: 'address'},
            {name: 'requestBlock', type: 'uint256'},
            {name: 'priceEscrowed', type: 'uint256'},
            {name: 'listingId', type: 'uint256'},
            {name: 'status', type: 'uint8'},
        ],
    },
    {type: 'function', name: 'selectionTimeoutBlocks', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {
        type: 'function',
        name: 'stuckNFTRecipient',
        stateMutability: 'view',
        inputs: [{name: 'listingId', type: 'uint256'}],
        outputs: [{type: 'address'}],
    },
] as const;

const num = (v: unknown) => Number(v as bigint | number);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const LOOKBACK = Math.max(1, Number(process.env.KEEPER_PULLPOOL_LOOKBACK ?? '50'));

async function readAll(client: PublicClient, contracts: readonly unknown[]): Promise<unknown[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await client.multicall({contracts: contracts as any, allowFailure: true});
    return res.map((r) => (r.status === 'success' ? r.result : undefined));
}

type RoundTuple = Record<string, bigint | number | boolean>;

/** Walk a bounded window of recent rounds and emit one KeeperTarget per actionable crank. Contract
 *  is 'pullPool' and address is the pool for all of them; the shared sender uses KEEPER_ABIS.pullPool. */
export async function evaluatePullPoolTargets(
    client: PublicClient,
    pool: Address,
    opts: {currentBlock: bigint},
): Promise<KeeperTarget[]> {
    const base = {address: pool, abi: pullPoolReadAbi} as const;
    const [roundCountRaw, ethPendingRaw, fwaRaw] = await readAll(client, [
        {...base, functionName: 'roundCount'},
        {...base, functionName: 'ethPendingRound'},
        {...base, functionName: 'FWA'},
    ]);
    const roundCount = (roundCountRaw as bigint | undefined) ?? 0n;
    if (roundCount === 0n || !fwaRaw) return [];
    const fwa = fwaRaw as Address;
    const ethPendingRound = (ethPendingRaw as bigint | undefined) ?? 0n;

    const selTimeoutRaw = (await readAll(client, [
        {address: fwa, abi: fwaAbi, functionName: 'selectionTimeoutBlocks'},
    ]))[0];
    const selectionTimeout = (selTimeoutRaw as bigint | undefined) ?? 0n;

    const first = roundCount - BigInt(LOOKBACK) > 0n ? roundCount - BigInt(LOOKBACK) + 1n : 1n;
    const ids: bigint[] = [];
    for (let i = first; i <= roundCount; i++) ids.push(i);

    const rounds = (await readAll(
        client,
        ids.map((id) => ({...base, functionName: 'getRound', args: [id]})),
    )) as (RoundTuple | undefined)[];

    // Second-phase FWA/pool reads, batched, keyed by round + kind.
    type Read = {id: bigint; kind: string; call: unknown};
    const reads: Read[] = [];
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const r = rounds[i];
        if (!r) continue;
        const state = num(r.state);
        if (state === RoundState.Open) {
            reads.push({id, kind: 'ticketsNeeded', call: {...base, functionName: 'ticketsNeeded', args: [id]}});
        } else if (state === RoundState.Pulling) {
            reads.push({id, kind: 'acq', call: {address: fwa, abi: fwaAbi, functionName: 'acquisitions', args: [r.fwaRequestId]}});
        } else if (state === RoundState.Claimable) {
            reads.push({id, kind: 'listing', call: {address: fwa, abi: fwaAbi, functionName: 'listings', args: [r.listingId]}});
        } else if (state === RoundState.Settled && !r.nftHeld && num(r.outcome) === Outcome.ForcedEth) {
            reads.push({id, kind: 'stuck', call: {address: fwa, abi: fwaAbi, functionName: 'stuckNFTRecipient', args: [r.listingId]}});
        }
    }
    const readResults = await readAll(client, reads.map((x) => x.call));
    const byId = new Map<string, unknown>();
    reads.forEach((x, i) => byId.set(`${x.id}:${x.kind}`, readResults[i]));

    const targets: KeeperTarget[] = [];
    const emit = (
        id: bigint,
        functionName: string,
        reward: boolean,
        reason: string,
    ) =>
        targets.push({
            key: `pullPool.${functionName}.${id}`,
            contract: 'pullPool',
            address: pool,
            functionName,
            args: [id.toString()],
            label: `pullPool ${functionName} #${id}`,
            actionable: true,
            reason,
            reward,
        });
    const ts = nowSec();

    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const r = rounds[i];
        if (!r) continue;
        const state = num(r.state);
        const stall = r.stallTimeout as bigint;

        if (state === RoundState.Open) {
            const need = byId.get(`${id}:ticketsNeeded`) as bigint | undefined;
            if (need !== undefined && need === 0n && ethPendingRound === 0n) {
                emit(id, 'pull', true, 'Open, covered, no pull in flight');
            }
            if (need !== undefined && need > 0n && ts > (r.fundingDeadline as bigint) + stall) {
                emit(id, 'voidRound', false, 'Open, funding deadline + stall lapsed, uncovered');
            }
        } else if (state === RoundState.Pulling) {
            const acq = byId.get(`${id}:acq`) as readonly unknown[] | undefined;
            const acqStatus = acq ? num(acq[4]) : -1;
            const requestBlock = acq ? (acq[1] as bigint) : 0n;
            const terminal =
                acqStatus === AcquisitionStatus.Fulfilled ||
                acqStatus === AcquisitionStatus.Expired ||
                acqStatus === AcquisitionStatus.Refunded;
            if (terminal) {
                emit(id, 'syncFwaResult', true, `Pulling, FWA acquisition terminal (status ${acqStatus})`);
            } else {
                const pullStalled = ts > (r.pullingAt as bigint) + stall;
                const pendingLive =
                    acqStatus === AcquisitionStatus.Pending && opts.currentBlock <= requestBlock + selectionTimeout;
                const live = acqStatus === AcquisitionStatus.Ready || pendingLive;
                if (pullStalled && !live) {
                    emit(id, 'voidRound', false, `Pulling stalled past stallTimeout, FWA not live (status ${acqStatus})`);
                }
            }
        } else if (state === RoundState.Claimable) {
            const listing = byId.get(`${id}:listing`) as readonly unknown[] | undefined;
            const status = listing ? num(listing[10]) : -1;
            if (status === ListingStatus.Allocated) {
                emit(id, 'settle', true, 'Claimable, FWA listing Allocated');
            } else if (status === ListingStatus.Settled) {
                emit(id, 'settleForcedEth', true, 'Claimable, FWA listing Settled (forced-ETH close)');
            }
        } else if (state === RoundState.Settled) {
            if ((r.feeOwed as bigint) > 0n && !r.feeClaimed) {
                emit(id, 'claimFee', false, 'Settled, fee owed and unclaimed');
            }
            if (!r.nftHeld && num(r.outcome) === Outcome.ForcedEth) {
                const stuck = byId.get(`${id}:stuck`) as Address | undefined;
                if (stuck && stuck.toLowerCase() === pool.toLowerCase()) {
                    emit(id, 'retryNftRecovery', false, 'Settled (ForcedEth), NFT stuck at FWA and recoverable');
                } else {
                    emit(id, 'syncNftCustody', false, 'Settled (ForcedEth), NFT custody probe (retry with more gas)');
                }
            }
        } else if (state === RoundState.Refunding) {
            if ((r.fwaRequestId as bigint) !== 0n) {
                emit(id, 'reclaimRefund', false, 'Refunding, reclaim any FWA acquisition credit');
            }
        }
    }

    return targets;
}
