// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ProtocolAdmin} from "./ProtocolAdmin.sol";

interface IHookExtensionAdmin {
    function setPoolExtension(PoolKey calldata poolKey, address extension, bytes calldata initData)
        external;
    function lockPoolExtension(PoolKey calldata poolKey) external;
}

interface IHookSkimFeeAdmin {
    function setMaxReferralBpsOfVolume(PoolKey calldata poolKey, uint24 newCap) external;
}

interface IArtCoinsTokenTaxAdmin {
    function setTaxBps(uint16 newBps) external;
}

/// @title  TokenAdminPoker
/// @notice Retained-admin holder of the 111 ERC20's token-admin role. It is
///         the deliberate alternative to a full-lockout poker: it does NOT
///         renounce, so the protocol owner retains a gated handle to manage the
///         pool's per-swap fee extension on the hook:
///
///           - `bindExtension` — bind/re-bind/swap the extension (safety valve
///             for the new, not-yet-battle-tested fee flywheel).
///           - `lockExtension` — one-way freeze of the extension binding, to
///             be called once the flywheel is proven in production (the
///             "retain-now, freeze-later" path).
///
///         There is intentionally NO metadata-refresh `poke()`. The on-chain
///         art lives on `PunkVault`'s ERC721 tokens (the Title + 111 Proofs),
///         which emit ERC-7572 `ContractURIUpdated` themselves on every
///         title/proof mint — that is the only metadata-refresh signal the
///         protocol needs, and it fires straight from the vault on the real
///         collection events. The separate 111 ERC20 marketplace card is
///         mission-orthogonal (read by nothing on-chain) and is left to
///         marketplace re-indexing.
///
///         What stays frozen: this contract holds the token admin but exposes
///         NO `updateImage` / `setMetadataRenderer` / `updateMetadata` / verify
///         / `transferAdmin` passthrough, so those token-admin surfaces are
///         unreachable. (Renderer swaps are handled separately via
///         `RendererRegistry`.) The only retained powers are over the pool
///         extension, the per-pool referral cap, and the venue-scoped buy-tax
///         rate (`setTokenTaxBps`); everything else on the token is
///         effectively immutable.
///
///         The referral cap (`setHookMaxReferralBps`) has a `ProtocolAdmin`
///         carve-out: it's callable by EITHER `owner` (the bindExtension
///         operator path) OR the current `ProtocolAdmin.admin()` EOA. Either
///         role being alive keeps the cap tunable; the cap freezes only when
///         BOTH are burned. Matches the existing scoped raw-admin carve-outs
///         (`Patron.addAllowedSeller` and the sibling `setTokenTaxBps`).
///
/// @dev    `owner` is the protocol's launch key / multisig. `setup` pins the
///         token and the pool (key + its hook) once. The hook accepts
///         `bindExtension` / `lockExtension` because this contract is the token
///         admin (`token.admin() == this`).
contract TokenAdminPoker {
    error ZeroAddress();
    error NotOwner();
    error NotAuthorized();
    error NotSetup();
    error AlreadySetup();

    event ExtensionBound(address indexed hook, address indexed extension);
    event ExtensionLocked(address indexed hook);
    event MaxReferralBpsSet(address indexed hook, uint24 newCap);
    event TokenTaxBpsSet(address indexed token, uint16 newBps);
    event OwnershipTransferred(address indexed from, address indexed to);

    /// @notice Protocol owner (launch key / multisig). Holds the extension
    ///         admin power; can transfer or, by inaction, leave it standing.
    address public owner;
    /// @notice `ProtocolAdmin` reference used for the referral-cap carve-out:
    ///         `setHookMaxReferralBps` accepts the current admin EOA in
    ///         addition to `owner`, so the cap survives a `transferOwnership`
    ///         to a dead address. Frozen only when BOTH `owner` and
    ///         `adminContract.admin()` are zero. Immutable.
    ProtocolAdmin public immutable adminContract;
    /// @notice The 111 ERC20 whose admin role this contract holds.
    address public token;
    /// @notice The pool the extension / referral-cap setters act on, pinned
    ///         once in `setup`. Its `hooks` field is the only contract those
    ///         setters can ever call — never a caller-supplied address — and the
    ///         key scopes them to the single canonical pool.
    PoolKey public poolKey;
    bool public setupDone;

    constructor(address owner_, address adminContract_) {
        if (owner_ == address(0) || adminContract_ == address(0)) revert ZeroAddress();
        owner = owner_;
        adminContract = ProtocolAdmin(adminContract_);
        emit OwnershipTransferred(address(0), owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice One-shot wiring. Pins the token and the pool (key + its hook).
    ///         Owner-only, once. Pinning the pool here is what lets
    ///         `bindExtension` / `lockExtension` / `setHookMaxReferralBps` drop
    ///         their target arguments — they can only ever act on this pool.
    function setup(address _token, PoolKey calldata _poolKey) external onlyOwner {
        if (setupDone) revert AlreadySetup();
        if (_token == address(0) || address(_poolKey.hooks) == address(0)) {
            revert ZeroAddress();
        }
        token = _token;
        poolKey = _poolKey;
        setupDone = true;
    }

    /// @notice Transfer the retained extension-admin power.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Owner-gated: bind (or re-bind) the per-swap fee extension on the
    ///         pool `hook`. Works because this contract is the token admin; the
    ///         hook also requires the extension to be allowlisted. Re-callable
    ///         until `lockExtension` freezes it.
    function bindExtension(address extension) external onlyOwner {
        if (!setupDone) revert NotSetup();
        address hook = address(poolKey.hooks);
        IHookExtensionAdmin(hook).setPoolExtension(poolKey, extension, "");
        emit ExtensionBound(hook, extension);
    }

    /// @notice Owner-gated, one-way: permanently freeze the pool's extension
    ///         binding. Call once the flywheel is proven to make it immutable.
    function lockExtension() external onlyOwner {
        if (!setupDone) revert NotSetup();
        address hook = address(poolKey.hooks);
        IHookExtensionAdmin(hook).lockPoolExtension(poolKey);
        emit ExtensionLocked(hook);
    }

    /// @notice Update the per-pool referral cap on the skim-fee hook.
    ///         Accepted from EITHER `owner` (the retained-admin path, same
    ///         as `bindExtension` / `lockExtension`) OR the current
    ///         `adminContract.admin()` EOA (the `ProtocolAdmin` carve-out
    ///         path — survives `transferOwnership(address(0))` on this
    ///         contract, freezes only when ProtocolAdmin is burned via
    ///         `transferAdmin(address(0))`).
    ///
    ///         The hook enforces the hard upper bound
    ///         (`MAX_REFERRAL_CAP_OF_VOLUME = 1_000`, i.e. 1% of swap volume
    ///         in the 100k denominator); this wrapper just forwards the
    ///         decoded value through to the hook.
    /// @dev    Carve-out rationale (matches the existing
    ///         `Patron.addAllowedSeller` pattern): referral
    ///         economics track a market regime that shifts over the
    ///         protocol's lifetime, so the cap should remain tunable even
    ///         after the 1-year `ProtocolAdmin` timer auto-locks AND after
    ///         the deliberately-retained TokenAdminPoker owner is renounced.
    ///         The cap is bounded `[0, 1_000]` at the hook level, so the
    ///         worst either role can do is sweep within that band. PC
    ///         launches with `maxReferralBpsOfVolume = 250` (0.25% of swap
    ///         volume); raise/lower via this function.
    function setHookMaxReferralBps(uint24 newCap) external {
        if (msg.sender != owner && msg.sender != adminContract.admin()) {
            revert NotAuthorized();
        }
        if (!setupDone) revert NotSetup();
        address hook = address(poolKey.hooks);
        IHookSkimFeeAdmin(hook).setMaxReferralBpsOfVolume(poolKey, newCap);
        emit MaxReferralBpsSet(hook, newCap);
    }

    /// @notice Update the bound token's venue-scoped buy-tax rate (in bps).
    ///         Accepted from EITHER `owner` OR the current `adminContract.admin()`
    ///         EOA — the SAME two-key `ProtocolAdmin` carve-out as
    ///         `setHookMaxReferralBps`. The rate stays tunable past the 1-year
    ///         `ProtocolAdmin` timer AND past `transferOwnership(address(0))` on
    ///         this contract; it freezes only when BOTH roles are burned.
    ///
    ///         This contract holds the token-admin role, so the token's
    ///         `setTaxBps` (gated to `msg.sender == token admin`) accepts this
    ///         forward. The token enforces the hard bound
    ///         (`taxBps <= taxBpsMax`, and `taxBpsMax <= TAX_BPS_ABSOLUTE_MAX =
    ///         2000`), so this wrapper can only sweep within `[0, taxBpsMax]` —
    ///         never above the 20% cap. PC launches at 15% (`taxBps = 1500`);
    ///         this setter only lowers/restores within the band.
    /// @dev    Carve-out rationale matches `setHookMaxReferralBps` and the
    ///         `Patron.addAllowedSeller` family: the tax rate tracks
    ///         a market regime (side-pool competition) that shifts over the
    ///         protocol's lifetime, so freezing the launch value permanently
    ///         would be wrong. No-op-safe on a dormant token: the token reverts
    ///         `TaxNotEnabled` if the tax feature is off.
    function setTokenTaxBps(uint16 newBps) external {
        if (msg.sender != owner && msg.sender != adminContract.admin()) {
            revert NotAuthorized();
        }
        address t = token;
        if (t == address(0)) revert NotSetup();
        IArtCoinsTokenTaxAdmin(t).setTaxBps(newBps);
        emit TokenTaxBpsSet(t, newBps);
    }
}
