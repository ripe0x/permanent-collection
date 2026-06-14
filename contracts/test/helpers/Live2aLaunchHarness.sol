// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeployScript} from "../../script/Deploy.s.sol";
import {IArtcoinsFactory} from "../../src/interfaces/IArtcoinsFactory.sol";

/// @title Live2aLaunchHarness
/// @notice Test-only subclass of the production `DeployScript`. It reuses the
///         REAL Phase-2b body (`_launchTokenAndWire`) and the deployments I/O
///         (`_readDeployments` / `_writeDeployments`) VERBATIM, but drives them
///         under `vm.startPrank(owner)` instead of a broadcast.
///
///         Why: running Phase-2b against the LIVE mainnet 2a contracts on a fork
///         requires acting as the original deployer `owner` — their `setup()`
///         gates pin a fixed identity that cannot be transferred (e.g.
///         `FeeAutoSwapper`'s immutable `_deployer`, `TokenAdminPoker`'s
///         `onlyOwner`, `Patron`'s `ProtocolAdmin`-gated allowlist). Because
///         `_launchTokenAndWire` is an `internal` function with no broadcast of
///         its own, calling it from this subclass under `startPrank(owner)` makes
///         every factory + `setup()` call carry `msg.sender == owner`.
///
///         This contract is the ONLY new surface — `Deploy.s.sol` itself is
///         unchanged, so the token-launch logic the test exercises is exactly the
///         logic the mainnet `runToken()` broadcast ships.
contract Live2aLaunchHarness is DeployScript {
    /// @notice Launch the token (Phase 2b) against the already-deployed 2a
    ///         contracts read from `DEPLOYMENTS_PATH`, acting as `owner` (the
    ///         live deployer / factory owner). Returns the deployed token.
    function launchTokenAsOwner(address owner) external returns (address tokenAddr) {
        _DeploymentAddresses memory d = _readDeployments();
        require(d.tokenAddr == address(0), "harness: token already launched");

        vm.startPrank(owner);
        // `owner` is the factory owner, so a deprecated factory already permits
        // the deploy via owner-bypass; un-deprecating on the fork removes all
        // doubt and mirrors a clean launch window.
        IArtcoinsFactory(_resolveFactory()).setDeprecated(false);
        d = _launchTokenAndWire(d);
        vm.stopPrank();

        _writeDeployments(d);
        return d.tokenAddr;
    }
}
