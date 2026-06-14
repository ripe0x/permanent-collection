import type {Metadata} from 'next';
import {WhyEssay} from '@/components/WhyEssay';
import {getDataAdapter} from '@/lib/data';
import {buildMeta, TAGLINE} from '@/lib/meta';

/* Pre-launch landing essay. Long-form description of the work and its
   mechanics. Intentionally minimal — no Header, no Footer, no outbound
   links. The on-chain renderer's live artwork is embedded above the
   artcoin section so the page shows the current state of the work
   wherever the renderer read succeeds (and a neutral placeholder grid
   where it doesn't). */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = buildMeta({
    title: 'Permanent Collection',
    bareTitle: true,
    description: TAGLINE,
    path: '/why',
});

export default async function WhyPage() {
    const adapter = getDataAdapter();
    const svgMarkup = await adapter.getRendererSvg().catch(() => null);
    return <WhyEssay svgMarkup={svgMarkup} />;
}
