import { buildValueCard } from '@/lib/og/card';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return buildValueCard('111 / 111');
}
