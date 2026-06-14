'use client';

import {getEvmNowAddressUrl, shortAddress} from '@/lib/format';
import {useProtocolLive} from '@/lib/useProtocolLive';

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * A protocol contract address rendered as an evm.now link ONLY once the protocol
 * is live (the token has bytecode on-chain). Pre-launch / pre-deploy it's muted
 * "not deployed yet" text — never a clickable link to an address that doesn't
 * exist yet. Pass `alwaysLive` for canonical external contracts (the Punks
 * market/data, V4 infra) that exist on mainnet regardless of PC's launch.
 */
export function ContractAddress({
    address,
    chainId,
    alwaysLive = false,
}: {
    address: string;
    chainId: number;
    alwaysLive?: boolean;
}) {
    const live = useProtocolLive();
    const deployed = Boolean(address) && address.toLowerCase() !== ZERO;
    const linkable = alwaysLive ? deployed : live && deployed;
    if (!linkable) {
        return <span className="contracts-pending">not deployed yet</span>;
    }
    return (
        <a href={getEvmNowAddressUrl(address, chainId)} target="_blank" rel="noreferrer" title={address}>
            {shortAddress(address)}
        </a>
    );
}
