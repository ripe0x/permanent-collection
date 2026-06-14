// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";

import {LocalSwapper} from "./sim/LocalSwapper.sol";
import {
    SidePoolV4Kit,
    SidePoolV3Kit,
    ISpkERC20,
    IUniV2Factory,
    IUniV2Pair,
    IUniV3FactoryLike,
    IUniV3Pool
} from "./sim/SidePoolKit.sol";

interface IWETH9 {
    function deposit() external payable;
    function transfer(address, uint256) external returns (bool);
}

/// @title  SimulateSidePoolTrading
/// @notice Local-fork simulation: stands up V4 + V2 + V3 SIDE pools of the 111
///         token (priced at the live canonical price) and runs a batch of real
///         buys on each. Every side-pool buy is a venue→non-exempt 111 outflow,
///         so the venue-scoped transfer tax fires and accrues 111 in
///         `VaultBurnPool` — which is burned on the next vault-path settle.
///
///         Spawned by `scripts/seed-acquisitions.ts` so the seeded fork has a
///         visible pile of accrued side-pool tax for the frontend, then an
///         ended-but-unsettled auction you can settle to watch it burn.
///
/// @dev    Not deployed to mainnet. Env:
///           SIDE_SWAPS      buys per venue (default 8)
///           SIDE_DEPTH_ETH  per-pool ETH/WETH depth in whole ETH (default 1)
///                           — the seed of 111 is bought (exempt) off canonical
///                           to match, so each canonical buy moves price by
///                           roughly this much.
contract SimulateSidePoolTrading is Script {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address constant V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    int24 constant CANON_TS = 200;
    uint24 constant DYNAMIC_FEE_FLAG = 0x800000;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant UNIV2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address constant UNIV3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    uint24 constant SIDE_FEE = 3000;
    int24 constant SIDE_TS = 60;
    int24 constant BAND = 6000; // ±tick band around the price for liquidity
    // LP-token recipient for the seeded V2 pair. Arbitrary EOA (anvil acct 0) —
    // the LP is never withdrawn; a forge script must NOT use `address(this)`.
    address constant LP_SINK = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    // Set in run(), read by the per-venue helpers (avoids stack-too-deep).
    address token;
    address vbp;
    LocalSwapper canon;
    SidePoolV4Kit v4kit;
    SidePoolV3Kit v3kit;
    uint160 cSqrt;
    int24 cTick;
    uint256 nSwaps;
    uint256 depth;

    function run() external {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments.json"));
        token = vm.parseJsonAddress(json, ".token");
        vbp = vm.parseJsonAddress(json, ".vaultBurnPool");
        address hook = vm.parseJsonAddress(json, ".hook");

        nSwaps = vm.envOr("SIDE_SWAPS", uint256(8));
        depth = vm.envOr("SIDE_DEPTH_ETH", uint256(1)) * 1 ether;

        // Read the live canonical price; all three side pools are priced at it.
        PoolKey memory canonKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: CANON_TS,
            hooks: IHooks(hook)
        });
        (cSqrt, cTick,,) = IPoolManager(V4_POOL_MANAGER).getSlot0(canonKey.toId());

        uint256 before = ISpkERC20(token).balanceOf(vbp);
        console2.log("=== side-pool trading: V4 + V2 + V3 (buys per venue):", nSwaps);
        console2.log("VaultBurnPool 111 before (whole):", before / 1e18);

        vm.startBroadcast();
        canon = new LocalSwapper(V4_POOL_MANAGER, token, hook, CANON_TS, DYNAMIC_FEE_FLAG);
        v4kit = new SidePoolV4Kit(V4_POOL_MANAGER, token);
        v3kit = new SidePoolV3Kit(token, WETH);

        _tradeV4();
        _tradeV2();
        _tradeV3();
        vm.stopBroadcast();

        uint256 nowBal = ISpkERC20(token).balanceOf(vbp);
        console2.log("VaultBurnPool 111 after  (whole):", nowBal / 1e18);
        console2.log("accrued side-pool tax 111 (whole):", (nowBal - before) / 1e18);
        console2.log("  (burned on the next vault-path settle; totalSupply drops by this)");
    }

    /// @dev Seed 111 (exempt canonical buy) to match `depth` ETH at the live
    ///      canonical price for a fresh side pool.
    function _seedToken() internal returns (uint256 amt) {
        amt = canon.buy{value: depth + 0.5 ether}(0); // 111 → broadcaster
    }

    function _buyer(uint8 venue, uint256 i) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("spk-buyer", venue, i)))));
    }

    // ── V4 side pool (native-ETH paired, hooks = 0) ────────────────────────
    function _tradeV4() internal {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: SIDE_FEE,
            tickSpacing: SIDE_TS,
            hooks: IHooks(address(0))
        });
        IPoolManager(V4_POOL_MANAGER).initialize(key, cSqrt);

        uint256 tokenDepth = _seedToken();
        ISpkERC20(token).transfer(address(v4kit), tokenDepth);
        int24 lower = ((cTick - BAND) / SIDE_TS) * SIDE_TS;
        int24 upper = ((cTick + BAND) / SIDE_TS) * SIDE_TS;
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            cSqrt, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), depth, tokenDepth
        );
        v4kit.addLiquidity{value: depth}(key, lower, upper, int256(uint256(liq)));

        for (uint256 i = 0; i < nSwaps; i++) {
            v4kit.buyTo{value: 0.05 ether}(key, 0.05 ether, _buyer(0, i));
        }
        console2.log("  V4 buys done:", nSwaps);
    }

    // ── V2 pair (real Uniswap-V2, WETH paired) ─────────────────────────────
    function _tradeV2() internal {
        address pair = IUniV2Factory(UNIV2_FACTORY).createPair(token, WETH);
        uint256 tokenDepth = _seedToken();
        ISpkERC20(token).transfer(pair, tokenDepth);
        IWETH9(WETH).deposit{value: depth}();
        IWETH9(WETH).transfer(pair, depth);
        IUniV2Pair(pair).mint(LP_SINK);

        bool tokenIsToken0 = IUniV2Pair(pair).token0() == token;
        for (uint256 i = 0; i < nSwaps; i++) {
            IWETH9(WETH).deposit{value: 0.2 ether}();
            IWETH9(WETH).transfer(pair, 0.2 ether);
            (uint112 r0, uint112 r1,) = IUniV2Pair(pair).getReserves();
            uint256 amountOut = (tokenIsToken0 ? uint256(r0) : uint256(r1)) / 40; // ~2.5%, affordable for 0.2 WETH
            if (tokenIsToken0) {
                IUniV2Pair(pair).swap(amountOut, 0, _buyer(1, i), "");
            } else {
                IUniV2Pair(pair).swap(0, amountOut, _buyer(1, i), "");
            }
        }
        console2.log("  V2 swaps done:", nSwaps);
    }

    // ── V3 pool (real Uniswap-V3, WETH paired) ─────────────────────────────
    function _tradeV3() internal {
        address pool = IUniV3FactoryLike(UNIV3_FACTORY).createPool(token, WETH, SIDE_FEE);
        bool tokenIsToken0 = token < WETH;
        int24 mid = ((tokenIsToken0 ? -cTick : cTick) / SIDE_TS) * SIDE_TS;
        int24 lower = mid - BAND;
        int24 upper = mid + BAND;
        IUniV3Pool(pool).initialize(TickMath.getSqrtPriceAtTick(mid));

        uint256 tokenDepth = _seedToken();
        ISpkERC20(token).transfer(address(v3kit), tokenDepth);
        IWETH9(WETH).deposit{value: depth + 2 ether}();
        IWETH9(WETH).transfer(address(v3kit), depth + 2 ether);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            TickMath.getSqrtPriceAtTick(mid),
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            tokenIsToken0 ? tokenDepth : depth,
            tokenIsToken0 ? depth : tokenDepth
        );
        v3kit.mintLiquidity(pool, lower, upper, liq);

        for (uint256 i = 0; i < nSwaps; i++) {
            v3kit.buyTokenTo(pool, _buyer(2, i), 0.05 ether);
        }
        console2.log("  V3 swaps done:", nSwaps);
    }
}
