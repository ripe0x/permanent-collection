/* Gates every /debug/* route behind the admin wallet. The gate itself is the
 * client AdminGate (it needs the connected wallet); this server layout just
 * wraps the routed page in it, so all four debug pages (index, fees,
 * distribution, nft-metadata) are covered in one place. */

import {AdminGate} from '@/components/AdminGate';

export default function DebugLayout({children}: {children: React.ReactNode}) {
    return <AdminGate>{children}</AdminGate>;
}
