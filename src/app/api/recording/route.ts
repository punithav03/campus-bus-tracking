import { NextResponse } from 'next/server';
import { checkPin, unauthorized } from '@/lib/auth';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

const DIR = join(process.cwd(), 'data', 'recordings');

/** A 70-minute ride at 1 Hz is roughly 400 KB. This is generous headroom. */
const MAX_BYTES = 12 * 1024 * 1024;

interface Trace {
  format?: string;
  session?: { id?: string; name?: string; startedAt?: number; distanceM?: number };
  fixes?: unknown[];
  markers?: unknown[];
}

/**
 * Receives a recorded ride from the phone that captured it.
 *
 * The alternative — exporting a file and messaging it over — loses recordings
 * and needs the person who rode the bus to also be the person who processes it.
 * Uploading decouples the two: whoever rides taps one button, and whoever owns
 * the laptop collects it later from /admin.
 */
export async function POST(req: Request) {
  if (!checkPin(req)) return unauthorized();
  const raw = await req.text();
  if (raw.length > MAX_BYTES) {
    return NextResponse.json({ error: 'recording too large' }, { status: 413 });
  }

  let trace: Trace;
  try {
    trace = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'not valid JSON' }, { status: 400 });
  }

  if (trace.format !== 'campusbus-trace/1' || !Array.isArray(trace.fixes)) {
    return NextResponse.json({ error: 'not a Campus Bus recording' }, { status: 400 });
  }
  if (trace.fixes.length < 20) {
    return NextResponse.json({ error: 'too few fixes to be a real ride' }, { status: 400 });
  }

  const id = (trace.session?.id ?? `rec-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '');
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${id}.json`), raw);

  return NextResponse.json({
    ok: true,
    id,
    fixes: trace.fixes.length,
    markers: trace.markers?.length ?? 0,
    name: trace.session?.name ?? id,
  });
}

/** What has been uploaded so far — powers the list on /admin. */
export async function GET(req: Request) {
  if (!checkPin(req)) return unauthorized();
  try {
    await mkdir(DIR, { recursive: true });
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.json'));
    const items = await Promise.all(
      files.map(async (f) => {
        try {
          const t = JSON.parse(await readFile(join(DIR, f), 'utf8')) as Trace;
          return {
            id: f.replace(/\.json$/, ''),
            name: t.session?.name ?? f,
            startedAt: t.session?.startedAt ?? 0,
            fixes: t.fixes?.length ?? 0,
            markers: t.markers?.length ?? 0,
            distanceM: t.session?.distanceM ?? 0,
          };
        } catch {
          return null;
        }
      }),
    );
    return NextResponse.json({
      recordings: items.filter(Boolean).sort((a, b) => (b!.startedAt) - (a!.startedAt)),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
