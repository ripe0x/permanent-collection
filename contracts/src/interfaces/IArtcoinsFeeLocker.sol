// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice External interface for the artcoins fee escrow (V3 stack, with
///         native-ETH support). The artcoins LP locker doesn't pay reward
///         recipients directly; it routes fees through this escrow, which
///         holds them per-recipient and lets them claim later.
///
///         For native-ETH paired pools (`Currency.wrap(address(0))`), the
///         escrow holds native ETH for the recipient under the `address(0)`
///         token slot — claim with `claim(feeOwner, address(0))`. For
///         ERC20-paired pools (e.g. WETH), pass the token address as usual.
///         Permissionless to call.
interface IArtcoinsFeeLocker {
    /// @notice Pull all stored fees for `feeOwner` in `token` to `feeOwner`'s
    ///         address. Permissionless to call — anyone can claim a
    ///         recipient's balance.
    function claim(address feeOwner, address token) external;

    /// @notice Current claimable balance for (feeOwner, token).
    function feesToClaim(address feeOwner, address token) external view returns (uint256);
}
