// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

import {PermanentCollection} from "../../src/PermanentCollection.sol";
import {PunkVault} from "../../src/PunkVault.sol";
import {Patron} from "../../src/Patron.sol";
import {LiveBidAdapter} from "../../src/LiveBidAdapter.sol";
import {BuybackBurner} from "../../src/BuybackBurner.sol";
import {ReturnAuctionModule} from "../../src/ReturnAuctionModule.sol";
import {ProtocolAdmin} from "../../src/ProtocolAdmin.sol";
import {VaultBurnPool} from "../../src/VaultBurnPool.sol";
import {ICryptoPunksMarket} from "../../src/interfaces/ICryptoPunksMarket.sol";
import {IPunksData} from "../../src/interfaces/IPunksData.sol";
import {IArtcoinsFactory} from "../../src/interfaces/IArtcoinsFactory.sol";
import {IArtcoinsLocker} from "../../src/interfaces/IArtcoinsLocker.sol";
import {PermanentCollectionMosaicRenderer} from "../../src/PermanentCollectionMosaicRenderer.sol";
import {PermanentCollectionProofRenderer} from "../../src/PermanentCollectionProofRenderer.sol";
import {PunkSvgFragmentCache} from "../../src/PunkSvgFragmentCache.sol";
import {TraitIconCache} from "../../src/TraitIconCache.sol";
import {PunkVaultTitleAuction} from "../../src/PunkVaultTitleAuction.sol";
import {RendererRegistry} from "../../src/RendererRegistry.sol";

import {FreshArtcoinsStack} from "./FreshArtcoinsStack.sol";
import {IArtCoinsHookSkimFee} from "artcoins/hooks/interfaces/IArtCoinsHookSkimFee.sol";
import {FeeAutoSwapper} from "artcoins/FeeAutoSwapper.sol";
import {TaxConfig, TaxVenue} from "artcoins/interfaces/IArtCoinsTaxable.sol";

interface IERC20Lite {
    function balanceOf(
        address
    ) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function transfer(
        address,
        uint256
    ) external returns (bool);
    function approve(
        address,
        uint256
    ) external returns (bool);
    function transferFrom(
        address,
        address,
        uint256
    ) external returns (bool);
}

/// @notice Mainnet-fork test fixture for the V4 protocol. Deploys the entire
///         stack (core, vault, bounty hub, burner, return auction module) against
///         the real CryptoPunks market, live PunksData, and live artcoins
///         factory.
abstract contract ForkFixtures is FreshArtcoinsStack {
    // ──────────────── External mainnet addresses ────────────────

    address internal constant PUNKS_MARKET = 0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB;
    address internal constant PUNKS_DATA = 0x9cF9C8eA737A7d5157d3F4282aCe30880a7A117C;
    address internal constant V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    /// @dev Burn admin used for reward slots that must never be redirected
    ///      post-deploy (slots 0 and 1). Mirrors Deploy.s.sol.
    address internal constant BURN_ADMIN = 0x000000000000000000000000000000000000dEaD;
    /// @dev No factory-injected artcoins protocol slot under the hook redesign
    ///      (LAYER burn flows via the hook skim's 20% protocol leg → PCController).
    ///      Mirrors Deploy.s.sol. The legacy V3 stack (factory / hook / locker /
    ///      escrow / linear-fees MEV) is GONE — the fresh tax-aware stack is
    ///      deployed by `FreshArtcoinsStack` and launched in `_launchPool`.
    uint16 internal constant ARTCOINS_PROTOCOL_BPS = 0;

    // Fresh-stack fee config (mirrors Deploy.s.sol). The transfer tax is left
    // DORMANT (`enabled=false`) in these core-logic fixtures — the taxed path is
    // validated by TaxedTokenForkTest / SkimForkFixture against the real deploy.
    uint24 internal constant BASELINE_SKIM_BPS = 6000; // 6%
    uint16 internal constant BOUNTY_BPS = 8333; // ~83.33% bid leg (= 5% of volume)
    uint24 internal constant MAX_REFERRAL_BPS_OF_VOLUME = 250; // 0.25%
    uint24 internal constant LP_FEE_PPM = 5000; // 0.5%
    uint16 internal constant TRANSFER_TAX_BPS = 1500;
    uint16 internal constant TRANSFER_TAX_BPS_MAX = 2000;

    // ──────────────── Protocol parameters ────────────────

    // Match the deploy script defaults.
    uint256 internal constant BURNER_MIN_BLOCKS = 1; // burn every block
    uint256 internal constant BURNER_MAX_STEP_WEI = 1 ether;
    uint256 internal constant ADAPTER_MAX_SWEEP_WEI = 2 ether;
    uint256 internal constant ADAPTER_MIN_BLOCKS = 300; // ~1h cooldown
    // Distinct from Deploy.s.sol's 30 ETH seed so a hard-coded prod value would
    // be caught; the auto-track tests assert against this fixture value.
    uint256 internal constant ADAPTER_ACTIVATION_THRESHOLD = 28 ether;
    uint24 internal constant POOL_BUY_FEE_PPM = 50_000;
    uint24 internal constant POOL_SELL_FEE_PPM = 50_000;
    int24 internal constant TICK_SPACING = 200;
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant STARTING_TICK = -190_400;
    uint256 internal constant TOKEN_TOTAL_SUPPLY = 1_110_000_000 * 1e18;

    // ──────────────── Deployed protocol ────────────────

    IPunksData internal punksData;
    PermanentCollection internal collection;
    PunkVault internal vault;
    Patron internal patron;
    BuybackBurner internal burner;
    ReturnAuctionModule internal finalSale;
    ProtocolAdmin internal adminContract;
    ICryptoPunksMarket internal punksMarket;

    IERC20Lite internal token;
    address internal hook;
    IArtcoinsLocker internal locker;
    address internal creatorRecipient;
    LiveBidAdapter internal liveBidAdapter;
    FeeAutoSwapper internal lockerFeeSwapper;
    VaultBurnPool internal vaultBurnPool;
    /// @dev Production renderer: cache-backed mosaic. This is the
    ///      `_launchPool`-installed registry impl — same wiring
    ///      `Deploy.s.sol` produces on mainnet. Renderer-specific tests
    ///      reach for this directly.
    PermanentCollectionMosaicRenderer internal mosaicRenderer;
    /// @dev The public Punk-tile cache that backs the mosaic renderer.
    ///      Permissionless, no admin, datasetHash-pinned to PunksData.
    PunkSvgFragmentCache internal punkSvgCache;
    TraitIconCache internal traitIconCache;
    /// @dev Proof-NFT renderer (token ids 0..110). Built alongside the
    ///      Mosaic renderer; Mosaic dispatches Proof-range ids to it.
    PermanentCollectionProofRenderer internal proofRenderer;
    PunkVaultTitleAuction internal titleAuction;
    RendererRegistry internal rendererRegistry;

    /// @dev Default fork block when FORK_BLOCK is unset. PINNED (not HEAD) so
    ///      Foundry's RPC cache compounds across runs — the first run warms
    ///      `~/.foundry/cache/rpc/mainnet/<block>/`, every rerun is served from
    ///      that cache and never re-throttles the RPC (this is what eliminates
    ///      the 429 storm on a full-suite run). Same block `MevSimulation`
    ///      pins, so all fork suites share one cache dir. Override with
    ///      `FORK_BLOCK=<n>`.
    uint256 internal constant DEFAULT_FORK_BLOCK = 25_133_816;

    function _setUpFork() internal {
        string memory url = vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        try vm.envUint("FORK_BLOCK") returns (uint256 b) {
            vm.createSelectFork(url, b);
        } catch {
            vm.createSelectFork(url, DEFAULT_FORK_BLOCK);
        }
        punksMarket = ICryptoPunksMarket(PUNKS_MARKET);
        punksData = IPunksData(PUNKS_DATA);
        require(address(PUNKS_DATA).code.length > 0, "fixture: PunksData missing on fork");
    }

    function _setUpForkAt(
        uint256 forkBlock
    ) internal {
        string memory url = vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url, forkBlock);
        punksMarket = ICryptoPunksMarket(PUNKS_MARKET);
        punksData = IPunksData(PUNKS_DATA);
        require(address(PUNKS_DATA).code.length > 0, "fixture: PunksData missing on fork");
    }

    /// @notice Deploys core + bounty hub. Does NOT call the artcoins factory.
    ///         Use `_launchPool()` for the token + LP + locker.
    function _deployProtocol() internal {
        // The fresh artcoins stack (factory, escrow, hook, MEV, controller,
        // locker) is deployed in `_launchPool` via the shared
        // PCLaunchStackDeployer. Pool-less suites never touch it, so it is not
        // deployed here (the LiveBidAdapter no longer references the escrow).
        adminContract = new ProtocolAdmin(address(this));
        collection = new PermanentCollection(PUNKS_DATA, address(adminContract));
        patron = new Patron(PUNKS_MARKET, PUNKS_DATA, address(adminContract), address(0));
        burner = new BuybackBurner(
            V4_POOL_MANAGER,
            DYNAMIC_FEE_FLAG,
            TICK_SPACING,
            BURNER_MIN_BLOCKS,
            BURNER_MAX_STEP_WEI,
            address(adminContract),
            address(0)
        );

        // PunkVault & ReturnAuctionModule have a circular constructor
        // dependency. Precompute the return auction module's CREATE address.
        uint64 n = vm.getNonce(address(this));
        address futureFinalSale = vm.computeCreateAddress(address(this), n + 1);
        vault = new PunkVault(PUNKS_MARKET, futureFinalSale);
        finalSale = new ReturnAuctionModule(
            PUNKS_MARKET,
            address(collection),
            address(vault),
            payable(address(patron)),
            payable(address(burner)),
            address(0)
        );
        require(address(finalSale) == futureFinalSale, "fixture: finalSale addr mismatch");

        // LiveBidAdapter — the single inflow governor. Built here (before
        // patron.setWiring) so it can be wired in as the sole faucet into the
        // live bid, mirroring Deploy.s.sol's ordering under inflow
        // consolidation. It needs patron + admin + finalSale
        // (poolReplenish module gate) + the records core (auto-track parity
        // with Deploy.s.sol: the threshold tracks 75% of the latest acceptBid
        // clearing price).
        liveBidAdapter = new LiveBidAdapter(
            payable(address(patron)),
            address(adminContract),
            ADAPTER_MAX_SWEEP_WEI,
            ADAPTER_MIN_BLOCKS,
            ADAPTER_ACTIVATION_THRESHOLD,
            address(collection), // records core — auto-track parity with Deploy.s.sol (×0.75)
            address(finalSale), // module ref — gates poolReplenish module-only
            address(0)
        );

        collection.setWiring(address(patron), address(finalSale), address(vault), payable(address(burner)));
        patron.setWiring(address(collection), address(finalSale), address(liveBidAdapter));
        finalSale.setLiveBidAdapter(payable(address(liveBidAdapter)));

        // Vault-burn path: pool. Pool depends on finalSale's address, so it
        // deploys after; we then wire it back into finalSale.
        vaultBurnPool = new VaultBurnPool(address(finalSale), payable(address(burner)), address(0));
        finalSale.setVaultBurnPool(payable(address(vaultBurnPool)));

        // Title auction + one-shot vault wiring. Auction is permissionless
        // and binds the vault, collection, and a payout recipient (the test
        // contract receives 100% of any cleared title-sale proceeds).
        titleAuction =
            new PunkVaultTitleAuction(address(collection), address(vault), payable(address(this)), address(0));
        vault.setTitleAuction(address(titleAuction));
    }

    /// @notice Deploy the full fresh artcoins stack (factory, escrow, hook, MEV,
    ///         controller, locker) via the shared PCLaunchStackDeployer, then
    ///         launch the token + pool + locker via the fresh tax-aware factory
    ///         (transfer tax left DORMANT for these core-logic suites), deploy
    ///         the renderer triplet, and finish BuybackBurner setup. The fixture
    ///         OWNS the fresh factory, so hook / MEV / locker are allowlisted
    ///         directly.
    function _launchPool() internal {
        require(address(adminContract) != address(0), "fixture: call _deployProtocol first");

        // Deploy the full fresh artcoins stack via the shared deployer — the
        // same code the production owner-ops script runs.
        _deployFreshArtcoinsStack();

        // Production renderer triplet: cache + mosaic renderer + registry.
        punkSvgCache = new PunkSvgFragmentCache(PUNKS_DATA);
        traitIconCache = new TraitIconCache(PUNKS_DATA);
        proofRenderer = new PermanentCollectionProofRenderer(
            address(vault), PUNKS_DATA, address(traitIconCache), address(punkSvgCache)
        );
        mosaicRenderer = new PermanentCollectionMosaicRenderer(
            address(collection),
            address(vault),
            address(punkSvgCache),
            PUNKS_DATA,
            address(traitIconCache),
            address(proofRenderer)
        );
        rendererRegistry = new RendererRegistry(address(adminContract), address(mosaicRenderer));
        vault.setRendererRegistry(address(rendererRegistry));

        IArtcoinsFactory factory = IArtcoinsFactory(address(taxFactory));
        uint256 fee = factory.deployFee();
        vm.deal(address(this), address(this).balance + fee);
        // Downstream LP-fee converter (mirrors Deploy.s.sol): the lean locker's
        // sole reward recipient. Converts artcoin-side LP fees → ETH and sends
        // them to the adapter's buffer (depositToLocker = false). The FAS guards
        // conversions with `maxSlippageBps` (= 500) as its SOLE sandwich guard —
        // a fixed per-call price-impact cap (the EMA `referenceDeviationBps` gate
        // was removed); the launcher's FAS suite covers conversion behavior.
        lockerFeeSwapper = new FeeAutoSwapper(
            FeeAutoSwapper.Config({
                poolManager: V4_POOL_MANAGER,
                feeLocker: address(feeEscrow),
                pairedToken: address(0),
                poolFee: DYNAMIC_FEE_FLAG,
                poolTickSpacing: TICK_SPACING,
                hook: address(skimHook),
                endRecipient: payable(address(liveBidAdapter)),
                depositToLocker: false,
                maxSlippageBps: 500,
                minBlocksBetweenConverts: 1,
                maxStepIn: 1_000_000e18
            })
        );
        IArtcoinsFactory.DeploymentConfig memory cfg = _buildFactoryConfig(
            address(adminContract),
            payable(address(liveBidAdapter)),
            payable(address(lockerFeeSwapper)),
            address(rendererRegistry)
        );
        TaxConfig memory taxConfig = _buildDormantTaxConfig();
        address tokenAddr = factory.deployTokenWithProtocolBpsAndTax{value: fee}(cfg, ARTCOINS_PROTOCOL_BPS, taxConfig);
        creatorRecipient = address(this);

        IArtcoinsFactory.TokenDeploymentInfo memory info = factory.tokenDeploymentInfo(tokenAddr);
        token = IERC20Lite(tokenAddr);
        hook = info.hook; // == address(skimHook)
        locker = IArtcoinsLocker(info.locker); // == address(conversionLocker)

        burner.setup(tokenAddr, info.hook);
        lockerFeeSwapper.setup(tokenAddr);
    }

    /// @dev Fresh-stack factory config (mirrors `Deploy.s.sol`'s production
    ///      path): skim hook, single 10_000-bps reward slot → LiveBidAdapter,
    ///      14-position locker geometry, skim-MEV decay (90%→6% over 30 min).
    function _buildFactoryConfig(
        address admin,
        address payable bountyAdapter_,
        address payable lockerFeeRecipient_,
        address rendererAddr
    ) internal view returns (IArtcoinsFactory.DeploymentConfig memory cfg) {
        cfg.tokenConfig = IArtcoinsFactory.TokenConfig({
            tokenAdmin: admin,
            name: "permanent collection",
            symbol: "111",
            salt: keccak256("permanent collection 111PUNKS v2"),
            image: "",
            metadata: "",
            context: "",
            totalSupply: TOKEN_TOTAL_SUPPLY,
            renderer: rendererAddr
        });

        // Three-leg skim split (baseline 5%, 80% bid leg). The fixture has no
        // ProtocolFeePhaseAdapter / ReferralPayout wired, so the protocol +
        // referral legs route to the adapter too — harmless (referral is gated
        // off pre-first-acquisition; protocol leg just joins the bid).
        IArtCoinsHookSkimFee.SkimHookFeeData memory skimCfg = IArtCoinsHookSkimFee.SkimHookFeeData({
            baselineSkimBps: BASELINE_SKIM_BPS,
            bountyBps: BOUNTY_BPS,
            maxReferralBpsOfVolume: MAX_REFERRAL_BPS_OF_VOLUME,
            lpFee: LP_FEE_PPM,
            bountyRecipient: bountyAdapter_,
            protocolRecipient: bountyAdapter_,
            referralPayout: bountyAdapter_,
            quoteToken: address(0)
        });

        cfg.poolConfig = IArtcoinsFactory.PoolConfig({
            hook: address(skimHook),
            pairedToken: address(0), // native-ETH-paired
            tickIfToken0IsArtCoins: STARTING_TICK,
            tickSpacing: TICK_SPACING,
            poolData: abi.encode(address(0), bytes(""), abi.encode(skimCfg))
        });

        // Single PC reward slot: 10_000 bps → FeeAutoSwapper (converts the
        // artcoin-side LP fees to ETH, forwards to LiveBidAdapter), admin = 0xdEaD.
        address[] memory rewardAdmins = new address[](1);
        rewardAdmins[0] = BURN_ADMIN;
        address[] memory rewardRecipients = new address[](1);
        rewardRecipients[0] = lockerFeeRecipient_;
        uint16[] memory rewardBps = new uint16[](1);
        rewardBps[0] = 10_000;

        // 14-position locker geometry (offsets from the starting tick).
        int24[14] memory lo =
            [int24(0), 1400, 3400, 6000, 9400, 14_000, 19_400, 26_000, 33_000, 40_000, 47_000, 53_400, 60_000, 72_000];
        int24[14] memory up = [
            int24(1400),
            3400,
            6000,
            9400,
            14_000,
            19_400,
            26_000,
            33_000,
            40_000,
            47_000,
            53_400,
            60_000,
            72_000,
            83_000
        ];
        uint16[14] memory w = [uint16(375), 150, 300, 500, 800, 700, 1500, 1700, 1150, 850, 600, 275, 700, 400];
        int24[] memory tickLowerArr = new int24[](14);
        int24[] memory tickUpperArr = new int24[](14);
        uint16[] memory positionBps = new uint16[](14);
        for (uint256 i = 0; i < 14; i++) {
            tickLowerArr[i] = STARTING_TICK + lo[i];
            tickUpperArr[i] = STARTING_TICK + up[i];
            positionBps[i] = w[i];
        }

        // Lean locker: no in-locker conversion, ignores lockerData.
        cfg.lockerConfig = IArtcoinsFactory.LockerConfig({
            locker: address(conversionLocker),
            rewardAdmins: rewardAdmins,
            rewardRecipients: rewardRecipients,
            rewardBps: rewardBps,
            tickLower: tickLowerArr,
            tickUpper: tickUpperArr,
            positionBps: positionBps,
            lockerData: bytes("")
        });
        // Skim-MEV decay: 90% → 6% over 30 min at ~2.8%/min (mirrors Deploy.s.sol).
        cfg.mevModuleConfig = IArtcoinsFactory.MevModuleConfig({
            mevModule: address(mevSkimModule), mevModuleData: abi.encode(uint24(90_000), uint24(6000), uint32(1800))
        });
        cfg.sniperFeeConfig = IArtcoinsFactory.SniperFeeConfig({recipient: address(0), lockRecipient: false});
        cfg.extensionConfigs = new IArtcoinsFactory.ExtensionConfig[](0);
    }

    /// @dev Venue-scoped transfer tax left DORMANT (`enabled=false`) for these
    ///      core-logic suites — the taxed path is validated against the real
    ///      deploy by TaxedTokenForkTest / SkimForkFixture. Still the FRESH
    ///      tax-capable token (deployed via the tax entry point), just not taxing.
    function _buildDormantTaxConfig() internal view returns (TaxConfig memory tax) {
        tax.enabled = false;
        tax.taxBps = 0;
        tax.taxBpsMax = TRANSFER_TAX_BPS_MAX;
        tax.burnAddress = BURN_ADMIN;
        tax.poolManager = V4_POOL_MANAGER;
        tax.canonicalHook = address(skimHook);
        tax.pairedToken = address(0);
        tax.canonicalPoolFee = DYNAMIC_FEE_FLAG;
        tax.canonicalTickSpacing = TICK_SPACING;
        tax.exempt = new address[](0);
        tax.venues = new TaxVenue[](0);
    }

    function _sweepFeesToBounty() internal returns (uint256 ethToBounty) {
        locker.collectRewards(address(token));
        ethToBounty = liveBidAdapter.sweep();
    }

    function _fundPatronFromAdapter(
        uint256 amount
    ) internal {
        vm.deal(address(liveBidAdapter), address(liveBidAdapter).balance + amount);
        vm.prank(address(liveBidAdapter));
        (bool ok,) = address(patron).call{value: amount}("");
        require(ok, "fixture: adapter funding failed");
    }

    function v4PoolManager() internal pure returns (IPoolManager) {
        return IPoolManager(V4_POOL_MANAGER);
    }

    /// @notice Transfer a Punk from its current owner to `user`, then have
    ///         `user` list the Punk EXCLUSIVELY to Patron at ~the current live
    ///         bid (so any caller can finalize `acceptBid`). Returns the price.
    function _giveAndOfferToBounty(
        address user,
        uint16 punkId
    ) internal returns (uint256 listed) {
        address owner_ = punksMarket.punkIndexToAddress(uint256(punkId));
        require(owner_ != address(0), "fixture: punk unowned");
        if (owner_ != user) {
            vm.prank(owner_);
            punksMarket.transferPunk(user, uint256(punkId));
        }
        // List EXCLUSIVELY to Patron at the current live bid (the price
        // acceptBid pays). Returns the listed price.
        listed = patron.bidBalance();
        vm.prank(user);
        punksMarket.offerPunkForSaleToAddress(uint256(punkId), listed, address(patron));
    }

    /// @notice Add `seller` to Patron's allowlist AND warp past the
    ///         24-hour activation delay introduced for M-3. Tests that need
    ///         to call `acceptListing` from a freshly-allowlisted seller
    ///         should use this instead of calling `addAllowedSeller`
    ///         directly. Sets caller to `address(this)` (the test fixture
    ///         is the protocol admin by default), so callers should not
    ///         pre-prank.
    function _addAllowedSellerImmediate(
        address seller
    ) internal {
        patron.addAllowedSeller(seller);
        vm.warp(block.timestamp + patron.ALLOWLIST_DELAY() + 1);
    }

    /// @notice Transfer + publicly list a Punk for sale by `seller`. Used to
    ///         create allowlist-eligible listings for `acceptListing` tests.
    function _giveAndPublicList(
        address seller,
        uint16 punkId,
        uint256 priceWei
    ) internal {
        address owner_ = punksMarket.punkIndexToAddress(uint256(punkId));
        require(owner_ != address(0), "fixture: punk unowned");
        if (owner_ != seller) {
            vm.prank(owner_);
            punksMarket.transferPunk(seller, uint256(punkId));
        }
        vm.prank(seller);
        punksMarket.offerPunkForSale(uint256(punkId), priceWei);
    }

    /// @notice Pick the target trait id for `punkId` — the protocol-derived
    ///         canonical target (rarest uncollected, non-pending trait the Punk
    ///         carries). `recordAcquisition` enforces this exact value, so tests
    ///         must target it. Reverts `NoEligibleTarget` if the Punk has no
    ///         eligible trait. (Pre-#1 this returned the lowest uncollected bit;
    ///         it now mirrors `canonicalTargetOf`.)
    function _pickTarget(
        uint16 punkId
    ) internal view returns (uint8) {
        return collection.canonicalTargetOf(punkId);
    }

    function _coverageWithGaps(
        uint16[] memory excludePunks,
        uint256 bitCount
    ) internal view returns (uint256 covered) {
        require(bitCount <= 111, "fixture: bitCount > 111");
        uint256 forbidden;
        for (uint256 i = 0; i < excludePunks.length; i++) {
            forbidden |= punksData.traitMaskOf(excludePunks[i]);
        }
        uint256 added;
        for (uint8 i = 0; i < 111 && added < bitCount; i++) {
            if ((forbidden >> i) & 1 == 0) {
                covered |= uint256(1) << i;
                added++;
            }
        }
        require(added == bitCount, "fixture: not enough open bits");
    }

    /// @notice Forcefully writes `mask` into PermanentCollection.collectedMask.
    ///         Probes storage by writing a sentinel; resilient to layout
    ///         shifts but verifies before returning.
    function _setCollectedMask(
        uint256 mask
    ) internal {
        uint256 slot = _findCollectedMaskSlot();
        vm.store(address(collection), bytes32(slot), bytes32(mask));
        require(collection.collectedMask() == mask, "fixture: collectedMask slot wrong");
    }

    function _findCollectedMaskSlot() internal returns (uint256) {
        uint256 sentinel = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        for (uint256 i = 0; i < 32; i++) {
            bytes32 original = vm.load(address(collection), bytes32(i));
            vm.store(address(collection), bytes32(i), bytes32(sentinel));
            if (collection.collectedMask() == sentinel) {
                vm.store(address(collection), bytes32(i), original);
                return i;
            }
            vm.store(address(collection), bytes32(i), original);
        }
        revert("fixture: collectedMask slot not found");
    }

    /// @notice Forcefully writes `(punkId, exists=true)` into
    ///         `PermanentCollection._firstVaulted[traitId]`. Used by the
    ///         renderer gas tests that need a full set without paying for
    ///         111 real settlements.
    ///
    /// @dev    The probe iterates candidate base slots (0..32) and looks
    ///         for the one whose `mapping(uint8 => First)` derivation
    ///         makes `firstVaultedPunk(traitId)` return the sentinel.
    ///         Cached after first call to keep the full-set helper cheap.
    function _setFirstVaultedPunk(
        uint8 traitId,
        uint16 punkId
    ) internal {
        uint256 base = _findFirstVaultedSlot();
        bytes32 key = keccak256(abi.encode(uint256(traitId), base));
        // struct First { uint16 punkId; bool exists; } packs into one slot
        // as little-endian: bytes 0..1 = punkId, byte 2 = exists.
        uint256 packed = (uint256(1) << 16) | uint256(punkId);
        vm.store(address(collection), key, bytes32(packed));
        (uint16 readPunk, bool exists) = collection.firstVaultedPunk(traitId);
        require(readPunk == punkId && exists, "fixture: _firstVaulted slot wrong");
    }

    uint256 private _firstVaultedSlotCache;
    bool private _firstVaultedSlotFound;

    function _findFirstVaultedSlot() internal returns (uint256) {
        if (_firstVaultedSlotFound) return _firstVaultedSlotCache;
        uint8 probeTrait = 110; // unused-by-default trait
        uint16 sentinelPunk = 0x1234;
        uint256 packed = (uint256(1) << 16) | uint256(sentinelPunk);
        for (uint256 i = 0; i < 32; i++) {
            bytes32 key = keccak256(abi.encode(uint256(probeTrait), i));
            bytes32 original = vm.load(address(collection), key);
            vm.store(address(collection), key, bytes32(packed));
            (uint16 readPunk, bool exists) = collection.firstVaultedPunk(probeTrait);
            vm.store(address(collection), key, original);
            if (readPunk == sentinelPunk && exists) {
                _firstVaultedSlotCache = i;
                _firstVaultedSlotFound = true;
                return i;
            }
        }
        revert("fixture: _firstVaulted slot not found");
    }

    receive() external payable {}
}
