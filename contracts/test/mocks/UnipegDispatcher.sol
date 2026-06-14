// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Using the PC mirror of the artcoins pool-extension interface (uses the
// standalone `SwapParams` type matching PC's v4-core version).
import {IArtcoinsPoolExtension} from "../../src/interfaces/IArtcoinsPoolExtension.sol";

import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

import {PCSwapContext} from "../../src/PCSwapContext.sol";
import {IPCCallbackExtension} from "../../src/interfaces/IPCCallbackExtension.sol";

/// @title  UnipegDispatcher
/// @notice Demo Design B dispatcher. Binds to the official PC pool's
///         extension slot, fans out `afterSwap` to N approved
///         `IPCCallbackExtension` implementations under gas budgets and
///         try/catch isolation, and toggles `PCSwapContext.inSwap` around
///         each callback so PC contracts can detect reentry.
///
///         This is a worked example proving Design B is viable. A
///         production version would add: ProtocolAdmin gating on the
///         registry, per-callback failure-counter + emergency disable,
///         locked add-only mode post-audit.
///
/// @dev    Implements `IArtCoinsPoolExtension` so it can be bound via
///         `TokenAdminPoker.bindExtension`. Tested with a direct
///         `afterSwap` invocation in `UnipegDemo.t.sol`.
contract UnipegDispatcher is IArtcoinsPoolExtension {
    error OnlyHook();
    error NotOwner();
    error NotHook();
    error CallbackAlreadyRegistered(address ext);
    error CallbackNotRegistered(address ext);
    error TooManyCallbacks();
    error GasBudgetOutOfBounds(uint32 budget);
    error ZeroAddress();

    // ─── events ──────────────────────────────────────────────────────────

    event CallbackRegistered(address indexed ext, uint32 gasBudget);
    event CallbackUnregistered(address indexed ext);
    event CallbackEnabledSet(address indexed ext, bool enabled);
    event CallbackGasBudgetSet(address indexed ext, uint32 gasBudget);
    event CallbackInvoked(address indexed ext, bytes32 result);
    event CallbackFailed(address indexed ext, bytes reason);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ─── constants ───────────────────────────────────────────────────────

    /// @notice Maximum simultaneous registered callbacks per pool.
    uint256 public constant MAX_CALLBACKS = 8;

    /// @notice Gas budget bounds. Lower = forces extensions to do less.
    uint32 public constant MIN_GAS_BUDGET = 5_000;
    uint32 public constant MAX_GAS_BUDGET = 200_000;

    // ─── immutable wiring ────────────────────────────────────────────────

    /// @notice The artcoins hook authorized to call `afterSwap` /
    ///         `initialize*` on this dispatcher.
    address public immutable hook;

    /// @notice `PCSwapContext` whose `inSwap` flag gets toggled around the
    ///         callback loop. The dispatcher MUST be the
    ///         `authorizedExtension` on this context for the flag toggle
    ///         to work (otherwise `enterSwap` reverts and the callback
    ///         loop reverts too — fail-closed: no callbacks fire unless
    ///         the guard infrastructure is properly wired).
    PCSwapContext public immutable swapContext;

    // ─── owner / registry ────────────────────────────────────────────────

    /// @notice Address that can register/unregister/configure callbacks.
    address public owner;

    /// @notice Ordered registry of callback addresses.
    address[] public callbacks;

    /// @notice Membership map for O(1) lookup.
    mapping(address => bool) public callbackRegistered;
    /// @notice Per-callback enabled flag (true to invoke, false to skip).
    mapping(address => bool) public callbackEnabled;
    /// @notice Per-callback gas budget for the `onSwap` call.
    mapping(address => uint32) public callbackGasBudget;

    // ─── construction ────────────────────────────────────────────────────

    constructor(address _hook, address _swapContext, address _owner) {
        if (_hook == address(0) || _swapContext == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        hook = _hook;
        swapContext = PCSwapContext(_swapContext);
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ─── ownership ───────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ─── registry ────────────────────────────────────────────────────────

    function registerCallback(address ext, uint32 gasBudget) external {
        if (msg.sender != owner) revert NotOwner();
        if (ext == address(0)) revert ZeroAddress();
        if (callbackRegistered[ext]) revert CallbackAlreadyRegistered(ext);
        if (callbacks.length >= MAX_CALLBACKS) revert TooManyCallbacks();
        if (gasBudget < MIN_GAS_BUDGET || gasBudget > MAX_GAS_BUDGET) {
            revert GasBudgetOutOfBounds(gasBudget);
        }
        callbackRegistered[ext] = true;
        callbackEnabled[ext] = true;
        callbackGasBudget[ext] = gasBudget;
        callbacks.push(ext);
        emit CallbackRegistered(ext, gasBudget);
    }

    function unregisterCallback(address ext) external {
        if (msg.sender != owner) revert NotOwner();
        if (!callbackRegistered[ext]) revert CallbackNotRegistered(ext);
        callbackRegistered[ext] = false;
        callbackEnabled[ext] = false;
        callbackGasBudget[ext] = 0;
        // Remove from array (order-preserving).
        uint256 len = callbacks.length;
        for (uint256 i = 0; i < len; i++) {
            if (callbacks[i] == ext) {
                for (uint256 j = i; j + 1 < len; j++) {
                    callbacks[j] = callbacks[j + 1];
                }
                callbacks.pop();
                break;
            }
        }
        emit CallbackUnregistered(ext);
    }

    function setCallbackEnabled(address ext, bool enabled) external {
        if (msg.sender != owner) revert NotOwner();
        if (!callbackRegistered[ext]) revert CallbackNotRegistered(ext);
        callbackEnabled[ext] = enabled;
        emit CallbackEnabledSet(ext, enabled);
    }

    function setCallbackGasBudget(address ext, uint32 gasBudget) external {
        if (msg.sender != owner) revert NotOwner();
        if (!callbackRegistered[ext]) revert CallbackNotRegistered(ext);
        if (gasBudget < MIN_GAS_BUDGET || gasBudget > MAX_GAS_BUDGET) {
            revert GasBudgetOutOfBounds(gasBudget);
        }
        callbackGasBudget[ext] = gasBudget;
        emit CallbackGasBudgetSet(ext, gasBudget);
    }

    // ─── hook callbacks (IArtCoinsPoolExtension) ─────────────────────────

    function initializePreLockerSetup(
        PoolKey calldata,
        bool,
        bytes calldata
    ) external {
        if (msg.sender != hook) revert OnlyHook();
        // No setup needed in this demo.
    }

    function initializePostLockerSetup(
        PoolKey calldata,
        address,
        bool
    ) external {
        if (msg.sender != hook) revert OnlyHook();
    }

    /// @notice Called by the hook after every swap. Fans out to each
    ///         enabled callback inside a try/catch with a gas budget,
    ///         flipping the `inSwap` flag for the duration so PC
    ///         contracts revert if a malicious callback tries to reenter.
    function afterSwap(
        PoolKey calldata poolKey,
        SwapParams calldata swapParams,
        BalanceDelta delta,
        bool, // artCoinIsToken0
        bytes calldata poolExtensionSwapData
    ) external {
        if (msg.sender != hook) revert OnlyHook();

        // Set the in-swap flag. The dispatcher MUST be the authorized
        // extension on PCSwapContext — if not, this reverts and the whole
        // afterSwap fails (which the parent hook's try/catch catches), so
        // callbacks never fire without the reentrancy guard active.
        swapContext.enterSwap();

        uint256 len = callbacks.length;
        for (uint256 i = 0; i < len; i++) {
            address ext = callbacks[i];
            if (!callbackEnabled[ext]) continue;
            uint32 budget = callbackGasBudget[ext];

            // External call with explicit gas cap. Solidity's
            // `IPCCallbackExtension(ext).onSwap{gas: budget}(...)` is
            // equivalent to a low-level call with that gas budget.
            try IPCCallbackExtension(ext).onSwap{gas: budget}(
                poolKey, swapParams, delta, poolExtensionSwapData
            ) returns (bytes32 result) {
                emit CallbackInvoked(ext, result);
            } catch (bytes memory reason) {
                emit CallbackFailed(ext, reason);
            }
        }

        // Clear the flag. Always runs — even if a callback consumed its
        // entire budget, control returns here.
        swapContext.exitSwap();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IArtcoinsPoolExtension).interfaceId
            || interfaceId == 0x01ffc9a7; // ERC-165
    }

    // ─── views ───────────────────────────────────────────────────────────

    function callbackCount() external view returns (uint256) {
        return callbacks.length;
    }

    function getCallbacks() external view returns (address[] memory) {
        return callbacks;
    }
}
