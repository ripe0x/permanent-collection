'use client';

import {useProtocolLive} from '@/lib/useProtocolLive';

/** The token's Dexscreener market link, shown only once the protocol is live
 *  (the token has bytecode on-chain) so it never points at a not-yet-deployed
 *  token. Hidden pre-launch / pre-deploy. */
export function DexscreenerLink({token}: {token: string}) {
    const live = useProtocolLive();
    if (!live) return null;
    return (
        <a href={`https://dexscreener.com/ethereum/${token}`} target="_blank" rel="noreferrer">
            Dexscreener
        </a>
    );
}
