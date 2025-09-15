import pLimit from 'p-limit';
import { getConfig, type ModelProvider } from '@/lib/config';

export type LLMRequest = {
  model: string;
  messages: { role: 'system'|'user'|'assistant'; content: string }[];
  json?: boolean;
  stream?: boolean;
  vision?: boolean;
  onToken?: (chunk: string) => void; // 新增：逐 token 回调
};

export type LLMResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export interface LLMClient {
  name: ModelProvider;
  chat<T = unknown>(req: LLMRequest): Promise<LLMResponse<T>>;
}

const limiters: Partial<Record<ModelProvider, ReturnType<typeof pLimit>>> = {};

export function limiterFor(name: ModelProvider) {
  const cfg = getConfig();
  if (!limiters[name]) {
    limiters[name] = pLimit(Math.max(1, Math.min(2, cfg.concurrency)));
  }
  return limiters[name]!;
}