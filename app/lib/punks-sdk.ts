// SERVER-ONLY. The pixel bundle is ~2.4 MB — never import this from a
// client component. Importing it only from server components (no
// 'use client' file in the import graph) keeps the bundle off the wire.
import {createPunksSdk, type PunksSdk} from '@networked-art/punks-sdk';
import {bundledOfflinePunksDataWithPixels} from '@networked-art/punks-sdk/offline-pixel-data';

let _sdk: PunksSdk | null = null;

/**
 * Singleton over `@networked-art/punks-sdk` initialised with the bundled
 * search + pixel data. Used by /collection pages for offline trait
 * lookups and local SVG rendering — no RPC round trips.
 *
 * The SDK is alpha and pinned to an exact version.
 */
export function getPunksSdk(): PunksSdk {
    if (_sdk) return _sdk;
    _sdk = createPunksSdk({dataset: bundledOfflinePunksDataWithPixels});
    return _sdk;
}
