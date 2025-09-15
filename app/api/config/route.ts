import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, setConfig, type AppConfig } from '@/lib/config';

export const runtime = 'nodejs';

const ProviderSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  useWebSearch: z.boolean().optional(),
  ak: z.string().optional(),
  sk: z.string().optional(),
});

export enum StageKeyEnum {
  Intent = 'intent',
  OutlineMulti = 'outline-multi',
  OutlineMerge = 'outline-merge',
  WriteSections = 'write-sections',
  ImagePrompts = 'image-prompts',
  ImageGeneration = 'image-generation',
  MergeAssembly = 'merge-assembly',
  ExpertReview = 'expert-review',
  FactCheck = 'fact-check',
  FinalMerge = 'final-merge',
}
const ModelProviderEnum = z.enum(['kimi','qwen','glm','deepseek','openai','anthropic','gemini']);
const ImageProviderEnum = z.enum(['keling','paiwo','jimeng','nanobanana']);

const ConfigSchema = z.object({
  providers: z.record(z.string(), ProviderSchema).optional(),
  imageProviders: z.record(ImageProviderEnum, ProviderSchema).optional(),
  concurrency: z.number().min(1).max(8).optional(),
  budgetUSD: z.number().min(0).optional(),
  ttsProvider: z.enum(['web','azure','elevenlabs','xunfei']).optional(),
  stageProviders: z.record(z.nativeEnum(StageKeyEnum), z.array(ModelProviderEnum)).optional(),
  // image-generation stage uses image providers selection
  imageStageProviders: z
    .object({ 'image-generation': z.array(ImageProviderEnum).optional() })
    .partial()
    .optional(),
});

// merge helpers to avoid wiping saved secrets when client omits them or sends empty strings
function mergeProvider(curr: any = {}, incoming: any = {}) {
  const out: any = { ...curr };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    if ((k === 'ak' || k === 'sk') && typeof v === 'string' && v.trim() === '') continue; // ignore empty overwrite
    (out as any)[k] = v;
  }
  return out;
}
function mergeProviderMaps(curr: Record<string, any> = {}, incoming: Record<string, any> = {}) {
  const keys = new Set([...Object.keys(curr || {}), ...Object.keys(incoming || {})]);
  const res: Record<string, any> = {};
  for (const key of keys) {
    res[key] = mergeProvider(curr?.[key], incoming?.[key]);
  }
  return res;
}

export async function GET() {
  const curr = getConfig();
  // sanitize ak/sk before returning to client but add presence flags
  const sanitizeProvider = (p: any) => {
    if (!p) return p;
    const { ak, sk, ...rest } = p;
    return { ...rest, hasAk: !!(ak && String(ak).length > 0), hasSk: !!(sk && String(sk).length > 0) };
  };

  const masked: any = {
    ...curr,
    providers: Object.fromEntries(
      Object.entries(((curr as any).providers) || {}).map(([k, v]) => [k, sanitizeProvider(v)])
    ),
    imageProviders: Object.fromEntries(
      Object.entries(((curr as any).imageProviders) || {}).map(([k, v]) => [k, sanitizeProvider(v)])
    ),
  };
  return NextResponse.json({ ok: true, config: masked });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = ConfigSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: 'invalid config' }, { status: 400 });

  const curr = getConfig();
  const incoming = parsed.data;

  const merged: Partial<AppConfig> = {
    ...curr,
    providers: mergeProviderMaps((curr as any).providers, (incoming as any).providers),
    imageProviders: mergeProviderMaps((curr as any).imageProviders, (incoming as any).imageProviders),
    concurrency: incoming.concurrency ?? (curr as any).concurrency,
    budgetUSD: incoming.budgetUSD ?? (curr as any).budgetUSD,
    ttsProvider: incoming.ttsProvider ?? (curr as any).ttsProvider,
    stageProviders: { ...(curr as any).stageProviders, ...(incoming.stageProviders ?? {}) },
    imageStageProviders: { ...(curr as any).imageStageProviders, ...(incoming.imageStageProviders ?? {}) },
  };

  setConfig(merged);
  // return masked config as in GET
  const sanitizeProvider = (p: any) => {
    if (!p) return p;
    const { ak, sk, ...rest } = p;
    return { ...rest, hasAk: !!(ak && String(ak).length > 0), hasSk: !!(sk && String(sk).length > 0) };
  };
  const masked: any = {
    ...merged,
    providers: Object.fromEntries(
      Object.entries(((merged as any).providers) || {}).map(([k, v]) => [k, sanitizeProvider(v)])
    ),
    imageProviders: Object.fromEntries(
      Object.entries(((merged as any).imageProviders) || {}).map(([k, v]) => [k, sanitizeProvider(v)])
    ),
  };
  return NextResponse.json({ ok: true, config: masked });
}