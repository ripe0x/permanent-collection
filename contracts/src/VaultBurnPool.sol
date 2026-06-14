// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IVaultBurnPool} from "./interfaces/IVaultBurnPool.sol";
import {OneTimeSetup} from "./libraries/OneTimeSetup.sol";
import {PCNoReentry} from "./libraries/PCNoReentry.sol";

/// @dev Minimal burn-capable ERC20 surface of the 111 token. `burn`
///      reduces total supply directly.
interface IBurnableToken {
    function balanceOf(address) external view returns (uint256);
    function burn(uint256) external;
}

/// @title  VaultBurnPool
/// @notice Burn accumulator for the V4 vault outcome, released on every
///         vault-path settle. Holds two assets:
///
///           - ETH from `ReturnAuctionModule.settle` cleared paths
///             (the `(highBid − cost) + CLEARED_VAULT_BURN_BPS × cost` slice)
///             and any `receive` top-up, forwarded to `BuybackBurner`.
///           - the 111 token's venue-scoped transfer-tax proceeds (this
///             contract is the token's tax `burnAddress`), burned in place.
///
///         Both legs release on the SAME trigger: `ReturnAuctionModule`
///         calls `sweep()` when a return auction ends with no clearing bidder
///         and the Punk enters the vault. So the pool only acts when the
///         protocol permanently collects a new trait — the ETH funds a
///         buy-and-burn and the accrued 111 is burned outright, both in one
///         step. The accumulator pattern means a vault outcome on a
///         long-uncollected trait can produce a large single-step impulse —
///         by design.
///
/// @dev    No admin, no withdrawal path. The only configurable surface is the
///         one-shot `setup` that wires the 111 token (resolving the
///         token↔burnAddress construction cycle). The only ETH outflow is
///         `sweep()` to `buybackBurner` (immutable); the only 111 outflow is
///         `burn` (supply reduction) — never a transfer to an external
///         address. A bytecode-scan test asserts the absence of every
///         withdrawal and token-transfer-out selector — see
///         `test/VaultBurnPool.t.sol`.
contract VaultBurnPool is IVaultBurnPool, OneTimeSetup, PCNoReentry {
    error NotReturnAuctionModule();
    error ZeroAddress();

    /// @notice Emitted on each `sweep` that actually forwarded ETH.
    event Swept(uint256 amount);
    /// @notice Emitted on each `sweep` that burned accrued 111-token tax.
    event SidePoolTaxBurned(uint256 amount);

    /// @notice The only caller of `sweep`. Set immutably at construction.
    address public immutable returnAuctionModule;
    /// @notice Recipient of every swept balance. Set immutably.
    address payable public immutable buybackBurner;
    /// @notice The 111 token whose venue-tax proceeds accrue here and are
    ///         burned on each vault-path `sweep`. Wired once via `setup`;
    ///         zero (and the 111 burn leg dormant) until then.
    address public token;

    /// @param _finalSaleModule The contract that orchestrates vault-path
    ///                         settlements (the only authorized sweeper).
    /// @param _buybackBurner   111 buy-and-burn sink — receives every sweep.
    constructor(
        address _finalSaleModule,
        address payable _buybackBurner,
        address _swapContext
    ) OneTimeSetup() PCNoReentry(_swapContext) {
        if (_finalSaleModule == address(0) || _buybackBurner == address(0)) revert ZeroAddress();
        returnAuctionModule = _finalSaleModule;
        buybackBurner = _buybackBurner;
    }

    /// @notice One-shot wiring of the 111 token whose venue-scoped transfer
    ///         tax burns here. The token's tax `burnAddress` is this contract,
    ///         a construction cycle (the token is deployed after this pool)
    ///         that this setter resolves. After it runs the setup gate closes
    ///         permanently — `token` can never be re-pointed.
    function setup(address _token) external onlySetup {
        if (_token == address(0)) revert ZeroAddress();
        token = _token;
        _markFinalized();
    }

    /// @notice Accept ETH from any source. Typical inflow is
    ///         `ReturnAuctionModule.settle` forwarding the cleared-path
    ///         vault-burn share (premium + 10%-of-cost slice), but any
    ///         address may top up the pool — direct donations compound the
    ///         impulse delivered on the next vault outcome. The receive
    ///         has no state mutation (and no event) to keep the path cheap.
    receive() external payable {}

    /// @inheritdoc IVaultBurnPool
    /// @dev    Non-reverting by construction when called by `returnAuctionModule`
    ///         (the only authorized caller): the 111 burn of the contract's own
    ///         balance cannot revert, and the ETH forward is best-effort (a
    ///         failed forward leaves the ETH for the next sweep rather than
    ///         reverting). So `ReturnAuctionModule.settle` calls this DIRECTLY,
    ///         with no `try/catch` — which is exactly what makes the 111 burn
    ///         GUARANTEED: `eth_estimateGas` must provision it, whereas a
    ///         caught revert would let the estimator pick a cheaper
    ///         burn-skipped path and silently defer the burn.
    ///
    ///         The `notInSwap` decoration is the dormant Design-B reentrancy
    ///         seam (`PCSwapContext.inSwap` is permanently false at launch, so
    ///         the modifier is a no-op until a synchronous extension is ever
    ///         bound). Here it is belt-and-suspenders: the first line already
    ///         gates the only caller to `returnAuctionModule`.
    ///
    ///         There is intentionally NO `nonReentrant` mutex: the only external
    ///         call is the ETH forward to the immutable, trusted `buybackBurner`
    ///         (whose `receive` only credits a counter and cannot call back),
    ///         the `returnAuctionModule`-only gate blocks any reentry regardless,
    ///         and the burn precedes the forward (CEI) so there is no stale state
    ///         to corrupt.
    function sweep() external notInSwap returns (uint256 forwarded) {
        if (msg.sender != returnAuctionModule) revert NotReturnAuctionModule();

        // 111 leg FIRST and REQUIRED: burn any accrued venue-tax 111 outright
        // (direct supply reduction; never transferred to an external address).
        // Burning the contract's own balance cannot revert, so this leg always
        // completes — the on-chain guarantee that the side-pool tax is burned
        // on the vault outcome. `token` is zero until wired (pure-ETH no-op).
        address t = token;
        if (t != address(0)) {
            uint256 bal = IBurnableToken(t).balanceOf(address(this));
            if (bal != 0) {
                IBurnableToken(t).burn(bal);
                emit SidePoolTaxBurned(bal);
            }
        }

        // ETH leg: BEST-EFFORT. Forward accumulated cleared-auction proceeds to
        // the buy-and-burn sink; on a failed forward the ETH stays for the next
        // sweep. NEVER reverts, so `settle` can call `sweep` directly without
        // any risk of a stranded Punk.
        forwarded = address(this).balance;
        if (forwarded != 0) {
            (bool ok,) = buybackBurner.call{value: forwarded}("");
            if (ok) {
                emit Swept(forwarded);
            } else {
                forwarded = 0;
            }
        }
    }

    /// @notice Current ETH balance — equivalent to what the next `sweep`
    ///         would forward.
    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
