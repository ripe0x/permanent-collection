#!/usr/bin/env bash
# Print a one-line on-chain snapshot of the protocol's invariants for the
# current anvil state. Useful as a state-id verification companion to the
# /e2e walkthrough.
#
# Usage: bash scripts/state-snapshot.sh
#
# Reads addresses from contracts/deployments.json.
set -euo pipefail
RPC="${RPC:-http://127.0.0.1:8545}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
J="$ROOT/contracts/deployments.json"
[[ -f "$J" ]] || { echo "no $J"; exit 1; }

PATRON=$(jq -r .patron "$J")
PC=$(jq -r .permanentCollection "$J")
TITLE=$(jq -r .titleAuction "$J")
VAULT=$(jq -r .punkVault "$J")
POL=$(jq -r .polDepositor "$J")
ADMIN=$(jq -r .protocolAdmin "$J")

ACQ=$(cast call "$PC" "acquisitionCount()(uint256)" --rpc-url "$RPC")
COL=$(cast call "$PC" "collectedCount()(uint256)" --rpc-url "$RPC")
# The live bid is the accounted bid (`bidBalance()`), not Patron's raw balance —
# forced/unaccounted ETH is excluded from the bid.
BID=$(cast call "$PATRON" "bidBalance()(uint256)" --rpc-url "$RPC")
BID_ETH=$(printf "%.4f" "$(echo "scale=18; $BID / 10^18" | bc -l)")
KICK_READY=$(cast call "$TITLE" "isKickoffReady()(bool)" --rpc-url "$RPC" 2>/dev/null || echo "?")
KICKED=$(cast call "$TITLE" "kickedOff()(bool)" --rpc-url "$RPC" 2>/dev/null || echo "?")
LOCKED=$(cast call "$ADMIN" "isLocked()(bool)" --rpc-url "$RPC" 2>/dev/null || echo "?")
BLK=$(cast block-number --rpc-url "$RPC")
TS=$(cast rpc eth_getBlockByNumber latest false --rpc-url "$RPC" 2>/dev/null | jq -r .timestamp 2>/dev/null || echo "?")

echo "block=$BLK ts=$TS  acq=$ACQ  collected=$COL  bid=${BID_ETH} ETH  kickReady=$KICK_READY kicked=$KICKED  adminLocked=$LOCKED"
