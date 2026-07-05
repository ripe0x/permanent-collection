import { parseAbi } from 'viem';

// Cold archive forks are slow/flaky for uncached punks: the first read of a punk
// triggers an upstream archive fetch, and concurrent reads of a fresh punk can race
// and fail. Retry with backoff so a transient failure self-heals once anvil caches
// the punk (the same resilience the preview batch grid already uses).
export const READ_RETRY = {
    retry: 6,
    retryDelay: (i: number) => Math.min(800 * 2 ** i, 6000),
} as const;

export const rendererAbi = parseAbi([
    'function previewSVG(uint256 id, uint8 status, address holder) view returns (string)',
    'function previewTokenURI(uint256 id, uint8 status, address holder) view returns (string)',
    'function renderSVG(uint256 id) view returns (string)',
    'function tokenURI(uint256 id) view returns (string)',
    // PFP (circle) variant — same metadata, art rendered as circles.
    'function renderSVGPfp(uint256 id) view returns (string)',
    'function tokenURIPfp(uint256 id) view returns (string)',
    'function colorCount(uint256 id) view returns (uint256)',
]);
