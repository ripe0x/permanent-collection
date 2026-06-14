// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ForkFixtures} from "./helpers/ForkFixtures.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

/// @notice Mainnet-fork test that exercises the same Universal Router
///         buy and sell paths the frontend produces in
///         `app/lib/swap/v4-calldata.ts`. Encoding bugs would break the
///         deployed UI; this is the canonical "the calldata layout is
///         correct" check.
///
///         Buy: EOA calls `UniversalRouter.execute([V4_SWAP], [v4Input],
///         deadline)` with native ETH `msg.value`. V4_SWAP settles from
///         the router's incoming balance (msg.value flows through UR
///         into V4 PoolManager) and takes the bought token via TAKE_ALL.
///         UR's tail sweep delivers the token to the EOA.
///
///         Sell: EOA signs a Permit2 PermitSingle off-chain, then UR
///         execute([PERMIT2_PERMIT, V4_SWAP], …) pulls tokens via Permit2
///         and takes native ETH via TAKE_ALL. UR's tail sweep delivers
///         the ETH to the EOA.
contract SwapTest is ForkFixtures {
    // UNIVERSAL_ROUTER / PERMIT2 / POOL_MANAGER are inherited from the
    // FreshArtcoinsStack base now.

    // ─── UR commands ──────────────────────────────────────────────
    bytes1 constant CMD_PERMIT2_PERMIT = 0x0a;
    bytes1 constant CMD_V4_SWAP = 0x10;

    // ─── V4 router actions ────────────────────────────────────────
    bytes1 constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    bytes1 constant ACT_SETTLE = 0x0b;
    bytes1 constant ACT_SETTLE_ALL = 0x0c;
    bytes1 constant ACT_TAKE_ALL = 0x0f;

    // ─── Permit2 type hashes (from canonical Permit2 source) ──────
    bytes32 constant PERMIT_DETAILS_TYPEHASH = keccak256(
        "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );
    bytes32 constant PERMIT_SINGLE_TYPEHASH = keccak256(
        "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );

    uint160 constant MAX_UINT160 = type(uint160).max;

    // ─── Actor ────────────────────────────────────────────────────
    address internal traderAddr;
    uint256 internal traderKey;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();

        // Fresh EOA with a known PK so we can vm.sign for Permit2.
        (traderAddr, traderKey) = makeAddrAndKey("swap-trader");
        vm.deal(traderAddr, 100 ether);
    }

    // ─── Helpers ──────────────────────────────────────────────────

    struct ExactInputSingle {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    function _poolKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    /// @dev Mirrors `encodeV4SwapInput` in `app/lib/swap/v4-calldata.ts`.
    function _encodeV4SwapInput(
        bool zeroForOne,
        uint128 amountIn,
        uint128 amountOutMinimum,
        address inputCurrency,
        address outputCurrency,
        bool payerIsUser
    ) internal view returns (bytes memory) {
        bytes1 settleAction = payerIsUser ? ACT_SETTLE_ALL : ACT_SETTLE;
        bytes memory actions = abi.encodePacked(
            ACT_SWAP_EXACT_IN_SINGLE, settleAction, ACT_TAKE_ALL
        );

        // ExactInputSingleParams encoded as a single dynamic tuple —
        // matches viem's `encodeAbiParameters([{type:'tuple',…}], [obj])`
        // and what V4Router's CalldataDecoder expects (leading 0x20 offset
        // word).
        bytes memory swapParams = abi.encode(
            ExactInputSingle({
                poolKey: _poolKey(),
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                hookData: bytes("")
            })
        );

        bytes memory settleParams = payerIsUser
            ? abi.encode(inputCurrency, uint256(amountIn))
            : abi.encode(inputCurrency, uint256(amountIn), false);

        bytes memory takeParams = abi.encode(outputCurrency, uint256(amountOutMinimum));

        bytes[] memory subInputs = new bytes[](3);
        subInputs[0] = swapParams;
        subInputs[1] = settleParams;
        subInputs[2] = takeParams;

        return abi.encode(actions, subInputs);
    }

    /// @dev Mirrors `buildBuyCalldata`. Native ETH → token via single V4_SWAP.
    function _buildBuyCalldata(uint128 ethIn, uint128 minTokenOut)
        internal
        view
        returns (bytes memory commands, bytes[] memory inputs, uint256 value)
    {
        commands = abi.encodePacked(CMD_V4_SWAP);
        inputs = new bytes[](1);
        // currency0 = address(0) (native ETH); token = currency1.
        // ETH → token means zeroForOne = true.
        inputs[0] = _encodeV4SwapInput({
            zeroForOne: true,
            amountIn: ethIn,
            amountOutMinimum: minTokenOut,
            inputCurrency: address(0),
            outputCurrency: address(token),
            payerIsUser: false
        });
        value = ethIn;
    }

    /// @dev Mirrors `buildSellCalldata` with Permit2 signature.
    function _buildSellCalldata(
        uint128 tokenIn,
        uint128 minEthOut,
        PermitSingle memory permit,
        bytes memory signature
    ) internal view returns (bytes memory commands, bytes[] memory inputs, uint256 value) {
        commands = abi.encodePacked(CMD_PERMIT2_PERMIT, CMD_V4_SWAP);
        inputs = new bytes[](2);
        // PERMIT2_PERMIT input: abi.encode(PermitSingle tuple, signature bytes).
        inputs[0] = abi.encode(permit, signature);
        // Token → ETH means zeroForOne = false (currency1 → currency0).
        inputs[1] = _encodeV4SwapInput({
            zeroForOne: false,
            amountIn: tokenIn,
            amountOutMinimum: minEthOut,
            inputCurrency: address(token),
            outputCurrency: address(0),
            payerIsUser: true
        });
        value = 0;
    }

    /// @dev Sign a Permit2 PermitSingle off-chain, mirroring
    ///      `signTypedData` in `usePermit2SignSwap.ts`. Uses the
    ///      contract's live DOMAIN_SEPARATOR rather than reconstructing.
    function _signPermit(PermitSingle memory permit, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 detailsHash = keccak256(
            abi.encode(
                PERMIT_DETAILS_TYPEHASH,
                permit.details.token,
                permit.details.amount,
                permit.details.expiration,
                permit.details.nonce
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_SINGLE_TYPEHASH,
                detailsHash,
                permit.spender,
                permit.sigDeadline
            )
        );
        (bool ok, bytes memory ret) = PERMIT2.staticcall(
            abi.encodeWithSignature("DOMAIN_SEPARATOR()")
        );
        require(ok, "Permit2: DOMAIN_SEPARATOR failed");
        bytes32 domainSeparator = abi.decode(ret, (bytes32));
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _execute(
        address from,
        bytes memory commands,
        bytes[] memory inputs,
        uint256 value
    ) internal {
        uint256 deadline = block.timestamp + 600;
        vm.prank(from);
        (bool ok, bytes memory ret) = UNIVERSAL_ROUTER.call{value: value}(
            abi.encodeWithSignature(
                "execute(bytes,bytes[],uint256)",
                commands,
                inputs,
                deadline
            )
        );
        require(ok, _decodeRevert(ret));
    }

    function _executeExpectRevert(
        address from,
        bytes memory commands,
        bytes[] memory inputs,
        uint256 value
    ) internal {
        uint256 deadline = block.timestamp + 600;
        vm.prank(from);
        (bool ok, ) = UNIVERSAL_ROUTER.call{value: value}(
            abi.encodeWithSignature(
                "execute(bytes,bytes[],uint256)",
                commands,
                inputs,
                deadline
            )
        );
        require(!ok, "expected revert");
    }

    function _decodeRevert(bytes memory ret) internal pure returns (string memory) {
        if (ret.length < 68) return "UR.execute reverted (no reason)";
        assembly {
            ret := add(ret, 0x04)
        }
        return abi.decode(ret, (string));
    }

    // ─── Tests ────────────────────────────────────────────────────

    /// @notice Buy path: ETH → 111PUNKS via UR.execute([V4_SWAP], …).
    function test_buy_path_succeeds() public {
        uint128 ethIn = 0.1 ether;
        uint128 minOut = 0; // accept any output for the happy path

        uint256 tokenBefore = token.balanceOf(traderAddr);

        (bytes memory commands, bytes[] memory inputs, uint256 value) =
            _buildBuyCalldata(ethIn, minOut);
        _execute(traderAddr, commands, inputs, value);

        uint256 tokenAfter = token.balanceOf(traderAddr);
        assertGt(tokenAfter, tokenBefore, "buy did not increase token balance");
        // Trader should still have most of their ETH (just spent 0.1 + gas)
        assertLt(traderAddr.balance, 100 ether, "ETH not spent");
        assertGt(traderAddr.balance, 99 ether, "way too much ETH spent");
    }

    /// @notice Buy path: tight slippage triggers V4Router revert.
    function test_buy_revertsOnSlippage() public {
        uint128 ethIn = 0.1 ether;
        // Set an absurdly high minimum so the slippage check trips.
        uint128 minOut = type(uint128).max;

        (bytes memory commands, bytes[] memory inputs, uint256 value) =
            _buildBuyCalldata(ethIn, minOut);
        _executeExpectRevert(traderAddr, commands, inputs, value);
    }

    /// @notice Sell path: 111PUNKS → ETH via UR.execute([PERMIT2_PERMIT, V4_SWAP], …).
    ///         Trader has to buy first to acquire tokens to sell.
    function test_sell_path_succeeds() public {
        // 1) Buy some tokens to set up the sell.
        {
            (bytes memory commands, bytes[] memory inputs, uint256 value) =
                _buildBuyCalldata(0.5 ether, 0);
            _execute(traderAddr, commands, inputs, value);
        }

        uint256 tokenBalance = token.balanceOf(traderAddr);
        require(tokenBalance > 0, "trader has no tokens after buy");

        // 2) Defensively grant token → Permit2 allowance. Solady-style
        //    tokens auto-grant infinite allowance and this is effectively
        //    a no-op; for non-Solady tokens this is the canonical setup.
        vm.prank(traderAddr);
        token.approve(PERMIT2, type(uint256).max);

        // 3) Read live Permit2 nonce (always 0 for a fresh user/token/spender
        //    tuple, but reading is the canonical pattern the frontend uses).
        (bool ok, bytes memory ret) = PERMIT2.staticcall(
            abi.encodeWithSignature(
                "allowance(address,address,address)",
                traderAddr,
                address(token),
                UNIVERSAL_ROUTER
            )
        );
        require(ok, "Permit2.allowance failed");
        (, , uint48 nonce) = abi.decode(ret, (uint160, uint48, uint48));

        // 4) Build + sign PermitSingle.
        PermitSingle memory permit = PermitSingle({
            details: PermitDetails({
                token: address(token),
                amount: MAX_UINT160,
                expiration: uint48(block.timestamp + 30 days),
                nonce: nonce
            }),
            spender: UNIVERSAL_ROUTER,
            sigDeadline: block.timestamp + 30 minutes
        });
        bytes memory signature = _signPermit(permit, traderKey);

        // 5) Execute sell.
        uint128 sellAmount = uint128(tokenBalance / 2); // sell half
        uint256 ethBefore = traderAddr.balance;

        (bytes memory commands, bytes[] memory inputs, uint256 value) =
            _buildSellCalldata(sellAmount, 0, permit, signature);
        _execute(traderAddr, commands, inputs, value);

        // 6) Assertions.
        uint256 ethAfter = traderAddr.balance;
        assertGt(ethAfter, ethBefore, "sell did not increase ETH balance");
        uint256 tokenAfter = token.balanceOf(traderAddr);
        assertEq(tokenBalance - tokenAfter, sellAmount, "token balance decrement mismatch");
    }

    /// @notice Sell path: tight slippage triggers V4Router revert.
    function test_sell_revertsOnSlippage() public {
        // Buy first to have tokens.
        {
            (bytes memory commands, bytes[] memory inputs, uint256 value) =
                _buildBuyCalldata(0.5 ether, 0);
            _execute(traderAddr, commands, inputs, value);
        }

        uint256 tokenBalance = token.balanceOf(traderAddr);
        require(tokenBalance > 0, "trader has no tokens");

        vm.prank(traderAddr);
        token.approve(PERMIT2, type(uint256).max);

        (bool ok, bytes memory ret) = PERMIT2.staticcall(
            abi.encodeWithSignature(
                "allowance(address,address,address)",
                traderAddr,
                address(token),
                UNIVERSAL_ROUTER
            )
        );
        require(ok, "Permit2.allowance failed");
        (, , uint48 nonce) = abi.decode(ret, (uint160, uint48, uint48));

        PermitSingle memory permit = PermitSingle({
            details: PermitDetails({
                token: address(token),
                amount: MAX_UINT160,
                expiration: uint48(block.timestamp + 30 days),
                nonce: nonce
            }),
            spender: UNIVERSAL_ROUTER,
            sigDeadline: block.timestamp + 30 minutes
        });
        bytes memory signature = _signPermit(permit, traderKey);

        uint128 sellAmount = uint128(tokenBalance / 2);
        // Absurdly high minEthOut to trip the slippage gate.
        uint128 minEthOut = type(uint128).max;

        (bytes memory commands, bytes[] memory inputs, uint256 value) =
            _buildSellCalldata(sellAmount, minEthOut, permit, signature);
        _executeExpectRevert(traderAddr, commands, inputs, value);
    }
}
