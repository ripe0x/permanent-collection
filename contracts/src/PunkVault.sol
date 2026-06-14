// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "solmate/src/tokens/ERC721.sol";

import {ICryptoPunksMarket} from "./interfaces/ICryptoPunksMarket.sol";
import {IPunkVault} from "./interfaces/IPunkVault.sol";

interface IRendererRegistryView {
    function tokenURI(uint256 id) external view returns (string memory);
    function contractURI(address token) external view returns (string memory);
}

/// @title  PunkVault
/// @notice Immutable terminal custodian for Punks whose 72-hour return auction
///         did not clear. The vault holds Punks via direct ownership on the
///         CryptoPunks market.
///
///         The vault is also the issuer of the protocol's 112 named ERC721
///         objects — the contract that answers "what is in the Permanent
///         Collection" in machine-readable form:
///
///           - **Token ids 0..110 — the Proofs.** One per first-vaulting of
///             a previously-uncollected trait. Minted at vault-settle time
///             to the `originalSeller` recorded on the acquisition (the
///             pre-lister on `acceptBid`; the listing seller on
///             `acceptListing` — NOT the finder). The token id for a Proof
///             IS the trait id (a Proof for trait 20 is token id 20).
///             Capped at 111 forever: no Proof mints for vaultings of
///             already-collected traits, no Proof mints for cleared return
///             auctions.
///
///           - **Token id 111 — the Title.** A one-of-one deed minted on
///             demand by the immutable `titleAuction` contract once 50% of
///             the collection has been completed. Grants no claim on the
///             Punks, no withdrawal rights, no admin powers — purely a
///             legible record of titular ownership.
///
///         Both classes of object are issued from disjoint, hard-coded
///         token-id ranges by two distinct immutable minters:
///
///           - `returnAuctionModule` may mint token ids 0..110 only, via
///             `mintProofs`. Calls for token id 111 or ≥ 112 revert. Mints
///             at most once per trait id.
///           - `titleAuction` may mint token id 111 only. Calls for any
///             other id revert. Mints at most once.
///
///         Token ids ≥ 112 are unreachable from any code path.
///
///         **Marketplace-collection editor (owner / renounce):** the vault
///         exposes ERC-173 `owner()` so OpenSea / Blur / Magic Eden
///         recognize a wallet as the collection's editor — used post-launch
///         to set the collection banner image, profile image, description
///         override, and social links on the marketplace's UI. The slot is
///         a **one-way ratchet**: initialized to the deployer EOA in the
///         constructor and only ever settable to `address(0)` via
///         `renounceOwnership()`. There is no `transferOwnership` — once
///         renounced, no key compromise can re-acquire collection-editor
///         rights, and OpenSea will refuse all future edits. The owner has
///         no on-chain authority over the vault, the Punks, the ERC721
///         metadata content (which comes from `RendererRegistry`), or any
///         other PC contract. The expected sequence is: deploy → set up
///         the OpenSea collection page → call `renounceOwnership()`.
///
/// @dev    There is NO withdrawal function for Punks. The contract has no
///         path to `transferPunk`, `offerPunkForSale`, `acceptBidForPunk`,
///         or any other write on the market. Once a Punk is owned by this
///         address, it can never leave. A bytecode scan in the test suite
///         asserts the absence of every outbound market selector.
///
///         The Title and Proofs themselves are transferable ERC721 tokens —
///         the bytecode-scan invariant is about *Punks* not having an exit
///         path; the ERC721 representing roles in the collection trade
///         normally.
///
///         The vault has NO admin functions. The wiring slots
///         (`titleAuction`, `rendererRegistry`) are deployer-only one-shot
///         setters that lock after first use.
contract PunkVault is IPunkVault, ERC721 {
    error NotReturnAuction();
    error ZeroAddress();
    error AlreadyLocked(uint16 punkId);
    error NotOwnedByVault(uint16 punkId);
    error NotTitleAuction();
    error NotDeployer();
    error TitleAuctionAlreadySet();
    error RendererRegistryAlreadySet();
    error TitleAlreadyMinted();
    error UnknownTokenId(uint256 id);
    error TitleNotMinted();
    error RendererRegistryNotSet();
    /// @notice Reverts on `mintProofs` if `traitId >= 111`.
    error InvalidTraitId(uint8 traitId);
    /// @notice Reverts on `mintProofs` if a Proof for `traitId` already exists.
    error ProofAlreadyMinted(uint8 traitId);
    /// @notice Reverts on `mintProofs` if the recipient is `address(0)`.
    ///         Defense in depth: `PermanentCollection.recordAcquisition`
    ///         already enforces a non-zero `originalSeller`.
    error InvalidRecipient();
    /// @notice Reverts on `renounceOwnership` if the caller is not the
    ///         current `owner()`. Once the owner has renounced, no further
    ///         calls succeed (the only valid caller — `address(0)` — cannot
    ///         originate a transaction).
    error NotOwner();

    /// @notice Emitted once per Punk that enters the vault. The Punk is now
    ///         permanently held — by design there is no event for "released".
    event PunkLocked(uint16 indexed punkId);
    /// @notice Emitted once at title-mint time. Mirrors the ERC721
    ///         `Transfer(0, titleAuction, 0)` for indexers that key on a
    ///         protocol-specific event name.
    event TitleMinted(address indexed to);
    /// @notice Emitted once per Proof at mint time. Fires inside
    ///         `mintProofs`, alongside the ERC721 `Transfer(0, recipient, tokenId)`.
    /// @param tokenId Token id on `PunkVault` (= `traitId`, range 0..110).
    /// @param traitId The trait this Proof attests to (0..110).
    /// @param punkId The Punk whose vaulting brought the trait into the
    ///        collection (= `firstVaultedPunk(traitId)` at mint time).
    /// @param recipient The address that gave up the Punk (the
    ///        `originalSeller` recorded on the acquisition). Always
    ///        non-zero; minted unconditionally regardless of receiver
    ///        capability (no `onERC721Received` callback).
    /// @param acquisitionId 0-based index of the acquisition in
    ///        `PermanentCollection._acquisitions` whose vault-settle
    ///        produced this Proof.
    /// @param sequence 1-based collection sequence — the value of
    ///        `collectedCount()` at mint time. Equals the order in which
    ///        traits are vaulted (1 = first trait collected, 111 = last).
    ///        Diverges from `tokenId` (= `traitId`) because traits are
    ///        vaulted in an arbitrary order, not in trait-id order.
    /// @param mintedAtBlock `block.number` at mint time.
    event ProofMinted(
        uint256 indexed tokenId,
        uint8 indexed traitId,
        uint16 indexed punkId,
        address recipient,
        uint256 acquisitionId,
        uint16 sequence,
        uint256 mintedAtBlock
    );
    /// @notice Emitted at the one-shot wiring of the title auction.
    event TitleAuctionSet(address indexed auction);
    /// @notice Emitted at the one-shot wiring of the renderer registry.
    event RendererRegistrySet(address indexed registry);
    /// @notice EIP-4906 metadata-refresh hint. Emitted on `receivePunk`
    ///         (vault state changes that affect title attributes) and on
    ///         `mintToAuction` (token is now visible).
    event MetadataUpdate(uint256 _tokenId);
    /// @notice ERC-7572 collection-metadata refresh hint. Emitted whenever
    ///         the contents of `contractURI()` may have changed in a
    ///         marketplace-visible way: on title mint and on every Proof
    ///         mint (the renderer's "N of 111" inscription and the title
    ///         JSON's collection-progress fields both depend on the
    ///         mint state of these tokens). OpenSea, Blur, and other
    ///         ERC-7572-aware indexers refresh their cached collection
    ///         metadata on this event.
    event ContractURIUpdated();
    /// @notice ERC-173 ownership transition. Emitted once at construction
    ///         (from `address(0)` → deployer) and once at renounce
    ///         (deployer → `address(0)`). The slot is a one-way ratchet —
    ///         no other transitions are possible.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Token id of the single vault-Title NFT.
    /// @dev    The Title sits just past the Proof range so the 111
    ///         Proofs occupy `tokenId == traitId` directly (a Proof for
    ///         trait 20 IS token id 20). Title at id 111 is "the
    ///         next one up" — easy to remember and disambiguate.
    uint256 public constant TITLE_TOKEN_ID = 111;

    /// @notice Highest valid Proof token id (= 110). Proofs occupy ids
    ///         0..MAX_PROOF_TOKEN_ID inclusive, with `tokenId == traitId`
    ///         (the Punks-traits-contract trait id maps directly).
    uint256 public constant MAX_PROOF_TOKEN_ID = 110;

    /// @notice Number of distinct Proofs (1 per trait). Constant from the
    ///         underlying trait taxonomy on `PunksData`.
    uint8 public constant PROOF_COUNT = 111;

    /// @notice The 2017 CryptoPunks market (mainnet `0xb47e3cd8…3BBB`).
    ICryptoPunksMarket public immutable punksMarket;

    /// @notice The only contract that may call `receivePunk`. Set immutably
    ///         at construction; cannot be rotated or revoked.
    address public immutable returnAuctionModule;

    /// @notice Deployer EOA — gates the one-shot `setTitleAuction` and
    ///         `setRendererRegistry` wiring functions. Has no other authority.
    address private immutable _deployer;

    /// @notice ERC-173 owner. Initialized to the deployer EOA in the
    ///         constructor and only ever settable to `address(0)` via
    ///         `renounceOwnership()`. Marketplaces (OpenSea, Blur, etc.)
    ///         read this slot via `owner()` to decide which wallet can
    ///         edit the collection page. No on-chain authority — does NOT
    ///         gate any state-mutating function on this contract or
    ///         elsewhere in PC. See `renounceOwnership()`.
    address private _owner;

    /// @notice Count of permanently-locked (vaulted) Punks. Monotonic. The
    ///         full per-Punk history is reconstructable from the `PunkLocked`
    ///         event log; this counter is the cheap on-chain summary the
    ///         renderer reads.
    uint256 public lockedPunkCount;
    /// @notice Per-Punk lock flag. Once true, stays true forever.
    mapping(uint16 => bool) public isLocked;

    /// @notice The only contract that may call `mintToAuction`. Set by the
    ///         deployer via `setTitleAuction` exactly once.
    address public titleAuction;
    /// @notice Stable address fronting the renderer. Set by the deployer
    ///         via `setRendererRegistry` exactly once. `tokenURI` delegates
    ///         to this contract's `tokenURI(uint256)`.
    address public rendererRegistry;
    /// @notice True iff the title token has been minted.
    bool public titleMinted;

    /// @notice Per-Proof metadata, keyed by Proof token id (0..110). Frozen
    ///         at mint time — all four fields are written once and never
    ///         change, even if the Proof is transferred. The current
    ///         owner is queried separately via `ownerOf` (the contribution
    ///         event is immutable; the current title-holder is not).
    /// @param punkId        The Punk whose vaulting produced this Proof.
    /// @param traitId       The trait this Proof attests to (= tokenId).
    /// @param sequence      1-based collection sequence (= collectedCount()
    ///                      at mint time). Can diverge from `traitId`.
    /// @param mintedAtBlock `block.number` at mint time.
    struct ProofMeta {
        uint16 punkId;
        uint8  traitId;
        uint16 sequence;
        uint64 mintedAtBlock;
    }
    mapping(uint256 => ProofMeta) public proofMeta;

    /// @notice Bitmap of Proofs minted so far (bit `traitId` set iff the
    ///         Proof for that trait has been minted). Single SLOAD for the
    ///         renderer / frontend to compute "issued so far".
    uint256 public proofsMintedMask;

    /// @notice Number of Proofs minted so far (0..111). Equivalent to
    ///         `popcount(proofsMintedMask)`. Tracked explicitly so the
    ///         renderer can compose the "N of 111" inscription without
    ///         walking the bitmap.
    uint16 public proofsMintedCount;

    /// @param _punksMarket     The 2017 CryptoPunks market.
    /// @param _finalSaleModule Sole caller of `receivePunk`. The deployer
    ///                         precomputes its address via CREATE-nonce math
    ///                         so the vault can reference it immutably while
    ///                         the ReturnAuctionModule itself is deployed next.
    constructor(address _punksMarket, address _finalSaleModule)
        ERC721("Title to PERMANENT COLLECTION Vault", "PERMANENTCOLLECTION")
    {
        if (_punksMarket == address(0) || _finalSaleModule == address(0)) revert ZeroAddress();
        punksMarket = ICryptoPunksMarket(_punksMarket);
        returnAuctionModule = _finalSaleModule;
        _deployer = msg.sender;
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice One-shot wiring: bind the title auction address. After this
    ///         call, `mintToAuction` is callable only by that address and
    ///         this function reverts forever. Deployer-only.
    function setTitleAuction(address _titleAuction) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (titleAuction != address(0)) revert TitleAuctionAlreadySet();
        if (_titleAuction == address(0)) revert ZeroAddress();
        titleAuction = _titleAuction;
        emit TitleAuctionSet(_titleAuction);
    }

    /// @notice One-shot wiring: bind the renderer registry address. After
    ///         this call, `tokenURI` delegates to the registry and this
    ///         function reverts forever. Deployer-only.
    function setRendererRegistry(address _rendererRegistry) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (rendererRegistry != address(0)) revert RendererRegistryAlreadySet();
        if (_rendererRegistry == address(0)) revert ZeroAddress();
        rendererRegistry = _rendererRegistry;
        emit RendererRegistrySet(_rendererRegistry);
    }

    // ────────── ERC-173 owner (marketplace collection editor) ──────────

    /// @notice ERC-173 owner. Marketplaces (OpenSea, Blur, Magic Eden)
    ///         read this slot to decide which wallet can edit the
    ///         collection page (banner image, profile image, description
    ///         override, social links). Returns the deployer EOA at
    ///         construction; returns `address(0)` permanently once
    ///         `renounceOwnership()` has been called.
    /// @dev    Carries no on-chain authority over the vault, the Punks,
    ///         the ERC721 metadata content (rendered by `RendererRegistry`),
    ///         or any other PC contract. The slot exists solely to give
    ///         marketplaces a recognizable editor handle during the
    ///         launch-setup window.
    function owner() external view returns (address) {
        return _owner;
    }

    /// @notice Permanently renounce marketplace-collection-editor rights.
    ///         Sets `owner()` to `address(0)` forever — no path can ever
    ///         re-assign it (there is intentionally no `transferOwnership`).
    ///         After this call, OpenSea / Blur / etc. will refuse all
    ///         collection-page edits, freezing the marketplace metadata
    ///         (banner, profile image, description override, social links)
    ///         alongside the on-chain `contractURI()` content.
    /// @dev    The one-way ratchet is intentional. The owner slot exists
    ///         only for the launch-setup window; keeping a transferable
    ///         editor surface long-term would be the only attack vector
    ///         a key compromise could exploit, since the slot itself has
    ///         no on-chain authority. Renouncing eliminates even that
    ///         vector.
    function renounceOwnership() external {
        address current = _owner;
        if (msg.sender != current) revert NotOwner();
        _owner = address(0);
        emit OwnershipTransferred(current, address(0));
    }

    /// @inheritdoc IPunkVault
    function receivePunk(uint16 punkId) external {
        if (msg.sender != returnAuctionModule) revert NotReturnAuction();
        if (isLocked[punkId]) revert AlreadyLocked(punkId);
        // The caller (return auction module) must have already executed
        // `transferPunk(vault, punkId)` before this call. Verifying current
        // market ownership keeps the locked list honest even if the call
        // ordering is ever tweaked.
        if (punksMarket.punkIndexToAddress(uint256(punkId)) != address(this)) {
            revert NotOwnedByVault(punkId);
        }
        isLocked[punkId] = true;
        unchecked { lockedPunkCount += 1; }
        emit PunkLocked(punkId);
        if (titleMinted) emit MetadataUpdate(TITLE_TOKEN_ID);
    }

    /// @inheritdoc IPunkVault
    function mintToAuction() external {
        if (msg.sender != titleAuction) revert NotTitleAuction();
        if (titleMinted) revert TitleAlreadyMinted();
        titleMinted = true;
        _mint(titleAuction, TITLE_TOKEN_ID);
        emit TitleMinted(titleAuction);
        emit MetadataUpdate(TITLE_TOKEN_ID);
        // ERC-7572: the title's existence changes collection-page state
        // (totalSupply jumps, the title becomes visible). Signal a refresh
        // so OpenSea / Blur / etc. update without waiting on poll cadence.
        emit ContractURIUpdated();
    }

    /// @inheritdoc IPunkVault
    function mintProofs(
        uint16 punkId,
        uint8 targetTraitId,
        address recipient,
        uint256 acquisitionId,
        uint16 sequence
    ) external {
        // Hard-coded minter scoping: only the ReturnAuctionModule may mint
        // Proofs. The title-auction minter has no path to this function;
        // the proof minter (this function) has no path to token id 111
        // (Title) — `mintToAuction` is independently gated.
        if (msg.sender != returnAuctionModule) revert NotReturnAuction();
        if (targetTraitId >= PROOF_COUNT) revert InvalidTraitId(targetTraitId);
        if (recipient == address(0)) revert InvalidRecipient();

        // Token id IS the trait id — direct 1:1 mapping with the
        // PunksData trait taxonomy. Proof 20 = trait 20.
        uint256 tokenId = uint256(targetTraitId);
        // Defense in depth: pin to [0, MAX_PROOF_TOKEN_ID]. The earlier
        // `targetTraitId >= PROOF_COUNT` check already enforces this, but
        // the explicit upper-bound mirrors the dispatch in `tokenURI`.
        if (tokenId > MAX_PROOF_TOKEN_ID) revert UnknownTokenId(tokenId);

        uint256 traitBit = uint256(1) << uint256(targetTraitId);
        if (proofsMintedMask & traitBit != 0) revert ProofAlreadyMinted(targetTraitId);

        proofsMintedMask |= traitBit;
        unchecked { proofsMintedCount += 1; }

        proofMeta[tokenId] = ProofMeta({
            punkId: punkId,
            traitId: targetTraitId,
            sequence: sequence,
            mintedAtBlock: uint64(block.number)
        });

        // Use `_mint` (not `_safeMint`) so a non-receiver-aware contract
        // seller (no `onERC721Received`) cannot strand the Proof. The
        // contribution event is immutable; the Proof exists regardless
        // of whether the recipient's contract is "polite" about ERC721.
        _mint(recipient, tokenId);

        emit ProofMinted(
            tokenId,
            targetTraitId,
            punkId,
            recipient,
            acquisitionId,
            sequence,
            block.number
        );
        emit MetadataUpdate(tokenId);
        // ERC-7572: every Proof mint shifts the renderer's "N of 111"
        // collection-progress inscription and the title JSON's progress
        // fields. Signal a refresh so OpenSea / Blur / etc. update without
        // waiting on poll cadence.
        emit ContractURIUpdated();
    }

    /// @notice The current title holder. Returns `address(0)` before the
    ///         title is minted; otherwise the ERC721 owner of token 1.
    function titleOwner() external view returns (address) {
        if (!titleMinted) return address(0);
        return _ownerOf[TITLE_TOKEN_ID];
    }

    // `lockedPunkCount` is a public state var (auto-getter) — see its
    // declaration above. The `PunkLocked` event log is the canonical per-Punk
    // history; there is no array accessor for the full locked-Punk list.

    // ────────── ERC721 metadata ──────────

    /// @inheritdoc ERC721
    /// @dev Valid ids are 0..110 (Proofs, one per trait) and 111 (Title).
    ///         - id 0..110       → delegates to the renderer iff the Proof
    ///                             for that trait has been minted; else
    ///                             reverts `UnknownTokenId(id)` (the id is
    ///                             in-shape but its token has not been
    ///                             issued — indistinguishable from a
    ///                             never-mintable id for marketplace polls)
    ///         - id 111 pre-mint → reverts `TitleNotMinted`
    ///         - id 111 post-mint→ delegates to the renderer
    ///         - id ≥ 112        → reverts `UnknownTokenId(id)`
    ///      Resolution is delegated to `RendererRegistry`, which forwards
    ///      to the configured renderer implementation; the renderer
    ///      dispatches internally based on `id`.
    function tokenURI(uint256 id) public view override returns (string memory) {
        if (id <= MAX_PROOF_TOKEN_ID) {
            uint8 traitId = uint8(id);
            if ((proofsMintedMask >> traitId) & 1 == 0) revert UnknownTokenId(id);
        } else if (id == TITLE_TOKEN_ID) {
            if (!titleMinted) revert TitleNotMinted();
        } else {
            revert UnknownTokenId(id);
        }
        if (rendererRegistry == address(0)) revert RendererRegistryNotSet();
        return IRendererRegistryView(rendererRegistry).tokenURI(id);
    }

    /// @notice ERC-7572 collection-level metadata. Marketplaces (OpenSea,
    ///         Blur, etc.) read this for the collection page. The renderer
    ///         branches on the caller's address — passing `address(this)`
    ///         opts into title-flavored JSON (distinct from the artcoins
    ///         ERC20's metadata, which routes through the same registry).
    function contractURI() external view returns (string memory) {
        if (rendererRegistry == address(0)) revert RendererRegistryNotSet();
        return IRendererRegistryView(rendererRegistry).contractURI(address(this));
    }

    /// @notice Total supply of all PunkVault-issued ERC721 objects:
    ///         the Title (one-of-one) plus all minted Proofs (max 111).
    ///         Marketplaces and indexers without ERC721Enumerable support
    ///         use this to size their collection-page UI.
    function totalSupply() external view returns (uint256) {
        return (titleMinted ? 1 : 0) + uint256(proofsMintedCount);
    }

    /// @notice Number of Proofs minted so far. Caps at 111.
    function totalProofsMinted() external view returns (uint256) {
        return uint256(proofsMintedCount);
    }

    /// @notice True iff a Proof has already been minted for `traitId`.
    /// @dev    Returns false for `traitId >= 111` (out of range, never
    ///         mintable). Cheaper than calling `ownerOf(traitId)`
    ///         which would revert pre-mint.
    function isProofMinted(uint8 traitId) external view returns (bool) {
        if (traitId >= PROOF_COUNT) return false;
        return (proofsMintedMask >> traitId) & 1 == 1;
    }

    /// @notice ERC165 — extends solmate's interface set with EIP-4906
    ///         (`0x49064906`) so marketplaces know to listen for
    ///         `MetadataUpdate`.
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0x49064906 || super.supportsInterface(interfaceId);
    }
}
