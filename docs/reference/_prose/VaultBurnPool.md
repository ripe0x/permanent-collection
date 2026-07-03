---
contract: VaultBurnPool
slug: vault-burn-pool
deploymentsKey: vaultBurnPool
title: VaultBurnPool
---

# summary

Burn accumulator released on every vault-path settle. The pool holds two
assets. First, ETH: `ReturnAuctionModule.settle` forwards the vault-burn
share of every cleared return auction here (the full clearing premium net of
any auction referrer share, plus 10% of the acquisition cost), and anyone can
top it up through `receive()`. Second, the $111 token: this contract is the
token's venue-scoped transfer-tax `burnAddress`, so tax charged on $111
leaving a known side-pool venue accrues here as a token balance.

Both assets release on one trigger. When a return auction ends with no
clearing bidder and the Punk enters the vault, `ReturnAuctionModule` calls
`sweep()`: the accrued $111 is burned in place via `token.burn` (a direct
total-supply reduction, never a transfer out), then the ETH balance is
forwarded to `BuybackBurner` to fund its paced buy-and-burn. So the pool acts
exactly when the protocol permanently collects a new trait, and the longer a
vault outcome takes, the larger the single-step impulse it delivers.

There is no admin and no withdrawal path. The only configurable surface is
the one-shot `setup(token)` that wires the $111 token address after the token
deploys (the token needs this pool's address at construction, so the pool
can't pin the token as an immutable). The only ETH outflow is `sweep()` to
the immutable `buybackBurner`; the only $111 outflow is the burn.

# concepts

### Two legs, one trigger, strict ordering

`sweep()` runs the $111 leg first and treats it as required: burning the
contract's own balance can't revert, so the side-pool tax burn is guaranteed
to complete on every vault-path settle. The ETH leg runs second and is
best-effort: if the forward to `BuybackBurner` fails, the ETH simply stays in
the pool for the next sweep instead of reverting. That construction makes
`sweep()` non-reverting for its one authorized caller, which is why
`ReturnAuctionModule.settle` calls it directly with no `try/catch`. A direct
call means gas estimation must always provision the burn, so it can't be
silently skipped, and a failed ETH forward can never block a Punk's
settlement into the vault.

### Where the balances come from

The ETH side accumulates from cleared return auctions: on each cleared
settle, `ReturnAuctionModule` sends `(highBid - cost)` minus any auction
referrer share, plus `cost x 1_000 / 10_000`, to this pool. Direct sends to
`receive()` add to the same balance and compound the next vault outcome's
impulse.

The $111 side accumulates passively. The token's transfer-tax logic sends
tax proceeds to its configured `burnAddress`, which is this pool. Until
`setup` wires the token address, the pool doesn't know about the token and
`sweep` runs as a pure-ETH forwarder; any $111 that accrued in the meantime
burns on the first sweep after wiring.

### Reading the pool

```bash
# ETH pending for the next vault-path sweep (wei)
cast call {{addr:vaultBurnPool}} "balance()(uint256)" \
  --rpc-url https://ethereum-rpc.publicnode.com

# accrued $111 awaiting burn
cast call {{addr:token}} "balanceOf(address)(uint256)" {{addr:vaultBurnPool}} \
  --rpc-url https://ethereum-rpc.publicnode.com
```

## function sweep

access: returnAuctionModule-only (any other caller reverts `NotReturnAuctionModule`)

Releases both legs. Step one, the $111 burn: if `token` is wired and the
pool holds a non-zero $111 balance, the full balance is burned via
`token.burn` (total supply drops) and `SidePoolTaxBurned` is emitted. Step
two, the ETH forward: the full ETH balance is sent to `buybackBurner`; on
success `Swept` is emitted and the amount is returned as `forwarded`, on
failure the ETH stays put and `forwarded` is `0`. The function never reverts
for its authorized caller, by construction: the burn can't fail, the forward
is best-effort, and there is no `nonReentrant` mutex because the only
external calls go to the immutable, trusted token and burner. Decorated
`notInSwap` (a no-op unless a Design B extension is ever bound). Called by
`ReturnAuctionModule.settle` on every vault-path outcome; not callable by
anyone else, including the deployer.

## function setup

access: deployer one-shot (`onlySetup`: deployer-only until finalized, then closed forever)

Wires the $111 token whose transfer-tax proceeds burn here. Callable once,
by the deployer captured at construction; reverts `ZeroAddress` for a zero
token, `NotDeployer` for any other caller, and `AlreadyFinalized` after the
first successful call (which emits `Finalized` and closes the gate
permanently). Exists because the token is deployed after this pool with this
pool's address as its tax `burnAddress`, a cycle an immutable couldn't
express. Until it runs, the $111 burn leg of `sweep` is a no-op.

## receive

access: permissionless

Accepts ETH from any sender. The routine inflow is `ReturnAuctionModule`
forwarding the cleared-path vault-burn share, but direct top-ups from anyone
are accepted and simply enlarge what the next vault-path `sweep` forwards to
`BuybackBurner`. No state mutation and no event, to keep the settle path
cheap. ETH sent here is not recoverable by the sender; its only exit is the
next sweep.

## function balance

Current ETH balance in wei, equivalent to what the next `sweep` would
attempt to forward to `BuybackBurner`. The accrued $111 side isn't covered
by this view; read `balanceOf(pool)` on the token for that.

## function buybackBurner

The immutable `BuybackBurner` address that receives every swept ETH balance.
Set at construction, never changes.

## function returnAuctionModule

The immutable `ReturnAuctionModule` address, the only account allowed to
call `sweep`. Set at construction, never changes.

## function setupFinalized

Whether the one-shot `setup` has run. `true` means `token` is wired
permanently and the setup surface is closed; `false` means the $111 burn leg
is still dormant and the deployer can still call `setup`.

## function token

The $111 token wired by `setup`, whose venue-tax proceeds accrue here and
burn on each vault-path sweep. `address(0)` until `setup` runs.

## event Finalized

Emitted exactly once, by the successful `setup` call. After this event the
pool's wiring is permanent; off-chain tooling can treat `token` as final.

## event SidePoolTaxBurned

Emitted on each `sweep` that burned a non-zero accrued $111 balance, with
the amount burned. Each occurrence is a real total-supply reduction of the
$111 token, so an indexer can sum these for the tax-burn contribution to
cumulative supply reduction, distinct from `BuybackBurner`'s buy-and-burn.

## event Swept

Emitted on each `sweep` whose ETH forward to `BuybackBurner` succeeded, with
the amount forwarded. A sweep with a zero ETH balance, or one whose forward
failed (balance retained for next time), emits no `Swept`.

## error AlreadyFinalized

`setup` was called after it already ran once. The token wiring is permanent;
there's nothing further to configure.

## error InSwap

A `notInSwap`-decorated function was entered while `PCSwapContext` reports a
swap in progress. Unreachable at launch (no authorized extension is bound,
so the flag is permanently false); relevant only if a Design B extension is
ever activated.

## error NotDeployer

`setup` was called by an address other than the deployer captured at
construction. Only the deployer can perform the one-shot wiring.

## error NotReturnAuctionModule

`sweep` was called by an address other than the immutable
`returnAuctionModule`. The release trigger is vault-path settlement only;
there is no permissionless or admin sweep.

## error ZeroAddress

Raised by the constructor for a zero module or burner address, and by
`setup` for a zero token address. Never reachable on the live deployment's
constructor path.
