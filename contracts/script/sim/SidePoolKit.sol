// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

/// @notice Test/simulation helpers for standing up + trading SIDE pools (V4,
///         V2, V3) of the 111 token, so a sim script can drive the venue-scoped
///         transfer tax and watch it accrue in `VaultBurnPool`. Not deployed to
///         mainnet. Mirrors the verified `TaxedTokenForkTest` kits; the repo
///         keeps sim helpers (this, `LocalSwapper`) separate from test helpers
///         by convention.

interface ISpkERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

interface IUniV2Factory {
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IUniV2Pair {
    function mint(address to) external returns (uint256 liquidity);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
}

interface IUniV3FactoryLike {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

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

/// @notice Stands up + trades a side V4 pool (native-ETH paired, hooks = 0 so
///         it earns no canonical budget → buys are taxed). The buy takes the
///         111 output DIRECTLY to `recipient` (the venue→recipient outflow the
///         token taxes).
contract SidePoolV4Kit is IUnlockCallback {
    IPoolManager public immutable pm;
    address public immutable token;

    constructor(address _pm, address _token) {
        pm = IPoolManager(_pm);
        token = _token;
    }

    receive() external payable {}

    // op 0 = buy(take→recipient); 1 = addLiquidity
    struct Job {
        uint8 op;
        PoolKey key;
        uint256 ethIn;
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
        require(msg.value == ethIn, "spk: send exact ETH");
        Job memory j;
        j.op = 0;
        j.key = key;
        j.ethIn = ethIn;
        j.recipient = recipient;
        grossOut = abi.decode(pm.unlock(abi.encode(j)), (uint256));
    }

    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liq) external payable {
        Job memory j;
        j.op = 1;
        j.key = key;
        j.tickLower = tickLower;
        j.tickUpper = tickUpper;
        j.liq = liq;
        pm.unlock(abi.encode(j));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "spk: not pm");
        Job memory j = abi.decode(data, (Job));

        if (j.op == 0) {
            BalanceDelta d = pm.swap(
                j.key,
                SwapParams({zeroForOne: true, amountSpecified: -int256(j.ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
                ""
            );
            uint256 ethSpent = uint256(uint128(-d.amount0()));
            uint256 tokenOut = uint256(uint128(d.amount1()));
            pm.settle{value: ethSpent}();
            pm.take(Currency.wrap(token), j.recipient, tokenOut);
            return abi.encode(tokenOut);
        } else {
            (BalanceDelta cd,) = pm.modifyLiquidity(
                j.key,
                ModifyLiquidityParams({tickLower: j.tickLower, tickUpper: j.tickUpper, liquidityDelta: j.liq, salt: bytes32(0)}),
                ""
            );
            int128 a0 = cd.amount0();
            int128 a1 = cd.amount1();
            if (a0 < 0) pm.settle{value: uint256(uint128(-a0))}();
            if (a1 < 0) {
                pm.sync(Currency.wrap(token));
                ISpkERC20(token).transfer(address(pm), uint256(uint128(-a1)));
                pm.settle();
            }
            return "";
        }
    }
}

/// @notice Stands up + trades a side Uniswap-V3 pool (WETH paired). Holds
///         111 + WETH (pre-funded) and pays the V3 mint/swap callbacks. A buy
///         takes the 111 output DIRECTLY to `recipient`; the pool's reported
///         output is the GROSS it transferred (the token's override splits it
///         into net + tax on the way out).
contract SidePoolV3Kit {
    address public immutable token;
    address public immutable weth;

    constructor(address _token, address _weth) {
        token = _token;
        weth = _weth;
    }

    function mintLiquidity(address pool, int24 tickLower, int24 tickUpper, uint128 amount) external {
        IUniV3Pool(pool).mint(address(this), tickLower, tickUpper, amount, abi.encode(pool));
    }

    function buyTokenTo(address pool, address recipient, uint256 wethIn) external returns (uint256 grossOut) {
        bool wethIsZero = IUniV3Pool(pool).token0() == weth;
        bool zeroForOne = wethIsZero; // sell WETH (input) for 111 (output)
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        (int256 a0, int256 a1) = IUniV3Pool(pool).swap(recipient, zeroForOne, int256(wethIn), limit, abi.encode(pool));
        grossOut = uint256(-(wethIsZero ? a1 : a0));
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "spk3: not pool");
        if (amount0Owed > 0) ISpkERC20(IUniV3Pool(pool).token0()).transfer(pool, amount0Owed);
        if (amount1Owed > 0) ISpkERC20(IUniV3Pool(pool).token1()).transfer(pool, amount1Owed);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "spk3: not pool");
        if (amount0Delta > 0) ISpkERC20(IUniV3Pool(pool).token0()).transfer(pool, uint256(amount0Delta));
        if (amount1Delta > 0) ISpkERC20(IUniV3Pool(pool).token1()).transfer(pool, uint256(amount1Delta));
    }
}
