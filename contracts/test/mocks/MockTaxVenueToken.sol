// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @title  MockTaxVenueToken — Track-B test double for the router sweep
/// @notice A faithful, hermetic copy of `ArtCoinsToken`'s venue-scoped buy-side
///         transfer-tax mechanic, with the parity cap RAISED so the side-pool
///         tax can be set to 10/15/20/25% — rates the production token blocks via
///         `TAX_BPS_ABSOLUTE_MAX = 500` (invariant #21). The tax-firing condition,
///         the amount-pinned EIP-1153 canonical-exemption budget, and the
///         venue/exempt checks are copied byte-for-byte from `ArtCoinsToken` so
///         the double's behavior matches the real token at 5% (asserted by a
///         fidelity test). This contract exists ONLY for the router-economics
///         experiment and is never deployed anywhere near mainnet.
///
/// @dev    Differences from `ArtCoinsToken`, all test-scoped:
///         - `taxBpsMax` is a constructor arg with NO 500 backstop (so >5% works).
///         - `canonicalPoolId` / `canonicalHook` are settable once via `wire()`
///           rather than computed in the constructor — the test deploys the
///           attesting buy-helper after the token, then wires it.
///         - V2/V3 venue derivation is dropped: both Track-B pools are V4, so the
///           single `taxPoolManager` immutable covers them (every V4 pool is a
///           venue). Side-pool taxation therefore needs no precomputed addresses.
///         - All ERC20 metadata/renderer/admin cruft is removed.
contract MockTaxVenueToken is ERC20 {
    error NotAdmin();
    error NotCanonicalHook();
    error TaxBpsTooHigh();

    uint256 private constant TAX_DENOMINATOR = 10_000;
    bytes32 private constant _CANONICAL_BUDGET_SLOT =
        keccak256("mock.token.canonicalExemptionBudget.v1");

    string private _name;
    string private _symbol;
    address public admin;

    address public immutable taxPoolManager;
    address public immutable taxBurnAddress;
    uint16 public immutable taxBpsMax; // NO 500 backstop — that's the whole point

    uint16 public taxBps;
    address public canonicalHook; // the attesting buy-helper (set via wire)
    bytes32 public canonicalPoolId; // the canonical-equiv pool id (set via wire)

    mapping(address => bool) private _taxExempt;

    event TaxApplied(address indexed from, address indexed to, uint256 gross, uint256 tax, uint256 net);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        address admin_,
        address poolManager_,
        address burnAddress_,
        uint16 taxBps_,
        uint16 taxBpsMax_,
        address[] memory exempt_
    ) {
        _name = name_;
        _symbol = symbol_;
        admin = admin_;
        taxPoolManager = poolManager_;
        taxBurnAddress = burnAddress_;
        require(taxBps_ <= taxBpsMax_, "bps>max");
        taxBpsMax = taxBpsMax_;
        taxBps = taxBps_;
        for (uint256 i = 0; i < exempt_.length; i++) {
            _taxExempt[exempt_[i]] = true;
        }
        _mint(msg.sender, maxSupply_);
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    /// @notice Wire the canonical pool id + its attesting hook. Re-callable so a
    ///         test can swap the canonical-equivalent pool (e.g. to vary its LP
    ///         fee) between configs; production's real token computes this once
    ///         in its constructor.
    function wire(address canonicalHook_, bytes32 canonicalPoolId_) external {
        if (msg.sender != admin) revert NotAdmin();
        canonicalHook = canonicalHook_;
        canonicalPoolId = canonicalPoolId_;
    }

    function setTaxBps(uint16 newBps) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newBps > taxBpsMax) revert TaxBpsTooHigh();
        taxBps = newBps;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    // ─── Tax path — copied from ArtCoinsToken ──────────────────────────────

    function transfer(address to, uint256 amount) public override returns (bool) {
        _taxedTransfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _taxedTransfer(from, to, amount);
        return true;
    }

    function _taxedTransfer(address from, address to, uint256 amount) internal {
        uint16 bps = taxBps;
        if (bps != 0 && amount != 0 && _isTaxVenue(from) && !_taxExempt[to]) {
            uint256 exemptAmt = _consumeCanonicalBudget(amount);
            uint256 taxable = amount - exemptAmt;
            uint256 tax = (taxable * uint256(bps)) / TAX_DENOMINATOR;
            if (tax != 0) {
                _transfer(from, to, amount - tax);
                _transfer(from, taxBurnAddress, tax);
                emit TaxApplied(from, to, amount, tax, amount - tax);
                return;
            }
        }
        _transfer(from, to, amount);
    }

    function _consumeCanonicalBudget(uint256 amount) private returns (uint256 exemptAmt) {
        uint256 b = _loadCanonicalBudget();
        if (b == 0) return 0;
        exemptAmt = b >= amount ? amount : b;
        _storeCanonicalBudget(b - exemptAmt);
    }

    function _loadCanonicalBudget() private view returns (uint256 b) {
        bytes32 slot = _CANONICAL_BUDGET_SLOT;
        /// @solidity memory-safe-assembly
        assembly {
            b := tload(slot)
        }
    }

    function _storeCanonicalBudget(uint256 b) private {
        bytes32 slot = _CANONICAL_BUDGET_SLOT;
        /// @solidity memory-safe-assembly
        assembly {
            tstore(slot, b)
        }
    }

    function attestCanonicalBudget(bytes32 poolId, uint256 amount) external {
        if (msg.sender != canonicalHook) revert NotCanonicalHook();
        if (poolId != canonicalPoolId || amount == 0) return;
        uint256 b = _loadCanonicalBudget();
        unchecked {
            _storeCanonicalBudget(b + amount);
        }
    }

    function isTaxVenue(address account) external view returns (bool) {
        return _isTaxVenue(account);
    }

    function isTaxExempt(address account) external view returns (bool) {
        return _taxExempt[account];
    }

    function _isTaxVenue(address account) internal view returns (bool) {
        return account == taxPoolManager;
    }
}
