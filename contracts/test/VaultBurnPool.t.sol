// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultBurnPool} from "../src/VaultBurnPool.sol";
import {OneTimeSetup} from "../src/libraries/OneTimeSetup.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

contract VaultBurnPoolTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
    }

    function test_Pool_AcceptsArbitraryTopUps() public {
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(vaultBurnPool).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(vaultBurnPool.balance(), 5 ether);
    }

    function test_Sweep_OnlyFromReturnAuctionModule() public {
        vm.deal(address(vaultBurnPool), 1 ether);
        vm.expectRevert(VaultBurnPool.NotReturnAuctionModule.selector);
        vaultBurnPool.sweep();
    }

    function test_Sweep_ForwardsAllToBuybackBurner() public {
        vm.deal(address(vaultBurnPool), 2.5 ether);
        uint256 burnerBefore = address(burner).balance;

        vm.prank(address(finalSale));
        uint256 forwarded = vaultBurnPool.sweep();

        assertEq(forwarded, 2.5 ether);
        assertEq(address(vaultBurnPool).balance, 0);
        assertEq(address(burner).balance - burnerBefore, 2.5 ether);
    }

    function test_Sweep_NoOpWhenEmpty() public {
        vm.prank(address(finalSale));
        uint256 forwarded = vaultBurnPool.sweep();
        assertEq(forwarded, 0);
    }

    function test_Bytecode_NoWithdrawalSelectors() public view {
        bytes memory code = address(vaultBurnPool).code;
        // NOTE: `sweep()` IS a legitimate function on this contract (the
        // ReturnAuctionModule-only forward to BuybackBurner). It's intentionally
        // omitted from the forbidden list. Every other withdrawal-shaped
        // selector is asserted absent.
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
        _assertNoSelector(code, bytes4(keccak256("withdraw(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("withdrawAll()")));
        _assertNoSelector(code, bytes4(keccak256("rescue(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(address)")));
        _assertNoSelector(code, bytes4(keccak256("sweep(address)")));
        _assertNoSelector(code, bytes4(keccak256("sweep(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("drain(address)")));
        _assertNoSelector(code, bytes4(keccak256("emergencyWithdraw()")));
        _assertNoSelector(code, bytes4(keccak256("migrate(address)")));
        _assertNoSelector(code, bytes4(keccak256("setOwner(address)")));
        _assertNoSelector(code, bytes4(keccak256("transferOwnership(address)")));
        // The only 111 outflow is `burn` (a call TO the token, not a selector
        // here). The pool must NOT expose any ERC20 move-out surface that could
        // send the accrued tax 111 to an external address instead of burning it.
        _assertNoSelector(code, bytes4(keccak256("transfer(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("transferFrom(address,address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("approve(address,uint256)")));
    }

    function _assertNoSelector(bytes memory code, bytes4 sel) internal pure {
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == sel[0]
                    && code[i + 1] == sel[1]
                    && code[i + 2] == sel[2]
                    && code[i + 3] == sel[3]
            ) {
                revert("bytecode contains forbidden selector");
            }
        }
    }
}

/// @dev Minimal burnable ERC20 stand-in for the 111 token — just the surface
///      `VaultBurnPool` touches (`balanceOf` + `burn`) plus a test `mint`.
contract MockBurnableToken {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function burn(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
    }
}

/// @dev Rejects ETH — stands in for a BuybackBurner whose `receive` reverts, to
///      prove a failed ETH forward neither reverts `sweep` nor blocks the burn.
contract RevertingReceiver {
    receive() external payable {
        revert("nope");
    }
}

/// @dev Standalone (no-fork) coverage of the 111-burn leg + one-shot `setup`
///      gate. Deploys its own `VaultBurnPool` so the test contract is the
///      `OneTimeSetup` deployer and can wire the mock token. `swapContext = 0`
///      makes the `notInSwap` modifier a no-op.
contract VaultBurnPoolBurnTest is Test {
    VaultBurnPool internal pool;
    MockBurnableToken internal tok;
    address internal module;
    address payable internal burner;

    event SidePoolTaxBurned(uint256 amount);

    function setUp() public {
        module = makeAddr("returnAuctionModule");
        burner = payable(makeAddr("buybackBurner"));
        pool = new VaultBurnPool(module, burner, address(0));
        tok = new MockBurnableToken();
        pool.setup(address(tok));
    }

    function test_Setup_WiresToken() public view {
        assertEq(pool.token(), address(tok));
        assertTrue(pool.setupFinalized());
    }

    function test_Setup_IsOneShot() public {
        vm.expectRevert(OneTimeSetup.AlreadyFinalized.selector);
        pool.setup(address(tok));
    }

    function test_Setup_RejectsZero() public {
        VaultBurnPool fresh = new VaultBurnPool(module, burner, address(0));
        vm.expectRevert(VaultBurnPool.ZeroAddress.selector);
        fresh.setup(address(0));
    }

    function test_Setup_OnlyDeployer() public {
        VaultBurnPool fresh = new VaultBurnPool(module, burner, address(0));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(OneTimeSetup.NotDeployer.selector);
        fresh.setup(address(tok));
    }

    function test_Sweep_BurnsAccruedToken() public {
        tok.mint(address(pool), 1_000 ether);
        uint256 supplyBefore = tok.totalSupply();

        vm.expectEmit(address(pool));
        emit SidePoolTaxBurned(1_000 ether);
        vm.prank(module);
        pool.sweep();

        assertEq(tok.balanceOf(address(pool)), 0, "accrued 111 fully burned");
        assertEq(tok.totalSupply(), supplyBefore - 1_000 ether, "totalSupply dropped by burn");
    }

    function test_Sweep_BurnsTokenAndForwardsEth() public {
        tok.mint(address(pool), 500 ether);
        vm.deal(address(pool), 2 ether);

        vm.prank(module);
        uint256 forwarded = pool.sweep();

        assertEq(forwarded, 2 ether, "ETH forwarded");
        assertEq(burner.balance, 2 ether, "burner received ETH");
        assertEq(tok.balanceOf(address(pool)), 0, "111 burned");
    }

    function test_Sweep_ZeroTokenBalance_NoOp() public {
        // ETH only, no accrued 111 — the burn leg is a no-op and must not revert.
        vm.deal(address(pool), 1 ether);
        vm.prank(module);
        pool.sweep();
        assertEq(tok.totalSupply(), 0, "nothing minted, nothing burned");
    }

    function test_Sweep_UnwiredToken_SkipsBurn() public {
        // A pool whose token was never wired keeps the pure-ETH behaviour:
        // even if 111 sits in it, the burn leg is skipped (token == 0).
        VaultBurnPool unwired = new VaultBurnPool(module, burner, address(0));
        MockBurnableToken t2 = new MockBurnableToken();
        t2.mint(address(unwired), 100 ether);
        vm.deal(address(unwired), 1 ether);

        vm.prank(module);
        unwired.sweep();

        assertEq(t2.balanceOf(address(unwired)), 100 ether, "unwired pool does NOT burn");
    }

    function test_Sweep_EthForwardFails_BurnStillHappens() public {
        // Hardening guarantee: even if the ETH forward fails (a reverting
        // BuybackBurner), sweep does NOT revert and the 111 burn STILL happens —
        // so settle can call sweep directly and the burn is unconditional.
        RevertingReceiver rr = new RevertingReceiver();
        VaultBurnPool p = new VaultBurnPool(module, payable(address(rr)), address(0));
        MockBurnableToken t = new MockBurnableToken();
        p.setup(address(t));
        t.mint(address(p), 1_000 ether);
        vm.deal(address(p), 2 ether);

        vm.prank(module);
        uint256 forwarded = p.sweep(); // must NOT revert

        assertEq(forwarded, 0, "failed ETH forward reported as 0");
        assertEq(address(p).balance, 2 ether, "ETH stays in the pool on a failed forward");
        assertEq(t.balanceOf(address(p)), 0, "111 burned despite the ETH forward failing");
        assertEq(t.totalSupply(), 0, "totalSupply dropped - a real burn");
    }
}
