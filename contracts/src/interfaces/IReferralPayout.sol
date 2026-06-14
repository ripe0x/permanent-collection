// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  IReferralPayout
/// @notice Interface for the per-referrer payout contract. The artcoins
///         skim hook forwards referral ETH here via `notify`; referrers
///         (or anyone on their behalf) claim accumulated balances via
///         `claim` / `claimFor`.
interface IReferralPayout {
    /// @notice Credit `msg.value` to `referrer`'s balance. Only the bound
    ///         hook may call. The hook is responsible for ensuring
    ///         `referrer != address(0)` and `msg.value > 0`; the contract
    ///         silently no-ops on zero inputs as defense in depth.
    /// @param  referrer  The address to credit.
    function notify(address referrer) external payable;

    /// @notice Pull the caller's accumulated balance. Reverts if zero or
    ///         if the transfer to `msg.sender` fails (balance reinstated
    ///         on failure).
    function claim() external;

    /// @notice Pull `referrer`'s accumulated balance, sending it to
    ///         `referrer` (not to `msg.sender`). Anyone may trigger this
    ///         on behalf of any referrer. Reverts if zero or if the
    ///         transfer fails.
    function claimFor(address referrer) external;

    /// @notice Per-referrer claimable balance.
    function balances(address referrer) external view returns (uint256);

    /// @notice The bound hook. Immutable.
    function hook() external view returns (address);

    /// @notice Emitted on every `notify` from the hook.
    event ReferralCredited(address indexed referrer, uint256 amount);
    /// @notice Emitted on every successful `claim` / `claimFor`.
    event ReferralClaimed(address indexed referrer, uint256 amount);
}
