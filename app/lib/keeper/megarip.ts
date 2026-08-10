// megarip.ts — MegaRip crank evaluation for the keeper, alongside the PullPool / GroupPull hops.
// Runs on the SAME process, wallet, and nonce stream as the other evaluators; returns KeeperTarget[]
// in the shared shape, sent via KEEPER_ABIS.megaRip.
//
// MegaRip (src/MegaRip.sol in the fwa-roll repo) is a one-off event: Pending -> Funding -> Pulling ->
// Finalized, forward only. This is a BACKUP keeper. `pull` and `settle` pay a per-call bounty, so
// searchers race them for profit; the calls this uniquely guarantees are the reward-free ones no third
// party is paid to run:
//   - lock       close the funding window and commit the pot (Funding -> Pulling). The gateway: no
//                pull bounty exists until this fires, so it is only weakly incentivized and may lag.
//   - finalize   close the event and open claims (Pulling -> Finalized). Reward-free; the real stall
//                risk without a keeper.
//   - sync       withdraw a late FWA refund credit into the pot after finalize. Reward-free.
//   - releaseStale  release a stranded terminal-crank reserve once the event is past hardTimeout.
// The bountied hops are emitted too, so the keeper is a genuine backstop when no searcher shows:
//   - pull       the acquisition crank, while the budget affords one (reward).
//   - settle     per allocation whose auction has ended (reward).
//
// The sender simulates every call before sending, so a hop a searcher already ran (or that the chain
// refuses) reverts in simulation and costs no gas — gates here can be coarse without waste.
import type {Address, PublicClient} from 'viem';

import type {KeeperTarget} from './targets';

// MegaRip.State. Forward only.
const State = {Pending: 0, Funding: 1, Pulling: 2, Finalized: 3} as const;
// MegaRip.AcqState. Voided/Resolved are terminal; StuckNft is live money until it sells or hardTimeout.
const AcqState = {None: 0, Pending: 1, Allocated: 2, StuckNft: 3, Resolved: 4, Voided: 5} as const;

// Wall clock, as the other evaluators do. The keeper box clock tracks chain time closely enough for
// timeout gates whose grace is measured in hours.
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

// Per-call page bound on the resumable pull crank. pull(N) in a loop and pull(1) N times do the same
// work, so a modest page keeps one tx gas-bounded; the next pass continues where this left off.
const MAX_PULLS = 25n;

// MegaRip.Acquisition, named so viem decodes fields by name. Matches the deployed struct field order.
const acquisitionTuple = {
    type: 'tuple',
    components: [
        {name: 'requestId', type: 'uint256'},
        {name: 'listingId', type: 'uint256'},
        {name: 'collection', type: 'address'},
        {name: 'tokenId', type: 'uint256'},
        {name: 'backing', type: 'uint128'},
        {name: 'bidEquiv', type: 'uint128'},
        {name: 'reserve', type: 'uint128'},
        {name: 'highBid', type: 'uint128'},
        {name: 'highBidder', type: 'address'},
        {name: 'requestedAt', type: 'uint64'},
        {name: 'allocatedAt', type: 'uint64'},
        {name: 'deadline', type: 'uint64'},
        {name: 'hardDeadline', type: 'uint64'},
        {name: 'discountBps', type: 'uint16'},
        {name: 'status', type: 'uint8'},
        {name: 'auctionOpen', type: 'bool'},
        {name: 'reserved', type: 'bool'},
    ],
} as const;

// The reads the evaluator makes on MegaRip (all view).
const megaRipReadAbi = [
    {type: 'function', name: 'state', stateMutability: 'view', inputs: [], outputs: [{type: 'uint8'}]},
    {type: 'function', name: 'fundingEndsAt', stateMutability: 'view', inputs: [], outputs: [{type: 'uint64'}]},
    {type: 'function', name: 'lockedAt', stateMutability: 'view', inputs: [], outputs: [{type: 'uint64'}]},
    {type: 'function', name: 'hardTimeout', stateMutability: 'view', inputs: [], outputs: [{type: 'uint64'}]},
    {type: 'function', name: 'activeCount', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'estimatedPullsRemaining', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'pullsDone', stateMutability: 'view', inputs: [], outputs: [{type: 'uint256'}]},
    {type: 'function', name: 'FWA', stateMutability: 'view', inputs: [], outputs: [{type: 'address'}]},
    {type: 'function', name: 'acquisitionAt', stateMutability: 'view', inputs: [{name: 'index', type: 'uint256'}], outputs: [acquisitionTuple]},
] as const;

// FWA's address-level refund credit owed to a holder. Gates `sync`: the only value that lands after
// `finalize` with no permissionless route into the pot but this one.
const fwaReadAbi = [
    {type: 'function', name: 'acquisitionRefundCredit', stateMutability: 'view', inputs: [{name: 'holder', type: 'address'}], outputs: [{type: 'uint256'}]},
] as const;

// The cranks the sender calls. lock/finalize/sync take no args; pull takes a page bound; settle a
// listingId; releaseStale an acquisition index.
export const megaRipKeeperAbi = [
    {type: 'function', name: 'lock', stateMutability: 'nonpayable', inputs: [], outputs: []},
    {type: 'function', name: 'pull', stateMutability: 'nonpayable', inputs: [{name: 'maxPulls', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [{name: 'listingId', type: 'uint256'}], outputs: []},
    {type: 'function', name: 'finalize', stateMutability: 'nonpayable', inputs: [], outputs: []},
    {type: 'function', name: 'sync', stateMutability: 'nonpayable', inputs: [], outputs: []},
    {type: 'function', name: 'releaseStale', stateMutability: 'nonpayable', inputs: [{name: 'idx', type: 'uint256'}], outputs: []},
] as const;

/**
 * Evaluate MegaRip's due cranks. Reads the top-level state in one batch; enumerates the acquisition
 * list only once the event is Pulling or later (there is nothing to settle or release before then).
 */
export async function evaluateMegaRipTargets(
    rpc: PublicClient,
    address: Address,
    _opts: {currentBlock: bigint},
): Promise<KeeperTarget[]> {
    const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rpc.readContract({address, abi: megaRipReadAbi, functionName, args} as any) as Promise<T>;

    const [state, fundingEndsAt, lockedAt, hardTimeout, activeCount, estPulls, pullsDone] = await Promise.all([
        read<number>('state'),
        read<bigint>('fundingEndsAt'),
        read<bigint>('lockedAt'),
        read<bigint>('hardTimeout'),
        read<bigint>('activeCount'),
        read<bigint>('estimatedPullsRemaining'),
        read<bigint>('pullsDone'),
    ]);

    const now = nowSec();
    const targets: KeeperTarget[] = [];
    const base = {contract: 'megaRip' as const, address};

    // lock — close the funding window. Only meaningful while Funding; due once the window has elapsed.
    if (state === State.Funding) {
        const due = now >= fundingEndsAt;
        targets.push({
            ...base,
            key: 'megaRip.lock',
            functionName: 'lock',
            args: [],
            label: 'MegaRip: close funding window',
            actionable: due,
            reason: due ? 'funding window elapsed' : `funding closes in ${fundingEndsAt - now}s`,
            reward: false,
        });
    }

    // pull — the acquisition crank, while the budget affords one. Bountied; searchers race it, so this
    // is a backstop. finalize — close the event once nothing is live, or the hardTimeout backstop.
    if (state === State.Pulling) {
        targets.push({
            ...base,
            key: 'megaRip.pull',
            functionName: 'pull',
            args: [MAX_PULLS.toString()],
            label: 'MegaRip: pull acquisitions',
            actionable: estPulls > 0n,
            reason: estPulls > 0n ? `budget affords ~${estPulls} more pull(s)` : 'budget exhausted',
            reward: true,
        });

        const pastHardTimeout = now >= lockedAt + hardTimeout;
        const finalizeReady = activeCount === 0n || pastHardTimeout;
        targets.push({
            ...base,
            key: 'megaRip.finalize',
            functionName: 'finalize',
            args: [],
            label: 'MegaRip: finalize and open claims',
            actionable: finalizeReady,
            reason:
                activeCount === 0n
                    ? 'no acquisitions live'
                    : pastHardTimeout
                      ? 'past hardTimeout'
                      : `${activeCount} live, awaiting settle or hardTimeout`,
            reward: false,
        });
    }

    // settle / releaseStale — per acquisition. Nothing to enumerate before Pulling.
    if (state >= State.Pulling && pullsDone > 0n) {
        const pastHardTimeout = now >= lockedAt + hardTimeout;
        const idxs = Array.from({length: Number(pullsDone)}, (_, i) => BigInt(i));
        const acqs = await Promise.all(idxs.map((i) => read<AcqRecord>('acquisitionAt', [i])));

        acqs.forEach((a, i) => {
            // settle — an Allocated auction that has ended (deadline passed) or opened closed
            // (`auctionOpen` false, settleable from allocation). Bountied; searchers race it.
            if (a.status === AcqState.Allocated && (!a.auctionOpen || now >= a.deadline)) {
                targets.push({
                    ...base,
                    key: `megaRip.settle.${a.listingId}`,
                    functionName: 'settle',
                    args: [a.listingId.toString()],
                    label: `MegaRip: settle listing ${a.listingId}`,
                    actionable: true,
                    reason: a.auctionOpen ? 'auction ended' : 'auction closed at allocation',
                    reward: true,
                });
            }

            // releaseStale — release a stranded reserve once the event is over. Guarded by `reserved`
            // (releaseStale is a no-op without it) and by the hardTimeout the contract itself checks.
            // A healthy Allocated auction still settling reverts NotStale in simulation, so emitting it
            // for every reserved acquisition past hardTimeout costs nothing when it is not yet due.
            const stale =
                a.reserved &&
                ((a.status === AcqState.StuckNft && pastHardTimeout) ||
                    (a.status === AcqState.Allocated && pastHardTimeout) ||
                    (a.status === AcqState.Pending && state === State.Finalized));
            if (stale) {
                targets.push({
                    ...base,
                    key: `megaRip.releaseStale.${i}`,
                    functionName: 'releaseStale',
                    args: [String(i)],
                    label: `MegaRip: release stale reserve #${i}`,
                    actionable: true,
                    reason: `acquisition #${i} (${acqStateName(a.status)}) reserve stranded`,
                    reward: false,
                });
            }
        });
    }

    // sync — withdraw a late FWA refund credit into the pot. Only after finalize is there value with no
    // other permissionless route in; pull reconciles the same while Pulling.
    if (state === State.Finalized) {
        const fwa = await read<Address>('FWA');
        const credit = (await rpc
            .readContract({address: fwa, abi: fwaReadAbi, functionName: 'acquisitionRefundCredit', args: [address]})
            .catch(() => 0n)) as bigint;
        if (credit > 0n) {
            targets.push({
                ...base,
                key: 'megaRip.sync',
                functionName: 'sync',
                args: [],
                label: 'MegaRip: reconcile late refund into pot',
                actionable: true,
                reason: `FWA refund credit ${credit} wei pending`,
                reward: false,
            });
        }
    }

    return targets;
}

// The fields of acquisitionAt this evaluator reads.
interface AcqRecord {
    listingId: bigint;
    deadline: bigint;
    status: number;
    auctionOpen: boolean;
    reserved: boolean;
}

function acqStateName(s: number): string {
    return (
        (Object.entries(AcqState).find(([, v]) => v === s)?.[0] as string | undefined) ?? `state ${s}`
    );
}
