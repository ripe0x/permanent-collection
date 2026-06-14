// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {HookMiner} from "./HookMiner.sol";

import {ArtCoinsHookSkimFee} from "artcoins/hooks/ArtCoinsHookSkimFee.sol";
import {ArtCoinsMevLinearSkim} from "artcoins/mev-modules/ArtCoinsMevLinearSkim.sol";
import {ProtocolFeeController} from "artcoins/protocol-fee/ProtocolFeeController.sol";
import {ArtCoinsLpLocker} from "artcoins/lp-lockers/ArtCoinsLpLocker.sol";
import {ArtCoinsFactory} from "artcoins/ArtCoinsFactory.sol";
import {ArtCoinsFeeEscrow} from "artcoins/ArtCoinsFeeEscrow.sol";
import {PCLaunchStackDeployer} from "./PCLaunchStackDeployer.sol";

/// @notice Minimal ETH sink — accepts ETH via receive(), holds it forever.
///         Used as the treasury + burn-router stand-ins for the PCController
///         in integration tests so we can assert what amount landed where
///         without depending on the real burn flow, and as the factory's
///         team-fee recipient sink.
contract MockEthSink {
    receive() external payable {}

    /// @dev Matches `IBurnRouter.layerToken()` signature; the PCController
    ///      only reads it from setBurnRouter (admin-only path we don't drive
    ///      in these tests).
    function layerToken() external pure returns (address) {
        return address(0xDEAD);
    }
}

/// @notice Shared fork-test scaffolding that deploys the **fresh** artcoins
///         stack PC's launch ships — a freshly-owned tax-aware
///         `ArtCoinsFactory`, a fresh `ArtCoinsFeeEscrow`, the skim hook
///         (`ArtCoinsHookSkimFee`) at a CREATE2 address encoding its v4
///         permission flags, the skim MEV module (`ArtCoinsMevLinearSkim`), a
///         PC-dedicated `ProtocolFeeController` (86.67/13.33) with mock sinks, and a
///         fresh conversion locker — all allowlisted directly on the
///         fixture-owned factory.
///
///         Both `SkimForkFixture` (drives the real `DeployScript`) and
///         `ForkFixtures` (manual PC deployment, test-as-admin) inherit this so
///         there is ONE fresh-stack deploy, not two copies. Call
///         `_deployFreshArtcoinsStack()` after selecting a mainnet fork.
abstract contract FreshArtcoinsStack is Test, PCLaunchStackDeployer {
    // ─── External mainnet addresses ──────────────────────────────────────

    address internal constant ARTCOINS_FACTORY_V3 = 0xF051cd4C4F3F36F9f24d8a19d60Ee8F84FC6793e;
    address internal constant ARTCOINS_HOOK_LEGACY = 0xAAd673ea3945dF5F7Ef328974d2c07c8BdcAA8Cc;
    address internal constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant POSITION_MANAGER = 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    // Used by fixtures/tests (e.g. Swap.t.sol) to drive router swaps — no longer
    // a locker constructor dep (the lean locker does not swap).
    address internal constant UNIVERSAL_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
    address internal constant WETH_ADDR = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    /// @dev Anvil default key 0. DeployScript reads `PRIVATE_KEY` and uses
    ///      `vm.addr(PRIVATE_KEY)` as the broadcaster.
    uint256 internal constant DEV_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // ─── Hook permission flag mask (must match getHookPermissions) ───────

    /// @dev v4 encodes hook permissions in the lowest 14 bits of the hook
    ///      contract's deployment address. ArtCoinsHookSkimFee returns
    ///      `beforeInitialize + beforeAddLiquidity + afterRemoveLiquidity +
    ///      beforeSwap + afterSwap + beforeSwapReturnsDelta +
    ///      afterSwapReturnsDelta`:
    ///        1<<13 | 1<<11 | 1<<8 | 1<<7 | 1<<6 | 1<<3 | 1<<2 = 0x29CC
    uint160 internal constant SKIM_HOOK_FLAGS =
        (1 << 13) | (1 << 11) | (1 << 8) | (1 << 7) | (1 << 6) | (1 << 3) | (1 << 2);

    // ─── Deployed-by-this-helper instances ───────────────────────────────

    ArtCoinsHookSkimFee internal skimHook;
    ArtCoinsMevLinearSkim internal mevSkimModule;
    ProtocolFeeController internal pcController;
    MockEthSink internal pcTreasury;
    MockEthSink internal pcBurnRouter;
    ArtCoinsLpLocker internal conversionLocker;
    /// @dev Freshly-deployed tax-aware factory. PC's launch redeploys the
    ///      factory (no coins on the original V3 factory yet); its linked
    ///      deployer produces the new token bytecode with the venue-scoped
    ///      transfer-tax constructor. Owned by this fixture, so hook / MEV /
    ///      locker are allowlisted directly (no owner impersonation).
    ArtCoinsFactory internal taxFactory;
    ArtCoinsFeeEscrow internal feeEscrow;
    MockEthSink internal factoryFeeSink;

    // ─── Fresh-stack deploy (via the shared PCLaunchStackDeployer) ────────

    /// @notice Deploy the full fresh artcoins stack via the shared
    ///         `PCLaunchStackDeployer` — the SAME code the production owner-ops
    ///         broadcast script (`DeployArtcoinsLaunchStack`) runs, so the fork
    ///         suite exercises the exact mainnet deploy path. Call after
    ///         selecting a mainnet fork (the legacy hook is read for its shared
    ///         pool-extension allowlist; PoolManager must exist).
    function _deployFreshArtcoinsStack() internal {
        require(ARTCOINS_FACTORY_V3.code.length > 0, "fresh-stack: factory missing");
        require(ARTCOINS_HOOK_LEGACY.code.length > 0, "fresh-stack: legacy hook missing");
        require(POOL_MANAGER.code.length > 0, "fresh-stack: PoolManager missing");

        // Test-side sinks the shared deployer wires in (production passes real
        // recipients). In a test, `new …{salt}` deploys from this fixture, so
        // both the owner and the CREATE2 deployer are `address(this)`.
        factoryFeeSink = new MockEthSink();
        pcTreasury = new MockEthSink();
        pcBurnRouter = new MockEthSink();

        PCLaunchStack memory s = _deployPCLaunchStack(
            address(this), address(this), address(factoryFeeSink), address(pcTreasury), address(pcBurnRouter)
        );
        taxFactory = s.factory;
        feeEscrow = s.escrow;
        skimHook = s.hook;
        mevSkimModule = s.mev;
        pcController = s.controller;
        conversionLocker = s.locker;
    }
}
