// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Direct coverage of the M-3 allowlist activation delay. Newly
///         allowlisted sellers cannot be drained until `ALLOWLIST_DELAY`
///         (24h) has elapsed since `addAllowedSeller`. Gives the protocol
///         and community a window to react to a hostile addition (whether
///         from a compromised admin EOA or a misconfiguration).
contract AllowlistDelayTest is ForkFixtures {
    address internal seller = address(0xC0FFEE);

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        _fundPatronFromAdapter(5 ether);
    }

    function _findEligiblePunkOwnedBy(address sellerAddr, uint16 startFrom)
        internal view returns (uint16)
    {
        sellerAddr;
        for (uint16 i = startFrom; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) == 0) continue;
            address owner = punksMarket.punkIndexToAddress(i);
            if (owner != address(0)) return i;
        }
        revert("no eligible");
    }

    // ─── activation timer state ─────────────────────────────────────────

    function test_AddAllowedSeller_SetsActivationTimestamp() public {
        uint64 t0 = uint64(block.timestamp);
        patron.addAllowedSeller(seller);

        assertTrue(patron.allowedSellers(seller), "seller listed");
        assertEq(
            patron.allowedSellerActiveAt(seller),
            t0 + patron.ALLOWLIST_DELAY(),
            "activation = now + ALLOWLIST_DELAY"
        );
    }

    function test_AddAllowedSeller_Idempotent_DoesNotResetTimer() public {
        patron.addAllowedSeller(seller);
        uint64 originalActivation = patron.allowedSellerActiveAt(seller);

        // Advance some time, then re-add. Already-allowlisted re-adds are
        // a no-op (no event, no timer reset).
        vm.warp(block.timestamp + 1 hours);
        patron.addAllowedSeller(seller);
        assertEq(
            patron.allowedSellerActiveAt(seller), originalActivation,
            "timer preserved on re-add"
        );
    }

    function test_RemoveAllowedSeller_ZerosActivation() public {
        patron.addAllowedSeller(seller);
        assertGt(patron.allowedSellerActiveAt(seller), 0);

        patron.removeAllowedSeller(seller);
        assertFalse(patron.allowedSellers(seller));
        assertEq(patron.allowedSellerActiveAt(seller), 0, "activation cleared");
    }

    function test_ReAdd_RestartsFullDelay() public {
        patron.addAllowedSeller(seller);
        vm.warp(block.timestamp + 12 hours); // halfway through original delay
        patron.removeAllowedSeller(seller);

        // Re-add at this point — new timer starts from current block.timestamp.
        uint64 reAddTime = uint64(block.timestamp);
        patron.addAllowedSeller(seller);
        assertEq(
            patron.allowedSellerActiveAt(seller),
            reAddTime + patron.ALLOWLIST_DELAY(),
            "re-add re-engages full delay"
        );
    }

    // ─── acceptListing gated by activation ──────────────────────────────

    function test_AcceptListing_RevertsBeforeActivation() public {
        patron.addAllowedSeller(seller);

        // Stage a listing immediately (still inside the 24h window).
        uint16 punkId = _findEligiblePunkOwnedBy(seller, 100);
        _giveAndPublicList(seller, punkId, 1 ether);

        uint8 target = _pickTarget(punkId);
        uint64 activeAt = patron.allowedSellerActiveAt(seller);

        vm.expectRevert(
            abi.encodeWithSelector(Patron.SellerNotYetActive.selector, seller, activeAt)
        );
        patron.acceptListing(punkId, target);
    }

    function test_AcceptListing_RevertsAt23h59m59s() public {
        patron.addAllowedSeller(seller);
        uint16 punkId = _findEligiblePunkOwnedBy(seller, 200);
        _giveAndPublicList(seller, punkId, 1 ether);
        uint8 target = _pickTarget(punkId);

        // One second before activation — still locked.
        vm.warp(uint256(patron.allowedSellerActiveAt(seller)) - 1);
        vm.expectRevert(); // SellerNotYetActive
        patron.acceptListing(punkId, target);
    }

    function test_AcceptListing_SucceedsAtExactActivation() public {
        patron.addAllowedSeller(seller);
        uint16 punkId = _findEligiblePunkOwnedBy(seller, 300);
        _giveAndPublicList(seller, punkId, 1 ether);
        uint8 target = _pickTarget(punkId);

        // Exactly at activation — the check is `block.timestamp < activeAt`,
        // so equality passes.
        vm.warp(uint256(patron.allowedSellerActiveAt(seller)));
        patron.acceptListing(punkId, target);

        // Confirm the call landed (Punk now in ReturnAuction custody).
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
    }

    function test_AcceptListing_SucceedsAfterActivation() public {
        patron.addAllowedSeller(seller);
        uint16 punkId = _findEligiblePunkOwnedBy(seller, 400);
        _giveAndPublicList(seller, punkId, 1 ether);
        uint8 target = _pickTarget(punkId);

        vm.warp(block.timestamp + patron.ALLOWLIST_DELAY() + 1);
        patron.acceptListing(punkId, target);
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
    }

    // ─── interaction with admin lifecycle ───────────────────────────────

    function test_DelayAppliesEvenWhenAddedPostAdminLock() public {
        // Past the 1y admin expiry, the allowlist is still editable
        // (carve-out via `onlyAdminEvenIfLocked`). Confirm the M-3 delay
        // still applies on these post-lock adds — defense in depth against
        // a compromised stale admin key.
        vm.warp(block.timestamp + 366 days);
        assertTrue(adminContract.isLocked());

        patron.addAllowedSeller(seller);
        uint16 punkId = _findEligiblePunkOwnedBy(seller, 500);
        _giveAndPublicList(seller, punkId, 1 ether);
        uint8 target = _pickTarget(punkId);

        // Listing immediately blocked.
        vm.expectRevert(); // SellerNotYetActive
        patron.acceptListing(punkId, target);

        // After 24h, unlocked.
        vm.warp(block.timestamp + patron.ALLOWLIST_DELAY() + 1);
        patron.acceptListing(punkId, target);
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(finalSale));
    }

    function test_PreviouslyRemovedSeller_MustWaitFullDelayAgain() public {
        // Add, wait past delay, remove, immediately re-add — the seller is
        // not consumable until ANOTHER 24h elapses.
        patron.addAllowedSeller(seller);
        vm.warp(block.timestamp + patron.ALLOWLIST_DELAY() + 1);
        assertGe(uint64(block.timestamp), patron.allowedSellerActiveAt(seller));

        patron.removeAllowedSeller(seller);
        patron.addAllowedSeller(seller);

        uint16 punkId = _findEligiblePunkOwnedBy(seller, 600);
        _giveAndPublicList(seller, punkId, 1 ether);
        uint8 target = _pickTarget(punkId);

        vm.expectRevert(); // SellerNotYetActive
        patron.acceptListing(punkId, target);

        vm.warp(block.timestamp + patron.ALLOWLIST_DELAY() + 1);
        patron.acceptListing(punkId, target);
    }
}
