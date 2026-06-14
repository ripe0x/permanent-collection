#!/usr/bin/env bash
# warm-fork-cache.sh — populate Foundry's per-block RPC cache for the
# pinned mainnet fork so subsequent runs hit cache instead of upstream.
#
# Usage:
#   ./scripts/warm-fork-cache.sh [FORK_BLOCK]
#
# Reads FORK_BLOCK from arg, then env, then defaults to the suggested
# launch-cycle block. Reads MAINNET_RPC_URL from env; must be an
# archive-tier endpoint (paid Alchemy/Infura/Quicknode, or a free archive
# tier like dRPC/BlockPI/Chainstack).
#
# Idempotent: re-running on an already-warm block spends ~zero CU.
# Foundry's cache at ~/.foundry/cache/rpc/mainnet/<block> serves every
# state read from disk on the second+ run.
#
# See docs/CACHE_WARMUP.md for the full recipe.

set -euo pipefail

DEFAULT_FORK_BLOCK=25133816
DEFAULT_FUZZ_SEED=0x1234
FORK_BLOCK="${1:-${FORK_BLOCK:-$DEFAULT_FORK_BLOCK}}"
# Pin the fuzz seed so testFuzz_* runs generate deterministic inputs —
# without this, each run picks fresh random values and the cache misses
# the addresses those fuzz inputs derive.
FOUNDRY_FUZZ_SEED="${FOUNDRY_FUZZ_SEED:-$DEFAULT_FUZZ_SEED}"
export FOUNDRY_FUZZ_SEED
CACHE_DIR="${HOME}/.foundry/cache/rpc/mainnet"
CACHE_ENTRY="${CACHE_DIR}/${FORK_BLOCK}"

# Find the contracts dir relative to this script.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
CONTRACTS_DIR="${REPO_ROOT}/contracts"

if [[ ! -f "${CONTRACTS_DIR}/foundry.toml" ]]; then
  echo "error: ${CONTRACTS_DIR}/foundry.toml not found — run from a repo checkout." >&2
  exit 1
fi

# Auto-load .env if present (project root). Don't clobber pre-set env vars.
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.env"
  set +a
fi

if [[ -z "${MAINNET_RPC_URL:-}" ]]; then
  cat >&2 <<EOF
error: MAINNET_RPC_URL is unset.

The first warmup run NEEDS an archive-tier RPC — public RPCs only serve
the last ~128 blocks of historical state, and the pinned block will fall
outside that window.

Set one of:
  - Paid: Alchemy / Infura / Quicknode (any tier)
  - Free archive tiers: dRPC / BlockPI / Chainstack

  export MAINNET_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/<KEY>"
  ./scripts/warm-fork-cache.sh ${FORK_BLOCK}

Once the cache is warm, day-to-day runs can use any RPC (the cache serves
state from disk). See docs/CACHE_WARMUP.md.
EOF
  exit 1
fi

# Warn if MAINNET_RPC_URL looks like a public/non-archive endpoint. The
# warmup will likely fail with "historical state ... is not available"
# errors partway through.
case "${MAINNET_RPC_URL}" in
  *publicnode*|*llamarpc*|*cloudflare-eth*|*ankr.com/eth*)
    cat >&2 <<EOF
warning: MAINNET_RPC_URL looks like a public RPC (no archive support).

Public RPCs only serve the last ~128 blocks of historical state. The
warmup will likely fail with "historical state ... is not available"
partway through.

Use an archive-tier endpoint for the first warmup (paid Alchemy/Infura,
or a free archive tier from dRPC/BlockPI/Chainstack), then switch back
to public RPC for day-to-day runs.

Continuing anyway in 5s — Ctrl-C to abort.
EOF
    sleep 5
    ;;
esac

echo "=== warm-fork-cache: FORK_BLOCK=${FORK_BLOCK} FOUNDRY_FUZZ_SEED=${FOUNDRY_FUZZ_SEED} ==="

# Report cache state before.
mkdir -p "${CACHE_DIR}"
if [[ -e "${CACHE_ENTRY}" ]]; then
  if [[ -f "${CACHE_ENTRY}" ]]; then
    SIZE_BEFORE=$(du -h "${CACHE_ENTRY}" 2>/dev/null | awk '{print $1}')
    FILES_BEFORE=1
  else
    SIZE_BEFORE=$(du -sh "${CACHE_ENTRY}" 2>/dev/null | awk '{print $1}')
    FILES_BEFORE=$(find "${CACHE_ENTRY}" -type f 2>/dev/null | wc -l | tr -d ' ')
  fi
  echo "cache before: ${SIZE_BEFORE} (${FILES_BEFORE} file(s)) at ${CACHE_ENTRY}"
else
  SIZE_BEFORE="0"
  FILES_BEFORE=0
  echo "cache before: cold (no entry at ${CACHE_ENTRY})"
fi

echo "running full fork-test suite from ${CONTRACTS_DIR}..."
echo

# Run the full suite. FORK_BLOCK + MAINNET_RPC_URL exported into the
# child process; ForkFixtures.sol picks them up via vm.envOr.
cd "${CONTRACTS_DIR}"
FORK_BLOCK="${FORK_BLOCK}" MAINNET_RPC_URL="${MAINNET_RPC_URL}" forge test
TEST_EXIT=$?

echo
echo "=== warmup complete (forge exit ${TEST_EXIT}) ==="

# Report cache state after.
if [[ -e "${CACHE_ENTRY}" ]]; then
  if [[ -f "${CACHE_ENTRY}" ]]; then
    SIZE_AFTER=$(du -h "${CACHE_ENTRY}" 2>/dev/null | awk '{print $1}')
    FILES_AFTER=1
  else
    SIZE_AFTER=$(du -sh "${CACHE_ENTRY}" 2>/dev/null | awk '{print $1}')
    FILES_AFTER=$(find "${CACHE_ENTRY}" -type f 2>/dev/null | wc -l | tr -d ' ')
  fi
  echo "cache after:  ${SIZE_AFTER} (${FILES_AFTER} file(s)) at ${CACHE_ENTRY}"
else
  echo "cache after:  still cold — something is wrong (no entry created)"
  exit 1
fi

if [[ "${SIZE_BEFORE}" == "${SIZE_AFTER}" && ${FILES_BEFORE} == "${FILES_AFTER}" ]]; then
  echo
  echo "→ cache size unchanged — already fully warm at this block, ~zero CU spent."
else
  echo
  echo "→ cache populated. Day-to-day runs at FORK_BLOCK=${FORK_BLOCK} now serve from disk."
fi

echo
cat <<EOF
Next steps:
  1. Persist FORK_BLOCK=${FORK_BLOCK} in your shell rc or .env.
  2. Switch MAINNET_RPC_URL to a free public RPC (publicnode/llamarpc) for
     day-to-day runs — the cache covers all historical state reads.
  3. See docs/CACHE_WARMUP.md for the invariant-suite caveat.
EOF

exit ${TEST_EXIT}
