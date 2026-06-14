#!/usr/bin/env bash
# launch-fire.sh — launch the TOKEN (Phase 2b) onto the already-running fork.
#
# Companion to scripts/dev-up-prelaunch.sh. Phase 2a (all PC contracts) is
# already deployed on mainnet, so that script's fork ALREADY has them at their
# real addresses — the only thing left to deploy is the token. This script runs
# `runToken()` against the live 2a, signed AS the live owner (0xCB43…) via anvil
# impersonation (dev-up-prelaunch forks at chainId 31337 and unlocks the owner;
# UNLOCKED_SENDER=true tells Deploy.s.sol to honour the impersonated --sender on a
# 31337 fork instead of its anvil-key default). The token lands at the pre-baked
# deterministic address, so the frontend's client-side `eth_getCode` flips the
# site live.
#
# Modes via PHASE:
#   PHASE=all       (default) — Phase 2b (runToken): launch the token + V4 pool +
#                   LP and wire it to the LIVE 2a. Site flips live. `pnpm launch:fire`.
#   PHASE=token     — same as `all` (the only remaining deploy IS the token).
#                   `pnpm launch:token`.
#   PHASE=contracts — Phase 2a (runContracts) for a FROM-SCRATCH fork only (signs
#                   with the anvil dev key); NOT part of the live-2a flow, since
#                   2a is already on mainnet. `pnpm launch:contracts`.
#   PHASE=indexer   — Phase 2c: configure + run the Ponder indexer against the
#                   deployed stack (sync indexer/.env.local from deployments.json,
#                   then `ponder dev`). Long-running — keeps the terminal.
#                   `pnpm launch:indexer`. (Mainnet 2c is a Fly deploy — see
#                   docs/INDEXER_DEPLOY.md.)
#
# Reads the artcoins prerequisite addresses (factory / hook / mev / controller /
# locker / escrow) from `contracts/prelaunch-state.json`, which dev-up-prelaunch
# wrote from the real mainnet Phase-1 stack.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ENV="$ROOT/app/.env.local"
DEPLOYMENTS_JSON="$ROOT/contracts/deployments.json"
PRELAUNCH_STATE="$ROOT/contracts/prelaunch-state.json"
RPC_PORT="${RPC_PORT:-8545}"
RPC_URL="http://127.0.0.1:${RPC_PORT}"
PHASE="${PHASE:-all}"

case "$PHASE" in
  all|contracts|token|indexer) ;;
  *) echo "✗ PHASE must be one of: all | contracts | token | indexer (got '$PHASE')" >&2; exit 1 ;;
esac

if ! command -v cast >/dev/null 2>&1; then
  echo "✗ \`cast\` not on PATH. Add Foundry: \`export PATH=\$HOME/.foundry/bin:\$PATH\`" >&2
  exit 1
fi
if ! cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  echo "✗ no anvil on $RPC_URL — start the pre-launch stack first:" >&2
  echo "    PRELAUNCH=1 pnpm dev:up" >&2
  exit 1
fi

# ── Phase 2c: indexer — configure + run Ponder against the deployed fork ────
# No forge / prelaunch-state needed: the indexer just reads the deployed
# addresses from deployments.json (written by 2a/2b) and indexes the running
# fork. Long-running — it exec's into `ponder dev` and keeps the terminal.
if [[ "$PHASE" == "indexer" ]]; then
  if [[ ! -f "$DEPLOYMENTS_JSON" ]]; then
    echo "✗ $DEPLOYMENTS_JSON not found — deploy the contracts first:" >&2
    echo "    pnpm launch:fire        # or  pnpm launch:contracts && pnpm launch:token" >&2
    exit 1
  fi
  echo "▸ PHASE=indexer (2c) — syncing indexer/.env.local from deployments.json …"
  ( cd "$ROOT" && FORK_RPC_PORT="$RPC_PORT" pnpm tsx scripts/sync-indexer-env.ts )
  echo "▸ starting Ponder against $RPC_URL — GraphQL at http://127.0.0.1:42069"
  echo "  (long-running; leave this terminal open. The app reads it at INDEXER_URL.)"
  cd "$ROOT/indexer"
  # Clear any stale .ponder store from a prior fork run so this start does a
  # clean backfill against the freshly deployed stack: a leftover store from a
  # different deployment or block shadows the new run with out-of-sync state.
  rm -rf "$ROOT/indexer/.ponder"
  exec pnpm dev
fi

if [[ ! -f "$PRELAUNCH_STATE" ]]; then
  echo "✗ $PRELAUNCH_STATE not found — was the fork started with PRELAUNCH=1 pnpm dev:up?" >&2
  exit 1
fi

FACTORY=$(jq -r '.factory'          "$PRELAUNCH_STATE")
HOOK_SKIM=$(jq -r '.skimHook'       "$PRELAUNCH_STATE")
MEV_SKIM=$(jq -r '.mevSkim'         "$PRELAUNCH_STATE")
PC_CTRL=$(jq -r '.pcController'     "$PRELAUNCH_STATE")
LOCKER=$(jq -r '.conversionLocker'  "$PRELAUNCH_STATE")
ESCROW=$(jq -r '.feeEscrow'         "$PRELAUNCH_STATE")
for v in FACTORY HOOK_SKIM MEV_SKIM PC_CTRL LOCKER ESCROW; do
  [[ "${!v}" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "✗ $v in $PRELAUNCH_STATE is not a valid address" >&2; exit 1; }
done

DEPLOY_PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

# The site's source of truth for "what token am I waiting on" is the pre-baked
# PC_TOKEN_ADDRESS in .env.local (the deterministic CREATE2 token address
# dev-up-prelaunch pre-baked from the snapshot). We verify the deployed token
# matches THIS — the live-2a snapshot keeps deployments.json's token at 0.
PREBAKED=$(grep -E '^PC_TOKEN_ADDRESS=' "$APP_ENV" 2>/dev/null | cut -d= -f2 || true)
[[ "$PREBAKED" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "✗ PC_TOKEN_ADDRESS missing/invalid in $APP_ENV — rerun PRELAUNCH=1 pnpm dev:up" >&2; exit 1; }

codesize() { cast codesize "$1" --rpc-url "$RPC_URL" 2>/dev/null || echo 0; }

# Owner of the LIVE 2a contracts + factory (read from the snapshot dev-up-prelaunch
# copied into deployments.json). Phase 2b signs as this account via anvil
# impersonation; the live 2a setup() gates pin it (not transferable).
OWNER=$(jq -r '.owner // empty' "$DEPLOYMENTS_JSON" 2>/dev/null)
[[ "$OWNER" =~ ^0x[0-9a-fA-F]{40}$ ]] || OWNER="0xCB43078C32423F5348Cab5885911C3B5faE217F9"

# Phase 2b guard: runToken reverts unless deployments.json shows token==0 (the
# dormant 2a state). Catch it early with a friendlier message than the revert.
if [[ "$PHASE" == "token" || "$PHASE" == "all" ]]; then
  CUR_TOKEN=$(jq -r '.token // "0x0000000000000000000000000000000000000000"' "$DEPLOYMENTS_JSON" 2>/dev/null)
  if [[ "$CUR_TOKEN" != "0x0000000000000000000000000000000000000000" ]]; then
    echo "✗ deployments.json already shows a token ($CUR_TOKEN) — already launched" >&2
    echo "  on this fork. Reset with:  PRELAUNCH=1 pnpm dev:up" >&2
    exit 1
  fi
fi

echo "▸ PHASE=$PHASE — token the site is wired to: $PREBAKED"
echo "  codesize(token) before: $(codesize "$PREBAKED")"

# Build the forge invocation + signer per phase:
#   all | token (Phase 2b against the LIVE 2a) → launch ONLY the token, signed AS
#     the live owner via anvil impersonation (dev-up-prelaunch unlocked it).
#     UNLOCKED_SENDER=true makes Deploy.s.sol honour the --sender on a 31337 fork;
#     PRIVATE_KEY is left UNSET so the no-key CLI-signer path is taken.
#   contracts (Phase 2a, from-scratch fork) → signed by the anvil dev key.
FORGE_ARGS=(script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --disable-code-size-limit)
case "$PHASE" in
  contracts)
    FORGE_ARGS+=(--sig "runContracts()")
    export PRIVATE_KEY="$DEPLOY_PK"
    ;;
  all|token)
    FORGE_ARGS+=(--sig "runToken()" --sender "$OWNER" --unlocked)
    export UNLOCKED_SENDER=true
    unset PRIVATE_KEY 2>/dev/null || true
    ;;
esac

echo "▸ running Deploy.s.sol ($PHASE) against $RPC_URL$([[ "$PHASE" == "all" || "$PHASE" == "token" ]] && echo " as owner $OWNER") …"
cd "$ROOT/contracts"
set +e
DEPLOY_OUT=$(env \
  ARTCOINS_FACTORY="$FACTORY" \
  ARTCOINS_HOOK_SKIM="$HOOK_SKIM" \
  ARTCOINS_MEV_SKIM="$MEV_SKIM" \
  PC_CONTROLLER="$PC_CTRL" \
  CONVERSION_LOCKER="$LOCKER" \
  ARTCOINS_FEE_ESCROW="$ESCROW" \
  forge "${FORGE_ARGS[@]}" 2>&1)
RC=$?
set -e
cd - >/dev/null

if [[ $RC -ne 0 ]] || ! echo "$DEPLOY_OUT" | grep -q "ONCHAIN EXECUTION COMPLETE"; then
  echo "✗ deploy failed (exit $RC)" >&2
  echo "$DEPLOY_OUT" | tail -40 >&2
  exit 1
fi

# ── Phase 2a: contracts only — token intentionally NOT deployed ────────────
if [[ "$PHASE" == "contracts" ]]; then
  PATRON=$(jq -r '.patron' "$DEPLOYMENTS_JSON")
  PATRON_CS=$(codesize "$PATRON")
  TOKEN_CS=$(codesize "$PREBAKED")
  [[ "$PATRON_CS" != "0" ]] || { echo "✗ Patron has no code after runContracts — deploy didn't take" >&2; exit 1; }
  [[ "$TOKEN_CS" == "0" ]]  || { echo "⚠ token already has code — expected dormant after 2a" >&2; }
  cat <<EOF

────────────────────────────────────────────────────────────────────────
  PHASE 2a DONE — PC contracts deployed, COIN STILL DORMANT.

  Patron: $PATRON   (codesize $PATRON_CS — deployed)
  Token:  $PREBAKED   (codesize 0 — NOT launched yet)

  The site STAYS in the pre-launch state — the code gate keys on the token,
  which has no bytecode yet. This is the dormant intermediate state mainnet
  passes through (verify contracts on Etherscan here, on the real launch).

  Next, launch the coin (site flips live):
    pnpm launch:token
────────────────────────────────────────────────────────────────────────
EOF
  exit 0
fi

# ── Phase 2b / combined: token is now deployed ─────────────────────────────
TOKEN_POST=$(jq -r '.token' "$DEPLOYMENTS_JSON")
echo "  codesize(token) after:  $(codesize "$TOKEN_POST")"

# Determinism: the deployed token MUST match what the site has pre-baked, or the
# client gate won't flip. Compare against .env.local (the site's source of truth).
if [[ "${PREBAKED,,}" != "${TOKEN_POST,,}" ]]; then
  echo "✗ ADDRESS DRIFT: deployed token $TOKEN_POST ≠ pre-baked $PREBAKED" >&2
  echo "  The site won't auto-flip — addresses no longer match." >&2
  echo "  The CREATE2 token address is deterministic, so the snapshot's" >&2
  echo "  tokenPredicted is stale (token config changed). Recompute it from the" >&2
  echo "  TokenLaunchAgainstLive2a rehearsal and update deployments.mainnet.json." >&2
  exit 1
fi

cat <<EOF

────────────────────────────────────────────────────────────────────────
  ${PHASE^^} DONE — token launched, PC stack live on the running fork.

  Token: $TOKEN_POST   (now has code)
  Refresh the browser at the demo URL — the client-side eth_getCode runs on
  mount and the site auto-flips to live.

  Want zero RPC after this (post-launch static mode)? Set
  PC_PROTOCOL_LIVE=true in app/.env.local and restart the app.
────────────────────────────────────────────────────────────────────────
EOF
