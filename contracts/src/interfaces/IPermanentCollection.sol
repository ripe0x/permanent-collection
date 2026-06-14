// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPermanentCollection {
    /// @notice Custody outcome for an acquired Punk. Lifecycle is strictly
    ///         `InReturnAuction → (ReturnedToMarket | Vaulted)`; transitions
    ///         never move backwards.
    enum Custody {
        None, // unused (zero default — punkId not yet acquired)
        InReturnAuction, // ReturnAuctionModule is currently holding the Punk
        ReturnedToMarket, // return auction cleared; Punk transferred to buyer
        Vaulted // return auction did not clear; Punk is in PunkVault forever
    }

    // ──────────────── Writes ────────────────

    /// @notice Called by Patron immediately after it has bought a Punk and
    ///         transferred custody to ReturnAuctionModule. Records the
    ///         acquisition and marks the chosen target trait as pending. Does
    ///         NOT modify `collectedMask` — collection happens only on Vaulted.
    function recordAcquisition(
        uint16 punkId,
        uint8 targetTraitId,
        uint256 mask,
        address acquirer,
        address originalSeller,
        uint256 priceWei
    ) external;

    /// @notice Called by the immutable ReturnAuctionModule at settlement. The
    ///         Vaulted path moves the recorded target bit into `collectedMask`.
    ///         The ReturnedToMarket path only releases pending counters; no
    ///         bits are collected by that transition.
    function markCustody(
        uint16 punkId,
        Custody outcome
    ) external;

    // ──────────────── Reads ────────────────

    function collectedMask() external view returns (uint256);
    function collectedCount() external view returns (uint256);
    function isComplete() external view returns (bool);
    function uncollectedMask() external view returns (uint256);
    function pendingMask() external view returns (uint256);
    function pendingTraitCount(
        uint8 traitId
    ) external view returns (uint16);
    function attemptCount(
        uint8 traitId
    ) external view returns (uint256);
    function isCollected(
        uint8 traitId
    ) external view returns (bool);
    function isPending(
        uint8 traitId
    ) external view returns (bool);
    function firstVaultedPunk(
        uint8 traitId
    ) external view returns (uint16 punkId, bool exists);
    /// @notice Whether acquiring `punkId` is currently constrained by the
    ///         sole-carrier guard, and to which trait. Used by
    ///         frontends/indexers to pre-fill the only valid target and warn.
    function soleCarrierConstraint(
        uint16 punkId
    ) external view returns (bool required, uint8 requiredTraitId);
    /// @notice The protocol-derived target an acquisition of `punkId` would
    ///         record now: the rarest uncollected, non-pending trait the Punk
    ///         carries (ties → lowest bit index). `recordAcquisition` requires
    ///         the supplied `targetTraitId` to equal this. Reverts
    ///         `NoEligibleTarget` if the Punk has no collectable trait left.
    ///         Frontends read it to pre-fill the target and preview the vaulting
    ///         outcome.
    function canonicalTargetOf(
        uint16 punkId
    ) external view returns (uint8);
    /// @notice Number of Punks carrying trait `traitId` in the sealed dataset.
    function traitCarrierCount(
        uint8 traitId
    ) external view returns (uint16);
    function acquisitionCount() external view returns (uint256);
    function custodyOf(
        uint16 punkId
    ) external view returns (Custody);
    function isRecorded(
        uint16 punkId
    ) external view returns (bool);
    function pendingAcquisitionMaskOf(
        uint16 punkId
    ) external view returns (uint256);
    /// @notice The address that gave up `punkId` to the protocol on its
    ///         original acquisition — the recipient of any Proof NFT
    ///         issued at vault-settle. Returns `address(0)` for an
    ///         unrecorded Punk.
    function originalSellerOf(
        uint16 punkId
    ) external view returns (address);
    /// @notice 0-based index of `punkId`'s acquisition in the append-only
    ///         acquisitions log. Reverts if the Punk has never been
    ///         recorded. Used by ReturnAuctionModule when emitting `ProofMinted`
    ///         so indexers can correlate the Proof with its acquisition.
    function acquisitionIndexOf(
        uint16 punkId
    ) external view returns (uint256);
}
