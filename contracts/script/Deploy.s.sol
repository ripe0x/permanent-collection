// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {PermanentCollection} from "../src/PermanentCollection.sol";
import {PunkVault} from "../src/PunkVault.sol";
import {Patron} from "../src/Patron.sol";
import {LiveBidAdapter} from "../src/LiveBidAdapter.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {ProtocolAdmin} from "../src/ProtocolAdmin.sol";
import {VaultBurnPool} from "../src/VaultBurnPool.sol";
import {IArtcoinsFactory} from "../src/interfaces/IArtcoinsFactory.sol";
import {TokenAdminPoker} from "../src/TokenAdminPoker.sol";
import {ProtocolFeePhaseAdapter} from "../src/ProtocolFeePhaseAdapter.sol";
import {PermanentCollectionMosaicRenderer} from "../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../src/PunkSvgFragmentCache.sol";
import {TraitIconCache} from "../src/TraitIconCache.sol";
import {PunkVaultTitleAuction} from "../src/PunkVaultTitleAuction.sol";
import {RendererRegistry} from "../src/RendererRegistry.sol";
import {PCSwapContext} from "../src/PCSwapContext.sol";
import {ReferralPayout} from "../src/ReferralPayout.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

// PC's 111 launches on the conversion-aware LP locker (converts artcoin-side
// fees to native ETH at collect). The conversion locker is shared artcoins
// infra (deployed + allowlisted by the artcoins owner); PC references it by
// address via the CONVERSION_LOCKER env var.
import {FeeAutoSwapper} from "artcoins/FeeAutoSwapper.sol";
// New hook + MEV module for the skim-based fee architecture (see
// docs/HOOK_REDESIGN_SPEC.md). Replaces the legacy ArtCoinsHookStaticFee +
// ArtCoinsMevLinearFees pair for PC. The legacy contracts stay in place for
// LAYER and any other tokens already deployed against them.
import {IArtCoinsHookSkimFee} from "artcoins/hooks/interfaces/IArtCoinsHookSkimFee.sol";
// Venue-scoped buy-side transfer tax (default-off shared infra on
// ArtCoinsToken). PC's 111 launch opts in via
// `deployTokenWithProtocolBpsAndTax`. See docs/TRANSFER_TAX_INVESTIGATION.md.
import {TaxConfig, TaxVenue} from "artcoins/interfaces/IArtCoinsTaxable.sol";

// Used to compute the launch tick from a target FDV + ETH/USD price at
// deploy time. `FixedPointMathLib.sqrt` underpins the price→sqrtPriceX96
// conversion; `TickMath.getTickAtSqrtPrice` is V4's canonical
// sqrtPriceX96→tick converter.
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

/// @notice Deploys the V4 PERMANENT COLLECTION protocol: records-only core,
///         immutable vault, global Patron with `acceptBid` /
///         `acceptListing` entry points, return auction module with parameterized
///         reserve + split, paced BuybackBurner with permissionless execution
///         reward, artcoins factory token + LP + locker, and the on-chain
///         renderer.
///
///         **Pre-launch operator checklist** (coordinate with the artcoins
///         V3 factory owner BEFORE running this script on mainnet):
///         1. Factory un-deprecated: `factory.setDeprecated(false)`
///         2. Skim MEV module allowlisted on the fresh factory:
///            `factory.setMevModule(ARTCOINS_MEV_SKIM, true)`
///            (the `ArtCoinsMevLinearSkim` deployed with the fresh stack; the
///            factory has its own `enabledMevModules` mapping. The deploy
///            reverts `MevModuleNotEnabled()` if missed.)
///         3. Burn router slippage floor set (see `DeployNativeEthStack.s.sol`).
///         4. LP locker (`ArtCoinsLpLocker`) deployed as
///            shared artcoins infra and:
///              a. allowlisted on the factory: `factory.setLocker(convLocker, hook, true)`
///              b. added as an escrow depositor: `feeEscrow.addDepositor(convLocker)`
///                 AND the skim hook added too: `feeEscrow.addDepositor(hook)` —
///                 CRITICAL, the hook deposits the protocol fee leg into the
///                 escrow every swap, so a missing hook depositor reverts all
///                 trading. `VerifyDeploy` asserts `allowedDepositors(hook)`.
///            Then export its address: `CONVERSION_LOCKER=0x…` (read by `run()`).
///         5. The new `ArtCoinsHookSkimFee` and `ArtCoinsMevLinearSkim`
///            must be deployed and allowlisted on the factory by the
///            artcoins factory owner. Export their addresses via env vars:
///              `ARTCOINS_HOOK_SKIM=0x…`
///              `ARTCOINS_MEV_SKIM=0x…`
///         6. PC's dedicated `ProtocolFeeController` (PCController, 86.67/13.33
///            treasury/burn split) must be deployed. Export its address:
///              `PC_CONTROLLER=0x…`
///         7. The fresh artcoins fee escrow (`ArtCoinsFeeEscrow`) deployed with
///            the new stack. Export its address:
///              `ARTCOINS_FEE_ESCROW=0x…`
///
/// @dev Minimal view into the LP locker's immutable fee escrow, used by the
///      preflight escrow cross-check. PC no longer imports the locker contract,
///      so it declares just the `feeLocker()` getter it needs here.
interface IConversionLockerFeeEscrow {
    function feeLocker() external view returns (address);
}

contract DeployScript is Script {
    error MissingPrivateKey();

    // External mainnet addresses.
    address constant PUNKS_MARKET = 0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB;
    address constant PUNKS_DATA = 0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C;
    address constant V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    // The artcoins stack PC launches on — factory, fee escrow, skim hook, skim
    // MEV module, PC `ProtocolFeeController`, and LP locker — is a FRESH
    // tax-aware deployment passed entirely by env var. There are NO hardcoded
    // address fallbacks: every resolver below reverts when its env var is unset
    // rather than defaulting to any prior/stale contract, so a missing intended
    // address stops the deploy instead of silently binding the wrong stack
    // (e.g. an escrow cross-check in `_assertExternalAddresses` re-confirms the
    // escrow against the locker's own immutable `feeLocker()`).

    /// @dev Resolve the SKIM hook address (`ArtCoinsHookSkimFee`). PC's new
    ///      fee architecture uses the skim hook, NOT the legacy
    ///      ArtCoinsHookStaticFee. Set `ARTCOINS_HOOK_SKIM` env var to the
    ///      deployed address. Reverts if unset — no canonical fallback yet
    ///      since the new hook is not yet deployed on mainnet.
    function _resolveSkimHook() internal view returns (address) {
        address h = vm.envOr("ARTCOINS_HOOK_SKIM", address(0));
        require(h != address(0), "Deploy: set ARTCOINS_HOOK_SKIM env (deployed + allowlisted skim hook)");
        return h;
    }

    /// @dev `mevModuleData` for `ArtCoinsMevLinearSkim.initialize`:
    ///        abi.encode(uint24 startingBps, uint24 endingBps, uint32 duration)
    ///      Skim module bps are in hundred-thousandths (100_000 = 100%):
    ///      - startingBps = 90_000 (90% skim at t=0 — the hook's MAX_SKIM_BPS)
    ///      - endingBps   =  6_000 (6% baseline skim — the active steady-state)
    ///      - duration    =  1_800 (30 min in seconds)
    ///      Decay shape: linear from 90% to 6% over 30 min (2.8% per minute).
    function _mevSkimInitData() internal pure returns (bytes memory) {
        return abi.encode(uint24(90_000), uint24(6000), uint32(1800));
    }

    /// @dev Resolve the configured starting tick for the factory's
    ///      `tickIfToken0IsArtCoins` field. Reads `ETH_USD_PRICE` env var
    ///      (defaults to `REFERENCE_ETH_USD_PRICE` = $2,100 if unset),
    ///      computes the on-pool tick that puts launch FDV at
    ///      `TARGET_LAUNCH_FDV_USD = $69,000` given
    ///      `FDV_CALC_SUPPLY_WHOLE = 999M` tokens, then negates (because
    ///      the factory inverts when 111 is `currency1`).
    ///
    ///      Math:
    ///        111_per_ETH = supply_whole * ETH_USD / FDV_USD
    ///        sqrtPriceX96 = sqrt(111_per_ETH * 2^192)
    ///        on_pool_tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96)
    ///        configured_tick = -on_pool_tick, rounded toward zero to
    ///                          the tick-spacing grid
    ///
    ///      At reference price ($2,100): 111_per_ETH ≈ 30.4M → on-pool
    ///      tick ≈ +172,300 → configured ≈ -172,200 (rounded to spacing).
    ///      Launched FDV at this tick with current 1.11B supply: ~$77K.
    ///      Launched FDV after block 3 reduces locker mint to 999M: $69K.
    function _computeStartingTick() internal view returns (int24) {
        uint256 ethUsdPrice = vm.envOr("ETH_USD_PRICE", REFERENCE_ETH_USD_PRICE);
        require(ethUsdPrice >= 100 && ethUsdPrice <= 100_000, "Deploy: ETH_USD_PRICE out of sanity range");

        // 111 per ETH (whole-token ratio).
        uint256 pctPerEth = (FDV_CALC_SUPPLY_WHOLE * ethUsdPrice) / TARGET_LAUNCH_FDV_USD;

        // sqrtPriceX96 = sqrt(pctPerEth << 192) = sqrt(pctPerEth) * 2^96.
        // Safe-shift check: pctPerEth must fit in 64 bits (so x << 192 fits
        // in 256). At realistic ETH/USD ranges (100..100_000) and 999M
        // supply / $69K FDV, pctPerEth is bounded around 1.4M..1.4B —
        // comfortably under 2^31.
        require(pctPerEth > 0 && pctPerEth < (uint256(1) << 64), "Deploy: pctPerEth out of range");
        uint256 sqrtPriceX96 = FixedPointMathLib.sqrt(pctPerEth << 192);

        int24 onPoolTick = TickMath.getTickAtSqrtPrice(uint160(sqrtPriceX96));
        int24 configured = -onPoolTick;

        // Round toward zero to align with tick spacing. Solidity integer
        // division on negative numerator truncates toward zero, so this
        // naturally floors-toward-zero for both signs.
        int24 spacing = TICK_SPACING;
        int24 rounded = (configured / spacing) * spacing;
        return rounded;
    }

    /// @notice Locker depth geometry — position bounds as OFFSETS from the
    ///         starting tick, plus per-position BPS weights. Returned as three
    ///         parallel arrays (lowerOffsets, upperOffsets, bps). `virtual` so
    ///         the slippage-probe harness can override it to exercise candidate
    ///         geometries against the real `_buildFactoryConfig` path.
    ///
    /// @dev    `_buildFactoryConfig` validates the return: equal lengths, all
    ///         offsets ≥ 0, strictly-ascending bounds, contiguity
    ///         (`lower[i] == upper[i-1]`), and `Σ bps == 10_000`.
    ///
    ///         14-position taper (production default). Positions 0-11 are the
    ///         original thin-floor taper reweighted ("C4-smoothed"); positions
    ///         12-13 are two new CONCENTRATED high-FDV TAIL positions that
    ///         replace the retired POLDepositor full-range depth bootstrap,
    ///         extending coverage from ~$31M to ~$310M FDV. Weights chosen by a
    ///         real-fork V4-Quoter slippage probe across 5 candidate geometries
    ///         (see docs/LOCKER_TAIL_PROBE_RESULTS.md + LOCKER_TAIL_FINDINGS_REPORT.md):
    ///         C4-smoothed had the lowest total slippage deviation from the
    ///         pre-extension master profile while preserving the $1M steady-state
    ///         band and the empirical floor tuning (position 0 = 375).
    ///
    ///         Widths (ticks):
    ///           [1400,2000,2600,3400,4600,5400,6600,7000,7000,7000,6400,6600 | 12000,11000]
    ///
    ///           i  Δticks  bps    ≈FDV band         note
    ///           0  1,400   375   $77K–$97K          empirical floor depth
    ///           1  2,000   150   $97K–$120K
    ///           2  2,600   300   $120K–$155K
    ///           3  3,400   500   $155K–$218K
    ///           4  4,600   800   $218K–$346K
    ///           5  5,400   700   $346K–$594K        softened (was 1300)
    ///           6  6,600  1500   $594K–$1.15M
    ///           7  7,000  1700   $1.15M–$2.31M      main growth
    ///           8  7,000  1150   $2.31M–$4.64M
    ///           9  7,000   850   $4.64M–$9.3M
    ///          10  6,400   600   $9.3M–$17.6M
    ///          11  6,600   275   $17.6M–$31M
    ///          12 12,000   700   $31M–$103M         ← NEW concentrated tail
    ///          13 11,000   400   $103M–$310M        ← NEW concentrated tail
    ///                            -------
    ///                             100.00%
    function _lockerPositions()
        internal
        view
        virtual
        returns (int24[] memory lowerOffsets, int24[] memory upperOffsets, uint16[] memory bps)
    {
        int24[14] memory lo = [
            int24(0), 1400, 3400, 6000, 9400, 14_000, 19_400, 26_000, 33_000, 40_000, 47_000, 53_400, 60_000, 72_000
        ];
        int24[14] memory up = [
            int24(1400),
            3400,
            6000,
            9400,
            14_000,
            19_400,
            26_000,
            33_000,
            40_000,
            47_000,
            53_400,
            60_000,
            72_000,
            83_000
        ];
        uint16[14] memory w = [uint16(375), 150, 300, 500, 800, 700, 1500, 1700, 1150, 850, 600, 275, 700, 400];

        lowerOffsets = new int24[](14);
        upperOffsets = new int24[](14);
        bps = new uint16[](14);
        for (uint256 i = 0; i < 14; i++) {
            lowerOffsets[i] = lo[i];
            upperOffsets[i] = up[i];
            bps[i] = w[i];
        }
    }

    /// @dev Resolve the SKIM MEV module address (`ArtCoinsMevLinearSkim`).
    ///      Set `ARTCOINS_MEV_SKIM` env var to the deployed address.
    function _resolveMevModule() internal view returns (address) {
        address m = vm.envOr("ARTCOINS_MEV_SKIM", address(0));
        require(m != address(0), "Deploy: set ARTCOINS_MEV_SKIM env (deployed + allowlisted skim MEV module)");
        return m;
    }

    /// @dev Resolve the PCController address (artcoins `ProtocolFeeController`
    ///      instance dedicated to PC, configured 86.67% treasury / 13.33% LAYER burn).
    ///      Receives the ProtocolFeePhaseAdapter's protocol-leg sweep (forwarded
    ///      to PCController from block 1).
    ///      Set `PC_CONTROLLER` env var to the deployed address.
    function _resolvePCController() internal view returns (address payable) {
        address c = vm.envOr("PC_CONTROLLER", address(0));
        require(c != address(0), "Deploy: set PC_CONTROLLER env (deployed ProtocolFeeController for PC)");
        return payable(c);
    }

    /// @dev Resolve the canonical payout recipient (title-auction payout; also
    ///      the value the operator should mirror into the artcoins `PC_TREASURY`
    ///      and the two frontends' default referrer). Reads `PAYOUT_RECIPIENT`,
    ///      falling back to `PAYOUT_RECIPIENT_DEFAULT` — config, not a hardcode.
    ///      Reverts on the zero address so a misconfigured env can't burn the
    ///      title proceeds.
    function _payoutRecipient() internal view returns (address payable) {
        address r = vm.envOr("PAYOUT_RECIPIENT", PAYOUT_RECIPIENT_DEFAULT);
        require(r != address(0), "Deploy: PAYOUT_RECIPIENT must be non-zero");
        return payable(r);
    }

    /// @dev Shared lean LP locker (`ArtCoinsLpLocker`), deployed + allowlisted as
    ///      artcoins infra. Read from env (the `CONVERSION_LOCKER` key name is
    ///      retained for operator/runbook continuity) so the same script serves
    ///      mainnet (export the deployed address) and fork tests (inject a
    ///      freshly-deployed instance). Reverts if unset.
    function _resolveConversionLocker() internal view returns (address) {
        address l = vm.envOr("CONVERSION_LOCKER", address(0));
        require(l != address(0), "Deploy: set CONVERSION_LOCKER env (deployed + allowlisted LP locker)");
        return l;
    }

    /// @dev Resolve the artcoins fee escrow (`ArtCoinsFeeEscrow`) — the
    ///      per-recipient native-ETH store the conversion locker deposits its
    ///      LP-fee ETH into and `LiveBidAdapter` claims from. PC's launch ships a
    ///      FRESH escrow with the new artcoins stack (the old escrow is
    ///      abandoned), so this is a REQUIRED env var with no default — exactly
    ///      like CONVERSION_LOCKER / PC_CONTROLLER. Wrong/stale escrow can't
    ///      silently strand the LP-fee leg: the preflight also cross-checks this
    ///      against the conversion locker's own immutable `feeLocker()`.
    function _resolveFeeEscrow() internal view returns (address) {
        address e = vm.envOr("ARTCOINS_FEE_ESCROW", address(0));
        require(e != address(0), "Deploy: set ARTCOINS_FEE_ESCROW env (fresh artcoins fee escrow)");
        return e;
    }

    /// @dev Resolve the artcoins factory. PC's tax launch deploys a FRESH
    ///      tax-aware `ArtCoinsFactory` (its linked deployer produces the
    ///      token bytecode with the venue-scoped transfer-tax constructor) and
    ///      exports `ARTCOINS_FACTORY=0x…`. REQUIRED env var with no default —
    ///      a stale factory cannot deploy the taxed token, so there is no safe
    ///      fallback; revert rather than silently target the wrong factory.
    function _resolveFactory() internal view returns (address) {
        address f = vm.envOr("ARTCOINS_FACTORY", address(0));
        require(f != address(0), "Deploy: set ARTCOINS_FACTORY env (fresh tax-aware artcoins factory)");
        return f;
    }

    /// @notice **PunkStrategy** (PNKSTR) yoyo contract. Seeded into the
    ///         `acceptListing` allowlist at launch so its 1.2× re-listings
    ///         compose with our bounty automatically.
    ///
    ///         Single-contract design: the PNKSTR ERC20 IS the yoyo —
    ///         `buyPunk(uint256)` is a public method on the token contract
    ///         that anyone can call to trigger a cycle. Verified by:
    ///           (a) Selector `0x8264fe98` present in deployed bytecode at
    ///               `0xc50673…eDF` (matches `buyPunk(uint256)`).
    ///           (b) Non-zero `pendingWithdrawals` for this address on the
    ///               2017 CryptoPunks market — proves prior selling activity.
    ///
    ///         Recheck before mainnet broadcast; the address is canonical
    ///         (matches the PNKSTR token URL on opensea.io and bankless.com
    ///         coverage as of 2026-05-16) but worth confirming the contract
    ///         hasn't migrated.
    address constant PUNKSTRATEGY_LISTING_CONTRACT = 0xc50673EDb3A7b94E8CAD8a7d4E0cD68864E33eDF;

    /// @notice Canonical protocol payout address — the single recipient for
    ///         the team / creator fee, the default swap referrer (both
    ///         frontends), and the `PunkVaultTitleAuction` payout (100% of
    ///         cleared settle proceeds route here; the title auction never
    ///         sends ETH to Patron). Deliberately NOT the deployer EOA — a
    ///         public, on-chain commitment rather than a side-effect of who
    ///         broadcast the deploy. Overridable per-deploy via the
    ///         `PAYOUT_RECIPIENT` env var (see `_payoutRecipient()`); the same
    ///         value should be set as the artcoins `PC_TREASURY` (team fee)
    ///         and as `DEFAULT_REFERRER` / `defaultReferrer` on the two
    ///         frontends, so revenue lands in one place.
    address constant PAYOUT_RECIPIENT_DEFAULT = 0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4;

    // Protocol parameters.
    /// @dev `BURNER_MIN_BLOCKS = 1` — burn can fire every block. Self-
    ///      regulating: callers race but only one wins per block, and the
    ///      0.01 ETH reward cap keeps the per-step economics tight. Admin-
    ///      tunable within [1, ~1 week].
    uint256 constant BURNER_MIN_BLOCKS = 1;
    /// @dev `BuybackBurner.maxSlippageBps` is a compile-time constant
    ///      (500 / 5%) in the contract itself. It is the binding
    ///      sandwich-protection rule: V4 partial-fills the burn step once
    ///      the pool would move past the impact cap, leaving the rest queued.
    ///      No admin tuning required or supported — see `BuybackBurner.sol`.
    /// @dev `BURNER_MAX_STEP_WEI = 1 ETH` — absolute cap on the ETH spent
    ///      per step. Predictable per-step MEV exposure regardless of queue
    ///      size. Admin-tunable within [0.01 ETH, 10 ETH].
    uint256 constant BURNER_MAX_STEP_WEI = 1 ether;
    /// @dev `ADAPTER_MAX_SWEEP_WEI = 2 ETH` paired with `ADAPTER_MIN_BLOCKS
    ///      = 150` (~30 min) is the throttle that paces the live bid once it is
    ///      at or above `ADAPTER_ACTIVATION_THRESHOLD`: the bid then grows by at
    ///      most ~2 ETH per 30 min, regardless of how much fee / contribution
    ///      / rescue-refund ETH has buffered in the adapter or how fast it
    ///      arrives, so the standing offer can't jump past floor prices in one
    ///      block. Both knobs are admin-tunable until the 1y lock (no carve-out);
    ///      they freeze with the rest of the economic surface afterward.
    uint256 constant ADAPTER_MAX_SWEEP_WEI = 2 ether;
    uint256 constant ADAPTER_MIN_BLOCKS = 150;
    /// @dev `ADAPTER_ACTIVATION_THRESHOLD = 30 ETH` seeds the fast/throttled
    ///      boundary for the pre-first-acquisition window: while the live bid is
    ///      below this, the adapter forwards the buffer uncapped (clamped to land
    ///      the bid AT the threshold) so the bid warms up rapidly at launch; at
    ///      or above it the `maxSweepWei`/cooldown throttle engages. After the
    ///      first `acceptBid`, the adapter auto-tracks the threshold to 75% of
    ///      the latest clearing price (the −25% band), so this seed only governs
    ///      launch. `setActivationThreshold` is the lone adapter carve-out — an
    ///      anomaly-correction valve that stays admin-tunable past the 1y lock.
    uint256 constant ADAPTER_ACTIVATION_THRESHOLD = 30 ether;
    /// @dev LP fee (ppm). Under the hook-redesign architecture this is small
    ///      (0.5%) because PC's revenue comes from the 5% hook skim, not from
    ///      being an LP. The 0.5% LP fee goes to in-range positions pro-rata —
    ///      locker captures most by depth dominance, and that share is
    ///      forwarded to Patron as bonus bounty.
    uint24 constant LP_FEE_PPM = 5000; // 0.5% — canonical total = 6% skim + 0.5% LP = 6.5%
    // (lowered from 1% per the router investigation: a 5.5% canonical total
    //  is more competitive vs side pools, dropping the needed side tax toward
    //  ~10–12.5% — see docs/router-results/FINAL_ROUTER_REPORT.md. Trade-off:
    //  the LP fee feeds the bid via the locker, so 0.5% halves that stream;
    //  the routing-defense benefit dominates.)
    /// @dev Baseline hook skim (in skim-module denominator, 100_000 = 100%).
    ///      The hook takes 6% of every swap's quote-side input/output and
    ///      splits it at swap-time: the ~83.33% bounty leg to LiveBidAdapter
    ///      and the ~16.67% protocol leg to ProtocolFeePhaseAdapter; the
    ///      anti-sniper extra routes 100% to the bounty leg during the MEV
    ///      window.
    uint24 constant BASELINE_SKIM_BPS = 6000; // 6%
    int24 constant TICK_SPACING = 200;
    uint24 constant DYNAMIC_FEE_FLAG = 0x800000;

    // ─── FeeAutoSwapper (downstream LP-fee converter) launch params ──────
    //
    // The lean ArtCoinsLpLocker does NO in-locker conversion (the
    // FeeConversion locker was retired); it escrows the artcoin-side LP fees
    // AS artcoin to its reward recipient. PC routes that slot to a
    // FeeAutoSwapper that converts the artcoin → ETH and forwards it to the
    // LiveBidAdapter. These are the swapper's deploy-time MEV/throughput knobs.
    //
    //   `maxSlippageBps` is the FAS's SOLE sandwich guard (the EMA gate /
    //   `referenceDeviationBps` was removed by the FAS EMA→maxSlippageBps
    //   simplification on artcoins master). It caps the convert's per-call price
    //   impact via `sqrtPriceLimitX96`; the FAS also has a hardcoded
    //   `SPOT_FLOOR_BPS = 8000` (80%) post-swap floor, so the usable impact tops
    //   out around 20% before `convert` reverts `MinOutBelowFloor`.
    //
    //   TUNED 2026-06-03 (frontrunning review): set to 5% — matching
    //   `BuybackBurner.maxSlippageBps` — so the convert's max price impact sits
    //   well BELOW the canonical pool's ~11% round-trip skim moat (5% baseline
    //   skim fires on BOTH legs of a sandwich + 0.5% LP each way). A fork sim of
    //   the front-run/convert/back-run bundle (artcoins
    //   test/FeeAutoSwapperSandwichSim) confirms the convert sandwich is
    //   unprofitable at every tested setting — at the real maxStepIn=1M the
    //   convert is far too small to move price (~0.3 bps), so the skim moat is
    //   the binding protection. The 5% cap (vs 10%) is defense-in-depth for the
    //   high-FDV regime, where 1M token becomes a larger ETH swap: in a stress
    //   case (40× convert) it halved the attacker's extractable move (999→499
    //   bps) and quadrupled their loss (−1.24%→−5.79%). It costs nothing at
    //   launch — a 1M-token convert never approaches even 5% impact, so the
    //   tighter clamp never partial-fills it more.
    uint256 constant FAS_MAX_SLIPPAGE_BPS = 500; // 5% — matches BuybackBurner; below the ~11% skim moat
    uint256 constant FAS_MIN_BLOCKS_BETWEEN_CONVERTS = 50; // ~10 min pacing
    uint256 constant FAS_MAX_STEP_IN = 1_000_000e18; // per-call artcoin cap

    // ════════════════════════════════════════════════════════════════════
    //  CENTRALIZED FEE / SPLIT / TAX CONFIG — the ONE place to scan + tweak
    //  every fee percentage. Consumed by `_buildFactoryConfig` (skim split)
    //  and `_buildTaxConfig` (transfer tax). The contracts read these via
    //  constructor/init params — there are NO magic-number fee literals in
    //  the token, hook, or factory bodies. Mirror any change here in
    //  docs/LAUNCH_PARAMS.md.
    // ════════════════════════════════════════════════════════════════════

    // ── Hook skim split (baseline = BASELINE_SKIM_BPS above) ──────────────
    /// @dev Bid leg: ~83.33% of the baseline skim (= 5.00% of volume). 10k
    ///      denom. The remainder (~16.67% = 1.00% of volume) is the protocol
    ///      leg, from which the swap-referral slice is carved before the rest
    ///      forwards to the ProtocolFeeController (team / LAYER-burn split).
    uint16 constant BOUNTY_BPS = 8333;
    /// @dev Referral cap: 0.25% of swap volume (100k denom). Launch value;
    ///      tunable up to the hook's hard 1_000 (1%) via
    ///      TokenAdminPoker.setHookMaxReferralBps (two-key carve-out).
    uint24 constant MAX_REFERRAL_BPS_OF_VOLUME = 250;

    // ── Venue-scoped buy-side transfer tax (PC-only; dormant elsewhere) ────
    /// @dev Launch rate: 15% per leg (10k denom). The router investigation
    ///      (docs/router-results/) showed 5% is *sub-parity* vs a 0.3%-LP side
    ///      pool (so the side-pool sell-leak stays open) — 12.5% is the floor and
    ///      15% the first clean defense with margin (at 5.5% canonical, larger
    ///      margin). Burned to 0xdEaD. NOT launched at the cap — see below.
    uint16 constant TRANSFER_TAX_BPS = 1500;
    /// @dev Hard cap — the bounded two-key setter (TokenAdminPoker.setTokenTaxBps)
    ///      can NEVER raise the rate above this, and the token's own
    ///      `TAX_BPS_ABSOLUTE_MAX = 2000` backstops it. Launch at 15% with headroom
    ///      to 20% so the rate can be tuned UP if live side-pool behavior is worse
    ///      than expected (the setter tunes within [0, 20%]).
    ///      INVARIANT #21 CHANGE (was 500/5% parity → 2000/20%). REQUIRES the
    ///      focused re-audit of the cap-raise + venue-tax + exemption path before
    ///      broadcast, AND the artcoins submodule commit/push + pin-bump.
    uint16 constant TRANSFER_TAX_BPS_MAX = 2000;

    // ── Frozen V2/V3 venue derivation set (no dynamic add path) ────────────
    // The token DERIVES each 111 pool address from `address(this)` + these
    // token-independent inputs in its constructor. Be generous: this list is
    // permanent. V4 is covered for free by the PoolManager singleton.
    // Counter-tokens a side pool would realistically pair the 111 token against for
    // liquidity: native-ETH (WETH on V2/V3) + the three deepest stables.
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    // Uniswap V2 / SushiSwap V2: pool = CREATE2(factory, keccak(t0,t1), initHash).
    address constant UNISWAP_V2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    bytes32 constant UNISWAP_V2_INIT_CODE_HASH = 0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f;
    address constant SUSHISWAP_V2_FACTORY = 0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac;
    bytes32 constant SUSHISWAP_V2_INIT_CODE_HASH = 0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303;
    // PancakeSwap V2 (Ethereum mainnet). initHash read live from the factory's
    // `INIT_CODE_PAIR_HASH()`; the derived 111/WETH pair was reproduced against
    // the chain (see TaxedTokenForkTest).
    address constant PANCAKE_V2_FACTORY = 0x1097053Fd2ea711dad45caCcc45EfF7548fCB362;
    bytes32 constant PANCAKE_V2_INIT_CODE_HASH = 0x57224589c67f3f30a6b0d7a1b54cf3153ab84563bc609ef41dfb34f8b2974d2d;
    // Uniswap V3: pool = CREATE2(factory, keccak(abi.encode(t0,t1,fee)), initHash).
    address constant UNISWAP_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    bytes32 constant UNISWAP_V3_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    // PancakeSwap V3 (Ethereum mainnet): pools are CREATE2-deployed by a
    // SEPARATE PoolDeployer, not the factory — so the deployer address is the
    // CREATE2 deployer for the derivation. Its enabled 0.25% tier is 2500, not
    // Uniswap's 3000. Both values reproduced against the chain.
    address constant PANCAKE_V3_POOL_DEPLOYER = 0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9;
    bytes32 constant PANCAKE_V3_INIT_CODE_HASH = 0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2;

    /// @dev **Launch FDV target in USD.** The configured starting tick is
    ///      derived from this value + `ETH_USD_PRICE` env var + the
    ///      supply used for FDV math (see `FDV_CALC_SUPPLY_WHOLE`).
    ///
    ///      Per the empirical tick-direction probe (see
    ///      `test/TickDirectionConvention.t.sol`), the factory negates
    ///      the configured `tickIfToken0IsArtCoins` before pool init
    ///      because 111 lands on `currency1`. So `_computeStartingTick`
    ///      returns the NEGATIVE of the on-pool launch tick. The factory
    ///      flips that back to positive, and 111 appreciation walks the
    ///      tick DOWN (toward zero) through the locker's positions.
    uint256 constant TARGET_LAUNCH_FDV_USD = 69_000;

    /// @dev Supply used for the launch-FDV → starting-tick computation.
    ///      Currently uses 999M (90% of total) — the **post-reserve**
    ///      supply that block 3 of the launch design will produce.
    ///
    ///      In THIS commit the locker still mints the full
    ///      `TOKEN_TOTAL_SUPPLY` (1.11B). The launched FDV will be ~$77K
    ///      at the reference ETH price ($2,100), dropping to the intended
    ///      $69K when block 3 lands and reduces the locker mint to 999M
    ///      at the SAME tick. Choosing the reduced supply for the tick
    ///      math now means the tick doesn't need to shift when block 3
    ///      ships — only the locker mint amount changes.
    uint256 constant FDV_CALC_SUPPLY_WHOLE = 999_000_000;

    /// @dev Reference ETH/USD price. If `ETH_USD_PRICE` env var is unset,
    ///      the deploy uses this value. ~~$2,100 chosen as a representative
    ///      mid-2026 price; operator should override for actual deploys.
    uint256 constant REFERENCE_ETH_USD_PRICE = 2100;

    // Token metadata. Ticker: `111` (no `$` prefix — user standing rule:
    // never begin a ticker with `$`). The salt baked into the deterministic
    // CREATE2 address is a fixed seed, held stable across metadata tweaks so
    // the token address doesn't move.
    string constant TOKEN_NAME = "permanent collection";
    string constant TOKEN_SYMBOL = "111";
    uint256 constant TOKEN_TOTAL_SUPPLY = 1_110_000_000 * 1e18;
    bytes32 constant TOKEN_SALT = keccak256("permanent collection 111PUNKS v2");

    /// @dev Per-deploy artcoins protocol-bps override. Under the hook-redesign
    ///      architecture, the locker LP fees are bonus bounty (not the
    ///      primary revenue path), so the artcoins protocol slot on the
    ///      LOCKER is set to 0. The artcoins protocol still benefits from
    ///      PC's volume via the hook skim's 20% protocol leg → PCController
    ///      → 20% LAYER burn at the controller level.
    uint16 constant ARTCOINS_PROTOCOL_BPS = 0;

    /// @dev Burn address used as the admin for reward slots that should never
    ///      be redirected. The artcoins locker checks `msg.sender == admin`
    ///      on `updateRewardRecipient` — `0xdEaD` has no private key so the
    ///      slot is provably immutable.
    address constant BURN_ADMIN = 0x000000000000000000000000000000000000dEaD;
    uint256 constant DEFAULT_ANVIL_PRIVATE_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    /// @notice Combined single-broadcast deploy (PC contracts + token + wiring).
    ///         Backward-compatible entry point — what the fork rehearsal and any
    ///         one-shot deploy use. For the split launch (deploy + verify all PC
    ///         contracts first, then launch the coin), use `runContracts()` then
    ///         `runToken()` instead (forge `--sig`).
    function run() external {
        address deployer = _resolveDeployerAndStart();
        _DeploymentAddresses memory d = _deployContracts(deployer);
        d = _launchTokenAndWire(d);
        vm.stopBroadcast();
        _writeDeployments(d);
    }

    /// @notice PHASE 2a — deploy ONLY the PC contracts (no token, no pool). The
    ///         coin is NOT live after this; the system is dormant (no pool means
    ///         no swap fees means no live bid). Public broadcast — no secrecy,
    ///         no time pressure: verify every contract on Etherscan before the
    ///         irreversible token launch. Writes `deployments.json` with
    ///         token/hook/locker = address(0).
    function runContracts() external {
        address deployer = _resolveDeployerAndStart();
        _DeploymentAddresses memory d = _deployContracts(deployer);
        vm.stopBroadcast();
        _writeDeployments(d);
    }

    /// @notice PHASE 2b — launch the token + V4 pool + LP and wire it to the
    ///         already-deployed PC contracts (read back from `deployments.json`).
    ///         This is the single irreversible, secrecy-sensitive step: broadcast
    ///         via a PRIVATE mempool (token-address / pool-init front-run
    ///         defense). Reverts if `deployments.json` shows a token already set.
    function runToken() external {
        _DeploymentAddresses memory d = _readDeployments();
        require(d.tokenAddr == address(0), "runToken: token already launched");

        _resolveDeployerAndStart();
        d = _launchTokenAndWire(d);
        vm.stopBroadcast();
        _writeDeployments(d);
    }

    /// @dev Phase-A body: deploy every PC contract + all PC-to-PC wiring. No
    ///      token dependency anywhere here (the two token-consuming contracts,
    ///      BuybackBurner and FeeAutoSwapper, are wired via `setup()` in
    ///      `_launchTokenAndWire`). Caller manages the broadcast.
    function _deployContracts(address deployer) internal returns (_DeploymentAddresses memory d) {
        // 1) ProtocolAdmin (initial admin = deployer EOA).
        ProtocolAdmin adminContract = new ProtocolAdmin(deployer);
        console2.log("protocolAdmin", address(adminContract));

        // 1b) PCSwapContext — dormant Design B reentrancy registry. Owner is
        //     the deployer; `authorizedExtension` stays `address(0)` at launch
        //     so the `notInSwap` guards on PC contracts are inert until a
        //     future dispatcher is bound and authorized.
        PCSwapContext swapContext = new PCSwapContext(deployer);
        console2.log("pcSwapContext", address(swapContext));

        // 2) Core records contract (pins datasetHash).
        PermanentCollection collection = new PermanentCollection(PUNKS_DATA, address(adminContract));
        console2.log("permanentCollection", address(collection));

        // 3) Patron (the V4 entry-point hub + ETH treasury).
        Patron patron = new Patron(PUNKS_MARKET, PUNKS_DATA, address(adminContract), address(swapContext));
        console2.log("patron", address(patron));

        // 4) BuybackBurner (V4 swap config; token+hook plugged in after factory call).
        BuybackBurner burner = new BuybackBurner(
            V4_POOL_MANAGER,
            DYNAMIC_FEE_FLAG,
            TICK_SPACING,
            BURNER_MIN_BLOCKS,
            BURNER_MAX_STEP_WEI,
            address(adminContract),
            address(swapContext)
        );
        console2.log("buybackBurner", address(burner));

        // 5) PunkVault & ReturnAuctionModule. Circular constructor dep resolved
        //    by precomputing the ReturnAuctionModule's CREATE address.
        uint64 nonce = vm.getNonce(deployer);
        address futureFinalSale = vm.computeCreateAddress(deployer, nonce + 1);
        PunkVault vault = new PunkVault(PUNKS_MARKET, futureFinalSale);
        ReturnAuctionModule finalSale = new ReturnAuctionModule(
            PUNKS_MARKET,
            address(collection),
            address(vault),
            payable(address(patron)),
            payable(address(burner)),
            address(swapContext)
        );
        require(address(finalSale) == futureFinalSale, "Deploy: finalSale address mismatch");
        console2.log("punkVault", address(vault));
        console2.log("returnAuctionModule", address(finalSale));

        // 6) Wire the collection. One-shot lock.
        collection.setWiring(address(patron), address(finalSale), address(vault), payable(address(burner)));

        // 7) LiveBidAdapter — the single inflow governor. Deployed here
        //    (before Patron wiring) so it can be passed into `patron.setWiring`
        //    below: under inflow consolidation, Patron's `receive()` accepts
        //    ETH ONLY from this adapter, which buffers every bid-funding source
        //    (fees, contributions, bare sends, rescue refunds) and meters them
        //    into Patron in two modes keyed on the live bid vs the activation
        //    threshold: below it the buffer forwards uncapped (clamped to land
        //    the bid at the threshold) for a fast launch warm-up; at/above it a
        //    fixed throttle (`maxSweepWei` per `minBlocksBetweenSweeps` blocks)
        //    paces growth so the live bid can't spike. The adapter reads the
        //    records core (`collection`) to auto-track the threshold to 75% of
        //    the latest `acceptBid` clearing price, and references the
        //    return-auction module (gates its module-only `poolReplenish`).
        //    The pool is native-ETH paired, so
        //    LP fees route escrow → FeeAutoSwapper → this adapter's `receive()`;
        //    `sweep()` / `streamForward()` forward the buffer. No WETH unwrap.
        //
        //    Cyclic wiring (adapter ↔ Patron ↔ module) resolves without
        //    CREATE-address precompute: the adapter takes the already-deployed
        //    module in its constructor; Patron receives the adapter via
        //    `setWiring`; the module receives the adapter via the one-shot
        //    `setLiveBidAdapter` (the same shape as `setVaultBurnPool`).
        LiveBidAdapter adapter = new LiveBidAdapter(
            payable(address(patron)),
            address(adminContract),
            ADAPTER_MAX_SWEEP_WEI,
            ADAPTER_MIN_BLOCKS,
            ADAPTER_ACTIVATION_THRESHOLD, // fast/throttled seed; auto-tracks after 1st acceptBid
            address(collection), // records core — auto-tracks threshold to latest clearing price
            address(finalSale), // module ref — gates `poolReplenish` module-only
            address(swapContext)
        );
        console2.log("liveBidAdapter", address(adapter));

        // 7a) Finalize Patron wiring (binds collection + final sale + adapter).
        //     After this, `Patron.receive()` rejects every sender but `adapter`.
        patron.setWiring(address(collection), address(finalSale), address(adapter));

        // 7b-i) Wire the adapter into the return-auction module so cleared-settle
        //       bounty refunds (and any rerouted settle keeper reward) route into
        //       the adapter buffer via `poolReplenish` instead of spiking Patron.
        finalSale.setLiveBidAdapter(payable(address(adapter)));

        // 7b) Title auction + vault wiring. The Title (token id 111) is minted
        //     into the auction's escrow at launch (mintTitle), so it exists
        //     from the start. The AUCTION opens separately: anyone may call
        //     `auction.kickoff()` once the protocol has collected at least
        //     KICKOFF_THRESHOLD (11) traits. On settle, 100% of cleared
        //     proceeds route (pull-based) to the immutable `payoutRecipient`
        //     (the canonical payout address — NOT the deployer EOA — see
        //     `_payoutRecipient()` / PAYOUT_RECIPIENT above). The title auction
        //     never sends ETH to Patron and is unaffected by the adapter-only
        //     `receive()` gate. No admin path, no rotation path; the recipient
        //     is permanently committed at deploy time.
        address payable payoutRecipient = _payoutRecipient();
        PunkVaultTitleAuction titleAuction = new PunkVaultTitleAuction(
            address(collection), address(vault), payoutRecipient, address(swapContext)
        );
        vault.setTitleAuction(address(titleAuction));
        // Mint the Title now so it exists at launch; the auction stays closed
        // until kickoff past the 11-trait threshold.
        titleAuction.mintTitle();
        console2.log("titleAuction", address(titleAuction));
        console2.log("titleAuction.payoutRecipient", payoutRecipient);

        // 8b) VaultBurnPool for the vault-outcome burn path.
        //     The hook no longer has a vault-burn leg; the pool's only
        //     inflow is `ReturnAuctionModule.settle` (cleared path) routing
        //     the `(highBid − cost) + CLEARED_VAULT_BURN_BPS × cost` slice
        //     here. Sweep is module-only and fires on every vault-path
        //     settle.
        VaultBurnPool vaultBurnPool =
            new VaultBurnPool(address(finalSale), payable(address(burner)), address(swapContext));
        console2.log("vaultBurnPool", address(vaultBurnPool));
        finalSale.setVaultBurnPool(payable(address(vaultBurnPool)));

        // 8c) ProtocolFeePhaseAdapter — receives the 20% protocol leg from
        //     the hook.
        //
        //     The hook takes a 6% skim from every swap and forwards the
        //     baseline split 83.33/16.67 across the two legs (bounty / protocol).
        //     Anti-sniper extras during the MEV window go directly to
        //     LiveBidAdapter (where they buffer and meter into Patron under
        //     the same fixed sweep rate cap as the bounty leg).
        //
        //     ProtocolFeePhaseAdapter sits behind the ~16.67% protocol leg and
        //     forwards it to PCController (the artcoins ProtocolFeeController
        //     instance with the treasury / LAYER-burn split) on every sweep,
        //     from block 1.
        ProtocolFeePhaseAdapter protocolFeePhaseAdapter = new ProtocolFeePhaseAdapter(
            _resolvePCController(),
            _resolveFeeEscrow(),
            address(swapContext)
        );
        console2.log("protocolFeePhaseAdapter", address(protocolFeePhaseAdapter));

        // 9) Public Punk-tile cache + on-chain mosaic renderer + stable
        //     RendererRegistry. The cache is independent of the protocol
        //     (no admin, no funds, derives bytes exclusively from PunksData)
        //     and reusable by any other project that wants compact Punk
        //     SVG fragments. The renderer composes the artwork as a true
        //     mosaic of cached tiles, sourcing each from the cache.
        //     The artcoins factory (ERC20) and the PunkVault (ERC721) both
        //     reference the registry's address as their immutable renderer.
        //     Implementation behind the registry is swappable by the
        //     ProtocolAdmin until either the 1-year timer auto-locks or
        //     `freeze()` is invoked — after that, the artwork is permanent.
        PunkSvgFragmentCache punkSvgCache = new PunkSvgFragmentCache(PUNKS_DATA);
        console2.log("punkSvgCache", address(punkSvgCache));
        // Companion cache for trait icons drawn on uncollected/pending
        // cells. Deployed empty; permissionless `cacheTrait(traitId)`
        // bakes fragments over time. The renderer consults this cache
        // before falling back to on-the-fly compute, so launch-day
        // renders use the (slow) compute path and gradually shift to
        // (fast) cached reads as community keepers fill the cache. No
        // admin coordination required. See `docs/RENDERER_CACHE.md`.
        TraitIconCache traitIconCache = new TraitIconCache(PUNKS_DATA);
        console2.log("traitIconCache", address(traitIconCache));
        // Proof renderer: composes per-Proof SVG + JSON for token ids
        // 1..111 on PunkVault. Reads `vault.proofMeta` at render time;
        // pre-mint reads produce a preview envelope so the
        // RendererRegistry's interface probe succeeds before any Proof
        // has been issued.
        PermanentCollectionProofRenderer proofRenderer = new PermanentCollectionProofRenderer(
            address(vault), PUNKS_DATA, address(traitIconCache), address(punkSvgCache)
        );
        console2.log("proofRenderer", address(proofRenderer));
        PermanentCollectionMosaicRenderer renderer = new PermanentCollectionMosaicRenderer(
            address(collection),
            address(vault),
            address(punkSvgCache),
            PUNKS_DATA,
            address(traitIconCache),
            address(proofRenderer)
        );
        console2.log("renderer", address(renderer));
        RendererRegistry rendererRegistry = new RendererRegistry(address(adminContract), address(renderer));
        vault.setRendererRegistry(address(rendererRegistry));
        console2.log("rendererRegistry", address(rendererRegistry));

        // 9c) TokenAdminPoker — retained-admin holder of the 111 token-admin
        //     role. There is no metadata-refresh `poke()`: the vault emits its
        //     own ERC-7572 `ContractURIUpdated` on every title/proof mint (the
        //     only refresh the protocol needs, straight from the real collection
        //     events), and the separate ERC20 marketplace card is
        //     mission-orthogonal, left to marketplace re-indexing. Under the
        //     hook-redesign architecture there is no per-swap pool extension to
        //     bind (the hook drives the skim path directly), so the
        //     `bindExtension` / `lockExtension` surface stays unused on this
        //     deploy. The retained powers are the two-key carve-out setters
        //     (`setHookMaxReferralBps`, `setTokenTaxBps`); token image /
        //     metadata-renderer surfaces remain frozen.
        TokenAdminPoker tokenAdminPoker = new TokenAdminPoker(deployer, address(adminContract));
        console2.log("tokenAdminPoker", address(tokenAdminPoker));

        // 10) Artcoins factory: token + V4 pool + LP + locker, single tx.
        //     Uses the NEW ArtCoinsHookSkimFee (resolved from env) and the
        //     skim-based MEV module. Locker config is simplified — a single
        //     reward slot routes all locker LP fees to LiveBidAdapter (which
        //     meters them into Patron under its fixed sweep rate cap), since
        //     under the hook-redesign architecture PC's revenue comes from the
        //     hook skim, not from being an LP. ARTCOINS_PROTOCOL_BPS = 0 — no
        //     factory-injected protocol slot on the locker (LAYER burn flows
        //     via the hook skim's protocol leg → PCController instead).
        //
        //     Permanent depth is provided by the locker's two concentrated
        //     high-FDV TAIL positions (12 & 13, covering ~$30M–$300M FDV) —
        //     the former POLDepositor full-range bootstrap was retired (its
        //     full-range depth was structurally negligible inside locker
        //     coverage; see docs/LOCKER_TAIL_EXTENSION_SPEC.md).
        // Skim hook (Phase-1 env) — needed here for ReferralPayout + the
        // FeeAutoSwapper config below. The factory, deploy fee, and conversion
        // locker are resolved in `_launchTokenAndWire` (Phase 2b), where the
        // token is actually deployed.
        address skimHook = _resolveSkimHook();

        // ReferralPayout — bound to the skim hook. Hook is `notify`'s only
        // authorized caller. Pays from the first swap whenever the swap
        // carries valid referral attribution in hookData; otherwise the
        // slice stays in the protocol leg.
        ReferralPayout referralPayout = new ReferralPayout(skimHook);
        console2.log("referralPayout", address(referralPayout));

        // Downstream LP-fee converter. The lean locker escrows the artcoin-side
        // LP fees AS artcoin to its reward recipient; this swapper converts them
        // to ETH and forwards to the LiveBidAdapter. `depositToLocker = false`
        // → ETH is sent to the adapter's `receive()` buffer (so no escrow-
        // depositor grant is needed — PC's deployer doesn't own the escrow) and
        // meters into Patron on the next `sweep()`. It is the locker's SOLE
        // reward recipient; the 5% hook-skim bounty leg still routes ETH straight
        // to the adapter. `setup(token)` runs after the factory deploys the token
        // (below) — the swapper is constructed first so it can be that recipient.
        FeeAutoSwapper lockerFeeSwapper = new FeeAutoSwapper(
            FeeAutoSwapper.Config({
                poolManager: V4_POOL_MANAGER,
                feeLocker: _resolveFeeEscrow(),
                pairedToken: address(0), // native-ETH-paired pool
                poolFee: DYNAMIC_FEE_FLAG,
                poolTickSpacing: TICK_SPACING,
                hook: skimHook,
                endRecipient: payable(address(adapter)),
                depositToLocker: false,
                maxSlippageBps: FAS_MAX_SLIPPAGE_BPS,
                minBlocksBetweenConverts: FAS_MIN_BLOCKS_BETWEEN_CONVERTS,
                maxStepIn: FAS_MAX_STEP_IN
            })
        );
        console2.log("lockerFeeSwapper", address(lockerFeeSwapper));

        // Populate the address struct (token/hook/locker stay address(0) until
        // `_launchTokenAndWire` runs in Phase 2b).
        d.collection = collection;
        d.patron = patron;
        d.burner = burner;
        d.finalSale = finalSale;
        d.vault = vault;
        d.adminContract = adminContract;
        d.tokenAddr = address(0);
        d.hookAddr = address(0);
        d.lockerAddr = address(0);
        d.adapterAddr = address(adapter);
        d.rendererAddr = address(renderer);
        d.vaultBurnPoolAddr = address(vaultBurnPool);
        d.titleAuctionAddr = address(titleAuction);
        d.rendererRegistryAddr = address(rendererRegistry);
        d.punkSvgCacheAddr = address(punkSvgCache);
        d.traitIconCacheAddr = address(traitIconCache);
        d.tokenAdminPokerAddr = address(tokenAdminPoker);
        d.protocolFeePhaseAdapterAddr = address(protocolFeePhaseAdapter);
        d.swapContextAddr = address(swapContext);
        d.referralPayoutAddr = address(referralPayout);
        d.feeAutoSwapperAddr = address(lockerFeeSwapper);
    }

    /// @dev Phase-B body: deploy the token + V4 pool + LP via the factory, then
    ///      wire it into the PC contracts carried in `d` (the three post-token
    ///      `setup()` calls + the allowlist seed). Returns `d` with the
    ///      token/hook/locker addresses filled. Caller manages the broadcast.
    ///      Every PC reference comes from `d` (deployed in Phase 2a / read from
    ///      `deployments.json`), so this never re-deploys a PC contract — only
    ///      the token and its wiring.
    function _launchTokenAndWire(_DeploymentAddresses memory d)
        internal
        returns (_DeploymentAddresses memory)
    {
        // Factory / deploy fee / conversion locker / skim hook (Phase-1 env).
        IArtcoinsFactory factory = IArtcoinsFactory(_resolveFactory());
        uint256 deployFee = factory.deployFee();
        address convLocker = _resolveConversionLocker();
        address skimHook = _resolveSkimHook();

        IArtcoinsFactory.DeploymentConfig memory config = _buildFactoryConfig(
            _SkimRecipients({
                tokenAdminAddr: d.tokenAdminPokerAddr,
                bountyAdapter_: payable(d.adapterAddr),
                lockerFeeRecipient_: payable(d.feeAutoSwapperAddr),
                protocolFeePhaseAdapter_: payable(d.protocolFeePhaseAdapterAddr),
                referralPayout_: payable(d.referralPayoutAddr),
                rendererAddr: d.rendererRegistryAddr,
                locker_: convLocker,
                skimHook: skimHook
            })
        );
        // Venue-scoped buy-side transfer tax (PC opt-in). Token-independent
        // inputs only — the token derives its V2/V3 venue addresses + canonical
        // pool id from `address(this)`. The exempt adapters (burner /
        // convLocker) and the VaultBurnPool burn sink are all already deployed
        // at this point, so no CREATE-address precomputation is needed.
        TaxConfig memory taxConfig =
            _buildTaxConfig(skimHook, address(d.burner), convLocker, d.vaultBurnPoolAddr);
        address tokenAddr =
            factory.deployTokenWithProtocolBpsAndTax{value: deployFee}(config, ARTCOINS_PROTOCOL_BPS, taxConfig);
        console2.log("token", tokenAddr);

        IArtcoinsFactory.TokenDeploymentInfo memory info = factory.tokenDeploymentInfo(tokenAddr);
        require(info.hook == skimHook, "factory returned unexpected hook");
        require(info.locker == convLocker, "factory returned unexpected locker");

        // Post-factory setup:
        //   - BuybackBurner: bind token + hook.
        //   - TokenAdminPoker: bind token + canonical pool (enables the two-key
        //     tax-rate / referral-cap carve-out setters; pins them to this pool).
        //     No `poke()` — the vault emits its own ERC-7572 refresh on mint.
        //   - FeeAutoSwapper: bind token (the locker's reward recipient, set at
        //     deploy; `setup` can only run post-token).
        //   - VaultBurnPool: bind token so the venue-tax 111 it receives as the
        //     token's `burnAddress` is burned on each vault-path sweep.
        d.burner.setup(tokenAddr, info.hook);
        VaultBurnPool(payable(d.vaultBurnPoolAddr)).setup(tokenAddr);
        TokenAdminPoker(d.tokenAdminPokerAddr).setup(
            tokenAddr,
            PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(tokenAddr),
                fee: DYNAMIC_FEE_FLAG,
                tickSpacing: TICK_SPACING,
                hooks: IHooks(info.hook)
            })
        );
        FeeAutoSwapper(payable(d.feeAutoSwapperAddr)).setup(tokenAddr);

        // Seed the Patron allowlist with PunkStrategy (if configured).
        if (PUNKSTRATEGY_LISTING_CONTRACT != address(0)) {
            d.patron.addAllowedSeller(PUNKSTRATEGY_LISTING_CONTRACT);
            console2.log("seeded allowlist with PunkStrategy", PUNKSTRATEGY_LISTING_CONTRACT);
        } else {
            console2.log("WARNING: PUNKSTRATEGY_LISTING_CONTRACT not set; allowlist empty");
        }

        d.tokenAddr = tokenAddr;
        d.hookAddr = info.hook;
        d.lockerAddr = info.locker;
        return d;
    }

    /// @dev Bundled to keep the factory call's argument list under Solidity's
    ///      stack-too-deep limit.
    struct _SkimRecipients {
        address tokenAdminAddr;
        address payable bountyAdapter_;
        // Locker reward-slot recipient — the downstream FeeAutoSwapper that
        // converts artcoin-side LP fees to ETH. Distinct from `bountyAdapter_`:
        // the hook-skim bounty leg is already ETH and routes straight to the
        // adapter, but the locker LP fees arrive partly as artcoin and need the
        // swapper in front of the adapter.
        address payable lockerFeeRecipient_;
        address payable protocolFeePhaseAdapter_;
        address payable referralPayout_;
        address rendererAddr;
        address locker_;
        address skimHook;
    }

    /// @dev Bundled to dodge stack-too-deep in `_writeDeployments`.
    struct _DeploymentAddresses {
        PermanentCollection collection;
        Patron patron;
        BuybackBurner burner;
        ReturnAuctionModule finalSale;
        PunkVault vault;
        address tokenAddr;
        address hookAddr;
        address lockerAddr;
        address adapterAddr;
        address rendererAddr;
        ProtocolAdmin adminContract;
        address vaultBurnPoolAddr;
        address titleAuctionAddr;
        address rendererRegistryAddr;
        address punkSvgCacheAddr;
        address traitIconCacheAddr;
        address tokenAdminPokerAddr;
        address protocolFeePhaseAdapterAddr;
        address swapContextAddr;
        address referralPayoutAddr;
        address feeAutoSwapperAddr;
    }

    /// @dev Resolve the deployer EOA and start a broadcast in one step. Three
    ///      modes, picked in this order:
    ///        1. `PRIVATE_KEY` env set        → sign with it; deployer = its address.
    ///        2. chainid == 31337 (local fork)→ anvil-default key fallback,
    ///           unless `UNLOCKED_SENDER=true` opts into mode 3 so a fork can
    ///           broadcast as an impersonated EOA.
    ///        3. Otherwise (CLI signer)       → `vm.startBroadcast()` (no key);
    ///           deployer = `msg.sender` (the `--sender` / `--account` /
    ///           `--unlocked` address). Lets a hardware/keystore signer drive
    ///           the broadcast with no key materialized AND lets an anvil fork
    ///           run as an impersonated EOA (`anvil --auto-impersonate
    ///           --sender <addr>`) so CREATE-address rehearsals match what the
    ///           real broadcast will produce.
    function _resolveDeployerAndStart() internal returns (address deployer) {
        uint256 deployerPk = vm.envOr("PRIVATE_KEY", uint256(0));
        // UNLOCKED_SENDER=true skips the anvil-key fallback so a 31337 fork can
        // broadcast as an impersonated EOA via the CLI sender (mode 3). No effect
        // on a real broadcast: chainid is never 31337 on a live network, and a
        // set PRIVATE_KEY still wins below.
        bool unlockedSender = vm.envOr("UNLOCKED_SENDER", false);
        if (deployerPk == 0 && block.chainid == 31_337 && !unlockedSender) {
            deployerPk = DEFAULT_ANVIL_PRIVATE_KEY;
        }
        if (deployerPk != 0) {
            deployer = vm.addr(deployerPk);
            console2.log("deployer", deployer);
            _assertExternalAddresses();
            vm.startBroadcast(deployerPk);
        } else {
            // CLI-signer path: forge supplies the sender; we just broadcast.
            deployer = msg.sender;
            console2.log("deployer", deployer);
            _assertExternalAddresses();
            vm.startBroadcast();
        }
    }

    /// @dev Build the factory config for the skim architecture.
    ///      The hook decomposes baseline skim into two pool legs at swap time:
    ///        - bountyShare   = baselineSkim × 8333 / 10_000  (~83.33%, 5% of vol)
    ///        - protocolShare = baselineSkim − bountyShare    (~16.67%, 1% of vol)
    ///      Plus the anti-sniper extra during the MEV window, which folds
    ///      into the bounty leg (→ `bountyAdapter_`).
    ///      Plus an optional per-swap referral (cap 250 = 0.25% of volume,
    ///      paid from the protocol slice only). The referral pays from the
    ///      first swap when the swap carries a valid referrer. `VaultBurnPool`
    ///      is fed from cleared-auction proceeds in `ReturnAuctionModule.settle`.
    function _buildFactoryConfig(
        _SkimRecipients memory r
    ) internal view returns (IArtcoinsFactory.DeploymentConfig memory cfg) {
        cfg.tokenConfig = IArtcoinsFactory.TokenConfig({
            tokenAdmin: r.tokenAdminAddr,
            name: TOKEN_NAME,
            symbol: TOKEN_SYMBOL,
            salt: TOKEN_SALT,
            image: "",
            metadata: "",
            context: "",
            totalSupply: TOKEN_TOTAL_SUPPLY,
            renderer: r.rendererAddr
        });

        IArtCoinsHookSkimFee.SkimHookFeeData memory skimCfg = IArtCoinsHookSkimFee.SkimHookFeeData({
            baselineSkimBps: BASELINE_SKIM_BPS,
            bountyBps: BOUNTY_BPS,
            // Launch value MAX_REFERRAL_BPS_OF_VOLUME = 250 (0.25% of swap
            // volume). Tunable post-launch via TokenAdminPoker.setHookMaxReferralBps()
            // — hard-capped to 1_000 (1% of swap volume in 100k denom) by the
            // hook. The wrapper is a ProtocolAdmin CARVE-OUT (callable by EITHER
            // TokenAdminPoker.owner OR ProtocolAdmin.admin() EOA), so the cap
            // stays tunable past the 1y admin timer and past TokenAdminPoker.owner
            // renounce; freezes only when BOTH are burned. Frontend defaults
            // `referralBps` to 250 (matches `MAX_REFERRAL_BPS_OF_VOLUME` in
            // attribution.ts). The referral leg pays from the first swap
            // whenever the swap carries a valid referrer; with no/invalid
            // referrer the slice stays in the protocol leg.
            maxReferralBpsOfVolume: MAX_REFERRAL_BPS_OF_VOLUME,
            lpFee: LP_FEE_PPM,
            bountyRecipient: r.bountyAdapter_,
            protocolRecipient: r.protocolFeePhaseAdapter_,
            referralPayout: r.referralPayout_,
            quoteToken: address(0) // native ETH
        });
        bytes memory innerFeeData = abi.encode(skimCfg);

        cfg.poolConfig = IArtcoinsFactory.PoolConfig({
            hook: r.skimHook,
            pairedToken: address(0), // native-ETH-paired pool
            tickIfToken0IsArtCoins: _computeStartingTick(),
            tickSpacing: TICK_SPACING,
            // PoolInitializationData = (extension, extensionData, feeData)
            // No pool extension at launch — Design B's dispatcher (if/when
            // built) is bound later via TokenAdminPoker.bindExtension.
            poolData: abi.encode(address(0), bytes(""), innerFeeData)
        });

        // Simplified locker reward distribution under the hook-redesign
        // architecture. PC's revenue comes from the 5% hook skim (routed
        // outside the locker), so the locker just collects the small 0.5% LP
        // fee on its position depth. The lean locker escrows that fee AS the
        // currency received (artcoin on sell-side flow, ETH on buy-side); the
        // reward slot points at the downstream FeeAutoSwapper, which converts
        // the artcoin leg to ETH and forwards everything to LiveBidAdapter (as
        // bonus bounty metered into Patron under the adapter's fixed sweep
        // rate cap).
        //
        // Single PC reward slot, 10_000 bps to the swapper, admin = BURN_ADMIN
        // (0xdEaD) so the recipient is provably locked (the swapper's own
        // endRecipient = adapter is likewise immutable, so the
        // locker→swapper→adapter chain is permanent). With ARTCOINS_PROTOCOL_BPS
        // = 0, the factory does NOT inject a protocol slot — LAYER burn revenue
        // flows via the hook skim's 20% protocol leg → PCController.
        address[] memory rewardAdmins = new address[](1);
        rewardAdmins[0] = BURN_ADMIN;
        address[] memory rewardRecipients = new address[](1);
        rewardRecipients[0] = r.lockerFeeRecipient_;
        uint16[] memory rewardBps = new uint16[](1);
        rewardBps[0] = 10_000;

        // Locker depth geometry. The offsets + weights live in the overridable
        // `_lockerPositions()` (below) so the slippage-probe harness can swap in
        // candidate geometries against this exact production deploy path without
        // forking the script. Validated here for length parity, BPS sum, and
        // contiguity, then shifted onto the live starting tick.
        (int24[] memory lowerOffsets, int24[] memory upperOffsets, uint16[] memory bps) = _lockerPositions();
        uint256 nPos = lowerOffsets.length;
        require(nPos == upperOffsets.length && nPos == bps.length, "Deploy: locker array length mismatch");
        require(nPos > 0, "Deploy: no locker positions");
        int24 startingTick = _computeStartingTick();
        int24[] memory tickLowerArr = new int24[](nPos);
        int24[] memory tickUpperArr = new int24[](nPos);
        uint16[] memory positionBps = new uint16[](nPos);
        uint256 bpsSum;
        for (uint256 i = 0; i < nPos; i++) {
            require(lowerOffsets[i] >= 0, "Deploy: negative locker offset");
            require(upperOffsets[i] > lowerOffsets[i], "Deploy: locker offset not ascending");
            // Contiguity: every position's lower offset must meet the prior
            // position's upper offset, leaving no dead zone inside the band.
            if (i > 0) {
                require(lowerOffsets[i] == upperOffsets[i - 1], "Deploy: locker positions not contiguous");
            }
            tickLowerArr[i] = startingTick + lowerOffsets[i];
            tickUpperArr[i] = startingTick + upperOffsets[i];
            positionBps[i] = bps[i];
            bpsSum += bps[i];
        }
        require(bpsSum == 10_000, "Deploy: locker BPS sum != 10000");
        // The lean ArtCoinsLpLocker does no in-locker conversion and ignores
        // `lockerData` — the artcoin-side LP fees are escrowed AS artcoin to the
        // reward recipient (the FeeAutoSwapper), which converts them downstream.
        cfg.lockerConfig = IArtcoinsFactory.LockerConfig({
            locker: r.locker_,
            rewardAdmins: rewardAdmins,
            rewardRecipients: rewardRecipients,
            rewardBps: rewardBps,
            tickLower: tickLowerArr,
            tickUpper: tickUpperArr,
            positionBps: positionBps,
            lockerData: bytes("")
        });
        // Anti-sniper window: skim-module decays the total skim from 90_000
        // (90% trader cost at t=0) to 6_000 (baseline 6%) over 30 minutes
        // (1_800s at ~2.8% per minute — see `_mevSkimInitData`).
        // The "anti-sniper extra" — the elevated portion above baseline —
        // routes directly to LiveBidAdapter (the bounty recipient), where
        // it joins the baseline bounty share and is metered into Patron under
        // the adapter's fixed sweep rate cap. Public LPs are gated
        // out during this window (the hook blocks `beforeAddLiquidity`).
        cfg.mevModuleConfig =
            IArtcoinsFactory.MevModuleConfig({mevModule: _resolveMevModule(), mevModuleData: _mevSkimInitData()});
        // The sniper-fee path is a SEPARATE artcoins mechanism (extra fee
        // ABOVE the base LP fee, routed 100% to `sniperFeeRecipient`).
        // `ArtCoinsMevLinearFees` does not use it; the module signals
        // `mevModuleSetFee` (raise LP fee) rather than
        // `mevModuleSetSniperFee` (signal extra). Leave both fields zero
        // so the recipient slot stays unlocked — operator can opt into
        // the sniper-extra path later by binding a different module via
        // ProtocolAdmin (NOT in scope for 111 launch).
        cfg.sniperFeeConfig = IArtcoinsFactory.SniperFeeConfig({recipient: address(0), lockRecipient: false});
        cfg.extensionConfigs = new IArtcoinsFactory.ExtensionConfig[](0);
    }

    /// @dev Assemble the venue-scoped buy-side transfer-tax config for PC's
    ///      111. All inputs are token-INDEPENDENT — the token derives the
    ///      actual V2/V3 pool addresses AND the canonical pool id from
    ///      `address(this)` in its constructor, so there is no CREATE2 circular
    ///      dependency. The venue set is FROZEN here (the token has no dynamic
    ///      add path), so it is deliberately generous across the liquid side-pool
    ///      space: {Uniswap V2, SushiSwap V2, PancakeSwap V2} × {WETH, USDC, USDT,
    ///      DAI} (12) + {Uniswap V3, PancakeSwap V3} × {WETH, USDC, USDT, DAI} ×
    ///      4 fee tiers (32) = 44 derived V2/V3 venues. Every V4 pool (canonical
    ///      + any side pool) is covered for free by the PoolManager singleton.
    ///      All knobs come from the centralized fee/tax constants above.
    function _buildTaxConfig(
        address skimHook,
        address burner,
        address convLocker,
        address vaultBurnPool
    ) internal pure returns (TaxConfig memory tax) {
        tax.enabled = true;
        tax.taxBps = TRANSFER_TAX_BPS;
        tax.taxBpsMax = TRANSFER_TAX_BPS_MAX;
        // Venue-tax 111 accrues in VaultBurnPool and is burned (supply
        // reduction) on each vault-path settle, alongside the ETH sweep.
        tax.burnAddress = vaultBurnPool;
        tax.poolManager = V4_POOL_MANAGER;
        tax.canonicalHook = skimHook;
        tax.pairedToken = address(0); // native-ETH-paired canonical pool.
        tax.canonicalPoolFee = DYNAMIC_FEE_FLAG;
        tax.canonicalTickSpacing = TICK_SPACING;

        // Exempt recipients: PC contracts that legitimately receive the 111 token FROM
        // the PoolManager and must NOT be skimmed. BuybackBurner buys the 111 token to
        // burn; the conversion locker holds the 14 LP positions + collects
        // 111-side fees. Every other PC adapter (Patron, LiveBidAdapter,
        // VaultBurnPool, ProtocolFeePhaseAdapter, ReferralPayout) is ETH-only
        // and needs no entry. (The former POLDepositor exemption was removed
        // with the POL retirement.)
        tax.exempt = new address[](2);
        tax.exempt[0] = burner;
        tax.exempt[1] = convLocker;

        // The LIQUID side-pool space (not the unbounded theoretical one): each
        // realistic counter-token × DEX family. V4 (any counter/fee/hook) is
        // covered for free by the PoolManager singleton compare and is NOT
        // enumerated here. Frozen at deploy — no add path. Every derivation is
        // reproduced against the live factories in TaxedTokenForkTest, so a
        // wrong constant fails the suite rather than silently missing a venue.
        address[4] memory counters = [WETH, USDC, USDT, DAI];
        // Uniswap V3 enables 0.30% (3000); PancakeSwap V3 enables 0.25% (2500)
        // instead. The other three tiers coincide.
        uint24[4] memory uniV3Tiers = [uint24(100), 500, 3000, 10_000];
        uint24[4] memory cakeV3Tiers = [uint24(100), 500, 2500, 10_000];

        // 3 V2-style DEXes × 4 counters + 2 V3-style DEXes × 4 counters × 4 tiers.
        tax.venues = new TaxVenue[](3 * 4 + 2 * 4 * 4);
        uint256 n = 0;
        for (uint256 c = 0; c < 4; c++) {
            address counter = counters[c];
            // Uniswap V2.
            tax.venues[n++] = TaxVenue({
                kind: 1,
                factory: UNISWAP_V2_FACTORY,
                initCodeHash: UNISWAP_V2_INIT_CODE_HASH,
                counterToken: counter,
                v3Fee: 0
            });
            // SushiSwap V2 (top V2 fork).
            tax.venues[n++] = TaxVenue({
                kind: 1,
                factory: SUSHISWAP_V2_FACTORY,
                initCodeHash: SUSHISWAP_V2_INIT_CODE_HASH,
                counterToken: counter,
                v3Fee: 0
            });
            // PancakeSwap V2 (Ethereum mainnet).
            tax.venues[n++] = TaxVenue({
                kind: 1,
                factory: PANCAKE_V2_FACTORY,
                initCodeHash: PANCAKE_V2_INIT_CODE_HASH,
                counterToken: counter,
                v3Fee: 0
            });
        }
        for (uint256 c = 0; c < 4; c++) {
            address counter = counters[c];
            for (uint256 t = 0; t < 4; t++) {
                // Uniswap V3 at each enabled tier.
                tax.venues[n++] = TaxVenue({
                    kind: 2,
                    factory: UNISWAP_V3_FACTORY,
                    initCodeHash: UNISWAP_V3_INIT_CODE_HASH,
                    counterToken: counter,
                    v3Fee: uniV3Tiers[t]
                });
                // PancakeSwap V3. NOTE: the CREATE2 deployer is the PoolDeployer,
                // not the factory — see PANCAKE_V3_POOL_DEPLOYER.
                tax.venues[n++] = TaxVenue({
                    kind: 2,
                    factory: PANCAKE_V3_POOL_DEPLOYER,
                    initCodeHash: PANCAKE_V3_INIT_CODE_HASH,
                    counterToken: counter,
                    v3Fee: cakeV3Tiers[t]
                });
            }
        }
        // n == 44 (12 V2-style + 32 V3-style). V4 covered separately by the
        // PoolManager singleton compare.
    }

    function _assertExternalAddresses() internal view {
        // Accept mainnet (1) or local Anvil fork (31337). The fork forks
        // mainnet but uses a distinct chainId so MetaMask treats it as a
        // separate network and routes signed txs to the local RPC.
        require(
            block.chainid == 1 || block.chainid == 31_337, "Deploy: expected chainid 1 (mainnet) or 31337 (anvil fork)"
        );
        require(PUNKS_MARKET.code.length > 0, "Deploy: PUNKS_MARKET no code");
        require(PUNKS_DATA.code.length > 0, "Deploy: PUNKS_DATA no code");
        require(V4_POOL_MANAGER.code.length > 0, "Deploy: V4_POOL_MANAGER no code");
        require(_resolveFactory().code.length > 0, "Deploy: ARTCOINS_FACTORY no code");
        // Fail-fast on the rest of the integration surface so a misconfigured
        // wiring reverts at preflight rather than mid-broadcast at the factory
        // call (which would burn gas + the deployFee on the reverting tx).
        require(_resolveSkimHook().code.length > 0, "Deploy: ARTCOINS_HOOK_SKIM no code");
        require(_resolveMevModule().code.length > 0, "Deploy: ARTCOINS_MEV_SKIM no code");
        require(_resolveConversionLocker().code.length > 0, "Deploy: CONVERSION_LOCKER no code");
        // Fee escrow: a code-length check alone is insufficient — the abandoned
        // old escrow still has bytecode on mainnet, so it would pass. Cross-check
        // the resolved escrow against the conversion locker's own immutable
        // feeLocker(): CONVERSION_LOCKER is env-injected and freshly wired to the
        // correct escrow, so a stale/mismatched ARTCOINS_FEE_ESCROW reverts HERE
        // instead of permanently binding LiveBidAdapter to the wrong escrow.
        address feeEscrow = _resolveFeeEscrow();
        require(feeEscrow.code.length > 0, "Deploy: ARTCOINS_FEE_ESCROW no code");
        require(
            feeEscrow == IConversionLockerFeeEscrow(_resolveConversionLocker()).feeLocker(),
            "Deploy: ARTCOINS_FEE_ESCROW != conversionLocker.feeLocker()"
        );
        require(_resolvePCController().code.length > 0, "Deploy: PC_CONTROLLER no code");
    }

    /// @dev Output/input path for `deployments.json`. Honors a `DEPLOYMENTS_PATH`
    ///      env override; defaults to `<root>/deployments.json` for production
    ///      broadcasts (unset → byte-identical to before). The override lets the
    ///      fork-test fixture give each parallel `-j` suite its OWN file, so the
    ///      Phase-2a `runContracts()` write → Phase-2b `runToken()` read handoff
    ///      can't race another suite on a shared path.
    function _deploymentsPath() internal view returns (string memory) {
        return vm.envOr("DEPLOYMENTS_PATH", string.concat(vm.projectRoot(), "/deployments.json"));
    }

    function _writeDeployments(
        _DeploymentAddresses memory d
    ) internal {
        string memory json = "deployments";
        vm.serializeAddress(json, "punksData", PUNKS_DATA);
        vm.serializeAddress(json, "permanentCollection", address(d.collection));
        vm.serializeAddress(json, "patron", address(d.patron));
        vm.serializeAddress(json, "buybackBurner", address(d.burner));
        vm.serializeAddress(json, "returnAuctionModule", address(d.finalSale));
        vm.serializeAddress(json, "punkVault", address(d.vault));
        vm.serializeAddress(json, "token", d.tokenAddr);
        vm.serializeAddress(json, "hook", d.hookAddr);
        vm.serializeAddress(json, "locker", d.lockerAddr);
        vm.serializeAddress(json, "liveBidAdapter", d.adapterAddr);
        vm.serializeAddress(json, "vaultBurnPool", d.vaultBurnPoolAddr);
        vm.serializeAddress(json, "renderer", d.rendererAddr);
        vm.serializeAddress(json, "rendererRegistry", d.rendererRegistryAddr);
        vm.serializeAddress(json, "punkSvgCache", d.punkSvgCacheAddr);
        vm.serializeAddress(json, "traitIconCache", d.traitIconCacheAddr);
        vm.serializeAddress(json, "titleAuction", d.titleAuctionAddr);
        vm.serializeAddress(json, "protocolAdmin", address(d.adminContract));
        vm.serializeAddress(json, "tokenAdminPoker", d.tokenAdminPokerAddr);
        vm.serializeAddress(json, "protocolFeePhaseAdapter", d.protocolFeePhaseAdapterAddr);
        vm.serializeAddress(json, "pcSwapContext", d.swapContextAddr);
        vm.serializeAddress(json, "referralPayout", d.referralPayoutAddr);
        // MEV skim module, canonical pool id, and the hook baseline skim, so
        // VerifyDeploy can assert the module decays to exactly the hook baseline
        // (else the pool settles at the wrong static skim after the MEV window).
        vm.serializeAddress(json, "mevModule", _resolveMevModule());
        bytes32 poolId = PoolId.unwrap(
            PoolIdLibrary.toId(
                PoolKey({
                    currency0: Currency.wrap(address(0)),
                    currency1: Currency.wrap(d.tokenAddr),
                    fee: DYNAMIC_FEE_FLAG,
                    tickSpacing: TICK_SPACING,
                    hooks: IHooks(d.hookAddr)
                })
            )
        );
        vm.serializeBytes32(json, "canonicalPoolId", poolId);
        vm.serializeUint(json, "baselineSkimBps", BASELINE_SKIM_BPS);
        // Downstream LP-fee converter; VerifyDeploy reads its step + slippage caps.
        vm.serializeAddress(json, "feeAutoSwapper", d.feeAutoSwapperAddr);
        vm.serializeUint(json, "deployBlock", block.number);
        string memory out = vm.serializeUint(json, "chainId", block.chainid);
        string memory path = _deploymentsPath();
        vm.writeFile(path, out);
    }

    /// @dev Inverse of `_writeDeployments` — rebuild the address struct from
    ///      `deployments.json` so `runToken()` (Phase 2b) can wire the token
    ///      into the PC contracts deployed by `runContracts()` (Phase 2a).
    ///      token/hook/locker are intentionally NOT read back (they are
    ///      address(0) in the Phase-2a file and are filled by the factory call).
    function _readDeployments() internal view returns (_DeploymentAddresses memory d) {
        string memory path = _deploymentsPath();
        string memory json = vm.readFile(path);
        d.collection = PermanentCollection(vm.parseJsonAddress(json, ".permanentCollection"));
        d.patron = Patron(payable(vm.parseJsonAddress(json, ".patron")));
        d.burner = BuybackBurner(payable(vm.parseJsonAddress(json, ".buybackBurner")));
        d.finalSale = ReturnAuctionModule(payable(vm.parseJsonAddress(json, ".returnAuctionModule")));
        d.vault = PunkVault(vm.parseJsonAddress(json, ".punkVault"));
        d.adminContract = ProtocolAdmin(vm.parseJsonAddress(json, ".protocolAdmin"));
        d.adapterAddr = vm.parseJsonAddress(json, ".liveBidAdapter");
        d.rendererAddr = vm.parseJsonAddress(json, ".renderer");
        d.rendererRegistryAddr = vm.parseJsonAddress(json, ".rendererRegistry");
        d.vaultBurnPoolAddr = vm.parseJsonAddress(json, ".vaultBurnPool");
        d.titleAuctionAddr = vm.parseJsonAddress(json, ".titleAuction");
        d.punkSvgCacheAddr = vm.parseJsonAddress(json, ".punkSvgCache");
        d.traitIconCacheAddr = vm.parseJsonAddress(json, ".traitIconCache");
        d.tokenAdminPokerAddr = vm.parseJsonAddress(json, ".tokenAdminPoker");
        d.protocolFeePhaseAdapterAddr = vm.parseJsonAddress(json, ".protocolFeePhaseAdapter");
        d.swapContextAddr = vm.parseJsonAddress(json, ".pcSwapContext");
        d.referralPayoutAddr = vm.parseJsonAddress(json, ".referralPayout");
        d.feeAutoSwapperAddr = vm.parseJsonAddress(json, ".feeAutoSwapper");
        // Read token/hook/locker so `runToken`'s idempotency guard works against
        // a post-launch file. After `runContracts` these are address(0); after
        // `runToken` they are the real addresses. The guard reverts on the
        // latter so a stray re-broadcast can't double-launch.
        d.tokenAddr = vm.parseJsonAddress(json, ".token");
        d.hookAddr = vm.parseJsonAddress(json, ".hook");
        d.lockerAddr = vm.parseJsonAddress(json, ".locker");
    }
}
