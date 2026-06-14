// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TaxConfig} from "artcoins/interfaces/IArtCoinsTaxable.sol";

/// @notice External interface for the artcoins token factory deployed at
///         `0xF051cd4C4F3F36F9f24d8a19d60Ee8F84FC6793e` on Ethereum mainnet.
///         Mirrors the ABI shipped in
///         `artcoins/src/lib/launcher/abi.ts::factoryAbi`.
///
///         A single `deployToken(DeploymentConfig)` call does the full
///         launch: deploys an `ArtCoinsToken` ERC20, initializes the V4
///         pool with the artcoins hook, mints the configured LP positions,
///         attaches the locker for fee distribution, wires an optional MEV
///         / sniper-fee module, and runs any post-launch extensions in a
///         single transaction.
interface IArtcoinsFactory {
    struct TokenConfig {
        /// @notice Address granted admin powers on the deployed token.
        ///         Per `tokenAbi`, admin can update the `metadataRenderer`,
        ///         `imageUrl`, `metadata`, `context`, and `isVerified`
        ///         fields, and transfer admin to another address. We pass
        ///         our `TokenAdminPoker`, which exposes only the scoped
        ///         extension / referral-cap / tax-rate carve-outs after setup.
        address tokenAdmin;
        string name;
        string symbol;
        /// @notice CREATE2 salt for the deployed token. Use a fixed value
        ///         to make the token address deterministic.
        bytes32 salt;
        string image;
        string metadata;
        string context;
        uint256 totalSupply;
        /// @notice Optional metadataRenderer override. The token's
        ///         `tokenURI()` delegates here if set. We pass our
        ///         `RendererRegistry` so the token metadata resolves through
        ///         the current collection renderer.
        address renderer;
    }

    struct PoolConfig {
        /// @notice Artcoins hook at
        ///         `0xAAd673ea3945dF5F7Ef328974d2c07c8BdcAA8Cc` on mainnet.
        address hook;
        /// @notice Token to pair with. Pass `address(0)` for native ETH.
        address pairedToken;
        /// @notice Initial tick if the art coin sorts as token0 in the pool.
        int24 tickIfToken0IsArtCoins;
        int24 tickSpacing;
        /// @notice ABI-encoded `(uint24 buyFee, uint24 sellFee)` in ppm
        ///         (1_000_000 = 100%). For 111 we use
        ///         `abi.encode(50_000, 50_000)` = 5% each direction.
        bytes poolData;
    }

    struct LockerConfig {
        /// @notice The artcoins locker at
        ///         `0xd914c864D9AEf3D8E51370139300aC534FB497b2` on mainnet.
        address locker;
        /// @notice Per-recipient admin (allowed to update the recipient).
        ///         Length must match `rewardRecipients` / `rewardBps`.
        address[] rewardAdmins;
        address[] rewardRecipients;
        /// @notice Reward share for each recipient, in bps. For this deploy
        ///         these sum to 9000; the remaining 1000 bps is the artcoins
        ///         protocol cut.
        uint16[] rewardBps;
        int24[] tickLower;
        int24[] tickUpper;
        /// @notice LP allocation per position, in bps. Must sum to 10_000.
        uint16[] positionBps;
        bytes lockerData;
    }

    struct MevModuleConfig {
        /// @notice Pass `address(0)` for no MEV module (clean launch).
        address mevModule;
        bytes mevModuleData;
    }

    struct SniperFeeConfig {
        address recipient;
        bool lockRecipient;
    }

    struct ExtensionConfig {
        address extension;
        uint256 msgValue;
        uint16 extensionBps;
        bytes extensionData;
    }

    struct DeploymentConfig {
        TokenConfig tokenConfig;
        PoolConfig poolConfig;
        LockerConfig lockerConfig;
        MevModuleConfig mevModuleConfig;
        SniperFeeConfig sniperFeeConfig;
        ExtensionConfig[] extensionConfigs;
    }

    /// @notice Permissionless. `msg.value` must be at least `deployFee()`.
    /// @return tokenAddress The deployed `ArtCoinsToken` address.
    function deployToken(DeploymentConfig calldata config)
        external
        payable
        returns (address tokenAddress);

    /// @notice Variant of `deployToken` that overrides the factory's default
    ///         protocol-fee bps for this deploy only. Used by the 111
    ///         launch (10% override) and any future deploy that wants a
    ///         non-default protocol slot. `msg.value` must be at least
    ///         `deployFee()`. Project-side `lockerConfig.rewardBps` must
    ///         sum to `10_000 - protocolBpsOverride`.
    /// @param  config Same shape as `deployToken`.
    /// @param  protocolBpsOverride Bps reserved for the artcoins protocol
    ///         slot (BurnRouter) on this deploy. Capped by the factory's
    ///         `MAX_PROTOCOL_FEE_BPS`.
    function deployTokenWithProtocolBps(
        DeploymentConfig calldata config,
        uint16 protocolBpsOverride
    ) external payable returns (address tokenAddress);

    /// @notice Variant of `deployTokenWithProtocolBps` that ALSO configures a
    ///         venue-scoped buy-side transfer tax on the deployed token. The
    ///         tax is default-off shared infrastructure on `ArtCoinsToken`;
    ///         pass an `enabled = false` `taxConfig` and the token behaves
    ///         identically to the standard path. PC's 111 launch uses this
    ///         with `enabled = true`. `taxConfig` fields are token-INDEPENDENT
    ///         (venue pool addresses + the canonical pool id are derived inside
    ///         the token constructor from `address(this)`), so there is no
    ///         CREATE2 circular dependency.
    /// @param  config Same shape as `deployTokenWithProtocolBps`.
    /// @param  protocolBpsOverride Protocol slot bps for THIS deploy only.
    /// @param  taxConfig Venue-scoped transfer-tax configuration.
    /// @return tokenAddress The deployed token address.
    function deployTokenWithProtocolBpsAndTax(
        DeploymentConfig calldata config,
        uint16 protocolBpsOverride,
        TaxConfig calldata taxConfig
    ) external payable returns (address tokenAddress);

    /// @notice Struct returned by `tokenDeploymentInfo`. The factory returns
    ///         a SINGLE tuple (not 4 flat values), so this struct shape
    ///         must match exactly — flat-tuple destructuring would
    ///         mis-decode the ABI offset prefix.
    struct TokenDeploymentInfo {
        address token;
        address hook;
        address locker;
        address[] extensions;
    }

    /// @notice Read back the addresses associated with a deployed token.
    function tokenDeploymentInfo(address token)
        external
        view
        returns (TokenDeploymentInfo memory);

    /// @notice Wei required for `deployToken` `msg.value`.
    function deployFee() external view returns (uint256);

    /// @notice Default share of the trading fee routed to the artcoins
    ///         protocol (in bps, out of 10_000). Currently 2000 = 20%.
    function defaultProtocolFeeBps() external view returns (uint16);

    /// @notice Address receiving the protocol-fee share.
    function teamFeeRecipient() external view returns (address);

    /// @notice OpenZeppelin Ownable owner. Can toggle deprecation.
    function owner() external view returns (address);

    /// @notice Whether `deployToken` is currently disabled. When true,
    ///         the factory reverts every deploy with `Deprecated()`
    ///         (selector 0xc73b9d7c).
    function deprecated() external view returns (bool);

    /// @notice Owner-only. Flip the deprecation flag.
    function setDeprecated(bool deprecated_) external;

    /// @notice Whether a given MEV module address has been whitelisted by
    ///         the factory owner (i.e. is callable via `mevModuleConfig`
    ///         on `deployToken`). The factory reverts `MevModuleNotEnabled`
    ///         when a deploy references a non-whitelisted module.
    function enabledMevModules(address mevModule) external view returns (bool);

    /// @notice Owner-only. Toggle whitelist status of a MEV module.
    function setMevModule(address mevModule, bool enabled) external;
}
