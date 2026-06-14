// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {FreshArtcoinsStack} from "./FreshArtcoinsStack.sol";
import {IArtcoinsFactory} from "../../src/interfaces/IArtcoinsFactory.sol";

import {DeployScript} from "../../script/Deploy.s.sol";

import {PermanentCollection} from "../../src/PermanentCollection.sol";
import {PunkVault} from "../../src/PunkVault.sol";
import {Patron} from "../../src/Patron.sol";
import {ReturnAuctionModule} from "../../src/ReturnAuctionModule.sol";
import {BuybackBurner} from "../../src/BuybackBurner.sol";
import {LiveBidAdapter} from "../../src/LiveBidAdapter.sol";
import {VaultBurnPool} from "../../src/VaultBurnPool.sol";
import {ProtocolFeePhaseAdapter} from "../../src/ProtocolFeePhaseAdapter.sol";
import {PCSwapContext} from "../../src/PCSwapContext.sol";
import {ReferralPayout} from "../../src/ReferralPayout.sol";
import {ProtocolAdmin} from "../../src/ProtocolAdmin.sol";
import {ICryptoPunksMarket} from "../../src/interfaces/ICryptoPunksMarket.sol";
import {IPunksData} from "../../src/interfaces/IPunksData.sol";

/// @notice Fork-test scaffolding for the hook-redesign architecture.
///         Deploys the NEW skim hook (`ArtCoinsHookSkimFee`) at a CREATE2
///         address whose lower 14 bits encode the hook permission flags v4
///         requires, deploys the matching MEV decay module
///         (`ArtCoinsMevLinearSkim`), deploys a `ProtocolFeeController`
///         (PCController) wired with mock treasury + burn router sinks,
///         allowlists all three on the live mainnet factory by impersonating
///         the factory owner, deploys + allowlists a fresh conversion locker,
///         and sets every env var the production `DeployScript` reads:
///
///           ARTCOINS_HOOK_SKIM
///           ARTCOINS_MEV_SKIM
///           PC_CONTROLLER
///           CONVERSION_LOCKER
///           PRIVATE_KEY
///
///         After `_setupSkimStackEnv()` returns, calling
///         `new DeployScript().run()` succeeds end-to-end on a mainnet fork.
abstract contract SkimForkFixture is FreshArtcoinsStack {
    // The fresh artcoins stack (factory / escrow / skim hook / skim-MEV /
    // locker / PCController) + its constants + `MockEthSink` now live in the
    // shared `FreshArtcoinsStack` base. This fixture adds the env-var export +
    // the full `DeployScript.run()` drive on top.

    // ─── Setup orchestration ─────────────────────────────────────────────

    /// @notice Run after `vm.createSelectFork` (or an equivalent) so the
    ///         live artcoins factory + escrow exist on the fork. After this
    ///         call, `DeployScript.run()` resolves every env var it needs.
    function _setupSkimStackEnv() internal {
        _deployFreshArtcoinsStack();
        _exportEnvVars();
    }

    function _exportEnvVars() internal {
        vm.setEnv("ARTCOINS_FACTORY", vm.toString(address(taxFactory)));
        vm.setEnv("ARTCOINS_HOOK_SKIM", vm.toString(address(skimHook)));
        vm.setEnv("ARTCOINS_MEV_SKIM", vm.toString(address(mevSkimModule)));
        vm.setEnv("PC_CONTROLLER", vm.toString(address(pcController)));
        vm.setEnv("CONVERSION_LOCKER", vm.toString(address(conversionLocker)));
        // The fixture deploys a FRESH escrow (mirroring production); Deploy reads
        // it as a required env var and cross-checks it against
        // conversionLocker.feeLocker().
        vm.setEnv("ARTCOINS_FEE_ESCROW", vm.toString(address(feeEscrow)));
        vm.setEnv("PRIVATE_KEY", vm.toString(DEV_PK));
    }

    /// @dev Deployments file the fixture reads back. Mirrors the script's
    ///      `_deploymentsPath`: honors a `DEPLOYMENTS_PATH` env override (the
    ///      split rehearsal sets it to its own file), else the default
    ///      `<root>/deployments.json` that combined `run()` writes.
    function _deploymentsPath() internal view returns (string memory) {
        return vm.envOr("DEPLOYMENTS_PATH", string.concat(vm.projectRoot(), "/deployments.json"));
    }

    /// @notice Convenience: fund the broadcaster (`vm.addr(DEV_PK)`) with
    ///         enough ETH to pay the factory's deploy fee.
    function _fundDeployer() internal {
        vm.deal(vm.addr(DEV_PK), 5 ether);
    }

    /// @notice Fund the live bid the production way: deal the adapter then prank
    ///         it into `Patron.receive()`, which credits `accountedLiveBidWei`.
    ///         A raw `vm.deal(address(patron), ...)` would raise Patron's real
    ///         balance only (the forced-ETH path) and never move the accounted
    ///         bid, so `acceptBid`/`acceptListing` would have nothing to pay.
    function _fundPatronFromAdapter(uint256 amount) internal {
        vm.deal(address(liveBidAdapter), address(liveBidAdapter).balance + amount);
        vm.prank(address(liveBidAdapter));
        (bool ok,) = address(patron).call{value: amount}("");
        require(ok, "fixture: adapter funding failed");
    }

    // ─── Full-stack deploy + load ────────────────────────────────────────

    /// @dev Production-parity deploy state, populated by `_runFullDeploy`.
    PermanentCollection internal pc;
    Patron internal patron;
    PunkVault internal vault;
    ReturnAuctionModule internal finalSale;
    BuybackBurner internal burner;
    LiveBidAdapter internal liveBidAdapter;
    VaultBurnPool internal vaultBurnPool;
    ProtocolFeePhaseAdapter internal protocolFeePhaseAdapter;
    ProtocolAdmin internal adminContract;
    PCSwapContext internal pcSwapContext;
    ReferralPayout internal referralPayout;
    address internal token;
    address internal deployedHook;
    address internal deployedLocker;
    ICryptoPunksMarket internal punksMarket;
    IPunksData internal punksDataView;

    /// @notice One-call orchestration: run the env setup, fund the deployer,
    ///         invoke `DeployScript.run()`, then read `deployments.json`
    ///         and populate every state-var above. After this returns, the
    ///         protocol is live on the fork and tests can drive swaps + the
    ///         acquisition flow.
    /// @notice Combined-`run()` deploy. Used by the BEHAVIOR suites (invariants,
    ///         adapter modes, etc.) that just need a deployed system to test
    ///         against: the combined and split paths produce a BYTE-IDENTICAL end
    ///         state, so a behavior test doesn't care which built it. The
    ///         production Phase-2 SPLIT sequence is rehearsed by
    ///         `_runFullDeploySplit` (the dress rehearsal) — that's the test whose
    ///         job IS to validate the deploy sequence we ship.
    function _runFullDeploy() internal {
        _setupSkimStackEnv();
        _fundDeployer();
        new DeployScript().run();
        _loadDeployments();
    }

    /// @notice Dress rehearsal of the EXACT production Phase-2 sequence — what the
    ///         mainnet broadcast runs, NOT the legacy combined `run()`. Routes its
    ///         deployments through an ISOLATED file (`deployments.rehearsal.json`,
    ///         via the `DEPLOYMENTS_PATH` override) so the 2a-write → 2b-read
    ///         handoff never races the run()-based suites on the shared default
    ///         path under `-j`.
    function _runFullDeploySplit() internal {
        _setupSkimStackEnv();
        _fundDeployer();
        vm.setEnv("DEPLOYMENTS_PATH", string.concat(vm.projectRoot(), "/deployments.rehearsal.json"));
        _runSplitDeploy();
        _loadDeployments();
    }

    /// @notice Drive the two production Phase-2 broadcasts in sequence:
    ///
    ///           Phase 2a `runContracts()` → all PC contracts + PC-to-PC wiring,
    ///             dormant (no token, no pool, no swap fees); the deployments file
    ///             gets `token/hook/locker = address(0)`.
    ///           [verify-before-2b gate] → `_assertPhase2aDormant()` stands in
    ///             for the on-Etherscan verification the operator does between
    ///             the two mainnet broadcasts.
    ///           Phase 2b `runToken()` → token + V4 pool + LP + the three
    ///             post-token `setup()` wirings + the PunkStrategy allowlist.
    ///
    ///         Two SEPARATE `DeployScript` instances = the two separate
    ///         `forge --sig` broadcasts on mainnet; they communicate ONLY through
    ///         the deployments file (2b's `_readDeployments`), exactly as in
    ///         production. (`run()` stays on the script for back-compat.)
    function _runSplitDeploy() internal {
        new DeployScript().runContracts(); // Phase 2a — public mempool on mainnet
        _assertPhase2aDormant();
        new DeployScript().runToken(); // Phase 2b — private mempool on mainnet
    }

    /// @notice The post-Phase-2a invariant: every PC contract is deployed and
    ///         wired, but the system is DORMANT — no token, no pool, no locker
    ///         (so no swap fees and no live bid) until Phase 2b. This is what the
    ///         operator confirms on Etherscan before the irreversible token
    ///         broadcast; asserting it in-rehearsal proves the split is safe to
    ///         pause between phases.
    function _assertPhase2aDormant() internal view {
        string memory json = vm.readFile(_deploymentsPath());
        require(vm.parseJsonAddress(json, ".token") == address(0), "phase2a: token must be 0x0");
        require(vm.parseJsonAddress(json, ".hook") == address(0), "phase2a: hook must be 0x0");
        require(vm.parseJsonAddress(json, ".locker") == address(0), "phase2a: locker must be 0x0");
        require(
            vm.parseJsonAddress(json, ".permanentCollection") != address(0), "phase2a: PermanentCollection deployed"
        );
        require(vm.parseJsonAddress(json, ".patron") != address(0), "phase2a: Patron deployed");
        require(vm.parseJsonAddress(json, ".liveBidAdapter") != address(0), "phase2a: LiveBidAdapter deployed");
        require(vm.parseJsonAddress(json, ".returnAuctionModule") != address(0), "phase2a: ReturnAuctionModule deployed");
    }

    function _loadDeployments() internal {
        string memory path = _deploymentsPath();
        string memory json = vm.readFile(path);
        pc = PermanentCollection(vm.parseJsonAddress(json, ".permanentCollection"));
        patron = Patron(payable(vm.parseJsonAddress(json, ".patron")));
        vault = PunkVault(vm.parseJsonAddress(json, ".punkVault"));
        finalSale = ReturnAuctionModule(payable(vm.parseJsonAddress(json, ".returnAuctionModule")));
        burner = BuybackBurner(payable(vm.parseJsonAddress(json, ".buybackBurner")));
        liveBidAdapter = LiveBidAdapter(payable(vm.parseJsonAddress(json, ".liveBidAdapter")));
        vaultBurnPool = VaultBurnPool(payable(vm.parseJsonAddress(json, ".vaultBurnPool")));
        // PCFeeRouter no longer exists under the three-leg architecture —
        // the hook routes the two baseline legs (bounty / protocol)
        // directly to the adapters at swap time. The vault-burn leg has
        // been retired; VaultBurnPool is now fed exclusively from the
        // cleared-auction proceeds split in ReturnAuctionModule.settle.
        protocolFeePhaseAdapter =
            ProtocolFeePhaseAdapter(payable(vm.parseJsonAddress(json, ".protocolFeePhaseAdapter")));
        adminContract = ProtocolAdmin(vm.parseJsonAddress(json, ".protocolAdmin"));
        pcSwapContext = PCSwapContext(vm.parseJsonAddress(json, ".pcSwapContext"));
        referralPayout = ReferralPayout(payable(vm.parseJsonAddress(json, ".referralPayout")));
        token = vm.parseJsonAddress(json, ".token");
        deployedHook = vm.parseJsonAddress(json, ".hook");
        deployedLocker = vm.parseJsonAddress(json, ".locker");

        punksMarket = ICryptoPunksMarket(0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB);
        punksDataView = IPunksData(0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C);

        // The deployer is also the initial ProtocolAdmin admin (see
        // DeployScript step 1). Re-route it to this fixture so we can drive
        // admin-gated setters (the seller-allowlist + adapter parameters).
        // Owned by `vm.addr(DEV_PK)` after the broadcast.
        address dev = vm.addr(DEV_PK);
        vm.prank(dev);
        adminContract.transferAdmin(address(this));
    }

    // ─── Punk helpers (production-parity flow) ───────────────────────────

    /// @dev Transfer Punk `punkId` to `user`, then have `user` list it
    ///      EXCLUSIVELY to Patron at ~the current live bid so any caller can
    ///      finalize `acceptBid`. Returns the listed price.
    function _giveAndOfferToBounty(address user, uint16 punkId) internal returns (uint256 listed) {
        address owner_ = punksMarket.punkIndexToAddress(uint256(punkId));
        require(owner_ != address(0), "skim-fixture: punk unowned");
        if (owner_ != user) {
            vm.prank(owner_);
            punksMarket.transferPunk(user, uint256(punkId));
        }
        listed = patron.bidBalance();
        vm.prank(user);
        punksMarket.offerPunkForSaleToAddress(uint256(punkId), listed, address(patron));
    }

    /// @dev The protocol-derived canonical target (rarest uncollected,
    ///      non-pending bit on `punkId`'s mask) — the value `recordAcquisition`
    ///      enforces. Reverts `NoEligibleTarget` if none. (Pre-#1 this returned
    ///      the lowest eligible bit; it now mirrors `canonicalTargetOf`.)
    function _pickTarget(uint16 punkId) internal view returns (uint8) {
        return pc.canonicalTargetOf(punkId);
    }
}
