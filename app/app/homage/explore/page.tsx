import {ExploreView} from '@/components/homage/ExploreView';
import {buildMeta} from '@/lib/meta';

export const metadata = buildMeta({
    title: 'Homage explore',
    description: 'Browse the 10,000 generative onchain homages, one for every CryptoPunk.',
    path: '/homage/explore',
});

// The explore experience lives in components/homage/ExploreView so the preview site mode can
// also serve it as the homepage (see app/page.tsx + lib/siteMode.ts).
export default function ExplorePage() {
    return <ExploreView />;
}
