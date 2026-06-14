// Quote-side utilities. The actual amount-out calc is delegated to the
// Uniswap V4 Quoter (which simulates hooks on-chain); these helpers handle
// slippage tolerance, price-impact, and display formatting.

const Q96 = 2n ** 96n;

/** Apply slippage tolerance (in basis points) to an expected output amount. */
export function getMinimumOut(expectedOut: bigint, slippageBps: number): bigint {
    if (slippageBps <= 0) return expectedOut;
    return (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Price impact of a swap, as a signed fraction. Compares the realized
 * exchange rate (`amountOut / amountIn`) to the pool's spot rate implied by
 * `sqrtPriceX96`.
 *
 * Sign convention:
 *   NEGATIVE = unfavorable (user got less than spot)
 *   POSITIVE = favorable   (rare; hook rebate or stale spot)
 *
 * Returns 0 if spot rate isn't available or inputs are zero.
 *
 * `sqrtPriceX96` encodes sqrt(token1/token0). When `zeroForOne` the user pays
 * currency0 and receives currency1, so spot output rate is `price`; otherwise
 * it's `1 / price`.
 */
export function getPriceImpactFromAmounts(
    amountIn: bigint,
    amountOut: bigint,
    sqrtPriceX96: bigint | undefined,
    zeroForOne: boolean,
): number {
    if (!sqrtPriceX96 || amountIn === 0n || amountOut === 0n) return 0;
    const sqrt = Number(sqrtPriceX96) / Number(Q96);
    const price = sqrt * sqrt;
    const spotOutPerIn = zeroForOne ? price : 1 / price;
    const realizedOutPerIn = Number(amountOut) / Number(amountIn);
    if (spotOutPerIn <= 0) return 0;
    return (realizedOutPerIn - spotOutPerIn) / spotOutPerIn;
}

/**
 * Token-in-paired-currency spot rate from `sqrtPriceX96`. Returns the
 * value of one whole token in the pool's other (paired) currency.
 *
 * For the native-ETH-paired 111 pool, currency0 is ETH and currency1
 * is the token, so the returned value is ETH per token. Multiply by
 * `ethPriceUsd` to get the synthetic `tokenPriceUsd` we display when
 * GeckoTerminal hasn't indexed the token yet.
 */
export function tokenPriceInPaired(
    sqrtPriceX96: bigint | undefined,
    tokenIsToken0: boolean,
): number | null {
    if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return null;
    const sqrt = Number(sqrtPriceX96) / Number(Q96);
    const raw = sqrt * sqrt;
    if (raw === 0) return null;
    // raw = token1 / token0. If the token is token0, raw is paired/token.
    // If it's token1 (our case — currency0 = ETH), invert.
    return tokenIsToken0 ? raw : 1 / raw;
}

/**
 * Format a USD value the way GeckoTerminal / DexScreener do. Uses
 * subscript notation for tiny values (e.g. `$0.0₄128` reads "0.0 with
 * four leading zeros, then 128"), so a freshly-launched artcoin
 * doesn't display as `1.28e-5`.
 */
export function formatUsd(value: number | null | undefined): string {
    if (value == null || !isFinite(value) || value <= 0) return '—';
    if (value < 0.001) {
        const [mantissaStr, expStr] = value.toExponential().split('e');
        const exponent = parseInt(expStr, 10);
        const leadingZeros = -exponent - 1;
        const sig = mantissaStr.replace('.', '').slice(0, 3);
        if (leadingZeros < 0 || sig.length === 0) return '—';
        const SUBSCRIPT = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
        const subscript = leadingZeros
            .toString()
            .split('')
            .map((d) => SUBSCRIPT[Number(d)])
            .join('');
        return `$0.0${subscript}${sig}`;
    }
    if (value < 1) return `$${value.toFixed(4)}`;
    if (value < 1000) return `$${value.toFixed(2)}`;
    if (value < 1_000_000) return `$${(value / 1000).toFixed(2)}K`;
    if (value < 1_000_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
}

/**
 * Format a bigint token amount (wei) for display. Uses thousand separators
 * for values ≥ 1, and up to six significant fractional digits for values < 1.
 * Trailing zeros are trimmed. Designed to look good across the full range
 * (`0.00000012` … `212,854.12`).
 */
export function formatTokenAmount(amount: bigint, decimals = 18): string {
    const divisor = 10n ** BigInt(decimals);
    const whole = amount / divisor;
    const frac = amount % divisor;

    if (whole === 0n) {
        if (frac === 0n) return '0';
        const fracStr = frac.toString().padStart(decimals, '0');
        const firstNonZero = fracStr.search(/[^0]/);
        const end = Math.min(firstNonZero + 6, fracStr.length);
        const trimmed = fracStr.slice(0, end).replace(/0+$/, '') || '0';
        return `0.${trimmed}`;
    }

    const wholeStr = whole.toLocaleString('en-US');
    const sigDigitsLeft = Math.max(0, 8 - whole.toString().length);
    const fracDigits = Math.min(6, sigDigitsLeft);
    if (fracDigits === 0) return wholeStr;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, fracDigits);
    const trimmed = fracStr.replace(/0+$/, '');
    return trimmed ? `${wholeStr}.${trimmed}` : wholeStr;
}
