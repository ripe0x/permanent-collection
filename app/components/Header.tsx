'use client';

/* Sticky translucent header. Holds logo + live bid chip on the left,
   nav + Trade CTA + ConnectButton on the right. The live bid uses the
   shared `useLiveBidBalance` so a single react-query entry feeds every
   chip on the page. Mobile: secondary nav collapses behind a menu
   toggle so the Trade CTA + connect remain reachable on small screens.
   Pre-launch the Trade CTA leads to the "not launched yet" gate, but the
   ConnectButton stays active so visitors can connect a wallet ahead of
   launch (e.g. to check eligibility, prep for the moment trading opens). */
import Link from 'next/link';
import {useEffect, useState} from 'react';

import {ConnectButton} from './ConnectButton';
import {getTokenTicker} from '@/lib/config';
import {useIncreaseFlash} from '@/lib/data/useIncreaseFlash';
import {useLiveBidBalance} from '@/lib/data/useLiveBidBalance';
import {formatEth} from '@/lib/format';

const TOKEN_SYMBOL = getTokenTicker();

function HeaderLiveBid() {
    const {value} = useLiveBidBalance();
    // First-paint: no value yet. Render a fixed-width placeholder so the
    // header doesn't jump when the first poll lands. Two ticks in (~4s)
    // the chip starts reflecting `Patron.bidBalance()`.
    const display = value === undefined ? '—' : formatEth(value);
    // When the bid rises (anyone's trade, picked up by the poll), flash green:
    // a stroke pulse around the chip and a matching pulse on the value text.
    // Keying both off the delta remounts them on each increase so the CSS
    // animation replays. Green matches the /trade live-bid increase affordance.
    const flashDelta = useIncreaseFlash(value, 1200);
    const flashing = flashDelta > 0n;
    return (
        <Link
            href="/bid"
            className="header-bid"
            aria-label={`Live bid: ${display}`}
            title="Live bid — Patron.bidBalance(). Click to accept the bid with a Punk."
        >
            <span className="header-bid-label">live bid</span>
            <span
                key={flashing ? `flash-${flashDelta}` : 'idle'}
                className={`header-bid-value tnum${flashing ? ' is-flashing' : ''}`}
            >
                {display}
            </span>
            {flashing && (
                <span
                    key={flashDelta.toString()}
                    className="header-bid-flash"
                    aria-hidden="true"
                />
            )}
        </Link>
    );
}

export function Header() {
    const [open, setOpen] = useState(false);

    // Close the menu on route change. App-router doesn't fire `popstate`
    // for client-side nav, so the simplest reliable trigger is a click
    // on any nav link inside the drawer — handled by `onLinkClick`.
    const onLinkClick = () => setOpen(false);

    // Close drawer on Escape, body-scroll lock while open.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prev;
        };
    }, [open]);

    return (
        <>
            <header className="header">
                <div className="header-inner">
                    <div className="header-left">
                        <Link href="/" className="logo" onClick={onLinkClick}>
                            Permanent Collection
                        </Link>
                        <HeaderLiveBid />
                    </div>
                    <nav className="nav" aria-label="Primary navigation">
                        <Link href="/collection" className="nav-link">
                            Collection
                        </Link>
                        <Link href="/auction" className="nav-link">
                            Auctions
                        </Link>
                        <Link href="/trade" className="trade">
                            Trade {TOKEN_SYMBOL}
                        </Link>
                        <ConnectButton />
                    </nav>
                    <button
                        type="button"
                        className="nav-toggle"
                        aria-expanded={open}
                        aria-controls="header-mobile-drawer"
                        aria-label={open ? 'Close menu' : 'Open menu'}
                        onClick={() => setOpen((v) => !v)}
                    >
                        <span
                            className={`nav-toggle-bars ${open ? 'is-open' : ''}`}
                            aria-hidden="true"
                        >
                            <span />
                            <span />
                            <span />
                        </span>
                    </button>
                </div>
            </header>

            {/* Drawer is a SIBLING of <header>, not a child — the header has
               `backdrop-filter: blur(...)`, which creates a containing block
               for any fixed-position descendant. Putting the drawer inside
               <header> trapped it to the header's 54px tall box. */}
            <div
                id="header-mobile-drawer"
                className={`mobile-drawer ${open ? 'mobile-drawer-open' : ''}`}
                hidden={!open}
            >
                <nav className="mobile-nav" aria-label="Mobile navigation">
                    <Link href="/collection" className="mobile-nav-link" onClick={onLinkClick}>
                        Collection
                    </Link>
                    <Link href="/auction" className="mobile-nav-link" onClick={onLinkClick}>
                        Auctions
                    </Link>
                    <Link
                        href="/trade"
                        className="mobile-nav-link mobile-nav-trade"
                        onClick={onLinkClick}
                    >
                        Trade {TOKEN_SYMBOL}
                    </Link>
                    <div className="mobile-nav-connect">
                        <ConnectButton />
                    </div>
                </nav>
            </div>

            <style>{styles}</style>
        </>
    );
}

const styles = `
.header {
    position: sticky;
    top: 0;
    z-index: 20;
    background: rgba(244, 244, 242, 0.88);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line);
}
.header-inner {
    height: 58px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 0 var(--pad);
    max-width: var(--max-wide);
    margin: 0 auto;
}
.header-left {
    display: flex;
    align-items: center;
    gap: 22px;
    min-width: 0;
}
.logo {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
}
.header-bid {
    position: relative;
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    padding: 5px 10px;
    border: 1px solid var(--line);
    background: var(--bg);
    transition: border-color 120ms ease;
}
.header-bid:hover {
    border-color: var(--ink);
}
.header-bid-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
}
.header-bid-value {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
    white-space: nowrap;
}
/* Green stroke pulse on the chip when the live bid rises. Absolutely
   positioned over the chip's border so it never shifts the header layout
   (safe on every viewport). One soft pulse — border + glow fade in, then out. */
.header-bid-flash {
    position: absolute;
    inset: -1px;
    pointer-events: none;
    border: 1px solid #2a8a3e;
    box-shadow: 0 0 6px 1px rgba(42, 138, 62, 0.45);
    animation: header-bid-flash 1100ms ease-out forwards;
}
@keyframes header-bid-flash {
    0%   { opacity: 0; }
    18%  { opacity: 1; }
    100% { opacity: 0; }
}
/* Value text pulses to the same green and settles back to its normal color. */
.header-bid-value.is-flashing {
    animation: header-bid-value-flash 1100ms ease-out;
}
@keyframes header-bid-value-flash {
    0%   { color: var(--accent); }
    18%  { color: #2a8a3e; }
    60%  { color: #2a8a3e; }
    100% { color: var(--accent); }
}
.preview-chip {
    display: inline-flex;
    align-items: center;
    padding: 4px 9px;
    border: 1px dashed var(--line);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    background: transparent;
}
.nav {
    display: flex;
    align-items: center;
    gap: 22px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.nav-link:hover {
    color: var(--ink);
}
.nav .trade {
    border: 1px solid var(--ink);
    color: var(--ink);
    padding: 9px 15px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
    transition: background 120ms ease, color 120ms ease;
}
.nav .trade:hover {
    background: var(--ink);
    color: var(--bg);
}
.nav-toggle {
    display: none;
    width: 38px;
    height: 38px;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--line);
    cursor: pointer;
    padding: 0;
}
.nav-toggle:hover {
    border-color: var(--ink);
}
.nav-toggle-bars {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    width: 16px;
    height: 11px;
    position: relative;
}
.nav-toggle-bars span {
    display: block;
    width: 100%;
    height: 1.5px;
    background: var(--ink);
    transition: transform 180ms ease, opacity 180ms ease;
}
.nav-toggle-bars.is-open span:nth-child(1) {
    transform: translateY(4.5px) rotate(45deg);
}
.nav-toggle-bars.is-open span:nth-child(2) {
    opacity: 0;
}
.nav-toggle-bars.is-open span:nth-child(3) {
    transform: translateY(-4.5px) rotate(-45deg);
}
.mobile-drawer {
    position: fixed;
    inset: 58px 0 0 0;
    background: var(--bg);
    border-top: 1px solid var(--line);
    z-index: 19;
    overflow-y: auto;
    animation: drawer-in 180ms ease-out;
}
@keyframes drawer-in {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
}
.mobile-nav {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 12px var(--pad);
}
.mobile-nav-link {
    font-family: var(--mono);
    font-size: 16px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink);
    padding: 18px 4px;
    border-bottom: 1px solid var(--line);
    transition: color 120ms ease;
}
.mobile-nav-link:hover {
    color: var(--accent);
}
.mobile-nav-trade {
    color: var(--accent);
}
.mobile-nav-connect {
    margin-top: 24px;
    padding: 0 4px;
}

/* Collapse the inline nav to the drawer toggle once the full row (links +
   Trade CTA + connect button) can no longer share one line with the logo
   and live-bid chip. The single-line layout needs ~985px of viewport; 1024
   keeps a comfortable margin above that so the buttons never wrap to two
   lines and the chip never overlaps the links. */
@media (max-width: 1024px) {
    .nav {
        display: none;
    }
    .nav-toggle {
        display: flex;
    }
}

/* Phone-only trims: shorter bar, tighter spacing, drop the live-bid label
   (the value alone carries it), pull the drawer up to the shorter header. */
@media (max-width: 760px) {
    .header-inner {
        height: 54px;
        gap: 12px;
    }
    .header-left {
        gap: 14px;
    }
    .mobile-drawer {
        inset: 54px 0 0 0;
    }
    .header-bid {
        padding: 4px 8px;
    }
    .header-bid-label {
        display: none;
    }
}
@media (max-width: 380px) {
    .logo {
        font-size: 10px;
        letter-spacing: 0.08em;
    }
}
`;
