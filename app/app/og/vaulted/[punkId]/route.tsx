import { buildPunkCard, VAULTED_BG } from '@/lib/og/card';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ punkId: string }> }) {
  const { punkId } = await params;
  return buildPunkCard(Number(punkId), VAULTED_BG);
}
