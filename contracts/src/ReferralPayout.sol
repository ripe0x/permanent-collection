// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IReferralPayout} from "./interfaces/IReferralPayout.sol";

/// @title  ReferralPayout
/// @notice Pull-based payout ledger for per-swap referral payments. The
///         artcoins skim hook calls `notify(referrer)` with the referral
///         ETH attached; this contract increments `balances[referrer]`
///         and emits `ReferralCredited`. Referrers (or anyone on their
///         behalf) pull via `claim` / `claimFor`.
///
///         Isolated payout behavior keeps the hook's hot path simple and
///         gives indexers a single contract to watch for attribution
///         analytics. Per-swap context (sourceId, campaignId, swap volume)
///         is emitted by the hook's `SwapAttribution` event at swap time;
///         this contract's events are just bookkeeping.
///
/// @dev    No admin. No withdrawal-by-third-party path. No setters. The
///         only inbound ETH credit path is `notify` from the bound hook
///         — stray `receive` ETH is accepted but NOT credited to any
///         referrer (it stays in the contract, unclaimable).
///
///         `claim` uses a generous gas budget on the send (35k) so most
///         contract referrers can receive. A pathological referrer
///         contract that always reverts on receive will simply never
///         claim — their balance accumulates indefinitely (or until
///         they fix their receive handler). Funds are never lost; the
///         claim is idempotent on failure (balance reinstated).
contract ReferralPayout is IReferralPayout {
    error Unauthorized();
    error NothingToClaim();
    error TransferFailed();
    error ZeroAddress();

    /// @notice Gas budget for the per-claim send. Generous enough for
    ///         most contract receivers, capped to prevent unbounded grief.
    uint256 public constant CLAIM_GAS = 35_000;

    /// @inheritdoc IReferralPayout
    address public immutable override hook;

    /// @inheritdoc IReferralPayout
    mapping(address => uint256) public override balances;

    /// @param _hook The artcoins skim hook authorized to call `notify`.
    constructor(address _hook) {
        if (_hook == address(0)) revert ZeroAddress();
        hook = _hook;
    }

    /// @notice Stray-ETH catcher. Anyone can send ETH here directly; it
    ///         increases the contract's balance but is NOT credited to any
    ///         referrer and CANNOT be claimed. Intentional: prevents
    ///         accidental contributions from being mis-attributed; the
    ///         hook is the only authoritative source of credits.
    receive() external payable {}

    /// @inheritdoc IReferralPayout
    function notify(address referrer) external payable override {
        if (msg.sender != hook) revert Unauthorized();
        if (referrer == address(0) || msg.value == 0) return;
        balances[referrer] += msg.value;
        emit ReferralCredited(referrer, msg.value);
    }

    /// @inheritdoc IReferralPayout
    function claim() external override {
        _claim(msg.sender);
    }

    /// @inheritdoc IReferralPayout
    function claimFor(address referrer) external override {
        _claim(referrer);
    }

    function _claim(address referrer) internal {
        uint256 amt = balances[referrer];
        if (amt == 0) revert NothingToClaim();
        balances[referrer] = 0;
        (bool ok,) = referrer.call{value: amt, gas: CLAIM_GAS}("");
        if (!ok) {
            balances[referrer] = amt;
            revert TransferFailed();
        }
        emit ReferralClaimed(referrer, amt);
    }
}
