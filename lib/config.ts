import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'

export type ModelProvider = 'kimi' | 'qwen' | 'glm' | 'deepseek' | 'openai' | 'anthropic' | 'gemini';
export type ImageProvider = 'keling' | 'paiwo' | 'jimeng' | 'nanobanana';

export type ProviderConfig = {
  enabled: boolean;
  apiKey?: string;
  model?: string;
  useWebSearch?: boolean;
  ak?: string; // for providers like jimeng (Volcengine)
  sk?: string; // for providers like jimeng (Volcengine)
};

export type StageKey =
  | 'intent'
  | 'outline-multi'
  | 'outline-merge'
  | 'write-sections'
  | 'image-prompts'
  | 'image-generation'
  | 'merge-assembly'
  | 'expert-review'
  | 'fact-check'
  | 'final-merge';

export type AppConfig = {
  providers: Record<ModelProvider, ProviderConfig>;
  imageProviders: Record<ImageProvider, ProviderConfig>;
  concurrency: number;
  budgetUSD?: number;
  ttsProvider?: 'web' | 'azure' | 'elevenlabs' | 'xunfei';
  stageProviders: Record<StageKey, ModelProvider[]>;
  // Image-stage specific provider mapping (for stages like 'image-generation')
  imageStageProviders?: Record<'image-generation', ImageProvider[]>;
};

const DEFAULT_CONFIG: AppConfig = {
  providers: {
    kimi: { enabled: true, model: 'kimi-k2-0711-preview', useWebSearch: true },
    qwen: { enabled: true, model: 'qwen2.5-72b-instruct' },
    glm: { enabled: false, model: 'glm-4.5' },
    deepseek: { enabled: false, model: 'deepseek-chat' },
    openai: { enabled: false, model: 'gpt-4o-mini' },
    anthropic: { enabled: false, model: 'claude-3-5-sonnet' },
    gemini: { enabled: false, model: 'gemini-1.5-pro' },
  },
  imageProviders: {
    keling: { enabled: false, model: 'kling-image-v1' },
    paiwo: { enabled: false, model: 'paiwo-image-v1' },
    jimeng: { enabled: false, model: 'jimeng-image-v1' },
    nanobanana: { enabled: false, model: 'nanobanana-image-v1' },
  },
  concurrency: 3,
  budgetUSD: 1,
  ttsProvider: 'web',
  stageProviders: {
    'intent': ['kimi'],
    'outline-multi': ['kimi','qwen','glm','deepseek','openai','anthropic','gemini'],
    'outline-merge': ['qwen'],
    'write-sections': ['qwen','deepseek','openai','anthropic','gemini','kimi','glm'],
    'image-prompts': [],
    'image-generation': [],
    'merge-assembly': ['qwen'],
    'expert-review': ['qwen','openai','anthropic','gemini'],
    'fact-check': ['kimi'],
    'final-merge': ['qwen'],
  },
  imageStageProviders: {
    'image-generation': [],
  },
};

const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

async function loadFromDisk(): Promise<AppConfig | null> {
  try {
    const buf = await fs.readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(buf) as Partial<AppConfig>;
    // merge onto defaults to keep new fields
    const merged: AppConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      providers: { ...DEFAULT_CONFIG.providers, ...(parsed.providers || {}) } as Record<ModelProvider, ProviderConfig>,
      imageProviders: { ...DEFAULT_CONFIG.imageProviders, ...(parsed as any).imageProviders } as Record<ImageProvider, ProviderConfig>,
      stageProviders: { ...DEFAULT_CONFIG.stageProviders, ...(parsed.stageProviders || {}) } as Record<StageKey, ModelProvider[]>,
      imageStageProviders: { ...DEFAULT_CONFIG.imageStageProviders, ...((parsed as any).imageStageProviders || {}) } as Record<'image-generation', ImageProvider[]>,
    } as AppConfig;
    return merged;
  } catch {
    return null;
  }
}

async function saveToDisk(cfg: AppConfig) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {}
}

// Initialize from disk synchronously to avoid race on first request
let _config: AppConfig = (() => {
  try {
    if (fsSync.existsSync(CONFIG_FILE)) {
      const buf = fsSync.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(buf) as Partial<AppConfig>;
      const merged: AppConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        providers: { ...DEFAULT_CONFIG.providers, ...(parsed.providers || {}) } as Record<ModelProvider, ProviderConfig>,
        imageProviders: { ...DEFAULT_CONFIG.imageProviders, ...(parsed as any).imageProviders } as Record<ImageProvider, ProviderConfig>,
        stageProviders: { ...DEFAULT_CONFIG.stageProviders, ...(parsed.stageProviders || {}) } as Record<StageKey, ModelProvider[]>,
        imageStageProviders: { ...DEFAULT_CONFIG.imageStageProviders, ...((parsed as any).imageStageProviders || {}) } as Record<'image-generation', ImageProvider[]>,
      } as AppConfig;
      return merged;
    }
  } catch {}
  return DEFAULT_CONFIG;
})();

// Keep async refresh (best-effort) in case file changes externally
(async () => {
  const loaded = await loadFromDisk();
  if (loaded) _config = loaded;
})();

export function getConfig(): AppConfig {
  return _config;
}

export function setConfig(next: Partial<AppConfig>) {
  _config = {
    ..._config,
    ...next,
    providers: { ..._config.providers, ...(next.providers || {}) },
    imageProviders: { ..._config.imageProviders, ...((next as any).imageProviders || {}) },
    stageProviders: { ..._config.stageProviders, ...(next.stageProviders || {}) },
    imageStageProviders: { ...(_config.imageStageProviders||{}), ...((next as any).imageStageProviders || {}) },
  } as AppConfig;
  // persist
  void saveToDisk(_config);
}