import { NextResponse } from 'next/server';
import { checkPin, pinRequired } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Tells the client two things: whether a PIN is needed here at all, and whether
 * the one it is holding is correct. Deliberately reveals nothing else — a wrong
 * PIN and a missing PIN look identical.
 */
export async function GET(req: Request) {
  return NextResponse.json(
    { required: pinRequired(), ok: checkPin(req) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: Request) {
  let pin = '';
  try {
    pin = String((await req.json())?.pin ?? '');
  } catch { /* empty body */ }

  // Re-check through the same path a real request takes, rather than comparing
  // here — one code path means one place to get the comparison right.
  const probe = new Request(req.url, { headers: { 'x-campus-pin': pin } });
  const ok = checkPin(probe);
  return NextResponse.json({ required: pinRequired(), ok }, { status: ok ? 200 : 401 });
}
