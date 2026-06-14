// Hand-written ABI fragment for the Uniswap V4 StateView.
// We only read `getSlot0` to power the spot reference price for the
// SwapBox's price-impact row.
export const abi = [
    {
        type: 'function',
        name: 'getSlot0',
        inputs: [{name: 'poolId', type: 'bytes32'}],
        outputs: [
            {name: 'sqrtPriceX96', type: 'uint160'},
            {name: 'tick', type: 'int24'},
            {name: 'protocolFee', type: 'uint24'},
            {name: 'lpFee', type: 'uint24'},
        ],
        stateMutability: 'view',
    },
] as const;
