// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Tiny mixin that captures the deployer at construction and
///         provides a one-time setup gate. After `_markFinalized()` is
///         called, no future `onlySetup`-gated calls can land — even from
///         the original deployer.
///
///         Used by every protocol contract that has post-construction
///         "wiring" (PermanentCollection, Patron, BuybackBurner) to
///         atomically bind addresses that would create
///         a constructor cycle if hard-coded as `immutable` (e.g. Patron
///         needs PermanentCollection's address; PermanentCollection needs
///         Patron's). The deployer fills these slots in a follow-up tx,
///         then `_markFinalized()` permanently revokes its own privilege.
///
/// @dev Pattern of use, illustrated for `Patron`:
///        1. constructor() sets the immutable refs that DON'T cycle
///           (PunksMarket, PunksData, ProtocolAdmin).
///        2. deployer calls `setWiring(pc, fsm)` (onlySetup-gated).
///        3. setWiring stores `pc`, `fsm`, then calls `_markFinalized()`.
///        4. Any future call to setWiring reverts AlreadyFinalized; any
///           other onlySetup-gated function (none exists in Patron, but
///           there could be) also reverts.
abstract contract OneTimeSetup {
    /// @notice Thrown when an onlySetup-gated call comes from any
    ///         address other than the deployer captured at construction.
    error NotDeployer();
    /// @notice Thrown when an onlySetup-gated call lands after
    ///         `_markFinalized()` has already been invoked. The setup
    ///         gate is one-shot.
    error AlreadyFinalized();

    /// @dev Deployer captured at construction time. Used as the sole
    ///      authorized caller of onlySetup-gated functions until the
    ///      finalize bit flips.
    address internal immutable _deployer;
    /// @dev Setup-gate flag. Flipped once via `_markFinalized()`,
    ///      monotonic thereafter — never resets.
    bool internal _finalized;

    /// @notice Emitted exactly once, when `_markFinalized()` is called.
    ///         After this event the contract's setup surface is
    ///         permanently closed.
    event Finalized();

    constructor() {
        _deployer = msg.sender;
    }

    /// @dev Guard for one-shot wiring setters. Reverts if the caller is
    ///      not the original deployer OR the contract has already been
    ///      finalized. Subclasses MUST call `_markFinalized()` from the
    ///      same function (or chain of functions) so the gate closes
    ///      after the wiring completes.
    modifier onlySetup() {
        if (msg.sender != _deployer) revert NotDeployer();
        if (_finalized) revert AlreadyFinalized();
        _;
    }

    /// @dev Permanently closes the setup gate. After this is called, every
    ///      `onlySetup`-gated function reverts forever. Subclasses call
    ///      this from their final wiring function (typically `setWiring`
    ///      or `setup`).
    function _markFinalized() internal {
        _finalized = true;
        emit Finalized();
    }

    /// @notice Whether `_markFinalized()` has been called. Useful for
    ///         off-chain tooling to confirm a contract's setup phase is
    ///         closed before treating its wiring as permanent.
    function setupFinalized() external view returns (bool) {
        return _finalized;
    }
}
