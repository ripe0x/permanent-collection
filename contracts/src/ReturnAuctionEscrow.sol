// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICryptoPunksMarket} from "./interfaces/ICryptoPunksMarket.sol";

/// @title  ReturnAuctionEscrow
/// @notice Transient settlement escrow that makes the canonical 2017
///         CryptoPunks market record a real `PunkBought(seller, buyer, price)`
///         for every cleared return auction, instead of a price-less
///         `PunkTransfer`. The clearing price thus lands on-chain in the
///         Punk's canonical sale history.
///
/// @dev    Deployed once by `ReturnAuctionModule` in its constructor and pinned to
///         that single caller (`MODULE`). During a cleared settle the module
///         transfers the won Punk here, this escrow lists it exclusively to
///         the module at the hammer price, the module buys it (emitting
///         `PunkBought` with this escrow as seller of record and the module as
///         buyer), and the proceeds round-trip straight back to the module via
///         `sweepProceeds`. Net ETH movement is zero.
///
///         The Punk is never left in this escrow across transactions — the
///         whole dance runs atomically inside the module's `nonReentrant`
///         `settle()`, so any failure rolls the entire settlement back. The
///         recorded buyer is the module (a protocol contract), never the human
///         winner: CryptoPunks records `msg.sender` of `buyPunk` as the buyer
///         and the winner's bid is escrowed in the module, not paid by the
///         winner at settle time. The winner still receives the Punk as the
///         final `transferPunk` recipient.
contract ReturnAuctionEscrow {
    error NotModule();
    error UnexpectedEtherSender();
    error ProceedsForwardFailed();

    /// @notice The `ReturnAuctionModule` that owns this escrow.
    address public immutable MODULE;
    /// @notice The 2017 CryptoPunks market.
    ICryptoPunksMarket public immutable punksMarket;

    constructor(address _punksMarket) {
        MODULE = msg.sender;
        punksMarket = ICryptoPunksMarket(_punksMarket);
    }

    /// @notice Accepts ETH only from the Punk market during `withdraw()`.
    ///         No other sender — and no admin path — can move ETH through here.
    receive() external payable {
        if (msg.sender != address(punksMarket)) revert UnexpectedEtherSender();
    }

    /// @notice List the held Punk for sale exclusively to the module at the
    ///         hammer price. The module calls `buyPunk` next, which emits the
    ///         canonical `PunkBought(escrow, module, hammerWei)`.
    /// @dev    Requires this escrow to currently own `punkId` (the module
    ///         transfers it in immediately before calling). Module-only.
    function listForSettlement(uint256 punkId, uint256 hammerWei) external {
        if (msg.sender != MODULE) revert NotModule();
        punksMarket.offerPunkForSaleToAddress(punkId, hammerWei, MODULE);
    }

    /// @notice Pull the post-sale credit from the market and forward the full
    ///         balance to the module so it can run the proceeds split.
    /// @dev    Module-only. Net ETH through this escrow is zero per settle.
    function sweepProceeds() external {
        if (msg.sender != MODULE) revert NotModule();
        punksMarket.withdraw();
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        (bool ok,) = payable(MODULE).call{value: bal}("");
        if (!ok) revert ProceedsForwardFailed();
    }
}
