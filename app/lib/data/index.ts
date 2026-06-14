// Adapter factory. Returns the mock adapter in dev when explicitly asked;
// otherwise the live adapter. Components consume the `DataAdapter` interface
// and never know which is wired in.

import {getDataAdapterKind} from '@/lib/config';
import {ForkAdapter} from './fork';
import {LiveAdapter} from './live';
import {MockAdapter} from './mock';
import type {DataAdapter} from './types';

let _adapter: DataAdapter | null = null;

export function getDataAdapter(): DataAdapter {
    if (_adapter) return _adapter;
    const kind = getDataAdapterKind();
    _adapter =
        kind === 'mock'
            ? new MockAdapter()
            : kind === 'fork'
              ? new ForkAdapter()
              : new LiveAdapter();
    return _adapter;
}

export type {
    AcceptedBidEvent,
    ActiveAuction,
    AuctionOutcome,
    DataAdapter,
    MarketReference,
    ProtocolState,
    ResolvedAuction,
    TraitId,
    TraitState,
    TraitView,
} from './types';
