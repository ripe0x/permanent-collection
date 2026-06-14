// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

interface IReferralPayout {
    function balances(address) external view returns (uint256);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

interface IPermanentCollection {
    function acquisitionCount() external view returns (uint256);
}

interface IArtCoinsHookSkimFee {
    // (baselineSkimBps, bountyBps, maxReferralBpsOfVolume, lpFee, bountyRecipient,
    //  protocolRecipient, referralPayout, quoteToken)
    function skimConfig(bytes32 poolId) external view returns (
        uint24, uint16, uint24, uint24,
        address, address, address, address
    );
}

/// @notice Helper that does one attributed buy. Deployed by the script;
///         implements IUnlockCallback so PoolManager.unlock calls back here.
contract AttributedSwapper is IUnlockCallback {
    error NotPoolManager();

    IPoolManager public immutable poolManager;
    address public immutable token;
    address public immutable hook;
    int24 public immutable tickSpacing;
    uint24 public immutable poolFee;

    struct PCAttribution {
        bytes32 sourceId;
        address referrer;
        bytes16 campaignId;
        uint24 referralBps;
    }
    struct PCSwapData {
        PCAttribution attribution;
        bytes extensionPayload;
    }
    struct PoolSwapData {
        bytes mevModuleSwapData;
        bytes poolExtensionSwapData;
    }

    constructor(
        address _pm,
        address _token,
        address _hook,
        int24 _ts,
        uint24 _fee
    ) {
        poolManager = IPoolManager(_pm);
        token = _token;
        hook = _hook;
        tickSpacing = _ts;
        poolFee = _fee;
    }

    receive() external payable {}

    function buyWithAttribution(
        address referrer,
        uint24 referralBps,
        address to
    ) external payable returns (uint256 pctOut) {
        require(msg.value > 0, "no ETH");
        bytes memory data = abi.encode(msg.value, to, referrer, referralBps);
        bytes memory result = poolManager.unlock(data);
        pctOut = abi.decode(result, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 amountIn, address to, address referrer, uint24 referralBps) =
            abi.decode(data, (uint256, address, address, uint24));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: poolFee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hook)
        });

        bytes memory hookData = _buildHookData(referrer, referralBps);

        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
        });
        BalanceDelta delta = poolManager.swap(key, params, hookData);
        uint256 ethOwed = uint256(int256(-delta.amount0()));
        uint256 pctReceived = uint256(int256(delta.amount1()));

        poolManager.settle{value: ethOwed}();
        poolManager.take(Currency.wrap(token), to, pctReceived);
        return abi.encode(pctReceived);
    }

    function _buildHookData(address referrer, uint24 referralBps)
        internal
        pure
        returns (bytes memory)
    {
        PCSwapData memory pcsd = PCSwapData({
            attribution: PCAttribution({
                sourceId: bytes32(0),
                referrer: referrer,
                campaignId: bytes16(0),
                referralBps: referralBps
            }),
            extensionPayload: ""
        });
        bytes memory inner = abi.encode(pcsd);
        PoolSwapData memory outer = PoolSwapData({
            mevModuleSwapData: "",
            poolExtensionSwapData: inner
        });
        return abi.encode(outer);
    }
}

/// @notice S19 driver: one attributed buy, then read RP balance.
///
/// Run:
///   REFERRER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
///   forge script script/SimulateAttributedSwap.s.sol --rpc-url http://127.0.0.1:8545 \
///       --broadcast --slow --skip-simulation --private-key 0xac0974...
contract SimulateAttributedSwap is Script {
    address constant V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    int24 constant TICK_SPACING = 200;
    uint24 constant DYNAMIC_FEE_FLAG = 0x800000;
    uint16 constant REFERRAL_BPS = 250;

    function run() external {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments.json"));
        address tokenAddr = vm.parseJsonAddress(json, ".token");
        address hookAddr = vm.parseJsonAddress(json, ".hook");
        address rpAddr = vm.parseJsonAddress(json, ".referralPayout");
        address pcAddr = vm.parseJsonAddress(json, ".permanentCollection");
        address referrer = vm.envAddress("REFERRER");
        uint256 buyWei = vm.envOr("BUY_WEI", uint256(0.5 ether));

        // Pre-flight: the hook only credits referrers when BOTH
        // (a) `pc.acquisitionCount() > 0` (referral gate opens on first
        // acquisition) AND (b) `hook.maxReferralBpsOfVolume > 0` (admin
        // explicitly raised the per-pool cap via TokenAdminPoker; PC
        // launches at 0, deliberately disabled). Missing either gate
        // = silent zero-credit, which used to bewilder operators (see #108).
        // Now we fail loud BEFORE attempting the swap.
        uint256 acqCount = IPermanentCollection(pcAddr).acquisitionCount();
        bytes32 poolId = _computePoolId(tokenAddr, hookAddr);
        (,, uint24 maxRefCap,,,,,) = IArtCoinsHookSkimFee(hookAddr).skimConfig(poolId);
        console2.log("=== Attributed swap (S19) ===");
        console2.log("token         ", tokenAddr);
        console2.log("hook          ", hookAddr);
        console2.log("referrer      ", referrer);
        console2.log("buyWei        ", buyWei);
        console2.log("acquisitionCount", acqCount);
        console2.log("maxReferralBps", uint256(maxRefCap));
        require(
            acqCount > 0,
            "AttributedSwap: acquisitionCount == 0 -- referral gate closed pre-first-acquisition. Run an acceptBid/acceptListing first."
        );
        require(
            maxRefCap > 0,
            "AttributedSwap: maxReferralBpsOfVolume == 0 -- referrals disabled. Raise via TokenAdminPoker.setHookMaxReferralBps."
        );

        uint256 preBal = IReferralPayout(rpAddr).balances(referrer);
        console2.log("RP pre        ", preBal);

        vm.startBroadcast();
        AttributedSwapper sw = new AttributedSwapper(
            V4_POOL_MANAGER, tokenAddr, hookAddr, TICK_SPACING, DYNAMIC_FEE_FLAG
        );
        sw.buyWithAttribution{value: buyWei}(referrer, REFERRAL_BPS, msg.sender);
        vm.stopBroadcast();

        uint256 postBal = IReferralPayout(rpAddr).balances(referrer);
        console2.log("RP post       ", postBal);
        console2.log("delta (wei)   ", postBal - preBal);
        console2.log(
            "expected upper bound ",
            (buyWei * REFERRAL_BPS) / 100_000
        );
        console2.log("=== Done ===");
    }

    /// @dev Compute PoolId for the canonical PC pool: ETH-paired, dynamic-
    ///      fee flag, our hook. Matches Deploy.s.sol's pool config.
    function _computePoolId(address token_, address hook_) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(address(0), token_, DYNAMIC_FEE_FLAG, TICK_SPACING, hook_)
        );
    }
}
