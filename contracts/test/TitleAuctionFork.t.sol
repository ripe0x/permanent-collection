// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SkimForkFixture} from "./helpers/SkimForkFixture.sol";
import {PunkVaultTitleAuction} from "../src/PunkVaultTitleAuction.sol";
import {PunkVault} from "../src/PunkVault.sol";

/// @title  TitleAuctionForkTest
/// @notice End-to-end fork-level verification of the vault Title Auction
///         against the live-deployed `Deploy.s.sol` bytecode on a mainnet
///         fork. Exercises both terminal paths:
///
///           - cleared:   kickoff → bid → outbid → settle → proceeds-pull
///           - restart:   kickoff → no-bid → settle (extends) → bid → settle
///
///         Cross-checked invariants:
///           - Kickoff gate (22 traits): reverts below threshold, succeeds at
///             the threshold, is one-shot.
///           - Bid validation: rejects below 5% minimum increase; accepts
///             at exactly the minimum.
///           - Cleared settle: 100% of proceeds queued to payoutRecipient
///             (audit F10), title ERC721 transferred to winner.
///           - No-bid settle: `settled` STAYS false (audit F11), `endsAt`
///             jumps by AUCTION_DURATION, the title stays in the auction.
///
/// @dev    The collectedMask gate is satisfied via storage manipulation
///         (`vm.store`) — driving 22 acquisitions through the full Patron
///         flow would balloon the test runtime without adding coverage of
///         the auction itself. Same approach as `PunkVaultTitleAuctionTest`'s
///         `_setCollectedMask`. Probes storage by sentinel-writing each of
///         the first 32 slots so layout shifts surface as a clear revert
///         rather than silent skew.
contract TitleAuctionForkTest is SkimForkFixture {
    PunkVaultTitleAuction internal titleAuction;
    address internal alice;
    address internal bob;
    address internal carol;

    function setUp() public {
        string memory url =
            vm.envOr("MAINNET_RPC_URL", string("https://gateway.tenderly.co/public/mainnet"));
        vm.createSelectFork(url);

        _runFullDeploy();

        // Read the title auction address from the deployments.json that
        // DeployScript wrote. Not surfaced as a SkimForkFixture state-var
        // (that fixture predates the Proofs+Title surface) so we load it
        // here.
        string memory path = string.concat(vm.projectRoot(), "/deployments.json");
        string memory json = vm.readFile(path);
        titleAuction = PunkVaultTitleAuction(vm.parseJsonAddress(json, ".titleAuction"));

        alice = makeAddr("title-alice");
        bob = makeAddr("title-bob");
        carol = makeAddr("title-carol");
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ────────── helpers ──────────

    /// @dev Force the protocol past the kickoff threshold (22 traits) by
    ///      writing a mask with the lowest 22 bits set.
    ///      `collectedCount >= KICKOFF_THRESHOLD` then holds.
    function _enableKickoff() internal {
        uint256 mask = (uint256(1) << 22) - 1;
        uint256 slot = _findCollectedMaskSlot();
        vm.store(address(pc), bytes32(slot), bytes32(mask));
        require(pc.collectedMask() == mask, "fork-fixture: collectedMask slot wrong");
        require(pc.collectedCount() >= 22, "fork-fixture: threshold not met");
    }

    function _findCollectedMaskSlot() internal returns (uint256) {
        uint256 sentinel = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        for (uint256 i = 0; i < 32; i++) {
            bytes32 original = vm.load(address(pc), bytes32(i));
            vm.store(address(pc), bytes32(i), bytes32(sentinel));
            if (pc.collectedMask() == sentinel) {
                vm.store(address(pc), bytes32(i), original);
                return i;
            }
            vm.store(address(pc), bytes32(i), original);
        }
        revert("fork-fixture: collectedMask slot not found");
    }

    function _kickoff() internal {
        _enableKickoff();
        titleAuction.kickoff();
    }

    // ────────── (1) kickoff gate ──────────

    function test_fork_kickoff_belowThreshold_reverts() public {
        // 21 bits set = 21 traits collected — one short of the 22-trait threshold.
        uint256 belowThreshold = (uint256(1) << 21) - 1;
        uint256 slot = _findCollectedMaskSlot();
        vm.store(address(pc), bytes32(slot), bytes32(belowThreshold));
        require(pc.collectedCount() == 21, "fixture: expected 21");

        vm.expectRevert(PunkVaultTitleAuction.ThresholdNotReached.selector);
        titleAuction.kickoff();
    }

    function test_fork_kickoff_atThreshold_mintsAndStarts() public {
        _enableKickoff();
        uint64 expectedEnd = uint64(block.timestamp) + titleAuction.AUCTION_DURATION();
        titleAuction.kickoff();
        assertTrue(titleAuction.kickedOff(), "kickedOff flag set");
        assertEq(titleAuction.endsAt(), expectedEnd, "endsAt is +24h");
        assertEq(vault.titleOwner(), address(titleAuction), "title minted to auction");
        assertTrue(titleAuction.isLive(), "auction is live");
    }

    function test_fork_kickoff_isOneShot() public {
        _kickoff();
        vm.expectRevert(PunkVaultTitleAuction.AlreadyKickedOff.selector);
        titleAuction.kickoff();
    }

    /// @notice The Title is minted into the auction escrow at deploy, so it
    ///         exists from launch — but the AUCTION stays closed (no kickoff,
    ///         no bids) until the 22-trait threshold is met. Decoupling the
    ///         mint from kickoff is the whole point.
    function test_fork_title_mintedAtDeploy_butAuctionGated() public {
        // Fresh deploy: nothing collected yet (< KICKOFF_THRESHOLD).
        assertLt(pc.collectedCount(), 22, "fixture: below threshold");

        // Title exists and is escrowed in the auction from launch.
        assertTrue(titleAuction.titleMinted(), "title minted at deploy");
        assertTrue(vault.titleMinted(), "vault.titleMinted");
        assertEq(vault.titleOwner(), address(titleAuction), "title escrowed in auction");
        // tokenURI(111) resolves rather than reverting TitleNotMinted.
        assertGt(bytes(vault.tokenURI(111)).length, 0, "title tokenURI resolves");

        // Auction is NOT open.
        assertFalse(titleAuction.kickedOff(), "not kicked off");
        assertFalse(titleAuction.isLive(), "not live");

        // No bids before kickoff.
        vm.deal(address(this), 1 ether);
        vm.expectRevert(PunkVaultTitleAuction.AuctionNotLive.selector);
        titleAuction.bid{value: 1 ether}();

        // kickoff still gated on the threshold.
        vm.expectRevert(PunkVaultTitleAuction.ThresholdNotReached.selector);
        titleAuction.kickoff();

        // mintTitle is idempotent — a second call is a harmless no-op.
        titleAuction.mintTitle();
        assertEq(vault.titleOwner(), address(titleAuction), "still escrowed after no-op mint");
    }

    // ────────── (2) bid validation ──────────

    function test_fork_bid_belowMinimumIncrease_reverts() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        // Min increase = 5%, so 1.04 ETH rejects.
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                PunkVaultTitleAuction.BidBelowMinimumIncrease.selector,
                1.04 ether,
                1.05 ether
            )
        );
        titleAuction.bid{value: 1.04 ether}();
    }

    function test_fork_bid_atMinimumIncrease_succeeds() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        vm.prank(bob);
        titleAuction.bid{value: 1.05 ether}();
        assertEq(titleAuction.highBidder(), bob, "bob now leading");
        assertEq(titleAuction.highBidWei(), 1.05 ether, "high bid bumped");
    }

    // ────────── (3) cleared settle E2E ──────────

    function test_fork_clearedSettle_transfersTitleAndQueuesProceeds() public {
        _kickoff();

        vm.prank(alice);
        titleAuction.bid{value: 2 ether}();
        vm.prank(bob);
        titleAuction.bid{value: 4 ether}();

        // Snapshot the immutable payout recipient + Patron balance before
        // settle — proceeds should be CREDITED to the pull queue, not
        // pushed. Audit F10.
        address payoutRecipient = titleAuction.payoutRecipient();
        uint256 payoutBalBefore = payoutRecipient.balance;

        vm.warp(block.timestamp + 25 hours);
        titleAuction.settle();

        // Title transferred immediately.
        assertEq(vault.titleOwner(), bob, "title now belongs to bob");
        assertTrue(titleAuction.settled(), "settled flipped");

        // Proceeds CREDITED but not pushed (audit F10). 100% routes to
        // payoutRecipient; the title auction has no other proceeds split.
        assertEq(
            payoutRecipient.balance - payoutBalBefore,
            0,
            "payout recipient balance unchanged"
        );
        assertEq(
            titleAuction.pendingProceeds(payoutRecipient),
            4 ether,
            "payout credited 100% (4 ETH)"
        );

        // An uncredited address has nothing to pull.
        vm.expectRevert(PunkVaultTitleAuction.NothingToWithdraw.selector);
        titleAuction.withdrawProceeds(carol);

        // Payout recipient pulls.
        titleAuction.withdrawProceeds(payoutRecipient);
        assertEq(
            payoutRecipient.balance - payoutBalBefore,
            4 ether,
            "payout recipient pulled 4 ETH"
        );
        assertEq(
            titleAuction.pendingProceeds(payoutRecipient),
            0,
            "payout credit zeroed"
        );
    }

    // ────────── (4) no-bid restart ──────────

    /// @notice Audit F11 regression: a no-bid settle MUST NOT strand the
    ///         title. The auction restarts in place, `settled` stays false,
    ///         and a fresh round of bidding opens.
    function test_fork_noBidSettle_restartsAuction() public {
        _kickoff();
        uint64 firstEndsAt = titleAuction.endsAt();

        vm.warp(block.timestamp + 25 hours);
        titleAuction.settle();

        // Title NOT stranded — still in the auction, ready for round 2.
        assertFalse(titleAuction.settled(), "no-bid keeps settled=false");
        assertEq(vault.titleOwner(), address(titleAuction), "title still held");
        // endsAt rolled forward by AUCTION_DURATION from the current time.
        assertEq(
            titleAuction.endsAt(),
            uint64(block.timestamp) + titleAuction.AUCTION_DURATION(),
            "endsAt extended"
        );
        assertGt(titleAuction.endsAt(), firstEndsAt, "endsAt strictly later");
        assertTrue(titleAuction.isLive(), "auction live again");

        // And bidding in the restarted window goes through and clears.
        vm.prank(alice);
        titleAuction.bid{value: 1.5 ether}();
        assertEq(titleAuction.highBidder(), alice, "alice now leading round 2");

        // Settle the second round to verify it can actually conclude.
        // Read endsAt fresh and warp to AFTER it, rather than computing from
        // `block.timestamp + N hours`. Foundry's via_ir hoists block.timestamp
        // across multiple vm.warp calls in the same function, leaving the
        // second warp at the same time as the first — this mirrors the
        // documented workaround in `test_AntiSnipe_Uncapped`.
        uint64 round2EndsAt = titleAuction.endsAt();
        vm.warp(uint256(round2EndsAt) + 1);
        titleAuction.settle();
        assertEq(vault.titleOwner(), alice, "title transferred on round 2 settle");
        assertTrue(titleAuction.settled(), "settled=true on the cleared round");
    }

    // ────────── (5) anti-snipe extension ──────────

    function test_fork_antiSnipe_extendsEndsAt() public {
        _kickoff();
        uint64 initialEnd = titleAuction.endsAt();
        vm.warp(initialEnd - 5 minutes); // within trigger window
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        assertEq(titleAuction.endsAt(), block.timestamp + 1 hours);
        assertGt(titleAuction.endsAt(), initialEnd);
    }

    // ────────── (6) post-settle, no Punks access ──────────

    function test_fork_winner_cannotPullPunksFromVault() public {
        _kickoff();
        vm.prank(alice);
        titleAuction.bid{value: 1 ether}();
        vm.warp(block.timestamp + 25 hours);
        titleAuction.settle();

        // Alice holds the Title — but the Title confers no Punk-extraction
        // power. PunkVault rejects any non-ReturnAuction receiver.
        vm.prank(alice);
        vm.expectRevert(PunkVault.NotReturnAuction.selector);
        vault.receivePunk(0);
    }
}
