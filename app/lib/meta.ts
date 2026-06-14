import type {Metadata} from 'next';

const SITE_NAME = 'Permanent Collection';
const SITE_TAGLINE = 'A public bid for Punk traits, funded by official pool trading.';

function siteUrl(): string {
    // Priority:
    //  1. NEXT_PUBLIC_SITE_URL — explicit override
    //  2. DEPLOY_PRIME_URL — Netlify exposes this on every deploy; matches the
    //     current context (production OR deploy preview), so PR previews get
    //     OG images that point back at themselves
    //  3. URL — Netlify's canonical site URL (== DEPLOY_PRIME_URL in production)
    //  4. empty string — local dev. Next.js then defaults metadataBase to
    //     http://localhost:3000, which is fine for dev but would leak that URL
    //     into deployed metadata if any of the above were missing — hence the
    //     explicit Netlify fallbacks.
    const raw =
        process.env.NEXT_PUBLIC_SITE_URL ??
        process.env.DEPLOY_PRIME_URL ??
        process.env.URL ??
        '';
    return raw.replace(/\/$/, '');
}

/** Build a full Metadata object for a page. Title gets the
 *  "Page · Permanent Collection" pattern automatically (unless `bareTitle`
 *  is set, e.g. for the home page where the site name IS the title).
 *  Separator is an interpunct (U+00B7), not a dash — explicit no-dash
 *  rule across all surfaces of the protocol's published metadata. */
export function buildMeta(opts: {
    title: string;
    bareTitle?: boolean;
    description: string;
    path: string;
    ogPath?: string;
}): Metadata {
    const fullTitle = opts.bareTitle ? opts.title : `${opts.title} · ${SITE_NAME}`;
    const base = siteUrl();
    const url = `${base}${opts.path}`;
    const ogUrl = `${base}${opts.ogPath ?? '/og.png'}`;

    return {
        title: fullTitle,
        description: opts.description,
        applicationName: SITE_NAME,
        metadataBase: base ? new URL(base) : undefined,
        openGraph: {
            title: fullTitle,
            description: opts.description,
            siteName: SITE_NAME,
            url,
            type: 'website',
            images: [
                {
                    url: ogUrl,
                    width: 1200,
                    height: 675,
                    alt: opts.title,
                },
            ],
        },
        twitter: {
            card: 'summary_large_image',
            title: fullTitle,
            description: opts.description,
            images: [ogUrl],
        },
    };
}

export const TAGLINE = SITE_TAGLINE;
