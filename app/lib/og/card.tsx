/**
 * Shared builders for Permanent Collection Open Graph cards (1200×630 PNGs).
 *
 * Deliberately minimal — the tweet text carries the detail; the image just
 * shows the Punk (on its classic background) for Punk events, or a single
 * centered value for non-Punk events. No header/footer chrome.
 *
 * Punk art is the offline SDK's vector SVG (crisp at any size — a 24×24 PNG
 * would blur when satori upscales it). next/og, Node runtime.
 */

import { ImageResponse } from 'next/og';
import { getPunksSdk } from '@/lib/punks-sdk';
import { formatEth } from '@/lib/format';
import { pixelText } from './pixel-font';

export const OG_SIZE = { width: 1200, height: 630 };

export const CLASSIC_BG = '#638596'; // canonical CryptoPunks background
export const VAULTED_BG = '#8F918B'; // "collected / permanent" color (mosaic theme)
const TEXT = '#f5f5f5'; // pixel-font text color (matches the mosaic renderer)

/**
 * These cards are parameterized by the query string (e.g. ?amount=…), but the
 * Netlify CDN cache key for Next image routes ignores arbitrary query params
 * (it varies only on Next's own __nextDataReq/_rsc). Combined with next/og's
 * default `cache-control: public, immutable, max-age=31536000`, the FIRST
 * render for a given path got frozen for a year and served for every param
 * value after it — so /og/bid-level/5?amount=<7.74> returned the stale image
 * from an earlier /og/bid-level/5?amount=<7.64> request. Disabling the shared
 * cache makes every request render the actual params. These are cheap,
 * params-only, near-one-shot fetches (the bot uploads the image to Twitter
 * once; link scrapers cache on their own side), so losing the CDN layer here
 * costs effectively nothing and buys correctness.
 */
const OG_HEADERS = { 'cache-control': 'no-store, max-age=0' };
const ogOpts = { ...OG_SIZE, headers: OG_HEADERS };

/** Wei (decimal string) -> "12.34 ETH" (2 decimals, truncated; unit included).
 *  Truncation matches the bot's tweet-text formatter so the image and the post
 *  text always render the same number. */
export function ethStr(wei: string | null | undefined): string {
  try {
    return formatEth(BigInt(wei ?? '0'), 2);
  } catch {
    return '—';
  }
}

/** Crisp vector Punk, full bleed, no text. Background defaults to classic. */
export function buildPunkCard(punkId: number, background: string = CLASSIC_BG): ImageResponse {
  const uri = getPunksSdk().render.svgDataUri(punkId, { background: 'transparent' });
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={uri} width={630} height={630} alt="" />
      </div>
    ),
    ogOpts
  );
}

/**
 * A single centered value for non-Punk events, drawn in the on-chain pixel
 * font on the classic background (e.g. "0 / 111", "60 ETH", "1000 $111").
 */
export function buildValueCard(text: string): ImageResponse {
  const glyph = pixelText(text, TEXT);
  // Fixed glyph height (~10px per font-pixel) for a consistent, generously
  // spaced scale; shrink only if a long string would exceed the width cap.
  let scale = 70 / glyph.h;
  const maxWidth = 820;
  if (glyph.w * scale > maxWidth) scale = maxWidth / glyph.w;
  const width = Math.round(glyph.w * scale);
  const height = Math.round(glyph.h * scale);
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: CLASSIC_BG,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={glyph.src} width={width} height={height} alt="" />
      </div>
    ),
    ogOpts
  );
}

/**
 * The current Vault Title artwork as a square image (its on-chain SVG). Falls
 * back to the "VAULT TITLE" value card when the SVG isn't available yet
 * (e.g. before the protocol is live).
 */
export function buildTitleCard(svgMarkup: string | null): ImageResponse {
  if (!svgMarkup) return buildValueCard('VAULT TITLE');
  const uri = `data:image/svg+xml;base64,${Buffer.from(svgMarkup).toString('base64')}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: '#000000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={uri} width={630} height={630} alt="" />
      </div>
    ),
    ogOpts
  );
}
