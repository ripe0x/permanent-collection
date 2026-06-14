import { buildValueCard } from '@/lib/og/card';
import { formatEthBare } from '@/lib/format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const symbol = sp.get('symbol') || 'tokens';
  let tokens = '0';
  try {
    tokens = formatEthBare(BigInt(sp.get('tokens') ?? '0'));
  } catch {}
  return buildValueCard(`${tokens} ${symbol}`);
}
