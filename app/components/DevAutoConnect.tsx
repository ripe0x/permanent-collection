'use client';

/**
 * DevAutoConnect — when wagmi is configured with the dev autosign mock
 * connector, this auto-fires `connect()` on mount so the UI sees the
 * wallet as connected without the user clicking "Connect".
 *
 * Activated only when `NEXT_PUBLIC_DEV_AUTOSIGN_PK` is set AND the
 * chain is 31337 (anvil). On any other config, this component does
 * nothing — the normal RainbowKit wallet picker stays in effect.
 *
 * No-op after the first successful connection.
 */

import {useEffect} from 'react';
import {useAccount, useConnect, useConnectors} from 'wagmi';
import {isDevAutosignActive} from '@/lib/wagmi';

export function DevAutoConnect() {
    const {isConnected} = useAccount();
    const {connect} = useConnect();
    const connectors = useConnectors();

    useEffect(() => {
        if (!isDevAutosignActive()) return;
        if (isConnected) return;
        // In dev-autosign mode the wagmi config has exactly one connector
        // (the mock). Connect against it on mount.
        const mockConn = connectors.find((c) => c.id === 'mock');
        if (!mockConn) return;
        connect({connector: mockConn});
    }, [isConnected, connect, connectors]);

    return null;
}
