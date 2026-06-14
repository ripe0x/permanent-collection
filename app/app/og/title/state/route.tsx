import { buildTitleCard } from '@/lib/og/card';
import { getDataAdapter } from '@/lib/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const svg = await getDataAdapter().getTitleSvg().catch(() => null);
  return buildTitleCard(svg);
}
