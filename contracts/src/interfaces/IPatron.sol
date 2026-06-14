// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPatron {
    // ──────────────── Entry points ────────────────

    /// @notice Accept the live bid for `punkId`. The Punk's owner MUST have
    ///         listed it EXCLUSIVELY to this contract at a real price via
    ///         `offerPunkForSaleToAddress(punkId, price, patron)` on the 2017
    ///         CryptoPunks market, with `price` set to ~the current
    ///         `bidBalance`. Anyone may then call this; the contract buys the
    ///         Punk at the listed price and the seller collects that price from
    ///         the market with `withdraw()`. The listed price must be positive,
    ///         at or below the live bid, and at or below `expectedListingWei`
    ///         (the caller's overpay cap).
    /// @dev    Reverts with `TargetTraitPending` if a return auction is already
    ///         live for `targetTraitId` — only one in-flight attempt per
    ///         uncollected trait is permitted.
    function acceptBid(uint16 punkId, uint8 targetTraitId, uint256 expectedListingWei) external;

    /// @notice Permissionless: accept any eligible Punk currently listed
    ///         publicly by an allowlisted seller for `minValue ≤ bidBalance`.
    ///         The protocol buys the Punk at the seller's listed price and the
    ///         caller earns a small finder fee.
    /// @dev    Reverts with `TargetTraitPending` if a return auction is already
    ///         live for `targetTraitId`.
    function acceptListing(uint16 punkId, uint8 targetTraitId) external;

    // NOTE: the attributed top-up surface `contribute(referrer, tag)` lives on
    // `LiveBidAdapter`, the single faucet into the live bid. Integrators call
    // `LiveBidAdapter.contribute`.

    // ──────────────── Reads ────────────────

    function bidBalance() external view returns (uint256);
    function allowedSellers(address seller) external view returns (bool);
    function finderFeeCapBps() external view returns (uint256);
    function finderFeeFixedCap() external view returns (uint256);

    // ──────────────── Cleared-sale callbacks ────────────────

    // NOTE: the cleared-auction return refund routes through
    // `LiveBidAdapter`'s buffer (`LiveBidAdapter.poolReplenish`, module-only),
    // not into Patron directly. There is no vault-path keeper reward — vault
    // settles are free and self-incentivized by the Proof-NFT recipient.
}
