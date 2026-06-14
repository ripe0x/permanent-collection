import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {Footer} from '@/components/Footer';
import {Header} from '@/components/Header';
import {PunkDetail} from '@/components/PunkDetail';
import {PunkSvg} from '@/components/PunkSvg';
import {getChainId, getContractAddresses} from '@/lib/config';
import {getDataAdapter} from '@/lib/data';
import {isIndexerDegraded} from '@/lib/data/indexer-client';
import {buildMeta} from '@/lib/meta';
import {getPunksSdk} from '@/lib/punks-sdk';

export const dynamic = 'force-dynamic';

export async function generateMetadata({params}: {params: Promise<{punkId: string}>}): Promise<Metadata> {
    const {punkId: raw} = await params;
    const punkId = Number.parseInt(raw, 10);
    if (!Number.isInteger(punkId) || punkId < 0 || punkId > 9999) {
        return buildMeta({title: 'Punk — not found', description: 'No such Punk.', path: '/collection'});
    }
    return buildMeta({
        title: `Punk #${punkId}`,
        description: `Punk #${punkId} — traits, status in the Permanent Collection, and full provenance.`,
        path: `/punk/${punkId}`,
    });
}

/** Best-effort owner annotation. Resolving contract addresses needs env that
 *  may be absent in mock mode, so failures degrade to no label. */
function ownerLabelFor(owner: string): string | undefined {
    try {
        const addrs = getContractAddresses();
        const lc = owner.toLowerCase();
        if (lc === addrs.punkVault.toLowerCase()) return 'Held permanently by the Permanent Collection vault.';
        if (lc === addrs.patron.toLowerCase()) return 'Listed to Patron — an acceptance is in flight.';
        if (lc === addrs.returnAuctionModule.toLowerCase()) return 'Escrowed in the return-auction module.';
    } catch {
        // no env — skip the annotation
    }
    return undefined;
}

export default async function PunkDetailPage({params}: {params: Promise<{punkId: string}>}) {
    const {punkId: raw} = await params;
    const punkId = Number.parseInt(raw, 10);
    if (!Number.isInteger(punkId) || punkId < 0 || punkId > 9999) notFound();

    const sdk = getPunksSdk();
    const summary = sdk.get(punkId, {includeTraits: true});

    const adapter = getDataAdapter();
    const [provenance, auction, eligibility, traitNames, state] = await Promise.all([
        adapter.getPunkProvenance(punkId),
        adapter.getAuctionByPunkId(punkId),
        adapter.getPunkEligibility(punkId),
        adapter.getTraitNames(),
        adapter.getProtocolState(),
    ]);

    const hasLiveAuction = auction !== null;
    const status: 'uncollected' | 'preListed' | 'inReturnAuction' | 'returned' | 'vaulted' = hasLiveAuction
        ? 'inReturnAuction'
        : provenance.events.some((e) => e.kind === 'vaulted')
          ? 'vaulted'
          : provenance.events.some((e) => e.kind === 'returned')
            ? 'returned'
            : eligibility.listedToPatron
              ? 'preListed'
              : 'uncollected';

    return (
        <>
            <Header />
            <main id="top">
                <PunkDetail
                    punkId={punkId}
                    status={status}
                    owner={eligibility.owner}
                    ownerLabel={ownerLabelFor(eligibility.owner)}
                    traits={(summary.traits ?? []).map((t) => ({
                        id: t.id,
                        name: t.name,
                        kind: t.kind,
                        supply: t.supply,
                    }))}
                    punkTypeName={summary.punkTypeName}
                    attributeCount={summary.attributeCount}
                    uncollectedTraitIds={eligibility.uncollectedBits}
                    pendingTraitIds={eligibility.pendingBits}
                    targetTraitId={auction?.targetTraitId}
                    provenance={provenance}
                    traitNames={traitNames}
                    chainId={getChainId()}
                    asOfBlock={state.asOfBlock}
                    asOfTimestamp={state.asOfTimestamp}
                    indexerDegraded={isIndexerDegraded()}
                    punkImage={
                        <PunkSvg punkId={punkId} size={320} label={`Punk #${punkId}`} background="transparent" />
                    }
                />
            </main>
            <Footer />
        </>
    );
}
