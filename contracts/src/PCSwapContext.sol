// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPCSwapContext} from "./interfaces/IPCSwapContext.sol";

/// @title  PCSwapContext
/// @notice Reentrancy-detection registry shared across PC contracts. Exposes
///         a transient-storage `inSwap` flag that an authorized extension
///         sets before invoking callbacks during a swap's `afterSwap` and
///         clears after.
///
///         At launch the flag is permanently 0 (no extension is authorized).
///         The infrastructure is in place so that when a future synchronous
///         extension dispatcher ("Design B") is bound, PC contracts already
///         have reentrancy guards in place — no redeployment needed.
///
///         The contract has no funds and no behavior beyond the flag and the
///         one-way `authorizedExtension` lock. There is no upgrade path,
///         no withdrawal path, no admin path beyond the owner's three calls
///         (`setAuthorizedExtension`, `lockAuthorizedExtension`,
///         `transferOwnership`).
///
/// @dev    Uses EIP-1153 transient storage (Cancun). The slot is
///         `keccak256("pc.swap.context.inswap.v1")` — versioned so a future PC
///         redeployment could fork the slot if needed (though that should
///         never happen — the entire point of this contract is to outlive
///         PC's other contracts).
contract PCSwapContext is IPCSwapContext {
    error NotOwner();
    error NotAuthorizedExtension();
    error AuthorizedExtensionAlreadyLocked();
    error ZeroAddress();

    /// @notice Emitted at construction AND on every successful
    ///         `transferOwnership`.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    /// @notice Emitted on every successful `setAuthorizedExtension`.
    event AuthorizedExtensionSet(address indexed extension);
    /// @notice Emitted exactly once on `lockAuthorizedExtension`.
    event AuthorizedExtensionLocked();
    /// @notice Emitted on every `enterSwap` call. Useful for indexers
    ///         tracking which callbacks fire.
    event SwapEntered();
    /// @notice Emitted on every `exitSwap` call.
    event SwapExited();

    /// @dev Transient storage slot for the in-swap flag. Inline assembly's
    ///      `tstore`/`tload` only accept direct number literals for the slot
    ///      argument, so the slot value is hardcoded here as the precomputed
    ///      `uint256(keccak256("pc.swap.context.inswap.v1"))`. Transient
    ///      storage is per-contract and isolated from regular storage, so
    ///      the literal can't collide with anything.
    uint256 internal constant INSWAP_SLOT =
        0x73cf1eedb0a4268580de8fa7f84f1f2204a717a275f3cc2a008c02db44849f74;

    /// @inheritdoc IPCSwapContext
    address public override owner;
    /// @inheritdoc IPCSwapContext
    address public override authorizedExtension;
    /// @inheritdoc IPCSwapContext
    bool public override authorizedExtensionLocked;

    /// @param _owner  Initial owner. Expected to be the same key as
    ///                `TokenAdminPoker.owner` (the protocol launch key /
    ///                multisig). Must be non-zero.
    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    /// @notice Transfer ownership. Cannot transfer to `address(0)` — burning
    ///         the role would foreclose Design B's binding path. To
    ///         permanently disable, use `lockAuthorizedExtension` (which
    ///         freezes the binding regardless of owner state) and then
    ///         optionally transfer ownership to a dead-but-non-zero address.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Authorize an extension contract to set/clear the `inSwap`
    ///         flag. Re-callable until `lockAuthorizedExtension` freezes
    ///         the binding.
    /// @param  ext  The extension contract. Pass `address(0)` to revoke
    ///         (re-enabling future re-authorization until lock).
    function setAuthorizedExtension(address ext) external {
        if (msg.sender != owner) revert NotOwner();
        if (authorizedExtensionLocked) revert AuthorizedExtensionAlreadyLocked();
        authorizedExtension = ext;
        emit AuthorizedExtensionSet(ext);
    }

    /// @notice Permanently freeze the authorized extension binding. After
    ///         this call, `setAuthorizedExtension` reverts forever; the
    ///         current `authorizedExtension` value is locked in.
    function lockAuthorizedExtension() external {
        if (msg.sender != owner) revert NotOwner();
        if (authorizedExtensionLocked) revert AuthorizedExtensionAlreadyLocked();
        authorizedExtensionLocked = true;
        emit AuthorizedExtensionLocked();
    }

    /// @notice Set the in-swap flag. Only the currently-authorized extension
    ///         may call. Reverts if no extension is authorized (i.e. at
    ///         launch the flag can never be set).
    function enterSwap() external {
        address ext = authorizedExtension;
        if (ext == address(0) || msg.sender != ext) revert NotAuthorizedExtension();
        assembly { tstore(INSWAP_SLOT, 1) }
        emit SwapEntered();
    }

    /// @notice Clear the in-swap flag. Only the currently-authorized
    ///         extension may call.
    function exitSwap() external {
        address ext = authorizedExtension;
        if (ext == address(0) || msg.sender != ext) revert NotAuthorizedExtension();
        assembly { tstore(INSWAP_SLOT, 0) }
        emit SwapExited();
    }

    /// @inheritdoc IPCSwapContext
    function inSwap() external view override returns (bool v) {
        assembly { v := tload(INSWAP_SLOT) }
    }
}
