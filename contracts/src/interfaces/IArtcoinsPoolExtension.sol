// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @notice PC-local mirror of artcoins' `IArtCoinsHookV2PoolExtension` — the
///         per-pool extension interface the artcoins V3 hook (`ArtCoinsHook`)
///         invokes around swaps. Vendored here as a local interface to match
///         PC's convention of mirroring artcoins ABIs rather than importing the
///         submodule source. Selectors are identical to the artcoins interface,
///         so `type(IArtcoinsPoolExtension).interfaceId` matches.
interface IArtcoinsPoolExtension {
    /// @notice Called once by the hook during pool initialization, before the
    ///         locker is set up.
    function initializePreLockerSetup(
        PoolKey calldata poolKey,
        bool artCoinIsToken0,
        bytes calldata poolExtensionInitData
    ) external;

    /// @notice Called once by the hook after the locker is set up (during MEV
    ///         module init, or directly by `setPoolExtension`).
    function initializePostLockerSetup(
        PoolKey calldata poolKey,
        address locker,
        bool artCoinIsToken0
    ) external;

    /// @notice Called by the hook after each swap (in a try/catch) to run
    ///         extension logic.
    function afterSwap(
        PoolKey calldata poolKey,
        SwapParams calldata swapParams,
        BalanceDelta delta,
        bool artCoinIsToken0,
        bytes calldata poolExtensionSwapData
    ) external;

    /// @notice ERC-165 introspection.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool);
}
