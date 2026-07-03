---
title: Run a keeper
description: The permissionless calls that keep value moving through the protocol, how to check readiness off-chain, and a minimal viem loop that sends them when profitable.
---

# Run a keeper

Four permissionless functions move value between protocol contracts. None of them requires a role, an allowlist entry, or any prior setup. Two pay the caller a small ETH reward; the other two pay nothing but keep the pipeline flowing. Anyone can run a keeper against them.

| Call | Contract | Reward | What it does |
|---|---|---|---|
| `sweep()` | [LiveBidAdapter](/docs/contracts/live-bid-adapter) | 0.5% of forwarded ETH, max 0.01 ETH | Meters buffered ETH into the live bid |
| `executeStep(minOut)` | [BuybackBurner](/docs/contracts/buyback-burner) | 0.5% of the step, max 0.01 ETH | Swaps queued ETH for $111 and burns it |
| `settle(punkId)` | [ReturnAuctionModule](/docs/contracts/return-auction-module) | none | Resolves an ended return auction |
| `sweep()` | [ProtocolFeePhaseAdapter](/docs/contracts/protocol-fee-phase-adapter) | none | Claims the protocol fee leg and forwards it |

For every call: simulate first (`eth_call` / viem `simulateContract` / `cast call`), then send. Gas cost varies with state, so measure via `eth_estimateGas` rather than assuming a number, and compare against the reward before sending the rewarded calls.

## LiveBidAdapter.sweep()

```solidity
function sweep() external returns (uint256 ethForwarded)
```

Address: [{{addr:liveBidAdapter}}](https://evm.now/address/{{addr:liveBidAdapter}}?chainId=1)

The adapter buffers every ETH inflow that funds the live bid and meters it into [Patron](/docs/contracts/patron). `sweep()` forwards buffered ETH in one of two modes, keyed on Patron's balance versus `activationThreshold()`:

- **Fast mode** (`patron.balance < activationThreshold()`): no cooldown, no per-call cap. The forward is clamped so the live bid lands exactly at the threshold; any excess stays buffered
- **Throttled mode** (`patron.balance >= activationThreshold()`): at most `maxSweepWei()` per call, and the call reverts `SweepTooEarly(nextBlock)` before `nextSweepBlock()`. The cooldown clock (`lastSweepBlock`) is shared with the hook-driven `streamForward()` path

Reward semantics, from source: the reward is `forwarded × KEEPER_REWARD_BPS / 10_000` (`KEEPER_REWARD_BPS = 50`, so 0.5%), capped at `KEEPER_REWARD_CAP = 0.01 ether`. In the fast-mode fill-to-threshold case the reward is paid out of the buffered remainder (capped at that remainder) so the bid still lands exactly at the threshold; otherwise it is carved off the forward. If the reward send to you fails, the call does not revert; the ETH stays buffered and `KeeperRewardFailed` is emitted. An empty buffer returns 0 without reverting and does not consume the cooldown.

Be aware of the competing path: the official pool's hook calls `streamForward()` on the adapter before swaps, which forwards the same buffer with no reward (it no-ops below `MIN_STREAM_WEI` = 0.01 ETH and on cooldown). During active trading the buffer may drain before your `sweep()` lands.

**Readiness (view calls):**

```bash
cast call {{addr:liveBidAdapter}} "bufferedEth()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:liveBidAdapter}} "nextSweepBlock()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:liveBidAdapter}} "activationThreshold()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast balance {{addr:patron}} --rpc-url https://ethereum-rpc.publicnode.com
```

Actionable when `bufferedEth() > 0` and either Patron's balance is below `activationThreshold()` (fast mode, any block) or `block.number >= nextSweepBlock()` (throttled mode).

## BuybackBurner.executeStep(minOut)

```solidity
function executeStep(uint256 minOut) external
```

Address: [{{addr:buybackBurner}}](https://evm.now/address/{{addr:buybackBurner}}?chainId=1)

Swaps up to `maxStepWei()` of queued ETH for $111 on the official pool and burns the output. Pacing: reverts `StepTooEarly(nextBlock)` before `nextExecutableBlock()`, and `NothingToBurn()` when `remainingEth()` is 0. The reward is 0.5% of the step (`EXEC_REWARD_BPS = 50`), capped at `EXEC_REWARD_CAP = 0.01 ether`, and pro-rated to the ETH actually spent on a partial fill.

**Picking `minOut`.** The contract's own sandwich guard is a fixed per-call price-impact cap: `maxSlippageBps = 500` (5%), a compile-time constant enforced through the V4 `sqrtPriceLimitX96`. When the limit binds, V4 partial-fills the swap and the unspent ETH stays queued. Because that cap is enforced on-chain, `minOut = 0` is safe and is what the protocol's own keeper sends. If you want a stricter per-call bound, quote the pool (via `poolKey()` and a V4 quoter) and set `minOut` below the quoted output, but note that a tight `minOut` will revert `InsufficientOutput(received, required)` on legitimate partial fills that the impact cap produces by design.

**Readiness (view calls):**

```bash
cast call {{addr:buybackBurner}} "remainingEth()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:buybackBurner}} "quoteStepAmount()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:buybackBurner}} "nextExecutableBlock()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
```

Actionable when `remainingEth() > 0` and `block.number >= nextExecutableBlock()`. `quoteStepAmount()` returns `min(remainingEth, maxStepWei)`, the ETH the next step would draw (reward included).

## ReturnAuctionModule.settle(punkId)

```solidity
function settle(uint16 punkId) external
```

Address: [{{addr:returnAuctionModule}}](https://evm.now/address/{{addr:returnAuctionModule}}?chainId=1)

Resolves a return auction once `block.timestamp >= endsAt(punkId)`. Reverts `SaleLive(punkId)` before then, `SaleMissing(punkId)` for a Punk with no sale, and `AlreadySettled(punkId)` after. Two branches:

- **Cleared** (a high bid exists): the Punk goes to the winning bidder and the proceeds split executes
- **Vault path** (no bids): the Punk enters [PunkVault](/docs/contracts/punk-vault) permanently, the recorded target trait is collected, and the Proof NFT mints if this is the trait's first vaulting

There is no caller reward on either branch. Settlement is still necessary: the winning bidder's ETH is locked and the Punk undelivered until someone settles, and on the vault path the trait is not collected until settle runs. Mission-aligned keepers should include it.

Watch `endsAt(punkId)` rather than caching a deadline: a bid inside the final 15 minutes extends the auction by 1 hour, with no cap on extensions.

**Readiness (view calls):** collect candidate `punkId`s from `ReturnAuctionStarted` event logs (never scan all 10,000 ids), then confirm each:

```bash
cast call {{addr:returnAuctionModule}} "isSettleable(uint16)(bool)" 8348 --rpc-url https://ethereum-rpc.publicnode.com
```

`isSettleable(punkId)` is true exactly when `settle(punkId)` would succeed.

## ProtocolFeePhaseAdapter.sweep()

```solidity
function sweep() external
```

Address: [{{addr:protocolFeePhaseAdapter}}](https://evm.now/address/{{addr:protocolFeePhaseAdapter}}?chainId=1)

The hook deposits the protocol fee leg into the artcoins fee escrow under this adapter's address on every swap. `sweep()` claims it from the escrow and forwards the full balance to the protocol fee controller. No reward. A failed escrow claim is non-fatal (`ClaimFailed` is emitted and the call continues with whatever balance is already held); a rejected forward reverts `ForwardFailed()` and the balance stays for retry. An empty balance returns without reverting.

**Readiness (view calls):** read the escrow address once, then check the pending balance under the adapter (token `address(0)` = native ETH):

```bash
ESCROW=$(cast call {{addr:protocolFeePhaseAdapter}} "feeEscrow()(address)" --rpc-url https://ethereum-rpc.publicnode.com)
cast call $ESCROW "availableFees(address,address)(uint256)" {{addr:protocolFeePhaseAdapter}} 0x0000000000000000000000000000000000000000 --rpc-url https://ethereum-rpc.publicnode.com
cast balance {{addr:protocolFeePhaseAdapter}} --rpc-url https://ethereum-rpc.publicnode.com
```

Actionable when either value is above zero.

## A minimal viem keeper loop

The sketch below checks readiness for all four calls each pass, simulates every candidate, and sends the rewarded ones only when the reward covers the estimated gas. Fill in your own transport and account handling.

```ts
import {createPublicClient, createWalletClient, http, parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {mainnet} from 'viem/chains';

const rpc = http('https://ethereum-rpc.publicnode.com');
const client = createPublicClient({chain: mainnet, transport: rpc});
const account = privateKeyToAccount(process.env.KEEPER_KEY as `0x${string}`);
const wallet = createWalletClient({account, chain: mainnet, transport: rpc});

const adapter = '{{addr:liveBidAdapter}}' as const;
const burner = '{{addr:buybackBurner}}' as const;
const auction = '{{addr:returnAuctionModule}}' as const;
const feeAdapter = '{{addr:protocolFeePhaseAdapter}}' as const;
const patron = '{{addr:patron}}' as const;

const adapterAbi = parseAbi([
    'function sweep() returns (uint256)',
    'function bufferedEth() view returns (uint256)',
    'function nextSweepBlock() view returns (uint256)',
    'function activationThreshold() view returns (uint256)',
]);
const burnerAbi = parseAbi([
    'function executeStep(uint256 minOut)',
    'function remainingEth() view returns (uint256)',
    'function nextExecutableBlock() view returns (uint256)',
]);
const auctionAbi = parseAbi([
    'function settle(uint16 punkId)',
    'function isSettleable(uint16 punkId) view returns (bool)',
    'event ReturnAuctionStarted(uint16 indexed punkId, uint128 acquisitionCost, uint128 reserveWei, uint64 startedAt, uint64 endsAt)',
]);
const feeAbi = parseAbi(['function sweep()']);

interface Candidate {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    rewarded: boolean;
}

async function findCandidates(): Promise<Candidate[]> {
    const block = await client.getBlockNumber();
    const out: Candidate[] = [];

    // 1. LiveBidAdapter.sweep()
    const [buffered, nextSweep, threshold, patronBal] = await Promise.all([
        client.readContract({address: adapter, abi: adapterAbi, functionName: 'bufferedEth'}),
        client.readContract({address: adapter, abi: adapterAbi, functionName: 'nextSweepBlock'}),
        client.readContract({address: adapter, abi: adapterAbi, functionName: 'activationThreshold'}),
        client.getBalance({address: patron}),
    ]);
    const fastMode = patronBal < threshold;
    if (buffered > 0n && (fastMode || block >= nextSweep)) {
        out.push({address: adapter, abi: adapterAbi, functionName: 'sweep', rewarded: true});
    }

    // 2. BuybackBurner.executeStep(0): the on-chain 5% impact cap bounds slippage
    const [queued, nextStep] = await Promise.all([
        client.readContract({address: burner, abi: burnerAbi, functionName: 'remainingEth'}),
        client.readContract({address: burner, abi: burnerAbi, functionName: 'nextExecutableBlock'}),
    ]);
    if (queued > 0n && block >= nextStep) {
        out.push({address: burner, abi: burnerAbi, functionName: 'executeStep', args: [0n], rewarded: true});
    }

    // 3. ReturnAuctionModule.settle(punkId): candidates from event history
    const started = await client.getContractEvents({
        address: auction, abi: auctionAbi, eventName: 'ReturnAuctionStarted',
        fromBlock: 25270161n, // PermanentCollection.deployedAtBlock
    });
    const punkIds = [...new Set(started.map((l) => l.args.punkId!))];
    for (const id of punkIds) {
        const ready = await client.readContract({
            address: auction, abi: auctionAbi, functionName: 'isSettleable', args: [id],
        });
        if (ready) out.push({address: auction, abi: auctionAbi, functionName: 'settle', args: [id], rewarded: false});
    }

    // 4. ProtocolFeePhaseAdapter.sweep(): cheap enough to just simulate
    out.push({address: feeAdapter, abi: feeAbi, functionName: 'sweep', rewarded: false});

    return out;
}

async function pass() {
    for (const c of await findCandidates()) {
        try {
            // Simulate first: a revert here costs nothing.
            const {request} = await client.simulateContract({...c, account} as never);
            // For rewarded calls, compare estimated gas cost against the
            // reward (<= 0.01 ETH) before sending.
            const gas = await client.estimateContractGas({...c, account} as never);
            const gasPrice = await client.getGasPrice();
            if (c.rewarded && gas * gasPrice > 10n ** 16n) continue; // reward can never exceed 0.01 ETH
            const hash = await wallet.writeContract(request);
            console.log(`${c.functionName} -> https://evm.now/tx/${hash}?chainId=1`);
        } catch {
            // Not actionable right now (cooldown, empty buffer, raced by another keeper).
        }
    }
}

setInterval(() => void pass(), 60_000);
```

The protocol's own dashboard at `/debug/distribution` evaluates the same readiness predicates per call, so it is a convenient way to cross-check what your keeper sees.
