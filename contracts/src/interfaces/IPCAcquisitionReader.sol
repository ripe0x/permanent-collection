// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  IPCAcquisitionReader
/// @notice Minimal read-only view of `PermanentCollection`'s append-only
///         acquisition log, scoped to exactly what `LiveBidAdapter` needs to
///         auto-track its activation threshold to the most recent live-bid
///         clearing price.
///
///         Deliberately NOT folded into `IPermanentCollection`: the concrete
///         `PermanentCollection is IPermanentCollection` already declares its
///         own `Acquisition` struct, so re-declaring it on the inherited
///         interface would clash. This standalone reader keeps the adapter's
///         dependency surface tiny and the core interface untouched.
///
///         The `Acquisition` struct and `Custody` enum mirror
///         `PermanentCollection`'s definitions field-for-field so the ABI
///         decode of `getAcquisition` is exact. `PermanentCollection` is
///         immutable, so this shape is frozen forever.
interface IPCAcquisitionReader {
    enum Custody {
        None,
        InReturnAuction,
        ReturnedToMarket,
        Vaulted
    }

    struct Acquisition {
        uint16  punkId;
        uint8   targetTraitId;
        uint256 mask;
        uint256 pendingMaskAtAcquisition;
        address acquirer;
        address originalSeller;
        uint256 priceWei;
        uint256 acquiredAtBlock;
        Custody custody;
    }

    /// @notice Total number of acquisitions ever recorded — monotonic.
    function acquisitionCount() external view returns (uint256);

    /// @notice The acquisition row at 0-based `idx`. Reverts if out of range.
    function getAcquisition(uint256 idx) external view returns (Acquisition memory);
}
