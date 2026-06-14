// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IArtcoinsFeeLocker} from "./interfaces/IArtcoinsFeeLocker.sol";
import {PCNoReentry} from "./libraries/PCNoReentry.sol";

/// @title  ProtocolFeePhaseAdapter
/// @notice Receives the protocol-fee leg (the non-bounty portion of the
///         hook's baseline skim — ~16.67% of the skim, i.e. ~1% of trade
///         volume) from `ArtCoinsHookSkimFee`, which deposits it into
///         `feeEscrow` under this adapter's address each swap
///         (`storeFeesNative` in `_flushAccruedSkim`). `sweep()` claims it
///         from the escrow and forwards it to the artcoins
///         `ProtocolFeeController`, which applies its treasury / LAYER-burn
///         split.
///
/// @dev    Permissionless, single forward target, no admin surface, no
///         setter, no withdrawal path.
contract ProtocolFeePhaseAdapter is PCNoReentry {
    // ─── errors ──────────────────────────────────────────────────────────

    error ZeroAddress();
    error ForwardFailed();

    // ─── events ──────────────────────────────────────────────────────────

    /// @notice Emitted on every successful forward to the controller.
    event Forwarded(address indexed recipient, uint256 amount);

    /// @notice Emitted when the escrow `claim` in `sweep()` reverts. Non-fatal:
    ///         `sweep()` still forwards whatever ETH is already on the adapter,
    ///         so a transient escrow issue never blocks forward progress.
    event ClaimFailed(address indexed feeEscrow);

    // ─── immutable wiring ────────────────────────────────────────────────

    /// @notice The artcoins `ProtocolFeeController` (PC's dedicated instance,
    ///         configured treasury / LAYER-burn). Receives the protocol-fee
    ///         leg on every sweep.
    address payable public immutable controller;

    /// @notice Artcoins fee escrow. The hook deposits the protocol-fee leg here
    ///         under this adapter's address (`storeFeesNative`); `sweep()` pulls
    ///         it via `claim` before forwarding. Same minimal interface
    ///         (`IArtcoinsFeeLocker`) LiveBidAdapter uses for its own claim.
    address public immutable feeEscrow;

    // ─── construction ────────────────────────────────────────────────────

    constructor(address payable controller_, address feeEscrow_, address _swapContext) PCNoReentry(_swapContext) {
        if (controller_ == address(0)) revert ZeroAddress();
        if (feeEscrow_ == address(0)) revert ZeroAddress();

        controller = controller_;
        feeEscrow = feeEscrow_;
    }

    // ─── inflow ──────────────────────────────────────────────────────────

    /// @notice Accept native-ETH from any source. Intentionally no-op:
    ///         distribution happens in `sweep` so the hook's per-swap
    ///         settle stays cheap and the re-entry surface stays minimal.
    ///         The hook does NOT push the protocol leg here — it deposits
    ///         it into `feeEscrow` under this adapter's address via
    ///         `storeFeesNative` in `_flushAccruedSkim`, and `sweep()`
    ///         claims it from the escrow before forwarding. This
    ///         `receive()` only catches direct/stray ETH sends.
    receive() external payable {}

    // ─── distribution ────────────────────────────────────────────────────

    /// @notice Forward the contract's ETH balance to the `ProtocolFeeController`.
    ///
    /// @dev    Permissionless. The hook deposits the protocol leg into
    ///         `feeEscrow` under this adapter on every swap (via
    ///         `storeFeesNative` in `_flushAccruedSkim`); `sweep` claims
    ///         that escrowed ETH first, then forwards the full balance to
    ///         `controller`. Any caller may invoke `sweep` to drain whatever's
    ///         accrued.
    ///
    ///         If the controller rejects the ETH, the call reverts and the
    ///         balance stays here for retry on the next `sweep` — we don't
    ///         silently strand ETH on a misbehaving recipient.
    function sweep() external notInSwap {
        try IArtcoinsFeeLocker(feeEscrow).claim(address(this), address(0)) {}
        catch {
            emit ClaimFailed(feeEscrow);
        }

        uint256 bal = address(this).balance;
        if (bal == 0) return;

        (bool ok,) = controller.call{value: bal}("");
        if (!ok) revert ForwardFailed();

        emit Forwarded(controller, bal);
    }
}
