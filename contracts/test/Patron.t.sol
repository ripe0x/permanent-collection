// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

contract ForceSendToPatron {
    constructor(
        address payable target
    ) payable {
        selfdestruct(target);
    }
}

/// @notice Patron-specific tests not covered by the entry-point suites.
///         Focuses on invariants (no admin withdrawal path), reentrancy, and
///         pool-replenish gating.
contract PatronTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
    }

    function test_BytecodeContainsNoAdminWithdrawSelectors() public view {
        bytes memory code = address(patron).code;
        // Patron must have no admin path to drain funds. Asserting the
        // absence of common withdraw/rescue/sweep selectors hardens the
        // "no admin withdrawal" invariant.
        _assertNoSelector(code, bytes4(keccak256("rescue(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("sweep()")));
        _assertNoSelector(code, bytes4(keccak256("sweep(address)")));
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
        _assertNoSelector(code, bytes4(keccak256("withdraw(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("withdrawAll()")));
        _assertNoSelector(code, bytes4(keccak256("emergencyWithdraw()")));
        _assertNoSelector(code, bytes4(keccak256("migrate(address)")));
    }

    /// @dev Under inflow consolidation, `poolReplenish` (and `contribute`)
    ///      moved off Patron onto `LiveBidAdapter`. Patron's bytecode must no
    ///      longer expose either selector — every bid-funding source now enters
    ///      through the adapter. (Adapter-side gating is covered by
    ///      `LiveBidAdapterTest.test_PoolReplenish_ModuleOnly`.)
    function test_Patron_NoContributeOrPoolReplenishSelectors() public view {
        bytes memory code = address(patron).code;
        _assertNoSelector(code, bytes4(keccak256("poolReplenish(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("contribute(address,bytes32)")));
    }

    /// @dev `receive()` accepts ETH ONLY from the wired adapter — it is the
    ///      single faucet into the live bid.
    function test_Receive_AcceptsFromAdapter() public {
        uint256 before_ = address(patron).balance;
        uint256 bidBefore = patron.bidBalance();
        vm.deal(address(liveBidAdapter), 3 ether);
        vm.prank(address(liveBidAdapter));
        (bool ok,) = address(patron).call{value: 3 ether}("");
        assertTrue(ok, "adapter send accepted");
        assertEq(address(patron).balance, before_ + 3 ether);
        assertEq(patron.bidBalance(), bidBefore + 3 ether, "adapter send counted as live bid");
    }

    /// @dev A direct top-up from any non-adapter sender is rejected — it must
    ///      route through the adapter (`receive`/`contribute`) instead.
    function test_Receive_RejectsNonAdapter() public {
        address rando = address(0xCAFE);
        vm.deal(rando, 3 ether);
        uint256 before_ = address(patron).balance;
        vm.prank(rando);
        (bool ok,) = address(patron).call{value: 3 ether}("");
        assertFalse(ok, "non-adapter send rejected (NotAdapter)");
        assertEq(address(patron).balance, before_, "no ETH entered Patron");
    }

    function test_ForcedEth_DoesNotInflateBidBalancePayoutOrReserve() public {
        uint16 punkId = 1;
        address owner = address(0xBEA71E);
        uint256 realBid = 1 ether;
        uint256 forcedEth = 25 ether;

        _fundPatronFromAdapter(realBid);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);

        vm.deal(owner, 100 ether);
        uint256 ownerBeforeForce = owner.balance;

        vm.prank(owner);
        new ForceSendToPatron{value: forcedEth}(payable(address(patron)));

        assertEq(address(patron).balance, realBid + forcedEth, "raw balance polluted");
        assertEq(patron.bidBalance(), realBid, "forced ETH not counted as live bid");

        patron.acceptBid(punkId, target, realBid);

        // Owner is credited only the accounted bid by the market (forced ETH
        // excluded), and collects it with withdraw().
        assertEq(punksMarket.pendingWithdrawals(owner), realBid, "seller credited only the accounted bid");
        vm.prank(owner);
        punksMarket.withdraw();
        assertEq(owner.balance, ownerBeforeForce + realBid - forcedEth, "seller withdrew only the accounted bid");
        assertEq(patron.bidBalance(), 0, "accounted bid paid out");
        assertEq(address(patron).balance, forcedEth, "forced ETH remains surplus");
        assertEq(finalSale.getSale(punkId).acquisitionCost, realBid, "cost ignores forced ETH");
        assertEq(finalSale.reserveOf(punkId), (realBid * 101) / 100, "reserve ignores forced ETH");

        uint256 adapterBefore = address(liveBidAdapter).balance;
        uint256 forwarded = patron.skimSurplus();
        assertEq(forwarded, forcedEth, "surplus forwarded");
        assertEq(address(patron).balance, 0, "surplus removed from Patron");
        assertEq(address(liveBidAdapter).balance, adapterBefore + forcedEth, "surplus returned to adapter");
        assertEq(patron.bidBalance(), 0, "surplus not immediately live bid");
    }

    /// @notice Forced ETH is never permanently stuck. `skimSurplus` routes it to
    ///         the adapter, and the adapter's `sweep` meters it back into the
    ///         live bid via `Patron.receive()`, where it becomes payable. This
    ///         closes the recovery loop the test above starts (which stops at
    ///         the adapter buffer): the only way `balance > accounted` is forced
    ///         ETH, and that excess is always recoverable into the bid.
    function test_ForcedEth_RecoverableIntoBidViaSweep() public {
        uint256 forcedEth = 1 ether; // below the adapter's maxSweepWei so one sweep clears it

        // 1. Force ETH in (bypasses receive() -> surplus, not bid).
        new ForceSendToPatron{value: forcedEth}(payable(address(patron)));
        assertEq(patron.bidBalance(), 0, "forced ETH not counted as bid");
        assertEq(address(patron).balance, forcedEth, "forced ETH is surplus");

        // 2. skimSurplus moves the surplus out of Patron and into the adapter.
        uint256 adapterBefore = address(liveBidAdapter).balance;
        patron.skimSurplus();
        assertEq(address(patron).balance, 0, "no surplus left stuck in Patron");
        assertEq(
            address(liveBidAdapter).balance, adapterBefore + forcedEth, "surplus buffered in adapter"
        );

        // 3. The adapter meters it back into the live bid via sweep -> receive().
        vm.roll(block.number + liveBidAdapter.minBlocksBetweenSweeps());
        uint256 bidBefore = patron.bidBalance();
        uint256 forwarded = liveBidAdapter.sweep();
        assertGt(forwarded, 0, "sweep recovered the surplus toward the bid");
        assertEq(
            patron.bidBalance(), bidBefore + forwarded, "recovered ETH is now payable live bid"
        );
    }

    /// @notice With a zero live bid, `acceptBid` MUST revert — there is no
    ///         "sell a Punk for nothing" path. A zero-price listing (what a zero
    ///         bid yields) hits `ZeroListingPrice`; any positive listing exceeds
    ///         the empty pool and hits `ListingExceedsBid`. Either way the Punk
    ///         does not move and nothing is recorded.
    function test_AcceptBid_ZeroBidBalance_Reverts() public {
        uint16 punkId = 1;
        address owner = address(0xBEA71E);
        // Bid is zero here, so the helper lists at price 0.
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);

        // (a) A zero-price listing is rejected outright.
        vm.expectRevert(abi.encodeWithSelector(Patron.ZeroListingPrice.selector, punkId));
        patron.acceptBid(punkId, target, type(uint256).max);

        // (b) Any positive listing exceeds the empty pool.
        vm.prank(owner);
        punksMarket.offerPunkForSaleToAddress(uint256(punkId), 1, address(patron));
        vm.expectRevert(abi.encodeWithSelector(Patron.ListingExceedsBid.selector, uint256(1), uint256(0)));
        patron.acceptBid(punkId, target, type(uint256).max);

        // The Punk never left its owner and nothing was recorded.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), owner, "Punk unmoved");
        assertFalse(collection.isRecorded(punkId), "nothing recorded");
    }

    function test_AcceptListing_RevertsIfBountyBelowMinimum() public {
        // Allowlist a seller, list a Punk at a tiny price, but bounty is
        // below MIN_BID_FOR_LISTING (0.5 ETH).
        _fundPatronFromAdapter(0.3 ether);
        patron.addAllowedSeller(address(0xCAFE99));
        // We don't even need a real listing — the bounty floor check fires
        // before any listing/seller checks.
        vm.expectRevert(abi.encodeWithSelector(Patron.BidBelowMinimum.selector, 0.3 ether, 0.5 ether));
        patron.acceptListing(uint16(1), 0);
    }

    function test_AddAllowedSeller_RejectsZeroAddress() public {
        vm.expectRevert(Patron.ZeroAddress.selector);
        patron.addAllowedSeller(address(0));
    }

    function test_AddAllowedSeller_Idempotent_NoDupEvents() public {
        address seller = address(0xCAFE99);
        patron.addAllowedSeller(seller);
        assertTrue(patron.allowedSellers(seller));
        // Re-add is a no-op (no revert, no second event).
        patron.addAllowedSeller(seller);
        assertTrue(patron.allowedSellers(seller));
    }

    function test_RemoveAllowedSeller_NoOpIfNotAllowlisted() public {
        // Removing a never-added seller is a no-op (no revert).
        patron.removeAllowedSeller(address(0xCAFE99));
        assertFalse(patron.allowedSellers(address(0xCAFE99)));
    }

    function test_NonAdmin_CannotEditAllowlist() public {
        address rando = address(0xBA5E);
        vm.startPrank(rando);
        vm.expectRevert(Patron.NotAdmin.selector);
        patron.addAllowedSeller(address(0xCAFE));
        vm.expectRevert(Patron.NotAdmin.selector);
        patron.removeAllowedSeller(address(0xCAFE));
        vm.stopPrank();
    }

    function _assertNoSelector(
        bytes memory code,
        bytes4 sel
    ) internal pure {
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2] && code[i + 3] == sel[3]) {
                revert("bytecode contains forbidden selector");
            }
        }
    }
}
