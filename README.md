# PERMANENT COLLECTION

> 111 Punk traits. One permanent collection. One public bid.

An on-chain artwork that uses a speculative ERC-20 to build an immutable public collection of CryptoPunks via full-trait coverage. There's no deadline: the work completes only when all 111 CryptoPunks traits are represented by vaulted Punks, or settles into an equilibrium where the remaining traits are held by owners who refuse the live bid.

**Live on Ethereum mainnet.** Every protocol contract is deployed, immutable, and source-verified on Etherscan; the canonical address snapshot is [contracts/deployments.mainnet.json](contracts/deployments.mainnet.json). The `111` artcoin, its native-ETH-paired Uniswap V4 pool, and the LP locker were launched through the [artcoins](https://github.com/ripe0x/artcoins) protocol on a fresh stack deployed for this launch.

The trait vocabulary comes from the live, sealed [`PunksData`](https://etherscan.io/address/0x9cf9c8ea737a7d5157d3f4282ace30880a7a117c) contract (ENS: `punksdata.eth`): 5 normalized Punk types, 11 head variants, 8 attribute counts, 87 accessories. **Acquisition is not permanence.** A trait only counts toward the Full Set when a Punk carrying it enters the immutable vault.

MIT licensed ([LICENSE](LICENSE)).

## Reading this repo

- Start with [docs/SYSTEM.md](docs/SYSTEM.md), the canonical system overview
- Building on the protocol (referral attribution, contributions, the callback surface): [docs/COMPOSABILITY.md](docs/COMPOSABILITY.md)
- Security research: [SECURITY.md](SECURITY.md) for private reporting, [docs/SECURITY.md](docs/SECURITY.md) for the trust model
- This repository is the public, published snapshot of the working repo's `master` branch — each change to `master` lands here as a clean snapshot commit; the full development history lives in the private working repo. Issues and PRs are welcome here; [CONTRIBUTING.md](CONTRIBUTING.md) explains how changes flow

## Acquisition model

The protocol posts a single global ETH **live bid**. Any owner of a Punk carrying an uncollected trait can accept it; the Punk then enters a 72-hour return auction. Two entry paths, both on `Patron` (the live-bid hub):

- **`acceptBid(punkId, targetTraitId, expectedListingWei)`**: the owner lists the Punk exclusively to `Patron` at a real positive price up to the current live bid (`offerPunkForSaleToAddress(punkId, listingWei, patron)`, never 0), then anyone finalizes via `acceptBid`. The protocol buys the listing through the CryptoPunks market, so the seller is paid the listed price and collects it with the market's `withdraw()`
- **`acceptListing(punkId, targetTraitId)`**: accepts an allowlisted seller's public listing priced at or below the live bid; the caller earns a bounded finder fee

The recorded target trait is protocol-derived, not caller-chosen: `PermanentCollection.recordAcquisition` enforces that the target equals `canonicalTargetOf(punkId)`, the rarest uncollected, non-pending trait the Punk carries. Callers pass the value as a verified expectation.

## Return auction

Every acquired Punk enters a 72-hour return auction.

- **Reserve** = `acquisitionCost × (101 + previousAttempts) / 100`, snapshotted at auction start (a 1% reserve premium per prior attempt against the same trait; first attempt = 1.01×)
- **Anti-snipe**: a bid in the final 15 minutes extends the auction by 1 hour, uncapped; an actively contested Punk stays in bidding indefinitely
- **Returned** (high bid ≥ reserve): the Punk goes to the bidder via a `ReturnAuctionEscrow` provenance round-trip, so the canonical CryptoPunks market emits a real `PunkBought` at the hammer price. Proceeds split, hard-coded with no setter: **65% of cost refills the live bid** (through `LiveBidAdapter.poolReplenish`, buffered and metered in), **25% of cost goes to `BuybackBurner`**, **10% of cost plus the premium above cost goes to `VaultBurnPool`**, less a fixed 5% slice of the premium to the winning bid's referrer when one is attributed (`placeBidWithReferral`; fail-closed). Traits do not become permanent
- **Not returned**: the Punk enters the immutable `PunkVault` and **only the recorded target trait** becomes permanent (other uncollected bits on the Punk's mask stay available for future acquisitions). The settle also sweeps `VaultBurnPool` to `BuybackBurner`, burns any transfer-tax `111` accrued in the pool (real supply reduction), and mints a **Proof** from `PunkVault` to the seller-of-record when the vaulting brought a previously-uncollected trait in

`PunkVault` issues **112 named ERC-721 objects**: the **Vault Title** (token id 111, the singular title record for the work, auctioned via `PunkVaultTitleAuction` once 22 traits are permanent) and the **111 Proofs** (token ids 0..110, token id = trait id, each minted at vault-settle to the seller whose Punk brought that trait permanently into the collection). The Title names the steward of the work; it grants no withdrawal rights, no admin control, and no claim on the Punks. The vault has no withdrawal function; bytecode-scan tests assert the absence of every CryptoPunks market write selector.

## Fee loop (three-leg hook split)

Trader ETH pays a 6% baseline skim per swap, split at swap-time inside `ArtCoinsHookSkimFee` (no separate per-swap extension contract):

```
swap fee →   ~83.33% → LiveBidAdapter   (+ 100% of the MEV-window overage)
             ~16.67% → ProtocolFeePhaseAdapter → PCController
                       (86.67% PC treasury / 13.33% LAYER burn), from block 1
           ≤0.25% of volume → ReferralPayout (per-referrer ledger, pulled FROM
                              the protocol slice; paid from the first swap)
```

Per 1 ETH of swap volume: **5.00% → live bid / 1.00% → protocol leg / ≤0.25% → referrer if attributed**. The separate 0.5% LP fee distributes pro-rata to in-range V4 liquidity; at launch the conversion locker holds all 14 LP positions and forwards its share to `LiveBidAdapter` via a single reward slot (admin = `0xdEaD`, recipient permanently locked). `ArtCoinsMevLinearSkim` elevates the skim during the first ~30 minutes after pool init (90% decaying to the 6% baseline); the overage routes 100% to the live-bid leg.

`LiveBidAdapter` is the single inflow governor: every ETH source that funds the live bid (the skim, attributed contributions, bare top-ups, the 65% refund from returned auctions) enters the adapter and meters into `Patron` via `sweep()`. `Patron.receive()` accepts ETH only from the adapter.

The `111` token also carries a **venue-scoped buy-side transfer tax** (15% at launch, hard-capped at 20%) that fires only when `111` leaves a side trading venue on a buy. The official pool is hook-exempted; sells, wallet/Safe/4337 sends, lending, bridges, and CEX transfers are never taxed. Proceeds accrue in `VaultBurnPool` and burn each time the protocol vaults a Punk. It removes the routing discount to trade off-canonical, feeding the live bid indirectly. See [docs/TRANSFER_TAX_INVESTIGATION.md](docs/TRANSFER_TAX_INVESTIGATION.md).

`VaultBurnPool` has no trading-fee leg: its only ETH inflow is the returned-auction proceeds split above, swept to `BuybackBurner` on each vault-path settle. `BuybackBurner.executeStep` is permissionless and paced; it swaps ETH for `111` and sends it to `0xdead`.

## Direct contribution

`LiveBidAdapter.contribute(referrer, tag)` is the canonical on-chain destination for capital flows that want to align with Permanent Collection. NFT launchpads, wallet widgets, and public-goods aggregators can route a portion of mint proceeds or user contributions through it; the referrer receives a fixed 5% slice, and the remainder buffers into the live bid. Plain `receive()` top-ups work for unattributed sends. Fail-closed: no referrer, or a reverting send, keeps 100% buffered for the live bid.

## Trait states

| State | Meaning | Counts toward completion? |
|---|---|---|
| **Uncollected** | No vaulted Punk carries the trait. | No |
| **In return auction** | An in-flight Punk carries it as its target; outcome undecided. | No |
| **Permanent** | At least one vaulted Punk carries it. Final. | Yes |

`FULL SET COMPLETE` triggers only when `collectedMask == FULL_SET_MASK` (all 111 bits via vaulted Punks).

## Layout

```
contracts/          Foundry project — Solidity protocol + mainnet-fork tests
  src/              core:    PermanentCollection, PunkVault, Patron,
                             ReturnAuctionModule, ReturnAuctionEscrow,
                             BuybackBurner, ProtocolAdmin
                    fees:    LiveBidAdapter, VaultBurnPool,
                             ProtocolFeePhaseAdapter, ReferralPayout,
                             TokenAdminPoker
                    composability: PCSwapContext + libraries/PCNoReentry
                    render:  PermanentCollectionMosaicRenderer,
                             PermanentCollectionProofRenderer, RendererRegistry,
                             PunkSvgFragmentCache, TraitIconCache,
                             PunkVaultTitleAuction
  test/             Mainnet-fork tests (no mocks); run `forge test --list`
                    for the current count
  script/           Deploy.s.sol (full one-broadcast deployment) +
                    DeployArtcoinsLaunchStack.s.sol (the artcoins stack)
  lib/artcoins/     artcoins launcher (git submodule, pinned)

app/                Next.js 15 (App Router) frontend
indexer/            Ponder indexer (protocol events → GraphQL)
scripts/            TS pipeline tools (trait snapshot, ABI generation,
                    local-fork seeding)

docs/               docs/SYSTEM.md is the canonical reader doc;
                    docs/PROTOCOL.md is the protocol spec
```

## Quickstart (local fork)

`contracts/lib/artcoins` is configured with `update = none`, so a plain recursive submodule init skips it. Check it out explicitly to build the contracts:

```bash
git submodule update --init --recursive
git submodule update --init --recursive --checkout contracts/lib/artcoins
```

Then:

```bash
# 1. Install
pnpm install

# 2. (one-time) Snapshot trait data from PunksData
export MAINNET_RPC_URL="https://ethereum-rpc.publicnode.com"   # or your own
pnpm snapshot:punksdata

# 3. Build + test contracts against the mainnet fork
pnpm test:contracts

# 4. Start a local fork
pnpm fork:start &

# 5. Deploy the protocol via the artcoins factory
pnpm deploy:fork
pnpm seed:fork

# 6. Generate ABIs and start the frontend
pnpm generate:abis
pnpm app:dev
```

Open http://localhost:3000. The first contracts build is heavy (via-IR, roughly 15 minutes cold); incremental builds are fast.

## Environment

See `.env.example`. Required:

- `MAINNET_RPC_URL`: for fork tests and the trait snapshot. Free public RPCs (e.g. `https://ethereum-rpc.publicnode.com`) work for the full suite
- `PRIVATE_KEY`: only for an actual mainnet deploy; the fork accepts anvil's default key
- `ETHERSCAN_API_KEY`: optional, for contract verification
- `NEXT_PUBLIC_*`: populated by `pnpm deploy:fork`

## Trait data integrity

PERMANENT COLLECTION never deploys its own trait dataset. It reads masks from the sealed PunksData contract at `0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C`. `PermanentCollection`'s constructor pins the expected dataset hash (`0x92117ce6…`) and reverts if the on-chain value doesn't match, so the artwork can't bind to a different taxonomy.

## Tests

```bash
cd contracts && forge test -j 4
```

All suites run against a mainnet fork on a public RPC (no archive node required). Run `forge test --list` for the current count. Coverage highlights:

- `LaunchInvariantFork.t.sol`: adversarial fork tests against the live-deployed `Deploy.s.sol` bytecode; every permanence-critical invariant probed
- `PermanentCollection.t.sol` / `PunkVault.t.sol`: pending vs collected state model; bytecode scans assert no CryptoPunks market-write selectors
- `Patron.t.sol`: bytecode scan asserts no admin withdrawal path
- `ReturnAuction` suites: reserve formula, the 65/25/10 returned-path split, 15-min/+1h uncapped anti-snipe
- `TaxedTokenForkTest.t.sol`: the venue-scoped transfer tax against live factory-derived venue addresses
- `Invariants.t.sol` / `Fuzz.t.sol`: monotonic `collectedMask`, append-only acquisitions, pending-count accounting, reserve/finder-fee fuzzing

## Docs

- **[docs/SYSTEM.md](docs/SYSTEM.md)**: canonical system overview (start here)
- **[docs/reference/](docs/reference/)**: API-style protocol reference — every contract, function, event, and error, with access control and worked examples (served on the site at `/docs`)
- [docs/PROTOCOL.md](docs/PROTOCOL.md): protocol mechanism + state machine
- [docs/SECURITY.md](docs/SECURITY.md): trust model + reentrancy posture
- [docs/COMPOSABILITY.md](docs/COMPOSABILITY.md): building on top (Design A + B)
- [docs/DISPATCHER_DESIGN.md](docs/DISPATCHER_DESIGN.md): PCDispatcher mechanic (Design B)
- [docs/METADATA_REFERENCE.md](docs/METADATA_REFERENCE.md): on-chain metadata routing
- [docs/TRANSFER_TAX_INVESTIGATION.md](docs/TRANSFER_TAX_INVESTIGATION.md): venue-scoped transfer-tax design
- [docs/MISSION_PROPERTIES.md](docs/MISSION_PROPERTIES.md): mission / liveness properties
- [docs/RUN_LOCAL.md](docs/RUN_LOCAL.md): local dev (anvil setup, seeding, walkthrough)
- [docs/ARTCOINS_PIN.md](docs/ARTCOINS_PIN.md): artcoins submodule pin + how to verify it
