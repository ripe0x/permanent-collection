// Hand-written ABI fragment for Uniswap's Universal Router. Only the
// `execute(bytes commands, bytes[] inputs, uint256 deadline)` entry is needed;
// every V4 swap from this app flows through it.
export const abi = [
    {
        type: 'function',
        name: 'execute',
        inputs: [
            {name: 'commands', type: 'bytes'},
            {name: 'inputs', type: 'bytes[]'},
            {name: 'deadline', type: 'uint256'},
        ],
        outputs: [],
        stateMutability: 'payable',
    },
] as const;
