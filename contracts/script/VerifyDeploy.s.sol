// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

/* ── Minimal read-only views ────────────────────────────────────────────── */

interface ICollectionView {
    function patron() external view returns (address);
    function returnAuctionModule() external view returns (address);
    function punkVault() external view returns (address);
    function buybackBurner() external view returns (address);
    function punksData() external view returns (address);
    function collectedMask() external view returns (uint256);
    function acquisitionCount() external view returns (uint256);
    function collectedCount() external view returns (uint256);
}

interface IPunksDataView {
    function datasetHash() external view returns (bytes32);
}

interface IPatronView {
    function permanentCollection() external view returns (address);
    function returnAuctionModule() external view returns (address);
    function allowedSellers(address) external view returns (bool);
}

interface ILiveBidAdapterView {
    function patron() external view returns (address);
    function activationThreshold() external view returns (uint256);
    function permanentCollection() external view returns (address);
}

interface IPCSwapContextView {
    function owner() external view returns (address);
    function authorizedExtension() external view returns (address);
    function authorizedExtensionLocked() external view returns (bool);
    function inSwap() external view returns (bool);
}

interface IReferralPayoutView {
    function hook() external view returns (address);
    function balances(address) external view returns (uint256);
}

interface IProtocolFeePhaseAdapterView {
    function feeEscrow() external view returns (address);
    function controller() external view returns (address);
}

interface IProtocolFeeControllerView {
    function treasury() external view returns (address);
    function burnRouter() external view returns (address);
    function treasuryBps() external view returns (uint16);
    function burnBps() external view returns (uint16);
}

interface IFeeEscrowView {
    function allowedDepositors(address) external view returns (bool);
}

interface IMevSkimView {
    function skimConfigs(bytes32 poolId)
        external
        view
        returns (uint24 startingBps, uint24 endingBps, uint32 durationSeconds, uint256 startTime);
}

interface IFeeAutoSwapperView {
    function maxStepIn() external view returns (uint256);
    function maxSlippageBps() external view returns (uint256);
    function poolFee() external view returns (uint24);
    function poolTickSpacing() external view returns (int24);
    function hook() external view returns (address);
    function pairedToken() external view returns (address);
}

/// @notice Post-deploy sanity script for the four-leg skim architecture.
///         Reads `deployments.json` and prints / asserts the load-bearing
///         invariants. Run via `forge script script/VerifyDeploy.s.sol`.
contract VerifyDeploy is Script {
    function run() external {
        // Honors a `DEPLOYMENTS_PATH` env override (fork-test fixtures point each
        // parallel suite at its own file); defaults to `<root>/deployments.json`
        // for the production verify, matching what the deploy script wrote.
        string memory path = vm.envOr("DEPLOYMENTS_PATH", string.concat(vm.projectRoot(), "/deployments.json"));
        string memory json = vm.readFile(path);

        address collection = vm.parseJsonAddress(json, ".permanentCollection");
        address patron = vm.parseJsonAddress(json, ".patron");
        address returnAuctionModule = vm.parseJsonAddress(json, ".returnAuctionModule");
        address vault = vm.parseJsonAddress(json, ".punkVault");
        address liveBidAdapter = vm.parseJsonAddress(json, ".liveBidAdapter");
        address pcSwapContext = vm.parseJsonAddress(json, ".pcSwapContext");
        address referralPayout = vm.parseJsonAddress(json, ".referralPayout");
        address hookAddr = vm.parseJsonAddress(json, ".hook");
        address protocolFeePhaseAdapter = vm.parseJsonAddress(json, ".protocolFeePhaseAdapter");

        console2.log("== Core ==");
        console2.log("permanentCollection", collection);
        console2.log("patron              ", patron);
        console2.log("returnAuctionModule     ", returnAuctionModule);
        console2.log("punkVault           ", vault);
        console2.log("hook                ", hookAddr);
        console2.log("== Design B preservation ==");
        console2.log("pcSwapContext       ", pcSwapContext);
        console2.log("referralPayout      ", referralPayout);

        // PermanentCollection wiring
        ICollectionView c = ICollectionView(collection);
        require(c.patron() == patron, "collection.patron");
        require(c.returnAuctionModule() == returnAuctionModule, "collection.returnAuctionModule");
        require(c.punkVault() == vault, "collection.punkVault");

        // External-dependency authenticity (PunksData). PunksData is the sealed
        // trait dataset every target choice reads; it is the one external
        // dependency PC fully trusts. Assert the deployed collection is wired to
        // the canonical mainnet PunksData AND that it reports the pinned dataset
        // hash, so a substituted dataset contract fails the post-deploy check.
        // (The artcoins fee-path dependencies -- hook / escrow / locker /
        // controller / MEV -- are deliberately NOT codehash-asserted: each
        // carries deploy-specific immutables that change its runtime codehash per
        // launch, so a fixed expected-hash would mis-fire. Their authenticity
        // roots in the deployer key, the factory that created them in one tx, and
        // the wiring + escrow-depositor checks below.)
        address punksData = vm.parseJsonAddress(json, ".punksData");
        require(
            punksData == 0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C,
            "punksData != canonical mainnet PunksData"
        );
        require(c.punksData() == punksData, "collection.punksData != deployments.punksData");
        require(
            IPunksDataView(punksData).datasetHash()
                == 0x92117ce6cb6bb70f9ffb9bf51ebbca6a84eae10e70639295d9c4a07958cd1f68,
            "punksData.datasetHash != pinned EXPECTED_DATASET_HASH"
        );
        console2.log("punksData (canonical)", punksData);

        // Patron wiring
        IPatronView p = IPatronView(patron);
        require(p.permanentCollection() == collection, "patron.collection");
        require(p.returnAuctionModule() == returnAuctionModule, "patron.returnAuctionModule");

        // LiveBidAdapter — bound to Patron, auto-tracking the records core,
        // seeded with the 30 ETH fast/throttled activation threshold.
        ILiveBidAdapterView b = ILiveBidAdapterView(liveBidAdapter);
        require(b.patron() == patron, "liveBidAdapter.patron");
        require(b.permanentCollection() == collection, "liveBidAdapter.permanentCollection (auto-track)");
        require(b.activationThreshold() == 30 ether, "liveBidAdapter.activationThreshold seed");

        // PCSwapContext — dormant at launch (authorizedExtension == 0)
        IPCSwapContextView ctx = IPCSwapContextView(pcSwapContext);
        require(ctx.authorizedExtension() == address(0), "swapContext dormant at launch");
        require(!ctx.inSwap(), "inSwap false at launch");

        // ReferralPayout — bound to the deployed hook
        IReferralPayoutView rp = IReferralPayoutView(referralPayout);
        require(rp.hook() == hookAddr, "referralPayout.hook bound to deployed hook");

        // Launch-blocker defense: the skim hook deposits the protocol fee leg
        // into the fee escrow on EVERY swap (`storeFeesNative`), which reverts
        // `Unauthorized` for non-depositors — so if the hook was not added as an
        // escrow depositor during the artcoins owner-ops wiring, the first swap
        // and every swap bricks the pool. The escrow is resolved from the phase
        // adapter's immutable `feeEscrow`, the same source the frontend uses.
        address feeEscrow = IProtocolFeePhaseAdapterView(protocolFeePhaseAdapter).feeEscrow();
        console2.log("feeEscrow           ", feeEscrow);
        require(
            IFeeEscrowView(feeEscrow).allowedDepositors(hookAddr),
            "feeEscrow: skim hook must be an escrow depositor (else every swap reverts)"
        );

        // The protocol leg's TERMINAL split. The phase adapter forwards the
        // protocol leg to the PCController, whose `processNativeFees()` pays
        // treasury (treasuryBps) + burn router (burnBps). Assert the wired
        // controller has non-zero sinks and the intended 86.67% / 13.33% split,
        // so a misconfigured controller can't silently mis-route every
        // protocol-fee ETH after launch. (Covered end-to-end by
        // LaunchFeeDistributionForkTest.)
        address pcControllerAddr = IProtocolFeePhaseAdapterView(protocolFeePhaseAdapter).controller();
        IProtocolFeeControllerView pcCtrl = IProtocolFeeControllerView(pcControllerAddr);
        console2.log("pcController         ", pcControllerAddr);
        console2.log("  treasury          ", pcCtrl.treasury());
        console2.log("  burnRouter        ", pcCtrl.burnRouter());
        console2.log("  treasuryBps       ", uint256(pcCtrl.treasuryBps()));
        console2.log("  burnBps           ", uint256(pcCtrl.burnBps()));
        require(pcCtrl.treasury() != address(0), "controller.treasury unset");
        require(pcCtrl.burnRouter() != address(0), "controller.burnRouter unset");
        require(pcCtrl.treasuryBps() == 8667, "controller.treasuryBps != 8667 (86.67% PC treasury)");
        require(pcCtrl.burnBps() == 1333, "controller.burnBps != 1333 (13.33% LAYER burn)");
        require(
            uint256(pcCtrl.treasuryBps()) + uint256(pcCtrl.burnBps()) == 10_000,
            "controller split must sum to 100%"
        );

        // The PunkStrategy listing contract is seeded into Patron's seller
        // allowlist at deploy (Deploy.s.sol). Verify it's present so a
        // missing or mis-seeded allowlist fails the post-deploy check loudly.
        require(
            p.allowedSellers(0xc50673EDb3A7b94E8CAD8a7d4E0cD68864E33eDF),
            "patron.allowedSellers PunkStrategy seeded"
        );

        // The MEV skim module must decay to EXACTLY the hook's baseline skim:
        // after the anti-sniper window `currentSkimBps` returns the module's
        // `endingBps`, so if that doesn't equal the baseline the pool would run
        // at a wrong static skim forever. Cross-checked against the baseline the
        // deploy configured into the hook (the hook has no public getter).
        address mevModule = vm.parseJsonAddress(json, ".mevModule");
        bytes32 canonicalPoolId = vm.parseJsonBytes32(json, ".canonicalPoolId");
        uint256 baselineSkimBps = vm.parseJsonUint(json, ".baselineSkimBps");
        (, uint24 endingBps,,) = IMevSkimView(mevModule).skimConfigs(canonicalPoolId);
        console2.log("mevModule           ", mevModule);
        console2.log("baselineSkimBps     ", baselineSkimBps);
        console2.log("mev endingBps       ", uint256(endingBps));
        require(
            uint256(endingBps) == baselineSkimBps,
            "mev endingBps must equal hook baselineSkimBps (else wrong post-window skim)"
        );

        // L-4: the downstream LP-fee converter's sandwich guard. Its constructor
        // pins maxSlippageBps into a sane band and maxStepIn above zero, so the
        // gate can't be disabled; surface both so the operator confirms maxStepIn
        // is conservative for the launch depth.
        address feeAutoSwapper = vm.parseJsonAddress(json, ".feeAutoSwapper");
        uint256 maxStepIn = IFeeAutoSwapperView(feeAutoSwapper).maxStepIn();
        uint256 maxSlippageBps = IFeeAutoSwapperView(feeAutoSwapper).maxSlippageBps();
        console2.log("feeAutoSwapper      ", feeAutoSwapper);
        console2.log("  maxStepIn         ", maxStepIn);
        console2.log("  maxSlippageBps    ", maxSlippageBps);
        require(maxSlippageBps != 0, "feeAutoSwapper slippage gate disabled");

        // The FAS is permanently locked in (its locker reward-slot admin is
        // 0xdEaD), so a pool-config mismatch can never be fixed: its converts
        // would revert forever and the LP-fee bid stream would silently stall.
        // Reconstruct the FAS's target pool id and require it equals the
        // canonical pool (checks fee + tickSpacing + hook + pairing at once).
        require(
            IFeeAutoSwapperView(feeAutoSwapper).pairedToken() == address(0),
            "feeAutoSwapper not native-ETH-paired"
        );
        bytes32 fasPoolId = PoolId.unwrap(
            PoolIdLibrary.toId(
                PoolKey({
                    currency0: Currency.wrap(address(0)),
                    currency1: Currency.wrap(vm.parseJsonAddress(json, ".token")),
                    fee: IFeeAutoSwapperView(feeAutoSwapper).poolFee(),
                    tickSpacing: IFeeAutoSwapperView(feeAutoSwapper).poolTickSpacing(),
                    hooks: IHooks(IFeeAutoSwapperView(feeAutoSwapper).hook())
                })
            )
        );
        require(
            fasPoolId == canonicalPoolId,
            "feeAutoSwapper pool config != canonical pool (converts would fail forever)"
        );

        console2.log("VerifyDeploy: OK");
    }
}
