#!/usr/bin/env bash
# dev-up-prelaunch.sh — bring the dev stack up in the PRE-LAUNCH state for the
# Phase-2 launch flow, using the REAL Phase-1 artcoins addresses already
# deployed on Ethereum mainnet. Lets you watch the site auto-flip to live when
# you run `pnpm launch:fire` against the same running fork. No env change, no
# rebuild.
#
# Mainnet Phase-1 artcoins addresses (deployed 2026-06-06, broadcast record
# `contracts/broadcast/DeployArtcoinsLaunchStack.s.sol/1/run-latest.json`).
# These are NOT redeployed locally — the fork starts from a recent mainnet
# block where they already have bytecode.
ARTCOINS_FACTORY="0x49596c375c139E79bb937bcf826068a8F78D4e0e"
ARTCOINS_FEE_ESCROW="0x7559689765aE86cBB38e68CD1294830CccB125F2"
ARTCOINS_HOOK_SKIM="0x636c050296B5Cc528D8785169Bf8923716FCa9cc"
ARTCOINS_MEV_SKIM="0xb038D597365FfD108D63C265Bb0621444a1D8B83"
PC_CONTROLLER="0xd8C63401268744d430EbE0C18412211421498013"
CONVERSION_LOCKER="0x866ea3Dc2bf7A3e77374619cf50EB697FA766aab"
#
# Single anvil session:
#   1. Fork mainnet at a recent block (the real Phase-1 + Phase-2a contracts are
#      already on-chain — nothing is re-deployed)
#   2. Fund the dev wallet
#   3. Confirm the live 2a contracts have code; copy the committed snapshot
#      (contracts/deployments.mainnet.json) → deployments.json for launch:fire
#   4. Impersonate the live owner (0xCB43…) so launch:fire's 2b signs as it
#   5. Write the LIVE PC_* addresses to app/.env.local (token = the predicted
#      CREATE2 2b address, no code yet → site pre-launch)
#   6. Start the front-end on :3022
#
# Then `pnpm launch:fire` launches ONLY the token (Phase 2b / runToken) against
# the live 2a on the fork, signed as the impersonated owner → the token lands at
# the pre-baked address → client `eth_getCode` flips the site live. (Phase 2a is
# already done on mainnet; `pnpm launch:contracts` remains for a from-scratch
# fork rehearsal.)
#
# Usage:
#   PRELAUNCH=1 pnpm dev:up               # pre-launch demo state (undeployed)
#   ACQUIRED=10 PRELAUNCH=1 pnpm dev:up    # deploy + seed to 10 vaulted, LIVE
#   ./scripts/dev-up-prelaunch.sh
#
# ACQUIRED=N (1..111): instead of the pre-launch state, deploy the protocol and
# seed it to N vaulted Punks (via seed-acquisitions — real swaps fund the bid;
# FAST=1 to mint instead), ending live with both frontends up. NO_ARTCOINS=1
# skips the artcoins frontend.
#
# Stop everything: pkill -x anvil ; lsof -ti tcp:3022 tcp:3001 | xargs kill
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-$ROOT/app}"
CONTRACTS_DIR="$ROOT/contracts"
RPC_PORT="${RPC_PORT:-8545}"
PC_PORT="${PC_PORT:-3022}"
RPC_URL="http://127.0.0.1:${RPC_PORT}"
APP_ENV="$APP_DIR/.env.local"
DEPLOYMENTS_JSON="$CONTRACTS_DIR/deployments.json"
PRELAUNCH_STATE="$CONTRACTS_DIR/prelaunch-state.json"
PC_LOG="/tmp/pc-app-${PC_PORT}.log"
ANVIL_LOG="/tmp/pc-prelaunch-anvil-${RPC_PORT}.log"
# artcoins token-trading frontend (separate repo). Started too unless missing or
# NO_ARTCOINS=1. Default location + port match scripts/dev-up.sh.
ARTCOINS_DIR="${ARTCOINS_DIR:-$(cd "$ROOT/.." && pwd)/artcoins}"
ARTCOINS_PORT="${ARTCOINS_PORT:-3001}"
ARTCOINS_LOG="/tmp/artcoins-app-${ARTCOINS_PORT}.log"

# ACQUIRED=N — instead of the pre-launch demo state, deploy the protocol AND
# seed it to N vaulted Punks, ending LIVE + seeded with both frontends up. One
# command for "show me the app at N acquired." Unset = the default pre-launch
# flow (deploy captured then reverted to the undeployed state). Funding for the
# seed uses real swaps by default; pass FAST=1 to mint instead.
ACQUIRED="${ACQUIRED:-}"
if [[ -n "$ACQUIRED" ]]; then
  if ! [[ "$ACQUIRED" =~ ^[0-9]+$ ]] || (( ACQUIRED < 1 || ACQUIRED > 111 )); then
    echo "✗ ACQUIRED must be an integer 1..111 (got: $ACQUIRED)" >&2
    exit 1
  fi
fi

# Defaults: Tenderly public gateway (archive-state friendly, no key) at a
# recent block. Override either via env if you want a different upstream or
# pin.
UPSTREAM="${UPSTREAM:-https://gateway.tenderly.co/public/mainnet}"
# If FORK_BLOCK isn't given, query the current mainnet tip and pin 500 blocks
# back so the fork is stable through a long session.
FORK_BLOCK="${FORK_BLOCK:-}"

# Anvil account 0 — signs the Deploy.s.sol broadcast (the demo's Phase-2
# "deployer"; on mainnet Phase 2 the real deployer signs). Always funded.
DEPLOYER_WALLET="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
DEV_PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

# User-facing wallet(s) to fund for testing — connect MetaMask here. Defaults to
# the historical PC dev wallet (matches `start-dev-fork.sh`). Override via
# DEV_WALLETS="0xaaa 0xbbb" to fund multiple, or DEV_WALLET_ETH=50000 for more
# ETH each. The deployer is funded separately above — you don't need to list it.
DEV_WALLETS="${DEV_WALLETS:-0x4fa58fFc00D973fD222d573C256Eb3Cc81A8569c}"
DEV_WALLET_ETH="${DEV_WALLET_ETH:-10000}"

export PATH="$HOME/.foundry/bin:$PATH"

free_port() {
  command -v lsof >/dev/null 2>&1 || return 0
  local pids; pids=$(lsof -ti "tcp:$1" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then echo "$pids" | xargs kill -9 2>/dev/null || true; fi
}

wait_listen() {
  local port="$1" tries="${2:-90}" i
  for ((i = 1; i <= tries; i++)); do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# ── (1) start the mainnet fork (no bootstrap — Phase 1 is already on-chain) ─
if [[ -z "$FORK_BLOCK" ]]; then
  echo "▸ [fork] resolving recent mainnet block from $UPSTREAM"
  TIP=$(cast block-number --rpc-url "$UPSTREAM" 2>/dev/null) || { echo "  ✗ couldn't reach $UPSTREAM" >&2; exit 1; }
  FORK_BLOCK=$((TIP - 500))
  echo "  ✓ using FORK_BLOCK=$FORK_BLOCK (tip $TIP - 500)"
fi

echo "▸ [fork] starting anvil on :${RPC_PORT} forked from mainnet @ $FORK_BLOCK"
pkill -f "anvil.*--port $RPC_PORT" 2>/dev/null || true
free_port "$RPC_PORT"
sleep 1

# Match the flags start-dev-fork.sh uses (big gas limit for renders, base-fee 0
# for wallet UX, code-size limit off for the conversion locker, --silent so it
# doesn't flood the terminal).
# chainId 31337: the standard local-fork chain both frontends connect to natively
# (PC via NEXT_PUBLIC_CHAIN_ID=31337, artcoins via its Foundry chain). launch:fire
# runs Phase 2b as the impersonated live owner (0xCB43…) via `forge --sender …
# --unlocked UNLOCKED_SENDER=true`, which makes Deploy.s.sol honour the CLI signer
# on a 31337 fork instead of its anvil-key default. No MetaMask "chainId in use"
# friction (31337 is a clean local chain).
nohup anvil \
  --fork-url "$UPSTREAM" \
  --fork-block-number "$FORK_BLOCK" \
  --chain-id 31337 \
  --port "$RPC_PORT" \
  --gas-limit 1000000000 \
  --base-fee 0 \
  --disable-code-size-limit \
  --silent >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
echo "$ANVIL_PID" > /tmp/pc-prelaunch-anvil.pid

# Wait until the RPC responds.
echo -n "  waiting for anvil to respond"
for i in $(seq 1 30); do
  cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && { echo " ✓"; break; }
  echo -n "."
  sleep 1
done
cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 || { echo " ✗"; tail -20 "$ANVIL_LOG" >&2; exit 1; }

# Confirm Phase-1 is actually present at this block.
echo "▸ [phase-1] verifying Phase-1 artcoins addresses have code on the fork"
for pair in "factory:$ARTCOINS_FACTORY" "escrow:$ARTCOINS_FEE_ESCROW" "hook:$ARTCOINS_HOOK_SKIM" "mev:$ARTCOINS_MEV_SKIM" "controller:$PC_CONTROLLER" "locker:$CONVERSION_LOCKER"; do
  N="${pair%%:*}"; A="${pair##*:}"
  SZ=$(cast codesize "$A" --rpc-url "$RPC_URL" 2>/dev/null || echo 0)
  if [[ "$SZ" == "0" ]]; then
    echo "  ✗ $N at $A has NO code — FORK_BLOCK ($FORK_BLOCK) is before Phase 1 was deployed" >&2
    echo "    set a later FORK_BLOCK or omit it (we auto-resolve recent tip)." >&2
    exit 1
  fi
  printf "  ✓ %-12s code=%s\n" "$N" "$SZ"
done

# ── (2) fund the deployer + the user-facing dev wallet(s) ─────────────────
echo "▸ [fund] funding deployer $DEPLOYER_WALLET with 10000 ETH (signs Deploy.s.sol)"
cast rpc anvil_setBalance "$DEPLOYER_WALLET" 0x21e19e0c9bab2400000 --rpc-url "$RPC_URL" >/dev/null
DEV_WEI_HEX=$(cast to-hex "$(cast to-wei "$DEV_WALLET_ETH" ether)")
for W in $DEV_WALLETS; do
  echo "▸ [fund] funding $W with $DEV_WALLET_ETH ETH (connect MetaMask here)"
  cast rpc anvil_setBalance "$W" "$DEV_WEI_HEX" --rpc-url "$RPC_URL" >/dev/null
  # Strip any EIP-7702 delegation the address might carry on real mainnet (a
  # delegation makes the market's 2300-gas `withdraw()` revert when the seller
  # tries to collect their acceptBid proceeds — useful to clear in a local demo).
  cast rpc anvil_setCode "$W" "0x" --rpc-url "$RPC_URL" >/dev/null
done
# Same delegation-strip on the deployer (mirrors start-dev-fork.sh).
cast rpc anvil_setCode "$DEPLOYER_WALLET" "0x" --rpc-url "$RPC_URL" >/dev/null

# ── (2.5) undeprecate the factory ─────────────────────────────────────────
# Mainnet Phase-1 left the factory deprecated() = true and deployFee = 0.
# Phase 2 mainnet broadcast undeprecates before broadcast and re-deprecates
# after; the fork mirrors only the undeprecate so Deploy.s.sol can call
# deployTokenWithProtocolBpsAndTax without reverting `Deprecated()`. Goes
# BEFORE the snapshot so it persists past the capture's evm_revert.
FACTORY_OWNER="0xCB43078C32423F5348Cab5885911C3B5faE217F9"
DEPRECATED=$(cast call "$ARTCOINS_FACTORY" "deprecated()(bool)" --rpc-url "$RPC_URL" 2>/dev/null)
if [[ "$DEPRECATED" == "true" ]]; then
  echo "▸ [undeprecate] factory.setDeprecated(false) — impersonating $FACTORY_OWNER"
  cast rpc anvil_impersonateAccount "$FACTORY_OWNER" --rpc-url "$RPC_URL" >/dev/null
  cast rpc anvil_setBalance "$FACTORY_OWNER" 0xDE0B6B3A7640000 --rpc-url "$RPC_URL" >/dev/null
  cast send "$ARTCOINS_FACTORY" "setDeprecated(bool)" false \
    --from "$FACTORY_OWNER" --unlocked --rpc-url "$RPC_URL" >/dev/null
  cast rpc anvil_stopImpersonatingAccount "$FACTORY_OWNER" --rpc-url "$RPC_URL" >/dev/null
  NOW=$(cast call "$ARTCOINS_FACTORY" "deprecated()(bool)" --rpc-url "$RPC_URL" 2>/dev/null)
  [[ "$NOW" == "false" ]] || { echo "  ✗ undeprecate failed (still: $NOW)" >&2; exit 1; }
  echo "  ✓ factory deprecated = false"
else
  echo "▸ [undeprecate] factory already deprecated=false — nothing to do"
fi

# ── (3) persist the artcoins addresses so launch:fire can read them ───────
jq -n \
  --arg fac "$ARTCOINS_FACTORY" --arg esc "$ARTCOINS_FEE_ESCROW" \
  --arg hk  "$ARTCOINS_HOOK_SKIM" --arg mev "$ARTCOINS_MEV_SKIM" \
  --arg ctrl "$PC_CONTROLLER" --arg loc "$CONVERSION_LOCKER" \
  '{factory:$fac, feeEscrow:$esc, skimHook:$hk, mevSkim:$mev, pcController:$ctrl, conversionLocker:$loc, source:"mainnet-phase-1"}' \
  > "$PRELAUNCH_STATE"
echo "▸ [state] wrote Phase-1 addresses to $PRELAUNCH_STATE"

# ── (4) load the LIVE mainnet Phase-2a addresses (already on the fork) ──────
# Phase 2a is deployed on mainnet, so the fork ALREADY has the PC contracts at
# their real addresses — no ephemeral capture / deploy / revert. Read them from
# the committed snapshot and confirm they have code at this fork block.
MAINNET_SNAPSHOT="$CONTRACTS_DIR/deployments.mainnet.json"
[[ -f "$MAINNET_SNAPSHOT" ]] || { echo "  ✗ $MAINNET_SNAPSHOT missing (committed live-2a snapshot)" >&2; exit 1; }
echo "▸ [phase-2a] verifying the live 2a PC contracts have code on the fork"
for key in patron permanentCollection returnAuctionModule liveBidAdapter tokenAdminPoker; do
  A=$(jq -r ".$key" "$MAINNET_SNAPSHOT")
  SZ=$(cast codesize "$A" --rpc-url "$RPC_URL" 2>/dev/null || echo 0)
  if [[ "$SZ" == "0" ]]; then
    echo "  ✗ $key at $A has NO code — FORK_BLOCK ($FORK_BLOCK) is before the Phase-2a deploy (block 25270213)." >&2
    echo "    Omit FORK_BLOCK (it auto-resolves a recent tip) or set one ≥ 25270213." >&2
    exit 1
  fi
  printf "  ✓ %-22s code=%s\n" "$key" "$SZ"
done

# launch:fire's runToken() reads the 2a addresses from deployments.json — seed it
# from the snapshot (token still 0 so the idempotency guard passes).
cp "$MAINNET_SNAPSHOT" "$DEPLOYMENTS_JSON"

# Impersonate the live owner (0xCB43…) so launch:fire's 2b can sign as it: the
# live 2a contracts + factory are owner-gated to this account. The unlock
# persists for the anvil session, so the separate launch:fire process can
# `--sender $OWNER --unlocked`.
OWNER="$(jq -r '.owner' "$MAINNET_SNAPSHOT")"
echo "▸ [impersonate] unlocking owner $OWNER for launch:fire's Phase-2b"
cast rpc anvil_impersonateAccount "$OWNER" --rpc-url "$RPC_URL" >/dev/null
cast rpc anvil_setBalance "$OWNER" 0x21e19e0c9bab2400000 --rpc-url "$RPC_URL" >/dev/null

# The deterministic (CREATE2) token address the 2b will land on — pre-baked so
# the client eth_getCode auto-flips the site live the moment launch:fire runs.
CAPTURED_TOKEN="$(jq -r '.tokenPredicted' "$MAINNET_SNAPSHOT")"

# ── (5) ACQUIRED mode: launch the token now (Phase 2b) + seed; else stay pre-launch
if [[ -n "$ACQUIRED" ]]; then
  echo "▸ [acquire] launching the token (Phase 2b as $OWNER) then seeding ${ACQUIRED} vaulted Punk(s)${RESCUE:+ + ${RESCUE} rescued}…"
  PHASE=token RPC_PORT="$RPC_PORT" "$ROOT/scripts/launch-fire.sh"
  ( cd "$ROOT" && COUNT="$ACQUIRED" RESCUE="${RESCUE:-0}" RPC_URL="$RPC_URL" pnpm tsx scripts/seed-acquisitions.ts )
fi

# ── (6.5) seed random Punks to the user-facing wallet ─────────────────────
# AFTER the revert so the transfers persist. Sends SEED_DEV_PUNKS (default 10)
# RANDOM eligible Punks to the FIRST DEV_WALLETS entry (default
# 0x4fa58fFc00D973fD222d573C256Eb3Cc81A8569c). Selection: partition the 10k
# space into SEED_N buckets and pick a RANDOM start within each, then let
# give-punk.ts scan forward (START env) to the first ELIGIBLE Punk from there.
# Random per run + one per bucket = distinct + varied, and always eligible
# (a fixed random PUNK_ID can hit an ineligible/zero-owner Punk and revert).
# Override: SEED_DEV_PUNKS_WALLET (recipient), SEED_DEV_PUNKS=N (count, 0 to
# skip), or SEED_DEV_PUNK_IDS="12 3456 …" for explicit ids.
SEED_N="${SEED_DEV_PUNKS:-10}"
if [[ "$SEED_N" != "0" ]]; then
  PUNK_RECIPIENT="${SEED_DEV_PUNKS_WALLET:-$(echo "$DEV_WALLETS" | awk '{print $1}')}"
  OK=0
  if [[ -n "${SEED_DEV_PUNK_IDS:-}" ]]; then
    # Explicit ids: caller-chosen, passed straight through as PUNK_ID.
    echo "▸ [seed] sending explicit Punks to ${PUNK_RECIPIENT}: ${SEED_DEV_PUNK_IDS}"
    for ID in ${SEED_DEV_PUNK_IDS}; do
      if ( cd "$ROOT" && RECIPIENT="$PUNK_RECIPIENT" PUNK_ID="$ID" RPC_URL="$RPC_URL" \
             pnpm tsx scripts/give-punk.ts >"/tmp/pc-seed-punk-${ID}.log" 2>&1 ); then
        echo "  ✓ #$ID"; OK=$((OK + 1))
      else
        echo "  ✗ #$ID  $(tail -1 "/tmp/pc-seed-punk-${ID}.log")"
      fi
    done
  else
    # Random, bucket-spread: one random start per bucket, leaving a margin so
    # give-punk's forward eligible-scan stays inside the bucket (distinct picks).
    echo "▸ [seed] sending ${SEED_N} random eligible Punks to ${PUNK_RECIPIENT}…"
    SEED_STEP=$(( 10000 / SEED_N ))
    SEED_MARGIN=300            # give-punk scans up to ~500 fwd; keep starts clear of the next bucket
    for ((k = 0; k < SEED_N; k++)); do
      SPAN=$(( SEED_STEP > SEED_MARGIN ? SEED_STEP - SEED_MARGIN : SEED_STEP ))
      START=$(( k * SEED_STEP + RANDOM % SPAN ))
      if ( cd "$ROOT" && RECIPIENT="$PUNK_RECIPIENT" START="$START" RPC_URL="$RPC_URL" \
             pnpm tsx scripts/give-punk.ts >"/tmp/pc-seed-punk-b${k}.log" 2>&1 ); then
        PICKED=$(grep -oE 'Targeting Punk #[0-9]+' "/tmp/pc-seed-punk-b${k}.log" | grep -oE '[0-9]+' | head -1)
        echo "  ✓ #${PICKED:-?} (bucket $k, start $START)"; OK=$((OK + 1))
      else
        echo "  ✗ bucket $k (start $START)  $(tail -1 "/tmp/pc-seed-punk-b${k}.log")"
      fi
    done
  fi
  echo "  seeded ${OK}/${SEED_N} Punks to ${PUNK_RECIPIENT}"
fi

# ── (7) write captured PC addresses → app/.env.local as PC_* vars ──────────
echo "▸ [env] writing pre-baked PC_* runtime vars to $APP_ENV"
TOKEN="$CAPTURED_TOKEN"                  # deterministic 2b token (no code until launch:fire)
PATRON=$(jq -r '.patron'                "$DEPLOYMENTS_JSON")
PERMCOLL=$(jq -r '.permanentCollection' "$DEPLOYMENTS_JSON")
RETURNAUC=$(jq -r '.returnAuctionModule' "$DEPLOYMENTS_JSON")
PUNKVAULT=$(jq -r '.punkVault'          "$DEPLOYMENTS_JSON")
BUYBACK=$(jq -r '.buybackBurner'        "$DEPLOYMENTS_JSON")
LBA=$(jq -r '.liveBidAdapter'           "$DEPLOYMENTS_JSON")
VBP=$(jq -r '.vaultBurnPool'            "$DEPLOYMENTS_JSON")
PFPA=$(jq -r '.protocolFeePhaseAdapter // empty' "$DEPLOYMENTS_JSON")
REFP=$(jq -r '.referralPayout // empty' "$DEPLOYMENTS_JSON")
PCSC=$(jq -r '.pcSwapContext // empty'  "$DEPLOYMENTS_JSON")
TITLEAU=$(jq -r '.titleAuction // empty' "$DEPLOYMENTS_JSON")
RENDERER=$(jq -r '.renderer'            "$DEPLOYMENTS_JSON")
ADMIN=$(jq -r '.protocolAdmin'          "$DEPLOYMENTS_JSON")
HOOK_PK="$ARTCOINS_HOOK_SKIM"            # real Phase-1 hook (snapshot .hook is 0 until 2b)

cat > "$APP_ENV" <<EOF
# PRE-LAUNCH demo env — written by scripts/dev-up-prelaunch.sh.
# Fork is mainnet @ block $FORK_BLOCK with the real, deployed Phase-1 + Phase-2a
# contracts already on-chain. These PC_* are the LIVE mainnet addresses; the
# token is the deterministic CREATE2 address Phase-2b will land on (no code yet).
# Run \`pnpm launch:fire\` to launch the token (Phase 2b) onto the running fork;
# the client's \`eth_getCode\` flips the site live on the next page load.

NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_DATA_ADAPTER=fork
RPC_URL=http://127.0.0.1:${RPC_PORT}
RPC_RATE_LIMIT_PER_MIN=0
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=LOCAL_DEV_PLACEHOLDER
NEXT_PUBLIC_TOKEN_SYMBOL=111

PC_TOKEN_ADDRESS=${TOKEN}
PC_PERMANENT_COLLECTION_ADDRESS=${PERMCOLL}
PC_PATRON_ADDRESS=${PATRON}
PC_RETURN_AUCTION_MODULE_ADDRESS=${RETURNAUC}
PC_PUNK_VAULT_ADDRESS=${PUNKVAULT}
PC_BUYBACK_BURNER_ADDRESS=${BUYBACK}
PC_LIVE_BID_ADAPTER_ADDRESS=${LBA}
PC_VAULT_BURN_POOL_ADDRESS=${VBP}
PC_PROTOCOL_FEE_PHASE_ADAPTER_ADDRESS=${PFPA}
PC_REFERRAL_PAYOUT_ADDRESS=${REFP}
PC_PC_SWAP_CONTEXT_ADDRESS=${PCSC}
PC_TITLE_AUCTION_ADDRESS=${TITLEAU}
PC_RENDERER_ADDRESS=${RENDERER}
PC_PROTOCOL_ADMIN_ADDRESS=${ADMIN}
PC_ARTCOINS_HOOK_ADDRESS=${HOOK_PK}
EOF
echo "  ✓ pre-baked token: ${TOKEN}"

# ── (8) start the front-end ────────────────────────────────────────────────
# Standard `pnpm dev` (turbopack). The `_buildManifest.js.tmp` ENOENT race that
# previously forced a webpack-dev fallback was a Next 15.5.18 turbopack bug,
# fixed in 15.5.19 — turbopack dev is the default again (faster compiles).
echo "▸ [app] starting front-end on :${PC_PORT}"
free_port "$PC_PORT"
( cd "$APP_DIR" && PORT="$PC_PORT" nohup pnpm dev >"$PC_LOG" 2>&1 & echo $! >/tmp/pc-app.pid )
wait_listen "$PC_PORT" 120 && APP_OK=1 || APP_OK=0

# ── (9) start the artcoins token-trading frontend ──────────────────────────
# Skipped if NO_ARTCOINS=1 or the repo isn't at ARTCOINS_DIR. For the app to
# show fork-deployed tokens its .env.local needs TWO flags, which this step
# auto-applies (idempotent): NEXT_PUBLIC_FOUNDRY_RPC_URL=<fork> (adds the 31337
# chain + routes reads to anvil) and NEXT_PUBLIC_MAINNET_ONLY=false (mainnetOnly
# short-circuits wagmi to chain 1 only, so 31337 is never added — that one
# silently hides every fork token).
ART_OK=0
ART_STARTED=0
if [[ "${NO_ARTCOINS:-0}" != "1" && -d "$ARTCOINS_DIR" ]]; then
  ART_ENV="$ARTCOINS_DIR/.env.local"
  touch "$ART_ENV"
  # MAINNET_ONLY → false (set, replace, or append)
  if grep -q '^NEXT_PUBLIC_MAINNET_ONLY=' "$ART_ENV"; then
    if grep -q '^NEXT_PUBLIC_MAINNET_ONLY=true' "$ART_ENV"; then
      sed -i '' 's/^NEXT_PUBLIC_MAINNET_ONLY=true/NEXT_PUBLIC_MAINNET_ONLY=false/' "$ART_ENV"
      echo "▸ [artcoins] set NEXT_PUBLIC_MAINNET_ONLY=false (was true — would hide fork tokens)"
    fi
  else
    echo 'NEXT_PUBLIC_MAINNET_ONLY=false' >> "$ART_ENV"
    echo "▸ [artcoins] added NEXT_PUBLIC_MAINNET_ONLY=false to .env.local"
  fi
  # FOUNDRY_RPC_URL → the fork (set or append; leave a custom value alone)
  if ! grep -q '^NEXT_PUBLIC_FOUNDRY_RPC_URL=' "$ART_ENV"; then
    echo "NEXT_PUBLIC_FOUNDRY_RPC_URL=$RPC_URL" >> "$ART_ENV"
    echo "▸ [artcoins] added NEXT_PUBLIC_FOUNDRY_RPC_URL=$RPC_URL to .env.local"
  fi
  echo "▸ [artcoins] starting token frontend on :${ARTCOINS_PORT} ($ARTCOINS_DIR)"
  free_port "$ARTCOINS_PORT"
  ( cd "$ARTCOINS_DIR" && PORT="$ARTCOINS_PORT" nohup npm run dev >"$ARTCOINS_LOG" 2>&1 & echo $! >/tmp/artcoins-app.pid )
  ART_STARTED=1
  wait_listen "$ARTCOINS_PORT" 120 && ART_OK=1 || ART_OK=0
else
  echo "▸ [artcoins] skipped ($([[ "${NO_ARTCOINS:-0}" == "1" ]] && echo NO_ARTCOINS=1 || echo "not found at $ARTCOINS_DIR"))"
fi

ART_LINE=""
if [[ "$ART_STARTED" == "1" ]]; then
  ART_LINE="  artcoins token UI  http://localhost:${ARTCOINS_PORT}/${TOKEN}   $([[ "$ART_OK" == "1" ]] && echo "" || echo "(still booting — tail $ARTCOINS_LOG)")
                     (pick the Foundry/31337 chain in its picker; needs NEXT_PUBLIC_FOUNDRY_RPC_URL set in the artcoins .env.local)
"
fi

if [[ -n "$ACQUIRED" ]]; then
cat <<EOF

────────────────────────────────────────────────────────────────────────
  LIVE + SEEDED — mainnet fork @ $FORK_BLOCK, protocol deployed, ${ACQUIRED} Punk(s) vaulted
  $([[ "$APP_OK" == "1" ]] && echo "(ready)" || echo "(still booting — tail $PC_LOG)")

  Visit  http://localhost:${PC_PORT}            (homepage — shows ${ACQUIRED}/111)
         http://localhost:${PC_PORT}/trade       (live swap UI)
         http://localhost:${PC_PORT}/collection  (the mosaic at ${ACQUIRED} collected)
         http://localhost:${PC_PORT}/bid          (accept the live bid)

${ART_LINE}  Fork:  $RPC_URL   (chainId 31337, protocol LIVE)
  Token: ${TOKEN}

  Connect MetaMask to ${DEV_WALLETS%% *} — funded with ${DEV_WALLET_ETH} ETH${SEED_N:+ + ${SEED_N} Punks (test /bid)}

  Seed further any time:  pnpm seed:acquisitions <N>

  Stop everything:
    pkill -x anvil ; lsof -ti tcp:${PC_PORT} tcp:${ARTCOINS_PORT} | xargs kill
────────────────────────────────────────────────────────────────────────
EOF
else
cat <<EOF

────────────────────────────────────────────────────────────────────────
  PRE-LAUNCH STATE IS UP — mainnet fork @ $FORK_BLOCK + real Phase-1 artcoins
  $([[ "$APP_OK" == "1" ]] && echo "(ready)" || echo "(still booting — tail $PC_LOG)")

  Visit  http://localhost:${PC_PORT}            (homepage)
         http://localhost:${PC_PORT}/trade       (swap UI — "Not launched yet")
         http://localhost:${PC_PORT}/contracts   (links muted as "not deployed yet")

${ART_LINE}  Fork:  $RPC_URL   (chainId 31337, NO PC contracts)
  Token: ${TOKEN}     (set, but zero code → pre-launch)

  Connect MetaMask to ${DEV_WALLETS%% *} — already funded with ${DEV_WALLET_ETH} ETH
  ${SEED_N:+(plus ${SEED_N} Punks already seeded; see /accept once protocol is live)}

  TO FLIP THE SITE LIVE, run (in another terminal):
    pnpm launch:fire     (or re-run with ACQUIRED=N to deploy + seed in one go)

  After it completes, refresh the browser — the client-side eth_getCode picks
  up the new bytecode and the site auto-flips live. No env change, no rebuild.

  Stop everything:
    pkill -x anvil ; lsof -ti tcp:${PC_PORT} tcp:${ARTCOINS_PORT} | xargs kill
────────────────────────────────────────────────────────────────────────
EOF
fi
