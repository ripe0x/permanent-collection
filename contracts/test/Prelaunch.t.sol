// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICryptoPunksMarket} from "../src/interfaces/ICryptoPunksMarket.sol";
import {IPermanentCollection} from "../src/interfaces/IPermanentCollection.sol";
import {ForkFixtures} from "./helpers/ForkFixtures.sol";

/// @notice Pre-launch invariants that catch operator drift before a real
///         mainnet broadcast. These are companions to docs/PRELAUNCH.md.
///
///         What's NOT here (and intentionally so):
///         - The locker's deployed rewardBps split. That's proven bit-exact
///           by the ratio check in `EndToEndVolume.t.sol` (6930/1350/720
///           observed at the locker boundary). Reading `tokenRewards` from
///           the deployed locker directly would require the locker's actual
///           struct ABI, which doesn't match our minimal interface.
contract PrelaunchTest is ForkFixtures {
    address internal constant PUNKSTRATEGY = 0xc50673EDb3A7b94E8CAD8a7d4E0cD68864E33eDF;

    /// @dev `buyPunk(uint256)` selector. The PNKSTR ERC20 IS the yoyo --
    ///      this selector being present in its deployed bytecode is one of
    ///      the verifications the deploy script's NatSpec calls out
    ///      (see `contracts/script/Deploy.s.sol`).
    bytes4 internal constant BUY_PUNK_SELECTOR = 0x8264fe98;

    function setUp() public {
        _setUpFork();
        _deployProtocol();
        adminContract.transferAdmin(address(this));
    }

    // ──────────────── PunkStrategy address verification ────────────────

    function test_PunkStrategy_HasCodeOnMainnet() public view {
        assertGt(PUNKSTRATEGY.code.length, 0, "PunkStrategy address has no code on mainnet fork");
    }

    function test_PunkStrategy_BytecodeContainsBuyPunkSelector() public view {
        bytes memory code = PUNKSTRATEGY.code;
        bool found;
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == BUY_PUNK_SELECTOR[0]
                    && code[i + 1] == BUY_PUNK_SELECTOR[1]
                    && code[i + 2] == BUY_PUNK_SELECTOR[2]
                    && code[i + 3] == BUY_PUNK_SELECTOR[3]
            ) {
                found = true;
                break;
            }
        }
        assertTrue(
            found, "PunkStrategy bytecode missing buyPunk(uint256) selector -- address may be stale"
        );
    }

    /// @dev Non-strict: a zero value doesn't strictly fail the canary (the
    ///      contract may have withdrawn recently), but log it for visibility
    ///      so an operator running this pre-broadcast can sanity-check the
    ///      number alongside the bytecode-selector check.
    function test_PunkStrategy_PriorSellingActivity_LogsForVisibility() public {
        uint256 pending = ICryptoPunksMarket(PUNKS_MARKET).pendingWithdrawals(PUNKSTRATEGY);
        emit log_named_uint("PunkStrategy pendingWithdrawals (wei)", pending);
    }

    function test_PunkStrategy_CanBeAllowlisted() public {
        // The deploy script seeds PunkStrategy into Patron's allowlist (see
        // step 12 of Deploy.s.sol). The fork fixture skips that step. Verify
        // the allowlist mechanism accepts the address — the deploy script
        // does the actual seeding at production time.
        patron.addAllowedSeller(PUNKSTRATEGY);
        assertTrue(patron.allowedSellers(PUNKSTRATEGY), "allowlist accepts PunkStrategy address");
    }

    // ──────────────── End-to-end patron path with the real address ────────────────

    /// @notice Drives the full `acceptListing` flow against the REAL
    ///         PunkStrategy address (not a mock). Pre-positions state on the
    ///         fork (moves a Punk into the address, impersonates it to list
    ///         publicly), then runs `patron.acceptListing` and asserts the
    ///         protocol-side cycle completes:
    ///           - Patron `buyPunk`s from PunkStrategy at the listed price.
    ///           - Punk transfers into ReturnAuctionModule custody.
    ///           - Acquisition recorded; reserve = 1.01× paid (first trial).
    ///           - Bot caller earns a finder fee (capped).
    ///           - PunkStrategy's market `pendingWithdrawals` increases by
    ///             the listing price — proving the real contract is reachable
    ///             via standard 2017-market semantics.
    function test_PunkStrategy_PatronPath_AcceptListing_AcceptsRealAddress() public {
        // Pre-position: pick a Punk and place it in PunkStrategy's hands at
        // a market-public listing price. We impersonate PunkStrategy to call
        // `offerPunkForSale` — testing the patron path, not PunkStrategy's
        // internal yoyo logic. The real address is the canonical seller of
        // record, which is what `acceptListing`'s allowlist check gates on.
        uint16 punkId = 4242;
        uint256 listingPrice = 8 ether;

        address currentOwner = punksMarket.punkIndexToAddress(uint256(punkId));
        require(currentOwner != address(0), "punk unowned at fork block");
        vm.prank(currentOwner);
        punksMarket.transferPunk(PUNKSTRATEGY, uint256(punkId));

        vm.prank(PUNKSTRATEGY);
        punksMarket.offerPunkForSale(uint256(punkId), listingPrice);

        _addAllowedSellerImmediate(PUNKSTRATEGY);
        _fundPatronFromAdapter(listingPrice + 5 ether);

        uint256 pendingBefore = punksMarket.pendingWithdrawals(PUNKSTRATEGY);
        address bot = address(0xB07);
        vm.deal(bot, 0);
        uint8 target = _pickTarget(punkId);
        vm.prank(bot);
        patron.acceptListing(punkId, target);

        // Patron paid the listing price into PunkStrategy's market-side
        // pendingWithdrawals — the real address can claim via `market.withdraw()`.
        assertEq(
            punksMarket.pendingWithdrawals(PUNKSTRATEGY) - pendingBefore,
            listingPrice,
            "PunkStrategy can withdraw the listing price"
        );

        // Our side completed: Punk is in ReturnAuctionModule custody, acquisition
        // recorded, reserve = 1.01× listing price (first trial of this trait).
        assertEq(
            punksMarket.punkIndexToAddress(uint256(punkId)),
            address(finalSale),
            "Punk transferred to ReturnAuction"
        );
        assertTrue(collection.isRecorded(punkId), "acquisition recorded");
        assertEq(
            uint8(collection.custodyOf(punkId)),
            uint8(IPermanentCollection.Custody.InReturnAuction)
        );
        assertEq(finalSale.reserveOf(punkId), (listingPrice * 101) / 100, "reserve = 1.01 x paid");

        // Bot was rewarded; reward respects the fixed cap.
        assertGt(bot.balance, 0, "bot earned finder fee");
        assertLe(bot.balance, patron.finderFeeFixedCap(), "fee under fixed cap");
    }

    /// @notice The complementary safety check: BEFORE seeding the allowlist,
    ///         `acceptListing` against the real address MUST revert
    ///         `SellerNotAllowed`. Confirms the allowlist gate actually
    ///         applies to this address (not, say, a hard-coded carve-out).
    function test_PunkStrategy_PatronPath_RevertsWhenNotAllowlisted() public {
        uint16 punkId = 4242;
        address currentOwner = punksMarket.punkIndexToAddress(uint256(punkId));
        require(currentOwner != address(0), "punk unowned at fork block");
        vm.prank(currentOwner);
        punksMarket.transferPunk(PUNKSTRATEGY, uint256(punkId));
        vm.prank(PUNKSTRATEGY);
        punksMarket.offerPunkForSale(uint256(punkId), 8 ether);
        _fundPatronFromAdapter(20 ether);

        // Allowlist is empty — must revert SellerNotAllowed against the real address.
        uint8 target = _pickTarget(punkId);
        vm.expectRevert(
            abi.encodeWithSelector(
                Patron_SellerNotAllowed_selector(), PUNKSTRATEGY
            )
        );
        patron.acceptListing(punkId, target);
    }

    /// @dev Compact way to get the selector without dragging in the full
    ///      Patron contract just for one error.
    function Patron_SellerNotAllowed_selector() internal pure returns (bytes4) {
        return bytes4(keccak256("SellerNotAllowed(address)"));
    }
}
