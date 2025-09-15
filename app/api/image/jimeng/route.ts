import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import * as crypto from 'crypto';

export const runtime = 'nodejs';

// 新增：宽松解析 AK/SK 的工具函数
function tryBase64DecodeTwice(input: string): string {
  const sanitize = (s: string) => s.replace(/\s+/g, '');
  const tryB64 = (s: string) => {
    try { return Buffer.from(sanitize(s), 'base64').toString('utf8'); } catch { return ''; }
  };
  let t = input;
  for (let i = 0; i < 2; i++) {
    const dec = tryB64(t);
    if (dec && dec !== t) t = dec; else break;
  }
  return t;
}
function sanitizePrintable(input: string): string {
  return input.replace(/[^\x20-\x7E]+/g, '');
}
function extractAk(rawAk?: string, rawApiKey?: string): string {
  const sources = [rawAk, rawApiKey].filter(Boolean) as string[];
  for (const src of sources) {
    let original = (src || '').trim();
    if (!original) continue;

    // 0) 先在原始字符串上做一次直接识别，避免把 RAW AK (AKLT...) 被当作 base64 解码破坏
    const originalClean = sanitizePrintable(original);
    // 0.1) 直接包含 AK 形态（常见前缀 AKLT）
    const directRaw = originalClean.match(/(AKL[T0-9A-Za-z][0-9A-Za-z\-_=]{10,64})/);
    if (directRaw) return directRaw[1].trim();
    // 0.2) kv 片段（在原始字符串上）
    const kvRaw = originalClean.match(/(?:^|[;&,\s])(?:ak|access[_-]?key(?:id)?|AK)[:=]([A-Za-z0-9\-_=]{8,128})/i);
    if (kvRaw) return kvRaw[1].trim();
    // 0.3) JSON 结构（在原始字符串上）
    try {
      const obj0 = JSON.parse(originalClean);
      const cand0 = (obj0 as any).ak || (obj0 as any).accessKeyId || (obj0 as any).access_key_id || (obj0 as any).accessKey || (obj0 as any).AK;
      if (typeof cand0 === 'string' && cand0.trim()) return cand0.trim();
    } catch {}

    // 1) 再尝试宽松 base64 解码
    let t = tryBase64DecodeTwice(original);
    t = sanitizePrintable(t);
    // 1.1) JSON 结构
    try {
      const obj = JSON.parse(t);
      const cand = (obj as any).ak || (obj as any).accessKeyId || (obj as any).access_key_id || (obj as any).accessKey || (obj as any).AK;
      if (typeof cand === 'string' && cand.trim()) return cand.trim();
    } catch {}
    // 1.2) kv 片段
    const kv = t.match(/(?:^|[;&,\s])(?:ak|access[_-]?key(?:id)?|AK)[:=]([A-Za-z0-9\-_=]{8,128})/i);
    if (kv) return kv[1].trim();
    // 1.3) 直接包含 AK 形态（常见前缀 AKLT）
    const direct = t.match(/(AKL[T0-9A-Za-z][0-9A-Za-z\-_=]{10,64})/);
    if (direct) return direct[1].trim();
    // 1.4) 合法令牌形态
    if (/^[A-Za-z0-9\-_=]{12,128}$/.test(t)) return t;
  }
  return '';
}
function extractSk(rawSk?: string, rawApiKey?: string): string {
  const sources = [rawSk, rawApiKey].filter(Boolean) as string[];
  for (const src of sources) {
    let original = (src || '').trim();
    if (!original) continue;

    // 0) 先在原始字符串上判定（避免把 RAW SK 错误地先做 base64 解码）
    const originalClean = sanitizePrintable(original);
    // 0.1) JSON
    try {
      const obj0 = JSON.parse(originalClean);
      const cand0 = (obj0 as any).sk || (obj0 as any).secret || (obj0 as any).secretKey || (obj0 as any).secretAccessKey || (obj0 as any).SECRET_ACCESS_KEY;
      if (typeof cand0 === 'string' && cand0.trim()) return cand0.trim();
    } catch {}
    // 0.2) kv 片段
    const kvRaw = originalClean.match(/(?:^|[;&,\s])(?:sk|secret(?:access)?key)[:=]([A-Za-z0-9._+\-\/=]{20,128})/i);
    if (kvRaw) return kvRaw[1].trim();
    // 0.3) 常见形态：base64 或 32/64 位 hex 或无符号 token
    if (/^[0-9a-f]{32,64}$/i.test(originalClean) || /^[A-Za-z0-9._+\-\/=]{20,128}$/.test(originalClean)) return originalClean;

    // 1) 尝试宽松 base64 解码后再判定
    let t = tryBase64DecodeTwice(original);
    t = sanitizePrintable(t);
    // 1.1) JSON
    try {
      const obj = JSON.parse(t);
      const cand = (obj as any).sk || (obj as any).secret || (obj as any).secretKey || (obj as any).secretAccessKey || (obj as any).SECRET_ACCESS_KEY;
      if (typeof cand === 'string' && cand.trim()) return cand.trim();
    } catch {}
    // 1.2) kv
    const kv = t.match(/(?:^|[;&,\s])(?:sk|secret(?:access)?key)[:=]([A-Za-z0-9._+\-\/=]{20,128})/i);
    if (kv) return kv[1].trim();
    // 1.3) 常见形态：base64 或 32/64 位 hex 或无符号 token
    if (/^[0-9a-f]{32,64}$/i.test(t) || /^[A-Za-z0-9._+\-\/=]{20,128}$/.test(t)) return t;
  }
  return '';
}

const BodySchema = z.object({
  prompt: z.string().min(1),
  width: z.number().int().min(64).max(2048).optional().default(1024),
  height: z.number().int().min(64).max(2048).optional().default(1024),
});

export async function POST(req: NextRequest) {
  try {
    const json = await req.json().catch(() => ({}));
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
    }
    let { prompt, width, height } = parsed.data;

    // 统一尺寸到上游支持的安全集合（避免 height or width invalid）
    const SAFE_SIZES = [1024, 1280, 1536, 2048];
    const pick = (v?: number) => {
      const n = Math.max(64, Math.min(2048, Math.round((v || 1024) / 64) * 64));
      // 向上取到最近的安全尺寸（最低 1024，避免 512 报错）
      for (const s of SAFE_SIZES) { if (n <= s) return s; }
      return 1024;
    };
    width = pick(width);
    height = pick(height);

    const cfg: any = getConfig();
    const cfgJimeng = cfg?.imageProviders?.jimeng || {};
    const akCandidate = (cfgJimeng.ak || '').trim();
    const apiKeyRaw = (cfgJimeng.apiKey || '').trim();
    let skFromCfg = (cfgJimeng.sk || '').trim();

    // 提取 AK/SK
    let ak = extractAk(akCandidate, apiKeyRaw).trim();
    let sk = extractSk(skFromCfg, apiKeyRaw).trim();

    // env 覆盖
    if (!ak) ak = (process.env.VOLC_ACCESS_KEY_ID || process.env.VOLCENGINE_ACCESS_KEY_ID || '').trim();
    if (!sk) sk = (process.env.VOLC_SECRET_ACCESS_KEY || process.env.VOLCENGINE_SECRET_ACCESS_KEY || '').trim();
    if (!ak || !sk) {
      return NextResponse.json({ ok: false, error: 'missing credentials (ak/sk)' }, { status: 400 });
    }

    // 固定服务/地域/主机
    const service = 'cv';
    const region = 'cn-north-1';
    const host = 'visual.volcengineapi.com';

    // req_key：遵循文档默认 jimeng_t2i_v40，可由环境覆盖
    const reqKey = (process.env.VOLC_JIMENG_REQ_KEY || 'jimeng_t2i_v40').trim();

    // 通用日期与哈希计算器
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

    // 动态签名：根据不同 Action 生成 canonicalQuery 并签名
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
        Authorization: authorization,
      };
      const sessionToken = process.env.VOLC_SESSION_TOKEN || process.env.VOLC_SECURITY_TOKEN || process.env.X_SECURITY_TOKEN || '';
      if (sessionToken) headers['X-Security-Token'] = sessionToken;
      const endpoint = `https://${host}/?${canonicalQuery}`;
      return { endpoint, headers };
    };

    // 1) 提交任务
    const submitBody = JSON.stringify({ req_key: reqKey, prompt, width, height, return_url: true });
    const submit = signAndBuild('CVSync2AsyncSubmitTask', submitBody);
    let submitResp = await fetch(submit.endpoint, { method: 'POST', headers: submit.headers as any, body: submitBody });
    if (!submitResp.ok) {
      const text = await submitResp.text().catch(() => '');
      return NextResponse.json({ ok: false, error: 'upstream error (submit)', status: submitResp.status, detail: text.slice(0, 500) }, { status: 502 });
    }
    const submitJson: any = await submitResp.json().catch(() => ({}));
    const taskId = submitJson?.data?.task_id || submitJson?.Data?.TaskId || submitJson?.task_id;
    if (!taskId) {
      return NextResponse.json({ ok: false, error: 'no task_id from submit', detail: JSON.stringify(submitJson).slice(0, 500) }, { status: 502 });
    }

    // 2) 轮询查询
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let resultUrl: string | undefined;
    let lastDetail = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const reqJson = { return_url: true };
      const getBody = JSON.stringify({ req_key: reqKey, task_id: String(taskId), req_json: JSON.stringify(reqJson) });
      const getReq = signAndBuild('CVSync2AsyncGetResult', getBody);
      const res = await fetch(getReq.endpoint, { method: 'POST', headers: getReq.headers as any, body: getBody });
      if (!res.ok) {
        lastDetail = await res.text().catch(() => '');
        if (res.status === 429 || res.status >= 500) { await sleep(1200); continue; }
        return NextResponse.json({ ok: false, error: 'upstream error (get)', status: res.status, detail: lastDetail.slice(0, 500) }, { status: 502 });
      }
      const jr: any = await res.json().catch(() => ({}));
      const statusStrRaw: string = jr?.data?.status || jr?.Status || '';
      const statusStr = (statusStrRaw || '').toString().toLowerCase();

      // 尝试多种位置的 URL 字段
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

      if (candidates.length > 0) {
        resultUrl = candidates[0];
        break;
      }

      // base64 兜底
      const b64: string[] = (jr?.data?.binary_data_base64) || (jr?.BinaryDataBase64) || [];
      if (Array.isArray(b64) && b64.length > 0 && typeof b64[0] === 'string' && b64[0].length > 0) {
        resultUrl = `data:image/jpeg;base64,${b64[0]}`;
        break;
      }

      if (statusStr === 'done' || statusStr === 'success' || statusStr === 'succeeded' || statusStr === 'finished') {
        lastDetail = JSON.stringify(jr).slice(0, 800);
        break;
      }
      if (statusStr === 'not_found' || statusStr === 'expired') {
        lastDetail = JSON.stringify(jr).slice(0, 800);
        break;
      }
      await sleep(1200);
    }

    if (!resultUrl) {
      return NextResponse.json({ ok: false, error: 'no url returned', detail: lastDetail.slice(0, 800) }, { status: 502 });
    }

    return NextResponse.json({ ok: true, provider: 'jimeng', url: resultUrl });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'unknown error' }, { status: 500 });
  }
}