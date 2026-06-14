// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SkimForkFixture} from "./helpers/SkimForkFixture.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";

import {IArtCoinsTaxable} from "artcoins/interfaces/IArtCoinsTaxable.sol";
import {TokenAdminPoker} from "../src/TokenAdminPoker.sol";

import {console2} from "forge-std/console2.sol";

interface IERC20R {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @notice Side-pool V4 liquidity + direct-take buy helper. Native ETH = c0,
///         111 = c1. A `buyTo` here takes the bought 111 DIRECTLY from the
///         PoolManager (a venue) to the recipient, which is what the token's
///         venue-scoped buy tax sees — so a buy on this hookless pool is taxed,
///         exactly like a real side-pool buy.
contract SideV4Kit is IUnlockCallback {
    IPoolManager public immutable pm;
    address public immutable token;

    constructor(address _pm, address _token) {
        pm = IPoolManager(_pm);
        token = _token;
    }

    receive() external payable {}

    struct Job {
        uint8 op; // 0 buy→recipient, 1 addLiq, 2 sell(111 in)→recipient
        PoolKey key;
        uint256 amtIn; // ETH for buy, 111 for sell
        address recipient;
        int24 tickLower;
        int24 tickUpper;
        int256 liq;
    }

    function buyTo(PoolKey calldata key, uint256 ethIn, address recipient)
        external
        payable
        returns (uint256 grossOut)
    {
        require(msg.value == ethIn, "kit: exact ETH");
        Job memory j;
        j.op = 0;
        j.key = key;
        j.amtIn = ethIn;
        j.recipient = recipient;
        grossOut = abi.decode(pm.unlock(abi.encode(j)), (uint256));
    }

    /// @notice Sell exact `pctIn` 111 into `key`, ETH out to `recipient`. Caller
    ///         must transfer the 111 to this kit first (so the kit, not a venue,
    ///         is the `from` on the into-pool leg — untaxed, like a real sell).
    function sellTo(PoolKey calldata key, uint256 pctIn, address recipient)
        external
        returns (uint256 ethOut)
    {
        Job memory j;
        j.op = 2;
        j.key = key;
        j.amtIn = pctIn;
        j.recipient = recipient;
        ethOut = abi.decode(pm.unlock(abi.encode(j)), (uint256));
    }

    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liq)
        external
        payable
    {
        Job memory j;
        j.op = 1;
        j.key = key;
        j.tickLower = tickLower;
        j.tickUpper = tickUpper;
        j.liq = liq;
        pm.unlock(abi.encode(j));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "kit: not pm");
        Job memory j = abi.decode(data, (Job));

        if (j.op == 0) {
            BalanceDelta d = pm.swap(
                j.key,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(j.amtIn),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                ""
            );
            uint256 ethSpent = uint256(uint128(-d.amount0()));
            uint256 tokenOut = uint256(uint128(d.amount1()));
            pm.settle{value: ethSpent}();
            pm.take(Currency.wrap(token), j.recipient, tokenOut);
            return abi.encode(tokenOut);
        } else if (j.op == 1) {
            (BalanceDelta cd,) = pm.modifyLiquidity(
                j.key,
                ModifyLiquidityParams({
                    tickLower: j.tickLower,
                    tickUpper: j.tickUpper,
                    liquidityDelta: j.liq,
                    salt: bytes32(0)
                }),
                ""
            );
            int128 a0 = cd.amount0();
            int128 a1 = cd.amount1();
            if (a0 < 0) pm.settle{value: uint256(uint128(-a0))}();
            if (a1 < 0) {
                pm.sync(Currency.wrap(token));
                IERC20R(token).transfer(address(pm), uint256(uint128(-a1)));
                pm.settle();
            }
            return "";
        } else {
            // Sell: 111 (c1) in, ETH (c0) out to recipient.
            BalanceDelta d = pm.swap(
                j.key,
                SwapParams({
                    zeroForOne: false,
                    amountSpecified: -int256(j.amtIn),
                    sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            uint256 pctSpent = uint256(uint128(-d.amount1()));
            uint256 ethRecv = uint256(uint128(d.amount0()));
            pm.sync(Currency.wrap(token));
            IERC20R(token).transfer(address(pm), pctSpent);
            pm.settle();
            pm.take(Currency.wrap(address(0)), j.recipient, ethRecv);
            return abi.encode(ethRecv);
        }
    }
}

/// @title  SidePoolRoutingBehavior — Phase 1, Track A (real stack, 5% tax)
/// @notice Fork harness that measures canonical-vs-side-pool routing economics
///         against the LIVE Deploy.s.sol bytecode at the launch 5% transfer tax.
///         Proves the mechanics (which route feeds the bid, which only burns,
///         which leaks) and runs a controlled discount × size sweep with a
///         best-execution comparator built on Foundry state snapshots.
///
///         Run:
///           MAINNET_RPC_URL=https://gateway.tenderly.co/public/mainnet \
///           forge test --match-contract SidePoolRoutingBehavior -vv
///
///         The >5% side-tax sweep (10/15/20/25%) lives in the Track-B file,
///         which uses a cap-parametrized test-double token — the production
///         token is structurally capped at 5% (invariant #21).
contract SidePoolRoutingBehaviorTest is SkimForkFixture {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint16 internal constant TAX_BPS = 1500; // launch 15% (cap 2000/20%)
    uint256 internal constant TAX_DENOM = 10_000;

    // Canonical pool key (native ETH / 111, dynamic fee, real hook).
    PoolKey internal canonKey;
    // Side V4 pool key (hookless, fee 0.30%, ts 60) — re-initialized per discount.
    uint24 internal constant SIDE_FEE = 3000;
    int24 internal constant SIDE_TS = 60;
    int24 internal constant SIDE_HALF = 10_000; // half-width of the seeded LP range, in ticks

    // One-time 111 reserve acquired in setUp to seed side pools without a fresh
    // canonical buy per cell. This single buy sets a consistent canonical
    // baseline; every per-cell comparison reads the live post-buy price, so the
    // canon-vs-side WINNER determinations are unbiased (only absolute outputs
    // sit at the post-seed baseline).
    uint256 internal seedReserve;

    TestSwapHelper internal canonSwap; // canonical buys/sells (real hook ⇒ skim + exempt)
    TestSwapHelper internal sideSwap; // side buys/sells via the hookless pool key
    SideV4Kit internal sideKit; // seed side liquidity + direct-take taxed buys

    address internal trader = address(0x7AaAAAAd);

    // Discount ladder (bps of price discount on the side pool) and trade-size
    // ladder (wei of ETH for buys). Kept modest so the seeded depth dominates.
    uint16[9] internal DISCOUNTS = [0, 250, 500, 750, 1000, 1250, 1500, 2000, 2500];

    function setUp() public {
        string memory rpc =
            vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(rpc);

        _runFullDeploy();

        canonKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 0x800000,
            tickSpacing: 200,
            hooks: IHooks(deployedHook)
        });

        canonSwap = new TestSwapHelper(POOL_MANAGER, token, deployedHook, 0x800000, 200);
        sideSwap = new TestSwapHelper(POOL_MANAGER, token, address(0), SIDE_FEE, SIDE_TS);
        sideKit = new SideV4Kit(POOL_MANAGER, token);

        // Past the ~30-min MEV window so the skim is the static 6% baseline.
        vm.warp(block.timestamp + 90 minutes);

        // One-time 111 reserve for seeding side pools (deepest pool ~30 ETH).
        seedReserve = _fundPct(address(this), 40 ether);
    }

    receive() external payable {}

    // ─────────────────────────────────────────────────────────────────────
    //  Price + seeding helpers
    // ─────────────────────────────────────────────────────────────────────

    function _canonSqrt() internal view returns (uint160 sp) {
        (sp,,,) = IPoolManager(POOL_MANAGER).getSlot0(canonKey.toId());
    }

    /// @dev Buy 111 on the canonical pool (exempt) and leave it with `to`.
    function _fundPct(address to, uint256 ethIn) internal returns (uint256 out) {
        vm.deal(address(this), address(this).balance + ethIn);
        out = canonSwap.buyTokenWithEth{value: ethIn}(ethIn);
        if (to != address(this) && out > 0) IERC20R(token).transfer(to, out);
    }

    /// @notice (Re)create the side V4 pool priced `discountBps` BELOW canonical,
    ///         i.e. 111 is `discountBps/1e4` cheaper in ETH terms on the side.
    ///         A cheaper 111 means MORE 111 per ETH → a HIGHER amount1/amount0 →
    ///         sqrtPrice scaled by sqrt(1/(1-d)). Liquidity is sized from the
    ///         target `ethDepth` via `LiquidityAmounts` (111 side oversupplied
    ///         from the reserve so ETH is the binding amount), giving a pool
    ///         deep enough that the sweep's trade sizes see realistic slippage
    ///         instead of exhausting it. Returns the seeded key.
    ///
    ///         The V4 pool id is fixed by the key, so the pool can only be
    ///         initialized once — the sweep seeds inside a snapshot and reverts
    ///         between cells.
    function _seedSideV4(uint16 discountBps, uint256 ethDepth, uint256 pctForPool)
        internal
        returns (PoolKey memory key)
    {
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: SIDE_FEE,
            tickSpacing: SIDE_TS,
            hooks: IHooks(address(0))
        });

        // sideSqrt = canonicalSqrt * sqrt(1/(1-d)).
        uint160 cs = _canonSqrt();
        uint256 oneMinusD = 1e18 - (uint256(discountBps) * 1e18) / 10_000;
        uint256 invX18 = (1e18 * 1e18) / oneMinusD; // 1/(1-d), 1e18
        uint256 sqrtFactorX9 = FixedPointMathLib.sqrt(invX18 * 1e18) / 1e9; // sqrt(invX18) in 1e9
        uint160 sideSqrt = uint160((uint256(cs) * sqrtFactorX9) / 1e9);

        IPoolManager(POOL_MANAGER).initialize(key, sideSqrt);

        // Symmetric range around the seeded price; size liquidity from ethDepth.
        int24 cur = TickMath.getTickAtSqrtPrice(sideSqrt);
        int24 lower = ((cur - SIDE_HALF) / SIDE_TS) * SIDE_TS;
        int24 upper = ((cur + SIDE_HALF) / SIDE_TS) * SIDE_TS;
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sideSqrt,
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            ethDepth,
            pctForPool
        );

        IERC20R(token).transfer(address(sideKit), pctForPool);
        vm.deal(address(this), address(this).balance + ethDepth);
        sideKit.addLiquidity{value: ethDepth}(key, lower, upper, int256(uint256(liq)));
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Route primitives — each returns the trader's realized output and
    //  records bid / burn deltas via the out-params.
    // ─────────────────────────────────────────────────────────────────────

    struct Deltas {
        uint256 bidDelta; // live-bid SIDE gain = LiveBidAdapter buffer + Patron
        uint256 protoDelta; // ProtocolFeePhaseAdapter gain
        uint256 burnDelta; // venue-tax 111 accrued in VaultBurnPool
    }

    /// @dev The "bid" quantity is the live-bid SIDE: the adapter buffer PLUS
    ///      Patron. The hook's pre-swap stream moves the bounty leg
    ///      adapter→Patron on each canonical swap, so measuring the adapter
    ///      alone would under-count (and underflow when the stream drains it).
    ///      The combined balance only grows when a CANONICAL swap feeds the
    ///      bid; a side-pool swap doesn't touch the canonical hook, so its
    ///      bidDelta stays 0.
    function _snap() internal view returns (uint256 bid, uint256 proto, uint256 dead) {
        bid = address(liveBidAdapter).balance + address(patron).balance;
        proto = address(protocolFeePhaseAdapter).balance;
        dead = IERC20R(token).balanceOf(address(vaultBurnPool));
    }

    function _diff(uint256 bid0, uint256 proto0, uint256 dead0)
        internal
        view
        returns (Deltas memory d)
    {
        d.bidDelta = (address(liveBidAdapter).balance + address(patron).balance) - bid0;
        d.protoDelta = address(protocolFeePhaseAdapter).balance - proto0;
        d.burnDelta = IERC20R(token).balanceOf(address(vaultBurnPool)) - dead0;
    }

    function _canonBuy(uint256 ethIn) internal returns (uint256 pctOut, Deltas memory d) {
        (uint256 b, uint256 p, uint256 dd) = _snap();
        vm.deal(address(this), address(this).balance + ethIn);
        pctOut = canonSwap.buyTokenWithEth{value: ethIn}(ethIn);
        d = _diff(b, p, dd);
    }

    function _sideBuyV4(PoolKey memory key, uint256 ethIn)
        internal
        returns (uint256 pctNet, Deltas memory d)
    {
        (uint256 b, uint256 p, uint256 dd) = _snap();
        uint256 before = IERC20R(token).balanceOf(trader);
        vm.deal(address(this), address(this).balance + ethIn);
        sideKit.buyTo{value: ethIn}(key, ethIn, trader);
        pctNet = IERC20R(token).balanceOf(trader) - before; // net of the burn
        d = _diff(b, p, dd);
    }

    function _canonSell(uint256 pctIn) internal returns (uint256 ethOut, Deltas memory d) {
        (uint256 b, uint256 p, uint256 dd) = _snap();
        IERC20R(token).approve(address(canonSwap), pctIn);
        ethOut = canonSwap.sellTokenForEth(pctIn);
        d = _diff(b, p, dd);
    }

    function _sideSellV4(PoolKey memory key, uint256 pctIn)
        internal
        returns (uint256 ethOut, Deltas memory d)
    {
        (uint256 b, uint256 p, uint256 dd) = _snap();
        IERC20R(token).transfer(address(sideKit), pctIn);
        ethOut = sideKit.sellTo(key, pctIn, address(this));
        d = _diff(b, p, dd);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Mechanical assertions (Core Qs 1–7)
    // ─────────────────────────────────────────────────────────────────────

    /// 1 + 2: canonical buys AND sells grow the live-bid leg by ~5% of volume
    ///        (~83.33% of the 6% baseline skim), landing on LiveBidAdapter in-tx.
    function test_canonicalBuyAndSell_feedBid() public {
        uint256 ethIn = 1 ether;
        (uint256 pct, Deltas memory db) = _canonBuy(ethIn);
        assertGt(pct, 0, "canon buy produced 111");
        // skim ~6% of volume; bid leg = ~83.33% of skim = ~5% of volume. The
        // volume is the swap's ETH input; allow generous tolerance for fee rounding.
        uint256 expectedBid = (ethIn * 6_000 / 100_000) * 8_333 / 10_000;
        assertApproxEqRel(db.bidDelta, expectedBid, 0.05e18, "buy: ~5% to bid leg");
        assertEq(db.burnDelta, 0, "canonical buy is exempt (no burn)");

        // Sell the 111 back; skim fires on the sell direction too.
        (uint256 ethOut, Deltas memory ds) = _canonSell(pct);
        assertGt(ethOut, 0, "canon sell produced ETH");
        assertGt(ds.bidDelta, 0, "sell also feeds the bid leg");
        assertEq(ds.burnDelta, 0, "canonical sell not taxed");
    }

    /// 3 + 5: a side-pool buy does NOT feed the bid and burns exactly the launch
    ///        tax (15%) of the gross 111 out.
    function test_sideBuy_burnsNoBid() public {
        uint256 s = vm.snapshotState();
        PoolKey memory key = _seedSideV4(0, 30 ether, seedReserve);

        (uint256 b, uint256 p, uint256 dd) = _snap();
        uint256 before = IERC20R(token).balanceOf(trader);
        vm.deal(address(this), 1 ether);
        uint256 gross = sideKit.buyTo{value: 0.2 ether}(key, 0.2 ether, trader);
        uint256 net = IERC20R(token).balanceOf(trader) - before;
        Deltas memory d = _diff(b, p, dd);

        assertGt(gross, 0, "side buy produced 111");
        uint256 expTax = gross * TAX_BPS / TAX_DENOM;
        assertEq(d.burnDelta, expTax, "side buy burns the 15% launch tax");
        assertEq(net, gross - expTax, "trader nets gross - tax");
        assertEq(d.bidDelta, 0, "side buy does NOT feed the bid");
        assertEq(d.protoDelta, 0, "side buy does NOT feed protocol leg");
        vm.revertToState(s);
    }

    /// 4 + 6: a side-pool sell feeds neither the bid nor the burn (untaxed).
    function test_sideSell_noBidNoTax() public {
        uint256 s = vm.snapshotState();
        PoolKey memory key = _seedSideV4(0, 30 ether, seedReserve);
        uint256 pct = _fundPct(address(this), 2 ether);

        (uint256 b, uint256 p, uint256 dd) = _snap();
        (uint256 ethOut,) = _sideSellV4(key, pct);
        Deltas memory d = _diff(b, p, dd);

        assertGt(ethOut, 0, "side sell produced ETH");
        assertEq(d.burnDelta, 0, "side sell is untaxed (the leak)");
        assertEq(d.bidDelta, 0, "side sell does NOT feed the bid");
        vm.revertToState(s);
    }

    /// 7 (wallet-to-wallet untaxed) — sanity that only venue outflows are taxed.
    function test_walletToWallet_untaxed() public {
        uint256 pct = _fundPct(address(0xBEEF), 1 ether);
        uint256 deadBefore = IERC20R(token).balanceOf(address(vaultBurnPool));
        vm.prank(address(0xBEEF));
        IERC20R(token).transfer(address(0xCAFE), pct);
        assertEq(IERC20R(token).balanceOf(address(vaultBurnPool)), deadBefore, "wallet send untaxed");
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Best-execution comparator (Foundry-snapshot based)
    //
    //  Realizes the "LocalBestExecutionRouter": execute each route from an
    //  identical state, record the actual realized output, revert, compare.
    //  Not a deployed contract — cheatcode snapshots make this MORE faithful
    //  (real execution, not a quote).
    // ─────────────────────────────────────────────────────────────────────

    /// @return canonOut 111 from canonical buy; sideOut 111 (net of tax) from side
    function _bestBuy(PoolKey memory key, uint256 ethIn)
        internal
        returns (uint256 canonOut, uint256 sideOut, Deltas memory canonD, Deltas memory sideD)
    {
        uint256 s1 = vm.snapshotState();
        (canonOut, canonD) = _canonBuy(ethIn);
        vm.revertToState(s1);
        uint256 s2 = vm.snapshotState();
        (sideOut, sideD) = _sideBuyV4(key, ethIn);
        vm.revertToState(s2);
    }

    /// @return canonOut ETH from canonical sell; sideOut ETH from side sell
    function _bestSell(PoolKey memory key, uint256 pctIn)
        internal
        returns (uint256 canonOut, uint256 sideOut)
    {
        uint256 s1 = vm.snapshotState();
        (canonOut,) = _canonSell(pctIn);
        vm.revertToState(s1);
        uint256 s2 = vm.snapshotState();
        (sideOut,) = _sideSellV4(key, pctIn);
        vm.revertToState(s2);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  The sweep: for the launch 5% tax, walk the discount ladder and, at each
    //  rung, compare buys and sells across canonical vs side at several sizes.
    //  Emits a CSV-friendly matrix row per cell.
    // ─────────────────────────────────────────────────────────────────────

    function test_sweep_v4_5pct() public {
        console2.log("tax_bps,discount_bps,size_eth_milli,buy_winner,canon_pct,side_pct,sell_winner,canon_eth,side_eth,bid_via_canon,bid_via_side,burn_side");
        uint256[4] memory sizes = [uint256(0.05 ether), 0.25 ether, 1 ether, 3 ether];

        for (uint256 di = 0; di < DISCOUNTS.length; di++) {
            uint16 disc = DISCOUNTS[di];
            for (uint256 si = 0; si < sizes.length; si++) {
                uint256 sizeEth = sizes[si];
                uint256 root = vm.snapshotState();
                // The deployed stack launches at 15%; dial down to 5% so this
                // baseline run logs the rate it claims (the 5% row summarized in
                // docs/router-results/FINAL_ROUTER_REPORT.md §1). Reverted with
                // `root` each iter.
                _setTax(500);

                PoolKey memory key = _seedSideV4(disc, 30 ether, seedReserve);

                // Buys: compare 111 out (clean seeded prices, no prior perturbation).
                (uint256 cBuy, uint256 sBuy, Deltas memory cBuyD, Deltas memory sBuyD) =
                    _bestBuy(key, sizeEth);

                // Sells: the trader must actually HOLD the 111 being sold, so
                // acquire ~`sizeEth` worth via a real canonical buy, compare both
                // sell routes (each reverted so the inventory is restored), then
                // revert the acquisition. The buy comparison above already ran on
                // the unperturbed price, so this acquisition biases nothing.
                uint256 sellSnap = vm.snapshotState();
                (uint256 pctForSell,) = _canonBuy(sizeEth);
                (uint256 cSell, uint256 sSell) = _bestSell(key, pctForSell);
                vm.revertToState(sellSnap);

                _logRow(
                    500, disc, sizeEth, cBuy, sBuy, cSell, sSell, cBuyD.bidDelta, sBuyD.bidDelta, sBuyD.burnDelta
                );

                vm.revertToState(root);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Real-stack tax-rate sweep (production-valid range, runs against the
    //  LIVE Deploy.s.sol stack — real hook, real canonical depth, real token).
    //
    //  Loops the LIVE side tax across the full shippable ladder
    //  5/10/12.5/15/20%, dialed via TokenAdminPoker.setTokenTaxBps. Every rung
    //  is ≤ the production cap (TAX_BPS_ABSOLUTE_MAX / TRANSFER_TAX_BPS_MAX =
    //  2000), so the sweep runs end-to-end and proves the launch rate (15%) and
    //  the ceiling (20%) behave on the real stack. The 25% over-cap probe from
    //  the research run is intentionally NOT in this ladder — the production
    //  token structurally refuses anything above 20% (asserted by
    //  test_productionCap_rejectsAbove20pct below). The over-cap economics were
    //  logged from the research run under a locally-raised cap and are
    //  summarized in docs/router-results/FINAL_ROUTER_REPORT.md (the raw rows
    //  are reproducible by raising the cap locally and re-running this sweep).
    // ─────────────────────────────────────────────────────────────────────

    uint16[5] internal TAXES = [500, 1000, 1250, 1500, 2000];

    function test_sweep_realstack_taxrates() public {
        console2.log("tax_bps,discount_bps,size_eth_milli,buy_winner,canon_pct,side_pct,sell_winner,canon_eth,side_eth,bid_via_canon,bid_via_side,burn_side");
        uint256[3] memory sizes = [uint256(0.1 ether), 1 ether, 3 ether];

        for (uint256 ti = 0; ti < TAXES.length; ti++) {
            for (uint256 di = 0; di < DISCOUNTS.length; di++) {
                for (uint256 si = 0; si < sizes.length; si++) {
                    uint256 root = vm.snapshotState();
                    _setTax(TAXES[ti]);
                    PoolKey memory key = _seedSideV4(DISCOUNTS[di], 30 ether, seedReserve);

                    (uint256 cBuy, uint256 sBuy, Deltas memory cBuyD, Deltas memory sBuyD) =
                        _bestBuy(key, sizes[si]);

                    uint256 sellSnap = vm.snapshotState();
                    (uint256 pctForSell,) = _canonBuy(sizes[si]);
                    (uint256 cSell, uint256 sSell) = _bestSell(key, pctForSell);
                    vm.revertToState(sellSnap);

                    _logRow(
                        TAXES[ti], DISCOUNTS[di], sizes[si], cBuy, sBuy, cSell, sSell,
                        cBuyD.bidDelta, sBuyD.bidDelta, sBuyD.burnDelta
                    );
                    vm.revertToState(root);
                }
            }
        }
    }

    /// @notice The production token structurally refuses any rate above the
    ///         20% ceiling (invariant #21). The research sweep probed 25% under
    ///         a locally-raised cap; here we assert the SHIPPED stack rejects it,
    ///         so the over-cap rung is recorded as a guarded boundary, not an
    ///         intentional red. 2000 (the ceiling) is accepted; 2001 and 2500
    ///         revert.
    function test_productionCap_rejectsAbove20pct() public {
        TokenAdminPoker poker = _poker();
        address owner = poker.owner();

        // At the ceiling: accepted.
        vm.prank(owner);
        poker.setTokenTaxBps(2000);

        // One bp over the ceiling: rejected.
        vm.prank(owner);
        vm.expectRevert();
        poker.setTokenTaxBps(2001);

        // The research over-cap rung (25%): rejected.
        vm.prank(owner);
        vm.expectRevert();
        poker.setTokenTaxBps(2500);
    }

    /// @dev Dial the live side tax via TokenAdminPoker (the two-key carve-out).
    function _setTax(uint16 bps) internal {
        TokenAdminPoker poker = _poker();
        vm.prank(poker.owner());
        poker.setTokenTaxBps(bps);
    }

    function _poker() internal view returns (TokenAdminPoker) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments.json"));
        return TokenAdminPoker(vm.parseJsonAddress(json, ".tokenAdminPoker"));
    }

    function _logRow(
        uint16 tax,
        uint16 disc,
        uint256 sizeEth,
        uint256 cBuy,
        uint256 sBuy,
        uint256 cSell,
        uint256 sSell,
        uint256 bidCanon,
        uint256 bidSide,
        uint256 burnSide
    ) internal view {
        console2.log(
            string.concat(
                _u(tax),
                ",",
                _u(disc),
                ",",
                _u(sizeEth / 1e15),
                ",",
                cBuy >= sBuy ? "CANON" : "SIDE",
                ",",
                _u(cBuy),
                ",",
                _u(sBuy),
                ",",
                cSell >= sSell ? "CANON" : "SIDE",
                ",",
                _u(cSell),
                ",",
                _u(sSell),
                ",",
                _u(bidCanon),
                ",",
                _u(bidSide),
                ",",
                _u(burnSide)
            )
        );
    }

    function _u(uint256 v) internal view returns (string memory) {
        return vm.toString(v);
    }
}
