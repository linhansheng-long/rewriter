import { LLMClient, LLMRequest, LLMResponse, limiterFor } from './base';
import type { ModelProvider } from '@/lib/config';
import { getConfig } from '@/lib/config';

// OpenAI-compatible HTTP call helper
type CompatBase = {
  baseURL: string;
  apiKeyHeader: string; // e.g. 'Authorization'
  apiKey?: string;
};
type OpenAIChatMessage = { role?: string; content?: string };
type OpenAIChatChoice = { index?: number; message?: OpenAIChatMessage };
type OpenAIChatResponse = { choices?: OpenAIChatChoice[] };

async function openaiCompatCall<T = unknown>(compat: CompatBase, req: LLMRequest): Promise<LLMResponse<T>> {
  const { baseURL, apiKeyHeader, apiKey } = compat;
  if (!apiKey) return { ok: false as const, error: 'Missing API key' };
  try {
    const resp = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [apiKeyHeader]: `Bearer ${apiKey}`,
      } as Record<string, string>,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: !!req.stream,
        response_format: req.json ? { type: 'json_object' } : undefined,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false as const, error: `HTTP ${resp.status}: ${text}` };
    }
    // streaming mode
    if (req.stream) {
      const reader = resp.body?.getReader();
      if (!reader) return { ok: false as const, error: 'No response body' };
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              // end of stream
            } else {
              try {
                const j = JSON.parse(payload) as any;
                const token = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content ?? '';
                if (token) {
                  full += token;
                  if (typeof req.onToken === 'function') req.onToken(token);
                }
              } catch {}
            }
          }
          nl = buf.indexOf('\n');
        }
      }
      if (req.json) {
        try {
          const parsed = JSON.parse(full) as T;
          return { ok: true as const, data: parsed };
        } catch (e) {
          return { ok: false as const, error: `JSON parse failed: ${String(e)}` };
        }
      }
      return { ok: true as const, data: full as unknown as T };
    }
    // non-stream mode
    const data = (await resp.json()) as unknown as OpenAIChatResponse;
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    if (req.json) {
      try {
        const parsed = JSON.parse(content) as T;
        return { ok: true as const, data: parsed };
      } catch (e) {
        return { ok: false as const, error: `JSON parse failed: ${String(e)}` };
      }
    }
    return { ok: true as const, data: content as unknown as T };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

// Anthropic native call helper
type AnthropicContentItem = { type?: string; text?: string };
type AnthropicResponse = { content?: AnthropicContentItem[] };
async function anthropicCall<T = unknown>(req: LLMRequest): Promise<LLMResponse<T>> {
  const cfg = getConfig();
  const pcfg = cfg.providers['anthropic'];
  const apiKey = pcfg?.apiKey;
  if (!apiKey) return { ok: false as const, error: 'Missing API key' };
  try {
    const systemMsg = req.messages.find((m) => m.role === 'system')?.content;
    const nonSystem = req.messages.filter((m) => m.role !== 'system');
    const messages = nonSystem.map((m) => ({
      role: m.role,
      content: [{ type: 'text', text: m.content }],
    }));
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model,
        system: systemMsg,
        messages,
        max_tokens: 2048,
        stream: false,
        response_format: req.json ? { type: 'json_object' } : undefined,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false as const, error: `HTTP ${resp.status}: ${text}` };
    }
    // removed legacy line: const data = (await resp.json()) as any;
    const data = (await resp.json()) as unknown as AnthropicResponse;
    const content: string = data?.content?.[0]?.text ?? '';
    if (req.json) {
      try {
        const parsed = JSON.parse(content) as T;
        return { ok: true as const, data: parsed };
      } catch (e) {
        return { ok: false as const, error: `JSON parse failed: ${String(e)}` };
      }
    }
    return { ok: true as const, data: content as unknown as T };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}

// Fallback fake caller for demo when no API key is configured
async function fakeCall<T = unknown>(req: LLMRequest): Promise<T> {
  await new Promise((r) => setTimeout(r, 200));
  void req;
  return { placeholder: true } as unknown as T;
}

function modelFor(p: ModelProvider, req: LLMRequest): LLMRequest {
  const cfg = getConfig();
  const m = cfg.providers[p]?.model || req.model;
  return { ...req, model: m };
}

export const KimiClient: LLMClient = {
  name: 'kimi',
  async chat<T = unknown>(req: LLMRequest): Promise<LLMResponse<T>> {
    const cfg = getConfig();
    const pcfg = cfg.providers['kimi'];
    const call = () => openaiCompatCall<T>({
      baseURL: 'https://api.moonshot.cn/v1',
      apiKeyHeader: 'Authorization',
      apiKey: pcfg?.apiKey,
    }, modelFor('kimi', req));
    const res = await limiterFor('kimi')(() => (pcfg?.apiKey ? call() : Promise.resolve({ ok: false as const, error: 'Missing API key' })));
    if (!res.ok) {
      const data = await fakeCall<T>(req);
      return { ok: true as const, data };
    }
    return res;
  },
};

export const QwenClient: LLMClient = {
  name: 'qwen',
  async chat<T = unknown>(req: LLMRequest): Promise<LLMResponse<T>> {
    const cfg = getConfig();
    const pcfg = cfg.providers['qwen'];
    const call = () => openaiCompatCall<T>({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyHeader: 'Authorization',
      apiKey: pcfg?.apiKey,
    }, modelFor('qwen', req));
    const res = await limiterFor('qwen')(() => (pcfg?.apiKey ? call() : Promise.resolve({ ok: false as const, error: 'Missing API key' })));
    if (!res.ok) {
      const data = await fakeCall<T>(req);
      return { ok: true as const, data };
    }
    return res;
  },
};

export const GLMClient: LLMClient = {
  name: 'glm',
  async chat<T = unknown>(req: LLMRequest): Promise<LLMResponse<T>> {
    const cfg = getConfig();
    const pcfg = cfg.providers['glm'];
    const call = () => openaiCompatCall<T>({
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      apiKeyHeader: 'Authorization',
      apiKey: pcfg?.apiKey,
    }, modelFor('glm', req));
    const res = await limiterFor('glm')(() => (pcfg?.apiKey ? call() : Promise.resolve({ ok: false as const, error: 'Missing API key' })));
    if (!res.ok) {
      const data = await fakeCall<T>(req);
      return { ok: true as const, data };
    }
    return res;
  },
};

export const DeepseekClient: LLMClient = {
  name: 'deepseek',
  async chat<T = unknown>(req: LLMRequest): Promise<LLMResponse<T>> {
    const cfg = getConfig();
    const pcfg = cfg.providers['deepseek'];
    const call = () => openaiCompatCall<T>({
      baseURL: 'https://api.deepseek.com/v1',
      apiKeyHeader: 'Authorization',
      apiKey: pcfg?.apiKey,
    }, modelFor('deepseek', req));
    const res = await limiterFor('deepseek')(() => (pcfg?.apiKey ? call() : Promise.resolve({ ok: false as const, error: 'Missing API key' })));
    if (!res.ok) {
      const data = await fakeCall<T>(req);
      return { ok: true as const, data };
    }
    return res;
  },
};

export const OpenAIClient: LLMClient = {
  name: 'openai',
  async chat<T = unknown>(req: LLMRequest): Promise<LLMResponse<T>> {
    const cfg = getConfig();
    const pcfg = cfg.providers['openai'];
    const call = () => openaiCompatCall<T>({
      baseURL: 'https://api.openai.com/v1',
      apiKeyHeader: 'Authorization',
      apiKey: pcfg?.apiKey,
    }, modelFor('openai', req));
    const res = await limiterFor('openai')(() => (pcfg?.apiKey ? call() : Promise.resolve({ ok: false as const, error: 'Missing API key' })));
    if (!res.ok) {
      const data = await fakeCall<T>(req);
      return { ok: true as const, data };
    }
    return res;
  },
};

export const AnthropicClient: LLMClient = {
  name: 'anthropic',
  async chat<T = unknown>(req: LLMRequest): Promise<LLMResponse<T>> {
    const res = await limiterFor('anthropic')(() => anthropicCall<T>(modelFor('anthropic', req)));
    if (!res.ok) {
      const data = await fakeCall<T>(req);
      return { ok: true as const, data };
    }
    return res;
  },
};

export const GeminiClient: LLMClient = {
  name: 'gemini',
  async chat<T = unknown>(req: LLMRequest): Promise<LLMResponse<T>> {
    // TODO: implement real Gemini call; for now keep placeholder
    try {
      const data = await limiterFor('gemini')(() => fakeCall<T>(req));
      return { ok: true as const, data };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  },
};

export const CLIENTS: Record<ModelProvider, LLMClient> = {
  kimi: KimiClient,
  qwen: QwenClient,
  glm: GLMClient,
  deepseek: DeepseekClient,
  openai: OpenAIClient,
  anthropic: AnthropicClient,
  gemini: GeminiClient,
};

export function getClient(name: ModelProvider): LLMClient {
  return CLIENTS[name];
}