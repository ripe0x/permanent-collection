// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPatron} from "./interfaces/IPatron.sol";
import {ICryptoPunksMarket} from "./interfaces/ICryptoPunksMarket.sol";
import {IPermanentCollection} from "./interfaces/IPermanentCollection.sol";
import {IReturnAuctionModule} from "./interfaces/IReturnAuctionModule.sol";
import {IPunksData} from "./interfaces/IPunksData.sol";
import {ProtocolAdmin} from "./ProtocolAdmin.sol";
import {OneTimeSetup} from "./libraries/OneTimeSetup.sol";
import {PCNoReentry} from "./libraries/PCNoReentry.sol";
import {PCReentrancyGuard} from "./libraries/PCReentrancyGuard.sol";

/// @title  Patron
/// @notice Entry-point hub. Holds the global live-bid ETH and exposes two
///         acquisition paths:
///
///         1. `acceptBid(punkId, targetTraitId, expectedListingWei)` — a Punk
///            owner lists their Punk to this contract at a real price via the
///            2017 market's `offerPunkForSaleToAddress(punkId, price, patron)`
///            (exclusive to this contract), with `price` set to ~the current
///            `bidBalance`. Anyone may then call here: the contract buys the
///            Punk at the listed price, hands it to ReturnAuctionModule, and
///            records the acquisition. The seller is paid the listed price by
///            the market (`pendingWithdrawals`) and collects it with
///            `withdraw()` — Patron pushes them nothing. The listed price must
///            be positive, at or below the live bid, and at or below the
///            caller's `expectedListingWei` cap.
///
///         2. `acceptListing(punkId, targetTraitId)` — anyone can call. Buys
///            an eligible Punk that an *allowlisted* seller has publicly
///            listed on the 2017 market at `minValue ≤ bidBalance`. Pays
///            a small finder fee to the caller. The allowlist is admin-
///            managed; PunkStrategy is the launch entry.
///
///         Both paths revert with `TargetTraitPending` if a return auction is
///         already in flight for the chosen target trait — only one in-
///         flight attempt per uncollected trait is permitted at a time, to
///         avoid wasteful "racing" acquisitions that would lock a Punk in
///         the vault without contributing a new collected bit.
///
///         Patron's accounted live bid fills ONLY via the `liveBidAdapter`:
///         every ETH source that funds the live bid (trading fees, attributed
///         `contribute` top-ups, bare sends, and the cleared return-auction
///         return refund) enters the adapter, which buffers and meters them in.
///         `receive()` rejects any normal sender other than the adapter
///         (`NotAdapter`). Forced ETH is deliberately excluded from bid and
///         reserve math and can only be forwarded back to the adapter as
///         surplus.
///
/// @dev    No admin withdrawal path. The contract's only ETH outflows are
///         (a) the listed price paid to the 2017 market via `buyPunk` on
///         `acceptBid` / `acceptListing` (the seller collects it from the
///         market, not from Patron), (b) the caller's finder fee on
///         `acceptListing`, and (c) surplus/unaccounted ETH forwarded back to
///         the adapter.
///
///         Economic parameter setters revert after the 1y `ProtocolAdmin`
///         auto-lock. **Allowlist setters remain active indefinitely** so
///         the protocol can recognize new aligned peer protocols past lock.
///         This is one of the protocol's raw-admin carve-outs — the stale
///         admin key can keep adding/removing allowed sellers forever unless
///         burned via `ProtocolAdmin.transferAdmin(address(0))`.
contract Patron is IPatron, OneTimeSetup, PCNoReentry, PCReentrancyGuard {
    // ──────────────── Errors ────────────────

    error NotAdmin();
    /// @notice `receive()` was called by anyone other than the
    ///         `liveBidAdapter`. The adapter is the sole faucet into the live
    ///         bid — every ETH source routes through it (its `receive` /
    ///         `contribute` / `poolReplenish`) where it is buffered and metered,
    ///         so a direct send to Patron is rejected rather than spiking the
    ///         available bid.
    error NotAdapter();
    error ZeroAddress();
    error AlreadyInitialized();
    error InvalidPunkId(uint16 punkId);
    error PunkNotListedToHub(uint16 punkId);
    error PunkAlreadyAcquired(uint16 punkId);
    error PunkNotPubliclyListed(uint16 punkId);
    error SellerNotAllowed(address seller);
    error ListingExceedsBid(uint256 listing, uint256 liveBid);
    error BidBelowMinimum(uint256 liveBid, uint256 minimum);
    error ZeroListingPrice(uint16 punkId);
    error FinderPaymentFailed();
    error PunkTransferFailed();
    error InvalidTargetTrait(uint16 punkId, uint8 targetTraitId);
    error TargetTraitAlreadyCollected(uint8 targetTraitId);
    error TargetTraitPending(uint8 targetTraitId);
    /// @notice Mirror of `PermanentCollection.SoleCarrierMustTargetTrait` —
    ///         the chosen target on a sole-carrier Punk is not the trait that
    ///         Punk uniquely carries. Early/cheap revert; the authoritative
    ///         guard lives in `recordAcquisition`.
    error SoleCarrierMustTargetTrait(uint16 punkId, uint8 requiredTraitId);
    /// @notice Mirror of `PermanentCollection.TargetNotCanonical` — the
    ///         supplied target is not the protocol-derived canonical target
    ///         (the rarest uncollected, non-pending trait the Punk carries).
    ///         The protocol picks the target so a scarce-trait carrier can't be
    ///         wasted on a common trait; early/cheap revert, authoritative rule
    ///         in `recordAcquisition`.
    error NotCanonicalTarget(uint16 punkId, uint8 provided, uint8 canonical);
    /// @notice `acceptBid` listed price exceeds the caller's
    ///         `expectedListingWei` cap — the seller raised the price after the
    ///         caller's read. The caller is protected from overpaying.
    error ListingAboveExpected(uint256 listing, uint256 expected);
    error SellerNotYetActive(address seller, uint64 activeAt);
    error NoSurplus();
    error SurplusForwardFailed();

    // ──────────────── Events ────────────────

    /// @notice Emitted on a successful `acceptBid`. `payout` is the listed
    ///         price the seller is paid through the market (`pendingWithdrawals`).
    event BidAccepted(uint16 indexed punkId, address indexed seller, uint256 payout);
    /// @notice Emitted on a successful `acceptListing`. `minValue` is what
    ///         we paid the listing seller via `buyPunk`; `finderFee` is the
    ///         keeper reward we paid the caller.
    event ListingAccepted(
        uint16 indexed punkId, address indexed seller, address indexed caller, uint256 minValue, uint256 finderFee
    );

    // NOTE: inflow events (`BareTopUp` / `Contribution` / `PoolReplenished`)
    // live on `LiveBidAdapter`, the single faucet — every ETH source that funds
    // the live bid enters through the adapter, which buffers and meters into
    // Patron. Patron's `receive()` accepts ETH ONLY from the adapter (invariant
    // #13 + the `NotAdapter` gate), so it has no direct-inflow surface to log.

    /// @notice Admin added an address to the listing-seller allowlist.
    event AllowedSellerAdded(address indexed seller);
    /// @notice Admin removed an address from the listing-seller allowlist.
    event AllowedSellerRemoved(address indexed seller);

    /// @notice Emitted once at `setWiring` time. Both addresses are
    ///         permanently fixed after this fires.
    event WiringFinalized(address indexed permanentCollection, address indexed returnAuctionModule);
    /// @notice Emitted when forced/unaccounted ETH is forwarded back to the
    ///         adapter buffer. This ETH is not part of the live bid until the
    ///         adapter meters it in through its normal sweep/stream paths.
    event SurplusForwarded(address indexed caller, uint256 amount);

    // ──────────────── Immutable refs ────────────────

    /// @notice The 2017 CryptoPunks market (mainnet `0xb47e…3BBB`). All
    ///         Punk-side state transitions (buy/transfer/listing checks)
    ///         flow through this interface.
    ICryptoPunksMarket public immutable punksMarket;
    /// @notice The sealed PunksData dataset. Read for trait masks on every
    ///         acquisition; re-verified inside `PermanentCollection`.
    IPunksData public immutable punksData;
    /// @notice The protocol's time-locked admin. Economic-parameter setters
    ///         gate on `checkAdmin` (locks at 1y); allowlist setters gate on
    ///         the raw `admin()` getter and remain editable until the role
    ///         is burned.
    ProtocolAdmin public immutable adminContract;

    // ──────────────── One-time wiring ────────────────

    /// @notice Records-only core. Patron is the only address authorized to
    ///         call its `recordAcquisition` writer.
    IPermanentCollection public permanentCollection;
    /// @notice The 72-hour return auction. Patron transfers acquired Punks to it
    ///         immediately after `buyPunk` and calls `startSale`.
    IReturnAuctionModule public returnAuctionModule;
    /// @notice The single inflow governor. Set once at `setWiring`; effectively
    ///         immutable thereafter. This is the ONLY address `receive()`
    ///         accepts ETH from — every source (fees, contributions, bare
    ///         sends, return refunds) routes through the adapter, which buffers
    ///         and meters into the bid. Patron's balance fills only via the
    ///         adapter's `sweep`.
    address public liveBidAdapter;

    /// @notice Logical live bid funded through `liveBidAdapter`. This is the
    ///         only value used for `acceptBid`, `acceptListing`, acquisition
    ///         cost, finder-fee, and reserve math. Raw contract balance can be
    ///         larger because ETH can be force-sent without calling `receive()`;
    ///         such surplus is not counted here.
    uint256 public accountedLiveBidWei;

    // ──────────────── Allowlist (editable indefinitely) ────────────────

    /// @notice Per-address eligibility for `acceptListing`. Public listings
    ///         from non-allowlisted sellers are not consumable by the
    ///         protocol. Editable indefinitely via `addAllowedSeller` /
    ///         `removeAllowedSeller` — a scoped raw-admin carve-out.
    mapping(address => bool) public allowedSellers;

    /// @notice Timestamp at which an allowlisted seller becomes consumable
    ///         by `acceptListing`. Set to `block.timestamp + ALLOWLIST_DELAY`
    ///         when `addAllowedSeller` runs. Zero when not allowlisted.
    ///         The delay gives the community a window to react to a hostile
    ///         allowlist addition (whether from a compromised admin key or a
    ///         misconfiguration). Existing allowlisted sellers are unaffected
    ///         by re-adds (`addAllowedSeller` is idempotent on `allowedSellers`).
    mapping(address => uint64) public allowedSellerActiveAt;

    /// @notice Delay between `addAllowedSeller` and the seller's listings
    ///         becoming consumable. 24 hours — enough for monitoring and
    ///         emergency `removeAllowedSeller` if a hostile add slips through.
    uint64 public constant ALLOWLIST_DELAY = 24 hours;

    // ──────────────── Tunable parameters ────────────────

    // Note: the creator's share of artcoins LP fees is set in the locker's
    // rewardBps array at deploy time (see Deploy.s.sol). Patron has no
    // setter for it. Changing the creator's share post-deploy goes through
    // the locker via `updateRewardRecipient` on slot 2, gated by the
    // deployer EOA admin.

    // NOTE: Patron has no attributed-contribution surface. `contribute` and
    // its referrer split (`REFERRER_CONTRIB_BPS` / `REFERRER_GAS`) live on
    // `LiveBidAdapter`, which pays any contribution referrer and buffers the
    // remainder into the bid.

    /// @notice Cap on the finder fee paid to `acceptListing` callers,
    ///         expressed as bps of the current bidBalance. Fixed at 50
    ///         (= 0.5%) — a protocol constant, not admin-tunable.
    /// @dev    The finder fee is a small keeper tip for triggering an
    ///         acquisition from an allowlisted public listing; the fee paid
    ///         is `min(bidBalance × finderFeeCapBps / 10_000, finderFeeFixedCap)`.
    ///         Its only design requirement is "stay boringly bounded," which a
    ///         constant satisfies directly — so the value carries no admin
    ///         setter and no compromised-key vector to inflate it. The bps
    ///         term only binds while the bid sits in the narrow
    ///         `[MIN_BID_FOR_LISTING, ~2 ETH]` window; above that the absolute
    ///         cap dominates.
    uint256 public constant finderFeeCapBps = 50;

    /// @notice Absolute cap on the finder fee paid to `acceptListing`
    ///         callers. Fixed at 0.01 ETH — a protocol constant, not
    ///         admin-tunable.
    /// @dev    With the live bid seeded well above `MIN_BID_FOR_LISTING`, this
    ///         absolute cap is what binds in practice. Frozen by the same
    ///         reasoning as `finderFeeCapBps`: a keeper tip only needs to be
    ///         bounded, and the natural caller of `acceptListing` (the
    ///         allowlisted seller itself) is aligned, so the tip is never
    ///         load-bearing for the path to function.
    uint256 public constant finderFeeFixedCap = 0.01 ether;

    /// @notice Minimum bidBalance required for `acceptListing` to fire.
    ///         Defends against pathological dust-listings draining finder fees
    ///         against trivial live bids.
    uint256 public constant MIN_BID_FOR_LISTING = 0.5 ether;

    /// @notice Sole-carrier guard mirror. #8348 is the
    ///         UNIQUE carrier of trait bit 23 ("7 Attributes") in the sealed
    ///         dataset. `PermanentCollection.recordAcquisition` is the
    ///         authoritative enforcement point; these mirror its constants so
    ///         both acquisition entry points can revert early/cheaply (before
    ///         `buyPunk` + transfer) instead of after. Internal — the public
    ///         getters live on `PermanentCollection`. The dataset is sealed, so
    ///         these can never drift.
    uint16 internal constant SOLE_CARRIER_PUNK_ID = 8348;
    uint8 internal constant SOLE_CARRIER_TRAIT_BIT = 23;

    uint256 internal constant BPS_DENOM = 10_000;

    // Reentrancy guard (`nonReentrant`) is inherited from PCReentrancyGuard —
    // cross-function, covering `acceptBid` and `acceptListing` so a malicious
    // seller / listing contract can't re-enter while a payout call is in flight.

    /// @dev Admin role used for the allowlist — same admin, but bypasses the
    ///      1y auto-lock. The allowlist is a scoped raw-admin carve-out and is
    ///      Patron's ONLY admin-gated surface: the finder-fee parameters are
    ///      protocol constants, so there is no `checkAdmin`-gated (1y-locking)
    ///      setter on Patron.
    modifier onlyAdminEvenIfLocked() {
        if (msg.sender != adminContract.admin()) revert NotAdmin();
        _;
    }

    // ──────────────── Construction ────────────────

    /// @param _punksMarket    Mainnet 2017 CryptoPunks market.
    /// @param _punksData      Sealed PunksData dataset.
    /// @param _adminContract  Pre-deployed `ProtocolAdmin` (admin EOA set
    ///                        inside that contract, not here).
    /// @param _swapContext    `PCSwapContext` for the dormant Design B
    ///                        reentrancy guard. See `PCNoReentry`.
    constructor(
        address _punksMarket,
        address _punksData,
        address _adminContract,
        address _swapContext
    ) OneTimeSetup() PCNoReentry(_swapContext) {
        if (_punksMarket == address(0) || _punksData == address(0) || _adminContract == address(0)) {
            revert ZeroAddress();
        }
        punksMarket = ICryptoPunksMarket(_punksMarket);
        punksData = IPunksData(_punksData);
        adminContract = ProtocolAdmin(_adminContract);
    }

    /// @notice One-shot wiring of `PermanentCollection` + `ReturnAuctionModule`
    ///         + `LiveBidAdapter`. Resolves the constructor-time cycle: Patron
    ///         needs all three addresses, but the records core and the return
    ///         auction both reference Patron in their constructors, and the
    ///         adapter is deployed after Patron. The deployer calls this once
    ///         after the adapter is deployed, then `_markFinalized()`
    ///         permanently closes the setup gate.
    /// @dev    Reverts `NotDeployer` (via `onlySetup`) if caller is not
    ///         the deployer. Reverts `AlreadyFinalized` on second call.
    ///         Reverts `AlreadyInitialized` if `permanentCollection` is
    ///         already non-zero — belt-and-suspenders alongside the
    ///         setup gate.
    /// @param _permanentCollection The records core. Only this contract's
    ///        `recordAcquisition` is callable from Patron afterward.
    /// @param _finalSaleModule The 72-hour return auction. Patron transfers
    ///        each acquired Punk to it and calls `startSale` immediately
    ///        after every `buyPunk` in `acceptBid` / `acceptListing`.
    /// @param _liveBidAdapter The single inflow governor. After this call,
    ///        `receive()` accepts ETH ONLY from this address.
    function setWiring(
        address _permanentCollection,
        address _finalSaleModule,
        address _liveBidAdapter
    ) external onlySetup {
        if (_permanentCollection == address(0) || _finalSaleModule == address(0) || _liveBidAdapter == address(0)) {
            revert ZeroAddress();
        }
        if (address(permanentCollection) != address(0)) revert AlreadyInitialized();
        permanentCollection = IPermanentCollection(_permanentCollection);
        returnAuctionModule = IReturnAuctionModule(_finalSaleModule);
        liveBidAdapter = _liveBidAdapter;
        _markFinalized();
        emit WiringFinalized(_permanentCollection, _finalSaleModule);
    }

    // ──────────────── ETH inflow ────────────────

    /// @notice Accept ETH ONLY from the `liveBidAdapter`. The adapter is the
    ///         single faucet into the live bid: it buffers every source (fees,
    ///         contributions, bare sends, return refunds) and meters them into
    ///         Patron via its `sweep`, so `accountedLiveBidWei` rises smoothly
    ///         and never spikes above what eligible Punks accept for. Any other
    ///         normal sender is rejected with `NotAdapter` — direct top-ups
    ///         must go to `LiveBidAdapter.receive()` / `contribute()` instead.
    ///         Forced ETH bypasses this function, so it is excluded from
    ///         `accountedLiveBidWei`.
    ///
    /// @dev    No admin path; the only ways ETH leaves Patron are
    ///         `acceptBid` / `acceptListing`. The attributed-contribution
    ///         surface (`contribute`) and the cleared-auction refund surface
    ///         (`poolReplenish`) live on the adapter.
    receive() external payable {
        if (msg.sender != liveBidAdapter) revert NotAdapter();
        accountedLiveBidWei += msg.value;
    }

    /// @notice Forward forced/unaccounted ETH back to the adapter buffer.
    ///         Surplus can exist because the EVM can credit ETH without calling
    ///         `receive()`. This function keeps that ETH out of the live bid
    ///         until the adapter meters it in under the same rate cap as every
    ///         other inflow.
    function skimSurplus() external nonReentrant notInSwap returns (uint256 amount) {
        uint256 balance = address(this).balance;
        uint256 accounted = accountedLiveBidWei;
        if (balance <= accounted) revert NoSurplus();
        if (liveBidAdapter == address(0)) revert ZeroAddress();
        amount = balance - accounted;
        (bool ok,) = liveBidAdapter.call{value: amount}("");
        if (!ok) revert SurplusForwardFailed();
        emit SurplusForwarded(msg.sender, amount);
    }

    // ──────────────── Shared acquisition guards ────────────────

    /// @dev Shared target-trait validation for both `acceptBid` and
    ///      `acceptListing`. Reverts if the target isn't present on the Punk,
    ///      is already collected, violates the sole-carrier guard, or is
    ///      already pending in another return auction. Returns the
    ///      Punk's trait mask (both callers need it for `recordAcquisition`).
    ///      `PermanentCollection.recordAcquisition` re-validates these
    ///      authoritatively; this is the cheap early guard so an invalid choice
    ///      doesn't waste the buyPunk + transfer.
    function _validateTarget(
        uint16 punkId,
        uint8 targetTraitId
    ) internal view returns (uint256 mask) {
        mask = punksData.traitMaskOf(punkId);
        uint256 collected = permanentCollection.collectedMask();
        if (targetTraitId >= 111 || (mask >> targetTraitId) & 1 == 0) {
            revert InvalidTargetTrait(punkId, targetTraitId);
        }
        if ((collected >> targetTraitId) & 1 == 1) {
            revert TargetTraitAlreadyCollected(targetTraitId);
        }
        if (
            punkId == SOLE_CARRIER_PUNK_ID && (collected >> SOLE_CARRIER_TRAIT_BIT) & 1 == 0
                && targetTraitId != SOLE_CARRIER_TRAIT_BIT
        ) {
            revert SoleCarrierMustTargetTrait(punkId, SOLE_CARRIER_TRAIT_BIT);
        }
        if (permanentCollection.pendingTraitCount(targetTraitId) > 0) {
            revert TargetTraitPending(targetTraitId);
        }
        // Protocol picks the target: it MUST equal the canonical (rarest
        // uncollected, non-pending) trait the Punk carries. The authoritative
        // rule is in `PermanentCollection.recordAcquisition`; this is the
        // early/cheap mirror so a non-canonical target reverts before the
        // buyPunk + transfer. The caller passes it as a verified expectation
        // (read `canonicalTargetOf` off-chain), so a target that shifted before
        // the tx landed fails loud here rather than recording another trait.
        uint8 canonical = permanentCollection.canonicalTargetOf(punkId);
        if (targetTraitId != canonical) {
            revert NotCanonicalTarget(punkId, targetTraitId, canonical);
        }
    }

    /// @dev Shared re-acquisition (custody) gate for both entry points.
    ///      Allowed from custody None (never acquired) or ReturnedToMarket
    ///      (rescued in a prior return auction); rejected when InReturnAuction
    ///      (an auction is live) or Vaulted (terminal). Mirrors the
    ///      authoritative gate in `PermanentCollection.recordAcquisition`.
    function _checkCustody(
        uint16 punkId
    ) internal view {
        IPermanentCollection.Custody cust = permanentCollection.custodyOf(punkId);
        if (cust == IPermanentCollection.Custody.InReturnAuction || cust == IPermanentCollection.Custody.Vaulted) {
            revert PunkAlreadyAcquired(punkId);
        }
    }

    // ──────────────── Shared acquisition tail ────────────────

    /// @dev Common tail for both entry points: debit the live bid by `cost`,
    ///      buy the Punk from the 2017 market at `cost`, hand it to the return
    ///      auction, and record the acquisition. The caller MUST have completed
    ///      all listing / target / custody validation (and any finder-fee
    ///      accounting) before invoking this. `acquirer` is recorded as the
    ///      acquirer (the owner on `acceptBid`, the finder on `acceptListing`);
    ///      `originalSeller` is the Punk's giver-up and the future Proof
    ///      recipient. The debit precedes the external `buyPunk`
    ///      (checks-effects-interactions); both entry points are `nonReentrant`.
    function _acquire(
        uint16 punkId,
        uint8 targetTraitId,
        uint256 mask,
        uint256 cost,
        address acquirer,
        address originalSeller
    ) internal {
        accountedLiveBidWei -= cost;

        // The market credits `cost` to the seller's `pendingWithdrawals`; they
        // collect with `withdraw()`. Patron pushes the seller nothing.
        punksMarket.buyPunk{value: cost}(uint256(punkId));
        if (punksMarket.punkIndexToAddress(uint256(punkId)) != address(this)) {
            revert PunkTransferFailed();
        }

        punksMarket.transferPunk(address(returnAuctionModule), uint256(punkId));
        returnAuctionModule.startSale(punkId, uint128(cost), targetTraitId);

        permanentCollection.recordAcquisition(punkId, targetTraitId, mask, acquirer, originalSeller, cost);
    }

    // ──────────────── Entry point: acceptBid ────────────────

    /// @notice Accept the live bid for `punkId`. The Punk's owner MUST have
    ///         listed it EXCLUSIVELY to this contract at a real price via the
    ///         2017 market's `offerPunkForSaleToAddress(punkId, price, patron)`,
    ///         with `price` set to ~the current `bidBalance`. Anyone may then
    ///         call this — the target trait is protocol-derived, so there is no
    ///         caller discretion to front-run, and the seller (the listing's
    ///         owner) is paid regardless of who calls. The contract buys the
    ///         Punk at the listed price and routes it into the return auction.
    ///         The seller is paid the listed price by the market
    ///         (`pendingWithdrawals`) and collects it with `withdraw()`; Patron
    ///         pushes them nothing.
    /// @param  punkId             The Punk being accepted.
    /// @param  targetTraitId      The protocol-derived canonical target,
    ///                            verified against `canonicalTargetOf`. A target
    ///                            that shifted before inclusion reverts
    ///                            `NotCanonicalTarget` rather than recording a
    ///                            different permanent trait.
    /// @param  expectedListingWei Caller's cap on the price the protocol will
    ///                            pay; reverts `ListingAboveExpected` if the
    ///                            seller raised the listed price past it.
    function acceptBid(
        uint16 punkId,
        uint8 targetTraitId,
        uint256 expectedListingWei
    ) external nonReentrant notInSwap {
        if (punkId >= 10_000) revert InvalidPunkId(punkId);

        // 1. The Punk must be listed EXCLUSIVELY to this contract at a real
        //    (non-zero) price. Exclusivity blocks a third-party snipe and is
        //    the seller's explicit "sell to the protocol" signal.
        (bool isForSale,, address seller, uint256 listingWei, address onlySellTo) =
            punksMarket.punksOfferedForSale(uint256(punkId));
        if (!isForSale || onlySellTo != address(this)) revert PunkNotListedToHub(punkId);
        if (listingWei == 0) revert ZeroListingPrice(punkId);

        // 2. Price bounds. The listed price must be affordable from the live
        //    bid (can't list above the pool) and at or below the caller's
        //    `expectedListingWei` cap, which protects a third-party finalizer
        //    from a price the seller raised after the caller's read. Any
        //    positive price up to the bid is accepted; the return auction's
        //    open-market exposure is what keeps a slot-occupation grief
        //    economically irrational, so no reserve floor is needed.
        uint256 bid = accountedLiveBidWei;
        if (listingWei > bid) revert ListingExceedsBid(listingWei, bid);
        if (listingWei > expectedListingWei) revert ListingAboveExpected(listingWei, expectedListingWei);

        // 3. Target + custody validation (defence in depth; the records core
        //    re-validates authoritatively in recordAcquisition).
        uint256 mask = _validateTarget(punkId, targetTraitId);
        _checkCustody(punkId);

        // 4. Buy at the listed price and route into the return auction. On the
        //    live-bid path the seller is both acquirer and originalSeller — the
        //    owner gave up the Punk and receives any future Proof.
        _acquire(punkId, targetTraitId, mask, listingWei, seller, seller);

        emit BidAccepted(punkId, seller, listingWei);
    }

    // ──────────────── Entry point: acceptListing ────────────────

    function acceptListing(
        uint16 punkId,
        uint8 targetTraitId
    ) external nonReentrant notInSwap {
        if (punkId >= 10_000) revert InvalidPunkId(punkId);

        uint256 liveBidBal = accountedLiveBidWei;
        if (liveBidBal < MIN_BID_FOR_LISTING) {
            revert BidBelowMinimum(liveBidBal, MIN_BID_FOR_LISTING);
        }

        // 1. Read listing state. Must be a PUBLIC listing from an allowlisted,
        //    active seller at a non-zero price.
        (bool isForSale,, address seller, uint256 minValue, address onlySellTo) =
            punksMarket.punksOfferedForSale(uint256(punkId));
        if (!isForSale || onlySellTo != address(0)) revert PunkNotPubliclyListed(punkId);
        if (!allowedSellers[seller]) revert SellerNotAllowed(seller);
        {
            uint64 activeAt = allowedSellerActiveAt[seller];
            if (block.timestamp < activeAt) revert SellerNotYetActive(seller, activeAt);
        }
        if (minValue == 0) revert ZeroListingPrice(punkId);

        // 2. Compute finder fee (bounded by both bps + absolute caps) and verify
        //    the total outflow (listed price + finder fee) fits the live bid.
        uint256 finderFee = (liveBidBal * finderFeeCapBps) / BPS_DENOM;
        if (finderFee > finderFeeFixedCap) finderFee = finderFeeFixedCap;
        uint256 totalOut = minValue + finderFee;
        if (totalOut > liveBidBal) revert ListingExceedsBid(totalOut, liveBidBal);

        // 3. Target + custody validation (same guards as acceptBid).
        uint256 mask = _validateTarget(punkId, targetTraitId);
        _checkCustody(punkId);

        // 4. Debit the finder fee, then acquire at the listed price via the
        //    shared tail. The caller is the recorded `acquirer` (and earns the
        //    finder fee below); the public-listing `seller` is the
        //    `originalSeller` and future Proof recipient — a distinct address
        //    from the third-party finder who triggered the acceptance. The
        //    seller is paid `minValue` by the market (pendingWithdrawals).
        accountedLiveBidWei -= finderFee;
        _acquire(punkId, targetTraitId, mask, minValue, msg.sender, seller);

        // 5. Pay the caller the finder fee.
        if (finderFee > 0) {
            (bool ok,) = msg.sender.call{value: finderFee}("");
            if (!ok) revert FinderPaymentFailed();
        }

        emit ListingAccepted(punkId, seller, msg.sender, minValue, finderFee);
    }

    // ──────────────── Allowlist management (no 1y lock) ────────────────

    /// @notice Recognize `seller` as an eligible source for `acceptListing`.
    ///         Idempotent — no event if already allowlisted.
    /// @dev    Editable past the 1y admin lock; a scoped raw-admin carve-out.
    ///         Burned only via
    ///         `ProtocolAdmin.transferAdmin(address(0))`.
    function addAllowedSeller(
        address seller
    ) external onlyAdminEvenIfLocked {
        if (seller == address(0)) revert ZeroAddress();
        if (!allowedSellers[seller]) {
            allowedSellers[seller] = true;
            // Defer eligibility for `ALLOWLIST_DELAY` so a hostile add can be
            // caught and reverted via `removeAllowedSeller` before any
            // listings from `seller` are consumable.
            allowedSellerActiveAt[seller] = uint64(block.timestamp) + ALLOWLIST_DELAY;
            emit AllowedSellerAdded(seller);
        }
    }

    /// @notice De-list `seller` from the allowlist. Idempotent.
    function removeAllowedSeller(
        address seller
    ) external onlyAdminEvenIfLocked {
        if (allowedSellers[seller]) {
            allowedSellers[seller] = false;
            // Zero the activation timer so a later re-add re-engages the
            // full delay (it would be set again in `addAllowedSeller`, but
            // an explicit reset keeps the storage state legible).
            allowedSellerActiveAt[seller] = 0;
            emit AllowedSellerRemoved(seller);
        }
    }

    // ──────────────── Economic parameters: none tunable ────────────────
    //
    // `finderFeeCapBps` / `finderFeeFixedCap` are protocol constants (see
    // their declarations above). Patron exposes no `checkAdmin`-gated
    // economic setter — only the raw-admin allowlist carve-out remains, and
    // that lives in the allowlist-management section above.

    // ──────────────── Views ────────────────

    /// @notice The current logical live bid pool — adapter-accounted ETH only.
    ///         Raw balance may be higher if ETH was force-sent; unaccounted
    ///         surplus is excluded from payout and reserve math.
    function bidBalance() external view returns (uint256) {
        return accountedLiveBidWei;
    }
}
