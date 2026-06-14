import { buildValueCard } from '@/lib/og/card';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ count: string }> }) {
  const { count } = await params;
  return buildValueCard(`${Number(count)} / 111`);
}
