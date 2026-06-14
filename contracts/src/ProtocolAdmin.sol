// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  ProtocolAdmin
/// @notice Time-locked admin role shared across the protocol's mutable
///         configuration surfaces. The admin's authority auto-expires after
///         `ADMIN_TIMER_DURATION` unless renewed by `transferAdmin`.
///
///         **Gated by `checkAdmin` (locks at the 1y expiry):**
///           - `LiveBidAdapter.setMaxSweepWei / setMinBlocksBetweenSweeps`
///           - `BuybackBurner.setMinBlocksBetweenSteps / setMaxStepWei`
///           - `RendererRegistry.setImplementation / freeze`
///
///         (`Patron`'s finder-fee parameters and
///         `ReturnAuctionModule.minBidIncrementBps` are protocol constants,
///         not admin-gated — see those contracts. `ReturnAuctionModule` holds
///         no admin reference at all.)
///
///         **Gated by raw `admin()` (does NOT lock at the 1y expiry — only
///         frozen by `transferAdmin(address(0))`):**
///           - `Patron.addAllowedSeller / removeAllowedSeller` — recognizing
///             new aligned peer protocols (PunkStrategy-style listing
///             contracts) is a forever requirement. 24h `ALLOWLIST_DELAY`
///             gives the community a detection window for hostile adds.
///
///         The adapter bounds live-bid growth directly via the
///         `setMaxSweepWei / setMinBlocksBetweenSweeps` rate-cap knobs, which
///         are `checkAdmin`-gated and lock at the 1y expiry like the rest of
///         the economic surface.
///
///         Funds and frozen economic parameters are unreachable post-lock.
///         The carve-outs above remain admin-mutable indefinitely unless
///         the role is burned.
///
/// @dev Design rules:
///       - Admin starts at the deployer-supplied address with a timer set to
///         `block.timestamp + ADMIN_TIMER_DURATION`.
///       - Calling `transferAdmin(newAdmin)` resets the timer to
///         `block.timestamp + ADMIN_TIMER_DURATION`. The user can transfer
///         to themselves (self-renewal) or to a new custodian (rotation).
///         Either way, the timer extends by another year.
///       - Calling `transferAdmin(address(0))` permanently burns the role —
///         no future admin actions are possible, even before the timer
///         would have expired. **Burning the role is also the only way to
///         permanently disable the raw-admin carve-outs**, and it is reachable
///         by the current admin at ANY time — including after the timer has
///         lapsed. Only renewals/rotations are time-gated; the burn path is
///         not, so the carve-outs always have an on-chain off-switch.
///       - Once the timer expires without renewal, the role auto-locks for
///         `checkAdmin`-gated functions: those revert thereafter. The
///         raw-admin carve-outs and the burn path stay reachable by the live
///         admin EOA until the role is burned.
///       - There is no way to extend the duration, raise it, or recover from a
///         missed deadline (a renewal requires an unexpired timer). Locks are
///         one-way.
contract ProtocolAdmin {
    error NotAdmin();
    error Locked();

    /// @notice Emitted on the initial admin assignment AND every subsequent
    ///         `transferAdmin(newAdmin)` call (when `newAdmin != 0`).
    /// @param previousAdmin Outgoing admin (or `address(0)` at construction).
    /// @param newAdmin Incoming admin (never `address(0)` on this event —
    ///                 burns use `AdminBurned` instead).
    /// @param newTimerExpires Fresh expiry timestamp (now + 1y).
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin, uint256 newTimerExpires);
    /// @notice Emitted on `transferAdmin(address(0))`. The admin role is
    ///         then permanently disabled — even allowlist edits stop.
    event AdminBurned(uint256 burnedAt);

    /// @notice One year, fixed at deploy. Not configurable.
    uint256 public constant ADMIN_TIMER_DURATION = 365 days;

    /// @notice Current admin EOA (or `address(0)` after burn).
    address public admin;
    /// @notice Unix timestamp at which the admin auto-locks. Reset by
    ///         `transferAdmin` (including self-transfer "heartbeat").
    uint256 public adminTimerExpires;
    /// @notice True iff `transferAdmin(address(0))` has been called. Once
    ///         set, the admin role is permanently disabled.
    bool public adminBurned;

    /// @param initialAdmin First admin. Cannot be `address(0)` — burning
    ///                     happens via `transferAdmin`, not at construction.
    constructor(address initialAdmin) {
        require(initialAdmin != address(0), "ProtocolAdmin: zero admin");
        admin = initialAdmin;
        adminTimerExpires = block.timestamp + ADMIN_TIMER_DURATION;
        emit AdminTransferred(address(0), initialAdmin, adminTimerExpires);
    }

    /// @notice Transfer the admin role. Renewals/rotations reset the 1-year
    ///         timer; pass `address(0)` to permanently burn the role.
    /// @dev    Self-transfer (newAdmin == admin) is allowed and acts as a
    ///         heartbeat that renews the timer without rotating custody.
    ///
    ///         **The burn path is NOT timer-gated.** Renewals and rotations
    ///         (`newAdmin != address(0)`) require the role to still be active —
    ///         once the timer lapses they revert `Locked()`. But burning
    ///         (`newAdmin == address(0)`) strictly *reduces* power, so it stays
    ///         reachable by the current admin at any time, including after a
    ///         missed heartbeat. This guarantees the raw-admin carve-outs
    ///         always have an on-chain off-switch — a post-lapse key compromise
    ///         can still be neutralised by burning the role.
    function transferAdmin(address newAdmin) external {
        if (msg.sender != admin) revert NotAdmin();
        // Only renewals/rotations are time-gated. Burning is always allowed:
        // it removes power, so locking it behind the timer would leave the
        // raw-admin carve-outs callable forever with no off-switch.
        if (newAdmin != address(0) && isLocked()) revert Locked();

        address previous = admin;
        admin = newAdmin;

        if (newAdmin == address(0)) {
            adminBurned = true;
            emit AdminBurned(block.timestamp);
        } else {
            adminTimerExpires = block.timestamp + ADMIN_TIMER_DURATION;
            emit AdminTransferred(previous, newAdmin, adminTimerExpires);
        }
    }

    /// @notice True if admin powers are no longer exercisable, either because
    ///         the role was burned or because the timer expired without renewal.
    /// @dev    Uses `>=` so the role locks at the exact `adminTimerExpires`
    ///         timestamp; admin actions land *strictly before* expiry.
    function isLocked() public view returns (bool) {
        return adminBurned || block.timestamp >= adminTimerExpires;
    }

    /// @notice Used by gated contracts: returns true iff `caller` is the
    ///         current admin and the role is still active.
    function checkAdmin(address caller) external view returns (bool) {
        return !isLocked() && caller == admin;
    }

    /// @notice Seconds remaining until the timer expires. Returns 0 if locked.
    function timeUntilLock() external view returns (uint256) {
        if (isLocked()) return 0;
        return adminTimerExpires - block.timestamp;
    }
}
