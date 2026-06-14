// Hand-written ABI fragment for the Uniswap V4 Quoter.
//
// `quoteExactInputSingle` is marked `nonpayable` because internally the
// Quoter executes the swap and reverts with the result encoded in the revert
// data — it's strictly a state-changing simulation. wagmi's `useReadContract`
// dispatches it via `eth_call`, which runs the simulation without applying
// state, so the function reads cleanly from the frontend.
export const abi = [
    {
        type: 'function',
        name: 'quoteExactInputSingle',
        inputs: [
            {
                name: 'params',
                type: 'tuple',
                components: [
                    {
                        name: 'poolKey',
                        type: 'tuple',
                        components: [
                            {name: 'currency0', type: 'address'},
                            {name: 'currency1', type: 'address'},
                            {name: 'fee', type: 'uint24'},
                            {name: 'tickSpacing', type: 'int24'},
                            {name: 'hooks', type: 'address'},
                        ],
                    },
                    {name: 'zeroForOne', type: 'bool'},
                    {name: 'exactAmount', type: 'uint128'},
                    {name: 'hookData', type: 'bytes'},
                ],
            },
        ],
        outputs: [
            {name: 'amountOut', type: 'uint256'},
            {name: 'gasEstimate', type: 'uint256'},
        ],
        stateMutability: 'nonpayable',
    },
] as const;
