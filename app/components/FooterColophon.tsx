'use client';

/* Footer bottom bar: the $111 token address (linked to evm.now, one-click
   copy) on the left, the "created by ripe" credit on the right. The token
   chip only appears once the protocol is live (the token has bytecode), so
   it never points at a not-yet-deployed address — mirrors DexscreenerLink /
   ContractAddress. The credit always shows. */
import {useState} from 'react';

import {getChainId, getTokenTicker} from '@/lib/config';
import {getEvmNowAddressUrl} from '@/lib/format';
import {useProtocolLive} from '@/lib/useProtocolLive';

const TICKER = getTokenTicker();
const ZERO = '0x0000000000000000000000000000000000000000';

export function FooterColophon({token}: {token?: string}) {
    const live = useProtocolLive();
    const showToken =
        live && !!token && /^0x[0-9a-fA-F]{40}$/.test(token) && token.toLowerCase() !== ZERO;
    return (
        <div className="footer-colophon">
            {showToken ? <TokenAddress token={token!} /> : <span aria-hidden="true" />}
            <span className="footer-credit">
                created by{' '}
                <a href="https://x.com/ripe0x" target="_blank" rel="noreferrer">
                    ripe
                </a>
            </span>
            <style>{styles}</style>
        </div>
    );
}

function TokenAddress({token}: {token: string}) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(token);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard unavailable (insecure context / denied) — the address
            // link is still fully selectable for manual copy.
        }
    };
    return (
        <span className="footer-token">
            <span className="footer-token-label">{TICKER} token</span>
            <a
                className="footer-token-addr tnum"
                href={getEvmNowAddressUrl(token, getChainId())}
                target="_blank"
                rel="noreferrer"
                title={`View the ${TICKER} token on evm.now`}
            >
                {token}
            </a>
            <button
                type="button"
                className="footer-token-copy"
                onClick={copy}
                aria-label={`Copy the ${TICKER} token address`}
            >
                {copied ? 'copied' : 'copy'}
            </button>
        </span>
    );
}

const styles = `
.footer-colophon {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px 28px;
    flex-wrap: wrap;
    border-top: 1px solid var(--line);
    padding-top: 20px;
}
.footer-token {
    display: inline-flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    min-width: 0;
}
.footer-token-label {
    color: var(--ink);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-size: 11px;
}
.footer-token-addr {
    color: var(--muted);
    font-size: 12px;
    word-break: break-all;
    border-bottom: 1px dotted var(--line);
    transition: color 120ms ease, border-color 120ms ease;
}
.footer-token-addr:hover {
    color: var(--ink);
    border-bottom-color: var(--ink);
}
.footer-token-copy {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    border: 1px solid var(--line);
    padding: 3px 8px;
    transition: border-color 120ms ease, color 120ms ease;
}
.footer-token-copy:hover {
    color: var(--ink);
    border-color: var(--ink);
}
.footer-credit {
    color: var(--muted);
    margin-left: auto;
}
.footer-credit a {
    color: var(--ink);
    border-bottom: 1px dotted var(--line);
    transition: border-color 120ms ease;
}
.footer-credit a:hover {
    border-bottom-color: var(--ink);
}
@media (max-width: 560px) {
    .footer-credit {
        margin-left: 0;
    }
}
`;
