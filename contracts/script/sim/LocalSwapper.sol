// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @title  LocalSwapper
/// @notice **Test / simulation helper.** Mirrors `BuybackBurner`'s V4 swap
///         pattern but exposes both directions (ETH→111 and 111→ETH) so a
///         simulation script can generate trading volume. Not deployed to
///         mainnet.
///
/// @dev    The PC pool is **native-ETH-paired** (currency0 = address(0),
///         currency1 = token). No WETH wrap/unwrap — ETH is settled with
///         `poolManager.settle{value:}()` on buy and taken with
///         `poolManager.take(Currency.wrap(address(0)), ...)` on sell.
///         Same unlockCallback pattern as BuybackBurner / TestSwapHelper.
contract LocalSwapper is IUnlockCallback {
    error NotPoolManager();
    error InsufficientOutput(uint256 received, uint256 minOut);
    error TransferFailed();

    event Swapped(address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut);

    IPoolManager public immutable poolManager;
    address public immutable token;
    address public immutable hook;
    int24 public immutable tickSpacing;
    uint24 public immutable poolFee;

    constructor(
        address _poolManager,
        address _token,
        address _hook,
        int24 _tickSpacing,
        uint24 _poolFee
    ) {
        poolManager = IPoolManager(_poolManager);
        token = _token;
        hook = _hook;
        tickSpacing = _tickSpacing;
        poolFee = _poolFee;
    }

    receive() external payable {}

    /// @notice Buy the 111 token with `msg.value` ETH. Returns the amount received.
    function buy(uint256 minOut) external payable returns (uint256 pctOut) {
        require(msg.value > 0, "no ETH");
        bytes memory data = abi.encode(true, msg.value, minOut, msg.sender);
        bytes memory result = poolManager.unlock(data);
        pctOut = abi.decode(result, (uint256));
        emit Swapped(msg.sender, true, msg.value, pctOut);
    }

    /// @notice Sell `amountIn` of the 111 token for ETH. Caller must approve this
    ///         contract for `amountIn` first. Returns ETH amount received.
    function sell(uint256 amountIn, uint256 minOut) external returns (uint256 ethOut) {
        require(amountIn > 0, "no tokens");
        IERC20(token).transferFrom(msg.sender, address(this), amountIn);
        bytes memory data = abi.encode(false, amountIn, minOut, msg.sender);
        bytes memory result = poolManager.unlock(data);
        ethOut = abi.decode(result, (uint256));
        emit Swapped(msg.sender, false, amountIn, ethOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (bool isBuy, uint256 amountIn, uint256 minOut, address to) =
            abi.decode(data, (bool, uint256, uint256, address));

        PoolKey memory key = _poolKey();

        if (isBuy) {
            // ETH (currency0) → 111 (currency1). zeroForOne = true.
            SwapParams memory params = SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            });
            BalanceDelta delta = poolManager.swap(key, params, "");
            uint256 ethOwed = uint256(int256(-delta.amount0()));
            uint256 pctReceived = uint256(int256(delta.amount1()));

            // Settle native ETH with value — no WETH wrap.
            poolManager.settle{value: ethOwed}();
            // Take 111 out directly to the trader.
            poolManager.take(Currency.wrap(token), to, pctReceived);

            if (pctReceived < minOut) revert InsufficientOutput(pctReceived, minOut);
            return abi.encode(pctReceived);
        } else {
            // 111 (currency1) → ETH (currency0). zeroForOne = false.
            SwapParams memory params = SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            });
            BalanceDelta delta = poolManager.swap(key, params, "");
            uint256 pctOwed = uint256(int256(-delta.amount1()));
            uint256 ethReceived = uint256(int256(delta.amount0()));

            // Pay 111 in.
            poolManager.sync(Currency.wrap(token));
            IERC20(token).transfer(address(poolManager), pctOwed);
            poolManager.settle();
            // Take native ETH out — currency0 = address(0). Delivered to
            // this contract first (need to forward), since `to` might not
            // be payable from a `take` perspective (it always is for EOAs;
            // this kept for parity with TestSwapHelper).
            poolManager.take(Currency.wrap(address(0)), address(this), ethReceived);
            (bool ok,) = to.call{value: ethReceived}("");
            if (!ok) revert TransferFailed();

            if (ethReceived < minOut) revert InsufficientOutput(ethReceived, minOut);
            return abi.encode(ethReceived);
        }
    }

    function _poolKey() internal view returns (PoolKey memory) {
        // Native ETH = address(0) sorts first → currency0. Token = currency1.
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: poolFee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hook)
        });
    }
}
