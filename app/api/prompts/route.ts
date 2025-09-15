import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getPrompts, setPrompts, resetPrompts, defaultPrompts, type Prompts } from '@/lib/prompts';
import fs from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';

const DATA_DIR = path.join(process.cwd(), 'data');
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');

async function loadOnce() {
  try {
    const buf = await fs.readFile(PROMPTS_FILE, 'utf8');
    const parsed = JSON.parse(buf) as Partial<Prompts>;
    setPrompts(parsed);
  } catch {}
}
let loaded = false;
async function ensureLoaded() {
  if (loaded) return;
  await loadOnce();
  loaded = true;
}

async function savePrompts() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(PROMPTS_FILE, JSON.stringify(getPrompts(), null, 2), 'utf8');
  } catch {}
}

export async function GET() {
  await ensureLoaded();
  return NextResponse.json({ ok: true, prompts: getPrompts() });
}

const PromptsObjectSchema = z.object({
  intent: z.string().optional(),
  'outline-multi': z.string().optional(),
  'outline-merge': z.string().optional(),
  'write-sections': z.string().optional(),
  'image-prompts': z.string().optional(),
  'merge-assembly': z.string().optional(),
  'expert-review': z.string().optional(),
  'fact-check': z.string().optional(),
  'final-merge': z.string().optional(),
});

const BodySchema = z.object({
  reset: z.boolean().optional(),
  prompts: PromptsObjectSchema.partial().optional(),
});

export async function POST(req: NextRequest) {
  await ensureLoaded();
  const body = await req.json();
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
  if (parsed.data.reset) {
    resetPrompts();
    await savePrompts();
    return NextResponse.json({ ok: true, prompts: getPrompts() });
  }
  if (parsed.data.prompts) setPrompts(parsed.data.prompts);
  await savePrompts();
  return NextResponse.json({ ok: true, prompts: getPrompts() });
}