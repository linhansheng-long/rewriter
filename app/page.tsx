"use client";
import { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import type { RunState, RunNode as PipeRunNode } from '@/lib/pipeline';
import type { AppConfig, ProviderConfig, StageKey, ModelProvider } from '@/lib/config';
import type React from 'react';
import type { UploadedFile } from '@/lib/types';
import ReactMarkdown from 'react-markdown';

const ReactFlow = dynamic(() => import('@xyflow/react').then(m=>m.ReactFlow), { ssr: false });
const Background = dynamic(() => import('@xyflow/react').then(m=>m.Background), { ssr: false });
const Controls = dynamic(() => import('@xyflow/react').then(m=>m.Controls), { ssr: false });

type FlowNode = RFNode<{ label: string }>;

type PromptKey = 'intent'|'outline-multi'|'outline-merge'|'write-sections'|'image-prompts'|'merge-assembly'|'expert-review'|'fact-check'|'final-merge';

const ALL_PROVIDERS: ModelProvider[] = ['kimi','qwen','glm','deepseek','openai','anthropic','gemini'];
const ALL_STAGES: StageKey[] = ['intent','outline-multi','outline-merge','write-sections','image-prompts','image-generation','merge-assembly','expert-review','fact-check','final-merge'];

export default function Home() {
  const [intent, setIntent] = useState({ topic: '示例主题', audience: '大众', style: '中性' });
  const [voicePref, setVoicePref] = useState<'male'|'female'>('female');
  const [rate, setRate] = useState<number>(1);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<RFEdge[]>([]);
  const [running, setRunning] = useState(false);
  const [finalMd, setFinalMd] = useState('');
  const [images, setImages] = useState<{sectionId:string,title:string,url:string,prompt:string}[]>([]);
  // settings state
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // prompts state
  const [prompts, setPromptsState] = useState<Record<PromptKey, string> | null>(null);
  const [activePrompt, setActivePrompt] = useState<PromptKey>('intent');
  const [promptText, setPromptText] = useState('');
  // ui tabs
  const [tab, setTab] = useState<'settings'|'prompts'>('settings');
  // tts
  const [speaking, setSpeaking] = useState(false);
  // files
  const [files, setFiles] = useState<UploadedFile[]>([]);
  // controller for cancel
  const [aborter, setAborter] = useState<AbortController | null>(null);
  // realtime logs
  const [logs, setLogs] = useState<string[]>([]);
  const loggedRef = useRef<Set<string>>(new Set());
  const logBoxRef = useRef<HTMLPreElement | null>(null);
  // 临时输入：图片供应商 AK/SK（不回显服务端返回，避免保存后清空的错觉）
  const [imgAkInputs, setImgAkInputs] = useState<Record<string, string>>({});
  const [imgSkInputs, setImgSkInputs] = useState<Record<string, string>>({});

  // load config & prompts on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        if (data.ok) setConfigState(data.config as AppConfig);
      } catch {}
      try {
        const res = await fetch('/api/prompts');
        const data = await res.json();
        if (data.ok) {
          setPromptsState(data.prompts as Record<PromptKey,string>);
          setPromptText((data.prompts as Record<PromptKey,string>)['intent']);
        }
      } catch {}
    })();
  }, []);

  useEffect(()=>{
    if (prompts) setPromptText(prompts[activePrompt]);
  }, [activePrompt, prompts]);

  useEffect(() => {
    // auto scroll log box
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  function stageLabel(t: PipeRunNode['type']) {
    switch (t) {
      case 'intent': return '意图评估';
      case 'outline-multi': return '多模型大纲';
      case 'outline-merge': return '合并大纲';
      case 'write-sections': return '分工写作';
      case 'image-prompts': return '图片提示词';
      case 'image-generation': return '图片生成';
      case 'merge-assembly': return '合并汇编';
      case 'expert-review': return '专家评审';
      case 'fact-check': return '事实核验';
      case 'final-merge': return '终稿合并';
      case 'git': return 'Git快照';
      case 'tts': return 'TTS标记';
      default: return t;
    }
  }
  function appendLog(line: string) {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${ts}] ${line}`]);
  }

  function applyRunState(run: RunState) {
    const flowNodes: FlowNode[] = run.nodes.map((n: PipeRunNode, idx: number) => ({
      id: n.id,
      data: { label: `${idx + 1}. ${n.type}` },
      position: { x: 100 + idx * 160, y: 100 },
      className: n.status === 'done' ? 'bg-green-200' : n.status === 'error' ? 'bg-red-200' : 'bg-yellow-200',
    }));
    const flowEdges: RFEdge[] = run.nodes.slice(1).map((n: PipeRunNode, idx: number) => ({ id: `e${idx}`, source: run.nodes[idx].id, target: n.id }));
    setNodes(flowNodes);
    setEdges(flowEdges);
    if (run.final?.markdown) setFinalMd(run.final.markdown);

    // append new logs for newly finished nodes
    run.nodes.forEach((n) => {
      if (n.status === 'done' && !loggedRef.current.has(n.id)) {
        loggedRef.current.add(n.id);
        appendLog(`完成阶段：${stageLabel(n.type)}`);
        try {
          if (n.type === 'outline-multi' && (n.data as any)?.outlines) {
            const titles = ((n.data as any).outlines as any[]).map((o) => o.title).filter(Boolean).join(' | ');
            if (titles) appendLog(`多纲要标题：${titles}`);
          }
          if (n.type === 'outline-merge' && (n.data as any)?.outline) {
            const sec = ((n.data as any).outline.sections || []).map((s: any) => s.title).slice(0, 8).join(' / ');
            appendLog(`合并大纲章节：${sec}`);
          }
          if (n.type === 'write-sections' && (n.data as any)?.drafts) {
            const count = ((n.data as any).drafts as any[]).length;
            appendLog(`已生成章节数：${count}`);
          }
          if (n.type === 'image-prompts' && (n.data as any)?.imagePrompts) {
            const arr = (((n.data as any).imagePrompts || {}).images || []) as any[];
            const top = arr.slice(0,3).map(v=>v.title).filter(Boolean).join(' | ');
            if (top) appendLog(`图片提示词TOP3：${top}`);
          }
          if (n.type === 'image-generation' && (n.data as any)?.images) {
            const imgs = ((n.data as any).images || []) as any[];
            setImages(imgs);
            const top = imgs.slice(0,3).map(v=>v.title).filter(Boolean).join(' | ');
            if (top) appendLog(`已生成图片TOP3：${top}`);
          }
          if (n.type === 'merge-assembly' && (n.data as any)?.doc) {
            const excerpt = String((n.data as any).doc.markdown || '').slice(0, 120).replace(/\n/g, ' ');
            appendLog(`合并预览：${excerpt}${excerpt.length>=120?'...':''}`);
          }
          if (n.type === 'expert-review' && (n.data as any)?.review) {
            const issues = ((n.data as any).review.issues || []).length;
            appendLog(`评审问题数：${issues}`);
          }
          if (n.type === 'fact-check') {
            appendLog(`事实核验完成`);
          }
          if (n.type === 'final-merge' && (n.data as any)?.final) {
            const len = String((n.data as any).final.markdown || '').length;
            appendLog(`终稿就绪，长度：${len}`);
          }
        } catch {}
      }
    });
  }

  async function run() {
    if (running) return;
    setRunning(true);
    setFinalMd('');
    setNodes([]); setEdges([]);
    setLogs([]);
    loggedRef.current = new Set();
    const controller = new AbortController();
    setAborter(controller);
    try {
      const res = await fetch('/api/run/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent, files }), signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`请求失败：${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            try {
              const evt = JSON.parse(line) as { type: 'update'|'done'|'error'; run?: RunState; message?: string };
              if ((evt.type === 'update' || evt.type === 'done') && evt.run) {
                applyRunState(evt.run);
              } else if (evt.type === 'error') {
                throw new Error(evt.message || '运行出错');
              }
            } catch {}
          }
          idx = buffer.indexOf('\n');
        }
      }
      appendLog('流水线已结束');
    } catch (e: unknown) {
      const aborted = (e as any)?.name === 'AbortError' || (e as Error)?.message?.includes('aborted');
      if (!aborted) {
        const message = e instanceof Error ? e.message : String(e);
        appendLog(`错误：${message}`);
        alert(message);
      } else {
        appendLog('已取消运行');
      }
    } finally {
      setRunning(false);
      setAborter(null);
    }
  }

  function stopRun() {
    if (aborter) aborter.abort();
  }

  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    const form = new FormData();
    Array.from(list).forEach(file => form.append('files', file, file.name));
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'upload failed');
      setFiles(data.files as UploadedFile[]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`上传失败：${msg}`);
    } finally {
      // reset value to allow re-select same file
      e.currentTarget.value = '';
    }
  }

  function toggleProvider(name: ModelProvider) {
    if (!config) return;
    const prev = config.providers[name];
    const next: ProviderConfig = { ...prev, enabled: !prev.enabled } as ProviderConfig;
    setConfigState({ ...config, providers: { ...config.providers, [name]: next } });
  }

  function updateProviderModel(name: ModelProvider, model: string) {
    if (!config) return;
    const next: ProviderConfig = { ...config.providers[name], model } as ProviderConfig;
    setConfigState({ ...config, providers: { ...config.providers, [name]: next } });
  }

  function updateProviderKey(name: ModelProvider, apiKey: string) {
    if (!config) return;
    const next: ProviderConfig = { ...config.providers[name], apiKey } as ProviderConfig;
    setConfigState({ ...config, providers: { ...config.providers, [name]: next } });
  }

  function toggleStageProvider(stage: StageKey, provider: ModelProvider) {
    if (!config) return;
    const curr = config.stageProviders[stage] || [] as ModelProvider[];
    const has = curr.includes(provider);
    const next = has ? curr.filter(p=>p!==provider) : [...curr, provider];
    setConfigState({ ...config, stageProviders: { ...config.stageProviders, [stage]: next } });
  }

  function toggleImageStageProvider(provider: string) {
    if (!config) return;
    const curr = ((config as any).imageStageProviders?.['image-generation'] || []) as string[];
    const has = curr.includes(provider);
    const next = has ? curr.filter(p=>p!==provider) : [...curr, provider];
    setConfigState({ ...(config as any), imageStageProviders: { ...((config as any).imageStageProviders||{}), 'image-generation': next } });
  }

  async function saveConfig() {
    if (!config) return;
    setSaving(true); setSaveMsg(null);
    try {
      // 仅当本次填写了 AK/SK 时才发送，避免被后端脱敏回写覆盖后造成“清空”的错觉
      const imageProvidersToSend: Record<string, any> = {};
      (['keling','paiwo','jimeng','nanobanana'] as string[]).forEach((p) => {
        const prev: any = (config as any).imageProviders?.[p] || {};
        const out: any = {
          enabled: !!prev.enabled,
          model: prev.model,
          apiKey: prev.apiKey,
        };
        const ak = (imgAkInputs[p] || '').trim();
        const sk = (imgSkInputs[p] || '').trim();
        if (ak) out.ak = ak; // 非空才发送
        if (sk) out.sk = sk; // 非空才发送
        imageProvidersToSend[p] = out;
      });

      const body = {
        providers: config.providers,
        imageProviders: imageProvidersToSend,
        concurrency: config.concurrency,
        budgetUSD: config.budgetUSD,
        ttsProvider: config.ttsProvider,
        stageProviders: config.stageProviders,
        imageStageProviders: (config as any).imageStageProviders,
      };
      const res = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'save failed');
      setConfigState(data.config as AppConfig);
      setSaveMsg('已保存');
      setTimeout(()=>setSaveMsg(null), 1500);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveMsg(`保存失败：${message}`);
    } finally {
      setSaving(false);
    }
  }

  async function savePrompt() {
    if (!prompts) return;
    const next = { ...prompts, [activePrompt]: promptText };
    try {
      const res = await fetch('/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompts: { [activePrompt]: promptText } }) });
      const data = await res.json();
      if (data.ok) setPromptsState(next);
    } catch {}
  }

  async function resetPromptsAll() {
    try {
      const res = await fetch('/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) });
      const data = await res.json();
      if (data.ok) {
        setPromptsState(data.prompts as Record<PromptKey,string>);
        setActivePrompt('intent');
        setPromptText((data.prompts as Record<PromptKey,string>)['intent']);
      }
    } catch {}
  }

  function speak() {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) return;
    if (speaking) { synth.cancel(); setSpeaking(false); return; }
    const utter = new SpeechSynthesisUtterance(finalMd);
    // voice preference
    const voices = synth.getVoices();
    const preferred = voices.find(v => (voicePref==='female'? /female|woman|girl|zira/i : /male|man|boy|david|mark/i).test(v.name)) || voices[0];
    if (preferred) utter.voice = preferred;
    // rate control
    utter.rate = Math.min(2, Math.max(0.5, rate));
    utter.onend = ()=> setSpeaking(false);
    synth.speak(utter);
    setSpeaking(true);
  }

  const mdComponents = {
    a: (props: any) => {
      const href = props.href || '';
      return <a {...props} href={href || undefined} target="_blank" rel="noreferrer noopener" />;
    },
    img: (props: any) => {
      const src = (props.src || '').trim();
      if (!src) return null;
      // eslint-disable-next-line @next/next/no-img-element
      return <img {...props} src={src} alt={props.alt||''} />;
    }
  } as any;

  return (
    <div className="flex h-screen">
      {/* 左侧：输入与运行 */}
      <div className="w-1/4 border-r p-3 space-y-3">
        <h2 className="font-bold">输入</h2>
        <label className="block text-sm">主题</label>
        <input className="w-full border p-2" value={intent.topic||''} onChange={e=>setIntent({...intent, topic: e.target.value})} />
        <label className="block text-sm">受众</label>
        <input className="w-full border p-2" value={intent.audience||''} onChange={e=>setIntent({...intent, audience: e.target.value})} />
        <label className="block text-sm">风格</label>
        <input className="w-full border p-2" value={intent.style||''} onChange={e=>setIntent({...intent, style: e.target.value})} />
        <label className="block text-sm">附件</label>
        <input className="w-full border p-1" type="file" multiple onChange={onPickFiles} />
        {files.length>0 && (
          <ul className="text-xs text-gray-600 list-disc pl-4 mt-1">
            {files.map(f=> <li key={f.filename}>{f.filename} {(f.size||0) > 0 ? `(${f.size} bytes)` : ''}</li>)}
          </ul>
        )}
        <div className="flex space-x-2">
          <button className="flex-1 bg-blue-600 text-white py-2" onClick={run} disabled={running}>{running?'运行中...':'运行流水线'}</button>
          <button className="w-28 bg-red-600 text-white py-2" onClick={stopRun} disabled={!running}>停止</button>
        </div>
        <div className="space-y-2">
          <div className="flex items-center space-x-2 text-sm">
            <label>声音:</label>
            <select className="border p-1" value={voicePref} onChange={e=>setVoicePref(e.target.value as 'male'|'female')}>
              <option value="female">女声</option>
              <option value="male">男声</option>
            </select>
            <label>语速:</label>
            <input type="range" min={0.5} max={2} step={0.1} value={rate} onChange={e=>setRate(Number(e.target.value))} />
            <span className="w-10 text-right">{rate.toFixed(1)}x</span>
          </div>
          <button className="w-full bg-emerald-600 text-white py-2" onClick={speak} disabled={!finalMd}>{speaking?'停止朗读':'朗读终稿'}</button>
        </div>
      </div>

      {/* 中间：流程画布与输出 */}
      <div className="w-2/4 border-r p-3">
        <div className="h-1/2 border mb-3 relative">
          <ReactFlow nodes={nodes} edges={edges} fitView>
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <div className="space-y-3">
          <div>
            <h2 className="font-bold mb-2">实时输出</h2>
            <pre ref={logBoxRef} className="whitespace-pre-wrap text-xs p-2 bg-black text-green-200 border h-40 overflow-auto">{logs.join('\n')}</pre>
          </div>
          <div>
            <h2 className="font-bold mb-2">终稿预览</h2>
            {images.length>0 && (
              <div className="w-full overflow-x-auto whitespace-nowrap mb-2 border rounded p-2 bg-white">
                {images.map((img,idx)=> (
                  <div key={idx} className="inline-block mr-2 align-top">
                    <div className="w-48 h-32 bg-gray-100 border rounded overflow-hidden flex items-center justify-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt={img.title} className="object-cover w-full h-full" />
                    </div>
                    <div className="text-xs mt-1 w-48 truncate" title={img.title}>{img.title}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="prose prose-sm max-w-none bg-white border p-3 rounded shadow-inner">
  {finalMd ? <ReactMarkdown components={mdComponents}>{finalMd}</ReactMarkdown> : <div className="text-gray-500 text-sm">终稿将显示在这里</div>}
</div>
          </div>
        </div>
      </div>

      {/* 右侧：设置与提示词 */}
      <div className="w-1/4 p-3 space-y-3">
        <div className="flex space-x-2">
          <button className={`px-3 py-1 border ${tab==='settings'?'bg-gray-200':''}`} onClick={()=>setTab('settings')}>设置</button>
          <button className={`px-3 py-1 border ${tab==='prompts'?'bg-gray-200':''}`} onClick={()=>setTab('prompts')}>提示词</button>
        </div>

        {tab==='settings' && config && (
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold">并发 / 预算 / TTS</h3>
              <div className="flex items-center space-x-2 mt-1">
                <label>并发:</label>
                <input type="number" className="border p-1 w-20" value={config.concurrency} onChange={e=>setConfigState({...config, concurrency: Number(e.target.value)})} />
                <label>预算($):</label>
                <input type="number" className="border p-1 w-24" value={config.budgetUSD||0} onChange={e=>setConfigState({...config, budgetUSD: Number(e.target.value)})} />
                <label>TTS:</label>
                <select className="border p-1" value={config.ttsProvider||'web'} onChange={e=>setConfigState({...config, ttsProvider: e.target.value as 'web'|'azure'|'elevenlabs'|'xunfei'})}>
                  <option value="web">Web</option>
                  <option value="azure">Azure</option>
                  <option value="elevenlabs">ElevenLabs</option>
                  <option value="xunfei">讯飞</option>
                </select>
              </div>
            </div>

            <div>
              <h3 className="font-semibold">模型供应商</h3>
              <div className="space-y-2">
                {ALL_PROVIDERS.map((p: ModelProvider) => (
                  <div key={p} className="flex items-center space-x-2">
                    <input type="checkbox" checked={!!config.providers[p]?.enabled} onChange={()=>toggleProvider(p)} />
                    <span className="w-24 capitalize">{p}</span>
                    <input className="flex-1 border p-1" placeholder="model" value={config.providers[p]?.model||''} onChange={e=>updateProviderModel(p, e.target.value)} />
                    <input className="flex-1 border p-1" placeholder="api key" value={config.providers[p]?.apiKey||''} onChange={e=>updateProviderKey(p, e.target.value)} />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="font-semibold">图片供应商</h3>
              <div className="space-y-2">
                {(['keling','paiwo','jimeng','nanobanana'] as any[]).map((p) => (
                  <div key={p} className="flex items-center space-x-2">
                    <input type="checkbox" checked={!!(config as any).imageProviders?.[p]?.enabled} onChange={()=>{
                      const prev = (config as any).imageProviders?.[p]||{ enabled:false };
                      setConfigState({ ...(config as any), imageProviders: { ...(config as any).imageProviders, [p]: { ...prev, enabled: !prev.enabled } } });
                    }} />
                    <span className="w-28 capitalize">{p}</span>
                    <input className="flex-1 border p-1" placeholder="model" value={(config as any).imageProviders?.[p]?.model||''} onChange={e=>{
                      const prev = (config as any).imageProviders?.[p]||{ enabled:false };
                      setConfigState({ ...(config as any), imageProviders: { ...(config as any).imageProviders, [p]: { ...prev, model: e.target.value } } });
                    }} />
                    <input className="flex-1 border p-1" placeholder="api key" value={(config as any).imageProviders?.[p]?.apiKey||''} onChange={e=>{
                      const prev = (config as any).imageProviders?.[p]||{ enabled:false };
                      setConfigState({ ...(config as any), imageProviders: { ...(config as any).imageProviders, [p]: { ...prev, apiKey: e.target.value } } });
                    }} />
                    {/* AK/SK for providers like jimeng: 使用临时输入状态，避免后端脱敏回写后清空显示 */}
                    <input className="flex-1 border p-1" placeholder="AK (jimeng)" value={imgAkInputs[p] || ''} onChange={e=>{
                      const v = e.target.value;
                      setImgAkInputs(prev => ({ ...prev, [p]: v }));
                    }} />
                    <input className="flex-1 border p-1" placeholder="SK (jimeng)" value={imgSkInputs[p] || ''} onChange={e=>{
                      const v = e.target.value;
                      setImgSkInputs(prev => ({ ...prev, [p]: v }));
                    }} />
                    <span className="text-xs text-gray-500 w-24">
                      {((config as any).imageProviders?.[p]?.hasAk ? 'AK✓' : 'AK?')} / {((config as any).imageProviders?.[p]?.hasSk ? 'SK✓' : 'SK?')}
                    </span>
                    {p==='jimeng' && (
                      <button
                        className="text-xs border px-2 py-1"
                        onClick={async()=>{
                          try{
                            const prompt = '测试图片生成：一张简洁的插画，主题为“产品宣传”，光线自然，高清';
                            const res = await fetch('/api/image/jimeng', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt, width: 1024, height: 1024 }) });
                            const data = await res.json();
                            if(!res.ok || !data.ok){
                              alert(`生成失败：${data?.error||res.status}`);
                            }else{
                              window.open(data.url, '_blank');
                            }
                          }catch(e:any){
                            alert(`生成异常：${e?.message||e}`);
                          }
                        }}
                      >测试生成</button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="font-semibold">阶段模型选择</h3>
              <div className="space-y-2">
                {ALL_STAGES.map(stage => (
                  <div key={stage} className="border p-2">
                     <div className="text-sm font-medium mb-1">{stage}</div>
                     {stage !== 'image-generation' && (
                       <div className="flex flex-wrap gap-3">
                          {ALL_PROVIDERS.map((p: ModelProvider) => (
                             <label key={p} className="flex items-center space-x-2">
                               <input type="checkbox" checked={config.stageProviders[stage]?.includes(p) || false} onChange={()=>toggleStageProvider(stage, p)} />
                               <span className="capitalize">{p}</span>
                             </label>
                           ))}
                       </div>
                     )}
                     {stage === 'image-generation' && (
                       <div className="flex flex-wrap gap-3">
                         {(['keling','paiwo','jimeng','nanobanana'] as string[]).map(p => (
                           <label key={p} className="flex items-center space-x-2">
                             <input type="checkbox" checked={(((config as any).imageStageProviders?.['image-generation']||[]) as string[]).includes(p)} onChange={()=>toggleImageStageProvider(p)} />
                             <span className="capitalize">{p}</span>
                           </label>
                         ))}
                       </div>
                     )}
                  </div>
                ))}
              </div>
            </div>

            <button className="w-full bg-blue-600 text-white py-2" onClick={saveConfig} disabled={saving}>{saving?'保存中...':'保存设置'}</button>
            {saveMsg && <div className="text-sm text-gray-600">{saveMsg}</div>}
            {config && (
              <div className="text-xs text-gray-500">保存后密钥不会在页面回显，仅显示是否已配置（AK/SK ✓/?）</div>
            )}
          </div>
        )}

        {tab==='prompts' && (
          <div className="space-y-2">
            <div className="flex space-x-2 flex-wrap">
              {(['intent','outline-multi','outline-merge','write-sections','image-prompts','merge-assembly','expert-review','fact-check','final-merge'] as PromptKey[]).map(k => (
                <button key={k} className={`px-2 py-1 border text-xs ${activePrompt===k?'bg-gray-200':''}`} onClick={()=>setActivePrompt(k)}>{k}</button>
              ))}
            </div>
            <textarea className="w-full h-48 border p-2 text-xs" value={promptText} onChange={e=>setPromptText(e.target.value)} />
            <div className="flex space-x-2">
              <button className="flex-1 bg-blue-600 text-white py-1" onClick={savePrompt}>保存当前提示词</button>
              <button className="flex-1 bg-gray-600 text-white py-1" onClick={resetPromptsAll}>重置全部</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
