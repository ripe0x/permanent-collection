---
title: The $111 token
description: The protocol's ERC20, its official pool, the swap skim, and the venue-scoped transfer tax.
---

# The $111 token

`{{addr:token}}` ·
[view on evm.now](https://evm.now/token/{{addr:token}}?chainId=1)

The protocol's ERC20. Name `permanent collection`, symbol `111`, total supply
1,110,000,000 (fixed at deploy; burns only reduce it). Deployed through the
artcoins factory as an `ArtCoinsToken` instance, paired with native ETH in a
Uniswap V4 pool (the official pool), with 100% of supply placed as locked
liquidity across 14 tick ranges at launch.

The token has no governance. Holding it grants no control over any protocol
contract.

## The official pool

The canonical V4 pool is native-ETH-paired and carries the
[skim hook](/docs/contracts/skim-hook). Its pool id is listed on
[Addresses](/docs/introduction/addresses). Swaps in this pool are what fund
the protocol: the hook skims 6% of volume per swap and routes it to the live
bid, the protocol leg, and referral attribution in the same transaction.

The LP fee is 0.5%, separate from the skim, and accrues to in-range liquidity
per standard V4 mechanics. The launch liquidity is held by a locker whose fee
recipient is permanently set to
[LiveBidAdapter](/docs/contracts/live-bid-adapter), so LP fees from the
locked positions also fund the live bid. Anyone may mint additional LP
positions and earns the LP fee pro-rata.

## Where burns come from

$111 is burned (sent to `0xdead` or destroyed via `burn`, reducing
`totalSupply`) on three paths:

- [BuybackBurner](/docs/contracts/buyback-burner) swaps accumulated ETH for
  $111 in the official pool and burns it, in permissionless paced steps
- [VaultBurnPool](/docs/contracts/vault-burn-pool) burns the transfer-tax
  proceeds it accrues (see below) every time a return auction settles by
  vaulting
- Cleared return auctions route 25% of the protocol's cost basis to
  BuybackBurner for the same buy-and-burn path

## Venue-scoped transfer tax

The token carries a buy-side transfer tax that exists to keep trading
concentrated in the official pool, whose skim funds the protocol. Current
rate: 15% (`taxBps = 1500`), bounded by a structural 20% maximum
(`TAX_BPS_ABSOLUTE_MAX = 2000`) that no role can exceed.

When it fires:

- Only on $111 **leaving a known venue** (the V4 PoolManager or one of 44
  precomputed V2/V3 pool addresses for WETH/USDC/USDT/DAI pairs) **to a
  non-exempt recipient**. In practice: buys in unofficial pools
- Never on transfers into a venue (sells and LP adds), never on
  wallet-to-wallet transfers, never on lending/bridge/CEX flows

Buys in the official pool are exempt through a hook-attested budget: the skim
hook attests the exact $111 amount leaving the canonical pool each swap, and
the token waives the tax against that budget. The budget lives in transient
storage and clears at the end of each transaction.

Tax proceeds accrue as $111 in [VaultBurnPool](/docs/contracts/vault-burn-pool)
and are burned there. They're never sold and never fund the bid; the bid is
fed by the routing shift toward the official pool, not by the tax itself.

The rate is tunable within `[0, 2000]` bps via
[TokenAdminPoker.setTokenTaxBps](/docs/contracts/token-admin-poker), a
two-key carve-out that survives the admin lock until both roles are burned.

## Token admin

The ERC20's `tokenAdmin` role is held by
[TokenAdminPoker](/docs/contracts/token-admin-poker), a protocol contract
whose owner-gated surface is limited to: binding (and permanently locking) a
future pool extension, tuning the referral cap on the hook, and tuning the
transfer-tax rate within its bounds. There is no mint function, no pause, no
blacklist, and no upgrade path anywhere in the token.

## Reading token state

```bash
cast call {{addr:token}} "totalSupply()(uint256)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:token}} "taxBps()(uint16)" --rpc-url https://ethereum-rpc.publicnode.com
cast call {{addr:token}} "balanceOf(address)(uint256)" 0x000000000000000000000000000000000000dEaD --rpc-url https://ethereum-rpc.publicnode.com
```

The dead-address balance plus the supply delta from `burn` calls gives the
total burned to date; the [indexer](/docs/offchain/indexer) tracks burn steps
and tax burns as first-class tables.
