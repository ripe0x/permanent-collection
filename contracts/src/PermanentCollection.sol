// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPermanentCollection} from "./interfaces/IPermanentCollection.sol";
import {IPunksData} from "./interfaces/IPunksData.sol";
import {ProtocolAdmin} from "./ProtocolAdmin.sol";
import {OneTimeSetup} from "./libraries/OneTimeSetup.sol";

/// @title  PermanentCollection
/// @notice Records-only permanent core. Stores the canonical `collectedMask`
///         (the artwork's completion progress), the immutable acquisitions
///         log, the per-trait first-vaulted-Punk mapping, and pending
///         counters that track in-Final-Sale claims.
///
/// @dev    **A trait is only Collected when a Punk carrying it enters the
///         vault as that acquisition's recorded target trait.** `recordAcquisition`
///         increments `pendingTraitCount` only for `targetTraitId` and never
///         updates `collectedMask`. Only `markCustody(punkId, Vaulted)` touches
///         `collectedMask`. The ReturnedToMarket path releases the target
///         pending counter and never collects new traits.
///
///         There is exactly one acquisition entry point — `Patron` — which
///         is wired at setup time and immutable thereafter. No pluggable
///         module registry.
///
///         This contract holds NO Punks. It has no path to call the
///         CryptoPunks market. Coverage (`collectedMask`) transitions are
///         strictly monotonic. Custody cycles: a returned (ReturnedToMarket)
///         Punk can re-enter the return auction (ReturnedToMarket →
///         InReturnAuction); `Vaulted` is the only terminal state.
contract PermanentCollection is IPermanentCollection, OneTimeSetup {
    error NotPatron();
    error NotReturnAuction();
    error AlreadyRecorded(uint16 punkId);
    error NotRecorded(uint16 punkId);
    error CustodyAlreadySet(uint16 punkId);
    error InvalidCustodyTransition(uint16 punkId);
    error TargetTraitNotInMask(uint16 punkId, uint8 targetTraitId);
    error TargetTraitAlreadyCollected(uint8 targetTraitId);
    error TargetTraitAlreadyPending(uint8 targetTraitId);
    error MaskMismatch(uint16 punkId, uint256 expected, uint256 provided);
    error BadCategoryId(uint8 categoryId);
    error DatasetHashMismatch(bytes32 expected, bytes32 actual);
    error AlreadyInitialized();
    error ZeroAddress();
    error PunkOutOfRange(uint16 punkId);
    /// @notice The acquisition targets a trait other than the sole-carrier
    ///         trait, on the unique Punk that is the *only* carrier of an
    ///         uncollected trait. See `SOLE_CARRIER_PUNK_ID` and the
    ///         sole-carrier guard in `recordAcquisition`.
    error SoleCarrierMustTargetTrait(uint16 punkId, uint8 requiredTraitId);
    /// @notice The Punk carries no trait that is both uncollected AND not
    ///         already pending in another return auction — there is nothing
    ///         left for this acquisition to target. See `canonicalTargetOf`.
    error NoEligibleTarget(uint16 punkId);
    /// @notice The supplied `targetTraitId` is not the protocol-derived
    ///         canonical target (the rarest uncollected, non-pending trait the
    ///         Punk carries). The caller does not choose the target; it is
    ///         derived on-chain so a scarce-trait carrier can never be wasted
    ///         on a common trait. The supplied value is
    ///         kept as a verified expectation so the call fails loud if the
    ///         canonical target shifted before the tx landed.
    error TargetNotCanonical(uint16 punkId, uint8 provided, uint8 canonical);

    /// @notice Emitted once per acquired Punk, at `recordAcquisition` time.
    /// @param punkId The CryptoPunk's market index (0..9999).
    /// @param targetTraitId The trait id this acquisition targets for the
    ///                      Vault outcome. Drives the per-trait attempt counter
    ///                      and is the only bit collected on Vault.
    /// @param acquirer The address credited for the acquisition (the previous
    ///               owner on `acceptBid`, the caller on `acceptListing`).
    /// @param originalSeller The address that gave up the Punk to the protocol —
    ///                       the recipient of any future Proof NFT minted at
    ///                       vault-settle time. Equals `acquirer` on `acceptBid`;
    ///                       equals the public-listing seller on `acceptListing`
    ///                       (distinct from the caller / finder).
    /// @param mask The Punk's full 111-bit trait mask (verified against
    ///             PunksData on record).
    /// @param pendingBits The single target-trait bit this acquisition is
    ///                    currently claiming pendingly.
    /// @param priceWei The live bid paid (or listing price) at acquisition.
    /// @param acquiredAtBlock `block.number` of the acquisition.
    event AcquisitionRecorded(
        uint16 indexed punkId,
        uint8 indexed targetTraitId,
        address indexed acquirer,
        address originalSeller,
        uint256 mask,
        uint256 pendingBits,
        uint256 priceWei,
        uint256 acquiredAtBlock
    );
    /// @notice Mirror of the target-bit `pendingBits` field on
    ///         `AcquisitionRecorded`, emitted separately for indexers that key
    ///         off per-bit state.
    event TraitsPending(uint16 indexed punkId, uint256 pendingBits);
    /// @notice Emitted when a bit transitions from uncollected (possibly
    ///         pending) to permanently collected — exactly one bit per
    ///         `markCustody(Vaulted)`, the recorded target.
    ///         `isComplete` is the cached "all 111 bits collected" flag for
    ///         cheap off-chain consumption.
    event TraitsCollected(uint16 indexed punkId, uint256 newlyCollectedBits, uint256 collectedCount, bool isComplete);
    /// @notice Emitted on every custody transition. Lifecycle cycles
    ///         `(None) → InReturnAuction → ReturnedToMarket → InReturnAuction
    ///         → …`; `Vaulted` is terminal. Fires on each step, including the
    ///         ReturnedToMarket → InReturnAuction re-acquisition edge.
    event CustodyUpdated(uint16 indexed punkId, Custody outcome);
    /// @notice Emitted once at `setWiring` time. The four addresses are
    ///         immutable thereafter — `setWiring` reverts on re-entry.
    /// @dev    First three are indexed for cheap indexer lookup;
    ///         `buybackBurner` is rarely queried by hub-side indexers.
    event WiringFinalized(
        address indexed patron, address indexed returnAuctionModule, address indexed punkVault, address buybackBurner
    );

    /// @notice Total trait bits across PunksData's four dimensions.
    uint256 public constant TRAIT_COUNT = 111;

    /// @notice Full coverage = every one of 111 trait bits set.
    uint256 public constant FULL_SET_MASK = (uint256(1) << TRAIT_COUNT) - 1;

    /// @notice Pinned hash of the PunksData trait dataset.
    bytes32 public constant EXPECTED_DATASET_HASH = 0x92117ce6cb6bb70f9ffb9bf51ebbca6a84eae10e70639295d9c4a07958cd1f68;

    // ────────── Sole-carrier guard ──────────
    //
    // In the sealed PunksData dataset pinned by `EXPECTED_DATASET_HASH` there
    // is exactly ONE rarity-1 ("sole-carrier") trait: bit 23, "7 Attributes"
    // (the attributeCount=7 trait), carried by exactly one Punk — #8348. It is
    // the unique forced edge in the 111/111 trait→Punk matching: bit 23 can be
    // collected *only* by vaulting #8348 with bit 23 as the recorded target.
    //
    // Because the vault is terminal and a Punk is acquirable once, vaulting
    // #8348 against any of its 9 *common* traits would set that common bit,
    // leave bit 23 unset, and lock #8348 away forever — permanently capping the
    // Full Set at 110/111.
    //
    // The guard below removes only the ability to *waste* the unique carrier:
    // while bit 23 is uncollected, an acquisition of #8348 MUST target bit 23.
    // It preserves the target-only collection rule (still one target per vault)
    // and the artistic "one deliberate choice per vaulting".
    //
    // The dataset is SEALED (hash-pinned), so this set can never change: there
    // is, and will only ever be, exactly one sole-carrier pair. A single pinned
    // pair is therefore the complete, gas-minimal form — not a shortcut.

    /// @notice Trait bit of the dataset's single rarity-1 trait
    ///         ("7 Attributes"). While uncollected, its sole carrier must
    ///         target it.
    uint8 public constant SOLE_CARRIER_TRAIT_BIT = 23;

    /// @notice The unique CryptoPunk carrying `SOLE_CARRIER_TRAIT_BIT` (#8348).
    ///         The only Punk whose acquisition the sole-carrier guard
    ///         constrains.
    uint16 public constant SOLE_CARRIER_PUNK_ID = 8348;

    // ────────── Per-trait carrier counts (rarity table) ──────────
    //
    // The number of the 10,000 Punks that carry each trait bit, packed
    // big-endian uint16 × 111 = 222 bytes (trait `i` at byte offsets 2i, 2i+1).
    // A fixed per-trait projection of the sealed dataset pinned by
    // `EXPECTED_DATASET_HASH`. The live PunksData exposes per-Punk masks but no
    // per-trait count accessor, so these counts are pinned as a constant rather
    // than derived on-chain. The constructor enforces the dataset's identity (it
    // reverts unless `punksData.datasetHash()` equals `EXPECTED_DATASET_HASH`),
    // which fixes the masks these counts summarize; the counts themselves are
    // not re-checked against those masks on-chain (that would cost a 10,000-mask
    // popcount this contract does not run), so they are trusted to match the
    // pinned dataset.
    //
    // Drives `canonicalTargetOf`: the protocol targets the RAREST uncollected
    // trait a Punk carries, so a scarce-trait carrier can never be wasted on a
    // common one. Spot values: bit 3 "Male" = 6039
    // (max), bit 23 "7 Attributes" = 1 (sole carrier #8348), bit 16
    // "0 Attributes" = 8, bits 0/5 "Alien" = 9.
    bytes internal constant CARRIER_COUNTS =
        hex"000900180f001797005800090018044d0496047901a406bb07410745025600580008014d0de81195058c00a6000b0001011e01e1002c00920217026900930081010a004e015f00fe011a003003c101f60180017e009400d4008e019e009d012c099b012501cd00ba01110104010501ba012700a9010f0093010701960103021702b801a3011e00af01cc01b901ad01b902840120012f023c012401210044012f005e0036005f013d00cb010600a5028f0093020f0080020e012c009c017a00ee007c00970090009401cf00b200370073014c009301100056009001bf0088";

    // ────────── Immutable refs ──────────

    /// @notice Canonical 2017-era CryptoPunks trait dataset. Sealed at the
    ///         time of writing (ENS: `punksdata.eth`). The constructor pins
    ///         the dataset's `datasetHash` against `EXPECTED_DATASET_HASH`
    ///         so a substituted PunksData address fails deployment.
    IPunksData public immutable punksData;
    /// @notice Provenance only — recorded so indexers can locate the admin
    ///         contract from this address. Not consulted by any code path
    ///         inside `PermanentCollection`; admin gating lives on
    ///         `Patron`/`BuybackBurner`/`LiveBidAdapter` setters.
    ProtocolAdmin public immutable adminContract;
    /// @notice Provenance only. Useful as a stable anchor for off-chain
    ///         indexers that want to bound their backfill range.
    uint256 public immutable deployedAtBlock;

    // ────────── One-time-set wiring ──────────

    /// @notice The single acquisition entry point. Only this address may call
    ///         `recordAcquisition`. Set immutably at setup time.
    address public patron;
    /// @notice The single custody-marker. Only this address may call
    ///         `markCustody`. Set immutably at setup time.
    address public returnAuctionModule;
    /// @notice Provenance only — `PunkVault`'s address is published here for
    ///         indexers + UI. The vault is not called from this contract;
    ///         ReturnAuctionModule transfers Punks to it directly on settlement.
    address public punkVault;
    /// @notice Provenance only — `BuybackBurner`'s address is published here
    ///         for the same reason. Not called from inside this contract.
    address public buybackBurner;

    // ────────── State ──────────

    /// @notice The canonical 111-bit completion mask. Only updated on Vaulted.
    uint256 public collectedMask;

    /// @notice Per-trait counter of in-Final-Sale Punks whose recorded target
    ///         is this trait. A trait is "pending" iff this counter is non-zero
    ///         AND the trait is not yet collected.
    mapping(uint8 => uint16) public pendingTraitCount;

    /// @notice Per-trait counter of how many acquisitions have ever targeted
    ///         this trait. Increments once at `recordAcquisition`. Monotonic.
    ///         Drives the return auction reserve formula:
    ///         `reserve = paid × (100 + attemptCount) / 100`.
    mapping(uint8 => uint256) public attemptCount;

    /// @notice One immutable row per acquisition. Pushed into `_acquisitions`
    ///         in `recordAcquisition`; only the `custody` field ever mutates
    ///         (via `markCustody`) and only forward through the lifecycle.
    /// @param punkId The CryptoPunks market index (0..9999).
    /// @param targetTraitId The trait bit (0..110) this acquisition will
    ///        collect on Vault. Recorded for provenance and consulted by
    ///        ReturnAuctionModule to compute the reserve.
    /// @param mask The Punk's full 111-bit trait mask, verified against
    ///        PunksData at record time. Stored for provenance — the rest
    ///        of the protocol only cares about `targetTraitId`.
    /// @param pendingMaskAtAcquisition Single-bit mask for `targetTraitId`
    ///        (preserved on the record for off-chain provenance). The actual
    ///        pending-counter release in `markCustody` uses `targetTraitId`
    ///        directly.
    /// @param acquirer The address credited with the acquisition. For
    ///        `acceptBid` this is the previous Punk owner; for
    ///        `acceptListing` it is the caller (who also receives the
    ///        finder fee).
    /// @param originalSeller The address that gave up the Punk to the
    ///        protocol — the recipient of any future Proof NFT minted
    ///        from `PunkVault` if this acquisition's vault-settle lights
    ///        up a previously-uncollected trait. For `acceptBid` this
    ///        equals `acquirer` (both reference the pre-lister). For
    ///        `acceptListing` this is the listing's seller — distinct
    ///        from `acquirer` (the caller / finder, who earns the finder
    ///        fee but not the Proof). Set at acquisition time and never
    ///        re-derived later, because the seller's relationship to the
    ///        protocol is over by the time the 72-hour return auction ends.
    /// @param priceWei The live bid payout (acceptBid) or listing price
    ///        (acceptListing) at the moment of acquisition. Snapshotted
    ///        into ReturnAuctionModule's reserve calculation.
    /// @param acquiredAtBlock `block.number` at record time. Provenance
    ///        only — useful for backfills and history queries.
    /// @param custody Lifecycle position recorded on THIS row. The live
    ///        per-Punk custody (`_custody[punkId]`) can cycle
    ///        (ReturnedToMarket → InReturnAuction on re-acquisition), but a
    ///        row's own `custody` only ever advances
    ///        `InReturnAuction → (ReturnedToMarket | Vaulted)` and then
    ///        freezes — a re-acquisition appends a NEW row rather than
    ///        re-mutating this one (append-only log).
    struct Acquisition {
        uint16 punkId;
        uint8 targetTraitId;
        uint256 mask;
        uint256 pendingMaskAtAcquisition;
        address acquirer;
        address originalSeller;
        uint256 priceWei;
        uint256 acquiredAtBlock;
        Custody custody;
    }

    Acquisition[] internal _acquisitions;
    mapping(uint16 => uint256) internal _acquisitionIndexOf; // 1-based; 0 = not recorded
    mapping(uint16 => Custody) internal _custody;

    struct First {
        uint16 punkId;
        bool exists;
    }
    /// @notice For each trait id, the first vaulted Punk that brought it
    ///         into the collection. Only set on Vaulted.
    mapping(uint8 => First) internal _firstVaulted;

    constructor(
        address _punksData,
        address _adminContract
    ) OneTimeSetup() {
        if (_punksData == address(0) || _adminContract == address(0)) revert ZeroAddress();
        IPunksData pd = IPunksData(_punksData);
        bytes32 actual = pd.datasetHash();
        if (actual != EXPECTED_DATASET_HASH) revert DatasetHashMismatch(EXPECTED_DATASET_HASH, actual);
        punksData = pd;
        adminContract = ProtocolAdmin(_adminContract);
        deployedAtBlock = block.number;
    }

    /// @notice One-shot wiring of the four protocol addresses this contract
    ///         references. Callable exactly once, by the deployer, before
    ///         the `OneTimeSetup` finalization. After this call, all four
    ///         addresses are permanently fixed — no admin recovery, no
    ///         upgrade path.
    /// @dev    `patron` and `returnAuctionModule` are read in `msg.sender`
    ///         comparisons by `recordAcquisition` and `markCustody`
    ///         respectively. `punkVault` and `buybackBurner` are stored
    ///         for indexer / off-chain provenance and not consulted inside
    ///         this contract.
    function setWiring(
        address _patron,
        address _finalSaleModule,
        address _punkVault,
        address _buybackBurner
    ) external onlySetup {
        if (
            _patron == address(0) || _finalSaleModule == address(0) || _punkVault == address(0)
                || _buybackBurner == address(0)
        ) revert ZeroAddress();
        if (patron != address(0)) revert AlreadyInitialized();
        patron = _patron;
        returnAuctionModule = _finalSaleModule;
        punkVault = _punkVault;
        buybackBurner = _buybackBurner;
        _markFinalized();
        emit WiringFinalized(_patron, _finalSaleModule, _punkVault, _buybackBurner);
    }

    // ─────────────────────────── record & custody ───────────────────────────

    /// @notice Record a new acquisition. Bumps the per-trait `attemptCount`,
    ///         marks the recorded target trait as pending, and
    ///         transitions the Punk's custody to `InReturnAuction`. Does NOT
    ///         modify `collectedMask`.
    /// @dev    Callable only by `patron`. Reverts if:
    ///         - the Punk is currently InReturnAuction or Vaulted
    ///           (re-acquisition is allowed only from custody None or
    ///           ReturnedToMarket),
    ///         - the supplied `mask` doesn't match canonical PunksData,
    ///         - `targetTraitId` is out of range or absent from `mask`,
    ///         - `targetTraitId` is already collected,
    ///         - `targetTraitId` is already pending (one in-flight per trait),
    ///         - the Punk has no eligible target bit (defense in depth).
    /// @param punkId          The Punk being acquired.
    /// @param targetTraitId   The trait this acquisition will collect on Vault.
    /// @param mask            The Punk's full trait mask — re-verified inside.
    /// @param acquirer          The address credited for the acquisition.
    /// @param originalSeller  The address that gave up the Punk. Recipient of
    ///                        any future Proof NFT issued on vault-settle.
    ///                        Equals `acquirer` on `acceptBid`; equals the
    ///                        listing's seller on `acceptListing`.
    /// @param priceWei        Live bid paid (or listing price) at acquisition.
    function recordAcquisition(
        uint16 punkId,
        uint8 targetTraitId,
        uint256 mask,
        address acquirer,
        address originalSeller,
        uint256 priceWei
    ) external {
        if (msg.sender != patron) revert NotPatron();
        if (originalSeller == address(0)) revert ZeroAddress();
        if (punkId >= 10_000) revert PunkOutOfRange(punkId);
        // Re-auction gate (custody-based). A Punk may be
        // (re-)acquired only from custody None (never acquired) or
        // ReturnedToMarket (returned in a prior return auction). A Punk that is
        // InReturnAuction (an auction is live for it) or Vaulted (terminal —
        // locked in PunkVault forever) is rejected. On a
        // re-acquisition this function appends a fresh row below and re-points
        // `_acquisitionIndexOf[punkId]` to it; the prior row's `custody` stays
        // frozen at ReturnedToMarket (append-only log).
        Custody existingCustody = _custody[punkId];
        if (existingCustody == Custody.InReturnAuction || existingCustody == Custody.Vaulted) {
            revert AlreadyRecorded(punkId);
        }

        // Mask verification against canonical PunksData.
        uint256 canonical = punksData.traitMaskOf(punkId);
        if (mask != canonical) revert MaskMismatch(punkId, canonical, mask);

        if (targetTraitId >= TRAIT_COUNT) revert BadCategoryId(targetTraitId);
        if ((mask >> targetTraitId) & 1 == 0) revert TargetTraitNotInMask(punkId, targetTraitId);

        uint256 currentCollected = collectedMask;
        if ((currentCollected >> targetTraitId) & 1 == 1) {
            revert TargetTraitAlreadyCollected(targetTraitId);
        }

        // Sole-carrier target guard. #8348 is the UNIQUE
        // carrier of trait bit 23 in the sealed dataset. While bit 23 is
        // uncollected, #8348 may be acquired ONLY toward bit 23 — otherwise a
        // silenced vaulting against a common trait would strand bit 23 forever,
        // capping the Full Set at 110/111. The guard self-disables once bit 23
        // is collected (#8348 is then already vaulted) or never fires for any
        // other Punk. This is the single authoritative enforcement point; the
        // `Patron` entry points mirror it for an early/cheap revert.
        if (
            punkId == SOLE_CARRIER_PUNK_ID && (currentCollected >> SOLE_CARRIER_TRAIT_BIT) & 1 == 0
                && targetTraitId != SOLE_CARRIER_TRAIT_BIT
        ) {
            revert SoleCarrierMustTargetTrait(punkId, SOLE_CARRIER_TRAIT_BIT);
        }

        // Only one in-flight acquisition per uncollected trait. Without this
        // check, two concurrent Vault-path settlements for the same target
        // would leave the second Punk locked in `PunkVault` having contributed
        // nothing to `collectedMask` (the first call collected the bit).
        if (pendingTraitCount[targetTraitId] > 0) {
            revert TargetTraitAlreadyPending(targetTraitId);
        }

        // Protocol-derived target. The
        // caller does NOT freely choose the target: it MUST equal the canonical
        // target — the rarest uncollected, non-pending trait this Punk carries
        // (`canonicalTargetOf`). This removes the ability to waste a
        // scarce-trait carrier (e.g. one of the 9 Aliens, the 8 "0 Attributes"
        // Punks) on a common trait, and subsumes the sole-carrier guard above
        // (bit 23 is rarity-1, so it is always the canonical pick for #8348
        // while uncollected). `targetTraitId` is kept as a VERIFIED EXPECTATION:
        // the call reverts if the canonical target shifted between the caller's
        // read and this tx rather than silently recording a different permanent
        // trait. `canonicalTargetOf` reads `pendingTraitCount`, so it is
        // evaluated here BEFORE the increment below (this acquisition's target
        // is not yet pending); it also reverts `NoEligibleTarget` if the Punk
        // has no collectable trait left.
        uint8 canonicalTarget = canonicalTargetOf(punkId);
        if (targetTraitId != canonicalTarget) {
            revert TargetNotCanonical(punkId, targetTraitId, canonicalTarget);
        }

        // Single-bit mask for the recorded target — preserved on the
        // acquisition row + emitted for off-chain consumers. `targetTraitId`
        // is bounded < TRAIT_COUNT (111) above, so this is always non-zero.
        uint256 pendingBits = uint256(1) << targetTraitId;

        // Increment the one pending counter that can actually be collected by
        // this return auction. Non-target bits on the Punk remain unclaimed.
        unchecked {
            pendingTraitCount[targetTraitId] += 1;
        }

        // Bump the per-trait attempt counter. Drives the next return auction's
        // reserve formula. Monotonic — never decremented.
        attemptCount[targetTraitId] += 1;

        _acquisitions.push(
            Acquisition({
                punkId: punkId,
                targetTraitId: targetTraitId,
                mask: mask,
                pendingMaskAtAcquisition: pendingBits,
                acquirer: acquirer,
                originalSeller: originalSeller,
                priceWei: priceWei,
                acquiredAtBlock: block.number,
                custody: Custody.InReturnAuction
            })
        );
        _acquisitionIndexOf[punkId] = _acquisitions.length;
        _custody[punkId] = Custody.InReturnAuction;

        emit AcquisitionRecorded(
            punkId, targetTraitId, acquirer, originalSeller, mask, pendingBits, priceWei, block.number
        );
        emit TraitsPending(punkId, pendingBits);
        emit CustodyUpdated(punkId, Custody.InReturnAuction);
    }

    /// @notice Settle a Punk's terminal custody. Releases its target pending
    ///         contributions, and — on the Vault outcome — collects the
    ///         recorded target trait (and only that trait).
    /// @dev    Callable only by `returnAuctionModule`. Marks the terminal
    ///         outcome of the CURRENT auction: `InReturnAuction →
    ///         ReturnedToMarket | Vaulted`. The ReturnedToMarket path never
    ///         touches `collectedMask`. A subsequent re-acquisition of a
    ///         ReturnedToMarket Punk flips custody back to InReturnAuction via
    ///         `recordAcquisition` (not here); `Vaulted` is terminal and the
    ///         `current == InReturnAuction` guard below prevents any re-mark of
    ///         an already-settled row.
    /// @param punkId  The Punk whose custody is being marked.
    /// @param outcome `Custody.ReturnedToMarket` if the return auction cleared
    ///                with a buyer, `Custody.Vaulted` if it did not.
    function markCustody(
        uint16 punkId,
        Custody outcome
    ) external {
        if (msg.sender != returnAuctionModule) revert NotReturnAuction();
        uint256 idx = _acquisitionIndexOf[punkId];
        if (idx == 0) revert NotRecorded(punkId);
        Custody current = _custody[punkId];
        if (current != Custody.InReturnAuction) revert CustodyAlreadySet(punkId);
        if (outcome != Custody.ReturnedToMarket && outcome != Custody.Vaulted) {
            revert InvalidCustodyTransition(punkId);
        }

        Acquisition storage rec = _acquisitions[idx - 1];

        // Release the single pending-target claim this Punk made at
        // acquisition time. `pendingMaskAtAcquisition` always carries exactly
        // one bit (the recorded target), so we decrement
        // `pendingTraitCount[target]` directly rather than iterating the
        // mask — the `pendingMaskAtAcquisition` field is preserved
        // on the record itself for off-chain provenance.
        uint8 releaseTarget = rec.targetTraitId;
        uint16 curCount = pendingTraitCount[releaseTarget];
        if (curCount > 0) {
            unchecked {
                pendingTraitCount[releaseTarget] = curCount - 1;
            }
        }

        _custody[punkId] = outcome;
        rec.custody = outcome;
        emit CustodyUpdated(punkId, outcome);

        if (outcome == Custody.Vaulted) {
            // The vault outcome collects ONLY the recorded target trait, not
            // every uncollected bit on the Punk's mask. Other uncollected
            // traits remain available for future acquisitions (each must be
            // earned through its own return auction).
            uint256 currentCollected = collectedMask;
            uint8 target = rec.targetTraitId;
            uint256 targetBit = uint256(1) << target;
            if ((currentCollected & targetBit) == 0) {
                _firstVaulted[target] = First({punkId: punkId, exists: true});
                uint256 nextCollected = currentCollected | targetBit;
                collectedMask = nextCollected;
                emit TraitsCollected(punkId, targetBit, _popcount(nextCollected), nextCollected == FULL_SET_MASK);
            }
        }
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice True iff trait `traitId` is permanently in the collection.
    function isCollected(
        uint8 traitId
    ) external view returns (bool) {
        if (traitId >= TRAIT_COUNT) revert BadCategoryId(traitId);
        return (collectedMask >> traitId) & 1 == 1;
    }

    /// @notice True iff `traitId` is uncollected AND at least one in-flight
    ///         return auction targets it.
    function isPending(
        uint8 traitId
    ) external view returns (bool) {
        if (traitId >= TRAIT_COUNT) revert BadCategoryId(traitId);
        if ((collectedMask >> traitId) & 1 == 1) return false;
        return pendingTraitCount[traitId] > 0;
    }

    /// @notice Bitmap of every currently-pending uncollected trait. Renderer
    ///         consumes this in a single call instead of looping
    ///         `pendingTraitCount` 111 times.
    function pendingMask() external view returns (uint256 m) {
        uint256 c = collectedMask;
        for (uint8 i = 0; i < uint8(TRAIT_COUNT); i++) {
            if ((c >> i) & 1 == 0 && pendingTraitCount[i] > 0) {
                m |= (uint256(1) << i);
            }
        }
    }

    /// @notice First Punk to enter the vault carrying `traitId`. Returns
    ///         `(0, false)` for uncollected traits.
    function firstVaultedPunk(
        uint8 traitId
    ) external view returns (uint16 punkId, bool exists) {
        if (traitId >= TRAIT_COUNT) revert BadCategoryId(traitId);
        First memory f = _firstVaulted[traitId];
        return (f.punkId, f.exists);
    }

    /// @notice Whether acquiring `punkId` is currently constrained by the
    ///         sole-carrier guard, and to which trait.
    ///         Single source of truth for frontends and indexers so they can
    ///         pre-fill the only valid target and warn before a wasted call
    ///         (rather than re-deriving the pinned facts off-chain).
    /// @return required        True iff `punkId` MUST target `requiredTraitId`.
    /// @return requiredTraitId The trait the acquisition must target (only
    ///                         meaningful when `required` is true; `0`
    ///                         otherwise).
    function soleCarrierConstraint(
        uint16 punkId
    ) external view returns (bool required, uint8 requiredTraitId) {
        if (punkId == SOLE_CARRIER_PUNK_ID && (collectedMask >> SOLE_CARRIER_TRAIT_BIT) & 1 == 0) {
            return (true, SOLE_CARRIER_TRAIT_BIT);
        }
        return (false, 0);
    }

    /// @notice The trait an acquisition of `punkId` would target right now: the
    ///         RAREST (fewest carriers in the sealed dataset) trait the Punk
    ///         carries that is both uncollected AND not already pending in
    ///         another return auction; ties broken by lowest bit index. This is
    ///         the protocol's canonical target — `recordAcquisition` requires
    ///         the supplied `targetTraitId` to equal it,
    ///         so a caller can never waste a scarce-trait carrier on a common
    ///         trait. Generalizes the sole-carrier guard: bit 23 is rarity-1, so
    ///         this returns 23 for #8348 while bit 23 is uncollected. Frontends
    ///         and indexers read this to pre-fill the target and preview which
    ///         trait a silenced vaulting would collect.
    /// @dev    Reverts `NoEligibleTarget` if the Punk carries no uncollected,
    ///         non-pending trait (each trait it has is already collected or
    ///         in-flight elsewhere).
    function canonicalTargetOf(
        uint16 punkId
    ) public view returns (uint8) {
        if (punkId >= 10_000) revert PunkOutOfRange(punkId);
        uint256 mask = punksData.traitMaskOf(punkId);
        uint256 collected = collectedMask;
        uint16 bestCount = type(uint16).max;
        uint256 best = type(uint256).max; // sentinel: no eligible trait found
        for (uint8 i = 0; i < uint8(TRAIT_COUNT); i++) {
            if ((mask >> i) & 1 == 0) continue; // not on this Punk
            if ((collected >> i) & 1 == 1) continue; // already collected
            if (pendingTraitCount[i] > 0) continue; // in-flight elsewhere
            uint16 c = _carrierCount(i);
            // strict `<` keeps the FIRST (lowest-index) bit on a count tie.
            if (c < bestCount) {
                bestCount = c;
                best = i;
            }
        }
        if (best == type(uint256).max) revert NoEligibleTarget(punkId);
        return uint8(best);
    }

    /// @notice Number of the 10,000 Punks carrying trait `traitId` in the
    ///         sealed dataset, from the pinned `CARRIER_COUNTS` table (a fixed
    ///         projection of the dataset pinned by `EXPECTED_DATASET_HASH`).
    function traitCarrierCount(
        uint8 traitId
    ) external pure returns (uint16) {
        if (traitId >= TRAIT_COUNT) revert BadCategoryId(traitId);
        return _carrierCount(traitId);
    }

    /// @notice Complement of `collectedMask` within `FULL_SET_MASK`.
    function uncollectedMask() external view returns (uint256) {
        return FULL_SET_MASK & ~collectedMask;
    }

    /// @notice True iff all 111 trait bits are set on `collectedMask`.
    function isComplete() external view returns (bool) {
        return collectedMask == FULL_SET_MASK;
    }

    /// @notice Number of bits set on `collectedMask` (0..111).
    function collectedCount() external view returns (uint256) {
        return _popcount(collectedMask);
    }

    /// @notice Total number of acquisitions ever recorded — monotonic.
    function acquisitionCount() external view returns (uint256) {
        return _acquisitions.length;
    }

    /// @notice Current custody slot for `punkId`. Returns `Custody.None`
    ///         (zero) if the Punk has never been acquired.
    function custodyOf(
        uint16 punkId
    ) external view returns (Custody) {
        return _custody[punkId];
    }

    /// @notice True iff `punkId` has been recorded as an acquisition.
    function isRecorded(
        uint16 punkId
    ) external view returns (bool) {
        return _acquisitionIndexOf[punkId] != 0;
    }

    /// @notice The pending-bit delta this acquisition contributed at record
    ///         time. Frozen on the record — does not shrink as bits get
    ///         collected by other acquisitions.
    function pendingAcquisitionMaskOf(
        uint16 punkId
    ) external view returns (uint256) {
        uint256 idx = _acquisitionIndexOf[punkId];
        if (idx == 0) return 0;
        return _acquisitions[idx - 1].pendingMaskAtAcquisition;
    }

    /// @notice The address that gave up `punkId` to the protocol at its
    ///         original acquisition. For `acceptBid` this is the
    ///         previous Punk owner (also the recorded `acquirer`); for
    ///         `acceptListing` this is the public-listing seller (distinct
    ///         from the caller / finder). Returns `address(0)` for an
    ///         unrecorded Punk. Consumed by `PunkVault.mintProofs` at
    ///         vault-settle time to address the Proof NFT.
    function originalSellerOf(
        uint16 punkId
    ) external view returns (address) {
        uint256 idx = _acquisitionIndexOf[punkId];
        if (idx == 0) return address(0);
        return _acquisitions[idx - 1].originalSeller;
    }

    /// @notice 0-based index of `punkId`'s acquisition in `_acquisitions`.
    ///         Reverts `NotRecorded` if the Punk has never been acquired.
    ///         Provides a stable, append-only handle for events that want
    ///         to reference an acquisition without copying the whole struct.
    function acquisitionIndexOf(
        uint16 punkId
    ) external view returns (uint256) {
        uint256 idx = _acquisitionIndexOf[punkId];
        if (idx == 0) revert NotRecorded(punkId);
        unchecked {
            return idx - 1;
        }
    }

    /// @notice Read an acquisition record by index (0-based). Reverts on
    ///         out-of-range; pair with `acquisitionCount()` for safe paging.
    function getAcquisition(
        uint256 idx
    ) external view returns (Acquisition memory) {
        return _acquisitions[idx];
    }

    /// @notice Read an acquisition record by Punk id.
    /// @dev    Reverts `NotRecorded` if the Punk has never been acquired.
    function getAcquisitionFor(
        uint16 punkId
    ) external view returns (Acquisition memory) {
        uint256 idx = _acquisitionIndexOf[punkId];
        if (idx == 0) revert NotRecorded(punkId);
        return _acquisitions[idx - 1];
    }

    /// @notice The mask bits this Punk would *currently* contribute to the
    ///         pending pool, based on the live `collectedMask`. Differs from
    ///         `pendingAcquisitionMaskOf` (which is the historical record).
    function newBitsFor(
        uint16 punkId
    ) external view returns (uint256) {
        return _newBitsFor(punkId);
    }

    /// @notice Population count of `newBitsFor(punkId)`.
    function newBitsCountFor(
        uint16 punkId
    ) external view returns (uint256) {
        return _popcount(_newBitsFor(punkId));
    }

    function _newBitsFor(
        uint16 punkId
    ) internal view returns (uint256) {
        if (punkId >= 10_000) return 0;
        return punksData.traitMaskOf(punkId) & ~collectedMask;
    }

    // ────────── helpers ──────────

    /// @dev Hamming weight of `x`. Classic SWAR popcount — pure constant-time.
    function _popcount(
        uint256 x
    ) internal pure returns (uint256 c) {
        unchecked {
            x = x - ((x >> 1) & 0x5555555555555555555555555555555555555555555555555555555555555555);
            x = (x & 0x3333333333333333333333333333333333333333333333333333333333333333)
                + ((x >> 2) & 0x3333333333333333333333333333333333333333333333333333333333333333);
            x = (x + (x >> 4)) & 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f;
            c = (x * 0x0101010101010101010101010101010101010101010101010101010101010101) >> 248;
        }
    }

    /// @dev Unpack trait `bit`'s carrier count from the packed `CARRIER_COUNTS`
    ///      table (big-endian uint16 at byte offsets 2*bit, 2*bit+1). Callers
    ///      pass `bit < TRAIT_COUNT`, so the indices are always in range.
    function _carrierCount(
        uint8 bit
    ) internal pure returns (uint16) {
        uint256 i = uint256(bit) * 2;
        return (uint16(uint8(CARRIER_COUNTS[i])) << 8) | uint16(uint8(CARRIER_COUNTS[i + 1]));
    }
}
