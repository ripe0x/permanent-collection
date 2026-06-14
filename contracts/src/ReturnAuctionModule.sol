// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICryptoPunksMarket} from "./interfaces/ICryptoPunksMarket.sol";
import {IPermanentCollection} from "./interfaces/IPermanentCollection.sol";
import {IReturnAuctionModule} from "./interfaces/IReturnAuctionModule.sol";
import {IPunkVault} from "./interfaces/IPunkVault.sol";
import {IVaultBurnPool} from "./interfaces/IVaultBurnPool.sol";
import {ReturnAuctionEscrow} from "./ReturnAuctionEscrow.sol";
import {PCNoReentry} from "./libraries/PCNoReentry.sol";
import {PCReentrancyGuard} from "./libraries/PCReentrancyGuard.sol";

/// @title  ReturnAuctionModule
/// @notice Per-Punk 72-hour return auction that follows every acquisition.
///
///         Opening reserve is derived from the per-trait attempt counter at
///         start-of-sale:
///             reserve = acquisitionCost × (101 + previousAttempts) / 100
///         so the first attempt against a trait requires a 1% premium over the
///         live-bid amount paid, the second requires 2%, and so on indefinitely.
///         `previousAttempts` is `PermanentCollection.attemptCount(targetTrait)`
///         BEFORE `recordAcquisition` bumps it for this attempt.
///
///         Any bid placed within the final 15 minutes extends the deadline
///         by 1 hour. The extension is uncapped — an actively-contested Punk
///         stays in active bidding indefinitely, since each bid must strictly
///         exceed the current high in ETH.
///
///         Settlement paths:
///           - **Cleared** (high bid ≥ reserve): Punk → buyer. Proceeds split
///             (hard-coded, no setter): 65% × cost → `LiveBidAdapter`
///             (buffered + metered into the live bid), 25% × cost →
///             `BuybackBurner`, 10% × cost + the overbid premium
///             `(highBid − cost)` → `VaultBurnPool`.
///           - **Unsold**: Punk → immutable `PunkVault`. `markCustody(Vaulted)`
///             collects ONLY the recorded target trait. Other uncollected
///             traits remain available for future acquisitions.
///
/// @dev    Single contract holds custody for every acquired Punk during its
///         return auction window. Reentrancy is guarded; outgoing-bidder
///         refunds use a push pattern with a pull fallback. `settle` pays no
///         protocol-funded keeper tip on either path — it is self-incentivized
///         (the cleared path by the winning bidder's locked ETH, who receives
///         the Punk only on settle; the vault path by the Proof-NFT
///         recipient). Anyone may call `settle`. The vault-path Proof mint is
///         REQUIRED — a `mintProofs` failure reverts the whole settle (atomic
///         with the vaulting; see the unsold branch) so a collected trait can
///         never exist without its Proof.
contract ReturnAuctionModule is IReturnAuctionModule, PCNoReentry, PCReentrancyGuard {
    error NotPatron();
    error SaleExists(uint16 punkId);
    error SaleMissing(uint16 punkId);
    error SaleLive(uint16 punkId);
    error SaleEnded(uint16 punkId);
    error AlreadySettled(uint16 punkId);
    error BidBelowReserve(uint256 bid, uint256 reserve);
    error BidNotHigherThanCurrent(uint256 bid, uint256 currentHigh);
    error ZeroAddress();
    error PunkNotInCustody(uint16 punkId);
    error TransferFailed();
    error NothingToWithdraw();
    error ReserveOverflow(uint256 reserveU);
    error BidBelowMinIncrement(uint256 bid, uint256 minNext);

    /// @notice Emitted once per Punk at `startSale` time. `reserveWei` is the
    ///         snapshot reserve = `acquisitionCost × (101 + previousAttempts) / 100`.
    event ReturnAuctionStarted(
        uint16 indexed punkId,
        uint128 acquisitionCost,
        uint128 reserveWei,
        uint64 startedAt,
        uint64 endsAt
    );
    /// @notice Emitted on every accepted bid, with the referrer + optional
    ///         campaign tag carried by this bid. `endsAt` reflects the deadline
    ///         AFTER any anti-snipe extension this bid may have triggered.
    ///         Surfaces the attribution side-channel cleanly so indexers and
    ///         frontends can credit referrers without re-reading the storage
    ///         slot. `referrer == address(0)` is a valid no-attribution bid.
    event BidPlaced(
        uint16 indexed punkId,
        address indexed bidder,
        address indexed referrer,
        uint256 amount,
        bytes32 tag,
        uint64 endsAt
    );
    /// @notice Emitted when an anti-snipe extension has moved `endsAt`
    ///         further into the future.
    event ReturnAuctionExtended(uint16 indexed punkId, uint64 newEndsAt);
    /// @notice Emitted on the cleared `settle` path with the four-way
    ///         proceeds split:
    ///           live-bid share = 65% × acquisitionCost                      → LiveBidAdapter
    ///           burnShare      = 25% × acquisitionCost (residual)           → BuybackBurner
    ///           referrerShare  = `REFERRER_PREMIUM_BPS` of (highBid − cost) → winning bid's referrer
    ///           vaultBurnShare = 10% × acquisitionCost + premium remainder  → VaultBurnPool
    ///         `referrer == address(0)` (or a refusing referrer) routes
    ///         the entire premium to VaultBurnPool; live-bid share and
    ///         burnShare are NEVER reduced by referrer attribution.
    event ReturnAuctionCleared(
        uint16 indexed punkId,
        address indexed buyer,
        address indexed referrer,
        uint256 highBidWei,
        uint256 liveBidShare,
        uint256 burnShare,
        uint256 vaultBurnShare,
        uint256 referrerShare
    );
    /// @notice Emitted on the unsold `settle` path. Punk is now in
    ///         `PunkVault` forever and the target trait has been collected.
    event PunkVaulted(uint16 indexed punkId);
    /// @notice Emitted when an outbid refund couldn't push to the bidder
    ///         (e.g. contract bidder needing more than 30k gas). The amount
    ///         is added to `pendingRefund[bidder]` for later `withdrawRefund`.
    event RefundQueued(address indexed bidder, uint256 amount);
    /// @notice Emitted when a bidder pulls a previously-queued refund.
    event RefundWithdrawn(address indexed bidder, uint256 amount);
    /// @notice Emitted exactly once at `setVaultBurnPool` time.
    event VaultBurnPoolSet(address indexed vaultBurnPool);
    /// @notice Emitted exactly once at `setLiveBidAdapter` time.
    event LiveBidAdapterSet(address indexed liveBidAdapter);

    /// @notice Total duration of each return auction from `startSale` to the
    ///         initial `endsAt`. Subsequent late-window bids extend it.
    uint64 public constant AUCTION_DURATION = 72 hours;
    /// @notice Length of each anti-snipe extension when triggered.
    uint64 public constant SNIPE_EXTENSION = 1 hours;
    /// @notice Trailing window in which a new bid triggers an extension.
    uint64 public constant SNIPE_TRIGGER_WINDOW = 15 minutes;
    uint256 internal constant BPS_DENOM = 10_000;

    /// @notice Live-bid share of the cleared (returned) proceeds, expressed as
    ///         a bps fraction of `acquisitionCost`. With the in-cost vault-
    ///         burn slice `CLEARED_VAULT_BURN_BPS = 1000`, the residual
    ///         burn share is `BPS_DENOM - CLEARED_BID_BPS - CLEARED_VAULT_BURN_BPS
    ///         = 2500` (25% of acquisitionCost). The premium above
    ///         acquisitionCost (i.e.
    ///         `highBid − acquisitionCost`) flows entirely to VaultBurnPool,
    ///         on top of the in-cost `CLEARED_VAULT_BURN_BPS` slice below.
    ///
    ///         Hard-coded — no setter, no admin.
    uint256 public constant CLEARED_BID_BPS = 6500;

    /// @notice Cleared-path vault-burn share — bps of `acquisitionCost`
    ///         (denom `BPS_DENOM = 10_000`). Carved out of cost alongside
    ///         the live-bid + burn slices on every return, and added on top
    ///         of the `(highBid − cost)` premium that already routes there.
    ///         With `CLEARED_BID_BPS = 6500` and `CLEARED_VAULT_BURN_BPS =
    ///         1000`, the residual burn share is `10_000 − 6500 − 1000 =
    ///         2500` (25% of cost). Hard-coded.
    uint256 public constant CLEARED_VAULT_BURN_BPS = 1000;

    /// @notice Winning-bidder's referrer share of the return premium,
    ///         expressed as a bps fraction of `(highBid − acquisitionCost)`.
    ///         The remainder of the premium flows to `VaultBurnPool`.
    ///         Live-bid share and burnShare are sized purely on `acquisitionCost`
    ///         and never reduced by referrer attribution — auction referral
    ///         comes from fresh external value (the returner's voluntary
    ///         overbid), not from internal pools.
    ///
    ///         Fail-closed in both directions: no referrer → 100% of premium
    ///         → VaultBurnPool; reverting / OOG referrer → ETH folds back
    ///         into vaultBurnShare before the pool transfer. The 35k-gas
    ///         budget on the outgoing send matches `ReferralPayout.CLAIM_GAS`
    ///         so receiver-side gas-grief patterns observed by one pull
    ///         apply identically to both surfaces.
    ///
    ///         Hard-coded — no setter, no admin. 500 = 5% of the premium.
    uint256 public constant REFERRER_PREMIUM_BPS = 500;

    /// @notice Gas budget for the outgoing send to the auction referrer on
    ///         cleared-path settles. Matches `ReferralPayout.CLAIM_GAS`.
    uint256 public constant REFERRER_GAS = 35_000;

    /// @notice The 2017 CryptoPunks market.
    ICryptoPunksMarket public immutable punksMarket;
    /// @notice Transient settlement escrow. Deployed by this module in its
    ///         constructor and used on the cleared `settle` path so the
    ///         canonical market records a real `PunkBought` at the hammer
    ///         price (seller = escrow, buyer = this module) before the Punk is
    ///         delivered to the winning bidder. See `ReturnAuctionEscrow`.
    ReturnAuctionEscrow public immutable escrow;
    /// @notice Records-only core — receives `markCustody` calls at settlement.
    IPermanentCollection public immutable permanentCollection;
    /// @notice Terminal custodian for unsold Punks.
    IPunkVault public immutable punkVault;
    /// @notice The acquisition hub — the ONLY authorized caller of `startSale`
    ///         (`msg.sender == patron`). The cleared-settle live-bid share is
    ///         routed through `liveBidAdapter.poolReplenish` (buffered +
    ///         metered), not sent to Patron directly.
    address payable public immutable patron;
    /// @notice 111 buy-and-burn sink. Receives the burn share on cleared
    ///         settlements.
    address payable public immutable buybackBurner;
    /// @notice Vault-burn pool — swept to BuybackBurner on every vault-path
    ///         settle. Wired post-deploy via `setVaultBurnPool` because the
    ///         pool's constructor depends on this contract's address.
    address payable public vaultBurnPool;
    /// @notice The single inflow governor. Receives the cleared-settle live-bid
    ///         share (65% of cost) via `poolReplenish`, which buffers it into
    ///         the live bid. Wired post-deploy via `setLiveBidAdapter`
    ///         (one-shot) because the adapter's constructor references this
    ///         module — the same cyclic resolution as `setVaultBurnPool`. The
    ///         cleared live-bid return refund routes here, not to Patron
    ///         directly.
    address payable public liveBidAdapter;

    /// @notice Minimum required overbid as bps of the current high bid.
    ///         The next valid bid must be ≥ `currentHigh × (10_000 + bps) / 10_000`.
    ///         Fixed at 100 bps (1%) — a protocol constant, not admin-tunable.
    /// @dev    Caps the indefinite-anti-snipe DoS vector: a griefer who keeps
    ///         the auction open with minimum overbids compounds the bid value
    ///         by 1% per round, so the locked-capital cost to indefinitely
    ///         delay trait collection grows geometrically (1.01^n). Freezing it
    ///         as a constant is strictly safer than a mutable bound: it removes
    ///         any path (including a compromised admin key inside the 1y window)
    ///         to weaken the increment. As a constant it is read directly by
    ///         every auction rather than snapshotted per sale.
    uint256 public constant minBidIncrementBps = 100;

    error AlreadyWired();
    error NotDeployer();
    address private immutable _deployer;

    /// @notice Per-Punk return auction state. Lifecycle:
    ///   - `_sales[punkId].endsAt == 0`                : never started
    ///   - `endsAt != 0 && !settled && now < endsAt`   : live (bids accepted)
    ///   - `endsAt != 0 && !settled && now >= endsAt`  : ready to settle
    ///   - `settled`                                   : terminal for THIS
    ///       auction, but the slot is REUSABLE. A re-auction of a returned
    ///       (ReturnedToMarket) Punk calls `startSale` again, which fully
    ///       resets the slot. Only a non-settled live sale blocks a new
    ///       `startSale`.
    /// @dev `reserveWei` is snapshotted at `startSale` and never moves for
    ///      that sale (re-snapshotted on each re-auction off the new
    ///      acquisition price + current `attemptCount`). The min-bid increment
    ///      is the protocol constant `minBidIncrementBps`, read directly in
    ///      `_placeBid`.
    /// @dev `targetTraitId` is the trait that gets collected on the Vault
    ///      branch — only that one, even if the Punk's mask carries others.
    struct ReturnAuction {
        uint128 acquisitionCost;  // live-bid amount paid (or listing price) at acquisition time
        uint128 highBidWei;
        address highBidder;
        uint64  startedAt;
        uint64  endsAt;
        uint128 reserveWei;       // snapshot at sale start = paid × (101 + prevAttempts) / 100
        uint8   targetTraitId;    // caller-selected target collected only on Vault path
        bool    settled;
    }
    mapping(uint16 => ReturnAuction) internal _sales;

    /// @notice Pull-pattern fallback for refunds that failed to push to a
    ///         previous bidder (e.g. a contract bidder whose receive needs
    ///         more than 30k gas). Withdrawable via `withdrawRefund`.
    mapping(address => uint256) public pendingRefund;

    /// @notice Referrer attached to the current high bid for `punkId`.
    ///         Overwritten on every accepted bid — the slot tracks the
    ///         CURRENT winning bidder's referrer only. Outbid bidders'
    ///         referrers lose their attribution claim (mirrors the
    ///         winner-take-all auction semantics). Read on the cleared
    ///         settle path to size the referrer share of the premium.
    ///         `address(0)` indicates a no-attribution bid.
    mapping(uint16 => address) public referrerOfHighBid;

    // `nonReentrant` inherited from PCReentrancyGuard.
    //
    // This contract has no admin role: the min-bid increment is a protocol
    // constant, so there is no `ProtocolAdmin` reference and no `onlyAdmin`
    // modifier here.

    /// @dev All immutable references are set here. The deploy script
    ///      resolves the circular Punk-vault dependency by precomputing
    ///      this contract's CREATE address before deploying the vault.
    constructor(
        address _punksMarket,
        address _permanentCollection,
        address _punkVault,
        address payable _patron,
        address payable _buybackBurner,
        address _swapContext
    ) PCNoReentry(_swapContext) {
        if (
            _punksMarket == address(0)
                || _permanentCollection == address(0)
                || _punkVault == address(0)
                || _patron == address(0)
                || _buybackBurner == address(0)
        ) revert ZeroAddress();
        punksMarket = ICryptoPunksMarket(_punksMarket);
        permanentCollection = IPermanentCollection(_permanentCollection);
        punkVault = IPunkVault(_punkVault);
        patron = _patron;
        buybackBurner = _buybackBurner;
        _deployer = msg.sender;

        // Deploy the dedicated settlement escrow pinned to this module. It is
        // used only on the cleared `settle` path to round-trip the won Punk
        // through the canonical market so a real `PunkBought` at the hammer
        // price is recorded. Deterministic CREATE address; no external wiring.
        escrow = new ReturnAuctionEscrow(_punksMarket);
    }

    /// @notice Accepts ETH only from the settlement escrow when it forwards
    ///         canonical-market proceeds back during a cleared settle. Bids
    ///         arrive via the payable `bid` function, not here.
    receive() external payable {
        if (msg.sender != address(escrow)) revert TransferFailed();
    }

    /// @notice One-time wiring of `VaultBurnPool` after deploy. The pool's
    ///         constructor depends on this contract's address, so the
    ///         dependency direction is ReturnAuctionModule → pool established
    ///         after both are deployed. Restricted to the deployer and only
    ///         allowed once; after that, immutable for protocol purposes.
    function setVaultBurnPool(address payable _vaultBurnPool) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (vaultBurnPool != address(0)) revert AlreadyWired();
        if (_vaultBurnPool == address(0)) revert ZeroAddress();
        vaultBurnPool = _vaultBurnPool;
        emit VaultBurnPoolSet(_vaultBurnPool);
    }

    /// @notice One-time wiring of `LiveBidAdapter` after deploy. The adapter's
    ///         constructor references THIS module (to gate its `poolReplenish`
    ///         module-only), so the adapter is deployed after this module and
    ///         wired back here — the same cyclic resolution as
    ///         `setVaultBurnPool`. Restricted to the deployer and allowed once;
    ///         after that, immutable for protocol purposes. Until set, the
    ///         cleared-settle live-bid return refund has nowhere to route, so the
    ///         deploy MUST call this before the first acquisition's auction can
    ///         settle (the broadcast wires it synchronously).
    function setLiveBidAdapter(address payable _liveBidAdapter) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (liveBidAdapter != address(0)) revert AlreadyWired();
        if (_liveBidAdapter == address(0)) revert ZeroAddress();
        liveBidAdapter = _liveBidAdapter;
        emit LiveBidAdapterSet(_liveBidAdapter);
    }

    /// @inheritdoc IReturnAuctionModule
    function startSale(uint16 punkId, uint128 acquisitionCost, uint8 targetTraitId) external {
        if (msg.sender != patron) revert NotPatron();
        ReturnAuction storage s = _sales[punkId];
        // A SETTLED sale slot is reusable for a re-auction of a *returned*
        // (ReturnedToMarket) Punk — re-acquisition is gated upstream in
        // PermanentCollection.recordAcquisition (custody must be None or
        // ReturnedToMarket). Only a LIVE, not-yet-settled sale blocks a new
        // startSale. The slot is fully reset below so no field leaks across
        // auctions.
        if (s.endsAt != 0 && !s.settled) revert SaleExists(punkId);
        if (punksMarket.punkIndexToAddress(uint256(punkId)) != address(this)) {
            revert PunkNotInCustody(punkId);
        }
        uint64 _startedAt = uint64(block.timestamp);
        uint64 _endsAt = _startedAt + AUCTION_DURATION;

        // Reserve formula: `paid × (101 + previousAttempts) / 100`,
        // rounded up so the 1%-per-attempt premium is actually enforced even
        // for dust acquisitions. Integer floor would let a 1-wei acquisition
        // open with a 1-wei reserve (i.e. no premium at all); ceilDiv pushes
        // it to 2 wei so the boundary math respects the spec literally.
        // `previousAttempts` is the value of `attemptCount(target)` BEFORE
        // recordAcquisition bumps it for THIS acquisition. Patron orders the
        // calls so startSale runs first, then recordAcquisition; we add the
        // +1 manually here.
        uint256 prevAttempts = uint256(permanentCollection.attemptCount(targetTraitId));
        uint256 product = uint256(acquisitionCost) * (101 + prevAttempts);
        // ceilDiv equivalent: (a + b - 1) / b for b > 0. Guard the
        // acquisitionCost == 0 case so `reserve` stays 0 rather than wrapping.
        uint256 reserveU = product == 0 ? 0 : (product + 99) / 100;
        if (reserveU > type(uint128).max) revert ReserveOverflow(reserveU);
        uint128 reserve = uint128(reserveU);

        // Full slot (re)initialization. On a first-ever sale the stale-field
        // resets are no-ops (the slot is already zero); on a re-auction they
        // clear the prior settled auction's winner + settled flag so nothing
        // leaks across auctions.
        s.acquisitionCost = acquisitionCost;
        s.highBidWei = 0;
        s.highBidder = address(0);
        s.startedAt = _startedAt;
        s.endsAt = _endsAt;
        s.reserveWei = reserve;
        s.targetTraitId = targetTraitId;
        s.settled = false;
        // Clear stale referrer attribution from any prior auction so a
        // previous winner's referrer can't carry over — the slot tracks the
        // CURRENT auction's high-bid referrer only.
        referrerOfHighBid[punkId] = address(0);
        emit ReturnAuctionStarted(punkId, acquisitionCost, reserve, _startedAt, _endsAt);
    }

    /// @notice Place a bid on the return auction for `punkId` with NO referral
    ///         attribution — the simple, common entry point. Callers who don't
    ///         carry a referrer use this and never touch the referral params;
    ///         it is exactly `placeBidWithReferral(punkId, address(0), bytes32(0))`.
    /// @param  punkId Sale identifier.
    function placeBid(uint16 punkId) external payable nonReentrant notInSwap {
        _placeBid(punkId, address(0), bytes32(0));
    }

    /// @notice Place a bid carrying auction-referral attribution. If THIS bid
    ///         is the winning bid at settle, `referrer` earns the referral
    ///         share of the return premium.
    /// @param  punkId   Sale identifier.
    /// @param  referrer Frontend / aggregator credited with the auction-
    ///                  referral share of the premium if THIS bid is the
    ///                  winning bid at settle. `address(0)` opts out (identical
    ///                  to `placeBid`). Stored at `referrerOfHighBid[punkId]`
    ///                  and overwritten by any subsequent accepted bid.
    /// @param  tag      Free-form campaign / UTM tag emitted in `BidPlaced`
    ///                  for off-chain attribution. NOT stored on-chain;
    ///                  `bytes32(0)` if unused.
    function placeBidWithReferral(uint16 punkId, address referrer, bytes32 tag)
        external
        payable
        nonReentrant
        notInSwap
    {
        _placeBid(punkId, referrer, tag);
    }

    /// @dev Shared bid logic for `placeBid` / `placeBidWithReferral`. Must
    ///      strictly exceed the reserve (acquisitionCost + premium snapshot)
    ///      AND the current high bid. If placed within the final
    ///      `SNIPE_TRIGGER_WINDOW`, the sale extends by `SNIPE_EXTENSION`.
    ///      The extension is uncapped — actively-contested Punks stay in
    ///      active bidding for as long as bidders keep escalating. Reentrancy /
    ///      in-swap guards live on the two external entry points above.
    function _placeBid(uint16 punkId, address referrer, bytes32 tag) internal {
        ReturnAuction storage s = _sales[punkId];
        if (s.endsAt == 0) revert SaleMissing(punkId);
        if (s.settled) revert AlreadySettled(punkId);
        if (block.timestamp >= s.endsAt) revert SaleEnded(punkId);

        uint256 reserve = uint256(s.reserveWei);
        if (msg.value < reserve) revert BidBelowReserve(msg.value, reserve);
        uint256 currentHigh = uint256(s.highBidWei);
        if (currentHigh == 0) {
            // First bid only needs to meet the reserve (already checked
            // above). No increment requirement applies — there's nothing to
            // increment from. The explicit `== 0` guard matters only on the
            // `acquisitionCost == 0` edge case (reserve = 0 lets msg.value = 0
            // satisfy the reserve check); we still require a strictly positive
            // first bid so the sale has a real winning bidder if it clears.
            if (msg.value == 0) revert BidNotHigherThanCurrent(msg.value, 0);
        } else {
            // Subsequent bids must clear the configured percentage increment.
            // Caps indefinite-extension griefing by forcing geometric growth
            // of locked capital per round.
            uint256 minNext = currentHigh + (currentHigh * minBidIncrementBps) / BPS_DENOM;
            // Defensive: rounding could in principle leave `minNext == currentHigh`
            // for absurdly small `currentHigh` and `minBidIncrementBps`; ensure
            // strictly higher.
            if (minNext <= currentHigh) minNext = currentHigh + 1;
            if (msg.value < minNext) revert BidBelowMinIncrement(msg.value, minNext);
        }

        address previousBidder = s.highBidder;
        uint256 previousBid = s.highBidWei;

        s.highBidWei = uint128(msg.value);
        s.highBidder = msg.sender;
        // Overwrite the referrer slot — outbid bidders' referrers lose
        // attribution; the slot tracks only the current high bidder's referrer.
        referrerOfHighBid[punkId] = referrer;

        if (s.endsAt - block.timestamp < SNIPE_TRIGGER_WINDOW) {
            // `extended` is always strictly greater than `s.endsAt` inside
            // this branch (we only enter when `s.endsAt - block.timestamp <
            // SNIPE_TRIGGER_WINDOW < SNIPE_EXTENSION`), so no extra guard.
            uint64 extended = uint64(block.timestamp) + SNIPE_EXTENSION;
            s.endsAt = extended;
            emit ReturnAuctionExtended(punkId, extended);
        }

        // `previousBidder != address(0)` implies a prior winning bid that
        // exceeded `reserve > 0`, so `previousBid > 0` is implicit.
        if (previousBidder != address(0)) {
            (bool ok,) = previousBidder.call{value: previousBid, gas: 30_000}("");
            if (!ok) {
                pendingRefund[previousBidder] += previousBid;
                emit RefundQueued(previousBidder, previousBid);
            }
        }

        emit BidPlaced(punkId, msg.sender, referrer, msg.value, tag, s.endsAt);
    }

    /// @notice Settle the return auction after `endsAt`. Anyone may call.
    function settle(uint16 punkId) external nonReentrant notInSwap {
        ReturnAuction storage s = _sales[punkId];
        if (s.endsAt == 0) revert SaleMissing(punkId);
        if (s.settled) revert AlreadySettled(punkId);
        if (block.timestamp < s.endsAt) revert SaleLive(punkId);
        s.settled = true;

        if (s.highBidder == address(0)) {
            // Unsold — lock to vault forever, collect the target trait only.
            uint8 targetTraitId = s.targetTraitId;
            uint256 maskBeforeSettle = permanentCollection.collectedMask();
            uint256 targetBit = uint256(1) << uint256(targetTraitId);
            bool firstVaultingOfTrait = (maskBeforeSettle & targetBit) == 0;

            punksMarket.transferPunk(address(punkVault), uint256(punkId));
            punkVault.receivePunk(punkId);
            permanentCollection.markCustody(punkId, IPermanentCollection.Custody.Vaulted);
            emit PunkVaulted(punkId);

            // Issue the Proof NFT for this trait's first-vaulting. Skipped
            // when the trait was already collected (a redundant vaulting of
            // an already-lit trait — the 111-cap is preserved). The Proof's
            // recipient is the address recorded as `originalSeller` on the
            // acquisition: for `acceptBid` this is the pre-lister; for
            // `acceptListing` this is the public-listing seller (NOT the
            // finder, who has already been paid the finder fee).
            //
            // The mint is REQUIRED, not best-effort — it is bound atomically
            // to the vaulting (no `try/catch`). The Proof is part of the
            // collection's accounting surface: the biconditional
            // "a permanently-collected trait has exactly one Proof" must hold.
            // This mint is one-shot and self-unretryable in isolation:
            // once `markCustody(Vaulted)` above lights the trait bit
            // (monotonic) and the Punk enters the terminal vault, no
            // later `settle` can ever re-mint it — `firstVaultingOfTrait`
            // would be false and a Vaulted Punk can never re-auction. A
            // SWALLOWED mint failure would therefore desync the collected-trait
            // set from the Proof set permanently, with no recovery path — the
            // worst possible outcome for a records protocol. Requiring the
            // mint instead reverts the WHOLE settle on any failure (the early
            // `s.settled = true`, the `transferPunk`/`receivePunk` into the
            // vault, and `markCustody` all roll back), leaving the auction
            // settleable so the mint is simply retried on the next `settle`.
            //
            // Safe in both directions:
            //   - No griefing / DoS vector. `PunkVault.mintProofs` uses
            //     `_mint` (not `_safeMint`), so the recipient runs no code
            //     during the mint and cannot force a revert to block a Punk's
            //     vaulting.
            //   - Cannot brick a legitimate settle. The recipient is
            //     structurally non-zero (`recordAcquisition` enforces
            //     `originalSeller != 0`) and the token id (`== traitId`)
            //     is structurally fresh on a first-vaulting, so `mintProofs`
            //     has no reachable revert here. The zero-recipient case is
            //     delegated to `mintProofs`' own `InvalidRecipient` revert
            //     rather than silently skipped, so the atomic invariant holds
            //     with no escape hatch.
            if (firstVaultingOfTrait) {
                punkVault.mintProofs(
                    punkId,
                    targetTraitId,
                    permanentCollection.originalSellerOf(punkId),
                    permanentCollection.acquisitionIndexOf(punkId),
                    uint16(permanentCollection.collectedCount())
                );
            }

            // Sweep the VaultBurnPool: burn the accrued venue-tax 111 (a supply
            // reduction parallel to the cleared path's burnShare) and forward
            // any ETH to BuybackBurner. Called DIRECTLY, with no `try/catch`:
            // `sweep` is non-reverting by construction when called here — the
            // 111 burn of its own balance cannot revert and the ETH forward is
            // best-effort — so it cannot strand the Punk, and the direct call is
            // what makes the 111 burn GUARANTEED rather than a gas-skippable
            // best-effort (a caught revert lets eth_estimateGas under-provision
            // the burn). See `VaultBurnPool.sweep`.
            address payable _pool = vaultBurnPool;
            if (_pool != address(0)) {
                IVaultBurnPool(_pool).sweep();
            }

            // No keeper reward on the vault path (nor on the cleared path):
            // settle pays no protocol-funded tip and is self-incentivized —
            // here by the Proof-NFT recipient (the recorded originalSeller)
            // plus any mission-aligned party (the trait collects
            // regardless). `settle` is permissionless in both branches.
        } else {
            address buyer = s.highBidder;
            uint256 highBid = s.highBidWei;
            uint256 cost = uint256(s.acquisitionCost);

            // ─── Four-way split (cost split + auction referral):
            //
            //     live-bid share = 65% × acquisitionCost          → LiveBidAdapter
            //     burnShare      = 25% × acquisitionCost          → BuybackBurner
            //     premium        = highBid − acquisitionCost
            //     referrerShare  = referrerOfHighBid != 0
            //                      ? premium × REFERRER_PREMIUM_BPS / 10_000
            //                      : 0                            → referrer
            //                                                       (35k gas;
            //                                                        fail-closed
            //                                                        to vaultBurn)
            //     vaultBurnShare = premium − referrerShare        → VaultBurnPool
            //                      + 10% × acquisitionCost
            //
            // The reserve formula guarantees `highBid ≥ cost × (101 + N) / 100`
            // for `N = previousAttempts`, so `highBid > cost` always on a return
            // and `vaultBurnShare > 0`. Cap-the-bid-pool design: 65% of cost
            // refills the live bid (via the adapter buffer, metered) regardless
            // of how high the returner bid; the overbid premium PLUS a
            // 10%-of-cost slice flow to VaultBurnPool as future 111-burn fuel
            // instead of inflating the live bid unboundedly. Burn share is the
            // residual (25% of cost) so dust stays accounted-for without
            // leakage. If a referrer was attached to the
            // winning bid, a `REFERRER_PREMIUM_BPS` slice of the premium routes
            // to the referrer first; live-bid and burn shares are NEVER reduced
            // by referrer attribution — the auction referral comes from fresh
            // external value (the returner's voluntary overbid), not from
            // internal pools.
            uint256 liveBidShareWei = (cost * CLEARED_BID_BPS) / BPS_DENOM;
            uint256 vaultBurnFromCost = (cost * CLEARED_VAULT_BURN_BPS) / BPS_DENOM;
            uint256 burnShare = cost - liveBidShareWei - vaultBurnFromCost;
            uint256 premium = highBid - cost;

            // Snapshot the referrer at settle time so settle()'s emits and
            // arithmetic see one stable value even if the storage slot were
            // (defensively) zeroed mid-execution.
            address recordedReferrer = referrerOfHighBid[punkId];
            uint256 referrerShare = recordedReferrer != address(0)
                ? (premium * REFERRER_PREMIUM_BPS) / BPS_DENOM
                : 0;
            // VaultBurnPool gets the 10%-of-cost slice PLUS the premium
            // remainder after any referrer cut. The two are orthogonal:
            // the cost split (65/25/10) and the premium split (referrer / rest)
            // partition two independent quantities.
            uint256 vaultBurnShare = (premium - referrerShare) + vaultBurnFromCost;

            // No protocol-funded keeper tip on the cleared path: the full
            // 65%-of-cost live-bid share flows to the adapter. The winning
            // bidder has locked `highBid` ETH and receives the Punk ONLY on
            // `settle`, so settlement is self-incentivized — and `settle` is
            // permissionless for any mission-aligned party regardless.

            // Provenance round-trip: record a real `PunkBought` at the hammer
            // price on the canonical market before delivering to the winner,
            // instead of a price-less `PunkTransfer`. Net ETH movement is zero
            // — the module pays `highBid` into the market and the escrow
            // (seller of record) withdraws it straight back. The recovered
            // `highBid` then funds the proceeds split below.
            //
            // Every step here touches only trusted contracts (the canonical
            // market + our own escrow) and CryptoPunks `transferPunk` makes no
            // callback to the recipient, so the round-trip cannot be griefed.
            // The whole sequence — and the share sends — are "or-revert": any
            // failure rolls the entire settlement back (including the early
            // `s.settled = true`), leaving the sale retryable.
            uint256 pid = uint256(punkId);
            punksMarket.transferPunk(address(escrow), pid);   // module → escrow
            escrow.listForSettlement(pid, highBid);           // escrow lists to module @ highBid
            punksMarket.buyPunk{value: highBid}(pid);         // PunkBought(escrow, module, highBid)
            escrow.sweepProceeds();                            // proceeds round-trip back to module
            punksMarket.transferPunk(buyer, pid);             // module → winning bidder

            if (liveBidShareWei > 0) {
                // Route the live-bid return refund through the adapter buffer:
                // it meters into Patron via `sweep`, so
                // a large return refund fast-replenishes a low bid but never
                // overshoots a bid that's already at/above the activation
                // threshold. The adapter's `poolReplenish` is module-only; THIS
                // module is the caller, so the gate passes.
                (bool ok1,) = liveBidAdapter.call{value: liveBidShareWei}(
                    abi.encodeWithSignature("poolReplenish(uint16)", punkId)
                );
                if (!ok1) revert TransferFailed();
            }
            if (burnShare > 0) {
                (bool ok2,) = buybackBurner.call{value: burnShare}("");
                if (!ok2) revert TransferFailed();
            }
            // Pay the auction referrer FIRST (before vaultBurn) so a
            // reverting / OOG referrer can fold their share back into
            // vaultBurnShare cleanly. Net invariant: live-bid share and
            // burnShare are NEVER reduced by referrer attribution; the
            // entire premium ends up split between referrer and
            // VaultBurnPool, regardless of the referrer's behaviour.
            if (referrerShare > 0) {
                (bool refOk,) =
                    recordedReferrer.call{value: referrerShare, gas: REFERRER_GAS}("");
                if (!refOk) {
                    // Fail-closed: roll the share into VaultBurnPool. The
                    // referrer keeps no claim; subsequent settle()s for
                    // other Punks are unaffected.
                    vaultBurnShare += referrerShare;
                    referrerShare = 0;
                }
            }
            if (vaultBurnShare > 0) {
                // Overbid premium (minus any successfully-paid referrer
                // slice) + 10%-of-cost slice → VaultBurnPool. Released as
                // 111-burn fuel on the next vault-path settle.
                (bool ok4,) = vaultBurnPool.call{value: vaultBurnShare}("");
                if (!ok4) revert TransferFailed();
            }

            // CEI: record the custody transition (the protocol-essential
            // state effect) after the proceeds split. The only external
            // interaction in this branch that touches an untrusted party is
            // the gas-bounded, fail-closed referrer send above; every other
            // send targets a trusted PC contract. `settle` is `nonReentrant`
            // and `settled` is already true. No keeper-reward send follows —
            // the cleared path pays no protocol-funded tip.
            permanentCollection.markCustody(punkId, IPermanentCollection.Custody.ReturnedToMarket);

            emit ReturnAuctionCleared(
                punkId,
                buyer,
                recordedReferrer,
                highBid,
                liveBidShareWei,
                burnShare,
                vaultBurnShare,
                referrerShare
            );
        }
    }

    /// @notice Pull queued refunds for `msg.sender` (refunds that failed to
    ///         push during a `bid` call). Idempotent — zeroes the balance
    ///         before sending.
    function withdrawRefund() external nonReentrant notInSwap {
        uint256 amt = pendingRefund[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        pendingRefund[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit RefundWithdrawn(msg.sender, amt);
    }

    // ────────── views ──────────

    /// @notice Full sale struct for `punkId`. Returns zero-valued struct if
    ///         no sale has ever started for this Punk.
    function getSale(uint16 punkId) external view returns (ReturnAuction memory) {
        return _sales[punkId];
    }

    /// @notice Bid floor for `punkId`. Snapshotted at `startSale`.
    function reserveOf(uint16 punkId) external view returns (uint256) {
        return uint256(_sales[punkId].reserveWei);
    }

    /// @notice Current winning bid amount. 0 if no bids yet.
    function highBidOf(uint16 punkId) external view returns (uint128) {
        return _sales[punkId].highBidWei;
    }

    /// @notice Current winning bidder. `address(0)` if no bids yet.
    function highBidderOf(uint16 punkId) external view returns (address) {
        return _sales[punkId].highBidder;
    }

    /// @notice Current `endsAt` for the sale (extensions included).
    function endsAt(uint16 punkId) external view returns (uint64) {
        return _sales[punkId].endsAt;
    }

    /// @notice `block.timestamp` when `startSale` ran.
    function startedAt(uint16 punkId) external view returns (uint64) {
        return _sales[punkId].startedAt;
    }

    /// @notice True iff the sale is currently accepting bids.
    function isLive(uint16 punkId) external view returns (bool) {
        ReturnAuction storage s = _sales[punkId];
        return s.endsAt != 0 && !s.settled && block.timestamp < s.endsAt;
    }

    /// @notice True iff `settle(punkId)` would succeed right now.
    function isSettleable(uint16 punkId) external view returns (bool) {
        ReturnAuction storage s = _sales[punkId];
        return s.endsAt != 0 && !s.settled && block.timestamp >= s.endsAt;
    }
}
