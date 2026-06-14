// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {HookMiner} from "./HookMiner.sol";

import {ArtCoinsHookSkimFee} from "artcoins/hooks/ArtCoinsHookSkimFee.sol";
import {ArtCoinsMevLinearSkim} from "artcoins/mev-modules/ArtCoinsMevLinearSkim.sol";
import {ProtocolFeeController} from "artcoins/protocol-fee/ProtocolFeeController.sol";
import {ArtCoinsLpLocker} from "artcoins/lp-lockers/ArtCoinsLpLocker.sol";
import {ArtCoinsFactory} from "artcoins/ArtCoinsFactory.sol";
import {ArtCoinsFeeEscrow} from "artcoins/ArtCoinsFeeEscrow.sol";

interface IPCLaunchLegacyHookView {
    function poolExtensionAllowlist() external view returns (address);
}

/// @title  PCLaunchStackDeployer
/// @notice THE single source of truth for deploying the fresh artcoins stack
///         PC launches on. Inherited by the fork-test fixture
///         (`FreshArtcoinsStack`), the dev-fork bootstrap (`BootstrapDevFork`),
///         and the production owner-ops broadcast script
///         (`DeployArtcoinsLaunchStack`). One implementation means the tested
///         path is literally the broadcast path — no hand-maintained copy can
///         drift a wiring step (the gap that produced audit H-1's confusion).
///
///         PC does NOT launch on the existing mainnet artcoins stack. The live
///         V3 factory (`0xF051cd…6793e`) cannot produce the venue-scoped
///         transfer-tax token bytecode (no `deployTokenWithProtocolBpsAndTax`),
///         so the launch deploys a FRESH tax-aware `ArtCoinsFactory`, plus a
///         FRESH `ArtCoinsFeeEscrow` (the old `0xDD1b…1C06` is not reused), the
///         skim hook, the skim MEV module, a PC-dedicated `ProtocolFeeController`
///         (86.67/13.33), and a conversion locker. The existing mainnet
///         hook/MEV/escrow are the LEGACY stack and are not used.
///
///         CRITICAL wiring: the skim hook deposits the protocol fee leg into the
///         escrow on every swap, so it MUST be `escrow.addDepositor`'d (along
///         with the locker) or the first swap and every swap reverts
///         `Unauthorized`. That step lives here, so it can never be forgotten.
abstract contract PCLaunchStackDeployer {
    // ─── Mainnet infrastructure (live on a fork) ─────────────────────────

    address internal constant PCLS_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant PCLS_POSITION_MANAGER = 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e;
    address internal constant PCLS_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant PCLS_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    /// @dev The legacy hook is read only for the shared pool-extension allowlist
    ///      instance (factory-owned artcoins infra the new skim hook reuses).
    address internal constant PCLS_HOOK_LEGACY = 0xAAd673ea3945dF5F7Ef328974d2c07c8BdcAA8Cc;

    /// @dev MUST match `ArtCoinsHookSkimFee.getHookPermissions()`. v4 encodes the
    ///      hook's permission flags in the low 14 bits of its address, so the
    ///      CREATE2 salt is mined against these bits and the ctor reverts
    ///      `HookAddressNotValid` if they don't match:
    ///        beforeInitialize | beforeAddLiquidity | afterRemoveLiquidity
    ///        | beforeSwap | afterSwap | beforeSwapReturnsDelta
    ///        | afterSwapReturnsDelta
    uint160 internal constant PCLS_SKIM_HOOK_FLAGS =
        (1 << 13) | (1 << 11) | (1 << 8) | (1 << 7) | (1 << 6) | (1 << 3) | (1 << 2);

    /// @dev PC's ProtocolFeeController split: 86.67% PC treasury / 13.33% LAYER burn.
    uint16 internal constant PCLS_CONTROLLER_TREASURY_BPS = 8667;

    struct PCLaunchStack {
        ArtCoinsFactory factory;
        ArtCoinsFeeEscrow escrow;
        ArtCoinsHookSkimFee hook;
        ArtCoinsMevLinearSkim mev;
        ProtocolFeeController controller;
        ArtCoinsLpLocker locker;
    }

    /// @notice Deploy + wire the fresh artcoins launch stack.
    /// @param owner          Owner of the deployed factory/escrow/controller/
    ///                       locker AND the effective `msg.sender` of this call
    ///                       (so the owner-gated wiring below succeeds):
    ///                       `address(this)` in a test, the broadcaster EOA in a
    ///                       `vm.broadcast` script.
    /// @param create2Deployer The deployer the hook salt is mined against — this
    ///                       MUST equal who actually executes `new …{salt}`:
    ///                       `address(this)` when this method runs from a test
    ///                       contract, `CREATE2_FACTORY` (the canonical proxy)
    ///                       when it runs under `vm.broadcast` (foundry routes
    ///                       salted CREATE2 through the proxy, not the EOA).
    /// @param teamFeeRecipient Factory team-fee sink (PC routes 0 protocol bps,
    ///                       but the recipient must be non-zero).
    /// @param treasury       PC treasury recipient for the controller.
    /// @param burnRouter     LAYER burn-router recipient for the controller.
    function _deployPCLaunchStack(
        address owner,
        address create2Deployer,
        address teamFeeRecipient,
        address treasury,
        address burnRouter
    ) internal returns (PCLaunchStack memory s) {
        address extAllowlist = IPCLaunchLegacyHookView(PCLS_HOOK_LEGACY).poolExtensionAllowlist();

        // ── Fresh tax-aware factory (owned by `owner`) ───────────────────
        s.factory = new ArtCoinsFactory(owner);
        s.factory.setDeprecated(false);
        s.factory.setTeamFeeRecipient(teamFeeRecipient);

        // ── Fresh fee escrow (owned by `owner`; the old mainnet escrow is
        //    not reused) ────────────────────────────────────────────────
        s.escrow = new ArtCoinsFeeEscrow(owner);

        // ── Skim hook (CREATE2-mined to encode the v4 permission flags) ──
        bytes memory hookCtorArgs =
            abi.encode(PCLS_POOL_MANAGER, address(s.factory), extAllowlist, PCLS_WETH, address(s.escrow));
        (address predictedHook, bytes32 hookSalt) =
            HookMiner.find(create2Deployer, PCLS_SKIM_HOOK_FLAGS, type(ArtCoinsHookSkimFee).creationCode, hookCtorArgs);
        s.hook = new ArtCoinsHookSkimFee{salt: hookSalt}(
            PCLS_POOL_MANAGER, address(s.factory), extAllowlist, PCLS_WETH, address(s.escrow)
        );
        require(address(s.hook) == predictedHook, "PCLaunchStack: hook addr mismatch");
        s.factory.setHook(address(s.hook), true);
        require(s.factory.enabledHooks(address(s.hook)), "PCLaunchStack: hook not enabled");

        // ── Skim MEV module ──────────────────────────────────────────────
        s.mev = new ArtCoinsMevLinearSkim();
        s.factory.setMevModule(address(s.mev), true);
        require(s.factory.enabledMevModules(address(s.mev)), "PCLaunchStack: mev not enabled");

        // ── PC-dedicated ProtocolFeeController (86.67/13.33 treasury/burn) ─
        s.controller = new ProtocolFeeController(owner, treasury, burnRouter, PCLS_CONTROLLER_TREASURY_BPS);

        // ── Lean LP locker, bound to the fresh factory + escrow ──────────
        s.locker = new ArtCoinsLpLocker(owner, address(s.factory), address(s.escrow), PCLS_POSITION_MANAGER, PCLS_PERMIT2);
        s.factory.setLocker(address(s.locker), address(s.hook), true);
        // Zero the locker-level keeper skim (PC converts the artcoin-side LP
        // fees downstream via FeeAutoSwapper).
        s.locker.setKeeperRewardBps(0);

        // ── Escrow depositors: BOTH the locker (LP-fee path) AND the hook
        //    (protocol-fee leg, every swap). Missing the hook bricks trading. ─
        s.escrow.addDepositor(address(s.locker));
        s.escrow.addDepositor(address(s.hook));
    }
}
