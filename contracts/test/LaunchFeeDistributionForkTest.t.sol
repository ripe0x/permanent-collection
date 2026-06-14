// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";

import {SkimForkFixture} from "./helpers/SkimForkFixture.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PCSwapData, PCAttribution} from "artcoins/hooks/interfaces/IArtCoinsHookSkimFee.sol";
import {IArtCoinsHook} from "artcoins/interfaces/IArtCoinsHook.sol";

interface IERC20Min {
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice TestSwapHelper variant that passes an attributed `hookData` payload
///         to PoolManager.swap, so a swap can carry a referrer.
contract AttributedSwapHelper is IUnlockCallback {
    IPoolManager public immutable pm;
    address public immutable token;
    address public immutable hook;
    uint24 public immutable poolFee;
    int24 public immutable poolTickSpacing;

    constructor(address _pm, address _token, address _hook, uint24 _fee, int24 _ts) {
        pm = IPoolManager(_pm);
        token = _token;
        hook = _hook;
        poolFee = _fee;
        poolTickSpacing = _ts;
    }

    receive() external payable {}

    function buyWith(uint256 ethIn, bytes calldata hookData) external payable returns (uint256 tokenOut) {
        require(msg.value == ethIn, "ASH: bad value");
        bytes memory data = abi.encode(uint8(0), ethIn, hookData);
        tokenOut = abi.decode(pm.unlock(data), (uint256));
        require(IERC20Min(token).transfer(msg.sender, tokenOut), "ASH: token xfer");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "ASH: not pm");
        (uint8 dir, uint256 amount, bytes memory hookData) = abi.decode(data, (uint8, uint256, bytes));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: poolFee,
            tickSpacing: poolTickSpacing,
            hooks: IHooks(hook)
        });
        if (dir == 0) {
            SwapParams memory params = SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            });
            BalanceDelta delta = pm.swap(key, params, hookData);
            uint256 ethSpent = uint256(-int256(delta.amount0()));
            uint256 tokenReceived = uint256(int256(delta.amount1()));
            pm.settle{value: ethSpent}();
            pm.take(Currency.wrap(token), address(this), tokenReceived);
            return abi.encode(tokenReceived);
        }
        revert("ASH: unsupported dir");
    }
}

/// @notice Fee-distribution rehearsal against the live `Deploy.s.sol` bytecode on
///         a mainnet fork. The referral leg is UNGATED (live from the first swap).
///         Run with `-vv` to print the outcomes report:
///
///           MAINNET_RPC_URL=https://gateway.tenderly.co/public/mainnet \
///             forge test --match-contract LaunchFeeDistributionForkTest -vv
///
///         Tests:
///           - swap WITHOUT referral: protocol leg -> PCController -> 86.67% treasury / 13.33% LAYER burn
///           - swap WITH referral:    referrer gets 0.25% of volume; protocol leg shrinks by that slice
///           - acquisition lifecycle: acceptBid -> cleared auction -> silenced (vault) auction
///           - auction referral:      the high-bid referrer gets 5% of the rescue premium
///
///         Treasury + BurnRouter are `MockEthSink`s in the fixture (`pcTreasury` /
///         `pcBurnRouter`); on mainnet they are the deploy's treasury + LAYER BurnRouter.
contract LaunchFeeDistributionForkTest is SkimForkFixture {
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant TICK_SPACING = 200;
    uint24 internal constant REFERRAL_BPS = 250; // 0.25% of volume (the launch cap)

    TestSwapHelper internal swapper;
    AttributedSwapHelper internal attributedSwapper;
    address internal trader;

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet")));
        _runFullDeploy();
        swapper = new TestSwapHelper(POOL_MANAGER, token, deployedHook, DYNAMIC_FEE_FLAG, TICK_SPACING);
        attributedSwapper = new AttributedSwapHelper(POOL_MANAGER, token, deployedHook, DYNAMIC_FEE_FLAG, TICK_SPACING);
        trader = makeAddr("fee-dist-trader");
        vm.deal(trader, 1000 ether);
        // Past the ~30 min MEV window so the skim sits at the 6% baseline.
        vm.warp(block.timestamp + 90 minutes);
    }

    function _buy(uint256 ethIn) internal {
        vm.prank(trader);
        swapper.buyTokenWithEth{value: ethIn}(ethIn);
    }

    function _buyWithReferrer(uint256 ethIn, address referrer) internal {
        PCAttribution memory att = PCAttribution({
            sourceId: bytes32("rehearsal"),
            referrer: referrer,
            campaignId: bytes16(0),
            referralBps: REFERRAL_BPS
        });
        bytes memory inner = abi.encode(PCSwapData({attribution: att, extensionPayload: ""}));
        IArtCoinsHook.PoolSwapData memory psd =
            IArtCoinsHook.PoolSwapData({mevModuleSwapData: bytes(""), poolExtensionSwapData: inner});
        bytes memory hookData = abi.encode(psd);
        vm.prank(trader);
        attributedSwapper.buyWith{value: ethIn}(ethIn, hookData);
    }

    function _splitProtocolLeg() internal returns (uint256 controllerBal, uint256 toTreasury, uint256 toBurnRouter) {
        protocolFeePhaseAdapter.sweep();
        controllerBal = address(pcController).balance;
        uint256 treBefore = address(pcTreasury).balance;
        uint256 burnBefore = address(pcBurnRouter).balance;
        pcController.processNativeFees();
        toTreasury = address(pcTreasury).balance - treBefore;
        toBurnRouter = address(pcBurnRouter).balance - burnBefore;
    }

    // ─── swap WITHOUT referral: full protocol leg → treasury + LAYER burn ───

    function test_rehearsal_swapFees_WITHOUT_referral() public {
        uint256 bidAdapterBefore = address(liveBidAdapter).balance;
        uint256 patronBidBefore = patron.bidBalance();

        for (uint256 i = 0; i < 8; i++) {
            _buy(1 ether);
        }

        // Bid leg = the ~5%-of-volume bounty slice the hook forwards to LiveBidAdapter
        // each swap (part may already have metered into Patron via streamForward).
        uint256 bidLeg =
            (address(liveBidAdapter).balance - bidAdapterBefore) + (patron.bidBalance() - patronBidBefore);
        assertApproxEqAbs(bidLeg, 0.4 ether, 0.002 ether, "bid leg ~5% of 8 ETH volume -> live bid");

        (uint256 controllerBal, uint256 toTreasury, uint256 toBurnRouter) = _splitProtocolLeg();
        assertGt(controllerBal, 0, "protocol leg reached the PCController");
        uint256 expectedTreasury = controllerBal * pcController.treasuryBps() / 10_000;
        assertEq(toTreasury, expectedTreasury, "treasury 86.67% of the FULL protocol leg");
        assertEq(toBurnRouter, controllerBal - expectedTreasury, "LAYER BurnRouter 13.33% of the FULL protocol leg");

        console2.log("");
        console2.log("==== SWAP FEES (8 ETH) -- NO REFERRAL ====");
        console2.log("  bid leg -> LiveBidAdapter/Patron (wei)", bidLeg);
        console2.log("  protocol leg -> controller (wei)", controllerBal);
        console2.log("    -> treasury 86.67% (wei)       ", toTreasury);
        console2.log("    -> LAYER BurnRouter 13.33% (wei)", toBurnRouter);
        console2.log("  referrer paid (wei)              ", uint256(0));
    }

    // ─── swap WITH referral: referrer gets 0.25%, protocol leg shrinks ───

    function test_rehearsal_swapFees_WITH_referral() public {
        address referrer = makeAddr("rehearsal-referrer");
        uint256 refBefore = referralPayout.balances(referrer);
        uint256 bidAdapterBefore = address(liveBidAdapter).balance;
        uint256 patronBidBefore = patron.bidBalance();

        for (uint256 i = 0; i < 8; i++) {
            _buyWithReferrer(1 ether, referrer);
        }

        // Referrer accrues exactly 0.25% of the 8 ETH volume = 0.02 ETH (ungated,
        // from the first swap). Credited in ReferralPayout for the referrer to claim.
        uint256 referrerGot = referralPayout.balances(referrer) - refBefore;
        assertEq(referrerGot, uint256(8 ether) * REFERRAL_BPS / 100_000, "referrer accrued 0.25% of volume");
        assertEq(referrerGot, 0.02 ether, "referrer accrued 0.02 ETH");

        // The bid leg is UNCHANGED vs the no-referral run: the referral slice is
        // carved from the PROTOCOL leg, never the bid leg.
        uint256 bidLeg =
            (address(liveBidAdapter).balance - bidAdapterBefore) + (patron.bidBalance() - patronBidBefore);
        assertApproxEqAbs(bidLeg, 0.4 ether, 0.002 ether, "bid leg unchanged by referral (~5% of volume)");

        // The protocol leg is reduced by exactly the referral slice.
        (uint256 controllerBal, uint256 toTreasury, uint256 toBurnRouter) = _splitProtocolLeg();
        assertGt(controllerBal, 0, "reduced protocol leg reached the PCController");
        uint256 expectedTreasury = controllerBal * pcController.treasuryBps() / 10_000;
        assertEq(toTreasury, expectedTreasury, "treasury 86.67% of the REDUCED protocol leg");
        assertEq(toBurnRouter, controllerBal - expectedTreasury, "LAYER BurnRouter 13.33% of the REDUCED protocol leg");

        console2.log("");
        console2.log("==== SWAP FEES (8 ETH) -- WITH REFERRAL ====");
        console2.log("  bid leg -> LiveBidAdapter/Patron (wei)", bidLeg);
        console2.log("  referrer paid 0.25% (wei)        ", referrerGot);
        console2.log("  protocol leg -> controller (wei) ", controllerBal);
        console2.log("    -> treasury 86.67% (wei)       ", toTreasury);
        console2.log("    -> LAYER BurnRouter 13.33% (wei)", toBurnRouter);
    }

    // ─── acquisition lifecycle: acceptBid → cleared → silenced (vault) ───

    function test_rehearsal_lifecycle_acceptBid_clearedAuction_vaultedAuction() public {
        _fundPatronFromAdapter(1 ether);
        address sellerA = makeAddr("lifecycle-seller-A");
        uint16 punkA = 0;
        uint256 listedA = _giveAndOfferToBounty(sellerA, punkA);
        uint8 targetA = _pickTarget(punkA);

        // Permissionless finalize; the 3rd arg is the overpay cap (here == the listing).
        patron.acceptBid(punkA, targetA, listedA);

        // The giver-up is paid the listed price by the MARKET (pendingWithdrawals),
        // not pushed by Patron; they collect it with withdraw().
        assertEq(
            punksMarket.pendingWithdrawals(sellerA), listedA, "listed price credited to the giver-up in the market"
        );
        assertEq(address(patron).balance, 0, "live bid paid out by acceptBid");
        assertEq(pc.acquisitionCount(), 1, "acquisition recorded");
        assertEq(punksMarket.punkIndexToAddress(uint256(punkA)), address(finalSale), "Punk in return-auction custody");

        vm.prank(sellerA);
        punksMarket.withdraw();
        assertEq(sellerA.balance, listedA, "giver-up collected the listed price via the market");

        console2.log("");
        console2.log("==== ACCEPT BID ====");
        console2.log("  listed price = live bid (wei)    ", listedA);
        console2.log("  paid to giver-up via market (wei)", sellerA.balance);

        // CLEARED (rescue) auction.
        address bidder = makeAddr("lifecycle-bidder");
        vm.deal(bidder, 3 ether);
        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: 1.5 ether}(punkA, address(0), bytes32(0));

        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 burnerBefore = address(burner).balance;
        uint256 vbpBefore = address(vaultBurnPool).balance;

        vm.warp(uint256(finalSale.getSale(punkA).endsAt) + 1);
        finalSale.settle(punkA);

        uint256 clearedToAdapter = address(liveBidAdapter).balance - adapterBefore;
        uint256 clearedToBurner = address(burner).balance - burnerBefore;
        uint256 clearedToVaultPool = address(vaultBurnPool).balance - vbpBefore;
        assertEq(punksMarket.punkIndexToAddress(uint256(punkA)), bidder, "Punk rescued to the winning bidder");
        assertEq(clearedToAdapter, 0.65 ether, "65% of cost buffered to refill the bid");
        assertEq(clearedToBurner, 0.25 ether, "25% of cost to BuybackBurner");
        assertEq(clearedToVaultPool, 0.6 ether, "(premium) + 10% of cost to VaultBurnPool");
        assertEq((pc.collectedMask() >> targetA) & 1, 0, "cleared rescue does NOT collect the trait");

        console2.log("==== CLEARED (rescue) AUCTION (cost 1 / bid 1.5) ====");
        console2.log("  -> LiveBidAdapter 65% (wei)      ", clearedToAdapter);
        console2.log("  -> BuybackBurner 25% (wei)       ", clearedToBurner);
        console2.log("  -> VaultBurnPool prem+10% (wei)  ", clearedToVaultPool);

        // SILENCED (vault) auction.
        _fundPatronFromAdapter(1 ether);
        address sellerB = makeAddr("lifecycle-seller-B");
        uint16 punkB = 1;
        uint256 listedB = _giveAndOfferToBounty(sellerB, punkB);
        uint8 targetB = _pickTarget(punkB);

        patron.acceptBid(punkB, targetB, listedB);

        uint256 vbpBeforeVault = address(vaultBurnPool).balance;
        uint256 burnerBeforeVault = address(burner).balance;

        vm.warp(uint256(finalSale.getSale(punkB).endsAt) + 1);
        finalSale.settle(punkB);

        uint256 vaultSweepToBurner = address(burner).balance - burnerBeforeVault;
        assertEq(punksMarket.punkIndexToAddress(uint256(punkB)), pc.punkVault(), "Punk vaulted permanently");
        assertEq((pc.collectedMask() >> targetB) & 1, 1, "ONLY the target trait collected on vaulting");
        assertEq(vault.ownerOf(uint256(targetB)), sellerB, "Proof minted to the giver-up");
        assertEq(vaultSweepToBurner, vbpBeforeVault, "VaultBurnPool swept to BuybackBurner");
        assertEq(address(vaultBurnPool).balance, 0, "VaultBurnPool drained by the vault-path sweep");

        console2.log("==== SILENCED (vault) AUCTION -> PERMANENT COLLECTION ====");
        console2.log("  target trait collected (bit)    ", uint256(targetB));
        console2.log("  Proof tokenId minted            ", uint256(targetB));
        console2.log("  VaultBurnPool -> BuybackBurner   ", vaultSweepToBurner);
    }

    // ─── auction referral: high-bid referrer gets 5% of the rescue premium ───

    function test_rehearsal_auctionReferral_distributesToReferrer() public {
        _fundPatronFromAdapter(1 ether);
        address seller = makeAddr("auc-ref-seller");
        uint16 punkId = 0;
        uint256 listed = _giveAndOfferToBounty(seller, punkId);
        uint8 target = _pickTarget(punkId);
        patron.acceptBid(punkId, target, listed);

        address referrer = makeAddr("auc-ref-referrer");
        address bidder = makeAddr("auc-ref-bidder");
        vm.deal(bidder, 2 ether);
        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: 1.5 ether}(punkId, referrer, bytes32("rehearsal"));
        assertEq(finalSale.referrerOfHighBid(punkId), referrer, "referrer recorded on the high bid");

        uint256 referrerBefore = referrer.balance;
        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 burnerBefore = address(burner).balance;
        uint256 vbpBefore = address(vaultBurnPool).balance;

        vm.warp(uint256(finalSale.getSale(punkId).endsAt) + 1);
        finalSale.settle(punkId);

        // cost 1 / high bid 1.5 -> premium 0.5. referrer = 5% of premium = 0.025.
        uint256 toReferrer = referrer.balance - referrerBefore;
        uint256 toAdapter = address(liveBidAdapter).balance - adapterBefore;
        uint256 toBurner = address(burner).balance - burnerBefore;
        uint256 toVaultPool = address(vaultBurnPool).balance - vbpBefore;
        assertEq(toReferrer, 0.025 ether, "referrer got 5% of the 0.5 premium");
        assertEq(toVaultPool, 0.575 ether, "vaultPool got 95% premium + 10% of cost");
        assertEq(toBurner, 0.25 ether, "burner got 25% of cost (referrer did NOT carve burn)");
        assertEq(toAdapter, 0.65 ether, "adapter buffered 65% of cost (referrer did NOT carve bounty)");

        console2.log("");
        console2.log("==== AUCTION REFERRAL (cost 1 / bid 1.5 / premium 0.5) ====");
        console2.log("  -> referrer 5% of premium (wei)  ", toReferrer);
        console2.log("  -> VaultBurnPool 95%+10% (wei)   ", toVaultPool);
        console2.log("  -> BuybackBurner 25% cost (wei)  ", toBurner);
        console2.log("  -> LiveBidAdapter 65% cost (wei) ", toAdapter);
    }

    // ─── LP fee path: 0.5% LP fee → locker → FeeAutoSwapper → LiveBidAdapter ──

    /// @notice Traces the LP fee through the full chain. At launch the locker
    ///         dominates depth, so it captures ~100% of the LP fee on every
    ///         swap. V4 takes the LP fee from the INPUT side per swap, so the
    ///         test drives both buys (ETH-side fee) and one sell (artcoin-side
    ///         fee). `collectRewards` pulls accrued V4 position fees into the
    ///         FeeEscrow under FeeAutoSwapper's slot; `flushPaired` forwards
    ///         the native-ETH side directly to LiveBidAdapter; `convert` swaps
    ///         the artcoin side to ETH and forwards the proceeds.
    function test_rehearsal_lpFeePath_routesToLiveBidAdapter() public {
        address feeAutoSwapper = vm.parseJsonAddress(
            vm.readFile(string.concat(vm.projectRoot(), "/deployments.json")),
            ".feeAutoSwapper"
        );

        // 1) Drive volume on BOTH sides. Buys accrue ETH-side LP fees; one
        //    sell accrues artcoin-side LP fees so the FAS convert path has
        //    something to convert.
        for (uint256 i = 0; i < 8; i++) {
            _buy(1 ether);
        }
        uint256 traderBal = IERC20Min(token).balanceOf(trader);
        uint256 sellAmount = traderBal / 4;
        vm.prank(trader);
        IERC20Min(token).approve(address(swapper), sellAmount);
        vm.prank(trader);
        swapper.sellTokenForEth(sellAmount);

        // Track BOTH the adapter buffer and the Patron bid balance — the
        // adapter's `streamForward()` can drain to Patron during the swap that
        // `convert()` performs (the hook calls it in `_beforeSwap`), so the
        // raw adapter delta alone may go negative even while net new ETH was
        // delivered. The full LP-fee inflow = adapter delta + Patron delta.
        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 patronBefore = patron.bidBalance();

        // 2) collectRewards pulls accrued fees from V4 positions and deposits
        //    them to FeeAutoSwapper's slot at the escrow — native ETH via
        //    storeFeesNative, artcoin via storeFees.
        IArtCoinsLocker(deployedLocker).collectRewards(token);

        uint256 nativeInEscrow = feeEscrow.availableFees(feeAutoSwapper, address(0));
        uint256 artcoinInEscrow = feeEscrow.availableFees(feeAutoSwapper, token);

        // 3) flushPaired drains the native side (no swap needed) → adapter.
        //    Pranked from an EOA so the keeper-reward push to msg.sender lands
        //    on something that can `receive()`; the test contract is not payable.
        address keeper = makeAddr("lp-keeper");
        vm.prank(keeper);
        IFeeAutoSwapper(feeAutoSwapper).flushPaired();
        uint256 afterFlush_adapter = address(liveBidAdapter).balance;
        uint256 afterFlush_patron = patron.bidBalance();
        uint256 fromNativeSide =
            (afterFlush_adapter + afterFlush_patron) - (adapterBefore + patronBefore);

        // 4) Roll forward past FeeAutoSwapper's `minBlocksBetweenConverts`
        //    pacing, then convert the artcoin side. The swap eats price impact
        //    against the same pool — output ETH varies with depth, so the
        //    trace records the actual delivered amount rather than asserting
        //    a fixed value.
        vm.roll(block.number + 200);
        vm.prank(keeper);
        IFeeAutoSwapper(feeAutoSwapper).convert(0);
        uint256 afterConvert_adapter = address(liveBidAdapter).balance;
        uint256 afterConvert_patron = patron.bidBalance();
        uint256 fromArtcoinSide = (afterConvert_adapter + afterConvert_patron)
            - (afterFlush_adapter + afterFlush_patron);

        uint256 totalToLiveBid = (afterConvert_adapter + afterConvert_patron)
            - (adapterBefore + patronBefore);
        assertGt(fromNativeSide, 0, "native LP fee forwarded to live bid");
        assertGt(fromArtcoinSide, 0, "artcoin LP fee converted + forwarded");

        console2.log("");
        console2.log("==== LP FEE PATH (8 buys + 1 sell, 0.5% LP fee) ====");
        console2.log("  LP fee accrued: native side in escrow (wei) ", nativeInEscrow);
        console2.log("  LP fee accrued: artcoin side in escrow (wei)", artcoinInEscrow);
        console2.log("  -> live bid from native flush (wei)         ", fromNativeSide);
        console2.log("  -> live bid from artcoin convert (wei)      ", fromArtcoinSide);
        console2.log("  TOTAL LP fee -> live bid (wei)              ", totalToLiveBid);
    }

    // ─── contribute() path: direct ETH top-up via LiveBidAdapter ──────────

    /// @notice Direct ETH contribution through the adapter (the canonical
    ///         attribution-bearing top-up surface, primary integration target
    ///         for "route X% of mint to Permanent Collection" launchpad
    ///         checkboxes). 5% of the value is forwarded synchronously to the
    ///         referrer (fail-closed); the remainder buffers in the adapter
    ///         and meters into Patron on the next sweep.
    function test_rehearsal_contributePath_distributesToReferrerAndBuffer() public {
        address funder = makeAddr("contributor");
        address referrer = makeAddr("contribute-referrer");
        vm.deal(funder, 2 ether);

        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 referrerBefore = referrer.balance;

        // With referrer: 5% to referrer synchronously, 95% buffered.
        vm.prank(funder);
        liveBidAdapter.contribute{value: 1 ether}(referrer, bytes32("rehearsal"));

        uint256 toReferrer = referrer.balance - referrerBefore;
        uint256 toAdapterBuffer = address(liveBidAdapter).balance - adapterBefore;
        assertEq(toReferrer, 0.05 ether, "referrer got exactly 5% of contribution");
        assertEq(toAdapterBuffer, 0.95 ether, "remaining 95% buffered in adapter");

        // Without referrer: 100% buffered.
        vm.prank(funder);
        liveBidAdapter.contribute{value: 1 ether}(address(0), bytes32("no-ref"));
        uint256 toAdapterBuffer_noref = address(liveBidAdapter).balance - adapterBefore - toAdapterBuffer;
        assertEq(toAdapterBuffer_noref, 1 ether, "no referrer -> 100% buffered");

        console2.log("");
        console2.log("==== contribute() PATH (1 ETH per call) ====");
        console2.log("  WITH referrer:");
        console2.log("    -> referrer 5% synchronous (wei)   ", toReferrer);
        console2.log("    -> LiveBidAdapter buffered (wei)   ", toAdapterBuffer);
        console2.log("  WITHOUT referrer:");
        console2.log("    -> LiveBidAdapter buffered (wei)   ", toAdapterBuffer_noref);
    }

    // ─── re-auction: rescued Punk goes back into the return auction with
    //     escalated reserve (101 + previousTrials)% of cost  ──────────────

    /// @notice The same trait can be retried. Each prior attempt increments
    ///         `attemptCount[targetTraitId]`, which raises the next return-
    ///         auction's reserve by 1% per trial. Proves a rescued
    ///         (ReturnedToMarket) Punk can be re-acquired and that the
    ///         second cleared distribution still respects the 65/25/10 cost
    ///         split — escalation only changes the cost basis, not the
    ///         percentages.
    function test_rehearsal_reAuction_escalatedReserveAndSameSplit() public {
        // Round 1: standard acceptBid + cleared rescue.
        _fundPatronFromAdapter(1 ether);
        address seller1 = makeAddr("reauc-seller1");
        uint16 punkId = 0;
        uint256 listed1 = _giveAndOfferToBounty(seller1, punkId);
        uint8 target = _pickTarget(punkId);
        patron.acceptBid(punkId, target, listed1);

        address rescuer1 = makeAddr("reauc-rescuer1");
        vm.deal(rescuer1, 3 ether);
        vm.prank(rescuer1);
        finalSale.placeBidWithReferral{value: 1.5 ether}(punkId, address(0), bytes32(0));
        vm.warp(uint256(finalSale.getSale(punkId).endsAt) + 1);
        finalSale.settle(punkId);

        // Sanity: rescue happened; trait still uncollected; attemptCount = 1.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), rescuer1, "round 1: Punk to rescuer1");
        assertEq((pc.collectedMask() >> target) & 1, 0, "round 1: trait NOT collected");
        uint256 prevTrials1 = pc.attemptCount(target);
        assertEq(prevTrials1, 1, "attemptCount = 1 after one acquisition");

        // Round 2: rescuer1 re-lists; someone re-acquires; reserve escalates.
        _fundPatronFromAdapter(1.5 ether);
        uint256 listed2 = patron.bidBalance();
        vm.prank(rescuer1);
        punksMarket.offerPunkForSaleToAddress(uint256(punkId), listed2, address(patron));
        patron.acceptBid(punkId, target, listed2);

        // Reserve = cost x (101 + previousTrials) / 100, ceil-div.
        uint256 sale2Reserve = finalSale.getSale(punkId).reserveWei;
        uint256 expectedReserve = (listed2 * (101 + prevTrials1) + 99) / 100;
        assertEq(sale2Reserve, expectedReserve, "reserve escalates by 1% per prior trial");

        // Place a winning bid at the new reserve.
        address rescuer2 = makeAddr("reauc-rescuer2");
        vm.deal(rescuer2, sale2Reserve + 1 ether);
        vm.prank(rescuer2);
        finalSale.placeBidWithReferral{value: sale2Reserve}(punkId, address(0), bytes32(0));

        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 burnerBefore = address(burner).balance;
        uint256 vbpBefore = address(vaultBurnPool).balance;

        vm.warp(uint256(finalSale.getSale(punkId).endsAt) + 1);
        finalSale.settle(punkId);

        uint256 toAdapter2 = address(liveBidAdapter).balance - adapterBefore;
        uint256 toBurner2 = address(burner).balance - burnerBefore;
        uint256 toVbp2 = address(vaultBurnPool).balance - vbpBefore;

        // Round-2 cost is listed2. Premium = sale2Reserve - listed2.
        assertEq(toAdapter2, listed2 * 65 / 100, "round 2: 65% of cost -> adapter");
        assertEq(toBurner2, listed2 * 25 / 100, "round 2: 25% of cost -> burner");
        assertEq(toVbp2, listed2 * 10 / 100 + (sale2Reserve - listed2), "round 2: 10% + premium -> vaultPool");
        assertEq(pc.attemptCount(target), 2, "attemptCount now 2 after second acquisition");

        console2.log("");
        console2.log("==== RE-AUCTION (round 2 after round-1 rescue) ====");
        console2.log("  round 1 cost (wei)                  ", listed1);
        console2.log("  round 2 cost (caller-set) (wei)     ", listed2);
        console2.log("  round 2 RESERVE = cost x 1.02 (wei) ", sale2Reserve);
        console2.log("  round 2 premium (wei)               ", sale2Reserve - listed2);
        console2.log("  -> LiveBidAdapter 65% (wei)         ", toAdapter2);
        console2.log("  -> BuybackBurner 25% (wei)          ", toBurner2);
        console2.log("  -> VaultBurnPool prem+10% (wei)     ", toVbp2);
        console2.log("  attemptCount[target] now            ", pc.attemptCount(target));
    }
}

// Minimal interfaces for the LP-fee narrative test (locker + FeeAutoSwapper
// are deployed by Phase 1 / Phase 2 but not imported elsewhere in the fixture).
interface IArtCoinsLocker {
    function collectRewards(address token) external;
}

interface IFeeAutoSwapper {
    function flushPaired() external returns (uint256 pairedOut);
    function convert(uint256 minOut) external returns (uint256 wethOut);
}
