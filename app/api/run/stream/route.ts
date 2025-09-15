import { NextRequest } from 'next/server';
import { runPipeline, type RunState } from '@/lib/pipeline';
import { z } from 'zod';

export const runtime = 'nodejs';

const IntentSchema = z.object({
  topic: z.string().optional(),
  audience: z.string().optional(),
  style: z.string().optional(),
  goals: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parse = IntentSchema.safeParse(body.intent || {});
  if (!parse.success) {
    return new Response(JSON.stringify({ type: 'error', message: 'invalid intent' }) + '\n', { status: 400, headers: { 'Content-Type': 'application/x-ndjson' } });
  }
  const abort = new AbortController();

  const stream = new ReadableStream({
    start(controller) {
      (async () => {
        try {
          const encoder = new TextEncoder();
          const onUpdate = async (state: RunState) => {
            controller.enqueue(encoder.encode(JSON.stringify({ type: 'update', run: state }) + '\n'));
          };
          const run = await runPipeline({ intent: parse.data, files: Array.isArray(body.files) ? body.files : [] }, { onUpdate, signal: abort.signal });
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'done', run }) + '\n'));
          controller.close();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', message: msg }) + '\n'));
          controller.close();
        }
      })();
    },
    cancel() {
      abort.abort();
    }
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}