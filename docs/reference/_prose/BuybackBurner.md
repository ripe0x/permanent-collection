---
contract: BuybackBurner
slug: buyback-burner
deploymentsKey: buybackBurner
title: BuybackBurner
---

# summary

BuybackBurner converts queued ETH into $111 and removes it from circulation.
It receives ETH from cleared return-auction settles, from `VaultBurnPool`
sweeps, and from any direct send to its `receive()` function. Anyone may call
`executeStep(minOut)` once the pacing window has elapsed: the contract swaps
up to `maxStepWei` of queued ETH for $111 in the official pool inside a V4
unlock callback, calls `burn` on the token with everything it received, and
pays the caller a small ETH reward. The pool is native-ETH paired, so the swap
settles ETH directly with no WETH wrap.

The contract holds no privileged withdrawal path. ETH can only leave toward
the pool (as swap input) or to the `executeStep` caller (as the bounded
reward). The two tunable parameters, `minBlocksBetweenSteps` and `maxStepWei`,
are gated by the time-locked `ProtocolAdmin` and freeze at its 1-year expiry.

# concepts

### Step pacing

Steps are paced by block number. `executeStep` reverts `StepTooEarly` until
`block.number >= lastStepBlock + minBlocksBetweenSteps`. `lastStepBlock` is
written to the current block BEFORE the contract enters the V4 unlock
callback, so a same-transaction re-entry of `executeStep` (for example from
the keeper-reward send) always reverts `StepTooEarly`. This pacing is the
contract's same-call reentry guard; there is no separate `nonReentrant`
mutex, and the `MIN_BLOCKS_LO = 1` floor on the setter keeps the guard
load-bearing.

### Step sizing and the price-impact cap

Each step draws `min(remainingEth, maxStepWei)` from the queue. The swap is
protected by two independent bounds:

- `maxStepWei` caps the ETH offered per step (admin-tunable within
  `[MAX_STEP_WEI_LO, MAX_STEP_WEI_HI]`, that is 0.01 to 10 ETH)
- `maxSlippageBps = 500` is a compile-time constant with no setter. The swap
  passes a `sqrtPriceLimitX96` derived from the current pool price so a
  single call can never move the price more than 5%. When the limit binds,
  V4 partial-fills the swap: fewer tokens are burned, and the unspent ETH
  stays queued in `remainingEth` for a later step

Because `executeStep` is permissionless and spends protocol ETH, the
caller-supplied `minOut` alone can't be the sandwich guard (a hostile caller
would just pass 0). The fixed price-impact cap is the objective protocol-level
guard; `minOut` is an optional stricter bound for keepers.

### Caller reward

The caller earns `min(step × 50 / 10_000, 0.01 ETH)`, that is at most 0.5% of
the step and never more than 0.01 ETH (`EXEC_REWARD_BPS`, `EXEC_REWARD_CAP`).
The reward is deducted from the step before the swap and pro-rated to the ETH
actually consumed on a partial fill, so a clamped swap pays a proportionally
smaller reward. If the reward send to the caller fails, the step still
succeeds: the burn has already happened, the reward ETH is credited back to
`remainingEth`, and `ExecutionRewardFailed` is emitted.

### Checking step readiness

A step is executable when the pacing window has elapsed AND there is queued
ETH. Read both in one shot:

```bash
RPC=https://ethereum-rpc.publicnode.com
cast call {{addr:buybackBurner}} "nextExecutableBlock()(uint256)" --rpc-url $RPC
cast call {{addr:buybackBurner}} "quoteStepAmount()(uint256)" --rpc-url $RPC
cast block-number --rpc-url $RPC
```

The step is ready when the current block number is at or past
`nextExecutableBlock()` and `quoteStepAmount()` is nonzero.

### Executing a step (viem)

```ts
import {createWalletClient, createPublicClient, http} from 'viem'
import {mainnet} from 'viem/chains'
import {privateKeyToAccount} from 'viem/accounts'
import {abi} from '@/lib/abis/BuybackBurner'

const burner = '{{addr:buybackBurner}}'
const publicClient = createPublicClient({chain: mainnet, transport: http()})
const wallet = createWalletClient({
  account: privateKeyToAccount(process.env.KEEPER_KEY as `0x${string}`),
  chain: mainnet,
  transport: http(),
})

const [nextBlock, stepAmount, blockNumber] = await Promise.all([
  publicClient.readContract({address: burner, abi, functionName: 'nextExecutableBlock'}),
  publicClient.readContract({address: burner, abi, functionName: 'quoteStepAmount'}),
  publicClient.getBlockNumber(),
])

if (blockNumber >= nextBlock && stepAmount > 0n) {
  // minOut = 0 relies on the contract's fixed 5% price-impact cap.
  // Keepers wanting a stricter bound can quote the pool and pass a floor.
  const hash = await wallet.writeContract({
    address: burner,
    abi,
    functionName: 'executeStep',
    args: [0n],
  })
  console.log(`https://evm.now/tx/${hash}?chainId=1`)
}
```

## function executeStep

access: permissionless

Swaps up to `maxStepWei` of queued ETH for $111 in the official pool and
burns everything received, paying the caller a bounded ETH reward. Step by
step:

1. Reverts `StepTooEarly(nextBlock)` if `block.number < lastStepBlock +
   minBlocksBetweenSteps`
2. Sizes the step at `min(remainingEth, maxStepWei)`; reverts
   `NothingToBurn` if that is zero
3. Computes the caller reward (`min(step × 0.5%, 0.01 ETH)`; forced to zero
   on a pathological step smaller than the reward) and subtracts it from the
   step to get the swap amount
4. Writes `lastStepBlock = block.number` BEFORE the swap, so a same-tx
   reentrant call reverts `StepTooEarly`
5. Calls `poolManager.unlock`, which re-enters via `unlockCallback` to
   perform the exact-input ETH-to-$111 swap with the 5% `sqrtPriceLimitX96`
   bound. When the limit binds, V4 partial-fills and the unspent ETH stays
   queued
6. Reverts `ExcessInputSpent` if the reported ETH spend exceeds the swap
   amount (defense against a misreporting hook), and
   `InsufficientOutput(received, minOut)` if the tokens received fall below
   the caller's `minOut`
7. Debits `remainingEth` by the ETH actually spent, increments
   `totalEthBurned` and `totalTokensBurned`, calls `token.burn(received)`,
   and emits `TokensBurned`
8. Pays the caller the reward, pro-rated to the ETH actually consumed on a
   partial fill. A failed reward send does not revert: the ETH is credited
   back to `remainingEth` and `ExecutionRewardFailed` is emitted

`minOut` may be 0 to rely solely on the fixed price-impact cap. Decorated
`notInSwap` (a no-op while `PCSwapContext` has no authorized extension).

## function setup

access: deployer one-shot, gated by `OneTimeSetup` (original deployer only, before finalization)

Wires the $111 token address and the official pool's V4 hook address in a
single call, then permanently closes the setup gate (`_markFinalized`, which
emits `Finalized`). Reverts `NotDeployer` for any other caller and
`AlreadyFinalized` on any repeat call. Reverts with `"BB: zero"` if either
address is zero. Until `setup` runs, `executeStep` cannot swap (the pool key
would reference a zero token).

## function setMinBlocksBetweenSteps

access: admin-only, `ProtocolAdmin.checkAdmin(msg.sender)`; locks at the 1-year admin expiry

Sets the minimum block delta between `executeStep` calls. Reverts
`OutOfBounds` outside `[MIN_BLOCKS_LO, MIN_BLOCKS_HI]` (1 to 50,400 blocks,
the upper bound about one week). Emits `ParameterChanged` with key
`"minBlocksBetweenSteps"`. The floor of 1 is load-bearing: pacing is the
contract's same-tx reentry guard.

## function setMaxStepWei

access: admin-only, `ProtocolAdmin.checkAdmin(msg.sender)`; locks at the 1-year admin expiry

Sets the ETH ceiling for a single step's swap. Reverts `OutOfBounds` outside
`[MAX_STEP_WEI_LO, MAX_STEP_WEI_HI]` (0.01 to 10 ETH). Emits
`ParameterChanged` with key `"maxStepWei"`. Acts as a soft impact guard
alongside the fixed `maxSlippageBps` cap.

## function unlockCallback

access: PoolManager-only, reverts `NotPoolManager` for any other caller

The V4 unlock callback invoked by `PoolManager.unlock` during `executeStep`.
Decodes the swap amount, builds the pool key (native ETH is always
`currency0`, so the swap is always zeroForOne), reads the current
`sqrtPriceX96` from slot0, and narrows `sqrtPriceLimitX96` to the 5%
price-impact bound. Executes the exact-input swap, asserts the ETH consumed
never exceeds the requested amount (reverts `ExcessInputSpent` otherwise, a
defense against hooks with return-delta permissions), settles the ETH side
with native value, takes the $111 output, and returns
`abi.encode(received, ethSpent)`. The caller's `minOut` is deliberately NOT
enforced here so partial fills don't spuriously revert; that check lives in
`executeStep`.

Not useful to call directly: any caller other than the PoolManager reverts,
and the PoolManager only invokes it inside `executeStep`'s unlock.

## receive

access: permissionless, accepts ETH from any sender

Credits `msg.value` to `remainingEth` and emits `BurnEthDeposited`. This is
how all inflows arrive: the cleared return-auction settle share, the
`VaultBurnPool` ETH sweep, and voluntary top-ups.

## function EXEC_REWARD_BPS

Constant `50`. The caller reward as basis points of the step size (0.5%).

## function EXEC_REWARD_CAP

Constant `0.01 ether`. The absolute cap on a single step's caller reward.

## function MAX_STEP_WEI_HI

Constant `10 ether`. Upper bound for `setMaxStepWei`.

## function MAX_STEP_WEI_LO

Constant `0.01 ether`. Lower bound for `setMaxStepWei`.

## function MIN_BLOCKS_HI

Constant `50_400` (about one week of blocks). Upper bound for
`setMinBlocksBetweenSteps`.

## function MIN_BLOCKS_LO

Constant `1`. Lower bound for `setMinBlocksBetweenSteps`. Load-bearing for
reentrancy safety: it guarantees a same-tx reentrant `executeStep` reverts
`StepTooEarly`.

## function adminContract

The `ProtocolAdmin` contract gating the two parameter setters. Immutable,
set at construction.

## function hook

The official pool's V4 hook address, used in the pool key. Zero until
`setup` runs.

## function lastStepBlock

Block number of the most recent `executeStep`. Combined with
`minBlocksBetweenSteps` to pace steps.

## function maxSlippageBps

Constant `500`. The per-call price-impact cap in basis points (5%), applied
through the swap's `sqrtPriceLimitX96`. Compile-time constant with no
setter. When the limit binds, V4 partial-fills the swap and the unspent ETH
stays queued.

## function maxStepWei

Current ETH ceiling for a single step's swap. Admin-tunable within
`[0.01, 10]` ETH until the 1-year lock.

## function minBlocksBetweenSteps

Current minimum block delta between steps. Admin-tunable within
`[1, 50_400]` until the 1-year lock.

## function nextExecutableBlock

The earliest block at which `executeStep` will succeed:
`lastStepBlock + minBlocksBetweenSteps`. Keepers should compare against the
current block number before submitting.

## function poolFee

The V4 pool fee field used in the pool key. May be a dynamic-fee sentinel;
the actual fee is read from the hook at swap time. Immutable.

## function poolKey

The full V4 `PoolKey` for the official pool (`currency0` = native ETH,
`currency1` = the $111 token, plus fee, tick spacing, and hook). Useful for
off-chain tooling that reads pool state directly.

## function poolManager

The V4 singleton PoolManager. Immutable.

## function poolTickSpacing

The V4 pool tick spacing used in the pool key. Immutable.

## function quoteStepAmount

ETH that would be drawn by the next step, including the caller-reward share:
`min(remainingEth, maxStepWei)`. Zero means `executeStep` would revert
`NothingToBurn`.

## function remainingEth

ETH queued for swap and burn. Credited by every inflow through `receive()`,
debited by each step's actual spend, and re-credited with the reward share
on the rare failed reward send. Tracks `address(this).balance`.

## function setupFinalized

Whether `setup` has run and permanently closed the one-shot wiring gate.
Off-chain tooling should confirm this is `true` before treating `token` and
`hook` as permanent.

## function token

The $111 token address. Zero until `setup` runs. The burn target: after
each swap the contract calls `burn` on this token with everything received.

## function totalEthBurned

Monotonic counter of total ETH ever spent on swaps (excludes the
caller-reward share).

## function totalTokensBurned

Monotonic counter of total $111 ever delivered to `burn`.

## event BurnEthDeposited

Emitted on every ETH inflow through `receive()`. `source` (indexed) is the
sender, `amount` the deposit, `remainingEth` the queue balance after the
credit. Indexers can attribute inflows by source: the return-auction module
(cleared settles), `VaultBurnPool` (sweeps), or anything else (direct
top-ups).

## event ExecutionRewardFailed

Emitted when the caller-reward send fails. The reward ETH is credited back
to `remainingEth`, so nothing leaves accounting; the burn itself already
succeeded. `caller` is the `executeStep` sender, `amount` the unsent reward.

## event ExecutionRewardPaid

Emitted when the caller reward is sent successfully. `caller` (indexed) is
the `executeStep` sender, `amount` the ETH paid (pro-rated on a partial
fill).

## event Finalized

Emitted exactly once, when `setup` completes and permanently closes the
one-shot wiring gate.

## event ParameterChanged

Emitted by both setters. `key` (indexed) is the parameter name as a
`bytes32` string (`"minBlocksBetweenSteps"` or `"maxStepWei"`), with the
old and new values.

## event TokensBurned

Emitted on every successful step. `ethSpent` is the ETH actually consumed
by the swap (may be less than the step size on a partial fill),
`tokensBurned` the $111 delivered to `burn`, `remainingEth` the queue
balance after the debit. The canonical event for tracking burn progress.

## error AlreadyFinalized

`setup` was called after the one-shot gate closed. The wiring is permanent;
there is no retry.

## error ExcessInputSpent

The V4 swap reported more ETH consumed than the exact-input amount
requested. Defends against a hook with return-delta permissions bypassing
the per-step ETH cap; never raised against an honest pool.

## error InSwap

A decorated function was entered during an authorized extension's swap
window (`PCSwapContext.inSwap`). Unreachable while no extension is bound.

## error InsufficientOutput

The swap returned fewer tokens than the caller's `minOut`. Retry with a
lower `minOut` or wait for better pool conditions; the fixed 5% impact cap
still protects the protocol when `minOut` is 0.

## error NotAdmin

A parameter setter was called by an address that fails
`ProtocolAdmin.checkAdmin`, or after the 1-year admin lock.

## error NotDeployer

`setup` was called by an address other than the deployer captured at
construction.

## error NotPoolManager

`unlockCallback` was called by any address other than the V4 PoolManager.

## error OutOfBounds

A setter received a value outside its hard bounds. Carries the rejected
`value` plus the `lo` and `hi` of the allowed range.

## error NothingToBurn

`executeStep` was called with `remainingEth == 0`. Wait for the next inflow;
`quoteStepAmount()` returning nonzero means this won't fire.

## error StepTooEarly

`executeStep` was called before `lastStepBlock + minBlocksBetweenSteps`.
Carries `nextBlock`, the earliest block at which the call will succeed. Also
the guard that makes a same-tx reentrant `executeStep` revert.
