import {isHomageConfigured} from '@/lib/homage/config';
import {HomageMintPage} from '@/components/homage/HomageMintPage';
import {ExploreView} from '@/components/homage/ExploreView';

/** The homage mint page. Until the Homage contract is configured
 *  (NEXT_PUBLIC_HOMAGE_ADDRESS / PC_HOMAGE_ADDRESS), the section renders the
 *  local explore experience as a preview — the mint UI appears the moment the
 *  operator sets the address (per-request gate; the root layout is
 *  force-dynamic, so this evaluates every request). */
export default function HomagePage() {
    return isHomageConfigured() ? <HomageMintPage /> : <ExploreView preview />;
}
