// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {PermanentCollection} from "../src/PermanentCollection.sol";
import {Patron} from "../src/Patron.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {PunkVault} from "../src/PunkVault.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ICryptoPunksMarket} from "../src/interfaces/ICryptoPunksMarket.sol";
import {IPunksData} from "../src/interfaces/IPunksData.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Handler that exposes bounded random actions on the protocol so
///         Foundry's invariant runner can drive arbitrary sequences against
///         the fork. All actions are wrapped in `try` blocks and `fail_on_revert
///         = false` (configured in foundry.toml) so an inapplicable action
///         just no-ops the call without failing the run.
///
///         Maintains ghost variables for monotonic invariants:
///           - `peakCollectedMask`: tightest lower bound on `collectedMask`
///             ever observed at the end of an action.
///           - `peakAcquisitionCount`: tightest lower bound on the
///             acquisitions log length.
///           - `pastCustody[punkId]`: best-known max custody seen, so we can
///             check that no Punk regresses (Vaulted → InReturnAuction, etc.).
contract InvariantHandler is Test {
    Patron public patron;
    ReturnAuctionModule public fs;
    PermanentCollection public coll;
    PunkVault public vault;
    IPunksData public punksData;
    ICryptoPunksMarket public market;
    // The single faucet into the live bid. The handler funds the bid by
    // pranking this address into `Patron.receive()` (the production path that
    // credits `accountedLiveBidWei`), and models forced ETH separately via
    // `forceEth` (a raw `vm.deal` that bypasses `receive()`).
    address public liveBidAdapter;

    uint16[] public punks;

    // Ghost vars.
    uint256 public peakCollectedMask;
    uint256 public peakAcquisitionCount;
    mapping(uint16 => uint8) public peakCustody;
    // Once a Punk has been observed Vaulted it must stay Vaulted forever:
    // Vaulted is the only terminal custody state. Re-auction can revisit
    // ReturnedToMarket → InReturnAuction, so custody is no longer globally
    // monotonic — terminality of Vaulted is the property we assert instead.
    mapping(uint16 => bool) public everVaulted;

    // Bookkeeping for the test harness — counts how many times each path fired
    // (helps detect a totally-stalled handler that's never doing work).
    uint256 public callsTopup;
    uint256 public callsForceEth;
    uint256 public callsSkim;
    uint256 public callsAccept;
    uint256 public callsBid;
    uint256 public callsSettle;
    // Split the settle counter by outcome so a -vvv run reveals whether the
    // fuzzer actually exercised each settlement branch. The cleared branch
    // runs the provenance round-trip (ReturnAuctionEscrow); the vaulted branch
    // does not. `invariant_SettleActuallyExercised` guards against a
    // regression where settle silently reverts on every call (which would
    // otherwise let the whole suite pass vacuously, never reaching a
    // post-settle state).
    uint256 public callsSettleCleared;
    uint256 public callsSettleVaulted;
    // Counts every time `trySettle` actually reaches `fs.settle` on a
    // settleable sale (past the custody/deadline guards). Compared against
    // `callsSettle` (successes) in `afterInvariant` to fail loud if settle
    // started reverting unconditionally.
    uint256 public settleAttempts;

    receive() external payable {}

    constructor(
        address _patron,
        address payable _fs,
        address _coll,
        address _vault,
        address _punksData,
        address _market,
        address _liveBidAdapter
    ) {
        patron = Patron(payable(_patron));
        fs = ReturnAuctionModule(_fs);
        coll = PermanentCollection(_coll);
        vault = PunkVault(_vault);
        punksData = IPunksData(_punksData);
        market = ICryptoPunksMarket(_market);
        liveBidAdapter = _liveBidAdapter;

        // Pre-pick a small set of owned Punks to operate on. Keep it small
        // (10) so the invariant runner can actually make state progress
        // within `depth=20` calls.
        uint256 picked = 0;
        for (uint16 i = 1; picked < 10 && i < 10_000; i++) {
            address o = market.punkIndexToAddress(i);
            if (o != address(0)) {
                punks.push(i);
                picked++;
            }
        }
    }

    function _refreshGhost() internal {
        uint256 m = coll.collectedMask();
        if (m > peakCollectedMask) peakCollectedMask = m;
        uint256 n = coll.acquisitionCount();
        if (n > peakAcquisitionCount) peakAcquisitionCount = n;
        for (uint256 i = 0; i < punks.length; i++) {
            uint16 p = punks[i];
            uint8 c = uint8(coll.custodyOf(p));
            if (c > peakCustody[p]) peakCustody[p] = c;
            if (coll.custodyOf(p) == IPermanentCollection.Custody.Vaulted) everVaulted[p] = true;
        }
    }

    function topUp(uint96 amt) external {
        amt = uint96(bound(amt, 0, 5 ether));
        // Fund the bid the production way: through the adapter, so
        // `Patron.receive()` credits `accountedLiveBidWei`. A raw `vm.deal` to
        // Patron would raise the real balance only (that is the forced-ETH
        // path, modeled by `forceEth` below) and would NOT move the bid.
        vm.deal(liveBidAdapter, liveBidAdapter.balance + amt);
        vm.prank(liveBidAdapter);
        (bool ok,) = address(patron).call{value: amt}("");
        if (ok) callsTopup++;
        _refreshGhost();
    }

    /// @notice Model forced ETH (selfdestruct / coinbase): raises Patron's raw
    ///         balance WITHOUT crediting the accounted bid. Drives the fuzzer
    ///         into surplus (`balance > accounted`) states so the
    ///         `accounted <= balance` and skim invariants are exercised against
    ///         real drift, not just the clean path.
    function forceEth(uint96 amt) external {
        amt = uint96(bound(amt, 1, 2 ether));
        vm.deal(address(patron), address(patron).balance + amt);
        callsForceEth++;
        _refreshGhost();
    }

    /// @notice Permissionlessly recover any forced-ETH surplus back to the
    ///         adapter. After a successful skim Patron holds no surplus
    ///         (balance == accounted), proving forced ETH is never stuck.
    function trySkimSurplus() external {
        try patron.skimSurplus() returns (uint256 amount) {
            if (amount > 0) callsSkim++;
        } catch {}
        _refreshGhost();
    }

    function tryAcceptBounty(uint8 idx) external {
        if (punks.length == 0) return;
        idx = uint8(bound(idx, 0, uint8(punks.length - 1)));
        uint16 p = punks[idx];
        // Re-auction aware: a never-acquired (None) or rescued
        // (ReturnedToMarket) Punk is eligible; InReturnAuction (live) and
        // Vaulted (terminal) are not. This lets the fuzzer drive
        // acquire → rescue → re-acquire cycles. See docs/RE_AUCTION_REDESIGN.md.
        IPermanentCollection.Custody cc = coll.custodyOf(p);
        if (
            cc == IPermanentCollection.Custody.InReturnAuction
                || cc == IPermanentCollection.Custody.Vaulted
        ) return;

        uint256 mask = punksData.traitMaskOf(p);
        uint256 collected = coll.collectedMask();
        uint256 newBits = mask & ~collected;
        if (newBits == 0) return;

        // Pick the first uncollected, non-pending bit.
        uint8 target = 255;
        for (uint8 i = 0; i < 111; i++) {
            if ((newBits >> i) & 1 == 1 && coll.pendingTraitCount(i) == 0) {
                target = i;
                break;
            }
        }
        if (target == 255) return;

        address owner = market.punkIndexToAddress(p);
        if (owner == address(0)) return;
        uint256 listed = patron.bidBalance();
        vm.prank(owner);
        market.offerPunkForSaleToAddress(p, listed, address(patron));

        vm.prank(owner);
        try patron.acceptBid(p, target, type(uint256).max) {
            callsAccept++;
        } catch {}
        _refreshGhost();
    }

    function tryBid(uint8 idx, uint96 over) external {
        if (punks.length == 0) return;
        idx = uint8(bound(idx, 0, uint8(punks.length - 1)));
        uint16 p = punks[idx];
        if (coll.custodyOf(p) != IPermanentCollection.Custody.InReturnAuction) return;
        if (fs.endsAt(p) <= block.timestamp) return;

        uint256 reserve = fs.reserveOf(p);
        uint256 currentHigh = fs.highBidOf(p);
        uint256 floor_ = reserve > currentHigh ? reserve : currentHigh + 1;
        over = uint96(bound(over, 0, 3 ether));
        uint256 bidAmt = floor_ + over;
        vm.deal(address(this), bidAmt);
        try fs.placeBidWithReferral{value: bidAmt}(p, address(0), bytes32(0)) {
            callsBid++;
        } catch {}
        _refreshGhost();
    }

    function trySettle(uint8 idx, uint16 secondsPast) external {
        if (punks.length == 0) return;
        idx = uint8(bound(idx, 0, uint8(punks.length - 1)));
        uint16 p = punks[idx];
        if (coll.custodyOf(p) != IPermanentCollection.Custody.InReturnAuction) return;

        uint64 ends = fs.endsAt(p);
        if (ends == 0) return;
        vm.warp(uint256(ends) + 1 + (uint256(secondsPast) % 1_000));
        settleAttempts++;
        try fs.settle(p) {
            callsSettle++;
            // Bucket by the terminal custody the settle just wrote, so the
            // diagnostic counters distinguish the cleared (round-trip) path
            // from the vaulted path.
            IPermanentCollection.Custody c = coll.custodyOf(p);
            if (c == IPermanentCollection.Custody.ReturnedToMarket) {
                callsSettleCleared++;
            } else if (c == IPermanentCollection.Custody.Vaulted) {
                callsSettleVaulted++;
            }
        } catch {}
        _refreshGhost();
    }

    function punksLength() external view returns (uint256) {
        return punks.length;
    }
}

/// @notice Foundry invariant suite for the four hard invariants called out
///         in CLAUDE.md:
///           1. `collectedMask` monotonically non-decreasing.
///           2. `Acquisition[]` log only grows.
///           3. `address(patron).balance >= bidBalance()` — the accounted bid
///              never exceeds the real balance (force-sent ETH only ever creates
///              skimmable surplus, never a payout deficit).
///           4. `Vaulted` is the only terminal custody state — a rescued Punk
///              may re-enter the auction, but a Vaulted Punk stays Vaulted.
///
///         Conservative runs/depth in foundry.toml (`runs=16, depth=20`)
///         keep the suite tractable on public RPC. Increase for a pre-mainnet
///         rigor pass.
contract InvariantsTest is ForkFixtures {
    InvariantHandler internal handler;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));

        handler = new InvariantHandler(
            address(patron),
            payable(address(finalSale)),
            address(collection),
            address(vault),
            PUNKS_DATA,
            PUNKS_MARKET,
            address(liveBidAdapter)
        );
        // Pre-seed the bid through the adapter so `accountedLiveBidWei` is
        // funded (a raw `vm.deal` would create forced-ETH surplus, not bid).
        _fundPatronFromAdapter(5 ether);

        targetContract(address(handler));
    }

    /// @notice The accounted live bid can NEVER exceed Patron's real balance.
    ///         This is the core anti-overcount guard: `acceptBid` /
    ///         `acceptListing` pay out `accountedLiveBidWei`, so if it ever
    ///         exceeded the real balance a payout would fail and brick the bid.
    ///         `receive()` raises both together; the two outflows subtract the
    ///         same amount from both; `skimSurplus` only removes the surplus.
    ///         So `accounted <= balance` must hold across every sequence —
    ///         including forced-ETH donations (`forceEth`, which raise the real
    ///         balance alone) and surplus recovery (`trySkimSurplus`).
    function invariant_AccountedNeverExceedsBalance() public view {
        assertLe(
            patron.bidBalance(), address(patron).balance, "accounted bid exceeds real balance"
        );
    }

    /// @notice `collectedMask` bits never unset. Tracked by ghost var in the
    ///         handler.
    function invariant_CollectedMaskMonotonic() public view {
        // Current must be >= every value observed during the run.
        assertGe(
            collection.collectedMask(),
            handler.peakCollectedMask(),
            "collectedMask regressed"
        );
    }

    /// @notice Acquisitions log only grows. Records can't be removed.
    function invariant_AcquisitionsAppendOnly() public view {
        assertGe(
            collection.acquisitionCount(),
            handler.peakAcquisitionCount(),
            "acquisitionCount regressed"
        );
    }

    /// @notice `Vaulted` is the ONLY terminal custody state. A rescued
    ///         (ReturnedToMarket) Punk may re-enter the auction
    ///         (ReturnedToMarket → InReturnAuction), so custody is no longer
    ///         globally monotonic — but once a Punk is Vaulted it must stay
    ///         Vaulted forever (no withdrawal path from PunkVault). See
    ///         docs/RE_AUCTION_REDESIGN.md.
    function invariant_VaultedIsTerminal() public view {
        uint256 n = handler.punksLength();
        for (uint256 i = 0; i < n; i++) {
            uint16 p = handler.punks(i);
            if (handler.everVaulted(p)) {
                assertEq(
                    uint8(collection.custodyOf(p)),
                    uint8(IPermanentCollection.Custody.Vaulted),
                    "Vaulted custody regressed (must be terminal)"
                );
            }
        }
    }

    /// @notice The Punk vault is terminal — every Punk recorded as Vaulted
    ///         in PermanentCollection must currently be locked in PunkVault
    ///         AND owned by the vault in the CryptoPunks market.
    function invariant_VaultedPunksLockedAndOwned() public view {
        uint256 n = handler.punksLength();
        for (uint256 i = 0; i < n; i++) {
            uint16 p = handler.punks(i);
            if (collection.custodyOf(p) == IPermanentCollection.Custody.Vaulted) {
                assertTrue(vault.isLocked(p), "vaulted Punk not locked");
                assertEq(
                    punksMarket.punkIndexToAddress(uint256(p)),
                    address(vault),
                    "vaulted Punk not owned by vault"
                );
            }
        }
    }

    /// @notice `pendingTraitCount[t]` must equal the number of acquisitions
    ///         in custody `InReturnAuction` whose `pendingMaskAtAcquisition` has
    ///         bit `t` set. This is the most subtle of the invariants — it's
    ///         the property that prevents two parallel Final Sales from both
    ///         claiming the same trait pre-vault.
    /// @dev    O(acquisitions × 111) — bounded by the 10-punk handler set,
    ///         so worst case ~1100 reads per invariant call.
    function invariant_PendingCountConsistent() public view {
        uint256 n = collection.acquisitionCount();
        for (uint8 t = 0; t < 111; t++) {
            uint256 expected = 0;
            for (uint256 i = 0; i < n; i++) {
                PermanentCollection.Acquisition memory a = collection.getAcquisition(i);
                if (a.custody == IPermanentCollection.Custody.InReturnAuction) {
                    if ((a.pendingMaskAtAcquisition >> t) & 1 == 1) {
                        expected++;
                    }
                }
            }
            assertEq(
                uint256(collection.pendingTraitCount(t)),
                expected,
                "pendingTraitCount accounting drift"
            );
        }
    }

    /// @notice Every collected trait must have a corresponding `firstVaultedPunk`
    ///         entry whose Punk is locked in the vault. Catches a regression
    ///         where `collectedMask` updates without the per-trait pointer.
    function invariant_FirstVaultedPunkSetForCollectedTraits() public view {
        uint256 m = collection.collectedMask();
        for (uint8 t = 0; t < 111; t++) {
            if ((m >> t) & 1 == 1) {
                (uint16 p, bool exists) = collection.firstVaultedPunk(t);
                assertTrue(exists, "collected trait missing firstVaultedPunk");
                assertTrue(vault.isLocked(p), "firstVaultedPunk not in vault");
            }
        }
    }

    /// @notice Diagnostic — log how many of each action actually fired. If a
    ///         run completes with all zeros for `accept` we know the handler
    ///         couldn't make state progress.
    function invariant_DiagnosticCounters() public {
        // Always passes — this exists so a `-vvv` run shows the counters.
        emit log_named_uint("topUp calls",         handler.callsTopup());
        emit log_named_uint("accept calls",        handler.callsAccept());
        emit log_named_uint("bid calls",           handler.callsBid());
        emit log_named_uint("settle calls",        handler.callsSettle());
        emit log_named_uint("settle (cleared)",    handler.callsSettleCleared());
        emit log_named_uint("settle (vaulted)",    handler.callsSettleVaulted());
    }

    /// @notice Fail loud if settle started reverting unconditionally.
    ///
    ///         `trySettle` swallows reverts in a try/catch (so one bad fuzz
    ///         input can't abort the campaign), which means a regression that
    ///         makes *every* settle revert would otherwise sail through green —
    ///         the invariants above would simply never observe a post-settle
    ///         state. `afterInvariant` runs once after the whole campaign, so
    ///         the handler counters here reflect the full run.
    ///
    ///         The guard is `attempts > 0 ⇒ successes > 0`: it asserts nothing
    ///         when the fuzzer never drove a sale to settlement (so it can't
    ///         flake on a low-coverage seed — settle fires rarely, ~1/320
    ///         calls), but the moment a settleable sale is reached, at least
    ///         one settle must succeed. A `trySettle` attempt is only counted
    ///         past the custody/deadline guards, where correct code always
    ///         settles (cleared or vaulted).
    ///
    ///         This guards the suite's integrity, not the cleared round-trip
    ///         specifically (the vaulted branch alone can satisfy it). The
    ///         cleared path (ReturnAuctionEscrow round-trip) is covered
    ///         deterministically by FinalSaleEscrowProvenanceTest.
    function afterInvariant() public view {
        if (handler.settleAttempts() > 0) {
            assertGt(
                handler.callsSettle(),
                0,
                "every settle attempt reverted across the run"
            );
        }
    }
}
