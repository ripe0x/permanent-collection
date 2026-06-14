#!/usr/bin/env bash
# dev-up.sh — bring up the entire local dev stack in one command and print the
# links you need:
#
#   [1] local mainnet fork + full 111PUNKS deploy + per-swap flywheel
#       (delegates to start-dev-fork.sh)
#   [2] PERMANENT COLLECTION front-end   (Next, :3000)
#   [3] artcoins front-end               (Next, :3001)
#   [+] (optional) trading-simulator loop so the bounty grows on its own
#
# Front-ends + sim run in the background (logs in /tmp); the fork's anvil is
# already backgrounded by start-dev-fork.sh. The script waits for the front-ends
# to come up, then prints every URL.
#
# Usage:
#   ./scripts/dev-up.sh                       # fork + both sites
#   SIMULATE=1 ./scripts/dev-up.sh            # also start the trading loop
#   SEED_TITLE_THRESHOLD=1 ./scripts/dev-up.sh  # vault 56 Punks → /title kickoff
#   SEED_DEV_PUNKS=5 ./scripts/dev-up.sh      # give the dev wallet 5 Punks (spread across the 10k) → /accept
#   NO_FORK=1 ./scripts/dev-up.sh             # reuse the running fork, just (re)start the sites
#   FORK_BLOCK=25145000 ./scripts/dev-up.sh   # pin the fork block (warm cache)
#   TIME_WARP=1 ./scripts/dev-up.sh           # auto-warp past the 85-min anti-sniper window (old behaviour)
#
# Fork starts AT the deploy block — the anti-sniper window is LIVE (~90% skim,
# decaying 1%/min to 5% over 85 min), so the launch state is testable in the
# UI out of the box. To jump to a later state, fast-forward the running fork:
#   ./scripts/warp-fork.sh                    # past the window → 5% baseline
#   MINUTES=43 ./scripts/warp-fork.sh         # ~mid-window → ~47% skim
# then refresh the UI (the swap box shows the current skim + countdown).
#
# Env overrides:
#   PC_PORT (3000)  ARTCOINS_PORT (3001)  RPC_PORT (8545)
#   ARTCOINS_DIR (../artcoins)  FORK_BLOCK  SIMULATE  NO_FORK  TIME_WARP
#   SEED_DEV_PUNKS (count)  SEED_DEV_PUNKS_WALLET (recipient)  SEED_DEV_PUNK_IDS (explicit ids)
#
# Stop everything:  pkill -x anvil ; lsof -ti tcp:$PC_PORT -i tcp:$ARTCOINS_PORT | xargs kill

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# PRELAUNCH=1 — bring the stack up with the deterministic launch addresses
# pre-baked into the site but no PC contracts deployed yet, then `pnpm
# launch:fire` to watch the site auto-flip live. Delegates to a dedicated
# script so this one stays focused on the normal-dev path.
if [[ "${PRELAUNCH:-0}" == "1" ]]; then
  exec "$ROOT/scripts/dev-up-prelaunch.sh"
fi

APP_DIR="${APP_DIR:-$ROOT/app}"
ARTCOINS_DIR="${ARTCOINS_DIR:-$(cd "$ROOT/.." && pwd)/artcoins}"

PC_PORT="${PC_PORT:-3000}"
ARTCOINS_PORT="${ARTCOINS_PORT:-3001}"
RPC_PORT="${RPC_PORT:-8545}"

PC_LOG="/tmp/pc-app-${PC_PORT}.log"
ARTCOINS_LOG="/tmp/artcoins-app-${ARTCOINS_PORT}.log"
SIM_LOG="/tmp/pc-sim-trading.log"

# Free a TCP port by killing whatever holds it (targeted — won't touch other
# Next servers on other ports, e.g. an unrelated project on :3002).
free_port() {
  command -v lsof >/dev/null 2>&1 || return 0
  local pids; pids=$(lsof -ti "tcp:$1" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "    freeing port $1"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
}

# Poll until something is LISTENING on the port (Next binds the port once it's
# ready to serve; the first request then triggers compilation in the browser).
wait_listen() {
  local port="$1" tries="${2:-90}" i
  for ((i = 1; i <= tries; i++)); do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# ── [1] fork + deploy + flywheel ────────────────────────────────────────────
if [[ "${NO_FORK:-0}" == "1" ]]; then
  echo "▸ [1/3] fork: skipped (NO_FORK=1) — reusing whatever is on :${RPC_PORT}"
else
  echo "▸ [1/3] fork + deploy + flywheel …"
  # Leave the fork AT the deploy block (anti-sniper window live, ~90% skim
  # decaying 1%/min over 85 min) so the launch state is testable in the UI.
  # NOT warped past the window — use scripts/warp-fork.sh to jump to any
  # later state (mid-decay / expired). Set TIME_WARP=1 to restore the old
  # auto-warp-past-the-window behaviour.
  PORT="$RPC_PORT" NO_TIME_WARP="$([[ "${TIME_WARP:-0}" == "1" ]] && echo 0 || echo 1)" \
    "$ROOT/scripts/start-dev-fork.sh"
fi

TOKEN=$(jq -r '.token // empty' "$ROOT/contracts/deployments.json" 2>/dev/null || true)

# ── [2] PERMANENT COLLECTION front-end ──────────────────────────────────────
echo "▸ [2/3] PERMANENT COLLECTION front-end → :${PC_PORT}"
free_port "$PC_PORT"
( cd "$APP_DIR" && PORT="$PC_PORT" nohup pnpm dev >"$PC_LOG" 2>&1 & echo $! >/tmp/pc-app.pid )

# ── [3] artcoins front-end ──────────────────────────────────────────────────
ARTCOINS_RUNNING=0
if [[ -d "$ARTCOINS_DIR" ]]; then
  echo "▸ [3/3] artcoins front-end → :${ARTCOINS_PORT}  ($ARTCOINS_DIR)"
  free_port "$ARTCOINS_PORT"
  ( cd "$ARTCOINS_DIR" && PORT="$ARTCOINS_PORT" nohup npm run dev >"$ARTCOINS_LOG" 2>&1 & echo $! >/tmp/artcoins-app.pid )
  ARTCOINS_RUNNING=1
else
  echo "▸ [3/3] artcoins SKIPPED — not found at $ARTCOINS_DIR (set ARTCOINS_DIR=…)"
fi

# ── [+] optional trading simulator ──────────────────────────────────────────
if [[ "${SIMULATE:-0}" == "1" ]]; then
  echo "▸ trading simulator loop → $SIM_LOG"
  ( cd "$ROOT" && RPC_URL="http://127.0.0.1:${RPC_PORT}" nohup pnpm tsx scripts/simulate-trading-loop.ts >"$SIM_LOG" 2>&1 & echo $! >/tmp/pc-sim.pid )
fi

# ── [+] optional Title-Auction kickoff seed ─────────────────────────────────
# Vault 56 Punks so PunkVaultTitleAuction.kickoff() becomes callable.
# Useful for testing the /title page's bid flow end-to-end on a fresh fork.
if [[ "${SEED_TITLE_THRESHOLD:-0}" == "1" ]]; then
  echo "▸ seeding Title-Auction kickoff threshold (vaulting 56 Punks)…"
  ( cd "$ROOT" && RPC_URL="http://127.0.0.1:${RPC_PORT}" pnpm tsx scripts/seed-title-threshold.ts )
fi

# ── [+] optional dev-wallet Punk seed ───────────────────────────────────────
# start-dev-fork.sh funds the dev wallet with ETH but never transfers it any
# Punks, so /accept has nothing to show out of the box. SEED_DEV_PUNKS=<count>
# hands the dev wallet that many Punks, picked evenly spread across the 10k
# collection (centered in each 10000/N bucket — e.g. N=5 → 1000 3000 5000
# 7000 9000) so they aren't clustered at the low ids. Override the recipient
# with SEED_DEV_PUNKS_WALLET (default = first DEV_WALLETS entry) or the exact
# ids with SEED_DEV_PUNK_IDS="12 3456 …". Delegates to scripts/give-punk.ts,
# which impersonates each Punk's current owner on the fork and transfers it.
if [[ -n "${SEED_DEV_PUNKS:-}" && "${SEED_DEV_PUNKS}" != "0" ]]; then
  SEED_N="${SEED_DEV_PUNKS}"
  SEED_WALLET="${SEED_DEV_PUNKS_WALLET:-${DEV_WALLETS:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}}"
  SEED_WALLET="${SEED_WALLET%% *}"   # first token if DEV_WALLETS holds several
  if [[ -n "${SEED_DEV_PUNK_IDS:-}" ]]; then
    SEED_IDS="${SEED_DEV_PUNK_IDS}"
  else
    SEED_IDS=""
    SEED_STEP=$(( 10000 / SEED_N ))
    SEED_HALF=$(( SEED_STEP / 2 ))
    for ((k = 0; k < SEED_N; k++)); do SEED_IDS+="$(( k * SEED_STEP + SEED_HALF )) "; done
  fi
  echo "▸ seeding dev Punks → ${SEED_WALLET}:  ${SEED_IDS}"
  SEED_OK=0
  for ID in ${SEED_IDS}; do
    if ( cd "$ROOT" && RECIPIENT="$SEED_WALLET" PUNK_ID="$ID" RPC_URL="http://127.0.0.1:${RPC_PORT}" \
           pnpm tsx scripts/give-punk.ts >"/tmp/pc-seed-punk-${ID}.log" 2>&1 ); then
      echo "    ✓ #$ID"
      SEED_OK=$((SEED_OK + 1))
    else
      echo "    ✗ #$ID — $(tail -1 "/tmp/pc-seed-punk-${ID}.log") (full log: /tmp/pc-seed-punk-${ID}.log)"
    fi
  done
  echo "    seeded ${SEED_OK} Punk(s) to ${SEED_WALLET} — connect as that wallet on /accept"
fi

# ── wait for the front-ends to bind their ports ─────────────────────────────
echo ""
echo "waiting for front-ends to boot (first Turbopack compile can take ~30s)…"
PC_OK=0; ART_OK=0
wait_listen "$PC_PORT" 120 && PC_OK=1 || true
if [[ "$ARTCOINS_RUNNING" == "1" ]]; then
  wait_listen "$ARTCOINS_PORT" 120 && ART_OK=1 || true
fi

status() { [[ "$1" == "1" ]] && echo "" || echo "  (still booting — tail $2)"; }

# ── print the links ─────────────────────────────────────────────────────────
cat <<EOF

────────────────────────────────────────────────────────────────────────
  LOCAL DEV IS UP

  PERMANENT COLLECTION$(status "$PC_OK" "$PC_LOG")
    home          http://localhost:${PC_PORT}
    trade (\111PUNKS)   http://localhost:${PC_PORT}/trade
    collection    http://localhost:${PC_PORT}/collection
EOF

if [[ "$ARTCOINS_RUNNING" == "1" ]]; then
cat <<EOF

  artcoins$(status "$ART_OK" "$ARTCOINS_LOG")
    home          http://localhost:${ARTCOINS_PORT}
    \111PUNKS token     http://localhost:${ARTCOINS_PORT}/${TOKEN:-<token-addr>}
EOF
fi

cat <<EOF

  WALLET / RPC
    network       http://127.0.0.1:${RPC_PORT}   (chainId 31337)
    \111PUNKS token     ${TOKEN:-<run a deploy>}

  ANTI-SNIPER WINDOW (live at the deploy block — ~90% skim, decays to 5% over 85 min)
    fast-forward  ./scripts/warp-fork.sh              (past the window → 5% baseline)
                  MINUTES=43 ./scripts/warp-fork.sh   (~mid-window → ~47% skim)
    (then refresh the UI — the swap box shows the current skim + countdown)

  SIMULATE ACTIVITY
    trading loop  pnpm tsx scripts/simulate-trading-loop.ts$( [[ "${SIMULATE:-0}" == "1" ]] && echo "   (already running → $SIM_LOG)" )
    give a Punk   PUNK_ID=42 RECIPIENT=0xYourWallet pnpm tsx scripts/give-punk.ts
    seed /accept  SEED_DEV_PUNKS=5 ./scripts/dev-up.sh   (5 Punks spread across the 10k → dev wallet)$( [[ -n "${SEED_DEV_PUNKS:-}" && "${SEED_DEV_PUNKS:-0}" != "0" ]] && echo "   (done above)" )

  LOGS    anvil /tmp/anvil-${RPC_PORT}.log  ·  pc ${PC_LOG}$( [[ "$ARTCOINS_RUNNING" == "1" ]] && echo "  ·  artcoins ${ARTCOINS_LOG}" )
  STOP    pkill -x anvil ; lsof -ti tcp:${PC_PORT} -i tcp:${ARTCOINS_PORT} | xargs kill
────────────────────────────────────────────────────────────────────────
EOF
