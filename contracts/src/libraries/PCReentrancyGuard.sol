// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  PCReentrancyGuard
/// @notice Mixin providing the classic same-call `nonReentrant` mutex shared
///         by the PC contracts that move funds through an external `.call`
///         (Patron, LiveBidAdapter, ReturnAuctionModule, PunkVaultTitleAuction).
///
///         This is the sibling of {PCNoReentry}: where `notInSwap` guards
///         against reentry from a synchronous extension's swap callback (the
///         dormant Design B path), `nonReentrant` guards against a payout
///         recipient re-entering the same contract within one transaction.
///         The two are orthogonal and both decorate the fund-moving entries.
///
/// @dev    Uses EIP-1153 transient storage (Cancun), matching {PCSwapContext}'s
///         existing `inSwap` flag. The lock auto-clears at end of transaction,
///         so there is no trailing SSTORE and no stuck-lock failure mode. The
///         slot is per-contract-address, so the four inheritors share the same
///         slot constant without colliding.
///
///         A single shared mutex inherited by all four fund-moving contracts.
abstract contract PCReentrancyGuard {
    error Reentrant();

    // ERC-7201-style derived slot; transient storage is scoped per contract
    // address, so a single shared constant is collision-free across inheritors.
    uint256 private constant _LOCK_SLOT =
        uint256(keccak256("permanentcollection.reentrancy.lock")) - 1;

    /// @notice Reverts if the decorated function is already on the call stack
    ///         in this transaction. Decorate every external entry point that
    ///         forwards ETH to an untrusted recipient via `.call`.
    modifier nonReentrant() {
        // Inline assembly only accepts literal-derived constants by value, so
        // read the slot into a local first. The local persists across `_`.
        uint256 slot = _LOCK_SLOT;
        uint256 locked;
        assembly ("memory-safe") {
            locked := tload(slot)
        }
        if (locked != 0) revert Reentrant();
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }
}
