import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { runPipeline } from '@/lib/pipeline';

export const runtime = 'nodejs';

const IntentSchema = z.object({
  topic: z.string().optional(),
  audience: z.string().optional(),
  style: z.string().optional(),
  goals: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
});

const FileSchema = z.object({ filename: z.string(), path: z.string(), mime: z.string().optional(), size: z.number().optional() });

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parse = IntentSchema.safeParse(body.intent || {});
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: 'invalid intent' }, { status: 400 });
  }
  const files = Array.isArray(body.files) ? body.files.filter((f: unknown)=>!!f).map((f: unknown)=>FileSchema.parse(f)) : [];
  const run = await runPipeline({ intent: parse.data, files });
  return NextResponse.json({ ok: true, run });
}