// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

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

import {IArtCoinsTaxable, TaxConfig} from "artcoins/interfaces/IArtCoinsTaxable.sol";
import {ArtCoinsToken} from "artcoins/ArtCoinsToken.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {TokenAdminPoker} from "../src/TokenAdminPoker.sol";

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

interface IFeeAutoSwapperView {
    function accruedArtCoin() external view returns (uint256);
}

interface IWETH9 {
    function deposit() external payable;
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IUniV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniV2Pair {
    function mint(address to) external returns (uint256 liquidity);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

/// @dev Uniswap-V3-style factory (Uniswap V3, PancakeSwap V3). `createPool`
///      CREATE2-deploys the pool and returns its address — for PancakeSwap V3
///      the actual deployer is a separate PoolDeployer, which is exactly the
///      subtlety the venue derivation must get right.
interface IUniV3FactoryLike {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

/// @dev Uniswap-V3-style pool surface used to stand up + trade a side V3 pool.
interface IUniV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice Multi-purpose V4 unlock helper for the tax tests. Supports
///         buying with native ETH and TAKING the bought token DIRECTLY to a
///         chosen recipient (so the venue→recipient transfer is what the tax
///         path sees), plus add/remove liquidity on an arbitrary pool key.
///         Native ETH = currency0; the art coin = currency1.
contract V4TaxKit is IUnlockCallback {
    IPoolManager public immutable pm;
    address public immutable token;

    constructor(address _pm, address _token) {
        pm = IPoolManager(_pm);
        token = _token;
    }

    receive() external payable {}

    // op 0 = buy(take→recipient); 1 = addLiquidity; 2 = removeLiquidity
    struct Job {
        uint8 op;
        PoolKey key;
        uint256 ethIn;
        address recipient;
        int24 tickLower;
        int24 tickUpper;
        int256 liq;
    }

    /// @notice Buy art coin with exactly `ethIn` and take the realized output
    ///         DIRECTLY to `recipient` (the venue→recipient transfer that the
    ///         token taxes when the pool is not the canonical one).
    function buyTo(PoolKey calldata key, uint256 ethIn, address recipient)
        external
        payable
        returns (uint256 grossOut)
    {
        require(msg.value == ethIn, "kit: send exact ETH");
        Job memory j;
        j.op = 0;
        j.key = key;
        j.ethIn = ethIn;
        j.recipient = recipient;
        grossOut = abi.decode(pm.unlock(abi.encode(j)), (uint256));
    }

    /// @notice Add liquidity to `key`. Caller pre-funds this kit with the art
    ///         coin (transfer in) and the ETH (msg.value). Returns leftover ETH.
    function addLiquidity(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liq
    ) external payable {
        Job memory j;
        j.op = 1;
        j.key = key;
        j.tickLower = tickLower;
        j.tickUpper = tickUpper;
        j.liq = liq;
        pm.unlock(abi.encode(j));
    }

    /// @notice Remove `liq` liquidity from `key`, taking both sides to `recipient`.
    function removeLiquidity(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liq,
        address recipient
    ) external {
        Job memory j;
        j.op = 2;
        j.key = key;
        j.tickLower = tickLower;
        j.tickUpper = tickUpper;
        j.liq = liq;
        j.recipient = recipient;
        pm.unlock(abi.encode(j));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "kit: not pm");
        Job memory j = abi.decode(data, (Job));

        if (j.op == 0) {
            // Buy: ETH (c0) in, token (c1) out; take directly to recipient.
            BalanceDelta d = pm.swap(
                j.key,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(j.ethIn),
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
            // Add liquidity; settle whatever is owed (both sides negative).
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
                IERC20T(token).transfer(address(pm), uint256(uint128(-a1)));
                pm.settle();
            }
            return "";
        } else {
            // Remove liquidity; take both owed sides to recipient.
            (BalanceDelta cd,) = pm.modifyLiquidity(
                j.key,
                ModifyLiquidityParams({
                    tickLower: j.tickLower,
                    tickUpper: j.tickUpper,
                    liquidityDelta: j.liq, // negative
                    salt: bytes32(0)
                }),
                ""
            );
            int128 a0 = cd.amount0();
            int128 a1 = cd.amount1();
            if (a0 > 0) pm.take(Currency.wrap(address(0)), j.recipient, uint256(uint128(a0)));
            if (a1 > 0) pm.take(Currency.wrap(token), j.recipient, uint256(uint128(a1)));
            return "";
        }
    }
}

/// @notice Stands up + trades a side Uniswap-V3 pool. Holds 111 + WETH
///         (pre-funded) and pays the V3 mint/swap callbacks. A buy takes the
///         111 output DIRECTLY to `recipient` — the venue→recipient outflow the
///         token taxes on a non-canonical pool. The pool's reported output is
///         the GROSS it transferred; the token's override splits it into net
///         (recipient) + tax (VaultBurnPool) on the way out, so the pool's own
///         balance accounting is unaffected.
contract V3TaxKit {
    address public immutable token;
    address public immutable weth;

    constructor(address _token, address _weth) {
        token = _token;
        weth = _weth;
    }

    /// @notice Mint `amount` liquidity into `pool` over `[tickLower, tickUpper]`.
    ///         The kit must already hold enough 111 + WETH for the callback.
    function mintLiquidity(address pool, int24 tickLower, int24 tickUpper, uint128 amount) external {
        IUniV3Pool(pool).mint(address(this), tickLower, tickUpper, amount, abi.encode(pool));
    }

    /// @notice Buy 111 with exactly `wethIn` WETH on `pool`, output to
    ///         `recipient`. Returns the GROSS 111 the pool sent (pre-tax).
    function buyTokenTo(address pool, address recipient, uint256 wethIn) external returns (uint256 grossOut) {
        bool wethIsZero = IUniV3Pool(pool).token0() == weth;
        // zeroForOne sells token0. We sell WETH (the input) for 111 (the output).
        bool zeroForOne = wethIsZero;
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        (int256 a0, int256 a1) =
            IUniV3Pool(pool).swap(recipient, zeroForOne, int256(wethIn), limit, abi.encode(pool));
        // The 111 leg is the negative delta (the pool pays it out).
        grossOut = uint256(-(wethIsZero ? a1 : a0));
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "kit3: not pool");
        if (amount0Owed > 0) IERC20T(IUniV3Pool(pool).token0()).transfer(pool, amount0Owed);
        if (amount1Owed > 0) IERC20T(IUniV3Pool(pool).token1()).transfer(pool, amount1Owed);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "kit3: not pool");
        if (amount0Delta > 0) IERC20T(IUniV3Pool(pool).token0()).transfer(pool, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20T(IUniV3Pool(pool).token1()).transfer(pool, uint256(amount1Delta));
    }
}

/// @notice Minimal contract recipient — stands in for a Safe / ERC-4337 account
///         to prove contract-to-contract sends are never taxed.
contract MockWallet {
    function send(address tok, address to, uint256 amt) external {
        IERC20T(tok).transfer(to, amt);
    }
}

/// @title  TaxedTokenForkTest
/// @notice Adversarial fork tests for 111PUNKS' venue-scoped buy-side transfer
///         tax, exercised against the live `Deploy.s.sol` bytecode on a mainnet
///         fork (same pattern as `LaunchInvariantFork`). Run:
///           MAINNET_RPC_URL=https://gateway.tenderly.co/public/mainnet \
///           forge test --match-contract TaxedTokenForkTest -vv
contract TaxedTokenForkTest is SkimForkFixture {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // The tax burn sink == VaultBurnPool == token.taxBurnAddress(): venue-tax
    // 111 accrues here, then is burned on each vault-path settle. These
    // mechanism tests never trigger a settle, so the sink balance accumulates
    // and `balanceOf(taxSink)` deltas measure exactly what the tax routed.
    address internal taxSink;
    uint16 internal constant TAX_BPS = 1500; // 15% launch rate (cap 2000/20%)
    uint256 internal constant TAX_DENOM = 10_000;

    TestSwapHelper internal swapper; // canonical buys (take→helper→forward)
    V4TaxKit internal kit; // direct-take buys + LP add/remove on any key
    V3TaxKit internal kit3; // mint + swap on a side Uniswap-V3 pool

    IArtCoinsTaxable internal tax;
    PoolKey internal canonicalKey;
    bytes32 internal canonicalPid; // cached so it isn't evaluated mid-prank

    address internal trader = address(0x77144E12);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(rpc);

        _runFullDeploy();

        tax = IArtCoinsTaxable(token);
        taxSink = address(vaultBurnPool);
        assertEq(tax.taxBurnAddress(), taxSink, "tax sink wired to VaultBurnPool");
        canonicalPid = tax.canonicalPoolId();
        canonicalKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 0x800000, // DYNAMIC_FEE_FLAG
            tickSpacing: 200,
            hooks: IHooks(deployedHook)
        });

        swapper = new TestSwapHelper(POOL_MANAGER, token, deployedHook, 0x800000, 200);
        kit = new V4TaxKit(POOL_MANAGER, token);
        kit3 = new V3TaxKit(token, WETH_ADDR);

        // Past the ~30-min MEV window so the skim is the static 6% baseline and
        // public LP adds aren't blocked by the hook's beforeAddLiquidity gate.
        vm.warp(block.timestamp + 90 minutes);
    }

    // ─── helpers ───────────────────────────────────────────────────────────

    /// @dev Buy `ethIn` of 111 on the canonical pool (exempt) and leave the
    ///      output with `to`. Uses the take→helper→forward path; the canonical
    ///      budget exempts the take, and the helper→`to` forward is a non-venue
    ///      sender so it's untaxed too.
    function _canonicalBuyTo(address to, uint256 ethIn) internal returns (uint256 out) {
        vm.deal(address(this), address(this).balance + ethIn);
        out = swapper.buyTokenWithEth{value: ethIn}(ethIn);
        // helper forwards to msg.sender (== address(this)); relay to `to`.
        if (to != address(this) && out > 0) {
            IERC20T(token).transfer(to, out);
        }
    }

    receive() external payable {}

    // ════════════════════════════════════════════════════════════════════
    //  1. Canonical buy — EXEMPT
    // ════════════════════════════════════════════════════════════════════

    function test_canonicalBuy_exempt() public {
        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        vm.deal(address(this), 2 ether);
        uint256 out = swapper.buyTokenWithEth{value: 1 ether}(1 ether);

        assertGt(out, 0, "got 111 from canonical buy");
        // The helper received the FULL pool output (exempt) and forwarded all of
        // it; if the take had been taxed, the helper could not have forwarded
        // `out` and this call would have reverted. Belt-and-suspenders: the burn
        // sink did not grow.
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "no burn on canonical buy");
        assertEq(IERC20T(token).balanceOf(address(this)), out, "caller holds full output");
    }

    /// @notice I-4: collecting the locker's LP fees on the tax-enabled pool does
    ///         NOT burn 111. The locker's fee-collect is a venue (PoolManager) →
    ///         exempt-locker 111 outflow, so the recipient receives the fees
    ///         un-burned. Accrue real 111-side LP fees (buy exempt, then sell —
    ///         the sell pays the LP fee on the 111 input), then collect and
    ///         assert BOTH no burn AND a non-zero amount flowed, so the test
    ///         cannot pass vacuously on zero accrued fees.
    function test_lockerFeeCollection_taxExempt() public {
        // The FeeAutoSwapper the locker escrows its LP fees into, read from the
        // same deployments.json the fixture's full deploy wrote.
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments.json"));
        address fas = vm.parseJsonAddress(json, ".feeAutoSwapper");

        // Past the ~30-min anti-sniper window so swaps run at the baseline skim.
        vm.warp(block.timestamp + 31 minutes);

        // Accrue 111-side LP fees in the locked positions: buy 111 (exempt) then
        // sell it back. The sell pays the LP fee on the 111 input, so the
        // locker's positions accrue 111-denominated fees — the exact fees whose
        // collection (a venue→locker 111 outflow) the tax could otherwise burn.
        for (uint256 i = 0; i < 3; i++) {
            uint256 pct = _canonicalBuyTo(address(this), 3 ether);
            IERC20T(token).approve(address(swapper), pct);
            swapper.sellTokenForEth(pct);
        }

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        uint256 accruedBefore = IFeeAutoSwapperView(fas).accruedArtCoin();

        // Collect: PoolManager (venue) → exempt locker → FeeAutoSwapper escrow.
        conversionLocker.collectRewards(token);

        assertEq(
            IERC20T(token).balanceOf(taxSink), sinkBefore,
            "tax burned 111 during locker fee collection"
        );
        assertGt(
            IFeeAutoSwapperView(fas).accruedArtCoin(), accruedBefore,
            "locker collected zero 111 LP fees (test would be vacuous)"
        );
    }

    // ════════════════════════════════════════════════════════════════════
    //  2. Canonical LP add + remove — EXEMPT (afterRemoveLiquidity attest)
    // ════════════════════════════════════════════════════════════════════

    function test_canonicalLpAddRemove_exempt() public {
        // Acquire 111 to LP with (canonical buy is exempt).
        uint256 pct = _canonicalBuyTo(address(this), 3 ether);
        assertGt(pct, 0, "have 111 to LP");

        // Add a 111-ONLY position BELOW the current tick (111 = currency1; a
        // range entirely below current price holds only currency1). Needs no
        // ETH. The kit settles exactly the owed 111 from its funded balance.
        (, int24 cur,,) = IPoolManager(POOL_MANAGER).getSlot0(canonicalKey.toId());
        int24 sp = 200;
        int24 upper = (cur / sp) * sp - 10 * sp; // safely below current
        int24 lower = upper - 30 * sp;
        int256 liq = 1e15; // small — needs well under 1 token at launch ticks

        IERC20T(token).transfer(address(kit), pct);
        kit.addLiquidity(canonicalKey, lower, upper, liq);

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        uint256 lpPctBefore = IERC20T(token).balanceOf(alice);

        // Remove the position, taking the 111 side to `alice` (a public LP, NOT
        // on the exempt allowlist). Without the afterRemoveLiquidity attestation
        // this 111 outflow from the PoolManager would be taxed.
        kit.removeLiquidity(canonicalKey, lower, upper, -liq, alice);

        uint256 received = IERC20T(token).balanceOf(alice) - lpPctBefore;
        assertGt(received, 0, "LP received 111 back on removal");
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "no burn on canonical LP removal");
    }

    // ════════════════════════════════════════════════════════════════════
    //  3. V4 SIDE-pool buy — TAXED
    // ════════════════════════════════════════════════════════════════════

    function test_v4SidePoolBuy_taxed() public {
        // A side V4 pool = same PoolManager, DIFFERENT pool id, hooks = 0, so no
        // canonical-budget attestation ⇒ the take is taxed.
        PoolKey memory sideKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        // Initialize at tick 0 (1:1) — a self-contained test pool; the price is
        // irrelevant, we only assert the buy is taxed. Seed a thick straddling
        // position so a small buy has clean slippage.
        IPoolManager(POOL_MANAGER).initialize(sideKey, TickMath.getSqrtPriceAtTick(int24(0)));

        // Seed the side pool with 111 (from an exempt canonical buy) + ETH.
        uint256 seed = _canonicalBuyTo(address(this), 3 ether);
        IERC20T(token).transfer(address(kit), seed);
        vm.deal(address(this), 30 ether);
        kit.addLiquidity{value: 30 ether}(sideKey, int24(-60_000), int24(60_000), int256(1e19));

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        uint256 traderBefore = IERC20T(token).balanceOf(trader);

        vm.deal(address(this), 1 ether);
        uint256 gross = kit.buyTo{value: 0.05 ether}(sideKey, 0.05 ether, trader);
        assertGt(gross, 0, "side pool produced output");

        uint256 traderGot = IERC20T(token).balanceOf(trader) - traderBefore;
        uint256 burned = IERC20T(token).balanceOf(taxSink) - sinkBefore;
        uint256 expectedTax = (gross * TAX_BPS) / TAX_DENOM;

        assertEq(burned, expectedTax, "side buy: 5% burned");
        assertEq(traderGot, gross - expectedTax, "side buy: trader gets net");
        assertGt(burned, 0, "side buy WAS taxed");
    }

    // ════════════════════════════════════════════════════════════════════
    //  4. Precomputed Uniswap V2 buy — TAXED (validates venue derivation)
    // ════════════════════════════════════════════════════════════════════

    function test_precomputedV2Buy_taxed() public {
        address UNIV2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
        address pair = IUniV2Factory(UNIV2_FACTORY).createPair(token, WETH_ADDR);

        // The token's CONSTRUCTOR-DERIVED venue set must already contain this
        // exact CREATE2 address — proving the precompute matches reality.
        assertTrue(tax.isTaxVenue(pair), "derived V2 pair address is a known venue");

        // Seed the pair: 111 (exempt canonical buy) + WETH.
        uint256 pct = _canonicalBuyTo(address(this), 4 ether);
        vm.deal(address(this), 10 ether);
        IWETH9(WETH_ADDR).deposit{value: 5 ether}();

        IERC20T(token).transfer(pair, pct);
        IWETH9(WETH_ADDR).transfer(pair, 5 ether);
        IUniV2Pair(pair).mint(address(this));

        // Buy 111 on the pair: send WETH in, swap out 111 to the trader.
        IWETH9(WETH_ADDR).deposit{value: 1 ether}();
        IWETH9(WETH_ADDR).transfer(pair, 1 ether);

        // Figure out which side is the art coin + a safe out amount from reserves.
        (uint112 r0, uint112 r1,) = IUniV2Pair(pair).getReserves();
        bool tokenIsToken0 = IUniV2Pair(pair).token0() == token;
        // crude constant-product out for ~1 WETH in against the 111 reserve, with
        // generous slippage headroom (we only assert "taxed", not exact amount).
        uint256 pctReserve = tokenIsToken0 ? r0 : r1;
        uint256 amountOut = pctReserve / 20; // ~5% of reserve, comfortably swappable

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        uint256 traderBefore = IERC20T(token).balanceOf(trader);

        if (tokenIsToken0) {
            IUniV2Pair(pair).swap(amountOut, 0, trader, "");
        } else {
            IUniV2Pair(pair).swap(0, amountOut, trader, "");
        }

        uint256 traderGot = IERC20T(token).balanceOf(trader) - traderBefore;
        uint256 burned = IERC20T(token).balanceOf(taxSink) - sinkBefore;
        uint256 expectedTax = (amountOut * TAX_BPS) / TAX_DENOM;

        assertEq(burned, expectedTax, "V2 buy: 5% burned");
        assertEq(traderGot, amountOut - expectedTax, "V2 buy: trader gets net");
        assertGt(burned, 0, "V2 buy WAS taxed");
    }

    // ════════════════════════════════════════════════════════════════════
    //  4b. EVERY precomputed venue matches the live factory (derivation proof)
    // ════════════════════════════════════════════════════════════════════

    /// @dev The token derives every side-pool address in its constructor from
    ///      `(factory, initCodeHash, counter[, fee])`. This creates the REAL
    ///      pool on each live factory and asserts the token already knows that
    ///      exact address — so a wrong factory / init-code-hash / deployer / fee
    ///      tier fails the suite here rather than silently shipping a venue that
    ///      taxes a nonexistent address while the real pool trades free. Pool
    ///      creation is local EVM (the fork only serves the cached factory
    ///      state), so creating all 44 is cheap.
    ///
    ///      Coverage = the full `_buildTaxConfig` matrix: {UniV2, Sushi, Cake}V2
    ///      × 4 counters, plus {UniV3, CakeV3} × 4 counters × 4 tiers. Both salt
    ///      formulas (V2 packed, V3 abi.encode), PancakeV3's separate PoolDeployer,
    ///      its 2500 (vs Uniswap's 3000) tier, and all four 111-vs-counter sort
    ///      orders are exercised.
    function test_precomputedVenues_allMatchLiveFactories() public {
        address USDC_ = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        address USDT_ = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
        address DAI_ = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
        address[4] memory counters = [WETH_ADDR, USDC_, USDT_, DAI_];

        // Factories (createPool is called on the V3 *factory*; for PancakeSwap V3
        // the factory deploys via its PoolDeployer, the address the token uses).
        address[3] memory v2Factories = [
            0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f, // Uniswap V2
            0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac, // SushiSwap V2
            0x1097053Fd2ea711dad45caCcc45EfF7548fCB362 // PancakeSwap V2
        ];
        address UNIV3 = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
        address CAKEV3 = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
        uint24[4] memory uniTiers = [uint24(100), 500, 3000, 10_000];
        uint24[4] memory cakeTiers = [uint24(100), 500, 2500, 10_000];

        uint256 proven;
        for (uint256 j = 0; j < 4; j++) {
            for (uint256 i = 0; i < 3; i++) {
                address pair = IUniV2Factory(v2Factories[i]).createPair(token, counters[j]);
                assertTrue(tax.isTaxVenue(pair), "V2 derived venue != live factory pair");
                proven++;
            }
            for (uint256 t = 0; t < 4; t++) {
                address up = IUniV3FactoryLike(UNIV3).createPool(token, counters[j], uniTiers[t]);
                assertTrue(tax.isTaxVenue(up), "UniV3 derived venue != live factory pool");
                address cp = IUniV3FactoryLike(CAKEV3).createPool(token, counters[j], cakeTiers[t]);
                assertTrue(tax.isTaxVenue(cp), "PancakeV3 derived venue != live factory pool");
                proven += 2;
            }
        }
        assertEq(proven, 44, "every enumerated venue proven against its live factory");
    }

    // ════════════════════════════════════════════════════════════════════
    //  5/6. Sells — UNTAXED + NON-REVERTING (into-pool leg, sender = trader)
    // ════════════════════════════════════════════════════════════════════

    function test_canonicalSell_untaxed() public {
        uint256 pct = _canonicalBuyTo(address(this), 2 ether);
        assertGt(pct, 0, "have 111 to sell");

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        IERC20T(token).approve(address(swapper), pct);
        uint256 ethOut = swapper.sellTokenForEth(pct);

        assertGt(ethOut, 0, "sell produced ETH");
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "sell into canonical not taxed");
    }

    function test_v2Sell_untaxed() public {
        address UNIV2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
        address pair = IUniV2Factory(UNIV2_FACTORY).createPair(token, WETH_ADDR);

        uint256 pct = _canonicalBuyTo(address(this), 4 ether);
        IWETH9(WETH_ADDR).deposit{value: 5 ether}();
        IERC20T(token).transfer(pair, pct / 2);
        IWETH9(WETH_ADDR).transfer(pair, 5 ether);
        IUniV2Pair(pair).mint(address(this));

        // Sell: transfer 111 INTO the pair (sender = this, NOT a venue) → no tax,
        // and the pair's K-check must still pass (the in-leg received in full).
        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        uint256 sellAmt = pct / 4;
        IERC20T(token).transfer(pair, sellAmt);

        (uint112 r0, uint112 r1,) = IUniV2Pair(pair).getReserves();
        bool tokenIsToken0 = IUniV2Pair(pair).token0() == token;
        // Out a tiny amount of WETH (well within K); we only assert no tax/no revert.
        uint256 wethReserve = tokenIsToken0 ? r1 : r0;
        uint256 wethOut = wethReserve / 100;
        if (tokenIsToken0) {
            IUniV2Pair(pair).swap(0, wethOut, address(this), "");
        } else {
            IUniV2Pair(pair).swap(wethOut, 0, address(this), "");
        }
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "sell into V2 not taxed");
    }

    // ════════════════════════════════════════════════════════════════════
    //  7/8. Wallet / contract sends — UNTAXED (sender not a venue)
    // ════════════════════════════════════════════════════════════════════

    function test_walletToWallet_untaxed() public {
        uint256 pct = _canonicalBuyTo(alice, 2 ether);
        assertGt(pct, 0, "alice has 111");

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        vm.prank(alice);
        IERC20T(token).transfer(bob, pct);

        assertEq(IERC20T(token).balanceOf(bob), pct, "bob got full amount");
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "wallet send not taxed");
    }

    function test_contractToContract_untaxed() public {
        MockWallet w = new MockWallet();
        uint256 pct = _canonicalBuyTo(address(w), 2 ether);
        assertGt(pct, 0, "wallet has 111");

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        w.send(token, bob, pct);

        assertEq(IERC20T(token).balanceOf(bob), pct, "bob got full amount");
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "contract send not taxed");
    }

    // ════════════════════════════════════════════════════════════════════
    //  9. PC adapters — EXEMPT even on a direct venue→adapter transfer
    // ════════════════════════════════════════════════════════════════════

    function test_pcAdapters_exempt() public {
        uint256 pct = _canonicalBuyTo(address(this), 2 ether);
        // Move 111 to the PoolManager so it can act as the venue sender.
        IERC20T(token).transfer(POOL_MANAGER, pct);

        // The exempt set is {BuybackBurner, conversion locker}. POLDepositor
        // was removed from the exempt set with the POL retirement.
        uint256 chunk = pct / 3;
        _assertVenueTransferExempt(address(burner), chunk);
        _assertVenueTransferExempt(deployedLocker, chunk);
    }

    function _assertVenueTransferExempt(address to, uint256 amt) internal {
        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        uint256 toBefore = IERC20T(token).balanceOf(to);
        vm.prank(POOL_MANAGER);
        IERC20T(token).transfer(to, amt);
        assertEq(IERC20T(token).balanceOf(to) - toBefore, amt, "exempt recipient got full");
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "exempt: nothing burned");
    }

    // ════════════════════════════════════════════════════════════════════
    //  10/11/12/13. Budget: hook-only, amount-pinned, wrong-pool, accumulate
    // ════════════════════════════════════════════════════════════════════

    function test_attest_hookOnly() public {
        bytes32 pid = canonicalPid;
        vm.prank(alice);
        vm.expectRevert(); // NotCanonicalHook
        tax.attestCanonicalBudget(pid, 1e18);

        // The deployed hook IS allowed (no revert).
        vm.prank(deployedHook);
        tax.attestCanonicalBudget(pid, 1e18);
    }

    function test_attest_amountPinned_andConsumed() public {
        uint256 pct = _canonicalBuyTo(address(this), 2 ether);
        IERC20T(token).transfer(POOL_MANAGER, pct);

        uint256 budget = pct / 2;
        bytes32 pid = canonicalPid;
        vm.prank(deployedHook);
        tax.attestCanonicalBudget(pid, budget);

        // A venue→trader transfer of exactly `budget` is fully exempt.
        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        vm.prank(POOL_MANAGER);
        IERC20T(token).transfer(trader, budget);
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "budgeted amount exempt");
        assertEq(IERC20T(token).balanceOf(trader), budget, "trader got full budgeted amount");

        // Budget now spent; a further venue→trader transfer IS taxed.
        uint256 more = pct / 4;
        uint256 tBefore = IERC20T(token).balanceOf(trader);
        vm.prank(POOL_MANAGER);
        IERC20T(token).transfer(trader, more);
        uint256 expectedTax = (more * TAX_BPS) / TAX_DENOM;
        assertEq(IERC20T(token).balanceOf(taxSink) - sinkBefore, expectedTax, "post-budget taxed");
        assertEq(IERC20T(token).balanceOf(trader) - tBefore, more - expectedTax, "net after budget");
    }

    function test_attest_wrongPoolId_ignored() public {
        uint256 pct = _canonicalBuyTo(address(this), 2 ether);
        IERC20T(token).transfer(POOL_MANAGER, pct);

        // Attest for a NON-canonical pool id → no budget granted.
        bytes32 wrong = keccak256("not the canonical pool");
        vm.prank(deployedHook);
        tax.attestCanonicalBudget(wrong, pct);

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        uint256 amt = pct / 2;
        vm.prank(POOL_MANAGER);
        IERC20T(token).transfer(trader, amt);
        uint256 expectedTax = (amt * TAX_BPS) / TAX_DENOM;
        assertEq(IERC20T(token).balanceOf(taxSink) - sinkBefore, expectedTax, "wrong-pool attest ignored -> taxed");
    }

    function test_budget_accumulatesWithinTx() public {
        uint256 pct = _canonicalBuyTo(address(this), 2 ether);
        IERC20T(token).transfer(POOL_MANAGER, pct);

        uint256 a = pct / 4;
        uint256 b = pct / 4;
        bytes32 pid = canonicalPid;
        vm.prank(deployedHook);
        tax.attestCanonicalBudget(pid, a);
        vm.prank(deployedHook);
        tax.attestCanonicalBudget(pid, b);

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        vm.prank(POOL_MANAGER);
        IERC20T(token).transfer(trader, a + b);
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "accumulated budget exempts the sum");
    }

    // ════════════════════════════════════════════════════════════════════
    //  14. Aggregator split — canonical leg exempt, side leg taxed (one tx)
    // ════════════════════════════════════════════════════════════════════

    function test_aggregatorSplit_canonExemptSideTaxed() public {
        uint256 pct = _canonicalBuyTo(address(this), 3 ether);
        IERC20T(token).transfer(POOL_MANAGER, pct);

        uint256 canonLeg = pct / 3; // the portion attested by the canonical leg
        uint256 sideLeg = pct / 3; // the portion routed through a side pool

        bytes32 pid = canonicalPid;
        vm.prank(deployedHook);
        tax.attestCanonicalBudget(pid, canonLeg);

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        // Canonical portion of the split → exempt (consumes the whole budget).
        vm.prank(POOL_MANAGER);
        IERC20T(token).transfer(alice, canonLeg);
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "canonical leg exempt");

        // Side portion in the same tx → taxed (budget already spent).
        vm.prank(POOL_MANAGER);
        IERC20T(token).transfer(bob, sideLeg);
        uint256 expectedTax = (sideLeg * TAX_BPS) / TAX_DENOM;
        assertEq(IERC20T(token).balanceOf(taxSink) - sinkBefore, expectedTax, "side leg taxed");
    }

    // ════════════════════════════════════════════════════════════════════
    //  15. Proceeds → burn sink (VaultBurnPool)
    // ════════════════════════════════════════════════════════════════════

    function test_proceeds_toBurnAddress() public {
        uint256 pct = _canonicalBuyTo(address(this), 2 ether);
        IERC20T(token).transfer(POOL_MANAGER, pct);

        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        uint256 amt = pct / 2;
        vm.prank(POOL_MANAGER);
        IERC20T(token).transfer(trader, amt);
        uint256 expectedTax = (amt * TAX_BPS) / TAX_DENOM;
        assertEq(IERC20T(token).balanceOf(taxSink) - sinkBefore, expectedTax, "tax landed in the burn sink");
    }

    // ════════════════════════════════════════════════════════════════════
    //  15b. Real side-pool trading → venue tax → BURNED on vault-path settle
    // ════════════════════════════════════════════════════════════════════
    //
    //  Full end-to-end on live `Deploy.s.sol` bytecode, once per venue family
    //  (V4 / V2 / V3): stand up a side pool, run a BATCH of real taxed buys on
    //  it (each a venue→non-exempt 111 outflow, so the tax fires and 111 accrues
    //  in VaultBurnPool), then silence a Punk (acquire → 72h return auction
    //  lapses with no bid → settle). The vault-path settle's `sweep` burns the
    //  ENTIRE accrued side-pool tax outright (real `token.burn`, totalSupply
    //  drops), in the same call that collects the trait — the realistic shape:
    //  side-pool tax accumulates across many trades and is burned in one batch
    //  when the protocol permanently collects a Punk.

    /// @dev Shared tail: silence a Punk and assert the vault-path settle burned
    ///      EXACTLY the 111 currently sitting in VaultBurnPool (the accrued
    ///      venue tax) — dropping totalSupply — in the same call that collects
    ///      the trait. The caller must have accrued a non-zero amount first.
    function _assertAccruedTaxBurnsOnSettle(string memory sellerLabel) internal {
        uint256 sinkPreSettle = IERC20T(token).balanceOf(address(vaultBurnPool));
        assertGt(sinkPreSettle, 0, "precondition: tax accrued in VaultBurnPool");
        uint256 supplyBefore = IERC20T(token).totalSupply();

        _fundPatronFromAdapter(1 ether);
        uint16 punkId = 0;
        address seller = makeAddr(sellerLabel);
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);

        vm.warp(block.timestamp + 72 hours + 1 minutes);
        vm.prank(makeAddr("settle-keeper"));
        finalSale.settle(punkId);

        assertEq((pc.collectedMask() >> target) & 1, 1, "vault-path settle collected the trait");
        assertEq(IERC20T(token).balanceOf(address(vaultBurnPool)), 0, "all accrued tax burned on settle");
        assertEq(IERC20T(token).totalSupply(), supplyBefore - sinkPreSettle, "totalSupply dropped by the burned tax");
    }

    /// @dev V4 side pool priced at the LIVE canonical price (~tens of millions
    ///      of 111 per ETH), so the taxed amounts are real-scale. Same
    ///      PoolManager, different pool id, hooks = 0 → no canonical attestation.
    function test_sidePoolTax_v4_realTrading_burnedOnSettle() public {
        PoolKey memory sideKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        _seedV4SidePoolAtCanonicalPrice(sideKey, 5 ether);

        // Trade a bunch — each buy is a taxed venue outflow into VaultBurnPool.
        uint256 sinkBefore = IERC20T(token).balanceOf(address(vaultBurnPool));
        uint256 expectedTax;
        for (uint256 i = 0; i < 5; i++) {
            address buyer = makeAddr(string.concat("v4-buyer-", vm.toString(i)));
            vm.deal(address(this), 1 ether);
            uint256 gross = kit.buyTo{value: 0.05 ether}(sideKey, 0.05 ether, buyer);
            assertGt(gross, 0, "v4 side buy produced output");
            expectedTax += (gross * TAX_BPS) / TAX_DENOM;
        }
        uint256 accrued = IERC20T(token).balanceOf(address(vaultBurnPool)) - sinkBefore;
        assertGt(accrued, 0, "v4 side trading accrued tax");
        assertEq(accrued, expectedTax, "v4: accrued == sum of per-buy tax");

        _assertAccruedTaxBurnsOnSettle("v4-sidepool-seller");
    }

    /// @dev Initialize `sideKey` at the live canonical price and seed it with
    ///      ~`ethDepth` ETH plus the matching 111 (bought exempt off canonical),
    ///      concentrated in a ±6000-tick band, via `LiquidityAmounts`. Leaves the
    ///      side pool priced like the real launch pool so trades move real-scale
    ///      token quantities.
    function _seedV4SidePoolAtCanonicalPrice(PoolKey memory sideKey, uint256 ethDepth) internal {
        uint256 tokenDepth = _canonicalBuyTo(address(this), 6 ether);
        (uint160 cSqrt, int24 cTick,,) = IPoolManager(POOL_MANAGER).getSlot0(canonicalKey.toId());
        IPoolManager(POOL_MANAGER).initialize(sideKey, cSqrt);
        IERC20T(token).transfer(address(kit), tokenDepth);
        int24 lower = ((cTick - 6000) / 60) * 60;
        int24 upper = ((cTick + 6000) / 60) * 60;
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            cSqrt, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), ethDepth, tokenDepth
        );
        vm.deal(address(this), ethDepth + 5 ether);
        kit.addLiquidity{value: ethDepth}(sideKey, lower, upper, int256(uint256(liq)));
    }

    /// @dev V2 side pool — a REAL Uniswap-V2 pair at the live CREATE2 venue.
    function test_sidePoolTax_v2_realTrading_burnedOnSettle() public {
        address UNIV2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
        address pair = IUniV2Factory(UNIV2_FACTORY).createPair(token, WETH_ADDR);
        assertTrue(tax.isTaxVenue(pair), "V2 pair is a known venue");

        // Seed: 111 (exempt canonical buy) + WETH, mint LP.
        uint256 seed = _canonicalBuyTo(address(this), 4 ether);
        vm.deal(address(this), 30 ether);
        IERC20T(token).transfer(pair, seed);
        IWETH9(WETH_ADDR).deposit{value: 10 ether}();
        IWETH9(WETH_ADDR).transfer(pair, 10 ether);
        IUniV2Pair(pair).mint(address(this));

        bool tokenIsToken0 = IUniV2Pair(pair).token0() == token;
        uint256 sinkBefore = IERC20T(token).balanceOf(address(vaultBurnPool));
        uint256 expectedTax;
        for (uint256 i = 0; i < 6; i++) {
            // Overpay WETH in, take a safe fraction of the current 111 reserve
            // out to a buyer (the venue→buyer outflow the token taxes).
            IWETH9(WETH_ADDR).deposit{value: 1 ether}();
            IWETH9(WETH_ADDR).transfer(pair, 1 ether);
            (uint112 r0, uint112 r1,) = IUniV2Pair(pair).getReserves();
            uint256 amountOut = (tokenIsToken0 ? r0 : r1) / 40; // ~2.5%, affordable for 1 WETH
            address buyer = makeAddr(string.concat("v2-buyer-", vm.toString(i)));
            if (tokenIsToken0) {
                IUniV2Pair(pair).swap(amountOut, 0, buyer, "");
            } else {
                IUniV2Pair(pair).swap(0, amountOut, buyer, "");
            }
            expectedTax += (amountOut * TAX_BPS) / TAX_DENOM;
        }
        uint256 accrued = IERC20T(token).balanceOf(address(vaultBurnPool)) - sinkBefore;
        assertGt(accrued, 0, "v2 side trading accrued tax");
        assertEq(accrued, expectedTax, "v2: accrued == sum of per-swap tax");

        _assertAccruedTaxBurnsOnSettle("v2-sidepool-seller");
    }

    /// @dev V3 side pool — a REAL Uniswap-V3 pool at the live CREATE2 venue,
    ///      priced at the live canonical price (WETH-paired; the 111/WETH tick
    ///      sign flips with the token↔WETH address ordering).
    function test_sidePoolTax_v3_realTrading_burnedOnSettle() public {
        address UNIV3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
        address pool = IUniV3FactoryLike(UNIV3_FACTORY).createPool(token, WETH_ADDR, 3000);
        assertTrue(tax.isTaxVenue(pool), "V3 pool is a known venue");

        // Price the WETH/111 pool at the canonical 111/ETH price. The canonical
        // tick is for ETH/111 (token1 = 111); for WETH/111 the sign inverts when
        // 111 sorts as token0.
        uint256 tokenDepth = _canonicalBuyTo(address(this), 6 ether);
        (, int24 cTick,,) = IPoolManager(POOL_MANAGER).getSlot0(canonicalKey.toId());
        bool tokenIsToken0 = token < WETH_ADDR;
        int24 mid = ((tokenIsToken0 ? -cTick : cTick) / 60) * 60;
        int24 lower = mid - 6000;
        int24 upper = mid + 6000;
        IUniV3Pool(pool).initialize(TickMath.getSqrtPriceAtTick(mid));

        // Fund the kit (111 + WETH) and mint a band straddling the price.
        IERC20T(token).transfer(address(kit3), tokenDepth);
        vm.deal(address(this), 20 ether);
        IWETH9(WETH_ADDR).deposit{value: 10 ether}();
        IWETH9(WETH_ADDR).transfer(address(kit3), 10 ether);
        uint256 wethDepth = 5 ether;
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            TickMath.getSqrtPriceAtTick(mid),
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            tokenIsToken0 ? tokenDepth : wethDepth,
            tokenIsToken0 ? wethDepth : tokenDepth
        );
        kit3.mintLiquidity(pool, lower, upper, liq);

        uint256 sinkBefore = IERC20T(token).balanceOf(address(vaultBurnPool));
        uint256 expectedTax;
        for (uint256 i = 0; i < 5; i++) {
            address buyer = makeAddr(string.concat("v3-buyer-", vm.toString(i)));
            uint256 gross = kit3.buyTokenTo(pool, buyer, 0.05 ether);
            assertGt(gross, 0, "v3 side buy produced output");
            expectedTax += (gross * TAX_BPS) / TAX_DENOM;
        }
        uint256 accrued = IERC20T(token).balanceOf(address(vaultBurnPool)) - sinkBefore;
        assertGt(accrued, 0, "v3 side trading accrued tax");
        assertEq(accrued, expectedTax, "v3: accrued == sum of per-swap tax");

        _assertAccruedTaxBurnsOnSettle("v3-sidepool-seller");
    }

    /// @dev REPORT (run with -vv): the per-trade split + the burn, at the real
    ///      launch price. Reuses the canonical-priced V4 side pool.
    function test_report_sidePoolTaxDistribution() public {
        console2.log("=== Side-pool transfer-tax distribution (V4 side pool @ canonical price, 15%) ===");
        PoolKey memory sideKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        _seedV4SidePoolAtCanonicalPrice(sideKey, 5 ether);

        uint256 nTrades = 5;
        uint256 totalGross;
        uint256 totalTax;
        uint256 totalNet;
        address[] memory buyers = new address[](nTrades);

        console2.log("");
        console2.log("Per-trade split (each buy spends 0.05 ETH):");
        for (uint256 i = 0; i < nTrades; i++) {
            address buyer = makeAddr(string.concat("report-buyer-", vm.toString(i)));
            buyers[i] = buyer;
            uint256 sinkB = IERC20T(token).balanceOf(address(vaultBurnPool));
            vm.deal(address(this), 1 ether);
            uint256 gross = kit.buyTo{value: 0.05 ether}(sideKey, 0.05 ether, buyer);
            uint256 taxed = IERC20T(token).balanceOf(address(vaultBurnPool)) - sinkB;
            uint256 net = IERC20T(token).balanceOf(buyer);
            assertEq(net + taxed, gross, "net + tax == gross");
            console2.log(string.concat("  trade #", vm.toString(i), "  gross 111 (wei):"), gross);
            console2.log("      tax  -> VaultBurnPool (wei):", taxed);
            console2.log("      net  -> buyer         (wei):", net);
            totalGross += gross;
            totalTax += taxed;
            totalNet += net;
        }

        console2.log("");
        console2.log(string.concat("Totals across ", vm.toString(nTrades), " trades:"));
        console2.log("  total gross 111 traded (wei):", totalGross);
        console2.log("  total tax -> VaultBurnPool   :", totalTax);
        console2.log("  total net  -> buyers         :", totalNet);
        console2.log("  total gross 111 (whole)      :", totalGross / 1e18);
        console2.log("  total tax   111 (whole)      :", totalTax / 1e18);
        console2.log("  realized tax rate      (bps) :", (totalTax * 10000) / totalGross);

        uint256 sinkPre = IERC20T(token).balanceOf(address(vaultBurnPool));
        uint256 supplyPre = IERC20T(token).totalSupply();
        console2.log("");
        console2.log("Before vault-path settle:");
        console2.log("  VaultBurnPool 111 (wei):", sinkPre);
        console2.log("  VaultBurnPool 111 (whole):", sinkPre / 1e18);
        console2.log("  token.totalSupply (wei):", supplyPre);

        _fundPatronFromAdapter(1 ether);
        uint16 punkId = 0;
        address seller = makeAddr("report-seller");
        _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(seller);
        patron.acceptBid(punkId, target, type(uint256).max);
        vm.warp(block.timestamp + 72 hours + 1 minutes);
        vm.prank(makeAddr("report-keeper"));
        finalSale.settle(punkId);

        uint256 supplyPost = IERC20T(token).totalSupply();
        console2.log("");
        console2.log("After vault-path settle (the silenced Punk's collection):");
        console2.log("  VaultBurnPool 111 (wei):", IERC20T(token).balanceOf(address(vaultBurnPool)));
        console2.log("  token.totalSupply (wei):", supplyPost);
        console2.log("  burned 111 (whole)     :", (supplyPre - supplyPost) / 1e18);

        assertEq(IERC20T(token).balanceOf(address(vaultBurnPool)), 0, "all accrued tax burned");
        assertEq(supplyPre - supplyPost, sinkPre, "supply dropped by exactly the burned tax");
        assertEq(totalTax, sinkPre, "accrued == sum of per-trade tax");
    }

    // ════════════════════════════════════════════════════════════════════
    //  16. Rate setter — two-key carve-out + bounds
    // ════════════════════════════════════════════════════════════════════

    function test_rate_bounds_and_twoKeyCarveOut() public {
        // Cache all view-call results so they aren't evaluated mid-prank (which
        // would consume the prank/expectRevert).
        TokenAdminPoker poker = _poker();
        address pokerOwner = poker.owner();
        uint16 overCap = tax.taxBpsMax() + 1;

        // Above parity cap -> revert (TaxBpsTooHigh bubbles up).
        vm.prank(pokerOwner);
        vm.expectRevert();
        poker.setTokenTaxBps(overCap);

        // Random caller -> NotAuthorized.
        vm.prank(alice);
        vm.expectRevert();
        poker.setTokenTaxBps(100);

        // Owner can lower the rate.
        vm.prank(pokerOwner);
        poker.setTokenTaxBps(100);
        assertEq(tax.taxBps(), 100, "owner lowered rate");

        // ProtocolAdmin EOA (the carve-out's second key) can also set it. The
        // fixture re-routed admin to address(this) in _loadDeployments.
        adminContract.transferAdmin(bob);
        vm.prank(bob);
        poker.setTokenTaxBps(0);
        assertEq(tax.taxBps(), 0, "ProtocolAdmin EOA set rate to 0");

        // With rate 0 the tax is inert: a venue→trader transfer is untaxed.
        uint256 pct = _canonicalBuyTo(address(this), 2 ether);
        IERC20T(token).transfer(POOL_MANAGER, pct);
        uint256 sinkBefore = IERC20T(token).balanceOf(taxSink);
        vm.prank(POOL_MANAGER);
        IERC20T(token).transfer(trader, pct / 2);
        assertEq(IERC20T(token).balanceOf(taxSink), sinkBefore, "rate 0 => no tax");
    }

    function _poker() internal view returns (TokenAdminPoker) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments.json"));
        return TokenAdminPoker(vm.parseJsonAddress(json, ".tokenAdminPoker"));
    }

    function _pokerOwner() internal view returns (address) {
        return _poker().owner();
    }

    // ════════════════════════════════════════════════════════════════════
    //  17. Dormant on a non-PC token (default-off; zero behavior change)
    // ════════════════════════════════════════════════════════════════════

    function test_dormant_onNonPcToken() public {
        // A token deployed with an EMPTY (default-off) TaxConfig — exactly what
        // the standard `deployToken` / `deployTokenWithProtocolBps` paths pass —
        // must report the tax fully OFF and never tax a venue-sender transfer.
        // Same bytecode as 111PUNKS; only the constructor config differs.
        TaxConfig memory off; // enabled = false, empty sets
        ArtCoinsToken plainTok =
            new ArtCoinsToken("Plain", "PLN", 1_000_000e18, address(this), "", "", "", address(0), off);
        IArtCoinsTaxable plain = IArtCoinsTaxable(address(plainTok));

        assertFalse(plain.taxEnabled(), "non-PC token: tax dormant");
        assertEq(plain.taxBps(), 0, "non-PC token: rate 0");
        assertEq(plain.canonicalPoolId(), bytes32(0), "non-PC token: no canonical pool");
        assertFalse(plain.isTaxVenue(POOL_MANAGER), "non-PC token: PoolManager not a venue");

        // The test holds the full supply (minted to msg.sender in the ctor).
        // Even a transfer FROM the PoolManager (a venue for PC's token) is a
        // plain, untaxed transfer here.
        uint256 amt = 1_000e18;
        uint256 sinkBefore = plainTok.balanceOf(taxSink);
        plainTok.transfer(POOL_MANAGER, amt);
        vm.prank(POOL_MANAGER);
        plainTok.transfer(trader, amt);
        assertEq(plainTok.balanceOf(trader), amt, "dormant: full amount");
        assertEq(plainTok.balanceOf(taxSink), sinkBefore, "dormant: nothing burned");
    }
}
