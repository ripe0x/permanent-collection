// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {ICryptoPunksMarket} from "../src/interfaces/ICryptoPunksMarket.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Simulates the PunkStrategy yoyo: an autonomous contract that
///         buys floor Punks and re-lists them publicly at a 1.2× markup.
///         On sale proceeds, it "burns" by funnelling proceeds into a
///         tracked counter (a stand-in for the PNKSTR buy-and-burn).
///
///         The headline integration test then accepts a PunkStrategy listing
///         via `Patron.acceptListing` and asserts both protocols'
///         cycles complete: PunkStrategy receives proceeds (and "burns"),
///         our protocol now holds the Punk in return auction.
contract MockPunkStrategy {
    ICryptoPunksMarket public immutable market;
    uint256 public proceedsBurned;
    uint256 public cyclesCompleted;
    uint256 public constant MARKUP_BPS = 12_000; // 1.2×

    constructor(address _market) {
        market = ICryptoPunksMarket(_market);
    }

    /// @notice List a Punk owned by this contract at 1.2× the given cost.
    ///         Called after the contract has bought a Punk from the floor.
    function listAtMarkup(uint16 punkId, uint256 cost) external {
        uint256 listPrice = (cost * MARKUP_BPS) / 10_000;
        market.offerPunkForSale(uint256(punkId), listPrice);
    }

    /// @notice Pull queued proceeds from the market and "burn" them.
    function withdrawAndBurn() external {
        uint256 before_ = address(this).balance;
        market.withdraw();
        uint256 received = address(this).balance - before_;
        if (received > 0) {
            proceedsBurned += received;
            cyclesCompleted += 1;
        }
    }

    receive() external payable {}
}

contract PunkStrategyCompositionTest is ForkFixtures {
    MockPunkStrategy internal punkStrategy;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        punkStrategy = new MockPunkStrategy(PUNKS_MARKET);
        _addAllowedSellerImmediate(address(punkStrategy));
    }

    function _findPunkWithUncollectedTrait(uint16 startFrom)
        internal
        view
        returns (uint16)
    {
        for (uint16 i = startFrom; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible punk");
    }

    /// @notice The headline test. PunkStrategy holds a Punk (simulated via a
    ///         direct transfer) and lists it at 1.2× cost. Our bounty has
    ///         been topped up so it exceeds the listing price. A single
    ///         `acceptListing` call completes both cycles atomically:
    ///         PunkStrategy gets its proceeds (immediately "burnable"), our
    ///         protocol gets the Punk into return auction.
    function test_FullYoyoCycle_AcceptListingCompletesBothProtocols() public {
        // Step 1: PunkStrategy "bought" a Punk at 25 ETH (simulated).
        uint16 punkId = _findPunkWithUncollectedTrait(2000);
        uint256 strategyCost = 25 ether;
        address currentOwner = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(currentOwner);
        punksMarket.transferPunk(address(punkStrategy), uint256(punkId));

        // Step 2: PunkStrategy lists at 1.2× = 30 ETH.
        punkStrategy.listAtMarkup(punkId, strategyCost);
        uint256 expectedListPrice = (strategyCost * 12_000) / 10_000;

        // Step 3: Bounty grows to 35 ETH (above listing price).
        _fundPatronFromAdapter(35 ether);

        // Step 4: Anyone calls acceptListing. Both cycles complete.
        address bot = address(0xB07);
        vm.deal(bot, 0);
        uint8 target = _pickTarget(punkId);
        vm.prank(bot);
        patron.acceptListing(punkId, target);

        // PunkStrategy's listing was bought: pendingWithdrawals queued.
        assertEq(
            punksMarket.pendingWithdrawals(address(punkStrategy)),
            expectedListPrice,
            "strategy can claim proceeds"
        );

        // PunkStrategy claims, burns simulated.
        punkStrategy.withdrawAndBurn();
        assertEq(punkStrategy.cyclesCompleted(), 1, "strategy yoyo cycle done");
        assertEq(punkStrategy.proceedsBurned(), expectedListPrice, "strategy 'burned' proceeds");

        // Our cycle: Punk in return auction; PC recorded acquisition.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
        assertTrue(collection.isRecorded(punkId));
        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.InReturnAuction)
        );

        // Bot earned finder fee.
        assertGt(bot.balance, 0, "bot paid finder fee");
        assertLe(bot.balance, patron.finderFeeFixedCap(), "fee capped");

        // Bounty paid out by listing price + finder fee.
        uint256 expectedRemaining = 35 ether - expectedListPrice - bot.balance;
        assertEq(address(patron).balance, expectedRemaining, "bounty paid out correctly");
    }

    function test_YoyoCycle_StuckIfBountyBelowListing() public {
        uint16 punkId = _findPunkWithUncollectedTrait(2000);
        uint256 strategyCost = 25 ether;
        address currentOwner = punksMarket.punkIndexToAddress(uint256(punkId));
        vm.prank(currentOwner);
        punksMarket.transferPunk(address(punkStrategy), uint256(punkId));

        punkStrategy.listAtMarkup(punkId, strategyCost); // lists at 30 ETH

        // Bounty is only 25 ETH — below the listing.
        _fundPatronFromAdapter(25 ether);

        uint8 target = _pickTarget(punkId);
        vm.expectRevert();
        patron.acceptListing(punkId, target);

        // Both protocols stuck waiting for bounty to grow OR a third-party
        // buyer to take the listing. This is the natural pause state.
    }

    function test_PunkStrategy_AsFinalSaleBidder_ClearsAndRefillsBounty() public {
        // Setup: bounty is high, owner accepts bounty, Punk enters return auction.
        uint16 punkId = _findPunkWithUncollectedTrait(3000);
        _fundPatronFromAdapter(20 ether);
        address owner = address(0xCAFE);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Now PunkStrategy decides to clear the Punk by bidding in return auction.
        uint256 reserve = finalSale.reserveOf(punkId);
        vm.deal(address(punkStrategy), reserve);
        vm.prank(address(punkStrategy));
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));

        // Settle.
        uint256 patronBefore = address(patron).balance;
        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 burnerBefore = address(burner).balance;
        uint256 vbpBefore = address(vaultBurnPool).balance;
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        // PunkStrategy now holds the Punk. Three-way split (no keeper tip —
        // the full 65% reaches the adapter):
        //   bountyShare       = 65% × acquisitionCost → LiveBidAdapter buffer
        //   vaultBurnFromCost = 10% × acquisitionCost (in addition to premium)
        //   burnShare         = 25% × acquisitionCost (residual)
        //   vaultBurnShare    = (highBid - cost) + vaultBurnFromCost
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(punkStrategy));
        // acquisitionCost = patron balance at acceptBid time = 20 ETH
        uint256 cost = 20 ether;
        uint256 expectedBounty = (cost * 6500) / 10_000;
        uint256 expectedVaultBurnFromCost = (cost * 1000) / 10_000;
        uint256 expectedBurn = cost - expectedBounty - expectedVaultBurnFromCost;
        uint256 expectedVaultBurn = (reserve - cost) + expectedVaultBurnFromCost; // bidder paid exactly reserve
        assertEq(address(liveBidAdapter).balance - adapterBefore, expectedBounty, "bounty = full 65% of cost (buffered in adapter)");
        assertEq(address(patron).balance, patronBefore, "Patron untouched by settle");
        assertEq(address(burner).balance - burnerBefore, expectedBurn, "burn = 25% of cost residual");
        assertEq(address(vaultBurnPool).balance - vbpBefore, expectedVaultBurn, "premium + 10%-of-cost to VBP");

        // PunkStrategy could re-list this Punk and the cycle continues.
    }
}
