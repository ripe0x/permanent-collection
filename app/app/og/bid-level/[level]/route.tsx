import { buildValueCard, ethStr } from '@/lib/og/card';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  return buildValueCard(ethStr(sp.get('amount')));
}
