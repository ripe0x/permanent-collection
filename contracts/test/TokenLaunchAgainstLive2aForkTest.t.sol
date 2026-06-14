// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Live2aLaunchHarness} from "./helpers/Live2aLaunchHarness.sol";
import {TestSwapHelper} from "./helpers/TestSwapHelper.sol";
import {VerifyDeploy} from "../script/VerifyDeploy.s.sol";

interface IHasTokenHook {
    function token() external view returns (address);
    function hook() external view returns (address);
}

interface IHasToken {
    function token() external view returns (address);
}

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

interface IPatronBid {
    function bidBalance() external view returns (uint256);
}

/// @title TokenLaunchAgainstLive2aForkTest
/// @notice The launch rehearsal for what's actually LEFT to broadcast: Phase 2a
///         (all PC contracts) is already live on mainnet, so this forks the real
///         post-2a state and runs ONLY the token launch (Phase 2b / `runToken`)
///         against the live, deployed 2a contracts — the only remaining deploy —
///         then exercises trading + the side-pool tax on the live system.
///
/// Run:
///   MAINNET_RPC_URL=https://gateway.tenderly.co/public/mainnet \
///     forge test --match-contract TokenLaunchAgainstLive2a -vv
contract TokenLaunchAgainstLive2aForkTest is Test {
    // ── Live mainnet Phase-1 artcoins stack (real, on-chain) ──────────────
    address constant FACTORY = 0x49596c375c139E79bb937bcf826068a8F78D4e0e;
    address constant FEE_ESCROW = 0x7559689765aE86cBB38e68CD1294830CccB125F2;
    address constant HOOK = 0x636c050296B5Cc528D8785169Bf8923716FCa9cc;
    address constant MEV = 0xb038D597365FfD108D63C265Bb0621444a1D8B83;
    address constant PC_CONTROLLER = 0xd8C63401268744d430EbE0C18412211421498013;
    address constant LOCKER = 0x866ea3Dc2bf7A3e77374619cf50EB697FA766aab;
    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    // ── Owner / deployer of the live 2a + factory ─────────────────────────
    address constant OWNER = 0xCB43078C32423F5348Cab5885911C3B5faE217F9;

    // ── A few live 2a addresses we assert against ─────────────────────────
    address constant PATRON = 0xC8ED01ffd957f5a62b1526d58E309c8bf2BB4A4c;
    address constant LIVE_BID_ADAPTER = 0x8C72FBc2bB32e76aa54243F76745266a0F92CD01;
    address constant BUYBACK_BURNER = 0xf8a2D6F8c58626eE3BcDb4638F2a2f30Fe021242;
    address constant TOKEN_ADMIN_POKER = 0xA96a11257890ED1C43C16c098E286e18e45E6258;
    address constant VAULT_BURN_POOL = 0xf5c3eC7e185d0a592264791D523496EA6e368753;

    uint24 constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 constant TICK_SPACING = 200;

    // Fork at/after the block where the LAST 2a contract was mined (the
    // `runContracts` broadcast spanned blocks 25270164..25270213). Override
    // with FORK_BLOCK.
    uint256 constant DEPLOY_BLOCK = 25_270_213;

    Live2aLaunchHarness harness;
    address tokenAddr;
    TestSwapHelper swapper;

    function setUp() public {
        string memory url =
            vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        uint256 forkBlock = vm.envOr("FORK_BLOCK", DEPLOY_BLOCK);
        vm.createSelectFork(url, forkBlock);

        require(PATRON.code.length > 0, "fork is before the Phase-2a deploy (set a later FORK_BLOCK)");
        require(FACTORY.code.length > 0, "Phase-1 factory missing on fork");

        // Env the unchanged `_launchTokenAndWire` reads (the live Phase-1 stack).
        vm.setEnv("ARTCOINS_FACTORY", vm.toString(FACTORY));
        vm.setEnv("ARTCOINS_FEE_ESCROW", vm.toString(FEE_ESCROW));
        vm.setEnv("ARTCOINS_HOOK_SKIM", vm.toString(HOOK));
        vm.setEnv("ARTCOINS_MEV_SKIM", vm.toString(MEV));
        vm.setEnv("PC_CONTROLLER", vm.toString(PC_CONTROLLER));
        vm.setEnv("CONVERSION_LOCKER", vm.toString(LOCKER));

        // 2a addresses come from the committed snapshot; copy to a writable
        // rehearsal path so `_writeDeployments` doesn't touch the snapshot.
        string memory snap =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments.mainnet.json"));
        string memory path = string.concat(vm.projectRoot(), "/deployments.rehearsal.json");
        vm.writeFile(path, snap);
        vm.setEnv("DEPLOYMENTS_PATH", path);

        harness = new Live2aLaunchHarness();
        tokenAddr = harness.launchTokenAsOwner(OWNER);

        // Past the ~30-min MEV anti-sniper window so the skim sits at the 6%
        // baseline for clean trading numbers.
        vm.warp(block.timestamp + 31 minutes);
        swapper = new TestSwapHelper(POOL_MANAGER, tokenAddr, HOOK, DYNAMIC_FEE_FLAG, TICK_SPACING);
        vm.deal(address(this), 100 ether);
    }

    receive() external payable {}

    function _liveBid() internal view returns (uint256) {
        return LIVE_BID_ADAPTER.balance + IPatronBid(PATRON).bidBalance();
    }

    // ── Deploy + wiring ───────────────────────────────────────────────────

    function test_live2a_tokenLaunched() public view {
        assertTrue(tokenAddr != address(0), "token deployed");
        assertGt(tokenAddr.code.length, 0, "token has code");
        console2.log("token", tokenAddr);
        console2.log("token totalSupply", IERC20T(tokenAddr).totalSupply());
    }

    function test_live2a_phase2bWiringFilled() public view {
        assertEq(IHasTokenHook(BUYBACK_BURNER).token(), tokenAddr, "burner.token");
        assertEq(IHasTokenHook(BUYBACK_BURNER).hook(), HOOK, "burner.hook (Phase-1)");
        assertEq(IHasToken(TOKEN_ADMIN_POKER).token(), tokenAddr, "tokenAdminPoker.token");
        assertEq(IHasToken(VAULT_BURN_POOL).token(), tokenAddr, "vaultBurnPool.token");
    }

    function test_live2a_verifyDeployPasses() public {
        new VerifyDeploy().run();
    }

    // ── Trading ───────────────────────────────────────────────────────────

    /// @notice A canonical buy: trading works, the 6% skim grows the live bid,
    ///         and the canonical buy is EXEMPT from the venue tax (the hook
    ///         attests the canonical budget), so no 111 burns to VaultBurnPool.
    function test_live2a_canonicalBuy_growsLiveBid_exempt() public {
        uint256 bidBefore = _liveBid();
        uint256 sinkBefore = IERC20T(tokenAddr).balanceOf(VAULT_BURN_POOL);

        uint256 out = swapper.buyTokenWithEth{value: 10 ether}(10 ether);

        assertGt(out, 0, "received 111 from the canonical buy");
        assertEq(IERC20T(tokenAddr).balanceOf(address(this)), out, "buyer holds full output (canonical exempt)");
        uint256 bidGrew = _liveBid() - bidBefore;
        assertGt(bidGrew, 0, "the 6% skim grew the live bid");
        assertEq(
            IERC20T(tokenAddr).balanceOf(VAULT_BURN_POOL),
            sinkBefore,
            "canonical buy charged NO venue tax"
        );

        console2.log("buy: ETH in", uint256(10 ether));
        console2.log("buy: 111 out", out);
        console2.log("buy: live bid grew by (wei)", bidGrew);
    }

    /// @notice A sell works (111 -> ETH); selling is from a non-venue holder, so
    ///         it is not venue-taxed.
    function test_live2a_canonicalSell() public {
        uint256 bought = swapper.buyTokenWithEth{value: 5 ether}(5 ether);
        IERC20T(tokenAddr).approve(address(swapper), bought);
        uint256 ethOut = swapper.sellTokenForEth(bought);
        assertGt(ethOut, 0, "received ETH from the sell");
        console2.log("sell: 111 in", bought);
        console2.log("sell: ETH out (wei)", ethOut);
    }

    // ── Side-pool / venue transfer tax ────────────────────────────────────

    /// @notice The venue-scoped buy-side tax: a transfer FROM a venue (the V4
    ///         PoolManager singleton) to a non-exempt recipient is taxed, and the
    ///         tax accrues to VaultBurnPool (the token's tax burnAddress). This is
    ///         the exact code path a side-pool buy hits; the full side-pool
    ///         routing is covered by TaxedTokenForkTest.
    function test_live2a_sidePoolVenueTax() public {
        address sideBuyer = makeAddr("sidePoolBuyer");
        uint256 amount = 1_000e18;

        uint256 sinkBefore = IERC20T(tokenAddr).balanceOf(VAULT_BURN_POOL);

        // PoolManager is a tax venue and holds the pool's 111 reserves; a direct
        // venue -> non-exempt outflow (no canonical budget this tx) is taxed.
        vm.prank(POOL_MANAGER);
        IERC20T(tokenAddr).transfer(sideBuyer, amount);

        uint256 received = IERC20T(tokenAddr).balanceOf(sideBuyer);
        uint256 taxed = amount - received;
        uint256 sinkAfter = IERC20T(tokenAddr).balanceOf(VAULT_BURN_POOL);

        assertGt(taxed, 0, "venue -> non-exempt transfer is taxed");
        assertEq(sinkAfter - sinkBefore, taxed, "tax accrued to VaultBurnPool (the tax burnAddress)");

        console2.log("sidepool tax: transfer amount", amount);
        console2.log("sidepool tax: recipient got", received);
        console2.log("sidepool tax: taxed to VaultBurnPool", taxed);
        console2.log("sidepool tax: observed bps", (taxed * 10_000) / amount);
    }
}
