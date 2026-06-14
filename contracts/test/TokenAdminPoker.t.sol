// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TokenAdminPoker} from "../src/TokenAdminPoker.sol";
import {ProtocolAdmin} from "../src/ProtocolAdmin.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

/// Minimal ArtCoinsToken stand-in. `setup` only records the token address and
/// the tax/referral setters forward to the hook, so the mock just needs to be
/// a contract with code at its address.
contract MockArtToken {}

/// Records setPoolExtension / lockPoolExtension / setMaxReferralBpsOfVolume calls.
contract MockHook {
    uint256 public setCount;
    uint256 public lockCount;
    uint256 public maxRefSetCount;
    address public lastExt;
    uint24 public lastMaxRef;
    bool public revertOnSetMaxRef;

    function setPoolExtension(PoolKey calldata, address ext, bytes calldata) external {
        setCount++;
        lastExt = ext;
    }

    function lockPoolExtension(PoolKey calldata) external {
        lockCount++;
    }

    function setMaxReferralBpsOfVolume(PoolKey calldata, uint24 newCap) external {
        if (revertOnSetMaxRef) revert("hook reverted");
        maxRefSetCount++;
        lastMaxRef = newCap;
    }

    function setRevertOnSetMaxRef(bool v) external {
        revertOnSetMaxRef = v;
    }
}

contract TokenAdminPokerTest is Test {
    TokenAdminPoker internal poker;
    ProtocolAdmin internal admin;
    MockArtToken internal token;
    MockHook internal hook;

    address internal owner = makeAddr("owner");
    address internal adminEoa = makeAddr("adminEoa");
    address internal stranger = makeAddr("stranger");

    PoolKey internal pk;

    function setUp() public {
        token = new MockArtToken();
        hook = new MockHook();
        admin = new ProtocolAdmin(adminEoa);
        poker = new TokenAdminPoker(owner, address(admin));
        pk = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 0x800000,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
    }

    function _setup() internal {
        vm.prank(owner);
        poker.setup(address(token), pk);
    }

    // ─── setup ───────────────────────────────────────────────────────────
    function test_setup_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(TokenAdminPoker.NotOwner.selector);
        poker.setup(address(token), pk);
    }

    function test_setup_oneShot() public {
        _setup();
        vm.prank(owner);
        vm.expectRevert(TokenAdminPoker.AlreadySetup.selector);
        poker.setup(address(token), pk);
    }

    function test_setup_zeroTokenReverts() public {
        vm.prank(owner);
        vm.expectRevert(TokenAdminPoker.ZeroAddress.selector);
        poker.setup(address(0), pk);
    }

    function test_setup_zeroHookReverts() public {
        PoolKey memory bad = pk;
        bad.hooks = IHooks(address(0));
        vm.prank(owner);
        vm.expectRevert(TokenAdminPoker.ZeroAddress.selector);
        poker.setup(address(token), bad);
    }

    function test_setup_pinsPoolKey() public {
        _setup();
        (Currency c0, Currency c1, uint24 fee, int24 ts, IHooks h) = poker.poolKey();
        assertEq(Currency.unwrap(c0), address(0));
        assertEq(Currency.unwrap(c1), address(token));
        assertEq(fee, 0x800000);
        assertEq(ts, int24(200));
        assertEq(address(h), address(hook));
    }

    // ─── bind / lock ───────────────────────────────────────────────────────
    function test_bindExtension_revertsBeforeSetup() public {
        vm.prank(owner);
        vm.expectRevert(TokenAdminPoker.NotSetup.selector);
        poker.bindExtension(address(0xBEEF));
    }

    function test_bindExtension_onlyOwner() public {
        _setup();
        vm.prank(stranger);
        vm.expectRevert(TokenAdminPoker.NotOwner.selector);
        poker.bindExtension(address(0xBEEF));
    }

    function test_bindExtension_forwardsToPinnedHook() public {
        _setup();
        vm.prank(owner);
        poker.bindExtension(address(0xBEEF));
        assertEq(hook.setCount(), 1);
        assertEq(hook.lastExt(), address(0xBEEF));
    }

    function test_bindExtension_rebindable() public {
        _setup();
        vm.startPrank(owner);
        poker.bindExtension(address(0xBEEF));
        poker.bindExtension(address(0xCAFE));
        vm.stopPrank();
        assertEq(hook.setCount(), 2);
        assertEq(hook.lastExt(), address(0xCAFE));
    }

    function test_lockExtension_revertsBeforeSetup() public {
        vm.prank(owner);
        vm.expectRevert(TokenAdminPoker.NotSetup.selector);
        poker.lockExtension();
    }

    function test_lockExtension_onlyOwnerAndForwards() public {
        _setup();
        vm.prank(stranger);
        vm.expectRevert(TokenAdminPoker.NotOwner.selector);
        poker.lockExtension();

        vm.prank(owner);
        poker.lockExtension();
        assertEq(hook.lockCount(), 1);
    }

    // ─── setHookMaxReferralBps ─────────────────────────────────────────────

    function test_setHookMaxReferralBps_strangerRejected() public {
        // Auth check fires before the setup gate, so no setup is needed here.
        vm.prank(stranger);
        vm.expectRevert(TokenAdminPoker.NotAuthorized.selector);
        poker.setHookMaxReferralBps(500);
    }

    function test_setHookMaxReferralBps_revertsBeforeSetup_fromOwner() public {
        // An authorized caller still hits the setup gate before forwarding.
        vm.prank(owner);
        vm.expectRevert(TokenAdminPoker.NotSetup.selector);
        poker.setHookMaxReferralBps(500);
    }

    function test_setHookMaxReferralBps_forwardsToHook_fromOwner() public {
        _setup();
        vm.prank(owner);
        poker.setHookMaxReferralBps(500);
        assertEq(hook.maxRefSetCount(), 1);
        assertEq(hook.lastMaxRef(), 500);
    }

    function test_setHookMaxReferralBps_forwardsToHook_fromAdminCarveOut() public {
        _setup();
        vm.prank(adminEoa);
        poker.setHookMaxReferralBps(750);
        assertEq(hook.maxRefSetCount(), 1);
        assertEq(hook.lastMaxRef(), 750);
    }

    function test_setHookMaxReferralBps_emitsEvent() public {
        _setup();
        vm.expectEmit(true, false, false, true, address(poker));
        emit TokenAdminPoker.MaxReferralBpsSet(address(hook), 750);
        vm.prank(owner);
        poker.setHookMaxReferralBps(750);
    }

    function test_setHookMaxReferralBps_acceptsZero() public {
        _setup();
        vm.prank(owner);
        poker.setHookMaxReferralBps(0);
        assertEq(hook.lastMaxRef(), 0);
    }

    function test_setHookMaxReferralBps_propagatesHookRevert() public {
        _setup();
        hook.setRevertOnSetMaxRef(true);
        vm.prank(owner);
        vm.expectRevert("hook reverted");
        poker.setHookMaxReferralBps(500);
    }

    function test_setHookMaxReferralBps_survivesOwnershipRotation() public {
        // Carve-out: even after ownership is rotated away from the launch
        // key, the ProtocolAdmin EOA can still tune the cap.
        _setup();
        vm.prank(owner);
        poker.transferOwnership(makeAddr("rotated"));

        // Original owner is no longer authorized.
        vm.prank(owner);
        vm.expectRevert(TokenAdminPoker.NotAuthorized.selector);
        poker.setHookMaxReferralBps(500);

        // ProtocolAdmin EOA still works (the carve-out path).
        vm.prank(adminEoa);
        poker.setHookMaxReferralBps(600);
        assertEq(hook.lastMaxRef(), 600);
    }

    function test_setHookMaxReferralBps_survivesAdminTimerExpiry() public {
        // Carve-out: uses adminContract.admin() directly, NOT checkAdmin().
        // So the 1y ProtocolAdmin timer expiring doesn't lock the setter.
        _setup();
        vm.warp(block.timestamp + 366 days);
        assertTrue(admin.isLocked(), "admin should be timer-locked");

        vm.prank(adminEoa);
        poker.setHookMaxReferralBps(800);
        assertEq(hook.lastMaxRef(), 800);
    }

    function test_setHookMaxReferralBps_freezesOnlyWhenAdminBurnedAndOwnerRotated() public {
        _setup();
        // Burn ProtocolAdmin via transferAdmin(address(0)). After this,
        // the carve-out path is gone, but TokenAdminPoker.owner still works.
        vm.prank(adminEoa);
        admin.transferAdmin(address(0));

        // Owner path still functions.
        vm.prank(owner);
        poker.setHookMaxReferralBps(400);
        assertEq(hook.lastMaxRef(), 400);

        // Rotating owner to a burn address removes the last live path.
        vm.prank(owner);
        poker.transferOwnership(makeAddr("burned-owner"));

        // Both original roles now rejected.
        vm.prank(owner);
        vm.expectRevert(TokenAdminPoker.NotAuthorized.selector);
        poker.setHookMaxReferralBps(500);

        vm.prank(adminEoa);
        vm.expectRevert(TokenAdminPoker.NotAuthorized.selector);
        poker.setHookMaxReferralBps(500);
    }

    // ─── ownership ─────────────────────────────────────────────────────────
    function test_transferOwnership() public {
        _setup();
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        poker.transferOwnership(newOwner);
        assertEq(poker.owner(), newOwner);

        // old owner can no longer bind
        vm.prank(owner);
        vm.expectRevert(TokenAdminPoker.NotOwner.selector);
        poker.bindExtension(address(0xBEEF));
    }

    function test_transferOwnership_zeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(TokenAdminPoker.ZeroAddress.selector);
        poker.transferOwnership(address(0));
    }
}
