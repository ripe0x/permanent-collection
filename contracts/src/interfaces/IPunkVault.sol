// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPunkVault {
    /// @notice Acknowledgement hook for the return auction module: after it
    ///         transfers a Punk to this vault, it calls `receivePunk` so the
    ///         vault can record the lock for indexers + tests. The vault has
    ///         no withdrawal path; locked Punks can never leave.
    function receivePunk(uint16 punkId) external;

    /// @notice Mint hook for the title auction. Callable exactly once, only
    ///         by the immutable `titleAuction` address. Mints token id 111
    ///         (the Title) to the auction contract so it can custody the
    ///         title between kickoff and settle.
    function mintToAuction() external;

    /// @notice Mint a Proof for `targetTraitId`'s first-vaulting. Callable
    ///         only by `returnAuctionModule`, only once per trait, only for
    ///         `targetTraitId ∈ [0, 110]`. The minted token id is
    ///         `targetTraitId` (Proof ids occupy 0..110, so `tokenId == traitId`). Uses
    ///         `_mint` semantics — no `onERC721Received` callback, so a
    ///         non-receiver-aware contract recipient cannot strand the
    ///         Proof.
    /// @param punkId        The Punk whose vaulting collected the trait.
    /// @param targetTraitId The newly-collected trait (0..110).
    /// @param recipient     The address recorded as `originalSeller` on
    ///                      the acquisition. Must be non-zero (enforced).
    /// @param acquisitionId 0-based index into `PermanentCollection._acquisitions`.
    /// @param sequence      Value of `collectedCount()` after the trait
    ///                      was collected. 1-based collection position.
    function mintProofs(
        uint16 punkId,
        uint8 targetTraitId,
        address recipient,
        uint256 acquisitionId,
        uint16 sequence
    ) external;

    /// @notice Count of permanently-locked Punks. Used by the renderer's
    ///         title-attributes block.
    function lockedPunkCount() external view returns (uint256);
}
