'use client';

/* Three states for the wallet-action button — render adapts so the
 * user always sees a single click that moves them forward:
 *
 *   1. Not connected           → "Connect wallet"        (opens RK connect modal)
 *   2. Connected, wrong chain  → "Switch to <chain>"     (opens RK chain modal)
 *   3. Connected, right chain  → short address + dot     (opens RK account modal)
 *
 * Wired through RainbowKit's `ConnectButton.Custom` render-prop so the
 * wallet picker / chain switcher / account modal come for free, but the
 * trigger keeps the protocol's own look (mono caps, ink border, accent
 * dot). State (2) hands off to RainbowKit's chain modal — it speaks the
 * same `wallet_switchEthereumChain` / `wallet_addEthereumChain` flow our
 * old `useSwitchChain` did, plus a clean UI when several chains are in
 * the config (only happens in fork mode here).
 */

import {ConnectButton as RKConnectButton} from '@rainbow-me/rainbowkit';
import {shortAddress} from '@/lib/format';
import {getChainId, getTokenTicker} from '@/lib/config';

export function ConnectButton({disabled = false}: {disabled?: boolean}) {
    // Pre-launch there's nothing to connect a wallet for — render an inert
    // button (no wallet modal) so the "not launched" state reads honestly
    // everywhere the connect button appears (header + swap box).
    if (disabled) {
        return (
            <>
                <button
                    type="button"
                    className="connect-button"
                    disabled
                    title={`${getTokenTicker()} hasn't launched yet`}
                >
                    Not launched
                </button>
                <style>{styles}</style>
            </>
        );
    }
    return (
        <RKConnectButton.Custom>
            {({account, chain, openAccountModal, openChainModal, openConnectModal, mounted}) => {
                // SSR: render an empty placeholder of the same height so the
                // header doesn't jump when the client hydrates.
                const ready = mounted;
                const connected = ready && !!account && !!chain;

                // RainbowKit's `chain.unsupported` only flags chains that
                // aren't in the wagmi config at all. In multi-chain (fork)
                // configs the wallet can be on a *supported* chain that
                // still isn't the one this page expects — RainbowKit shows
                // the account chip, but the rest of the app (SwapBox, bid
                // flows) treats it as wrong-network and hides their action
                // buttons. Compare against the app's expected chain so we
                // surface a working "Switch network" CTA in that case too.
                const onWrongNetwork =
                    connected && (chain.unsupported || chain.id !== getChainId());

                return (
                    <div
                        aria-hidden={!ready}
                        style={
                            !ready
                                ? {opacity: 0, pointerEvents: 'none', userSelect: 'none'}
                                : undefined
                        }
                    >
                        {(() => {
                            // ── State 1: not connected ───────────────────────
                            if (!connected) {
                                return (
                                    <button
                                        type="button"
                                        className="connect-button"
                                        onClick={openConnectModal}
                                    >
                                        Connect wallet
                                    </button>
                                );
                            }
                            // ── State 2: connected, wrong chain ──────────────
                            if (onWrongNetwork) {
                                return (
                                    <button
                                        type="button"
                                        className="connect-button switch"
                                        onClick={openChainModal}
                                        aria-label={`Connected to chain ${chain.id}. Click to switch to chain ${getChainId()}.`}
                                        title={`Wallet is on chain ${chain.id}; this page expects chain ${getChainId()}.`}
                                    >
                                        <span className="dot dot-warn" aria-hidden="true" />
                                        Wrong network
                                    </button>
                                );
                            }
                            // ── State 3: connected, right chain ──────────────
                            return (
                                <button
                                    type="button"
                                    className="connect-button connected"
                                    onClick={openAccountModal}
                                    aria-label={`Connected as ${account.address}. Click to manage wallet.`}
                                >
                                    <span className="dot" aria-hidden="true" />
                                    {shortAddress(account.address)}
                                </button>
                            );
                        })()}
                        <style>{styles}</style>
                    </div>
                );
            }}
        </RKConnectButton.Custom>
    );
}

const styles = `
.connect-button {
    font-family: var(--mono);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border: 1px solid var(--ink);
    color: var(--ink);
    background: transparent;
    padding: 9px 15px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
    transition: background 120ms ease, color 120ms ease;
}
.connect-button:hover:not(:disabled) {
    background: var(--ink);
    color: var(--bg);
}
.connect-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.connect-button .dot {
    width: 7px;
    height: 7px;
    background: var(--accent);
    border-radius: 50%;
}
.connect-button.connected {
    /* identical, but with the dot */
}
.connect-button.switch {
    border-color: var(--accent);
    color: var(--accent);
}
.connect-button.switch:hover:not(:disabled) {
    background: var(--accent);
    color: var(--bg);
}
.connect-button .dot-warn {
    background: var(--accent);
}
`;
