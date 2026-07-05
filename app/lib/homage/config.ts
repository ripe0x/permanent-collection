// Homage-section config gate. Thin accessors over the PC config module so
// homage code never touches env vars directly — the Homage contract
// addresses follow the same build-time NEXT_PUBLIC_* / runtime PC_* layering
// as every other protocol address (see lib/config.ts).

import {getContractAddresses, getHomageDeployBlock} from '@/lib/config';
import type {Address} from '@/lib/data/types';

/** The Homage ERC721 contract, or undefined pre-deploy. */
export function getHomageAddress(): Address | undefined {
    return getContractAddresses().homage;
}

/** The PermanenceRenderer for the Homage collection, or undefined pre-deploy. */
export function getHomageRenderer(): Address | undefined {
    return getContractAddresses().homageRenderer;
}

/** Is the Homage contract configured (deployed + address set)? Unconfigured
 *  ⇒ the /homage section renders the local explore/preview experience and
 *  "mint not yet open"; configured ⇒ full mint/redeem. The homage twin of
 *  `isProtocolLive()`. */
export function isHomageConfigured(): boolean {
    return getHomageAddress() !== undefined;
}

export {getHomageDeployBlock};
