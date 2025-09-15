import { v4 as uuidv4 } from 'uuid';
import { Outline, Intent, DraftSection, Review, FinalDoc, UploadedFile } from '@/lib/types';
import { getPrompts } from '@/lib/prompts';
import { getConfig, type ModelProvider, type StageKey } from '@/lib/config';
import fs from 'fs/promises';
import path from 'path';
import simpleGit from 'simple-git';
import { getClient } from '@/lib/llm/providers';
import type { LLMRequest, LLMResponse } from '@/lib/llm/base';
import * as crypto from 'crypto';

export type RunNode = {
  id: string;
  type:
    | 'intent'
    | 'outline-multi'
    | 'outline-merge'
    | 'write-sections'
    | 'image-prompts'
    | 'image-generation'
    | 'merge-assembly'
    | 'expert-review'
    | 'fact-check'
    | 'final-merge'
    | 'git'
    | 'tts';
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt?: number;
  endedAt?: number;
  costUSD?: number;
  data?: unknown;
};

export type RunState = {
  id: string;
  nodes: RunNode[];
  outline?: Outline;
  draftSections?: DraftSection[];
  final?: FinalDoc;
};

function now() {
  return Date.now();
}
function node(id: string, type: RunNode['type']): RunNode {
  return { id, type, status: 'idle' };
}

// 新增：结果形状校验与兜底构造
function isOutlineLike(o: any): o is Outline {
  return !!o && Array.isArray((o as any).sections);
}
function fallbackOutline(intent: Intent): Outline {
  return {
    title: intent.topic || '未命名主题',
    sections: Array.from({ length: 5 }, (_, j) => ({
      id: uuidv4(),
      title: `部分 ${j + 1}`,
      bullets: ['要点A', '要点B'],
    })),
  };
}

export async function runPipeline(input: { intent: Intent; files?: UploadedFile[] }, options?: { onUpdate?: (state: RunState) => void | Promise<void>, signal?: AbortSignal }): Promise<RunState> {
  const run: RunState = { id: uuidv4(), nodes: [] };
  const prompts = getPrompts();
  const cfg = getConfig();

  const baseDir = path.join(
    process.cwd(),
    'runs',
    `${new Date().toISOString().replace(/[:.]/g, '-')}_${run.id}`,
  );
  async function snapshot(stage: string, payload: unknown) {
    try {
      await fs.mkdir(baseDir, { recursive: true });
      const filePath = path.join(baseDir, `${stage}.json`);
      await fs.writeFile(
        filePath,
        JSON.stringify({ stage, when: new Date().toISOString(), payload }, null, 2),
        'utf8',
      );
      // try git commit
      try {
        const git = simpleGit(process.cwd());
        await git.add([path.relative(process.cwd(), filePath)]);
        const commitMsg = `[run:${run.id}] ${stage}`;
        await git.commit(commitMsg);
        const rev = await git.revparse(['--short', 'HEAD']);
        return rev.trim();
      } catch {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }

  // helpers
  const emit = async () => {
    try {
      if (options?.onUpdate) {
        // 传递可序列化的浅拷贝
        const copy: RunState = JSON.parse(JSON.stringify(run));
        await options.onUpdate(copy);
      }
    } catch {}
  };
  const checkAbort = () => {
    if (options?.signal?.aborted) {
      throw new Error('aborted');
    }
  };

  // helpers for multi-provider calls（仅限 config.StageKey 支持的阶段，不包含 image-prompts/git/tts）
  const selected = (stage: StageKey): ModelProvider[] => {
    const candidates = cfg.stageProviders[stage] || [];
    return candidates.filter((p) => cfg.providers[p]?.enabled);
  };
  const modelOf = (p: ModelProvider) => cfg.providers[p]?.model || '';
  const askJSON = async <T,>(
    p: ModelProvider,
    messages: LLMRequest['messages'],
  ): Promise<T | undefined> => {
    try {
      const res: LLMResponse<T> = await getClient(p).chat<T>({ model: modelOf(p), messages, json: true });
      if (res.ok) return res.data as T;
      return undefined;
    } catch {
      return undefined;
    }
  };
  const askText = async (
    p: ModelProvider,
    messages: LLMRequest['messages'],
  ): Promise<string | undefined> => {
    try {
      const res: LLMResponse<string> = await getClient(p).chat<string>({ model: modelOf(p), messages });
      if (res.ok) {
        const data: unknown = res.data as unknown;
        if (typeof data === 'string') return data;
        // 非字符串结果时返回 undefined，交由上游使用占位文案兜底，避免出现 "[object Object]"
        return undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  // 1) 意图评估
  run.nodes.push(node('intent', 'intent'));
  run.nodes[0].status = 'running';
  run.nodes[0].startedAt = now();
  const providersIntent = selected('intent');
  run.nodes[0].data = {
    intent: input.intent,
    files: input.files || [],
    prompt: prompts['intent'],
    providers: providersIntent,
  };
  run.nodes[0].status = 'done';
  run.nodes[0].endedAt = now();
  await emit();
  const c1 = await snapshot('01_intent', run.nodes[0].data);
  checkAbort();

  // 2) 多模型并发大纲
  run.nodes.push(node('outline-multi', 'outline-multi'));
  run.nodes[1].status = 'running';
  run.nodes[1].startedAt = now();
  const providersOutlineMulti = selected('outline-multi');
  const outlineMessages: LLMRequest['messages'] = [
    { role: 'system', content: prompts['outline-multi'] },
    {
      role: 'user',
      content: JSON.stringify(
        {
          topic: input.intent.topic,
          audience: input.intent.audience,
          style: input.intent.style,
        },
        null,
        2,
      ),
    },
  ];
  const outlineResults = await Promise.allSettled(
    providersOutlineMulti.map((p) => askJSON<Outline>(p, outlineMessages)),
  );
  let outlines: Outline[] = outlineResults
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => (r as PromiseFulfilledResult<Outline | undefined>).value!) as Outline[];
  // 兜底：过滤不合规结果
  outlines = outlines.filter(isOutlineLike);
  if (outlines.length === 0) {
    outlines = [fallbackOutline(input.intent), fallbackOutline(input.intent), fallbackOutline(input.intent)];
  }
  run.nodes[1].data = { outlines, prompt: prompts['outline-multi'], providers: providersOutlineMulti };
  run.nodes[1].status = 'done';
  run.nodes[1].endedAt = now();
  await emit();
  const c2 = await snapshot('02_outline-multi', run.nodes[1].data);
  checkAbort();

  // 3) 合并大纲
  run.nodes.push(node('outline-merge', 'outline-merge'));
  run.nodes[2].status = 'running';
  run.nodes[2].startedAt = now();
  const providersOutlineMerge = selected('outline-merge');
  let merged: Outline | undefined;
  if (providersOutlineMerge.length > 0) {
    const mergeMessages: LLMRequest['messages'] = [
      { role: 'system', content: prompts['outline-merge'] },
      { role: 'user', content: JSON.stringify({ outlines }, null, 2) },
    ];
    for (const p of providersOutlineMerge) {
      const out = await askJSON<Outline>(p, mergeMessages);
      if (out && isOutlineLike(out)) {
        merged = out;
        break;
      }
    }
  }
  // 兜底：无可用合并结果时，使用多纲要聚合或意图占位
  if (!merged || !isOutlineLike(merged)) {
    if (outlines.length > 0 && isOutlineLike(outlines[0])) {
      merged = {
        title: outlines[0].title,
        sections: outlines.flatMap((o) => Array.isArray(o.sections) ? o.sections : []).slice(0, 5),
      } as Outline;
    } else {
      merged = fallbackOutline(input.intent);
    }
  }
  run.outline = merged;
  run.nodes[2].data = { outline: merged, prompt: prompts['outline-merge'], providers: providersOutlineMerge };
  run.nodes[2].status = 'done';
  run.nodes[2].endedAt = now();
  await emit();
  const c3 = await snapshot('03_outline-merge', run.nodes[2].data);
  checkAbort();

  // 4) 分工写作
  run.nodes.push(node('write-sections', 'write-sections'));
  run.nodes[3].status = 'running';
  run.nodes[3].startedAt = now();
  const providersWrite = selected('write-sections');
  let drafts: DraftSection[] = [];
  // 使用安全的章节列表
  const baseSections = isOutlineLike(merged) && Array.isArray(merged.sections) && merged.sections.length > 0
    ? merged.sections
    : fallbackOutline(input.intent).sections;
  if (providersWrite.length > 0) {
    const tasks = baseSections.map((s, idx) => ({ s, p: providersWrite[idx % providersWrite.length] }));
    const results = await Promise.allSettled(
      tasks.map(async ({ s, p }) => {
        const messages: LLMRequest['messages'] = [
          { role: 'system', content: prompts['write-sections'] },
          { role: 'user', content: JSON.stringify({ section: s, intent: input.intent }, null, 2) },
        ];
        const md = await askText(p, messages);
        return {
          sectionId: s.id,
          markdown: md && md.trim().length > 0 ? md : `# ${s.title}\n\n这里是占位内容。`,
        } as DraftSection;
      }),
    );
    drafts = results.map((r) => (r.status === 'fulfilled' ? r.value : undefined)).filter(Boolean) as DraftSection[];
  }
  if (drafts.length === 0) {
    drafts = baseSections.map((s) => ({ sectionId: s.id, markdown: `# ${s.title}\n\n这里是占位内容。` }));
  }
  run.draftSections = drafts;
  run.nodes[3].data = { drafts, prompt: prompts['write-sections'], providers: providersWrite };
  run.nodes[3].status = 'done';
  run.nodes[3].endedAt = now();
  await emit();
  const c4 = await snapshot('04_write-sections', run.nodes[3].data);
  checkAbort();

  // 4b) 图片提示词（本地构造占位，可选调用模型）
  run.nodes.push(node('image-prompts', 'image-prompts'));
  const imgNodeIdx = run.nodes.length - 1;
  run.nodes[imgNodeIdx].status = 'running';
  run.nodes[imgNodeIdx].startedAt = now();
  const secForImages = (run.outline && Array.isArray(run.outline.sections) && run.outline.sections.length>0)
    ? run.outline.sections
    : (Array.isArray(baseSections) ? baseSections : []);
  const images = secForImages.map((s, i) => ({
    sectionId: s.id,
    title: s.title || `部分 ${i+1}`,
    prompt: `为主题“${input.intent.topic||''}”，章节“${s.title||`部分 ${i+1}`}”生成一幅配图：主体清晰、场景贴合内容；风格：${input.intent.style||'写实/插画皆可'}；构图合理（三分法/居中）；光线自然；避免文字水印、过度暴力或敏感元素；输出一行中文描述。`
  }));
  const imagePrompts = { images };
  run.nodes[imgNodeIdx].data = { imagePrompts, prompt: prompts['image-prompts'], providers: [] } as unknown;
  run.nodes[imgNodeIdx].status = 'done';
  run.nodes[imgNodeIdx].endedAt = now();
  await emit();
  const c4b = await snapshot('04b_image-prompts', run.nodes[imgNodeIdx].data);
  checkAbort();

  // 4c) 图片生成（占位 SVG，如无真实图片提供商）
  run.nodes.push(node('image-generation', 'image-generation'));
  const imgGenIdx = run.nodes.length - 1;
  run.nodes[imgGenIdx].status = 'running';
  run.nodes[imgGenIdx].startedAt = now();
  // 生成 SVG 占位图（避免外部依赖）。若后续接入真实图片服务，可在此分支调用。
  const toSvgDataUri = (title: string) => {
    const safe = String(title || '配图').slice(0, 40);
    const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><defs><style>@import url('https://fonts.googleapis.com/css2?family=Noto+Sans');</style></defs><rect width="100%" height="100%" fill="#e5e7eb"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="28" fill="#111827">${safe}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  };

  // 如果启用了图片供应商，并包含 jimeng，尝试真实生成
  async function jimengText2Image(promptStr: string, width = 1024, height = 1024): Promise<string | undefined> {
    // helper: loosely extract SK from apiKey (supports base64/double-base64/JSON/kv)
    const extractSkFromApiKey = (raw: string): string => {
      const sanitize = (s: string) => s.replace(/\s+/g, '');
      const tryB64 = (s: string) => { try { return Buffer.from(sanitize(s), 'base64').toString('utf8'); } catch { return ''; } };
      let t = (raw || '').trim();
      for (let i = 0; i < 2; i++) {
        const dec = tryB64(t);
        if (dec && dec !== t) { t = dec; } else { break; }
      }
      try {
        const obj = JSON.parse(t);
        const cand = (obj as any).sk || (obj as any).secret || (obj as any).secretKey || (obj as any).secretAccessKey || (obj as any).SECRET_ACCESS_KEY;
        if (typeof cand === 'string' && cand.trim()) return String(cand).trim();
      } catch {}
      const m = t.match(/(?:^|[;&,\s])sk[:=]([A-Za-z0-9._+\-\/=]{20,128})/i);
      if (m) return m[1].trim();
      if (/^[0-9a-f]{32,64}$/i.test(t) || /^[A-Za-z0-9._+\-\/=]{20,128}$/.test(t)) return t;
      return '';
    };
    // helper: loosely extract AK from ak field or apiKey sidecar
    const extractAk = (akRaw: string, apiKeyRaw?: string): string => {
      const sanitize = (s: string) => s.replace(/\s+/g, '');
      const tryB64 = (s: string) => { try { return Buffer.from(sanitize(s), 'base64').toString('utf8'); } catch { return ''; } };
      const tryJSON = (s: string) => { try { return JSON.parse(sanitize(s)); } catch { return null; } };
      const pickAk = (s: string) => {
        const t = s.trim();
        if (/^AKL[0-9A-Za-z]/.test(t)) return t; // looks like volc AK
        const m = t.match(/(?:^|[;&,\s])ak[:=](AKL[A-Za-z0-9]+)/i);
        if (m) return m[1].trim();
        return '';
      };
      let t = (akRaw || '').trim();
      if (/^[A-Za-z0-9+/=]+$/.test(t) && t.length % 4 === 0) {
        const dec = tryB64(t);
        if (pickAk(dec)) return pickAk(dec);
      }
      if (pickAk(t)) return pickAk(t);
      if (apiKeyRaw && apiKeyRaw.trim()) {
        let side = apiKeyRaw.trim();
        for (let i = 0; i < 2; i++) {
          const dec = tryB64(side);
          if (dec && dec !== side) side = dec; else break;
        }
        const obj = tryJSON(side);
        if (obj) {
          const cand = (obj as any).ak || (obj as any).accessKey || (obj as any).access_key_id || (obj as any).AccessKeyId;
          if (typeof cand === 'string' && /^AKL[0-9A-Za-z]/.test(cand)) return cand.trim();
        }
        if (pickAk(side)) return pickAk(side);
      }
      return t; // fall back raw
    };

    try {
      // Prefer ak/sk from config if present (set via settings page), fallback to env
      const cfgJimeng = (cfg as any)?.imageProviders?.jimeng || {};
      const akFromCfg = (cfgJimeng.ak || '').trim();
      let skFromCfg = (cfgJimeng.sk || '').trim();
      if (!skFromCfg && typeof cfgJimeng.apiKey === 'string' && cfgJimeng.apiKey.trim()) {
        skFromCfg = extractSkFromApiKey(cfgJimeng.apiKey);
      }
      const akCandidate = extractAk(akFromCfg, typeof cfgJimeng.apiKey === 'string' ? cfgJimeng.apiKey : undefined);
      const ak = (akCandidate || process.env.VOLC_ACCESS_KEY_ID || process.env.VOLCENGINE_ACCESS_KEY_ID || '').trim();
      const sk = (skFromCfg || process.env.VOLC_SECRET_ACCESS_KEY || process.env.VOLCENGINE_SECRET_ACCESS_KEY || '').trim();
      if (!ak || !sk) return undefined;
      const region = 'cn-north-1';
      const service = 'cv';
      const host = 'visual.volcengineapi.com';
      // req_key 默认按文档 jimeng_t2i_v40，可由环境覆盖
      const reqKey = (process.env.VOLC_JIMENG_REQ_KEY || 'jimeng_t2i_v40').trim();

      const nowDate = new Date();
      const yyyy = nowDate.getUTCFullYear();
      const mm = String(nowDate.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(nowDate.getUTCDate()).padStart(2, '0');
      const HH = String(nowDate.getUTCHours()).padStart(2, '0');
      const MM = String(nowDate.getUTCMinutes()).padStart(2, '0');
      const SS = String(nowDate.getUTCSeconds()).padStart(2, '0');
      const date = `${yyyy}${mm}${dd}`;
      const xDate = `${date}T${HH}${MM}${SS}Z`;
      const canonicalURI = '/';

      const signAndBuild = (
        action: 'CVSync2AsyncSubmitTask' | 'CVSync2AsyncGetResult',
        bodyJson: string
      ) => {
        const canonicalQuery = `Action=${action}&Version=2022-08-31`;
        const hashHex = crypto.createHash('sha256').update(bodyJson).digest('hex');
        const headersForSigning: Record<string, string> = {
          'content-type': 'application/json',
          host,
          'x-content-sha256': hashHex,
          'x-date': xDate,
        };
        const signedHeaders = 'content-type;host;x-content-sha256;x-date';
        const canonicalHeaders = `content-type:${headersForSigning['content-type']}\nhost:${headersForSigning.host}\nx-content-sha256:${headersForSigning['x-content-sha256']}\nx-date:${headersForSigning['x-date']}\n`;
        const canonicalRequest = ['POST', canonicalURI, canonicalQuery, canonicalHeaders, signedHeaders, hashHex].join('\n');
        const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
        const scope = `${date}/${region}/${service}/request`;
        const stringToSign = ['HMAC-SHA256', xDate, scope, canonicalRequestHash].join('\n');
        const kDate = crypto.createHmac('sha256', sk).update(date).digest();
        const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
        const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
        const kSigning = crypto.createHmac('sha256', kService).update('request').digest();
        const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
        const authorization = `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Date': xDate,
          'X-Content-Sha256': hashHex,
          Host: host,
          Authorization: authorization,
        };
        const sessionToken = process.env.VOLC_SESSION_TOKEN || process.env.VOLC_SECURITY_TOKEN || process.env.X_SECURITY_TOKEN || '';
        if (sessionToken) headers['X-Security-Token'] = sessionToken;
        const endpoint = `https://${host}/?${canonicalQuery}`;
        return { endpoint, headers };
      };

      // 1) 提交
      const submitBody = JSON.stringify({ req_key: reqKey, prompt: promptStr, width, height, return_url: true });
      const submitReq = signAndBuild('CVSync2AsyncSubmitTask', submitBody);
      const respSubmit = await fetch(submitReq.endpoint, { method: 'POST', headers: submitReq.headers as any, body: submitBody });
      if (!respSubmit.ok) return undefined;
      const submitJson: any = await respSubmit.json().catch(() => ({}));
      const taskId = submitJson?.data?.task_id || submitJson?.Data?.TaskId || submitJson?.task_id;
      if (!taskId) return undefined;

      // 2) 轮询
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let attempt = 0; attempt < 20; attempt++) {
        const reqJson = { return_url: true };
        const getBody = JSON.stringify({ req_key: reqKey, task_id: String(taskId), req_json: JSON.stringify(reqJson) });
        const getReq = signAndBuild('CVSync2AsyncGetResult', getBody);
        const resp = await fetch(getReq.endpoint, { method: 'POST', headers: getReq.headers as any, body: getBody });
        if (!resp.ok) {
          if (resp.status === 429 || resp.status >= 500) { await sleep(1200); continue; }
          return undefined;
        }
        const jr: any = await resp.json().catch(() => ({}));
        // 扩展 URL 解析
        const candidates: string[] = [];
        const pushMaybe = (v: any) => {
          if (typeof v === 'string' && v) candidates.push(v);
          else if (Array.isArray(v)) for (const u of v) if (typeof u === 'string' && u) candidates.push(u);
        };
        pushMaybe(jr?.data?.image_urls);
        pushMaybe(jr?.Result?.ImageUrls);
        pushMaybe(jr?.image_urls);
        pushMaybe(jr?.data?.url);
        pushMaybe(jr?.data?.image_url);
        pushMaybe(jr?.Result?.Url);
        pushMaybe(jr?.Result?.ImageUrl);
        pushMaybe(jr?.Data?.Url);
        pushMaybe(jr?.data?.images?.[0]?.url);
        pushMaybe(jr?.data?.result?.image_urls);
        if (candidates.length > 0) return candidates[0];
        const b64: string[] = (jr?.data?.binary_data_base64) || (jr?.BinaryDataBase64) || [];
        if (Array.isArray(b64) && b64.length > 0 && typeof b64[0] === 'string' && b64[0].length > 0) return `data:image/jpeg;base64,${b64[0]}`;
        const st = (jr?.data?.status || jr?.Status || '').toString().toLowerCase();
        if (st === 'done' || st === 'success' || st === 'succeeded' || st === 'finished' || st === 'not_found' || st === 'expired') break;
        await sleep(1200);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  let imageGen: any[] = [];
  try {
    const imgProviders = (cfg.imageStageProviders?.['image-generation'] || []) as string[];
    const enabled = (imgProviders && imgProviders.length > 0 ? imgProviders : Object.keys(cfg.imageProviders || {}).filter((k) => (cfg.imageProviders as any)?.[k]?.enabled));
    const akFromCfg = ((cfg as any)?.imageProviders?.jimeng?.ak ?? '').trim();
    let skFromCfg = ((cfg as any)?.imageProviders?.jimeng?.sk ?? '').trim();
    const apiKeyFromCfg = ((cfg as any)?.imageProviders?.jimeng?.apiKey ?? '').trim();
    const looseExtract = (raw: string): string => {
      try {
        const sanitize = (s: string) => s.replace(/\s+/g, '');
        const tryB64 = (s: string) => { try { return Buffer.from(sanitize(s), 'base64').toString('utf8'); } catch { return ''; } };
        let t = raw;
        for (let i = 0; i < 2; i++) { const dec = tryB64(t); if (dec && dec !== t) t = dec; else break; }
        try { const obj = JSON.parse(t); const cand = (obj as any).sk || (obj as any).secret || (obj as any).secretKey || (obj as any).secretAccessKey || (obj as any).SECRET_ACCESS_KEY; if (typeof cand === 'string' && cand.trim()) return String(cand).trim(); } catch {}
        const m = t.match(/(?:^|[;&,\s])sk[:=]([A-Za-z0-9._+\-\/=]{20,128})/i); if (m) return m[1].trim();
        if (/^[0-9a-f]{32,64}$/i.test(t) || /^[A-Za-z0-9._+\-\/=]{20,128}$/.test(t)) return t;
        return '';
      } catch { return ''; }
    };
    if (!skFromCfg && apiKeyFromCfg) skFromCfg = looseExtract(apiKeyFromCfg);
    const envHasAk = !!(process.env.VOLC_ACCESS_KEY_ID || process.env.VOLCENGINE_ACCESS_KEY_ID);
    const envHasSk = !!(process.env.VOLC_SECRET_ACCESS_KEY || process.env.VOLCENGINE_SECRET_ACCESS_KEY);
    const hasCred = ((akFromCfg && (skFromCfg || (apiKeyFromCfg && looseExtract(apiKeyFromCfg)))) || (envHasAk && envHasSk));
    const useJimeng = enabled.includes('jimeng') && hasCred;
    let imgGenReason = '';
    if (!enabled.includes('jimeng')) {
      imgGenReason = 'image-generation 未选择 jimeng，使用占位图';
    } else if (!hasCred) {
      imgGenReason = `缺少 AK/SK（设置页或 .env.local），回退占位图；ak:${!!akFromCfg||envHasAk}, sk:${!!skFromCfg||envHasSk||!!apiKeyFromCfg}`;
    } else if (akFromCfg && (skFromCfg || (apiKeyFromCfg && looseExtract(apiKeyFromCfg)))) {
      imgGenReason = '使用 jimeng（凭据来自设置页，串行并发=1）';
    } else {
      imgGenReason = '使用 jimeng（凭据来自 .env.local，串行并发=1）';
    }

    if (useJimeng && imagePrompts && Array.isArray((imagePrompts as any).images)) {
      const items = (imagePrompts as any).images as any[];
      const results: any[] = [];
      for (const it of items) {
        const url = await jimengText2Image(it.prompt);
        results.push({ sectionId: it.sectionId, title: it.title, prompt: it.prompt, url: url || toSvgDataUri(it.title) });
      }
      imageGen = results;
    } else {
      imageGen = (imagePrompts && Array.isArray((imagePrompts as any).images))
        ? (imagePrompts as any).images.map((it: any) => ({ sectionId: it.sectionId, title: it.title, prompt: it.prompt, url: toSvgDataUri(it.title) }))
        : [] as any[];
    }
    // 首次写入包含 provider/info 的数据
    run.nodes[imgGenIdx].data = { images: imageGen, provider: useJimeng ? 'jimeng' : 'placeholder', info: imgGenReason } as unknown;
  } catch {
    imageGen = (imagePrompts && Array.isArray((imagePrompts as any).images))
      ? (imagePrompts as any).images.map((it: any) => ({ sectionId: it.sectionId, title: it.title, prompt: it.prompt, url: toSvgDataUri(it.title) }))
      : [] as any[];
    // 发生异常时也保留原因
    const prev = (run.nodes[imgGenIdx].data as any) || {};
    run.nodes[imgGenIdx].data = { ...prev, images: imageGen, provider: prev?.provider || 'placeholder', info: prev?.info || '异常回退占位图' } as unknown;
  }

  // 不要覆盖已有的 provider/info，仅更新 images
  {
    const prev = (run.nodes[imgGenIdx].data as any) || {};
    run.nodes[imgGenIdx].data = { ...prev, images: imageGen } as unknown;
  }
  run.nodes[imgGenIdx].status = 'done';
  run.nodes[imgGenIdx].endedAt = now();
  await emit();
  const c4c = await snapshot('04c_image-generation', run.nodes[imgGenIdx].data);
  checkAbort();

  // 5) 合并汇编
  run.nodes.push(node('merge-assembly', 'merge-assembly'));
  const assemblyIdx = run.nodes.length - 1;
  run.nodes[assemblyIdx].status = 'running';
  run.nodes[assemblyIdx].startedAt = now();
  const providersAssembly = selected('merge-assembly');
  let mergedDoc: FinalDoc | undefined;
  if (providersAssembly.length > 0) {
    const messages: LLMRequest['messages'] = [
      { role: 'system', content: prompts['merge-assembly'] },
      { role: 'user', content: JSON.stringify({ drafts }, null, 2) },
    ];
    for (const p of providersAssembly) {
      const md = await askText(p, messages);
      if (md && md.trim().length > 0) {
        mergedDoc = { markdown: md };
        break;
      }
    }
  }
  if (!mergedDoc) {
    mergedDoc = { markdown: drafts.map((d) => d.markdown).join('\n\n') };
  }
  run.nodes[assemblyIdx].data = { doc: mergedDoc, prompt: prompts['merge-assembly'], providers: providersAssembly };
  run.nodes[assemblyIdx].status = 'done';
  run.nodes[assemblyIdx].endedAt = now();
  await emit();
  const c5 = await snapshot('05_merge-assembly', run.nodes[assemblyIdx].data);
  checkAbort();

  // 6) 专家评审
  run.nodes.push(node('expert-review', 'expert-review'));
  const reviewIdx = run.nodes.length - 1;
  run.nodes[reviewIdx].status = 'running';
  run.nodes[reviewIdx].startedAt = now();
  const providersReview = selected('expert-review');
  let review: Review | undefined;
  if (providersReview.length > 0) {
    const messages: LLMRequest['messages'] = [
      { role: 'system', content: prompts['expert-review'] },
      { role: 'user', content: JSON.stringify({ doc: mergedDoc, outline: merged, intent: input.intent }, null, 2) },
    ];
    for (const p of providersReview) {
      const out = await askJSON<Review>(p, messages);
      if (out) {
        review = out;
        break;
      }
    }
  }
  if (!review) review = { issues: [] };
  run.nodes[reviewIdx].data = { review, prompt: prompts['expert-review'], providers: providersReview };
  run.nodes[reviewIdx].status = 'done';
  run.nodes[reviewIdx].endedAt = now();
  await emit();
  const c6 = await snapshot('06_expert-review', run.nodes[reviewIdx].data);
  checkAbort();

  // 7) 事实核验
  run.nodes.push(node('fact-check', 'fact-check'));
  const factIdx = run.nodes.length - 1;
  run.nodes[factIdx].status = 'running';
  run.nodes[factIdx].startedAt = now();
  const providersFact = selected('fact-check');
  let factData: unknown = undefined;
  if (providersFact.length > 0) {
    const messages: LLMRequest['messages'] = [
      { role: 'system', content: prompts['fact-check'] },
      { role: 'user', content: JSON.stringify({ doc: mergedDoc }, null, 2) },
    ];
    for (const p of providersFact) {
      const out = await askJSON<unknown>(p, messages);
      if (out) {
        factData = out;
        break;
      }
    }
  }
  if (!factData) factData = { verified: false, notes: ['占位：联网核验未启用'] } as unknown;
  run.nodes[factIdx].data = { ...(factData as object), prompt: prompts['fact-check'], providers: providersFact } as unknown;
  run.nodes[factIdx].status = 'done';
  run.nodes[factIdx].endedAt = now();
  await emit();
  const c7 = await snapshot('07_fact-check', run.nodes[factIdx].data);

  // 8) 终稿合并
  run.nodes.push(node('final-merge', 'final-merge'));
  const finalIdx = run.nodes.length - 1;
  run.nodes[finalIdx].status = 'running';
  run.nodes[finalIdx].startedAt = now();
  const providersFinal = selected('final-merge');
  let final: FinalDoc | undefined;
  if (providersFinal.length > 0) {
    const messages: LLMRequest['messages'] = [
      { role: 'system', content: prompts['final-merge'] },
      { role: 'user', content: JSON.stringify({ doc: mergedDoc || { markdown: '' }, review, intent: input.intent, imagePrompts }, null, 2) },
    ];
    // 优先使用支持流的提供商；逐 token 累积并回传
    let acc = '';
    for (const p of providersFinal) {
      try {
        const res = await getClient(p).chat<string>({
          model: modelOf(p),
          messages,
          stream: true,
          onToken: (tok: string) => {
            acc += tok;
            // 实时更新 run.final 并推送前端
            run.final = { markdown: acc };
            run.nodes[finalIdx].data = { final: run.final, prompt: prompts['final-merge'], providers: providersFinal };
            // 非阻塞推送更新
            try {
              const copy: RunState = JSON.parse(JSON.stringify(run));
              if (options?.onUpdate) void options.onUpdate(copy);
            } catch {}
          },
        });
        if (res.ok) {
          const md = typeof res.data === 'string' ? res.data : '';
          if (md && md.trim().length > 0) {
            final = { markdown: md };
            break;
          }
        }
      } catch {
        // 尝试下一个提供商
      }
    }
  }
  if (!final) final = { markdown: (mergedDoc?.markdown || drafts.map(d=>d.markdown).join('\n\n')) + '\n\n（终稿占位）' };

  // 结构兜底：若缺少二级标题，则按大纲拆分为“## 标题 + 正文”，正文取 drafts 内容
  try {
    const md0 = final.markdown || '';
    const hasH2 = /(^|\n)##\s+/.test(md0);
    if (!hasH2) {
      const sections = (run.outline && Array.isArray(run.outline.sections)) ? run.outline.sections : [];
      const parts: string[] = [];
      const titleMatch = md0.match(/^\s*#\s+[^\n]+/m);
      if (titleMatch) {
        parts.push(titleMatch[0].trim());
      } else {
        parts.push('# 终稿');
      }
      const body = md0.replace(/^\s*#\s+[^\n]+\n?/, '').trim();
      if (body.length > 0) parts.push('\n\n## 概述\n\n' + body);
      sections.forEach((s: any, idx: number) => {
        const d = (drafts || []).find((dr) => dr.sectionId === s.id)?.markdown || '';
        const dBody = d.replace(/^\s*#\s+[^\n]+\n?/, '').trim();
        parts.push(`\n\n## ${idx + 1}. ${s.title}\n\n${dBody}`);
      });
      final = { markdown: parts.join('') };
    }
  } catch {}

  // 附：图片提示词附录，确保成品包含图片提示词
  try {
    if (imagePrompts && Array.isArray(imagePrompts.images) && imagePrompts.images.length > 0) {
      const appendix = ['\n\n## 附录：图片提示词',
        ...imagePrompts.images.map((it: any, idx: number) => `- ${idx+1}. ${it.title}: ${it.prompt}`)
      ].join('\n');
      final = { markdown: (final.markdown || '') + appendix };
    }
  } catch {}

  // 附：图片内联优先，其次画廊兜底
  try {
    const imgList = (Array.isArray(imageGen) ? imageGen : []) as any[];
    if (imgList.length > 0) {
      const idTitle = new Map<string,string>();
      try {
        const sections = (run.outline && Array.isArray((run.outline as any).sections)) ? (run.outline as any).sections : [];
        sections.forEach((s: any) => { if (s && s.id && s.title) idTitle.set(String(s.id), String(s.title)); });
      } catch {}

      const normalize = (s: string) => (s||'').normalize('NFKC').replace(/\s+/g,'').replace(/[\p{P}\p{S}]+/gu,'').toLowerCase();
      const headingText = (line: string) => String(line||'').replace(/^#+\s*/, '').trim();

      let md = final.markdown || '';
      const lines = md.split('\n');
      const used: boolean[] = imgList.map(()=>false);

      const findHeadingIndex = (title: string): number => {
        const nTitle = normalize(title);
        if (!nTitle) return -1;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/^##\s+/.test(line)) {
            const ht = headingText(line);
            const nHead = normalize(ht);
            if (nHead.includes(nTitle) || nTitle.includes(nHead)) return i;
          }
        }
        return -1;
      };

      // 1) 按小节在 H2 下方内联插图
      imgList.forEach((it: any, idx: number) => {
        const title = (it && (it.title || idTitle.get(String(it.sectionId)))) || '';
        const url = (it && typeof it.url === 'string' && it.url.trim().length>0) ? it.url : toSvgDataUri(title || `配图${idx+1}`);
        const hIdx = findHeadingIndex(title);
        if (hIdx >= 0) {
          const insertAt = hIdx + 1;
          const imgLine = `![${title || `配图${idx+1}`}](${url})`;
          lines.splice(insertAt, 0, '', imgLine, '');
          used[idx] = true;
        }
      });

      md = lines.join('\n');

      // 2) 未匹配到标题的，拼接“图片预览”画廊兜底
      const leftovers = imgList.filter((_: any, i: number) => !used[i]);
      if (leftovers.length > 0) {
        const gallery = ['\n\n## 图片预览',
          ...leftovers.map((it: any, idx: number) => `![${(it.title||`配图${idx+1}`)}](${(it.url && String(it.url).trim().length>0) ? it.url : toSvgDataUri(it.title||`配图${idx+1}`)})`)
        ].join('\n');
        md += gallery;
      }

      final = { markdown: md };
    }
  } catch {}

  // 标题统一：若文首没有以 # 开头的主标题，则补充
  try {
    const md = final.markdown || '';
    if (!/^\s*#\s+/m.test(md)) {
      final = { markdown: `# 终稿\n\n${md}` };
    }
  } catch {}
  run.final = final;
  run.nodes[finalIdx].data = { final, prompt: prompts['final-merge'], providers: providersFinal };
  run.nodes[finalIdx].status = 'done';
  run.nodes[finalIdx].endedAt = now();
  await emit();
  const c8 = await snapshot('08_final-merge', run.nodes[finalIdx].data);
  checkAbort();

  // 9) Git 与 10) TTS 标记
  run.nodes.push(node('git', 'git'));
  const gitInfo = { commits: [c1, c2, c3, c4, c4b, c4c, c5, c6, c7, c8].filter(Boolean) };
  run.nodes[run.nodes.length-1].data = gitInfo;
  run.nodes[run.nodes.length-1].status = 'done';

  run.nodes.push(node('tts', 'tts'));
  run.nodes[run.nodes.length-1].status = 'done';
  await emit();

  return run;
}
function selected(stage: string) {
  const cfg = getConfig() as any;
  if (stage === 'image-generation') {
    const cand = (cfg.imageStageProviders?.['image-generation'] || []) as string[];
    const enabled = cand.filter((p) => (cfg.imageProviders?.[p]?.enabled));
    return enabled.length > 0 ? enabled : Object.keys(cfg.imageProviders || {}).filter((k) => cfg.imageProviders?.[k]?.enabled);
  }
  const cand = (cfg.stageProviders?.[stage] || []) as string[];
  const enabled = cand.filter((p) => cfg.providers?.[p]?.enabled);
  return enabled.length > 0 ? enabled : Object.keys(cfg.providers || {}).filter((k) => cfg.providers?.[k]?.enabled);
}