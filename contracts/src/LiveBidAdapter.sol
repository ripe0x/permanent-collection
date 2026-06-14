// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPCAcquisitionReader} from "./interfaces/IPCAcquisitionReader.sol";
import {IPreSwapStream} from "./interfaces/IPreSwapStream.sol";
import {ProtocolAdmin} from "./ProtocolAdmin.sol";
import {PCNoReentry} from "./libraries/PCNoReentry.sol";
import {PCReentrancyGuard} from "./libraries/PCReentrancyGuard.sol";

/// @title  LiveBidAdapter
/// @notice The single inflow governor for the live bid. Sits between every
///         ETH source that funds the bid and the `Patron`, buffering each
///         inflow and metering it onward so the live bid rises smoothly toward
///         realistic Punk prices and never spikes. `Patron.receive()` accepts
///         ETH ONLY from this adapter — so this contract is the sole faucet
///         into the live bid.
///
///         Inflow sources, all buffered here:
///           - trading-fee skim — the hook pushes the bid-leg skim and the
///             FeeAutoSwapper pushes converted LP fees into `receive()`
///             (native-ETH-paired pool, so no WETH unwrap);
///           - `contribute(referrer, tag)` — attributed top-ups (pays the
///             referrer `REFERRER_CONTRIB_BPS`, buffers the remainder);
///           - `receive()` — bare unattributed top-ups from anyone;
///           - `poolReplenish(punkId)` — the cleared return-auction return
///             refund, routed here (module-only) by `ReturnAuctionModule`.
///
///         All entry points are permissionless except `poolReplenish` (which
///         is gated to `returnAuctionModule` so its punk-keyed event can't be
///         spoofed). The buffer drains toward Patron through two paths — the
///         keeper/UI `sweep()` and the hook-driven `streamForward()` — under a
///         two-mode meter keyed on Patron's balance vs `activationThreshold`:
///
///           - **Below the threshold (fast mode).** The buffer forwards with no
///             cooldown and no per-call cap, CLAMPED so a single fast-mode
///             forward fills the bid only UP TO the threshold. This warms the
///             live bid up rapidly at launch. It is NOT a balance cap — once the
///             bid reaches the threshold the throttle takes over and the bid
///             keeps growing past it at the drip rate; the clamp only stops a
///             large buffer from blowing the bid far past the threshold in a
///             single block (overpay against a floor Punk).
///           - **At or above the threshold (throttled).** A per-call cap
///             (`maxSweepWei`) and a cooldown (`minBlocksBetweenSweeps`), keyed
///             off one shared `lastSweepBlock` across both `sweep()` and
///             `streamForward()`, bound the live bid's growth to at most
///             `maxSweepWei` per `minBlocksBetweenSweeps` blocks, no matter how
///             much has buffered here or which source delivered it.
///
///         `activationThreshold` self-manages: `sweep()` first refreshes it to
///         75% of the most recent `acceptBid` clearing price (the revealed
///         Punk-floor signal less a 25% band), clamped to
///         `ACTIVATION_THRESHOLD_HI`, so the fast-fill ceiling tracks shifting
///         floor regimes with no admin action. The buffer can only exit toward
///         Patron — there is no withdrawal path.
contract LiveBidAdapter is PCNoReentry, PCReentrancyGuard, IPreSwapStream {
    error ForwardFailed();
    error NotAdmin();
    error SweepTooEarly(uint256 nextBlock);
    error OutOfBounds(uint256 value, uint256 lo, uint256 hi);
    /// @notice `contribute` called with `msg.value == 0`. A contribution must
    ///         move ETH; a zero-value call is rejected so the `Contribution`
    ///         log never carries an empty entry.
    error ZeroValue();
    /// @notice `poolReplenish` called by anyone other than the bound
    ///         `returnAuctionModule`. The punk-keyed `PoolReplenished` event
    ///         must not be spoofable, so the return-refund entry is
    ///         module-only.
    error NotReturnAuction();

    event Swept(uint256 ethSwept, uint256 ethForwarded, uint256 ethBuffered);
    /// @notice Emitted on every direct ETH send into the adapter buffer via
    ///         `receive()` — the hook bid-leg skim, the FeeAutoSwapper-converted
    ///         LP fees, the cleared return refund, or a bare top-up. The ETH
    ///         joins the buffer and meters into Patron on the next `sweep()`.
    ///         Use `contribute(referrer, tag)` to attach attribution. The
    ///         adapter is the sole faucet into the live bid.
    event BareTopUp(address indexed sender, uint256 amount);
    /// @notice Emitted on every `contribute(referrer, tag)` call. `referrer`
    ///         is `address(0)` for un-referred contributions; `tag` is the
    ///         free-form campaign / UTM marker (`bytes32(0)` if unused).
    ///         `referrerShare` is the wei paid to the referrer (0 on a
    ///         no-referrer call or when the referrer's send failed and the
    ///         share was kept in the buffer as bid).
    event Contribution(
        address indexed contributor,
        uint256 amount,
        address indexed referrer,
        bytes32 indexed tag,
        uint256 referrerShare
    );
    /// @notice Emitted when `ReturnAuctionModule` routes the live-bid share of a
    ///         cleared return auction (and any rerouted keeper reward) into the
    ///         buffer via `poolReplenish`. The refund meters into the live bid
    ///         through the buffer rather than spiking `Patron.balance`
    ///         directly.
    event PoolReplenished(uint16 indexed punkId, uint256 amount);
    event KeeperReward(address indexed caller, uint256 amount);
    /// @dev Emitted when the caller-reward send fails. The reward ETH stays
    ///      buffered in this contract and will be picked up by the next
    ///      successful `sweep` toward Patron.
    event KeeperRewardFailed(address indexed caller, uint256 amount);
    /// @dev Emitted exactly when a forward takes Patron's balance from below
    ///      `activationThreshold` to at-or-above it. UIs / indexers can use
    ///      this to surface "the live bid has entered realistic Punk-price
    ///      territory" alerts. Fires at most once per threshold crossing
    ///      (subsequent forwards don't re-fire until the live bid drops back
    ///      below and crosses again).
    event ThresholdCrossed(uint256 patronBalance, uint256 threshold);
    /// @dev Emitted when an `acceptBid` acquisition auto-updates the activation
    ///      threshold via `_syncActivationThreshold`. `clearingPrice` is the
    ///      raw recorded acquisition price; `applied` is the value written to
    ///      `activationThreshold` — `(clearingPrice × 75) / 100` (the −25%
    ///      band), clamped to `ACTIVATION_THRESHOLD_HI`; `acquisitionCount` is
    ///      the records core's count at sync time. Only `acceptBid`
    ///      acquisitions emit this — `acceptListing` rows are skipped (see
    ///      `_syncActivationThreshold`).
    event ActivationThresholdSynced(uint256 clearingPrice, uint256 applied, uint256 acquisitionCount);
    event ParameterChanged(bytes32 indexed key, uint256 oldValue, uint256 newValue);

    /// @notice Caller-reward cap on `sweep`. Bounded by both bps of the
    ///         forwarded amount and a fixed absolute cap so the keeper share
    ///         can never dominate the inflow.
    uint256 public constant KEEPER_REWARD_BPS = 50;     // 0.5% of forwarded ETH
    uint256 public constant KEEPER_REWARD_CAP = 0.01 ether;

    /// @notice Dust floor for the hook-driven `streamForward` path: it no-ops
    ///         unless at least this much native ETH has buffered, so a tiny
    ///         swap doesn't trigger a forward. Keeps the per-swap cost a cheap
    ///         balance check until ≥0.01 ETH of bid-leg skim has accrued (the
    ///         bid then advances in ≥0.01 ETH increments). Fixed dust floor,
    ///         not a security/market knob.
    uint256 public constant MIN_STREAM_WEI = 0.01 ether;

    /// @notice Bounds for `maxSweepWei`. The default of 2 ETH paired with the
    ///         default ~30 min cooldown gives an effective ceiling of ~4 ETH/hour
    ///         of live-bid growth once the throttle is engaged. Admin can widen
    ///         if the protocol's trading regime turns out quieter than expected.
    uint256 public constant MAX_SWEEP_WEI_LO = 0.01 ether;
    uint256 public constant MAX_SWEEP_WEI_HI = 5 ether;

    /// @notice Bounds for `minBlocksBetweenSweeps`. Lower bound = every
    ///         block (essentially no cooldown). Upper bound ~1 day.
    uint256 public constant MIN_BLOCKS_LO = 1;
    uint256 public constant MIN_BLOCKS_HI = 7200;

    /// @notice Bounds for `activationThreshold` — the Patron-balance level that
    ///         separates fast mode (below) from the throttle (at/above). There
    ///         is no lower bound: the banded sync value may legitimately fall to
    ///         0, which pins the adapter into throttled mode (see the
    ///         `_syncActivationThreshold` AUDIT NOTE). The upper bound caps the
    ///         fast-fill ceiling so the warm-up can't run uncapped to arbitrary
    ///         heights; admin can lower or raise within the band as market
    ///         conditions change.
    uint256 public constant ACTIVATION_THRESHOLD_LO = 0;
    uint256 public constant ACTIVATION_THRESHOLD_HI = 100 ether;

    /// @notice Bps denominator (referrer-contribution split, keeper reward).
    uint256 public constant BPS = 10_000;

    /// @notice Referrer share of an attributed `contribute(referrer, tag)`
    ///         call, expressed as a bps fraction of `msg.value`. The remainder
    ///         joins the buffer and meters into the live bid via `sweep()`.
    ///
    ///         Fail-closed in both directions: no referrer → 100% buffered;
    ///         reverting / OOG referrer → 100% buffered (`referrerShare` reset
    ///         to 0 in-place, ETH never left the adapter). Hard-coded — no
    ///         setter, no admin. See the "Direct contribution split" invariant.
    uint256 public constant REFERRER_CONTRIB_BPS = 500;

    /// @notice Gas budget for the outgoing send to the contribution referrer.
    ///         Matches `ReferralPayout.CLAIM_GAS` and the auction-referrer
    ///         budget on the cleared-path settle.
    uint256 public constant REFERRER_GAS = 35_000;

    /// @notice The protocol's entry-point hub. Receives ETH inflows here.
    address payable public immutable patron;
    /// @notice Time-locked admin (1y auto-lock). Gates the sweep cap and
    ///         cooldown setters. `activationThreshold` is the lone adapter
    ///         carve-out and remains editable until the admin role is burned.
    ProtocolAdmin public immutable adminContract;
    /// @notice The records core. Read (never written) to auto-track
    ///         `activationThreshold` to the most recent `acceptBid` clearing
    ///         price — see `_syncActivationThreshold`. `address(0)` disables
    ///         auto-tracking entirely (the threshold is then the constructor
    ///         seed plus any manual `setActivationThreshold`), the mode
    ///         standalone unit-test fixtures run in.
    IPCAcquisitionReader public immutable permanentCollection;
    /// @notice The return-auction module. The ONLY authorized caller of
    ///         `poolReplenish` — gating it module-only keeps the punk-keyed
    ///         `PoolReplenished` event unspoofable. `address(0)` leaves
    ///         `poolReplenish` permanently uncallable (the manual-only mode
    ///         standalone unit tests run in); the production deploy wires the
    ///         real module address. Set in the constructor and never changes.
    address public immutable returnAuctionModule;

    /// @notice Maximum ETH forwarded to Patron per throttled forward. Excess
    ///         stays buffered in this contract for future calls. Only enforced
    ///         once `Patron.balance >= activationThreshold`; below the threshold
    ///         the fast-mode forward is uncapped (clamped only to land the bid
    ///         at the threshold).
    uint256 public maxSweepWei;
    /// @notice Minimum blocks between consecutive throttled forwards. A no-op
    ///         call (empty buffer / below the stream dust floor) does not
    ///         consume the cooldown. Shared by `sweep` and `streamForward` via
    ///         `lastSweepBlock`. Only enforced once
    ///         `Patron.balance >= activationThreshold`.
    uint256 public minBlocksBetweenSweeps;
    /// @notice Block of the most recent THROTTLED forward (from either `sweep`
    ///         or `streamForward`). Combined with `minBlocksBetweenSweeps` to
    ///         enforce the single shared pacing window. Fast-mode forwards
    ///         (below the threshold) do NOT update this — the throttle engages
    ///         fresh from the first at-or-above-threshold forward, not pre-armed
    ///         by warm-up activity.
    uint256 public lastSweepBlock;
    /// @notice Patron-balance threshold below which the throttle is bypassed.
    ///         Fast-mode behaviour: no cooldown, no per-call cap, the buffer
    ///         forwards in one call — but CLAMPED so a single fast-mode forward
    ///         fills the bid only UP TO this threshold (the remainder stays
    ///         buffered and drips in under the throttle). NOT a balance cap:
    ///         once the bid reaches the threshold the throttle engages and the
    ///         bid keeps growing past it at the drip rate. The clamp only stops
    ///         a large buffer from blowing the bid far past the threshold in a
    ///         single block (overpay / gameable against a floor Punk).
    ///
    ///         Self-managing: `_syncActivationThreshold` (run first in every
    ///         `sweep`) overwrites this with 75% of the most recent `acceptBid`
    ///         clearing price — the revealed Punk-floor signal less a 25% band
    ///         — clamped to `ACTIVATION_THRESHOLD_HI`. The band keeps the
    ///         fast-fill ceiling a quarter below the latest accepted price so
    ///         the throttle engages before the bid reaches floor. The
    ///         constructor value seeds the pre-first-acquisition window; after
    ///         that, accepted bids keep it aligned with shifting floor regimes
    ///         with no admin action.
    ///
    ///         `setActivationThreshold` remains a bounded manual override
    ///         (admin-settable indefinitely, even after the 1y protocol lock):
    ///         a manual write persists until the next `acceptBid` re-syncs
    ///         (last-writer-wins on this one slot), so it's an anomaly-
    ///         correction valve, not a value you have to maintain.
    uint256 public activationThreshold;

    /// @notice High-water mark of `permanentCollection.acquisitionCount()`
    ///         already reflected into `activationThreshold`. Lets
    ///         `_syncActivationThreshold` fire at most once per new
    ///         acquisition. Zero until the first sync; never decreases.
    uint256 public lastSyncedAcquisitionCount;

    /// @dev Same-function reentrancy mutex (`nonReentrant`) is inherited from
    ///      PCReentrancyGuard. It complements the inherited `notInSwap` guard:
    ///      `notInSwap` blocks reentry from a Design B dispatcher callback
    ///      during a swap (dormant at launch); `nonReentrant` blocks the
    ///      un-gas-limited keeper-reward `.call` recipient from re-entering
    ///      `sweep` within the same tx — including in fast-mode, where no
    ///      cooldown applies.

    modifier onlyAdmin() {
        if (!adminContract.checkAdmin(msg.sender)) revert NotAdmin();
        _;
    }

    /// @dev Gates `setActivationThreshold`: the raw admin EOA, ignoring the 1y
    ///      auto-lock timer. The setter stays live until
    ///      `ProtocolAdmin.transferAdmin(address(0))` burns the role.
    modifier onlyAdminEvenIfLocked() {
        if (msg.sender != adminContract.admin()) revert NotAdmin();
        _;
    }

    /// @param _patron                  The hub (recipient of forwarded ETH).
    /// @param _adminContract           Pre-deployed `ProtocolAdmin`.
    /// @param _maxSweepWei             Initial per-call ETH cap (the throttle's
    ///                                 per-forward ceiling, enforced at/above
    ///                                 the activation threshold).
    /// @param _minBlocksBetweenSweeps  Initial inter-forward cooldown in blocks
    ///                                 (enforced at/above the threshold).
    /// @param _activationThreshold     Initial Patron-balance threshold at which
    ///                                 the throttle activates. Below this value
    ///                                 the adapter runs in fast-mode (no
    ///                                 cooldown/cap, but the forward is clamped
    ///                                 to fill only up to the threshold). Seeds
    ///                                 the pre-first-acquisition window;
    ///                                 accepted bids take over via auto-tracking.
    /// @param _permanentCollection     Records core, read to auto-track the
    ///                                 threshold to the latest `acceptBid`
    ///                                 clearing price. Pass `address(0)` to
    ///                                 disable auto-tracking (manual-only).
    /// @param _returnAuctionModule     The return-auction module — the sole
    ///                                 authorized caller of `poolReplenish`.
    ///                                 Pass `address(0)` to leave
    ///                                 `poolReplenish` uncallable (standalone
    ///                                 unit-test mode).
    /// @param _swapContext             PCSwapContext registry for `notInSwap`.
    constructor(
        address payable _patron,
        address _adminContract,
        uint256 _maxSweepWei,
        uint256 _minBlocksBetweenSweeps,
        uint256 _activationThreshold,
        address _permanentCollection,
        address _returnAuctionModule,
        address _swapContext
    ) PCNoReentry(_swapContext) {
        require(_patron != address(0), "LiveBidAdapter: zero hub");
        require(_adminContract != address(0), "LiveBidAdapter: zero admin");
        require(_maxSweepWei >= MAX_SWEEP_WEI_LO && _maxSweepWei <= MAX_SWEEP_WEI_HI, "LiveBidAdapter: bad maxSweep");
        require(
            _minBlocksBetweenSweeps >= MIN_BLOCKS_LO && _minBlocksBetweenSweeps <= MIN_BLOCKS_HI,
            "LiveBidAdapter: bad minBlocks"
        );
        require(
            _activationThreshold <= ACTIVATION_THRESHOLD_HI,
            "LiveBidAdapter: bad activationThreshold"
        );
        patron = _patron;
        adminContract = ProtocolAdmin(_adminContract);
        // Optional: zero disables auto-tracking (manual-only). No revert on
        // zero — test fixtures and any deploy that opts out construct cleanly.
        permanentCollection = IPCAcquisitionReader(_permanentCollection);
        // Optional: zero leaves `poolReplenish` permanently uncallable (no
        // caller can ever equal `address(0)`). The production deploy wires the
        // real module; standalone adapter unit tests pass zero.
        returnAuctionModule = _returnAuctionModule;
        maxSweepWei = _maxSweepWei;
        minBlocksBetweenSweeps = _minBlocksBetweenSweeps;
        activationThreshold = _activationThreshold;
    }

    /// @notice Accept native ETH into the buffer from any source — the hook's
    ///         bid-leg skim, the FeeAutoSwapper-converted LP fees, the cleared
    ///         return refund, or a bare top-up. Every inflow is tagged
    ///         `BareTopUp` for indexers and meters into Patron on the next
    ///         `sweep()` / `streamForward()`. Use `contribute(referrer, tag)`
    ///         to attach attribution.
    receive() external payable {
        emit BareTopUp(msg.sender, msg.value);
    }

    /// @notice Canonical Schelling-point contribution surface for capital that
    ///         wants to align with Permanent Collection. Pays
    ///         `REFERRER_CONTRIB_BPS` of `msg.value` to `referrer` (if
    ///         non-zero) and buffers the remainder, which meters into the live
    ///         bid via `sweep()`. Optional `tag` is emitted for off-chain
    ///         campaign attribution.
    ///
    ///         Primary integration target: NFT launchpads ("Route X% of mint
    ///         to Permanent Collection" checkbox); secondary: wallet widgets,
    ///         DAO treasuries, public-goods aggregators.
    ///
    /// @dev    The remainder buffers here and meters into Patron via `sweep()`
    ///         rather than landing in Patron directly. Fail-closed in both
    ///         directions:
    ///           - `referrer == address(0)`        → 100% buffered (no send)
    ///           - referrer reverts / OOGs (35k)   → 100% buffered; the call
    ///             never moved ETH out of the adapter, so resetting
    ///             `referrerShare` to 0 is accounting-accurate.
    ///         No retry path, no claim path. `nonReentrant` shares the adapter
    ///         mutex with `sweep` so a malicious referrer cannot re-enter a
    ///         fund-mover; `notInSwap` participates in the dormant Design B
    ///         guard.
    ///
    /// @param  referrer Optional referrer address (`address(0)` to skip).
    /// @param  tag      Free-form 32-byte campaign / UTM tag (indexed).
    function contribute(address referrer, bytes32 tag)
        external
        payable
        nonReentrant
        notInSwap
    {
        if (msg.value == 0) revert ZeroValue();
        uint256 referrerShare = referrer != address(0)
            ? (msg.value * REFERRER_CONTRIB_BPS) / BPS
            : 0;
        if (referrerShare > 0) {
            (bool ok,) = referrer.call{value: referrerShare, gas: REFERRER_GAS}("");
            if (!ok) {
                // Fail-closed: keep 100% in the buffer. The send did not move
                // ETH out of the adapter, so resetting referrerShare to 0 is
                // accurate accounting; the Contribution event records the
                // outcome so a frontend can show "referrer did not accept
                // payment" rather than silently losing attribution.
                referrerShare = 0;
            }
        }
        // The remainder (msg.value − referrerShare) stays buffered and meters
        // into Patron on the next sweep.
        emit Contribution(msg.sender, msg.value, referrer, tag, referrerShare);
    }

    /// @notice Accept the live-bid share of a cleared return auction (and any
    ///         rerouted settle keeper reward) into the buffer. Module-only so
    ///         the punk-keyed `PoolReplenished` event cannot be spoofed. The
    ///         ETH joins the buffer and meters into Patron via `sweep()` — this
    ///         is the "no overshoot when the pool is already high" path: a
    ///         large return refund fast-replenishes a low bid but is throttled
    ///         once the bid is already at/above the activation threshold.
    /// @dev    `nonReentrant` + `notInSwap` guard this payable entry. The
    ///         module calls this from within its own `nonReentrant` settle;
    ///         the adapter mutex is independent, so there is no cross-lock
    ///         interaction.
    function poolReplenish(uint16 punkId) external payable nonReentrant notInSwap {
        if (msg.sender != returnAuctionModule) revert NotReturnAuction();
        emit PoolReplenished(punkId, msg.value);
    }

    /// @notice Permissionless. Forwards the buffered native ETH to Patron
    ///         (paying the caller a small keeper reward off the top). Below the
    ///         activation threshold the forward is uncapped (clamped to land the
    ///         bid at the threshold); at/above it the forward is capped at
    ///         `maxSweepWei` and paced by `minBlocksBetweenSweeps`. Excess
    ///         buffer stays here for later calls.
    /// @return ethForwarded The amount of native ETH sent to Patron this call.
    function sweep() external notInSwap nonReentrant returns (uint256 ethForwarded) {
        // Refresh the activation threshold from the latest acceptBid clearing
        // price BEFORE the throttle decision below reads it. Fail-open, no-op
        // when nothing changed or auto-tracking is disabled.
        _syncActivationThreshold();

        uint256 ethBal = address(this).balance;
        if (ethBal == 0) return 0;

        // 100% of the sweep inflow flows to Patron (the live bid). Permanent
        // depth is provided separately by the conversion locker's two
        // concentrated high-FDV tail positions.

        // Snapshot Patron's balance BEFORE the forward. Drives both the
        // throttle decision and the `ThresholdCrossed` event detection.
        uint256 patronBalBefore = patron.balance;
        uint256 threshold = activationThreshold;
        bool throttled = patronBalBefore >= threshold;

        uint256 toForward;
        bool fillToThreshold;
        if (throttled) {
            // At/above the threshold — engage throttle: cooldown + per-call cap.
            // Cooldown check happens AFTER the empty-buffer return above so a
            // no-op call does not reserve the cooldown slot.
            uint256 nextBlock = lastSweepBlock + minBlocksBetweenSweeps;
            if (block.number < nextBlock) revert SweepTooEarly(nextBlock);
            toForward = ethBal < maxSweepWei ? ethBal : maxSweepWei;
            lastSweepBlock = block.number;
        } else {
            // Fast-mode (below activation threshold): fill the live bid UP TO
            // the threshold, then stop. The remainder stays buffered and drips
            // in under the throttle on later sweeps. This is NOT a bid cap —
            // the throttled drip still grows the bid past the threshold; we
            // clamp only the single fast-mode forward so a large buffer can't
            // blow the bid far past the threshold in one block (which would let
            // a floor Punk be accepted against an overshot bid — overpay, and
            // gameable).
            //
            // AUDIT NOTE — finding L-2 is knowingly accepted. In fast mode
            // there is no cooldown, so a keeper can call `sweep()` on each tiny
            // inflow and collect the (bps + fixed-cap) reward every time until
            // the bid reaches the threshold. The harvest is bounded by the
            // reward cap per call and ends once the threshold is crossed
            // (throttled mode then paces rewards by the cooldown). Accepted in
            // exchange for the fast-fill warm-up.
            //
            // `lastSweepBlock` is intentionally NOT updated here — the throttle
            // should engage fresh from the first at-or-above-threshold forward,
            // not be pre-armed by warm-up activity.
            uint256 room = threshold - patronBalBefore; // >0: !throttled ⇒ before < threshold
            if (ethBal < room) {
                // Can't reach the threshold this sweep — warm-up, forward all.
                toForward = ethBal;
            } else {
                // Enough to reach the threshold: land EXACTLY at it. The reward
                // block forwards the full `room` to Patron and pays the keeper
                // out of the remainder, so the bid hits the threshold and the
                // throttle engages next sweep. This exact landing is
                // LOAD-BEARING, not cosmetic: if the reward were carved off the
                // forward the bid would land a hair BELOW the threshold every
                // time, `patronBalBefore >= threshold` would never hold, the
                // throttle would never engage, and the bid would stall just
                // under the threshold forever — unable to grow past it toward
                // the real floor (a fork test caught exactly this).
                toForward = room;
                fillToThreshold = true;
            }
        }

        // Keeper reward (same bps + fixed cap in both modes).
        uint256 reward = (toForward * KEEPER_REWARD_BPS) / BPS;
        if (reward > KEEPER_REWARD_CAP) reward = KEEPER_REWARD_CAP;

        if (fillToThreshold) {
            // Forward the FULL `toForward` (== `room`) to Patron so the bid
            // lands AT the threshold and the throttle engages next sweep, and
            // pay the keeper out of the buffered remainder instead of carving
            // it off the forward. Otherwise the reward would leave the bid a
            // hair below the threshold, the throttle would never engage, and
            // the bid would stall just below the threshold (see above).
            // Cap at the available remainder (the whole non-forwarded balance).
            uint256 remainder = ethBal - toForward;
            if (reward > remainder) reward = remainder;
            ethForwarded = toForward;
        } else {
            // Carve the reward off the forward. Safe — in the warm-up
            // (ethBal < room) and throttled cases nothing is left stranded
            // behind the bid.
            if (reward >= toForward) reward = 0;
            ethForwarded = toForward - reward;
        }

        (bool okFwd,) = patron.call{value: ethForwarded}("");
        if (!okFwd) revert ForwardFailed();

        // Detect the below→at-or-above threshold crossing on this forward.
        // Fires at most once per crossing; subsequent sweeps don't re-emit
        // until the live bid drops back below (e.g. spent by acceptBid)
        // and crosses again.
        uint256 patronBalAfter = patron.balance;
        if (patronBalBefore < threshold && patronBalAfter >= threshold) {
            emit ThresholdCrossed(patronBalAfter, threshold);
        }

        if (reward > 0) {
            (bool okReward,) = msg.sender.call{value: reward}("");
            if (okReward) {
                emit KeeperReward(msg.sender, reward);
            } else {
                // Reward send failed (caller can't receive ETH). The reward
                // ETH stays buffered for the next sweep. Do NOT revert —
                // the protocol-essential forward to Patron has already
                // succeeded.
                emit KeeperRewardFailed(msg.sender, reward);
            }
        }

        // Emit Swept AFTER the reward attempt so `ethBuffered` reflects
        // post-reward state.
        emit Swept(ethBal, ethForwarded, address(this).balance);
    }

    /// @notice Hook-driven pre-swap stream of already-buffered native ETH into
    ///         the live bid. Designed to be called from the artcoins hook's
    ///         `_beforeSwap` so the bid advances per-swap (sweeping the PRIOR
    ///         swaps' accrued pending — this swap's skim arrives later in
    ///         `_afterSwap`). Deliberately leaner than `sweep()`:
    ///           - **cheap** — just a balance read + forward of the existing
    ///             buffer, so it adds negligible cost to the swap hot path. It
    ///             does NOT refresh the activation threshold (that runs only in
    ///             the keeper/UI `sweep()`); it reads whatever the last sweep
    ///             set;
    ///           - **dust floor** — no-ops below `MIN_STREAM_WEI`, so tiny swaps
    ///             don't trigger a forward;
    ///           - **no keeper reward** — the caller is the hook, not a keeper,
    ///             so no reward leaks out (and the fast-mode clamp lands the bid
    ///             EXACTLY at the threshold — no reward-dust to source from the
    ///             remainder);
    ///           - **no-op (never reverts) on cooldown** above the threshold —
    ///             a revert here would brick the swap, so it returns 0 instead.
    ///         Same fast-mode clamp + throttle bounds as `sweep()`. Safe to call
    ///         in `_beforeSwap`: that's outside the Design-B `inSwap` window
    ///         (the dispatcher only flips `inSwap` around its `_afterSwap`
    ///         callback), and the only external call is the forward to Patron,
    ///         whose `receive()` has no logic — it cannot re-enter the
    ///         PoolManager or corrupt the in-flight swap's settlement.
    /// @return ethForwarded Native ETH sent to Patron this call (0 on no-op).
    function streamForward() external override notInSwap nonReentrant returns (uint256 ethForwarded) {
        // Buffered native only — no escrow claim. Dust floor.
        uint256 ethBal = address(this).balance;
        if (ethBal < MIN_STREAM_WEI) return 0;

        uint256 patronBalBefore = patron.balance;
        uint256 threshold = activationThreshold;

        uint256 toForward;
        if (patronBalBefore >= threshold) {
            // Throttled: per-call cap + cooldown, but NO-OP (not revert) when
            // called before the cooldown so a swap is never bricked. Above the
            // threshold the stream therefore advances at most once per cooldown
            // (the drip rate), regardless of swap frequency — by design.
            if (block.number < lastSweepBlock + minBlocksBetweenSweeps) return 0;
            toForward = ethBal < maxSweepWei ? ethBal : maxSweepWei;
            lastSweepBlock = block.number;
        } else {
            // Fast-mode: fill the bid up to the threshold, no overshoot. No
            // keeper reward on this path, so the forward lands the bid exactly
            // at the threshold and the throttle engages cleanly next call.
            //
            // AUDIT NOTE (L-2): the stream path pays NO keeper reward, so the
            // fast-mode keeper-reward harvest vector does not exist here; the
            // uncapped fast-fill is the warm-up speedup only.
            uint256 room = threshold - patronBalBefore; // >0: before < threshold
            toForward = ethBal < room ? ethBal : room;
        }

        // No keeper reward on the stream path — full amount to Patron.
        ethForwarded = toForward;
        (bool okFwd,) = patron.call{value: ethForwarded}("");
        if (!okFwd) revert ForwardFailed();

        uint256 patronBalAfter = patron.balance;
        if (patronBalBefore < threshold && patronBalAfter >= threshold) {
            emit ThresholdCrossed(patronBalAfter, threshold);
        }
        // ethSwept = ethBal (the buffer at call time); the stream path never
        // claims from an escrow.
        emit Swept(ethBal, ethForwarded, address(this).balance);
    }

    /// @notice Auto-track `activationThreshold` to the most recent live-bid
    ///         clearing price. Called first in every `sweep`.
    ///
    /// @notice AUDIT NOTE — finding M-1 is knowingly accepted. An attacker can
    ///         list a Punk exclusively to the hub at 1 wei, have the acceptBid
    ///         finalized, and drive the synced value to `(1 * 75) / 100 == 0`,
    ///         which pins the adapter into throttled mode permanently (a 0
    ///         threshold makes `patronBalBefore >= threshold` always true, so
    ///         fast-mode is bypassed). The worst-case outcome is that every
    ///         forward is rate-limited — the live bid still grows, just at the
    ///         `maxSweepWei`/cooldown drip and never uncapped. The attacker
    ///         extracts no protocol value, and the cost is steep: driving a sync
    ///         means putting a real eligible Punk through `acceptBid`, which
    ///         sends it into a 72h return auction — vaulted forever if unredeemed,
    ///         or bought back at market on a rescue. The buffer this threshold
    ///         governs can only ever flow toward Patron, so nothing is
    ///         extractable, and the next legitimate acceptBid re-syncs the
    ///         threshold up (last-writer, not a ratchet). The bounded grief is
    ///         accepted in exchange for the fast-fill warm-up.
    ///
    /// @dev    Reads the records core. On a NEW acquisition (count advanced
    ///         past `lastSyncedAcquisitionCount`) whose recorded `acquirer`
    ///         equals its `originalSeller` — the `acceptBid` shape, where the
    ///         pre-lister IS the giver-up of the Punk — it overwrites
    ///         `activationThreshold` with 75% of the acquisition price (the
    ///         −25% band), clamped to `ACTIVATION_THRESHOLD_HI`.
    ///
    ///         `acceptListing` acquisitions record a distinct finder as
    ///         `acquirer`, so they're skipped: a cheap aligned listing must
    ///         not drag the warm-up ceiling below the real floor. A manual
    ///         `setActivationThreshold` therefore persists until the next
    ///         qualifying `acceptBid` re-syncs (last-writer-wins on one slot).
    ///
    ///         Fail-open: a reverting reader (or auto-tracking disabled via
    ///         `permanentCollection == address(0)`) never blocks the sweep.
    ///         The high-water mark advances on any successfully-read new
    ///         acquisition (including skipped `acceptListing` rows) so a row
    ///         is never re-examined.
    function _syncActivationThreshold() internal {
        IPCAcquisitionReader pc = permanentCollection;
        if (address(pc) == address(0)) return;

        try pc.acquisitionCount() returns (uint256 count) {
            if (count <= lastSyncedAcquisitionCount) return;

            try pc.getAcquisition(count - 1) returns (
                IPCAcquisitionReader.Acquisition memory a
            ) {
                // acceptBid shape: acquirer == originalSeller (both the
                // pre-lister). acceptListing records the finder as acquirer,
                // distinct from the listing seller, so it's excluded.
                if (a.acquirer == a.originalSeller && a.acquirer != address(0)) {
                    // −25% band: set the throttle activation point to 75% of
                    // the revealed clearing price, so the fast-fill ceiling
                    // sits a quarter below the latest accepted Punk price and
                    // the throttle engages sooner. Last-writer per acceptBid,
                    // so the threshold tracks UP AND DOWN — a falling floor
                    // lowers the ceiling rather than ratcheting up. Clamp to
                    // ACTIVATION_THRESHOLD_HI; apply the clamp BEFORE the
                    // multiply so a pathological priceWei can never overflow it.
                    // Any price above 4/3 of the cap already bands past HI and
                    // pins to HI, so the ×75 only ever runs on a bounded value
                    // — the sync stays revert-free for every possible input,
                    // not just the ones the records core actually returns.
                    uint256 applied = a.priceWei > (ACTIVATION_THRESHOLD_HI * 100) / 75
                        ? ACTIVATION_THRESHOLD_HI
                        : (a.priceWei * 75) / 100;
                    if (applied != activationThreshold) {
                        activationThreshold = applied;
                    }
                    emit ActivationThresholdSynced(a.priceWei, applied, count);
                }
                // Advance the mark regardless: a non-acceptBid latest row
                // simply leaves the threshold at its prior value, and we don't
                // want to re-read it on every future sweep.
                lastSyncedAcquisitionCount = count;
            } catch {
                // getAcquisition reverted — leave the mark so we retry next
                // sweep rather than skipping the row permanently.
            }
        } catch {
            // acquisitionCount reverted — skip the sync this call.
        }
    }

    /// @notice Update the per-call ceiling on forwarded ETH (the throttle's
    ///         per-forward cap).
    /// @dev    Bounded by `MAX_SWEEP_WEI_LO`..`MAX_SWEEP_WEI_HI`. Wider
    ///         values amortize more buffered ETH into a single forward; the
    ///         throttle still applies via the cooldown. Subject to the 1y admin
    ///         lock — no carve-out.
    function setMaxSweepWei(uint256 newValue) external onlyAdmin {
        if (newValue < MAX_SWEEP_WEI_LO || newValue > MAX_SWEEP_WEI_HI) {
            revert OutOfBounds(newValue, MAX_SWEEP_WEI_LO, MAX_SWEEP_WEI_HI);
        }
        uint256 old = maxSweepWei;
        maxSweepWei = newValue;
        emit ParameterChanged("maxSweepWei", old, newValue);
    }

    /// @notice Update the inter-forward cooldown.
    /// @dev    Bounded by `MIN_BLOCKS_LO`..`MIN_BLOCKS_HI`. Lower = faster
    ///         inflow. Subject to the 1y admin lock — no carve-out.
    function setMinBlocksBetweenSweeps(uint256 newValue) external onlyAdmin {
        if (newValue < MIN_BLOCKS_LO || newValue > MIN_BLOCKS_HI) {
            revert OutOfBounds(newValue, MIN_BLOCKS_LO, MIN_BLOCKS_HI);
        }
        uint256 old = minBlocksBetweenSweeps;
        minBlocksBetweenSweeps = newValue;
        emit ParameterChanged("minBlocksBetweenSweeps", old, newValue);
    }

    /// @notice Manually override the Patron-balance threshold below which the
    ///         throttle is bypassed. Set higher to keep the fast-mode warm-up
    ///         phase active longer; set to 0 to always throttle.
    /// @dev    The threshold normally self-manages via `_syncActivationThreshold`
    ///         (auto-tracks the latest `acceptBid` clearing price). This setter
    ///         is the anomaly-correction valve: the written value persists only
    ///         until the next `acceptBid` re-syncs (last-writer-wins on the
    ///         slot), so it corrects the CURRENT value rather than pinning a
    ///         maintained constant.
    ///
    ///         Bounded by `[ACTIVATION_THRESHOLD_LO, ACTIVATION_THRESHOLD_HI]`
    ///         and intentionally exempt from the 1y admin timer
    ///         (`onlyAdminEvenIfLocked`). The setter remains live until
    ///         `ProtocolAdmin.transferAdmin(address(0))` burns the raw admin
    ///         role.
    function setActivationThreshold(uint256 newValue) external onlyAdminEvenIfLocked {
        if (newValue > ACTIVATION_THRESHOLD_HI) {
            revert OutOfBounds(newValue, ACTIVATION_THRESHOLD_LO, ACTIVATION_THRESHOLD_HI);
        }
        uint256 old = activationThreshold;
        activationThreshold = newValue;
        emit ParameterChanged("activationThreshold", old, newValue);
    }

    /// @notice ETH currently buffered in the adapter, waiting to be drip-
    ///         forwarded to Patron over future `sweep` / `streamForward` calls.
    function bufferedEth() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice The block number at or after which the next throttled `sweep`
    ///         call is allowed to forward (a no-op sweep, and any fast-mode
    ///         forward, is allowed at any block).
    function nextSweepBlock() external view returns (uint256) {
        return lastSweepBlock + minBlocksBetweenSweeps;
    }
}
