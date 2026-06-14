// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProtocolAdmin} from "./ProtocolAdmin.sol";

interface IRendererImpl {
    function tokenURI() external view returns (string memory);
    function tokenURI(uint256 id) external view returns (string memory);
    function svg() external view returns (string memory);
    /// @dev ERC-7572 contract-level metadata. The artcoins ERC20's
    ///      `_resolveURI()` calls this signature when a metadata renderer
    ///      is configured — without it the token falls back to its
    ///      built-in default URI builder and our on-chain art is never
    ///      surfaced.
    function contractURI(address token) external view returns (string memory);
}

/// @title  RendererRegistry
/// @notice Stable address fronting the protocol's renderer. The artcoins
///         factory and `PunkVault` both store this registry's address as
///         their immutable renderer reference, while the actual rendering
///         logic lives at `implementation` and can be swapped during the
///         admin window (or until `freeze()` is called) to fix display
///         bugs. After the admin role auto-locks OR `freeze()` is called,
///         the implementation is permanent.
///
/// @dev    The registry carries no funds and forwards every renderer call
///         to `implementation` via the standard external-call path. Worst-
///         case bad-faith admin: garbage strings. Cannot move ETH, cannot
///         move Punks, cannot affect any economic state.
contract RendererRegistry {
    error NotAdmin();
    error AlreadyFrozen();
    error ZeroAddress();
    /// @notice Reverts on `setImplementation` if the candidate address
    ///         has no contract code. Catches typos (EOAs, dead addresses)
    ///         before they brick `tokenURI`.
    error NotAContract();

    /// @notice Emitted at deployment and on each successful
    ///         `setImplementation`. `previous == address(0)` on the
    ///         construction event.
    event ImplementationUpdated(address indexed previous, address indexed next);
    /// @notice Emitted once when `freeze()` is called. After this,
    ///         `setImplementation` reverts forever.
    event Frozen(uint256 atBlock);

    /// @notice Admin role gating implementation updates. Uses the same
    ///         1-year heartbeat-renewable timer as the rest of the
    ///         protocol's mutable surfaces — `checkAdmin` returns false
    ///         once the timer expires or the role is burned.
    ProtocolAdmin public immutable adminContract;

    /// @notice The current renderer implementation. Updated by the admin
    ///         while the role is active and the registry is unfrozen.
    address public implementation;

    /// @notice True iff `freeze()` has been called. Once true, the
    ///         implementation is permanent regardless of admin state.
    bool public frozen;

    constructor(address _adminContract, address _initialImpl) {
        if (_adminContract == address(0) || _initialImpl == address(0)) revert ZeroAddress();
        adminContract = ProtocolAdmin(_adminContract);
        implementation = _initialImpl;
        emit ImplementationUpdated(address(0), _initialImpl);
    }

    /// @notice Update the renderer implementation. Restricted to the
    ///         current admin and only callable while the admin timer is
    ///         unexpired and the registry is not frozen.
    /// @dev    Guards against the two foot-guns worth a cheap on-chain
    ///         check: the zero address (`ZeroAddress`) and an EOA /
    ///         destroyed contract (`NotAContract`). A candidate that HAS
    ///         code but renders wrongly is not guarded against on-chain by
    ///         design: the registry moves no value, so a bad install only
    ///         reverts the forwarded views until the next
    ///         `setImplementation`, and that recoverability — not a
    ///         deploy-time interface probe — is the real bound. The launch
    ///         runbook verifies the live render before calling `freeze()`,
    ///         which is strictly stronger than a selector length-check a
    ///         contract returning two garbage words would pass anyway.
    function setImplementation(address newImpl) external {
        if (frozen) revert AlreadyFrozen();
        if (!adminContract.checkAdmin(msg.sender)) revert NotAdmin();
        if (newImpl == address(0)) revert ZeroAddress();
        if (newImpl.code.length == 0) revert NotAContract();
        address previous = implementation;
        implementation = newImpl;
        emit ImplementationUpdated(previous, newImpl);
    }

    /// @notice Permanently lock the implementation. One-way; cannot be
    ///         undone. Restricted to the current admin (so a stale admin
    ///         past timer expiry cannot freeze, but in that case
    ///         `setImplementation` is already locked too).
    function freeze() external {
        if (frozen) revert AlreadyFrozen();
        if (!adminContract.checkAdmin(msg.sender)) revert NotAdmin();
        frozen = true;
        emit Frozen(block.number);
    }

    /// @notice True iff the implementation is permanently locked — either
    ///         because `freeze()` was called explicitly, or because the
    ///         admin role is no longer exercisable for updates.
    function isLocked() external view returns (bool) {
        return frozen || adminContract.isLocked();
    }

    // ─────────────── pass-through views ───────────────

    /// @notice Forwarded zero-arg `tokenURI()` for the ERC20 (artcoins
    ///         factory consumes this signature).
    function tokenURI() external view returns (string memory) {
        return IRendererImpl(implementation).tokenURI();
    }

    /// @notice Forwarded `tokenURI(uint256)` for the ERC721 vault title.
    function tokenURI(uint256 id) external view returns (string memory) {
        return IRendererImpl(implementation).tokenURI(id);
    }

    /// @notice Forwarded raw SVG payload (no JSON wrapper).
    function svg() external view returns (string memory) {
        return IRendererImpl(implementation).svg();
    }

    /// @notice Forwarded ERC-7572 `contractURI(address)`. The artcoins
    ///         ERC20 calls this on its configured metadata renderer to
    ///         resolve both its own `contractURI()` and zero-arg
    ///         `tokenURI()` — wiring this signature is what hooks our
    ///         on-chain art into the token's metadata at all.
    function contractURI(address token) external view returns (string memory) {
        return IRendererImpl(implementation).contractURI(token);
    }
}
