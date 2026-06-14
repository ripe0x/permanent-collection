// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {BuybackBurner} from "../../src/BuybackBurner.sol";
import {ForkFixtures} from "../helpers/ForkFixtures.sol";

/// @notice Property-based fuzzing of BuybackBurner's accounting invariants.
///         Equivalent to the kind of test Echidna would run, but
///         implemented against Foundry's invariant runner so it shares the
///         existing fork fixture (V4 PoolManager + artcoins factory + real
///         pool state) without needing a V4 mock.
///
///         The headline invariant — `address(burner).balance ==
///         burner.remainingEth()` — is the one the v2 redesign's partial-
///         fill reconciliation has to hold across every execution path:
///         full fills, partial fills, accepted/rejected reward sends, and
///         arbitrary inflows via `receive()`.

/// @dev Wrapper interface — the handler dispatches `executeStep` through one
///      of these so msg.sender is observably different (EOA-like vs rejecter).
interface ICaller {
    function fire(BuybackBurner b, uint256 minOut) external;
}

/// @dev Accepts ETH on receive — represents a healthy keeper.
contract EoaLikeReceiver is ICaller {
    function fire(BuybackBurner b, uint256 minOut) external override {
        b.executeStep(minOut);
    }
    receive() external payable {}
}

/// @dev Reverts on receive — exercises BuybackBurner's failed-reward path
///      (the post-call `remainingEth += actualReward` re-credit).
contract RejecterReceiver is ICaller {
    function fire(BuybackBurner b, uint256 minOut) external override {
        b.executeStep(minOut);
    }
    receive() external payable {
        revert("RejecterReceiver: no eth");
    }
}

contract BuybackBurnerHandler is CommonBase, StdCheats, StdUtils {
    BuybackBurner public immutable burner;
    address[] public callers;

    uint256 public callsExecuteStep;
    uint256 public callsDeposit;

    constructor(BuybackBurner _burner) {
        burner = _burner;
        callers.push(address(new EoaLikeReceiver()));
        callers.push(address(new RejecterReceiver()));
        callers.push(address(new EoaLikeReceiver()));
    }

    /// @notice Top up the burner from an arbitrary handler-controlled source.
    function deposit(uint96 amount) external {
        amount = uint96(bound(uint256(amount), 0, 5 ether));
        if (amount == 0) return;
        vm.deal(address(this), uint256(amount));
        (bool ok,) = address(burner).call{value: uint256(amount)}("");
        require(ok, "handler: receive failed");
        callsDeposit++;
    }

    /// @notice Step the burner from one of the seeded caller addresses.
    function execStep(uint8 callerSeed, uint96 minOutSeed) external {
        if (burner.remainingEth() == 0) return;
        vm.roll(burner.nextExecutableBlock());

        address caller = callers[uint256(callerSeed) % callers.length];
        uint256 minOut = uint256(minOutSeed);
        if (callerSeed % 4 == 0) minOut = 0;

        try ICaller(caller).fire(burner, minOut) {
            callsExecuteStep++;
        } catch {
            // executeStep can revert for many legit reasons: too-early,
            // nothing-to-burn, minOut < floor, pool returned < minOut.
            // Ignore — the invariant is about state CONSISTENCY, not about
            // every call succeeding.
        }
    }
}

contract BuybackBurnerInvariantsTest is StdInvariant, ForkFixtures {
    BuybackBurnerHandler internal handler;

    uint256 internal _lastTotalEthBurned;
    uint256 internal _lastTotalTokensBurned;
    uint256 internal _lastStepBlockObserved;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        _launchPool();
        adminContract.transferAdmin(address(this));

        handler = new BuybackBurnerHandler(burner);

        // Pre-fund the burner so the first few execStep calls have
        // something to bite into.
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(burner).call{value: 10 ether}("");
        require(ok, "setup: receive failed");

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.execStep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ──────────────── Invariants ────────────────

    /// @notice Conservation: contract balance equals the `remainingEth`
    ///         ledger after every state-changing operation. This is THE
    ///         property the v2 partial-fill reconciliation must maintain.
    function invariant_BalanceMatchesRemainingEth() public view {
        assertEq(
            address(burner).balance,
            burner.remainingEth(),
            "balance != remainingEth (accounting drift)"
        );
    }

    /// @notice `totalEthBurned` monotonically non-decreasing.
    function invariant_TotalEthBurnedMonotonic() public {
        uint256 cur = burner.totalEthBurned();
        assertGe(cur, _lastTotalEthBurned, "totalEthBurned regressed");
        _lastTotalEthBurned = cur;
    }

    /// @notice `totalTokensBurned` monotonically non-decreasing.
    function invariant_TotalTokensBurnedMonotonic() public {
        uint256 cur = burner.totalTokensBurned();
        assertGe(cur, _lastTotalTokensBurned, "totalTokensBurned regressed");
        _lastTotalTokensBurned = cur;
    }

    /// @notice `lastStepBlock` monotonically non-decreasing.
    function invariant_LastStepBlockMonotonic() public {
        uint256 cur = burner.lastStepBlock();
        assertGe(cur, _lastStepBlockObserved, "lastStepBlock regressed");
        _lastStepBlockObserved = cur;
    }
}
