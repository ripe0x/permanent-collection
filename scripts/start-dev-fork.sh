#!/usr/bin/env bash
# start-dev-fork.sh — spin up an anvil mainnet fork ready for local
# dev across the PC + artcoins sites.
#
# What it does:
#   1. Kills any anvil already on the target port.
#   2. Picks the most recent cached Foundry RPC block as the fork pin
#      (so we don't depend on publicnode's narrow state window).
#   3. Starts anvil pinned to that block on chain id 31337.
#   4. Warms the canonical Uniswap V4 + Permit2 + Universal Router
#      contracts in anvil's working set. PC's `Deploy.s.sol` doesn't
#      touch them, so without this step the SwapBox pre-flight reverts
#      when the wallet tries the first swap — anvil hits upstream for
#      UR code, upstream has rotated past the pin, request 503s.
#
# Usage:
#   ./scripts/start-dev-fork.sh          # uses port 8545, picks recent cached block
#   PORT=8546 ./scripts/start-dev-fork.sh
#   FORK_BLOCK=25137411 ./scripts/start-dev-fork.sh
#   DEV_WALLETS="0xAAA... 0xBBB..." ./scripts/start-dev-fork.sh
#   DEV_WALLET_ETH=50000 ./scripts/start-dev-fork.sh
#
# Default dev wallet (ripe0x) gets 10k ETH automatically. Override via
# DEV_WALLETS (space-separated) to add/replace; DEV_WALLET_ETH= changes
# the per-wallet amount.
#
# Followups (separate steps — kept manual so they're observable):
#   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:$PORT --broadcast \
#     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

set -euo pipefail

PORT="${PORT:-8545}"
CHAIN_ID="${CHAIN_ID:-31337}"
LOG_FILE="${LOG_FILE:-/tmp/anvil-${PORT}.log}"
# Fork upstream. MUST be archive-capable: anvil's fork backend lazily pulls
# historical state on a cache miss, and this app reads sealed PunksData "data
# contracts" (trait-name + pixel SSTORE2 blobs at 0x6e89…, 0x0111E5…) when it
# renders the on-chain mosaic / trait grid. Those slots aren't warmed by the
# deploy, so they're a cache miss — and publicnode/llamarpc/ankr/cloudflare
# serve historical `eth_call` but PRUNE the historical state anvil needs to
# fetch them ("-32000 old data" / "failed to get account"), so the renderer
# reverts. Tenderly's public gateway serves arbitrary historical blocks with
# no key and survives the fork-instantiation burst — it's the documented
# standing preference for archive fork work (see ~/.claude/CLAUDE.md). dRPC's
# free tier also serves archive but times out under that burst, so avoid it.
# Reads still cache into ~/.foundry/cache/rpc/mainnet/<block>, so the upstream
# is barely hit after the first warm — the pin-the-block cache compounds.
# Fallbacks if Tenderly is down: https://eth-mainnet.public.blastapi.io,
# https://1rpc.io/eth. Override with UPSTREAM=… for your own archive node.
UPSTREAM="${UPSTREAM:-https://gateway.tenderly.co/public/mainnet}"
CACHE_DIR="${HOME}/.foundry/cache/rpc/mainnet"

# Dev wallet(s) to fund with `anvil_setBalance` after the fork comes up.
# Space-separated 0x-addresses. Override via env to add/replace.
#
# Default = ripe0x's dedicated TEST wallet — DELIBERATELY NOT 0xCB43…217F9.
# That address is the artcoins factory owner this script impersonates during
# setup; trading the UI from the SAME address that gets impersonated desyncs
# anvil's mempool nonce-tracking, so correctly-nonced swaps land in anvil's
# "queued" set and never mine — the UI then hangs at "Confirming on-chain…".
# Use a fresh address for UI interaction; the factory owner still gets gas via
# the dedicated top-up further below.
DEV_WALLETS="${DEV_WALLETS:-0x4fa58fFc00D973fD222d573C256Eb3Cc81A8569c}"
# Amount per wallet (ether). 10_000 ETH default — plenty for trading + gas.
DEV_WALLET_ETH="${DEV_WALLET_ETH:-10000}"

if [[ -z "${FORK_BLOCK:-}" ]]; then
  # Pick the most-recent block already in Foundry's RPC cache. anvil
  # serving state from this block won't need upstream at all.
  if [[ -d "${CACHE_DIR}" ]]; then
    FORK_BLOCK=$(ls "${CACHE_DIR}" 2>/dev/null \
      | grep -E '^[0-9]+$' \
      | sort -n \
      | tail -1)
  fi
  if [[ -z "${FORK_BLOCK:-}" ]]; then
    echo "error: no cached blocks in ${CACHE_DIR} and FORK_BLOCK not set" >&2
    echo "       run ./scripts/warm-fork-cache.sh first, or pass FORK_BLOCK=<block>" >&2
    exit 1
  fi
fi

echo "=== start-dev-fork: port=${PORT} chainId=${CHAIN_ID} forkBlock=${FORK_BLOCK} ==="

# Default behaviour is port-specific: free whatever process holds tcp:${PORT}
# so the new anvil can bind, and leave any other anvil on a different port
# alone. That keeps `pnpm dev:up` (e.g. port 8545) and `pnpm test:e2e` (e.g.
# port 8645) from clobbering each other on a dev machine.
#
# Set KILL_ALL_ANVILS=1 to fall back to the older blanket-pkill behaviour,
# which catches a default-port anvil (no `--port` flag — still binds 8545)
# that wouldn't otherwise match a port-specific lookup. Useful if a stale
# anvil from an earlier session is stuck and you don't know its port.
if [[ "${KILL_ALL_ANVILS:-0}" == "1" ]]; then
  if pgrep -x anvil > /dev/null 2>&1; then
    echo "killing existing anvil process(es) (KILL_ALL_ANVILS=1)"
    pkill -x anvil || true
  fi
fi
if command -v lsof > /dev/null 2>&1; then
  PORT_PIDS=$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)
  if [[ -n "${PORT_PIDS}" ]]; then
    echo "freeing port ${PORT}"
    echo "${PORT_PIDS}" | xargs kill -9 2>/dev/null || true
  fi
fi
sleep 1

# Start anvil pinned to the cached block.
#
#   `--gas-limit 1_000_000_000` (1B) raises the block (and therefore
#   default eth_call) gas limit above PC's full-mosaic-SVG render cost
#   (~70M empty cache; ~30M fully cached). Without it, `contractURI()`
#   reverts with "out of gas: out of memory" and the artcoins homepage
#   thumbnail falls back to a blank placeholder.
#
#   `--base-fee 0` pins EIP-1559 baseFee at zero. Some wallets
#   (Rainbow observed; MetaMask occasionally) submit EIP-1559 txs
#   with `maxFeePerGas == maxPriorityFeePerGas` — which leaves no
#   headroom for baseFee and anvil correctly refuses to include the
#   tx. Result: swap submits, hash returns, tx sits in mempool
#   forever, the UI gets stuck at "Confirming on-chain…". With
#   baseFee=0 the constraint `maxFee >= baseFee + maxPriority`
#   reduces to `maxFee >= maxPriority`, which is always true.
#
#   `--disable-code-size-limit` lifts the 24KB EIP-170 cap. The artcoins
#   conversion locker (`ArtCoinsLpLockerFeeConversion`, deployed below for the
#   per-swap fee flywheel) exceeds 24KB under this repo's build settings, so
#   anvil rejects it with `CreateContractSizeLimit` otherwise. Fork-only — the
#   mainnet operator ships a size-compliant build.
nohup anvil \
  --fork-url "${UPSTREAM}" \
  --fork-block-number "${FORK_BLOCK}" \
  --chain-id "${CHAIN_ID}" \
  --port "${PORT}" \
  --gas-limit 1000000000 \
  --base-fee 0 \
  --disable-code-size-limit \
  --silent \
  > "${LOG_FILE}" 2>&1 &
ANVIL_PID=$!
disown $ANVIL_PID 2>/dev/null || true
echo "anvil pid: ${ANVIL_PID}"

# Wait for anvil to accept connections.
for i in {1..20}; do
  if curl -s --max-time 3 -X POST \
       -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
       "http://127.0.0.1:${PORT}" 2>/dev/null | grep -q '"result"'; then
    echo "anvil ready"
    break
  fi
  sleep 1
done

# Warm contracts that PC's Deploy.s.sol doesn't touch but the frontend
# swap path needs. Each eth_getCode call forces anvil to fetch + cache
# the code at the pinned block.
WARM_CONTRACTS=(
  0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af  # Uniswap Universal Router
  0x000000000022D473030F116dDEE9F6B43aC78BA3  # Permit2
  0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203  # V4 Quoter
  0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227  # V4 StateView
)

echo "warming swap-path contracts..."
for ADDR in "${WARM_CONTRACTS[@]}"; do
  RESP=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"${ADDR}\",\"latest\"],\"id\":1}" \
    "http://127.0.0.1:${PORT}")
  if echo "${RESP}" | grep -q '"result":"0x6'; then
    echo "  ${ADDR} ✓"
  else
    echo "  ${ADDR} ✗  ${RESP:0:120}" >&2
  fi
done

# Top up dev wallets via anvil_setBalance. `cast` does the wei + hex
# conversion so we don't have to fight bash's 63-bit int ceiling.
if [[ -n "${DEV_WALLETS}" ]]; then
  WEI_HEX=$(cast to-hex "$(cast to-wei "${DEV_WALLET_ETH}" ether)")
  echo "topping up dev wallets (${DEV_WALLET_ETH} ETH each → ${WEI_HEX} wei)..."
  for WALLET in ${DEV_WALLETS}; do
    RESP=$(curl -s -X POST \
      -H "Content-Type: application/json" \
      --data "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setBalance\",\"params\":[\"${WALLET}\",\"${WEI_HEX}\"],\"id\":1}" \
      "http://127.0.0.1:${PORT}")
    if echo "${RESP}" | grep -q '"result":'; then
      echo "  ${WALLET} ✓"
    else
      echo "  ${WALLET} ✗  ${RESP:0:160}" >&2
    fi
    # Strip any EIP-7702 delegation the FORKED mainnet state carries on this
    # address. Anvil's well-known default accounts double as real mainnet
    # addresses, and some of them have a 7702 delegation on-chain (code =
    # 0xef0100<delegate>). A delegated EOA stops behaving like a plain account:
    # when a contract pays it with a 2300-gas `.transfer` — e.g. the 2017
    # CryptoPunks market's `withdraw()` paying the seller in the acceptBid Claim
    # step — the EVM runs the delegated code, which reverts the whole withdraw
    # with InvalidFEOpcode. Clearing the code restores a plain payable EOA so
    # the dev wallet can collect its proceeds. Harmless (no-op) for an
    # un-delegated account.
    curl -s -X POST \
      -H "Content-Type: application/json" \
      --data "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setCode\",\"params\":[\"${WALLET}\",\"0x\"],\"id\":1}" \
      "http://127.0.0.1:${PORT}" >/dev/null
  done
fi

# ── Bootstrap the prerequisites Deploy.s.sol now requires ──
#
# Under the tax-aware skim-hook architecture, `Deploy.s.sol` reads five env
# vars whose targets must be deployed + allowlisted before it can run:
#   ARTCOINS_FACTORY     — fresh tax-aware ArtCoinsFactory (live V3 factory
#                          lacks the tax entry point; see below)
#   ARTCOINS_HOOK_SKIM   — ArtCoinsHookSkimFee (CREATE2-mined for v4 flag bits)
#   ARTCOINS_MEV_SKIM    — ArtCoinsMevLinearSkim
#   PC_CONTROLLER        — PC-dedicated ProtocolFeeController (80/20)
#   CONVERSION_LOCKER    — ArtCoinsLpLockerFeeConversion
#
# On mainnet the operator deploys these out-of-band (`docs/DEPLOYMENT.md`).
# On the fork we drive `contracts/script/BootstrapDevFork.s.sol` which
# deploys the WHOLE fresh stack in one broadcast — including a fresh
# ArtCoinsFeeEscrow — and allowlists the hook / MEV / locker AND registers the
# locker as a depositor on that fresh escrow, all in-broadcast.
#
# WHY A FRESH ESCROW (issue #169 / audit M1): the old mainnet escrow
# 0xDD1b…1C06 is ABANDONED. PC's tests + production deploy a fresh escrow, so
# the dev fork must too — otherwise dev drifts from mainnet (and reusing the
# dead escrow is exactly what masked the H1 frontend-escrow bug: dev "worked"
# because it reused the same dead escrow the frontend hardcoded). The
# bootstrap owns the fresh escrow, so addDepositor runs in-broadcast and there
# is NO owner impersonation left.
#
# PC's launch deploys its OWN tax-aware ArtCoinsFactory — the live V3 factory
# (0xF051cd…6793e) lacks the `deployTokenWithProtocolBpsAndTax` entry point
# Deploy.s.sol calls (its immutable linked deployer can't emit the tax-aware
# token bytecode), so a deploy against it reverts with empty data on the
# missing selector. BootstrapDevFork therefore deploys a fresh factory (owned
# by the dev key), un-deprecates it, and allowlists the hook / MEV / locker on
# THAT factory in the same broadcast — no owner impersonation and no
# interface-id setCode etch trick (fresh factory + fresh contracts share the
# current `IArtCoins*` interface ids). Deploy.s.sol picks up the fresh factory
# + fresh escrow via ARTCOINS_FACTORY / ARTCOINS_FEE_ESCROW.
FACTORY_ADDR=""
FEE_ESCROW_ADDR=""
SKIM_HOOK_ADDR=""
MEV_SKIM_ADDR=""
PC_CONTROLLER_ADDR=""
CONVERSION_LOCKER=""
CONTRACTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/contracts"

if [[ -d "${CONTRACTS_DIR}/lib/artcoins" ]]; then
  echo "bootstrapping fresh factory + skim hook + MEV skim + PCController + conversion locker..."
  DEV0_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  # Capture forge's exit code explicitly. Under `set -e` a bare
  # `BOOT_OUT=$(forge … )` assignment silently kills the whole script the
  # instant forge reverts — BEFORE the diagnostic dump below ever runs — so a
  # fork bootstrap failure surfaced in CI as a black-box "start-dev-fork.sh
  # exited 1" with no forge trace. Capturing $? and dumping on failure keeps
  # the revert reason visible.
  set +e
  BOOT_OUT=$(cd "${CONTRACTS_DIR}" && PRIVATE_KEY="${DEV0_KEY}" \
    forge script script/BootstrapDevFork.s.sol:BootstrapDevForkScript \
    --rpc-url "http://127.0.0.1:${PORT}" --broadcast \
    --disable-code-size-limit 2>&1)
  BOOT_RC=$?
  set -e
  if [[ ${BOOT_RC} -ne 0 ]]; then
    echo "  bootstrap forge script FAILED (exit ${BOOT_RC}) — full trace:" >&2
    echo "${BOOT_OUT}" | tail -60 >&2
    exit 1
  fi
  FACTORY_ADDR=$(echo "${BOOT_OUT}" | grep -oiE 'BOOTSTRAP factory 0x[a-fA-F0-9]{40}' | grep -oE '0x[a-fA-F0-9]{40}' | head -1)
  FEE_ESCROW_ADDR=$(echo "${BOOT_OUT}" | grep -oiE 'BOOTSTRAP feeEscrow 0x[a-fA-F0-9]{40}' | grep -oE '0x[a-fA-F0-9]{40}' | head -1)
  SKIM_HOOK_ADDR=$(echo "${BOOT_OUT}" | grep -oiE 'BOOTSTRAP skimHook 0x[a-fA-F0-9]{40}' | grep -oE '0x[a-fA-F0-9]{40}' | head -1)
  MEV_SKIM_ADDR=$(echo "${BOOT_OUT}" | grep -oiE 'BOOTSTRAP mevSkim 0x[a-fA-F0-9]{40}' | grep -oE '0x[a-fA-F0-9]{40}' | head -1)
  PC_CONTROLLER_ADDR=$(echo "${BOOT_OUT}" | grep -oiE 'BOOTSTRAP pcController 0x[a-fA-F0-9]{40}' | grep -oE '0x[a-fA-F0-9]{40}' | head -1)
  CONVERSION_LOCKER=$(echo "${BOOT_OUT}" | grep -oiE 'BOOTSTRAP conversionLocker 0x[a-fA-F0-9]{40}' | grep -oE '0x[a-fA-F0-9]{40}' | head -1)
  if [[ -z "${FACTORY_ADDR}" || -z "${FEE_ESCROW_ADDR}" || -z "${SKIM_HOOK_ADDR}" || -z "${MEV_SKIM_ADDR}" || -z "${PC_CONTROLLER_ADDR}" || -z "${CONVERSION_LOCKER}" ]]; then
    echo "  bootstrap FAILED — could not parse all six addresses:" >&2
    echo "${BOOT_OUT}" | tail -40 >&2
    exit 1
  fi
  echo "  factory          ${FACTORY_ADDR}"
  echo "  feeEscrow        ${FEE_ESCROW_ADDR}"
  echo "  skimHook         ${SKIM_HOOK_ADDR}"
  echo "  mevSkim          ${MEV_SKIM_ADDR}"
  echo "  pcController     ${PC_CONTROLLER_ADDR}"
  echo "  conversionLocker ${CONVERSION_LOCKER}"

  # The hook / MEV / locker are already allowlisted on the fresh factory by
  # the broadcast above. Read them back as a sanity check (fail loud if not).
  HOOK_OK=$(cast call "${FACTORY_ADDR}" "enabledHooks(address)(bool)" "${SKIM_HOOK_ADDR}" --rpc-url "http://127.0.0.1:${PORT}" 2>/dev/null)
  MEV_OK=$(cast call "${FACTORY_ADDR}" "enabledMevModules(address)(bool)" "${MEV_SKIM_ADDR}" --rpc-url "http://127.0.0.1:${PORT}" 2>/dev/null)
  LOCKER_OK=$(cast call "${FACTORY_ADDR}" "enabledLockers(address,address)(bool)" "${CONVERSION_LOCKER}" "${SKIM_HOOK_ADDR}" --rpc-url "http://127.0.0.1:${PORT}" 2>/dev/null)
  echo "  factory allowlist: hook=${HOOK_OK} mev=${MEV_OK} locker=${LOCKER_OK}"
  if [[ "${HOOK_OK}" != "true" || "${MEV_OK}" != "true" || "${LOCKER_OK}" != "true" ]]; then
    echo "  ✗ fresh factory allowlist incomplete — aborting" >&2
    exit 1
  fi

  # The locker was registered as a depositor on the FRESH escrow inside the
  # bootstrap broadcast (the deployer owns it). Read it back as a sanity check.
  DEPOSITOR_OK=$(cast call "${FEE_ESCROW_ADDR}" "allowedDepositors(address)(bool)" "${CONVERSION_LOCKER}" --rpc-url "http://127.0.0.1:${PORT}" 2>/dev/null)
  echo "  fresh escrow depositor: locker=${DEPOSITOR_OK}"
  if [[ "${DEPOSITOR_OK}" != "true" ]]; then
    echo "  ✗ locker not registered as depositor on fresh escrow — aborting" >&2
    exit 1
  fi
fi

# Auto-deploy the 111PUNKS protocol so the fork is fully ready in one command.
# Skip with NO_DEPLOY=1 (e.g. when you want a bare fork). The dev private
# key is anvil's default account #0 — fine for a local fork.
#
# Under the four-leg hook redesign there's no per-swap flywheel to bind
# afterward — the hook's `_afterSwap` does the split directly via the
# `bountyBps`/`vaultBurnBps`/`maxReferralBpsOfVolume` config Deploy.s.sol
# writes at `initializePool`. So this section is just: pass the four
# prerequisite addresses through and broadcast.
DEPLOY_PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
if [[ "${NO_DEPLOY:-0}" != "1" && -d "${CONTRACTS_DIR}" ]]; then
  echo "deploying \111PUNKS protocol..."
  if [[ -z "${FACTORY_ADDR}" || -z "${FEE_ESCROW_ADDR}" || -z "${SKIM_HOOK_ADDR}" || -z "${MEV_SKIM_ADDR}" || -z "${PC_CONTROLLER_ADDR}" || -z "${CONVERSION_LOCKER}" ]]; then
    echo "  ✗ missing prerequisite addresses from bootstrap — aborting" >&2
    exit 1
  fi
  # Capture forge's exit code explicitly — same `set -e` swallowing rationale
  # as the bootstrap step above. Without this a Deploy.s.sol revert would kill
  # the script at the assignment, never reaching the success/failure check
  # below, and the final "deployed + ready" banner would never print (the
  # symptom that masked this for the e2e suite).
  set +e
  DEPLOY_OUT=$(cd "${CONTRACTS_DIR}" && env \
    ARTCOINS_FACTORY="${FACTORY_ADDR}" \
    ARTCOINS_HOOK_SKIM="${SKIM_HOOK_ADDR}" \
    ARTCOINS_MEV_SKIM="${MEV_SKIM_ADDR}" \
    PC_CONTROLLER="${PC_CONTROLLER_ADDR}" \
    CONVERSION_LOCKER="${CONVERSION_LOCKER}" \
    ARTCOINS_FEE_ESCROW="${FEE_ESCROW_ADDR}" \
    PRIVATE_KEY="${DEPLOY_PK}" \
    forge script script/Deploy.s.sol --rpc-url "http://127.0.0.1:${PORT}" \
    --broadcast --disable-code-size-limit 2>&1)
  DEPLOY_RC=$?
  set -e
  if [[ ${DEPLOY_RC} -eq 0 ]] && echo "${DEPLOY_OUT}" | grep -q "ONCHAIN EXECUTION COMPLETE"; then
    TOKEN_ADDR=$(echo "${DEPLOY_OUT}" | grep -oE 'token 0x[a-fA-F0-9]{40}' | head -1)
    echo "  ✓ deployed (${TOKEN_ADDR})"

    # Sync the frontend's address env vars from the just-written
    # deployments.json. Without this, every redeploy hands the app stale
    # addresses and the "live state" page reads revert. Only rewrites
    # lines that already exist — leaves unrelated env vars alone.
    APP_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/app/.env.local"
    DEPLOYMENTS_JSON="${CONTRACTS_DIR}/deployments.json"
    if [[ -f "${APP_ENV}" && -f "${DEPLOYMENTS_JSON}" ]]; then
      # env-var name → deployments.json key
      declare -a PAIRS=(
        "NEXT_PUBLIC_PERMANENT_COLLECTION_ADDRESS:permanentCollection"
        "NEXT_PUBLIC_PATRON_ADDRESS:patron"
        "NEXT_PUBLIC_RETURN_AUCTION_MODULE_ADDRESS:returnAuctionModule"
        "NEXT_PUBLIC_PUNK_VAULT_ADDRESS:punkVault"
        "NEXT_PUBLIC_BUYBACK_BURNER_ADDRESS:buybackBurner"
        "NEXT_PUBLIC_LIVE_BID_ADAPTER_ADDRESS:liveBidAdapter"
        "NEXT_PUBLIC_VAULT_BURN_POOL_ADDRESS:vaultBurnPool"
        "NEXT_PUBLIC_VAULT_BURN_ADAPTER_ADDRESS:vaultBurnAdapter"
        "NEXT_PUBLIC_PROTOCOL_FEE_PHASE_ADAPTER_ADDRESS:protocolFeePhaseAdapter"
        "NEXT_PUBLIC_REFERRAL_PAYOUT_ADDRESS:referralPayout"
        "NEXT_PUBLIC_PC_SWAP_CONTEXT_ADDRESS:pcSwapContext"
        "NEXT_PUBLIC_RENDERER_ADDRESS:renderer"
        "NEXT_PUBLIC_TOKEN_ADDRESS:token"
        "NEXT_PUBLIC_PROTOCOL_ADMIN_ADDRESS:protocolAdmin"
        "NEXT_PUBLIC_ARTCOINS_HOOK_ADDRESS:hook"
        "NEXT_PUBLIC_TITLE_AUCTION_ADDRESS:titleAuction"
      )
      synced=0
      missing=()
      for pair in "${PAIRS[@]}"; do
        env_name="${pair%%:*}"
        json_key="${pair##*:}"
        val=$(jq -r --arg k "${json_key}" '.[$k] // empty' "${DEPLOYMENTS_JSON}")
        if [[ -n "${val}" && "${val}" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
          if grep -q "^${env_name}=" "${APP_ENV}"; then
            # Line exists — in-place replace. macOS sed needs ''.
            sed -i '' "s|^${env_name}=.*|${env_name}=${val}|" "${APP_ENV}"
          else
            # Line missing — append. New optional contracts (referralPayout,
            # pcSwapContext) won't be in older .env.local files, and a silent
            # skip there leaves the page in its legacy empty-state forever.
            printf '\n%s=%s\n' "${env_name}" "${val}" >> "${APP_ENV}"
          fi
          synced=$((synced+1))
        else
          missing+=("${env_name}(${json_key})")
        fi
      done
      echo "  → synced ${synced} addresses into app/.env.local"
      if [[ ${#missing[@]} -gt 0 ]]; then
        echo "  ⚠ skipped (no value in deployments.json): ${missing[*]}"
      fi
    else
      echo "  → app/.env.local NOT synced (file missing or deployments.json missing)"
    fi

    # Warp 70 minutes so the 69-min anti-sniper skim window is fully
    # decayed by the time anyone trades on the UI — otherwise the pool
    # is taking ~69% per swap at t=0 and the dev experience is unusable.
    # Override with NO_TIME_WARP=1 for tests that exercise the MEV window.
    if [[ "${NO_TIME_WARP:-0}" != "1" ]]; then
      curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"evm_increaseTime","params":[4200],"id":1}' \
        "http://127.0.0.1:${PORT}" > /dev/null
      curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":1}' \
        "http://127.0.0.1:${PORT}" > /dev/null
      echo "  → warped 70 min past MEV anti-sniper window"
    fi
  else
    echo "  ✗ deploy FAILED (exit ${DEPLOY_RC}) — full trace:" >&2
    echo "${DEPLOY_OUT}" | tail -60 >&2
    exit 1
  fi
fi

cat <<EOF

anvil up on http://127.0.0.1:${PORT} (chainId ${CHAIN_ID}, forked at block ${FORK_BLOCK}).
log: ${LOG_FILE}

\111PUNKS deployed + ready. If you need a bare fork (no deploy): NO_DEPLOY=1 ./scripts/start-dev-fork.sh
NOTE: do NOT use \`pnpm fork:start:bare\` / raw \`anvil --chain-id 1\` — the app
expects chainId ${CHAIN_ID}, and a bare fork has no \111PUNKS pool (blank price/MC,
stuck swaps).

EOF
