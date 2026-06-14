// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  IPCSwapContext
/// @notice Read-only view of the cross-contract "in-swap" flag used by PC
///         contracts to detect callback reentry from `afterSwap`.
///
/// @dev    The flag lives in transient storage on `PCSwapContext`. It is
///         set by the (future) authorized extension before invoking
///         callbacks and cleared after. PC contracts decorated with
///         `PCNoReentry.notInSwap` revert if `inSwap() == true`.
interface IPCSwapContext {
    /// @notice Current state of the in-swap flag. Read by PC contracts'
    ///         `notInSwap` modifier on every gated external call.
    function inSwap() external view returns (bool);

    /// @notice The single address authorized to call `enterSwap` /
    ///         `exitSwap`. `address(0)` at launch — set later (one-shot
    ///         via the owner) when Design B's dispatcher is bound.
    function authorizedExtension() external view returns (address);

    /// @notice True once `lockAuthorizedExtension` has been called. After
    ///         that, `setAuthorizedExtension` reverts forever.
    function authorizedExtensionLocked() external view returns (bool);

    /// @notice Current owner. Permitted to call `setAuthorizedExtension`,
    ///         `lockAuthorizedExtension`, and `transferOwnership`.
    function owner() external view returns (address);
}
