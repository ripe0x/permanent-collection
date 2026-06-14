// Display helpers. All numbers on screen route through here so units +
// precision are consistent.

import {formatEther} from 'viem';

/** ETH amount → "47.182 ETH" style, up to `decimals` places with trailing
 *  zeros (and a dangling decimal point) trimmed: 33→"33 ETH", 0.5→"0.5 ETH",
 *  0→"0 ETH". */
export function formatEth(wei: bigint, decimals = 3): string {
    const sign = wei < 0n ? '-' : '';
    const abs = wei < 0n ? -wei : wei;
    const whole = abs / 10n ** 18n;
    const frac = abs % 10n ** 18n;
    // Fractional remainder as a fixed-width string, then trim trailing zeros.
    const scaled = (frac * 10n ** BigInt(decimals)) / 10n ** 18n;
    const fracStr = scaled.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${sign}${whole.toString()}${fracStr ? `.${fracStr}` : ''} ETH`;
}

/** Without unit, for inline contexts. */
export function formatEthBare(wei: bigint, decimals = 3): string {
    return formatEth(wei, decimals).replace(' ETH', '');
}

/** Whole-dollar USD with separators: "$23,412". For headline ETH→USD lines
 *  (the live-bid dollar annotation) where compaction would drop real
 *  precision. Values under $1 keep cents so a near-zero figure doesn't
 *  render as "$0". */
export function formatUsdWhole(usd: number): string {
    if (!isFinite(usd)) return '—';
    const digits = Math.abs(usd) < 1 ? 2 : 0;
    return usd.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}

/** Compact USD: $2.9M / $402K / $4,800 / $0.42. Returns null when the input
 *  is null/unusable so callers can choose between "—" and hiding the line. */
export function formatUsdCompact(usd: number | null): string | null {
    if (usd == null || !isFinite(usd)) return null;
    if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd >= 10_000_000 ? 0 : 1)}M`;
    if (usd >= 1_000) return `$${(usd / 1_000).toFixed(usd >= 10_000 ? 0 : 1)}K`;
    if (usd >= 1) return `$${usd.toLocaleString('en-US', {maximumFractionDigits: 0})}`;
    return `$${usd.toFixed(2)}`;
}

/** A positive increase in wei as "+0.123 ETH" (or "+0.0000123" / exponential
 *  for tiny deltas). Used by the green "+delta" flash badge on the live bid —
 *  in the header and on the /trade page. Returns "" for a non-positive delta. */
export function formatDelta(deltaWei: bigint): string {
    if (deltaWei <= 0n) return '';
    const eth = Number(formatEther(deltaWei));
    if (eth >= 0.001) return `+${eth.toFixed(3)} ETH`;
    if (eth >= 0.000001) return `+${eth.toFixed(6)} ETH`;
    return `+${eth.toExponential(2)} ETH`;
}

/** Round `wei` UP to `decimals` places (10^(18-decimals) granularity).
 *  `formatEth` truncates, so a "minimum" affordance seeded straight from a wei
 *  floor renders BELOW the real floor and, parsed back, drops under it — which
 *  is how a bid input pre-filled with the minimum can leave the submit button
 *  disabled. Ceiling to display precision gives the smallest value AT that
 *  precision that is still >= the true floor, so the default / chips round-trip
 *  through formatEth -> parseEther without ever falling below the minimum. */
export function ceilWeiToDecimals(wei: bigint, decimals = 3): bigint {
    if (wei <= 0n) return 0n;
    const unit = 10n ** BigInt(18 - decimals);
    return ((wei + unit - 1n) / unit) * unit;
}

/** "Mohawk" / "Cap" / "Pipe" etc. Resolves real names from PunksData when
 *  `names` is supplied; falls back to `Trait #N` for legacy callers that
 *  haven't been threaded through. */
export function formatTraitName(traitId: number, names?: readonly string[]): string {
    if (names && names[traitId] !== undefined) return names[traitId];
    return `Trait #${traitId}`;
}

/** Truncate "0xabcd…1234". */
export function shortAddress(addr: string): string {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Punk #N. */
export function formatPunk(punkId: number): string {
    return `Punk #${punkId}`;
}

/** A duration like "18h 24m" / "6h 12m" / "51h 38m" matching v3. */
export function formatDurationFromSeconds(secs: bigint): string {
    if (secs <= 0n) return '0m';
    const total = Number(secs);
    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    if (days > 0) return `${days}d ${hours.toString().padStart(2, '0')}h`;
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
}

/** Live-ticking countdown that ALWAYS surfaces minutes and seconds (days +
 *  hours fold in only when present): "2d 05h 12m 03s" / "5h 12m 03s" /
 *  "12m 03s". Used by the auction detail countdown so the clock visibly
 *  ticks second-by-second. */
export function formatCountdownPrecise(secs: bigint): string {
    if (secs <= 0n) return '0m 00s';
    const total = Number(secs);
    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    const seconds = total % 60;
    const ss = seconds.toString().padStart(2, '0');
    const mm = minutes.toString().padStart(2, '0');
    if (days > 0) {
        const hh = hours.toString().padStart(2, '0');
        return `${days}d ${hh}h ${mm}m ${ss}s`;
    }
    if (hours > 0) return `${hours}h ${mm}m ${ss}s`;
    return `${minutes}m ${ss}s`;
}

/** "2s ago" / "12m ago" / "3h ago" / "2d ago" — for the "as of" badges. */
export function formatRelative(timestampSecs: bigint): string {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const delta = now > timestampSecs ? now - timestampSecs : 0n;
    const secs = Number(delta);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86_400)}d ago`;
}

/** Multi-chain explorer link for a transaction hash. Project-wide
 *  convention is evm.now (chain-aware via the `chainId` query param)
 *  rather than chain-specific explorers. */
export function getEvmNowTxUrl(hash: string, chainId: number): string {
    return `https://evm.now/tx/${hash}?chainId=${chainId}`;
}

/** Multi-chain explorer link for an address (evm.now, chain-aware). */
export function getEvmNowAddressUrl(address: string, chainId: number): string {
    return `https://evm.now/address/${address}?chainId=${chainId}`;
}

/** Returns the % representation of a / b, clamped 0..100. */
export function ratioPct(a: bigint, b: bigint, decimals = 1): number {
    if (b === 0n) return 0;
    const scaled = (a * 10n ** BigInt(decimals + 2)) / b;
    const num = Number(scaled) / 10 ** decimals;
    if (num < 0) return 0;
    if (num > 100) return 100;
    return num;
}
