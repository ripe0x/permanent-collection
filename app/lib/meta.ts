import type {Metadata} from 'next';

const SITE_NAME = 'Permanent Collection';
const SITE_TAGLINE = 'A public bid for Punk traits, funded by official pool trading.';

/** The canonical production origin. Every published URL (metadata, OG images,
 *  referral links, the docs' machine-readable surfaces) resolves to this
 *  unless an explicit override is set. */
export const CANONICAL_SITE_URL = 'https://permanentcollection.art';

function siteUrl(): string {
    // 1. NEXT_PUBLIC_SITE_URL — explicit override, always wins.
    if (process.env.NEXT_PUBLIC_SITE_URL) {
        return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
    }
    // 2. Deploy previews / branch deploys point at themselves (DEPLOY_PRIME_URL)
    //    so their OG images resolve on the preview host. `CONTEXT` is set by
    //    Netlify and is 'production' only for the live site.
    if (
        process.env.CONTEXT &&
        process.env.CONTEXT !== 'production' &&
        process.env.DEPLOY_PRIME_URL
    ) {
        return process.env.DEPLOY_PRIME_URL.replace(/\/$/, '');
    }
    // 3. Production and local dev: the fixed canonical domain, so published
    //    metadata never leaks a Netlify deploy subdomain. metadataBase only
    //    affects absolute URLs, which don't matter offline.
    return CANONICAL_SITE_URL;
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
