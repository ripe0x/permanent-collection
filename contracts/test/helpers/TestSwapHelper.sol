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

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// @notice Test-only V4 swap helper for the native-ETH-paired 111PUNKS pool. Lets
///         test code drive ETH↔token swaps outside the protocol's
///         BuybackBurner so we can simulate organic trading volume. Models
///         the V4 PoolManager `unlock` pattern the protocol uses internally,
///         settling the ETH side with native value (no WETH wrap).
///
/// @dev    Native-ETH = `address(0)`, the lowest possible address, so it
///         always sorts as currency0. The artcoin is currency1.
///         Buy path: caller sends ETH via msg.value, helper settles with
///         native value, takes token, transfers to caller.
///         Sell path: caller approves token, helper transfers tokens to PM,
///         takes ETH, forwards to caller.
contract TestSwapHelper is IUnlockCallback {
    IPoolManager public immutable pm;
    address public immutable token;
    address public immutable hook;
    uint24 public immutable poolFee;
    int24  public immutable poolTickSpacing;

    constructor(
        address _pm, address _token, address _hook,
        uint24 _fee, int24 _ts
    ) {
        pm = IPoolManager(_pm);
        token = _token; hook = _hook;
        poolFee = _fee; poolTickSpacing = _ts;
    }

    receive() external payable {}

    /// @notice Buy `token` with exact `ethIn` wei. Caller MUST send msg.value
    ///         == ethIn. Token output is transferred to caller.
    function buyTokenWithEth(uint256 ethIn) external payable returns (uint256 tokenOut) {
        require(msg.value == ethIn, "TSH: send exact ETH");
        bytes memory data = abi.encode(uint8(0), ethIn, uint160(0));
        tokenOut = abi.decode(pm.unlock(data), (uint256));
        require(IERC20Min(token).transfer(msg.sender, tokenOut), "TSH: token xfer");
    }

    /// @notice Test/probe helper: buy `token` with ETH (zeroForOne, which moves
    ///         the pool toward higher FDV) until the price reaches
    ///         `sqrtPriceLimitX96` OR `ethBudget` is exhausted. Caller MUST send
    ///         msg.value == ethBudget; any unspent ETH is refunded. The bought
    ///         token is held by this helper (price-warp only — output discarded).
    ///         Returns the ETH actually spent.
    function buyTokenToPrice(uint256 ethBudget, uint160 sqrtPriceLimitX96)
        external
        payable
        returns (uint256 ethSpent)
    {
        require(msg.value == ethBudget, "TSH: send exact ETH");
        bytes memory data = abi.encode(uint8(2), ethBudget, sqrtPriceLimitX96);
        ethSpent = abi.decode(pm.unlock(data), (uint256));
        uint256 refund = ethBudget - ethSpent;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "TSH: refund");
        }
    }

    /// @notice Sell exact `tokenIn` token for ETH. Caller MUST have approved
    ///         this contract to pull `tokenIn`. ETH output transferred to
    ///         caller.
    function sellTokenForEth(uint256 tokenIn) external returns (uint256 ethOut) {
        require(IERC20Min(token).transferFrom(msg.sender, address(this), tokenIn), "TSH: pull");
        bytes memory data = abi.encode(uint8(1), tokenIn, uint160(0));
        ethOut = abi.decode(pm.unlock(data), (uint256));
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "TSH: send eth");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "TSH: not pm");
        (uint8 dir, uint256 amount, uint160 sqrtLimit) =
            abi.decode(data, (uint8, uint256, uint160));
        PoolKey memory key = _poolKey();

        if (dir == 0 || dir == 2) {
            // Buy token: pay ETH (currency0), receive token (currency1).
            // dir==0 → full buy to MIN price (exact input fully consumed);
            // dir==2 → warp buy, stops at `sqrtLimit` or when input exhausted.
            SwapParams memory params = SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: dir == 2 ? sqrtLimit : TickMath.MIN_SQRT_PRICE + 1
            });
            BalanceDelta delta = pm.swap(key, params, "");
            int256 d0 = int256(delta.amount0());
            int256 d1 = int256(delta.amount1());
            uint256 ethSpent = uint256(-d0);
            uint256 tokenReceived = uint256(d1);
            // Settle the ETH side with native value — no WETH wrap.
            pm.settle{value: ethSpent}();
            pm.take(Currency.wrap(token), address(this), tokenReceived);
            // dir==2 returns ETH spent (for warp accounting); dir==0 returns token.
            return abi.encode(dir == 2 ? ethSpent : tokenReceived);
        } else {
            // Sell token: pay token (currency1), receive ETH (currency0).
            SwapParams memory params = SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            });
            BalanceDelta delta = pm.swap(key, params, "");
            int256 d0 = int256(delta.amount0());
            int256 d1 = int256(delta.amount1());
            uint256 tokenSpent = uint256(-d1);
            uint256 ethReceived = uint256(d0);
            pm.sync(Currency.wrap(token));
            IERC20Min(token).transfer(address(pm), tokenSpent);
            pm.settle();
            // Take native ETH out of the pool — currency0 = address(0).
            pm.take(Currency.wrap(address(0)), address(this), ethReceived);
            return abi.encode(ethReceived);
        }
    }

    function _poolKey() internal view returns (PoolKey memory) {
        // Native ETH = address(0), sorts as currency0. Artcoin = currency1.
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: poolFee,
            tickSpacing: poolTickSpacing,
            hooks: IHooks(hook)
        });
    }
}
