import {parseAbi, type Address, type PublicClient} from 'viem';
import {useReadContracts} from 'wagmi';

import {getChainId, getContractAddresses, getV4Infrastructure} from '@/lib/config';
import {buildPoolKey, computePoolId, type PoolKey} from '@/lib/swap/poolKey';
import {getHomageAddress, isHomageConfigured} from './config';

// Canonical CryptoPunks contracts (mainnet) — the ownership source for the holder-priority
// claim window. Raw ownership is `punkIndexToAddress`; a wrapped punk reports the wrapper as
// owner, so the true holder is the wrapper's `ownerOf` (mirrors Homage._isPunkHolder).
export const CRYPTOPUNKS_MARKET = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as const;
export const WRAPPED_PUNKS = '0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6' as const;

// Economic constants — mirror Homage.sol.
export const THRESHOLD = 50_000n * 10n ** 18n; // 50k $111 escrowed per homage
export const BASE_FEE = 5_000_000_000_000_000n; // 0.005 ETH — deploy default; real fee is mintFeeOf()
export const EXIT_FEE = 3_000_000_000_000_000n; // 0.003 ETH — deploy default; read exitFee() live before redeem (owner-tunable)

export const homageAbi = parseAbi([
    'function THRESHOLD() view returns (uint256)',
    'function exitFee() view returns (uint256)',
    'function SUPPLY() view returns (uint256)',
    'function remaining() view returns (uint256)',
    'function totalMinted() view returns (uint256)',
    'function isMinted(uint256 punkId) view returns (bool)',
    'function ownerOf(uint256 id) view returns (address)',
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenURI(uint256 id) view returns (string)',
    // per-wallet fee escalator (public mint)
    'function baseFee() view returns (uint256)',
    'function feeGrowthBps() view returns (uint256)',
    'function publicMints(address who) view returns (uint256)',
    'function mintFeeOf(address who) view returns (uint256)',
    // mint schedule (three windows)
    'function claimStart() view returns (uint64)',
    'function allowlistStart() view returns (uint64)',
    'function publicStart() view returns (uint64)',
    // allowlist
    'function allowlistRoot() view returns (bytes32)',
    'function maxPerAllowlisted() view returns (uint256)',
    'function allowlistMinted(address who) view returns (uint256)',
    // pool key immutables — the single source of truth for the pool Homage swaps
    // through (see fallbackPoolKey / getHomagePoolKey below)
    'function currency0() view returns (address)',
    'function currency1() view returns (address)',
    'function poolFee() view returns (uint24)',
    'function poolTickSpacing() view returns (int24)',
    'function poolHooks() view returns (address)',
    // mint paths
    'function mint() payable returns (uint256 punkId)',
    'function claim(uint256 punkId) payable returns (uint256)',
    'function claimFor(uint256 punkId, address vault) payable returns (uint256)',
    'function allowlistMint(bytes32[] proof) payable returns (uint256)',
    'function redeem(uint256 punkId) payable',
    'event Minted(address indexed to, uint256 indexed punkId, uint256 ethSwapped, uint256 received111)',
    'event Claimed(address indexed to, uint256 indexed punkId, uint256 ethSwapped, uint256 received111)',
    'event Redeemed(address indexed from, uint256 indexed punkId, uint256 amount111)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    // Custom errors — listed so viem can decode a revert selector to a named reason instead of
    // surfacing a bare `0x…` (shortErr then walks the cause chain to show the name). Mirrors Homage.sol.
    'error NotManager()',
    'error BadValue()',
    'error SoldOut()',
    'error Slippage(uint256 received, uint256 needed)',
    'error ClaimClosed()',
    'error AllowlistClosed()',
    'error PublicClosed()',
    'error NotPunkOwner()',
    'error NotDelegated()',
    'error AlreadyMinted()',
    'error NotAllowlisted()',
    'error AllowlistCapReached()',
    'error BadSchedule()',
]);

// CryptoPunks ownership reads for the claim window (verify `msg.sender` holds the punk).
// The raw market isn't ERC-721: current ownership is `punkIndexToAddress`. Raw-held punk
// ids are discovered via the server API (/api/owned-punks, data-adapter-backed) and then
// confirmed against `punkIndexToAddress`; the acquisition events stay in the ABI for
// decoding and any future consumer.
export const punksMarketAbi = parseAbi([
    'function punkIndexToAddress(uint256 index) view returns (address)',
    'event Assign(address indexed to, uint256 punkIndex)',
    'event PunkTransfer(address indexed from, address indexed to, uint256 punkIndex)',
    'event PunkBought(uint256 indexed punkIndex, uint256 value, address indexed fromAddress, address indexed toAddress)',
]);
// WrappedPunks is a canonical ERC-721Enumerable, so a holder's wrapped punks enumerate
// directly (balanceOf + tokenOfOwnerByIndex) with no log scan.
export const wrappedPunksAbi = parseAbi([
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
]);

// Delegate.xyz Registry v2 (canonical singleton) — a cold vault delegates a hot wallet, which
// then transacts the holder-priority claim via `claimFor` (the homage mints to the vault).
// `checkDelegateForERC721` is hierarchical (wallet-wide / contract / token all count); raw punks
// key against the MARKET, wrapped against WRAPPED_PUNKS. `getIncomingDelegations` lets the claim
// UI discover which vaults have delegated to the connected wallet in one read.
export const DELEGATE_REGISTRY = '0x00000000000000447e69651d841bD8D104Bed493' as const;
export const delegateRegistryAbi = parseAbi([
    'function checkDelegateForERC721(address to, address from, address contract_, uint256 tokenId, bytes32 rights) view returns (bool)',
    'struct Delegation { uint8 type_; address to; address from; bytes32 rights; address contract_; uint256 tokenId; uint256 amount; }',
    'function getIncomingDelegations(address to) view returns (Delegation[])',
]);

// v4 StateView — read the pool's current price (sqrtPriceX96) for a spot estimate.
export const stateViewAbi = parseAbi([
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

// v4 Quoter — simulate the real ETH→$111 swap (LP fee + 6% skim + price impact all
// reflected) so the mint cost is honest, not a naive spot number. Not a `view` in the
// ABI, but it's designed to be eth_call'd; readContract simulates it fine.
export const v4QuoterAbi = parseAbi([
    'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
    'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
    'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

// ─── Pool-key resolution ───────────────────────────────────────────────────────
//
// Homage stores its pool key as public immutables (currency0, currency1, poolFee,
// poolTickSpacing, poolHooks) — the pool the quotes below run against is read FROM
// THE CONTRACT, a single source of truth that can never drift, and works identically
// on mainnet and any fork wiring.

/** PC's canonical 111 pool. On mainnet this IS the pool Homage swaps through;
 *  pre-homage-deploy it lets the calculator price the live pool anyway. */
export function fallbackPoolKey(): PoolKey {
    return buildPoolKey(getContractAddresses().token);
}

const poolKeyCache = new Map<Address, Promise<PoolKey>>();

/** Resolve the pool Homage swaps through. Configured: multicall the 5 pool-key
 *  immutables off the homage contract and cache the result (immutables never
 *  change, so the in-flight/settled promise is cached per homage address).
 *  Unconfigured: fall back to PC's canonical 111 pool. */
export async function getHomagePoolKey(client: PublicClient): Promise<PoolKey> {
    if (!isHomageConfigured()) return fallbackPoolKey();
    const homage = getHomageAddress()!;
    const cached = poolKeyCache.get(homage);
    if (cached) return cached;

    const promise = client
        .multicall({
            contracts: [
                {address: homage, abi: homageAbi, functionName: 'currency0'},
                {address: homage, abi: homageAbi, functionName: 'currency1'},
                {address: homage, abi: homageAbi, functionName: 'poolFee'},
                {address: homage, abi: homageAbi, functionName: 'poolTickSpacing'},
                {address: homage, abi: homageAbi, functionName: 'poolHooks'},
            ],
            allowFailure: false,
        })
        .then(([currency0, currency1, fee, tickSpacing, hooks]) => ({
            currency0,
            currency1,
            fee,
            tickSpacing,
            hooks,
        })) as Promise<PoolKey>;

    poolKeyCache.set(homage, promise);
    return promise;
}

/** Client hook twin of {@link getHomagePoolKey}. Configured: `useReadContracts`
 *  of the 5 pool-key immutables (infinite staleTime — they never change).
 *  Unconfigured: returns the fallback pool key synchronously. */
export function useHomagePoolKey(): {key?: PoolKey; poolId?: `0x${string}`} {
    const configured = isHomageConfigured();
    const homage = getHomageAddress();

    const chainId = getChainId();
    const {data} = useReadContracts({
        contracts: homage
            ? [
                  {address: homage, abi: homageAbi, functionName: 'currency0', chainId},
                  {address: homage, abi: homageAbi, functionName: 'currency1', chainId},
                  {address: homage, abi: homageAbi, functionName: 'poolFee', chainId},
                  {address: homage, abi: homageAbi, functionName: 'poolTickSpacing', chainId},
                  {address: homage, abi: homageAbi, functionName: 'poolHooks', chainId},
              ]
            : [],
        query: {
            enabled: configured && homage !== undefined,
            staleTime: Infinity,
            gcTime: 3_600_000,
        },
    });

    if (!configured || !homage) {
        const key = fallbackPoolKey();
        return {key, poolId: computePoolId(key)};
    }

    const currency0 = data?.[0]?.result as Address | undefined;
    const currency1 = data?.[1]?.result as Address | undefined;
    const fee = data?.[2]?.result as number | undefined;
    const tickSpacing = data?.[3]?.result as number | undefined;
    const hooks = data?.[4]?.result as Address | undefined;

    if (
        currency0 === undefined ||
        currency1 === undefined ||
        fee === undefined ||
        tickSpacing === undefined ||
        hooks === undefined
    ) {
        return {};
    }

    const key: PoolKey = {currency0, currency1, fee, tickSpacing, hooks};
    return {key, poolId: computePoolId(key)};
}

/** Throws when the Homage contract isn't configured yet, so the write flows below
 *  fail loud instead of sending a tx to the zero address. Resolved at call time
 *  (not module load) so the runtime-config launch flip needs no rebuild. */
function requireHomageAddress(): Address {
    const address = getHomageAddress();
    if (!address) throw new Error('Homage contract not configured');
    return address;
}

/**
 * One-click ETH mint — the single path. Send `ethForSwap + MINT_FEE` as `value` to
 * `Homage.mint()`; the contract swaps `ethForSwap` into >= THRESHOLD $111, escrows
 * exactly THRESHOLD inside a new random homage minted to you, refunds any excess
 * $111/ETH, and reverts on slippage if the swap nets < THRESHOLD.
 *
 * Redeem: `Homage.redeem(punkId)` with `value` = the live `exitFee()` (owner-tunable, so
 * read it before the tx) — burns it and returns the full THRESHOLD $111.
 */
export function mintValue(ethForSwap: bigint, fee: bigint): bigint {
    return ethForSwap + fee;
}

export const homageFlows = {
    mint: (value: bigint) => ({address: requireHomageAddress(), abi: homageAbi, functionName: 'mint', value}) as const,
    claim: (punkId: bigint, value: bigint) =>
        ({address: requireHomageAddress(), abi: homageAbi, functionName: 'claim', args: [punkId], value}) as const,
    claimFor: (punkId: bigint, vault: `0x${string}`, value: bigint) =>
        ({address: requireHomageAddress(), abi: homageAbi, functionName: 'claimFor', args: [punkId, vault], value}) as const,
    allowlistMint: (proof: readonly `0x${string}`[], value: bigint) =>
        ({address: requireHomageAddress(), abi: homageAbi, functionName: 'allowlistMint', args: [proof], value}) as const,
    redeem: (punkId: bigint, value: bigint) =>
        ({address: requireHomageAddress(), abi: homageAbi, functionName: 'redeem', args: [punkId], value}) as const,
};

/** "Ethereum" on mainnet, else the local anvil-fork label — replaces the source's
 *  `activeChain.name` (PC has no dedicated fork-chain object; chain id 1 is the
 *  only "real" chain, everything else here is the local mainnet fork). */
export function homageChainName(): string {
    return getChainId() === 1 ? 'Ethereum' : 'Anvil (mainnet fork)';
}

// ─── Quote the mint cost ───────────────────────────────────────────────────────
//
// What ETH should `mint()` swap so it nets >= THRESHOLD $111? We read spot price
// (StateView) to size a probe, run ONE real quote through the live pool (V4Quoter —
// reflects the LP fee, the 6% skim, and price impact), then scale linearly to clear
// THRESHOLD with a small safety margin. The swap is exact-input, so all `ethForSwap`
// is spent; any $111 over THRESHOLD is refunded, and the contract reverts if the swap
// underflows THRESHOLD — so erring slightly high is safe.

const Q192 = 1n << 192n;
const WAD = 10n ** 18n;

export type MintQuote = {
    ethForSwap: bigint; // ETH the mint will route into the pool
    totalValue: bigint; // tx value = ethForSwap + the caller's current mint fee
    fee: bigint; // the ETH fee folded in (mintFeeOf for public; baseFee for claim/allowlist)
    estReceived: bigint; // ~$111 the swap nets (>= THRESHOLD)
    estRefund: bigint; // ~$111 over THRESHOLD, refunded to the minter
    spotEthForThreshold: bigint; // naive spot ETH for exactly THRESHOLD (no fee/skim/impact)
    price111PerEth: bigint; // $111 (1e18) per 1 ETH, for display
    safetyBps: number;
};

async function quoteExactInput(client: PublicClient, key: PoolKey, ethIn: bigint): Promise<bigint> {
    const res = (await client.readContract({
        address: getV4Infrastructure().quoter,
        abi: v4QuoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{poolKey: key, zeroForOne: true, exactAmount: ethIn, hookData: '0x'}],
    })) as readonly [bigint, bigint];
    return res[0];
}

/**
 * Quote the mint. `fee` is the ETH fee to fold into the tx value (the caller's
 * `mintFeeOf()` for a public mint, or `baseFee()` for a claim / allowlist mint).
 * `safetyBps` is headroom over THRESHOLD (default 5%) to absorb price drift between
 * quote and tx; the excess $111 is refunded, so it costs the minter nothing but a
 * little ETH that comes back as $111.
 */
export async function quoteMint(client: PublicClient, fee: bigint, safetyBps = 500): Promise<MintQuote> {
    const key = await getHomagePoolKey(client);
    const poolId = computePoolId(key);

    const slot0 = (await client.readContract({
        address: getV4Infrastructure().stateView,
        abi: stateViewAbi,
        functionName: 'getSlot0',
        args: [poolId],
    })) as readonly [bigint, number, number, number];
    const sqrtP = slot0[0];
    if (sqrtP === 0n) throw new Error('pool not initialized');

    // price = currency1/currency0 = $111 (1e18) per 1 ETH (1e18) = sqrtP^2 / 2^192.
    const price111PerEth = (sqrtP * sqrtP * WAD) / Q192;
    // naive spot ETH (wei) to buy exactly THRESHOLD $111 — the probe (and a display ref).
    const spotEthForThreshold = (THRESHOLD * Q192) / (sqrtP * sqrtP);
    const probe = spotEthForThreshold > 0n ? spotEthForThreshold : WAD / 1000n;

    // zeroForOne stays true — currency0 is native ETH in this pool.
    const out = await quoteExactInput(client, key, probe);
    if (out === 0n) throw new Error('quote returned zero');

    // Scale linearly to clear THRESHOLD + safety; +1 wei guards integer-floor undershoot.
    const target = (THRESHOLD * BigInt(10000 + safetyBps)) / 10000n;
    const ethForSwap = (probe * target) / out + 1n;
    const estReceived = (out * ethForSwap) / probe;
    const estRefund = estReceived > THRESHOLD ? estReceived - THRESHOLD : 0n;

    return {
        ethForSwap,
        totalValue: ethForSwap + fee,
        fee,
        estReceived,
        estRefund,
        spotEthForThreshold,
        price111PerEth,
        safetyBps,
    };
}
