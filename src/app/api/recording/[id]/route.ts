import { NextResponse } from 'next/server';
import { checkPin, unauthorized } from '@/lib/auth';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

const DIR = join(process.cwd(), 'data', 'recordings');

/** Only ever touch a file whose name we generated. */
const safe = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkPin(req)) return unauthorized();
  const { id } = await params;
  if (!safe(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  try {
    const raw = await readFile(join(DIR, `${id}.json`), 'utf8');
    return new NextResponse(raw, {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="${id}.json"`,
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkPin(req)) return unauthorized();
  const { id } = await params;
  if (!safe(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  try {
    await unlink(join(DIR, `${id}.json`));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}
