#!/usr/bin/env bash
# warp-fork.sh — fast-forward the local anvil fork to test anti-sniper states.
#
# Why this exists:
#   `dev:up` leaves the fork AT the deploy block, so the anti-sniper window is
#   live: the SKIM MEV module (ArtCoinsMevLinearSkim) takes ~90% of every swap
#   at t=0 and decays linearly at 1%/min down to the 5% baseline over 85 min
#   (5100s). To test a later state without restarting the stack, warp the
#   clock forward by MINUTES and mine a block so it takes effect.
#
#   Skim schedule (approx, skim ≈ max(5, 90 − minutes_elapsed)% ):
#     deploy block .......  90%   (the launch / sniper-defense state)
#     MINUTES=20 .........  70%
#     MINUTES=43 .........  47%   (~mid-window)
#     MINUTES=85 .........   5%   (window just closed)
#     MINUTES=90 .........   5%   (comfortably past — baseline regime)
#   After warping, refresh the UI: the swap box reads the live skim +
#   countdown from the module, so you'll see exactly which state you're in.
#
# Note: warping pushes anvil's block clock AHEAD of wall-clock. Swap deadlines
# are computed off the pending block (see app/lib/swap/chainTime.ts), so this
# no longer breaks swaps the way a wall-clock-based deadline would.
#
# Usage:
#   ./scripts/warp-fork.sh            # warps 90 min — past the window → 5% baseline
#   MINUTES=43 ./scripts/warp-fork.sh # ~mid-window → ~47% skim
#   PORT=8546 ./scripts/warp-fork.sh  # non-default anvil port

set -euo pipefail

PORT="${PORT:-8545}"
MINUTES="${MINUTES:-90}"
RPC="http://127.0.0.1:${PORT}"
SECONDS_TO_WARP=$(( MINUTES * 60 ))

# Sanity: anvil reachable?
if ! curl -s --max-time 3 -X POST -H "Content-Type: application/json" \
     --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
     "${RPC}" 2>/dev/null | grep -q '"result"'; then
  echo "error: anvil not reachable at ${RPC}" >&2
  echo "       start it first via: pnpm fork:start" >&2
  exit 1
fi

# Before: current block + timestamp.
BEFORE_TS=$(curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}' \
  "${RPC}" | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result']['timestamp'], 16))")
BEFORE_BLOCK=$(curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  "${RPC}" | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'], 16))")

echo "warping ${MINUTES} min (${SECONDS_TO_WARP}s)..."
echo "  before: block=${BEFORE_BLOCK} ts=${BEFORE_TS}"

# Warp the clock + mine a block so the new timestamp takes effect.
curl -s -X POST -H "Content-Type: application/json" \
  --data "{\"jsonrpc\":\"2.0\",\"method\":\"evm_increaseTime\",\"params\":[${SECONDS_TO_WARP}],\"id\":1}" \
  "${RPC}" > /dev/null
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":1}' \
  "${RPC}" > /dev/null

AFTER_TS=$(curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}' \
  "${RPC}" | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result']['timestamp'], 16))")
AFTER_BLOCK=$(curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  "${RPC}" | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'], 16))")

DELTA=$(( AFTER_TS - BEFORE_TS ))
echo "  after:  block=${AFTER_BLOCK} ts=${AFTER_TS} (Δ=${DELTA}s)"
echo "done. Warped ${MINUTES} min. Refresh the UI — the swap box shows the"
echo "current anti-sniper skim + countdown (≈ max(5, 90 − minutes_elapsed)%)."
