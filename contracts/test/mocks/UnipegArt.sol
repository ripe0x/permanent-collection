// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

import {IPCCallbackExtension} from "../../src/interfaces/IPCCallbackExtension.sol";
import {
    PCSwapData,
    PCAttribution
} from "artcoins/hooks/interfaces/IArtCoinsHookSkimFee.sol";

/// @title  UnipegArt
/// @notice Demo callback extension. On every attributed swap, it derives a
///         "unipeg" — a 24-bit color palette index — from the swapper +
///         pool + block. Per-source counters and the latest unipeg color
///         per (source, swapper) are stored on-chain, demonstrating that
///         synchronous extensions CAN produce real on-chain state from
///         swap context without touching PC's protected state.
///
///         Inspired by Unipeg-style swap-generated art: every swap is its
///         own miniature mint, attributed to a `sourceId`. Indexers can
///         render the unipeg by reading `latestUnipeg[sourceId][swapper]`.
///
/// @dev    Constraints (per IPCCallbackExtension):
///           - Does NOT call back into PC contracts.
///           - Completes well within typical 100k gas budgets.
///           - Holds no ETH and exposes no withdrawal path.
///         The dispatcher invokes this via try/catch with a per-callback
///         gas budget, so even a buggy implementation here cannot revert
///         the underlying swap.
contract UnipegArt is IPCCallbackExtension {
    using PoolIdLibrary for PoolKey;

    /// @notice Emitted on every successful unipeg mint.
    /// @param sourceId  Builder-chosen attribution id from hookData.
    /// @param swapper   The trader (forwarded by the dispatcher; not the
    ///                  msg.sender of `onSwap`, which is the dispatcher).
    /// @param poolId    The pool id.
    /// @param unipeg    24-bit color (0xRRGGBB) derived deterministically
    ///                  from swap context.
    /// @param totalForSource  Cumulative unipegs minted under `sourceId`.
    event UnipegMinted(
        bytes32 indexed sourceId,
        address indexed swapper,
        PoolId  indexed poolId,
        uint24 unipeg,
        uint256 totalForSource
    );

    /// @notice Per-source unipeg count.
    mapping(bytes32 => uint256) public unipegsForSource;
    /// @notice Latest unipeg color per (source, address).
    mapping(bytes32 => mapping(address => uint24)) public latestUnipeg;

    /// @inheritdoc IPCCallbackExtension
    function onSwap(
        PoolKey calldata poolKey,
        SwapParams calldata swapParams,
        BalanceDelta delta,
        bytes calldata attribution
    ) external returns (bytes32) {
        // Decode the attribution wrapper. Bad encoding → no-op, return 0.
        if (attribution.length == 0) return bytes32(0);
        PCSwapData memory psd;
        try this.decode(attribution) returns (PCSwapData memory d) {
            psd = d;
        } catch {
            return bytes32(0);
        }
        bytes32 sourceId = psd.attribution.sourceId;
        // Even a referrer-less swap can mint a unipeg if it has a sourceId.
        if (sourceId == bytes32(0)) return bytes32(0);

        // Derive a unipeg color deterministically from swap + caller state.
        // Note: tx.origin is the actual swapper here because the dispatcher
        // → this contract chain doesn't pass through any indirection that
        // changes msg.sender's relationship to the trader. For demo
        // purposes we use tx.origin to identify the swapper.
        address swapper = tx.origin;
        uint24 unipeg = uint24(uint256(keccak256(abi.encode(
            sourceId,
            swapper,
            poolKey.toId(),
            swapParams.amountSpecified,
            swapParams.zeroForOne,
            delta,
            block.number
        ))));

        latestUnipeg[sourceId][swapper] = unipeg;
        uint256 total = ++unipegsForSource[sourceId];

        emit UnipegMinted(sourceId, swapper, poolKey.toId(), unipeg, total);
        return bytes32(uint256(unipeg));
    }

    /// @notice External helper for try-decoding `PCSwapData` from calldata.
    ///         Public so the same contract can `this.decode(...)` it inside
    ///         a try/catch.
    function decode(bytes calldata data) external pure returns (PCSwapData memory) {
        return abi.decode(data, (PCSwapData));
    }
}
