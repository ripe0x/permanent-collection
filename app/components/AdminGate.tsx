'use client';

/* Client-side admin gate for the /debug/* routes. Renders its children only
 * when the connected wallet is the protocol admin EOA; everyone else sees an
 * "admin only" notice. The debug pages render on-chain-public data, so this is
 * UI-level access control (keep the internals out of sight), not secrecy — for
 * a hard server-side gate (don't render for non-admins at all) a SIWE sign-in
 * session would be needed. Default admin overridable via NEXT_PUBLIC_DEBUG_ADMIN. */

import {useEffect, useState} from 'react';
import {useAccount} from 'wagmi';

const DEBUG_ADMIN = (
    process.env.NEXT_PUBLIC_DEBUG_ADMIN ?? '0xCB43078C32423F5348Cab5885911C3B5faE217F9'
).toLowerCase();

export function AdminGate({children}: {children: React.ReactNode}) {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    const {address, isConnected} = useAccount();

    // Gate only on production builds — local dev (`next dev`, NODE_ENV
    // development) is open so developers don't need the admin wallet to reach
    // the debug pages. (NODE_ENV is a build-time constant, so this short-circuits
    // cleanly per build; the hooks above always run, keeping hook order stable.)
    if (process.env.NODE_ENV !== 'production') return <>{children}</>;

    // Avoid an SSR/hydration flash: useAccount is empty on the server.
    if (!mounted) return null;

    const isAdmin = isConnected && address?.toLowerCase() === DEBUG_ADMIN;
    if (isAdmin) return <>{children}</>;

    return (
        <div className="admin-gate">
            <div className="admin-gate-box">
                <div className="admin-gate-kicker">Restricted</div>
                <div className="admin-gate-title">Admin only</div>
                <p className="admin-gate-copy">
                    {isConnected
                        ? 'This page is restricted to the protocol admin. The connected wallet isn’t the admin.'
                        : 'This page is restricted to the protocol admin. Connect the admin wallet to view it.'}
                </p>
            </div>
            <style>{styles}</style>
        </div>
    );
}

const styles = `
.admin-gate {
    min-height: 60vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
}
.admin-gate-box {
    max-width: 440px;
    text-align: center;
    border: 1px solid var(--line);
    padding: 32px 28px;
}
.admin-gate-kicker {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
}
.admin-gate-title {
    margin-top: 8px;
    font-family: var(--sans);
    font-size: 28px;
    color: var(--ink);
}
.admin-gate-copy {
    margin-top: 12px;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.7;
    color: var(--muted);
}
`;
