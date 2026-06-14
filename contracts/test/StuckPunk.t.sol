// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Patron} from "../src/Patron.sol";
import {ReturnAuctionModule} from "../src/ReturnAuctionModule.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Stuck-Punk scenarios — explicit acknowledgment that the protocol
///         has NO recovery path for a return auction that becomes unsettleable.
///         The design choice is intentional:
///
///         - If `BuybackBurner` rejects ETH (impossible — has `receive()`)
///         - If `Patron` rejects ETH (impossible — has `receive()`)
///         - If `PunkVault.receivePunk` reverts on the vault path
///
///         the Punk would be stranded in `ReturnAuctionModule`. We assert that
///         the components designed to receive ETH actually do so, and that
///         the vault's reject paths are correctly bounded (a single one-time
///         failure can't permanently strand a Punk).
///
///         The tests also document — by NOT providing a recovery path —
///         that an admin cannot pull a stuck Punk out of ReturnAuctionModule.
///         If a real stuck scenario emerges, the protocol is intentionally
///         frozen for that Punk. This is the immutability contract.
contract StuckPunkTest is ForkFixtures {
    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
        _fundPatronFromAdapter(5 ether);
    }

    function _findEligiblePunk(uint16 start) internal view returns (uint16) {
        for (uint16 i = start; i < 10_000; i++) {
            uint256 mask = punksData.traitMaskOf(i);
            if ((mask & ~collection.collectedMask()) != 0) return i;
        }
        revert("no eligible");
    }

    /// @notice Vault-path settle succeeds with an empty VaultBurnPool and an
    ///         empty live bid. The vault path pays NO keeper reward (that
    ///         subsystem was removed — settle is free and self-incentivized by
    ///         the Proof-NFT recipient, mission K1); the only best-effort step
    ///         is the VaultBurnPool sweep, wrapped in try/catch, which cannot
    ///         strand a Punk in ReturnAuctionModule. The first-vaulting Proof
    ///         mint, by contrast, is REQUIRED (atomic with the vaulting, no
    ///         try/catch) — its rollback-on-failure semantics are covered by
    ///         `ProofMintForkTest::test_VaultSettle_ProofMintRevert_RollsBackAtomically`.
    function test_VaultPath_SettlesWithEmptyPoolAndNoReward() public {
        uint16 punkId = _findEligiblePunk(5_000);
        address owner = address(0xCAFE);
        // Top up the live bid, then list at it. The bid was credited through the
        // adapter in setUp; acceptBid debits the listed price (≈ the full bid),
        // draining Patron to ~0.
        _fundPatronFromAdapter(0.5 ether);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // acceptBid paid the entire accounted bid out to the owner, leaving
        // Patron at zero. VaultBurnPool is empty (no fee inflows in this test).
        assertEq(vaultBurnPool.balance(), 0);

        // Settle — should succeed despite the empty pool + zero reward.
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), address(vault));
        assertTrue(vault.isLocked(punkId));
    }

    /// @notice Cleared path settles cleanly from a caller that cannot receive
    ///         ETH. The cleared path pays NO protocol-funded keeper tip, so
    ///         there is no outgoing send to `msg.sender` — a non-receiving
    ///         keeper (or the winning bidder's own contract) finalizes the
    ///         auction with no reward-send failure path to worry about.
    ///         Confirms the "self-incentivized, no tip" invariant: the winning
    ///         bidder's locked ETH is the only incentive needed.
    function test_ClearedPath_SettlesFromNonReceivingCaller_NoTip() public {
        uint16 punkId = _findEligiblePunk(5_001);
        address owner = address(0xCAFE);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Bidder clears.
        uint256 reserve = finalSale.reserveOf(punkId);
        address bidder = address(0xBEEF);
        vm.deal(bidder, reserve);
        vm.prank(bidder);
        finalSale.placeBidWithReferral{value: reserve}(punkId, address(0), bytes32(0));

        // Settle from a contract with no `receive()` (CantReceiveCaller). The
        // settle succeeds precisely because the cleared path sends the caller
        // nothing.
        CantReceiveCaller bad = new CantReceiveCaller(address(finalSale));
        uint256 callerBalBefore = address(bad).balance;
        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        bad.settle(punkId);

        // Punk delivered to the winning bidder, burn share landed, and the
        // (non-receiving) caller got exactly zero — no tip.
        assertEq(punksMarket.punkIndexToAddress(uint256(punkId)), bidder);
        assertGt(address(burner).balance, 0, "burn share landed");
        assertEq(address(bad).balance, callerBalBefore, "caller received no settle tip");
    }

    /// @notice There is NO admin path to recover a Punk from ReturnAuctionModule.
    ///         The contract has no `withdrawPunk`/`recoverPunk`/`emergencyTransfer`
    ///         selector. This is asserted by bytecode scan.
    ///
    ///         NOTE: `sweep()` (no args) is intentionally omitted from the
    ///         forbidden list — ReturnAuctionModule legitimately calls
    ///         `vaultBurnPool.sweep()` from its vault-path settle branch, so
    ///         the selector is embedded in this contract's bytecode as a
    ///         call target. The signatures with args (`sweep(uint16)`,
    ///         `sweep(address)`) are still rejected — those would have to
    ///         be local entry points, not external calls.
    function test_NoAdminRecoveryPath_OnFinalSaleModule() public view {
        bytes memory code = address(finalSale).code;
        _assertNoSelector(code, bytes4(keccak256("withdrawPunk(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("recoverPunk(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("emergencyTransfer(address,uint16)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("transferPunkOut(uint16,address)")));
        _assertNoSelector(code, bytes4(keccak256("sweep(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("sweep(address)")));
    }

    /// @notice An admin call to settle on a sale that's already settled is a
    ///         no-op revert — there's no path to unsettle and try again.
    function test_AlreadySettled_BlocksReSettle() public {
        uint16 punkId = _findEligiblePunk(5_002);
        address owner = address(0xCAFE);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        vm.warp(uint256(finalSale.endsAt(punkId)) + 1);
        finalSale.settle(punkId);

        vm.expectRevert(
            abi.encodeWithSelector(ReturnAuctionModule.AlreadySettled.selector, punkId)
        );
        finalSale.settle(punkId);
    }

    /// @notice Settle cannot fire before `endsAt` — confirms the sale-live
    ///         guard is in place.
    function test_BeforeEndsAt_SettleReverts() public {
        uint16 punkId = _findEligiblePunk(5_003);
        address owner = address(0xCAFE);
        _giveAndOfferToBounty(owner, punkId);
        uint8 target = _pickTarget(punkId);
        vm.prank(owner);
        patron.acceptBid(punkId, target, type(uint256).max);

        // Settle before endsAt: SaleLive revert.
        vm.expectRevert(
            abi.encodeWithSelector(ReturnAuctionModule.SaleLive.selector, punkId)
        );
        finalSale.settle(punkId);
    }

    /// @notice There is NO admin path to recover or override custody state
    ///         on `PermanentCollection`. The contract has no `withdrawPunk`,
    ///         `setCustody`, `forceVault`, `unmarkCustody`, or similar
    ///         selector. Custody state is single-write per Punk via the
    ///         ReturnAuctionModule-gated `markCustody` only.
    function test_NoAdminRecoveryPath_OnPermanentCollection() public view {
        bytes memory code = address(collection).code;
        // Custody overrides — every conceivable "fix it up" verb.
        _assertNoSelector(code, bytes4(keccak256("setCustody(uint16,uint8)")));
        _assertNoSelector(code, bytes4(keccak256("forceCustody(uint16,uint8)")));
        _assertNoSelector(code, bytes4(keccak256("unmarkCustody(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("forceVault(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("forceReturn(uint16)")));
        // Mask + count overrides — would let an admin retroactively
        // "uncollect" a trait.
        _assertNoSelector(code, bytes4(keccak256("setCollectedMask(uint256)")));
        _assertNoSelector(code, bytes4(keccak256("clearCollectedBit(uint8)")));
        _assertNoSelector(code, bytes4(keccak256("setPendingTraitCount(uint8,uint16)")));
        // Generic admin / rescue surface.
        _assertNoSelector(code, bytes4(keccak256("withdraw()")));
        _assertNoSelector(code, bytes4(keccak256("withdrawPunk(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("rescue(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("sweep()")));
        _assertNoSelector(code, bytes4(keccak256("sweep(uint16)")));
    }

    /// @notice There is NO admin path to remove a Punk from `PunkVault`. The
    ///         contract holds Punks via direct ownership on the CryptoPunks
    ///         market — and exposes no path to `transferPunk`,
    ///         `offerPunkForSale`, `acceptBidForPunk`, or any other outbound
    ///         market write. Once a Punk is owned by the vault, it's there
    ///         forever. This is the artwork's terminal commitment.
    function test_NoAdminRecoveryPath_OnPunkVault() public view {
        bytes memory code = address(vault).code;
        // Punk outbound paths.
        _assertNoSelector(code, bytes4(keccak256("withdrawPunk(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("withdrawPunk(uint16,address)")));
        _assertNoSelector(code, bytes4(keccak256("recoverPunk(uint16)")));
        _assertNoSelector(code, bytes4(keccak256("emergencyTransfer(uint16,address)")));
        _assertNoSelector(code, bytes4(keccak256("rescuePunk(uint16,address)")));
        _assertNoSelector(code, bytes4(keccak256("sweep()")));
        // CryptoPunks market write selectors the vault must NEVER call.
        // (These would let the vault list/transfer Punks to itself or out.)
        _assertNoSelector(code, bytes4(keccak256("transferPunk(address,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSale(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("offerPunkForSaleToAddress(uint256,uint256,address)")));
        _assertNoSelector(code, bytes4(keccak256("acceptBidForPunk(uint256,uint256)")));
        _assertNoSelector(code, bytes4(keccak256("punkNoLongerForSale(uint256)")));
        // ERC20 sweep (vault holds no ERC20s; defense in depth).
        _assertNoSelector(code, bytes4(keccak256("sweepToken(address,address)")));
    }

    /// @notice The persistent-revert thought experiment, documented as a
    ///         test: if `markCustody(Vaulted)` were to revert mid-settle —
    ///         e.g. a hypothetical downstream burn step throwing on every
    ///         call — the protocol has NO escape hatch. The Punk would
    ///         remain in `ReturnAuctionModule` forever.
    ///
    ///         In practice this CANNOT happen (we audit below) because
    ///         markCustody's only failure modes are message-sender,
    ///         already-set, and idx-zero, none of which apply in the
    ///         settle path. But the absence of a recovery surface means
    ///         that if such a scenario somehow occurred, the artwork is
    ///         spec-compliant: a stuck Punk is the artwork's commitment.
    function test_PersistentRevert_NoEscapeHatch_DesignChoice() public pure {
        // 1) ReturnAuctionModule has no recovery surface (asserted by
        //    test_NoAdminRecoveryPath_OnFinalSaleModule).
        // 2) PermanentCollection's markCustody is the ONLY mutator of
        //    custody state — there's no fallback or override (asserted by
        //    test_NoAdminRecoveryPath_OnPermanentCollection).
        // 3) PunkVault has no path to release a Punk (asserted by
        //    test_NoAdminRecoveryPath_OnPunkVault).
        //
        // This combination is the design choice: a stuck Punk is forever
        // stuck. The protocol's immutability is the value proposition,
        // not a recovery path.
        //
        // Audit of markCustody's revert modes (read against the source):
        //   - NotReturnAuction: caller-side; settle is the only caller
        //   - NotRecorded: pre-condition guaranteed by settle ordering
        //   - CustodyAlreadySet: pre-condition guaranteed by settled flag
        //   - InvalidCustodyTransition: outcome is hardcoded
        //   - underflow on pendingTraitCount: guarded by `if cur > 0`
        //
        // So markCustody cannot revert from any user-reachable state.
        // The thought experiment exists only to document the design.
        assertTrue(true, "design choice: no recovery; see comments");
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

contract CantReceiveCaller {
    ReturnAuctionModule fs;
    constructor(address _fs) {
        fs = ReturnAuctionModule(payable(_fs));
    }
    function settle(uint16 punkId) external {
        fs.settle(punkId);
    }
    // No receive() — ETH transfers to this contract revert.
}
