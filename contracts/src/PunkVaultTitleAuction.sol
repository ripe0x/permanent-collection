// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPermanentCollection} from "./interfaces/IPermanentCollection.sol";
import {IPunkVault} from "./interfaces/IPunkVault.sol";
import {PCNoReentry} from "./libraries/PCNoReentry.sol";
import {PCReentrancyGuard} from "./libraries/PCReentrancyGuard.sol";

interface IERC721Transfer {
    function transferFrom(address from, address to, uint256 id) external;
}

/// @title  PunkVaultTitleAuction
/// @notice One-shot, permissionless English auction that sells the vault
///         title (ERC721 token id 111 on `PunkVault`) once the collection
///         has collected at least `KICKOFF_THRESHOLD` (22) traits.
///
///         Lifecycle:
///           - Pre-kickoff: the title (token id 111) is already minted to
///             this contract at launch via `mintTitle()`, so it exists and
///             renders from the start, but the auction is closed. Anyone can
///             call `kickoff()` once
///             `collection.collectedCount() >= KICKOFF_THRESHOLD`, which
///             starts the 24-hour auction clock (and re-mints the title only
///             as an idempotent fallback).
///           - Live: anyone can `bid()`. Bids have no fixed reserve but
///             each new bid must be at least 5% above the current high
///             (and strictly greater in wei terms). Outbid losers are
///             refunded via a 30k-gas push, falling back to a pull-pattern
///             `pendingRefund` mapping. A bid in the final 15 minutes
///             extends the deadline by 1 hour, uncapped.
///           - Settle: anyone can call `settle()` after `endsAt`. With a
///             winner, the title transfers and 100% of the proceeds route
///             to the immutable `payoutRecipient` (the live bid gets
///             nothing from this path). That recipient
///             is a hard-coded address chosen at deploy time and does NOT
///             default to the deployer EOA. With no winner, `settle()` does
///             not finalize: it extends the deadline by another
///             `AUCTION_DURATION` and re-emits `Kickoff`, so the auction
///             restarts and loops until someone bids.
///
/// @dev    No admin functions. No setters. No fund-recovery path. Every
///         parameter is a compile-time constant or an immutable bound at
///         construction. `transferFrom` (not `safeTransferFrom`) is used
///         to deliver the title so a non-receiver-aware winner contract
///         can't strand the token.
contract PunkVaultTitleAuction is PCNoReentry, PCReentrancyGuard {
    error AlreadyKickedOff();
    error ThresholdNotReached();
    error AuctionNotLive();
    error AuctionEnded();
    error AuctionLive();
    error AlreadySettled();
    error BidNotHigherThanCurrent(uint256 bid, uint256 currentHigh);
    error BidBelowMinimumIncrease(uint256 bid, uint256 minRequired);
    error ZeroBid();
    error ZeroAddress();
    error TransferFailed();
    error NothingToWithdraw();

    /// @notice Emitted once at `kickoff` time with the snapshot deadline.
    event Kickoff(uint256 atBlock, uint64 endsAt);
    /// @notice Emitted on every accepted bid. `endsAt` reflects the
    ///         deadline AFTER any anti-snipe extension this bid triggered.
    event Bid(address indexed bidder, uint256 amount, uint64 endsAt);
    /// @notice Emitted when an anti-snipe extension has moved `endsAt`
    ///         further into the future.
    event Extended(uint64 newEndsAt);
    /// @notice Emitted on the cleared settle path. 100% of `highBid` is
    ///         credited to `payoutRecipient` via the pull queue.
    event Settled(address indexed winner, uint256 highBid);
    /// @notice Emitted on the no-bidder settle path. The auction does not
    ///         finalize; it extends by another `AUCTION_DURATION` and
    ///         re-emits `Kickoff`, restarting until someone bids.
    event SettledNoBidder();
    /// @notice Emitted when a push refund failed and was queued.
    event RefundQueued(address indexed bidder, uint256 amount);
    /// @notice Emitted when a queued refund was successfully pulled.
    event RefundWithdrawn(address indexed bidder, uint256 amount);
    /// @notice Emitted when a settle-proceeds credit was queued for pull.
    ///         The full credit (100% of `highBid`) goes to `payoutRecipient`
    ///         and is claimed via `withdrawProceeds`; anyone may trigger a
    ///         claim for the credited recipient. The settle path never
    ///         pushes ETH so a recipient that reverts on receive cannot
    ///         block the title transfer.
    event ProceedsQueued(address indexed recipient, uint256 amount);
    /// @notice Emitted when a queued proceeds credit was successfully pulled.
    event ProceedsWithdrawn(address indexed recipient, uint256 amount);

    /// @notice Total trait bits — matches `PermanentCollection.TRAIT_COUNT`.
    uint256 public constant TRAIT_COUNT = 111;
    /// @notice Permissionless `kickoff()` becomes callable once at least this
    ///         many traits have been collected. Each vaulted Punk collects
    ///         exactly one trait, so this is also "kickoff after N Punks
    ///         vaulted." Set to 22 — meaningful proof the protocol has
    ///         acquired and vaulted real Punks, while keeping the title path
    ///         open to win as the collection grows.
    uint256 public constant KICKOFF_THRESHOLD = 22;
    /// @notice Token id of the vault Title NFT on `PunkVault`. Single one-of-one.
    /// @dev    Title sits at id 111, just past the 111 Proofs (which
    ///         occupy 0..110 with `tokenId == traitId` directly). Must
    ///         mirror `PunkVault.TITLE_TOKEN_ID`.
    uint256 public constant TITLE_TOKEN_ID = 111;
    /// @notice Duration from `kickoff` to the initial `endsAt`. Each
    ///         late-window bid extends it; the extension is uncapped.
    uint64 public constant AUCTION_DURATION = 24 hours;
    /// @notice Trailing window in which a new bid triggers an extension.
    uint64 public constant SNIPE_TRIGGER_WINDOW = 15 minutes;
    /// @notice Length of each anti-snipe extension.
    uint64 public constant SNIPE_EXTENSION = 1 hours;
    /// @notice Minimum bid increment over the current high, in basis
    ///         points. A new bid must be at least
    ///         `highBidWei * (BPS_DENOM + MIN_INCREASE_BPS) / BPS_DENOM`
    ///         AND strictly greater than `highBidWei` (the latter handles
    ///         the rounding edge case for sub-20-wei highs).
    uint16 public constant MIN_INCREASE_BPS = 500;
    uint256 internal constant BPS_DENOM = 10_000;

    /// @notice Records core. Read for `collectedCount` at kickoff.
    IPermanentCollection public immutable collection;
    /// @notice Vault that mints the title to this contract via
    ///         `mintToAuction`, and that this contract transfers from at
    ///         settle.
    IPunkVault public immutable vault;
    /// @notice Receives 100% of cleared settle proceeds.
    ///         Set once at construction; no rotation path, no admin path.
    ///         This is intentionally NOT named "creator" — it is a payout
    ///         destination chosen at deploy time and may be any address
    ///         (EOA, multisig, splitter), distinct from any "creator
    ///         identity" elsewhere in the protocol (e.g. the locker's
    ///         creator reward recipient, which is its own separate
    ///         decision and rotatable via the locker's own admin path).
    address payable public immutable payoutRecipient;

    bool public kickedOff;
    bool public settled;
    /// @notice True once the Title (token 111) has been minted into this
    ///         auction's escrow. Set by `mintTitle()` (called at launch) so
    ///         the Title exists from the start; the AUCTION is separately
    ///         gated on `KICKOFF_THRESHOLD` (see `kickoff`).
    bool public titleMinted;
    uint64 public endsAt;
    uint128 public highBidWei;
    address public highBidder;

    /// @notice Pull-pattern fallback for refunds that failed to push.
    mapping(address => uint256) public pendingRefund;
    /// @notice Pull-pattern credits for cleared settle proceeds.
    ///         `payoutRecipient` is credited the full `highBid` at settle;
    ///         the actual ETH transfer happens later via `withdrawProceeds`
    ///         — settle itself never pushes ETH. A recipient
    ///         whose `receive` reverts cannot block the title transfer or
    ///         the rest of settle.
    mapping(address => uint256) public pendingProceeds;

    // `nonReentrant` inherited from PCReentrancyGuard.

    /// @param _collection      Records core (read for `collectedCount`).
    /// @param _vault           Vault that mints the title NFT into this
    ///                         contract's escrow (via `mintTitle()` at launch)
    ///                         and from which it transfers to the winner on
    ///                         settle.
    /// @param _payoutRecipient Receives 100% of cleared settle
    ///                         proceeds. Immutable — must be set
    ///                         deliberately at deploy time. Per the
    ///                         field-level natspec above, this is a
    ///                         **payout address** (any EOA, multisig, or
    ///                         splitter), not necessarily a creator
    ///                         identity.
    constructor(
        address _collection,
        address _vault,
        address payable _payoutRecipient,
        address _swapContext
    ) PCNoReentry(_swapContext) {
        if (
            _collection == address(0)
                || _vault == address(0)
                || _payoutRecipient == address(0)
        ) revert ZeroAddress();
        collection = IPermanentCollection(_collection);
        vault = IPunkVault(_vault);
        payoutRecipient = _payoutRecipient;
    }

    /// @notice Mint the Title (token 111) into this auction's escrow.
    ///         Permissionless and idempotent — called once at launch so the
    ///         Title exists (and its `tokenURI`/marketplace page resolve) from
    ///         the start, independent of the auction. A no-op if already
    ///         minted. The AUCTION itself does NOT open here: bidding stays
    ///         closed until `kickoff()` past `KICKOFF_THRESHOLD`.
    function mintTitle() external {
        _mintTitle();
    }

    function _mintTitle() internal {
        if (titleMinted) return;
        titleMinted = true;
        vault.mintToAuction();
    }

    /// @notice Start the auction clock. Permissionless; anyone can call once
    ///         the protocol has collected at least `KICKOFF_THRESHOLD` traits
    ///         (= same number of Punks vaulted under the one-trait-per-Punk
    ///         rule). The Title is minted separately at launch via
    ///         `mintTitle()`; kickoff mints it as a fallback (idempotent) so
    ///         settle always has a Title to transfer.
    function kickoff() external {
        if (kickedOff) revert AlreadyKickedOff();
        if (collection.collectedCount() < KICKOFF_THRESHOLD) revert ThresholdNotReached();
        kickedOff = true;
        endsAt = uint64(block.timestamp) + AUCTION_DURATION;
        _mintTitle();
        emit Kickoff(block.number, endsAt);
    }

    /// @notice Place a bid. The bid must be strictly greater than the
    ///         current high AND at least 5% above it
    ///         (`MIN_INCREASE_BPS = 500`). A bid placed in the final
    ///         `SNIPE_TRIGGER_WINDOW` extends `endsAt` by
    ///         `SNIPE_EXTENSION` (uncapped).
    function bid() external payable nonReentrant notInSwap {
        if (!kickedOff || settled) revert AuctionNotLive();
        if (block.timestamp >= endsAt) revert AuctionEnded();
        if (msg.value == 0) revert ZeroBid();
        uint256 currentHigh = uint256(highBidWei);
        if (msg.value <= currentHigh) {
            revert BidNotHigherThanCurrent(msg.value, currentHigh);
        }
        uint256 minRequired = (currentHigh * (BPS_DENOM + MIN_INCREASE_BPS)) / BPS_DENOM;
        if (msg.value < minRequired) {
            revert BidBelowMinimumIncrease(msg.value, minRequired);
        }

        address previousBidder = highBidder;
        uint256 previousBid = currentHigh;

        highBidWei = uint128(msg.value);
        highBidder = msg.sender;

        if (endsAt - uint64(block.timestamp) < SNIPE_TRIGGER_WINDOW) {
            uint64 extended = uint64(block.timestamp) + SNIPE_EXTENSION;
            endsAt = extended;
            emit Extended(extended);
        }

        if (previousBidder != address(0)) {
            (bool ok,) = previousBidder.call{value: previousBid, gas: 30_000}("");
            if (!ok) {
                pendingRefund[previousBidder] += previousBid;
                emit RefundQueued(previousBidder, previousBid);
            }
        }

        emit Bid(msg.sender, msg.value, endsAt);
    }

    /// @notice Settle the auction after `endsAt`. Anyone may call.
    ///
    ///         **With a winner**: the title NFT transfers to the highest
    ///         bidder, and the ETH proceeds are credited to a pull-pattern
    ///         queue. **100% of proceeds route to `payoutRecipient`**; the
    ///         live bid receives nothing from the title-auction path. Anyone — not
    ///         just the credited recipient — can trigger the actual
    ///         transfer of credited funds, so a recipient with a
    ///         non-payable `receive` cannot brick settle.
    ///
    ///         **With no bidder**: settle does NOT flip `settled`. Instead
    ///         it extends `endsAt` by another `AUCTION_DURATION` and re-emits
    ///         `Kickoff` so indexers refresh their countdown. This keeps
    ///         the title from being stranded forever in a "no-bid"
    ///         terminal state. The no-bid extension is uncapped — the
    ///         auction will loop indefinitely until someone bids.
    function settle() external nonReentrant notInSwap {
        if (!kickedOff) revert AuctionNotLive();
        if (settled) revert AlreadySettled();
        if (block.timestamp < endsAt) revert AuctionLive();

        address winner = highBidder;
        if (winner == address(0)) {
            // No-bid restart. Don't flip `settled` — the auction stays
            // live for another AUCTION_DURATION. The Kickoff event signals
            // indexers / UIs to refresh the deadline.
            uint64 extended = uint64(block.timestamp) + AUCTION_DURATION;
            endsAt = extended;
            emit SettledNoBidder();
            emit Kickoff(block.number, extended);
            return;
        }

        settled = true;
        uint256 highBid = uint256(highBidWei);

        // Credit 100% of the proceeds to the pull queue rather than pushing.
        // A recipient that reverts on `receive` (or is a contract with no
        // payable fallback) can still claim later via `withdrawProceeds`.
        // A non-payable `payoutRecipient` would otherwise block settle
        // forever and strand the title. `highBid > 0` here — the no-bid
        // path returned above.
        pendingProceeds[payoutRecipient] += highBid;
        emit ProceedsQueued(payoutRecipient, highBid);

        // Title last — keeps the failure-mode boundary clean. (Proceeds
        // are already accounted for in storage; the title transfer is the
        // only remaining external interaction.)
        IERC721Transfer(address(vault)).transferFrom(address(this), winner, TITLE_TOKEN_ID);

        emit Settled(winner, highBid);
    }

    /// @notice Pull queued proceeds for `recipient` (the immutable
    ///         `payoutRecipient` credited 100% of `highBid` at settle).
    ///         Idempotent — zeroes the balance before sending. Anyone may
    ///         trigger the transfer, but funds always go to the credited
    ///         recipient, so the proceeds stay claimable even if
    ///         `payoutRecipient` has no generic outbound-call surface.
    function withdrawProceeds(address recipient) public nonReentrant notInSwap {
        _withdrawProceeds(recipient);
    }

    /// @notice Convenience wrapper for EOAs/contracts claiming their own
    ///         credit. Use the `withdrawProceeds(address)` overload to pull
    ///         for another recipient (e.g. `payoutRecipient`).
    function withdrawProceeds() external nonReentrant notInSwap {
        _withdrawProceeds(msg.sender);
    }

    function _withdrawProceeds(address recipient) internal {
        uint256 amt = pendingProceeds[recipient];
        if (amt == 0) revert NothingToWithdraw();
        pendingProceeds[recipient] = 0;
        (bool ok,) = recipient.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit ProceedsWithdrawn(recipient, amt);
    }

    /// @notice Pull queued refunds for `msg.sender` (refunds that failed
    ///         to push during a `bid` call). Idempotent — zeroes the
    ///         balance before sending.
    function withdrawRefund() external nonReentrant notInSwap {
        uint256 amt = pendingRefund[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        pendingRefund[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit RefundWithdrawn(msg.sender, amt);
    }

    // ────────── views ──────────

    /// @notice True iff the auction is currently accepting bids.
    function isLive() external view returns (bool) {
        return kickedOff && !settled && block.timestamp < endsAt;
    }

    /// @notice True iff `settle()` would succeed right now.
    function isSettleable() external view returns (bool) {
        return kickedOff && !settled && block.timestamp >= endsAt;
    }

    /// @notice True iff `kickoff()` would succeed right now.
    function isKickoffReady() external view returns (bool) {
        return !kickedOff && collection.collectedCount() >= KICKOFF_THRESHOLD;
    }

    /// @notice Minimum acceptable bid right now. Before any bids, returns
    ///         0 — the first bid only needs to be non-zero. Once a high
    ///         exists, returns `highBidWei * 1.05` (rounded down by
    ///         integer division).
    function minNextBid() external view returns (uint256) {
        return (uint256(highBidWei) * (BPS_DENOM + MIN_INCREASE_BPS)) / BPS_DENOM;
    }
}
