import type {Metadata} from 'next';

import {HomageCalculatorPage} from '@/components/homage/HomageCalculatorPage';
import {buildMeta} from '@/lib/meta';

// Distinct from the top-level /calculator (the protocol's live-bid calculator) —
// title says "Homage mint calculator" so the two never read as the same page.
export const metadata: Metadata = buildMeta({
    title: 'Homage mint calculator',
    description: 'Estimate the ETH cost of minting a Homage from the live $111 pool price, pool skim, and mint fee.',
    path: '/homage/calculator',
});

export default function Page() {
    return <HomageCalculatorPage />;
}
