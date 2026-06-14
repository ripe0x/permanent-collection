// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice External interface for the artcoins LP locker. PERMANENT
///         COLLECTION launches on the lean `ArtCoinsLpLocker` (deployed fresh
///         per launch) — not the stock artcoins locker (`0xd914c8…97b2`).
///
///         The locker holds the LP NFT minted by the factory at launch.
///         Fees accrue to the LP position as users swap; `collectRewards`
///         pulls the accrued fees and credits each configured
///         `rewardRecipient` per its `rewardBps` into the fee escrow, in
///         WHATEVER currency was collected (native ETH on buy-side flow,
///         artcoin on sell-side) — the locker itself does NO conversion.
///
///         PC's single reward slot points at a downstream `FeeAutoSwapper`,
///         which converts the artcoin leg to native ETH and forwards
///         everything to the LiveBidAdapter. Conversion is therefore
///         keeper-driven: `collectRewards` is permissionless, and a keeper
///         then calls `FeeAutoSwapper.convert()` / `flushPaired()` to move
///         the proceeds on to the adapter.
interface IArtcoinsLocker {
    /// @notice Collect accrued LP fees for `token`'s pool and distribute
    ///         to all `rewardRecipients` in their bps proportions.
    ///         Permissionless. Anyone can pay the gas; recipients are
    ///         fixed at deploy time and updated only via admin paths.
    function collectRewards(
        address token
    ) external;

    /// @notice Same as `collectRewards` but does not modify the underlying
    ///         LP unlock state. Use when you want to keep positions
    ///         pristine.
    function collectRewardsWithoutUnlock(
        address token
    ) external;

    /// @notice Read the current reward configuration for a token. Mirrors
    ///         what was passed in the factory's `LockerConfig`.
    function tokenRewards(
        address token
    )
        external
        view
        returns (
            address[] memory rewardAdmins,
            address[] memory rewardRecipients,
            uint16[] memory rewardBps,
            int24[] memory tickLower,
            int24[] memory tickUpper,
            uint16[] memory positionBps
        );
}
