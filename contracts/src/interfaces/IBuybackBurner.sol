// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IBuybackBurner {
    function executeStep(uint256 minOut) external;
    function quoteStepAmount() external view returns (uint256);
    function remainingEth() external view returns (uint256);
    function totalEthBurned() external view returns (uint256);
    function totalTokensBurned() external view returns (uint256);
    function lastStepBlock() external view returns (uint256);
}
