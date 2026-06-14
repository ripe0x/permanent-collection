# Run it all locally — fork + both sites + simulated activity

How to bring up the **local mainnet fork**, both front-ends (PERMANENT
COLLECTION + artcoins), and the **trading / protocol-activity simulators** so
you can exercise the whole three-leg flywheel in the UIs.

## Prerequisites

- Foundry (`forge`, `anvil`, `cast` ≥ 1.5.0)
- pnpm 9+
- An Ethereum mainnet RPC URL for the fork upstream. Free public RPCs
  (`https://ethereum-rpc.publicnode.com`, the Tenderly public gateway)
  work for everything below; an archive endpoint is only required if you
  pin a historical `FORK_BLOCK` for cache compounding.
- Submodules initialized: `git submodule update --init --recursive`. The
  artcoins submodule at `contracts/lib/artcoins` is required for the three-leg
  hook source.

---

## Quickest path — one command

```bash
cd /Users/dd/CascadeProjects/permanent-collection
pnpm dev:up
```

`pnpm dev:up` (= `./scripts/dev-up.sh`) brings up **everything** and prints the
links. It runs the fork + full deploy + flywheel, starts the PERMANENT
COLLECTION front-end (`:3000`) and the artcoins front-end (`:3001`) in the
background, waits for them to boot, then prints:

```
  PERMANENT COLLECTION
    home          http://localhost:3000
    trade (111)   http://localhost:3000/trade
    collection    http://localhost:3000/collection
  artcoins
    home          http://localhost:3001
    111 token     http://localhost:3001/<token-address>
  WALLET / RPC
    network       http://127.0.0.1:8545   (chainId 31337)
  + simulate-activity commands, log paths, and the stop command
```

anvil + both front-ends run in the background (logs in `/tmp`); the command
returns once the links are live. Knobs:

| Env | Default | Effect |
|---|---|---|
| `SIMULATE=1` | off | also start the trading-sim loop (live bid grows on its own) |
| `NO_FORK=1` | off | reuse the running fork — just (re)start the front-ends |
| `FORK_BLOCK` | latest cached | pin the fork block for a warm cache |
| `PC_PORT` / `ARTCOINS_PORT` | `3000` / `3001` | front-end ports |
| `ARTCOINS_DIR` | `../artcoins` | artcoins repo location |
| `PRELAUNCH=1` | off | **launch-flow demo** — see below |

### Launch-flow demo (`PRELAUNCH=1`)

Rehearses **what's actually left to launch**. Phase 2a (all PC contracts) is
already deployed on mainnet, so this forks the real post-2a state — the live
Phase-1 artcoins stack AND the live PC contracts are already on the fork at their
real addresses. The **only remaining deploy is the token** (Phase 2b), launched
the same way mainnet will: `runToken()` signed AS the live owner (`0xCB43…`),
which the fork unlocks via anvil impersonation.

> The prelaunch fork runs at **chainId 31337** (the standard local chain both
> frontends connect to). `launch:fire` signs 2b as the impersonated owner by
> setting `UNLOCKED_SENDER=true`, which tells `Deploy.s.sol` to honour the
> `--sender` CLI signer on a 31337 fork instead of its anvil-key default. No
> MetaMask "chainId in use" friction.

Two commands: the first brings the site up in the pre-launch state with the real
mainnet addresses pre-baked (token = the deterministic CREATE2 address, no code
yet); the second launches the token so you can watch the site auto-flip live (no
env change, no rebuild — the client `eth_getCode` picks up the new bytecode).

```bash
PRELAUNCH=1 pnpm dev:up        # site on :3022, mainnet fork on :8545, token NOT launched
pnpm launch:fire               # in another terminal — launches ONLY the token (Phase 2b)
# Refresh the browser → site flips to live.
```

(`pnpm launch:contracts` still exists but is for a from-scratch fork only — 2a is
already on mainnet, so the live-2a flow never re-deploys it.)

What you'll see:

| Surface | Before `launch:fire` | After `launch:fire` |
|---|---|---|
| Homepage / Header | "NOT LAUNCHED", "0 ETH" | "LIVE BID 0 ETH", "CONNECT WALLET" |
| `/trade` swap CTA | "Not launched yet" (disabled) | "Connect wallet" → real swap |
| `/contracts` rows | Protocol rows muted as "not deployed yet"; external (Punks/V4) links live | All rows linked to evm.now |
| Dexscreener link (footer) | Hidden | Visible |

**How it works** (single anvil session, no restart): fork mainnet at chainId 31337 →
confirm the live Phase-1 + 2a contracts have code → copy the committed snapshot
(`contracts/deployments.mainnet.json`) → `contracts/deployments.json` (token=0)
→ impersonate the live owner (`0xCB43…`) → write the real PC addresses to
`app/.env.local` as `PC_*` runtime vars (token = the deterministic 2b address) →
start app. The Phase-1 addresses are also written to `contracts/prelaunch-state.json`
so `launch:fire` can pass them to `runToken()`, which deploys the token + runs the
`setup()` wiring against the live 2a, signed as the impersonated owner. `FORK_BLOCK`
defaults to mainnet tip − 500; override with `FORK_BLOCK=<n> PRELAUNCH=1 pnpm dev:up`
(must be ≥ the Phase-2a deploy block 25270213).

Stop everything:

```bash
pkill -x anvil ; lsof -ti tcp:3000 -i tcp:3001 | xargs kill
```

The prelaunch fork runs on one anvil session (**chainId 31337**, port **8545**);
addresses are the real mainnet ones, so env is configured once.

Prefer to run the pieces yourself — or want to know exactly what `dev:up`
does? The sections below are those same steps, à la carte.

---

## 1. Fork + deploy (the fork piece)

```bash
cd /Users/dd/CascadeProjects/permanent-collection
FORK_BLOCK=25145000 pnpm fork:start          # = ./scripts/start-dev-fork.sh
```

What it does, in order:

1. Kills any anvil already on the port.
2. Starts a fresh fork — chainId `31337`, port `8545`, `--base-fee 0`,
   `--gas-limit 1000000000`, `--disable-code-size-limit`, upstream =
   Tenderly public gateway.
3. Funds the dev wallet (`0xCB43…17F9`) with 10k ETH.
4. Deploys a **local `ArtCoinsMevLinearFees`** (the canonical mainnet one has
   no code on the fork) via CREATE2 — stable address every run.
5. Deploys the **conversion locker** (`ArtCoinsLpLockerFeeConversion`) and
   allowlists it on the factory + escrow.
6. Runs `Deploy.s.sol` — the full `111` stack (token, pool, Patron,
   ReturnAuctionModule, PunkVault, BuybackBurner, adapters, renderer, …).
7. Warps past the 30-min MEV anti-sniper window so swaps see the static
   6% baseline skim. Prints `stack live ✓`. Pool extension stays
   unbound — the three-leg fee split is performed by the hook itself,
   no per-swap dispatcher needed at launch.

Notes:
- **`FORK_BLOCK`** — pinning a block lets Foundry's RPC cache compound across
  runs (free reads). Omit it and the script auto-picks the most-recent cached
  block. First-time / cold cache: pass a recent block explicitly (anvil fetches
  it from Tenderly and caches), or run `./scripts/warm-fork-cache.sh` first.
- **Bare fork (no deploy):** `NO_DEPLOY=1 pnpm fork:start`.
- **Different upstream:** `UPSTREAM=https://your-archive-rpc pnpm fork:start`.
- Re-running it is the way to **reset to a pristine state** (live bid = 0).

## 2. Site #1 — PERMANENT COLLECTION → http://localhost:3000

```bash
cd /Users/dd/CascadeProjects/permanent-collection
pnpm app:dev                                  # next dev --turbopack
```

- Reads `app/.env.local` — already wired to the fork (`NEXT_PUBLIC_CHAIN_ID=31337`,
  `RPC_URL=http://127.0.0.1:8545`, live data adapter, contract addresses).
- Addresses are **deterministic** across reforks (same deployer nonce at the
  same `FORK_BLOCK`), so `app/.env.local` does **not** need re-syncing after a
  refork. If you ever change the deploy or fork block, re-sync it from
  `contracts/deployments.json`.
- **Wallet picker (RainbowKit)** needs `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
  in `app/.env.local` — any placeholder works locally (MetaMask / injected
  still connect; only WalletConnect-backed wallets like Rainbow mobile and
  Coinbase Wallet mobile need a real id). Get one at
  [cloud.walletconnect.com](https://cloud.walletconnect.com) before mainnet.

## 3. Site #2 — artcoins → http://localhost:3001

```bash
cd /Users/dd/CascadeProjects/artcoins
PORT=3001 npm run dev                         # explicit PORT — both default to 3000
```

- artcoins uses **npm** (not pnpm) and `next dev` (no built-in port), so set
  `PORT` explicitly to avoid colliding with the PC site on 3000.
- Reads `.env.development.local`, which points its foundry transport at the
  fork (`NEXT_PUBLIC_FOUNDRY_RPC_URL`, `NEXT_PUBLIC_MAINNET_RPC_URL`) and adds
  the foundry chain to the wallet picker.
- **Check `NEXT_PUBLIC_FOUNDRY_MEV_LINEAR_OVERRIDE`** = the local MEV module
  `0x7b215A58d0EF39055C47D002789a206Fd348D0B5` so the anti-sniper banner
  resolves. It's a CREATE2 address — **stable across reforks**, so set it once.

## 4. Simulate activity

### Trading — live bid drifts up while you watch

```bash
cd /Users/dd/CascadeProjects/permanent-collection
pnpm tsx scripts/simulate-trading-loop.ts
```

Daemon that re-runs `SimulateTrading.s.sol` on an interval. Each pass does
~60 trades; with the per-swap flywheel each trade collects → converts →
sweeps, so `Patron.bountyBalance` (function name follows the deployed ABI;
semantically the live bid) climbs. Visible live on the PC homepage /
`/trade` "live bid" stat. `Ctrl-C` to stop.

Env knobs (all optional):

| Var | Default | Meaning |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | fork endpoint |
| `DELAY_SECONDS` | `60` | pause between iterations |
| `ITERATIONS` | `999` | effectively infinite |
| `PRIVATE_KEY` | anvil acct 0 | trader |

One-shot (single batch, no loop):

```bash
cd contracts
forge script script/SimulateTrading.s.sol:SimulateTrading \
  --rpc-url http://127.0.0.1:8545 --broadcast --slow --skip-simulation \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

### Give yourself a Punk — test the live-bid / return-auction flow in the UI

```bash
cd /Users/dd/CascadeProjects/permanent-collection
PUNK_ID=42 RECIPIENT=0xYourWallet pnpm tsx scripts/give-punk.ts
```

Impersonates the current mainnet owner of a Punk carrying an **uncollected
trait** and transfers it to your wallet, so you can list it to Patron at
price 0 and run `acceptBid` → return auction through the UI. Omit
`PUNK_ID` to auto-pick the first eligible Punk; omit `RECIPIENT` to use
anvil account 0.

### Fast-forward past the 72h return auction — test settling

Once a Punk is in a return auction (after `acceptBid`), the auction runs for
**72 hours** (`AUCTION_DURATION` in `ReturnAuctionModule`). You don't want to
wait three days to test the settle path, so warp the fork clock past the
deadline. `scripts/warp-fork.sh` takes an arbitrary `MINUTES`; 72h is 4320
minutes, so warp a bit past it:

```bash
# Warp 72h + a margin so the auction is definitely over.
MINUTES=4400 ./scripts/warp-fork.sh
```

Two outcomes to test, depending on whether a rescue bid was placed:

- **Silenced (no bid ≥ reserve):** nobody out-bid the reserve, so settling
  vaults the Punk forever and makes its target trait permanent. This is the
  common path to test.
- **Rescued (a bid ≥ reserve landed):** settling sends the Punk to the high
  bidder and splits the proceeds. Place a qualifying bid in the UI *before*
  warping, then warp + settle.

Heads-up: the auction has a **15-minute anti-snipe window** — a bid in the
last 15 min extends the deadline by 1h (`SNIPE_EXTENSION`, uncapped). If you
bid right before warping, warp comfortably past (the `MINUTES=4400` margin
covers one extension; add more if you triggered several).

Settle through the UI (the auction page surfaces a **Settle** action once the
deadline passes — refresh after warping so the countdown re-reads the fork
clock), or from the CLI:

```bash
export RPC=http://127.0.0.1:8545
RAM=$(jq -r .returnAuctionModule contracts/deployments.json)
# settle(uint16 punkId) — permissionless; anyone can call once the deadline passes.
cast send "$RAM" "settle(uint16)" <PUNK_ID> \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url "$RPC"
```

Verify it took effect:

```bash
PC=$(jq -r .permanentCollection contracts/deployments.json)
# collectedCount climbs by 1 on a silenced settle (the trait is now permanent).
cast call "$PC" "collectedCount()(uint256)" --rpc-url "$RPC"
```

The warp pushes anvil's block clock ahead of wall-clock; swap deadlines read
the pending block (`app/lib/swap/chainTime.ts`), so trading still works after
a warp. To jump back to a fresh stack instead, see **6. Stop / reset** below.

## 5. Verify the flywheel is live

```bash
export RPC=http://127.0.0.1:8545
export PATRON=$(jq -r .patron contracts/deployments.json)

# Live bid (grows as trades happen). 0 on a fresh fork.
cast call $PATRON "bountyBalance()(uint256)" --rpc-url $RPC | cast from-wei
```

The extension is the no-throttle, full-pipeline-every-swap build: the
`creator()` and `minBlocksBetweenCollects()` getters were removed, so calling
them reverts (a quick way to confirm the deployed build):

```bash
cast call $(jq -r .perSwapFeeExtension contracts/deployments.json) \
  "creator()(address)" --rpc-url $RPC    # reverts on the current build
```

A single trade through the sim (or a swap in the UI) should bump
`bountyBalance` (the live bid) — e.g. one 2 ETH buy grows it ~0.069 ETH
while the anti-sniper fee is still elevated.

## 6. Stop / reset

```bash
# Stop the fork (drops all fork state):
pkill -f "anvil.*port 8545"

# Reset to a pristine deploy (live bid = 0, fresh stack):
FORK_BLOCK=25145000 pnpm fork:start
```

Front-ends and the sim loop are just `Ctrl-C` in their terminals.

---

## Gotchas

- **Use the dedicated test wallet for the UI — not the factory owner.**
  `start-dev-fork.sh` funds `0x4fa58f…` for UI trading. Do **not** trade from
  `0xCB43…217F9`: it's the artcoins factory owner the script impersonates during
  setup, and trading from an impersonated address desyncs anvil's mempool
  nonce-tracking → swaps stick at "Confirming on-chain…".
- **After a refork, reset your wallet's nonce cache.** Every refork resets the
  chain's nonces, but Rainbow/MetaMask cache the old ones; a stale-nonce swap
  hangs at "Confirming on-chain…". Fix: clear the wallet's activity (Rainbow:
  remove + re-add the network; MetaMask: Settings → Advanced → Clear activity
  tab data) — or avoid reforking mid-session: `NO_FORK=1 pnpm dev:up` (re)starts
  only the front-ends.
- **chainId is `31337`, not `1`** for both `pnpm dev:up` and `PRELAUNCH=1 pnpm
  dev:up` — `start-dev-fork.sh` and both frontends expect 31337. (The old
  `LOCAL_DEV.md` says `--chain-id 1` — ignore that.) The prelaunch flow signs
  Phase 2b as the impersonated live owner via `UNLOCKED_SENDER=true` (see the
  launch-flow demo above), so it needs no chainId change.
- **Port collision.** Both Next apps default to 3000 — always give artcoins an
  explicit `PORT`.
- **Don't use `pnpm scenario:fork` / `pnpm seed:fork` / `seed:fork:forge`.**
  They reference `RunScenario.s.sol` / `SeedLocalFork.s.sol`, which **don't
  exist**, and the root `seed:fork` hardcodes the wrong port (8546). Only
  `SimulateTrading.s.sol` (via the loop in §4) is real.
- **Deterministic addresses.** Same `FORK_BLOCK` ⇒ same deploy addresses, so
  env files survive a refork. Change the block and you must re-sync
  `app/.env.local` from `contracts/deployments.json`.
- **MEV override.** The local `ArtCoinsMevLinearFees` address is CREATE2-stable
  (`0x7b215A58…`); set artcoins' `NEXT_PUBLIC_FOUNDRY_MEV_LINEAR_OVERRIDE` to it
  once.

## Reference — key fork addresses (deterministic @ `FORK_BLOCK=25145000`)

Authoritative source: `contracts/deployments.json` (PC) + `app/.env.local`.

| Contract | Address |
|---|---|
| `111` token | `0x76A00199290eD0745bb88863bB0eF739Dfcb81aC` |
| Patron (live-bid hub) | `0x062583De3A5c4D3b03EeF964F36B2E4F22b81AEB` |
| PCSwapContext | (deterministic via Deploy.s.sol; see `deployments.json`) |
| ReferralPayout | (deterministic via Deploy.s.sol; see `deployments.json`) |
| ProtocolFeePhaseAdapter | (deterministic via Deploy.s.sol; see `deployments.json`) |
| Conversion locker | `0x40178C9EFc87E48F2034fFa3F300339729e0A762` |
| MEV module (local) | `0x7b215A58d0EF39055C47D002789a206Fd348D0B5` |
| artcoins hook (mainnet) | `0xAAd673ea3945dF5F7Ef328974d2c07c8BdcAA8Cc` |
