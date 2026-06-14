// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPCSwapContext} from "../interfaces/IPCSwapContext.sol";

/// @title  PCNoReentry
/// @notice Mixin that decorates external entry points with `notInSwap`,
///         a reentrancy guard that reverts if a synchronous extension's
///         `afterSwap` callback is currently in flight.
///
///         At launch the guard is inert — `PCSwapContext.inSwap()` is
///         always false because no extension is authorized to flip it.
///         When Design B's dispatcher is later bound and authorized, every
///         decorated function reverts on reentry from the callback.
///
/// @dev    Inheriting contracts MUST pass the `_swapContext` address to
///         this contract's constructor. The context is `immutable` — set
///         once, then frozen for the life of the contract.
///
///         Cost per call: one external view call → one TLOAD (~100 gas
///         with Cancun) + comparison. Negligible against typical PC
///         entry-point gas costs.
abstract contract PCNoReentry {
    error InSwap();

    IPCSwapContext internal immutable swapContext;

    /// @param _swapContext  The `PCSwapContext` address. Pass `address(0)`
    ///        to disable the guard entirely (test fixtures, non-PC pools).
    ///        Production deploys always pass a real `PCSwapContext` —
    ///        though its `inSwap()` flag stays false at launch because
    ///        no extension is authorized to flip it.
    constructor(address _swapContext) {
        swapContext = IPCSwapContext(_swapContext);
    }

    /// @notice Reverts if a swap callback is currently in flight. Decorate
    ///         every external state-mutating entry point on PC contracts
    ///         reachable from the artcoins hook's `afterSwap` path.
    modifier notInSwap() {
        // No-op when context isn't wired (test fixtures pass `address(0)`
        // for cheaper setUp; PC's production deploy always passes a real
        // context).
        if (address(swapContext) != address(0) && swapContext.inSwap()) revert InSwap();
        _;
    }
}
