// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  IPreSwapStream
/// @notice Minimal interface for a fee recipient that streams its buffered
///         balance onward at the start of a swap. The artcoins hook calls
///         `streamForward()` on the configured live-bid recipient inside
///         `_beforeSwap` (via try/catch, so it can never brick a swap), so the
///         live bid advances per-swap from PRIOR swaps' accrued pending.
///
///         Implementations MUST be safe to call mid-`_beforeSwap` (no
///         re-entry into the PoolManager) and MUST NOT revert in a way that
///         bricks the swap — a no-op return is the correct response to "not
///         worth forwarding yet" (dust floor) or "rate-limited" (cooldown).
interface IPreSwapStream {
    /// @notice Forward buffered funds onward. Returns the amount forwarded
    ///         (0 on a no-op). Implementations should be reward-free on this
    ///         path (the caller is the hook, not a keeper).
    function streamForward() external returns (uint256 forwarded);
}
