// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IVaultBurnPool {
    /// @notice Called by `ReturnAuctionModule` on vault-path settlements. Forwards
    ///         the entire ETH balance to `BuybackBurner`. No-op if zero.
    function sweep() external returns (uint256 forwarded);
}
