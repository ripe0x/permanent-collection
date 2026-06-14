'use client';

/**
 * ReferralShare — the sharing surface for a referral link.
 *
 * Given a referrer address (and optionally a cosmetic vanity slug), renders
 * the shareable link with copy-to-clipboard and native share where available.
 *
 * The link always resolves to the production origin (see `lib/referral/share`)
 * so a link copied from a deploy preview still points at the live site.
 *
 * Copy framing follows `docs/LANGUAGE_STYLE_GUIDE.md`: it describes routing
 * trading to the official pool, never investment / yield / earnings.
 */

import {useEffect, useState} from 'react';

import {getTokenTicker} from '@/lib/config';
import {FEES, fmtPct} from '@/lib/protocol-params';
import {displayLink, referralUrl, vanityUrl} from '@/lib/referral/share';

interface ReferralShareProps {
    /** The address credited as referrer — the link's `?ref=` target. */
    referrer?: `0x${string}`;
    /** Optional cosmetic vanity slug; when set, the primary link is
     *  `/r/<slug>` (which redirects to the same `?ref=`). */
    slug?: string;
    /** Compact variant for the swap-page nudge: tighter, no QR. */
    compact?: boolean;
    /** Minimal variant: a single subtle row — label + link + copy (and
     *  native share where available). No QR, no social intents. For an
     *  always-present "copy your link" affordance under the swap box. */
    minimal?: boolean;
}

/** Clipboard write with a legacy fallback for non-secure contexts where
 *  `navigator.clipboard` is unavailable. Returns true on success. */
async function copyText(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through to the legacy path
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

export function ReferralShare({
    referrer,
    slug,
    compact = false,
    minimal = false,
}: ReferralShareProps) {
    const [copied, setCopied] = useState(false);
    const [canShare, setCanShare] = useState(false);

    // Feature-detect native share after mount (SSR-safe). On desktop where
    // `navigator.share` is absent, copy is the primary action.
    useEffect(() => {
        setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    }, []);

    if (!referrer) {
        if (compact || minimal) return null;
        return (
            <div className="rs-root">
                <span className="rs-label">Share your referral link</span>
                <p className="rs-empty">Connect a wallet to get your referral link.</p>
                <style jsx>{styles}</style>
            </div>
        );
    }

    const ticker = getTokenTicker();
    const primary = slug ? vanityUrl(slug) : referralUrl(referrer);
    const rawLink = referralUrl(referrer);
    const shareText = `Trade ${ticker} on the official Permanent Collection pool.`;

    const onCopy = async () => {
        const ok = await copyText(primary);
        if (!ok) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
    };

    const onShare = () => {
        if (typeof navigator === 'undefined' || !navigator.share) return;
        void navigator
            .share({title: 'Permanent Collection', text: shareText, url: primary})
            .catch(() => {
                /* user dismissed the share sheet — no-op */
            });
    };

    if (minimal) {
        return (
            <div className="rs-min">
                <div className="rs-min-row">
                    <span className="rs-min-label">Your referral link</span>
                    <code className="rs-min-link tnum">{displayLink(primary)}</code>
                    <button
                        type="button"
                        className="rs-min-btn"
                        onClick={() => void onCopy()}
                    >
                        {copied ? 'Copied' : 'Copy'}
                    </button>
                    {canShare && (
                        <button type="button" className="rs-min-btn" onClick={onShare}>
                            Share
                        </button>
                    )}
                </div>
                <span className="rs-min-note">
                    Swaps routed through your link send up to{' '}
                    {fmtPct(FEES.referralCapPct)} of volume to you.{' '}
                    <a href="/referrals" className="rs-min-note-link">
                        Claim on the referrals page →
                    </a>
                </span>
                <style jsx>{styles}</style>
            </div>
        );
    }

    return (
        <div className={compact ? 'rs-root rs-compact' : 'rs-root'}>
            <span className="rs-label">Share your referral link</span>

            <div className="rs-linkrow">
                <code className="rs-link tnum">{displayLink(primary)}</code>
                <button type="button" className="rs-btn" onClick={() => void onCopy()}>
                    {copied ? 'Copied' : 'Copy'}
                </button>
                {canShare && (
                    <button type="button" className="rs-btn" onClick={onShare}>
                        Share
                    </button>
                )}
            </div>

            {/* When a vanity slug is the primary link, surface the raw
             *  address link too so it's clear both route to the same place. */}
            {slug && (
                <span className="rs-sub">
                    or your address link:{' '}
                    <code className="rs-sub-link tnum">{displayLink(rawLink)}</code>
                </span>
            )}

            <style jsx>{styles}</style>
        </div>
    );
}

const styles = `
    .rs-root {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }
    .rs-label {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .rs-empty {
        color: var(--muted);
        font-size: 14px;
        margin: 0;
    }
    .rs-linkrow {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .rs-link {
        font-size: 12px;
        color: var(--ink);
        word-break: break-all;
        flex: 1 1 auto;
        min-width: 0;
    }
    .rs-btn {
        border: 1px solid var(--line);
        background: transparent;
        color: var(--ink);
        padding: 6px 12px;
        font-family: var(--mono);
        font-size: 11px;
        cursor: pointer;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        text-decoration: none;
        white-space: nowrap;
    }
    .rs-btn:hover {
        background: var(--ink);
        color: var(--bg);
    }
    .rs-sub {
        font-size: 11px;
        color: var(--muted);
    }
    .rs-sub-link {
        color: var(--ink);
        word-break: break-all;
    }
    .rs-compact {
        gap: 8px;
    }
    /* Minimal variant: a subtle inline row plus a one-line note. */
    .rs-min {
        display: flex;
        flex-direction: column;
        gap: 5px;
    }
    .rs-min-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .rs-min-note {
        font-size: 11px;
        color: var(--muted);
        line-height: 1.5;
    }
    .rs-min-note-link {
        color: var(--muted);
        text-decoration: underline;
        text-underline-offset: 2px;
    }
    .rs-min-note-link:hover {
        color: var(--ink);
    }
    .rs-min-label {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .rs-min-link {
        font-size: 11px;
        color: var(--muted);
        word-break: break-all;
    }
    .rs-min-btn {
        border: none;
        background: transparent;
        color: var(--muted);
        padding: 0;
        font-family: var(--mono);
        font-size: 11px;
        cursor: pointer;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        text-decoration: underline;
        text-underline-offset: 2px;
    }
    .rs-min-btn:hover {
        color: var(--ink);
    }
`;
