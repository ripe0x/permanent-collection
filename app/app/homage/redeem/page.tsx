import type {Metadata} from 'next';

import {HomageRedeemPage} from '@/components/homage/HomageRedeemPage';
import {buildMeta} from '@/lib/meta';

export const metadata: Metadata = buildMeta({
    title: 'Homage redeem',
    description: 'Burn a homage to reclaim the 111 escrowed inside it.',
    path: '/homage/redeem',
});

export default function Page() {
    return <HomageRedeemPage />;
}
