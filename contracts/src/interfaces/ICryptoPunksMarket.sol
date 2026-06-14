// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal interface for the original 2017 CryptoPunks market contract
///         at 0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB. Native CryptoPunks
///         are not ERC721 — ownership, offers and transfers all flow through
///         this contract.
interface ICryptoPunksMarket {
    /// @dev Listing opened. `toAddress == address(0)` is a public listing
    ///      anyone can fulfill; otherwise the listing is restricted to that
    ///      address (e.g. our Patron contract for `acceptBid`).
    event PunkOffered(uint256 indexed punkIndex, uint256 minValue, address indexed toAddress);

    /// @dev Listing canceled by the seller.
    event PunkNoLongerForSale(uint256 indexed punkIndex);

    /// @dev Listing fulfilled. `fromAddress` is the previous owner / seller,
    ///      `toAddress` is the buyer.
    event PunkBought(
        uint256 indexed punkIndex,
        uint256 value,
        address indexed fromAddress,
        address indexed toAddress
    );

    /// @dev Ownership changed via `transferPunk`. Clears any active listing
    ///      as a side-effect of the 2017 contract.
    event PunkTransfer(address indexed from, address indexed to, uint256 punkIndex);

    function punkIndexToAddress(uint256 punkIndex) external view returns (address);

    function punksOfferedForSale(uint256 punkIndex)
        external
        view
        returns (bool isForSale, uint256 punkIndexOut, address seller, uint256 minValue, address onlySellTo);

    function buyPunk(uint256 punkIndex) external payable;
    function transferPunk(address to, uint256 punkIndex) external;
    function offerPunkForSale(uint256 punkIndex, uint256 minSalePriceInWei) external;
    function offerPunkForSaleToAddress(uint256 punkIndex, uint256 minSalePriceInWei, address toAddress) external;
    function punkNoLongerForSale(uint256 punkIndex) external;

    function pendingWithdrawals(address) external view returns (uint256);
    function withdraw() external;

    function enterBidForPunk(uint256 punkIndex) external payable;
    function withdrawBidForPunk(uint256 punkIndex) external;
    function acceptBidForPunk(uint256 punkIndex, uint256 minPrice) external;
}
