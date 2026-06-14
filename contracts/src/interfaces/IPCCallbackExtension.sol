// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @title  IPCCallbackExtension
/// @notice Builder-facing callback interface invoked by a PC dispatcher
///         during the official PC pool's `afterSwap`. Canonical interface
///         for Design B — implement this and register on `PCDispatcher`
///         (or the `UnipegDispatcher` demo) to receive a per-swap
///         notification on the bound pool.
///
///         **Contract:** the dispatcher invokes `onSwap` inside a try/catch
///         block with a per-callback gas budget. Reverts and gas-overruns
///         are isolated — they never break the underlying swap, and
///         persistent failures auto-disable the slot.
///
///         **Constraints (enforced by the dispatcher's reentrancy guard):**
///           - MUST NOT call any PC contract (Patron, ReturnAuctionModule,
///             BuybackBurner, etc.). PC contracts revert via the
///             `notInSwap` modifier when `PCSwapContext.inSwap() == true`.
///           - MUST complete within the dispatcher's per-slot gas budget.
///           - MUST NOT expect to receive ETH from the dispatcher — callbacks
///             have no fund custody.
///           - SHOULD be defensive about `attribution` content: it can be
///             empty, malformed, or attacker-controlled.
interface IPCCallbackExtension {
    /// @param poolKey The pool the swap happened on.
    /// @param params  The swap params.
    /// @param delta   Balance delta produced by the swap (post-skim).
    /// @param attribution The raw `poolExtensionSwapData` bytes the hook
    ///        forwarded to the dispatcher (typically an ABI-encoded
    ///        `PCSwapData` struct). The dispatcher does not decode it;
    ///        the callback is responsible for parsing whatever it cares
    ///        about.
    /// @return result Opaque per-callback return value (logged by the
    ///         dispatcher).
    function onSwap(
        PoolKey calldata poolKey,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata attribution
    ) external returns (bytes32 result);
}
