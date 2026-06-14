// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IReturnAuctionModule {
    /// @notice Called by Patron immediately after it has transferred the Punk
    ///         to this contract. Records the acquisition cost and starts the
    ///         72h return auction.
    /// @dev    Reserve is derived from `acquisitionCost` and the per-trait
    ///         `previousAttempts` count (the value of
    ///         `PermanentCollection.attemptCount(targetTraitId)` BEFORE this
    ///         acquisition is recorded):
    ///         `reserve = acquisitionCost × (101 + previousAttempts) / 100`
    ///         so the first attempt requires a 1% premium and each subsequent
    ///         attempt against the same trait adds another 1%.
    function startSale(uint16 punkId, uint128 acquisitionCost, uint8 targetTraitId) external;
}
