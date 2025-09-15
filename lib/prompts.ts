export type PromptKey = 'intent'|'outline-multi'|'outline-merge'|'write-sections'|'merge-assembly'|'expert-review'|'fact-check'|'final-merge'|'image-prompts';

export type Prompts = Record<PromptKey, string>;

export const PROMPT_KEYS: readonly PromptKey[] = [
  'intent',
  'outline-multi',
  'outline-merge',
  'write-sections',
  'merge-assembly',
  'expert-review',
  'fact-check',
  'final-merge',
  'image-prompts',
] as const;

const defaultPrompts: Prompts = {
  'intent': `你是写作意图评估助手。请依据以下信息提炼结构化意图（JSON）：\n- 主题: {topic}\n- 受众: {audience}\n- 风格: {style}\n- 目标: {goals}\n- 约束: {constraints}\n- 参考: {references}\n要求：输出字段 intent: { topic, audience, style, goals[], constraints[], references[] }。`,
  'outline-multi': `你是写作大纲专家。请针对“{topic}”生成结构化大纲，考虑受众“{audience}”、风格“{style}”。输出JSON：{ title, sections: [{ id, title, bullets[], requiresEvidence? }] }。`,
  'outline-merge': `你是大纲合并器。输入多份大纲，去重合并，保持层次清晰与覆盖全面，输出JSON同前，最多 8 个章节。`,
  'write-sections': `你是章节写手。针对给定大纲章节，生成对应 Markdown 内容（中文），保持一致风格“{style}”，引用必要事实并标注占位引用。`,
  'merge-assembly': `你是编排与风格统一助手。将多个章节合并为完整 Markdown，统一术语、衔接段落，自动生成合理标题与目录（可选）。`,
  'expert-review': `你是领域专家评审，多轮提出问题与修改建议（JSON：issues[{locationId,severity,suggestion,rationale}]}），聚焦准确性、逻辑性、结构。`,
  'fact-check': `你是联网事实核验助手。针对关键陈述，使用检索进行逐条验证，返回证据（JSON：sources[{url,snippet,confidence}]}）。`,
  'final-merge': `目标：输出一篇结构严谨、可直接发布的中文 Markdown 终稿。\n必须遵循：\n1) 结构：\n   - 一级标题为成稿主标题（# 标题）\n   - 自动生成目录（使用 [TOC] 或显式“## 目录”+锚点列表）\n   - 正文使用分节编号（例如 “## 1. 概述”、“## 2. …”），小节用 “###”\n   - 结语（## 结语 或 ## 总结）\n   - 参考资料（## 参考资料，可保留占位）\n2) 表达：\n   - 禁止出现“要点A(续)”等含糊或重复标题；标题应具体、可读、不可重复\n   - 段落完整、逻辑顺畅，避免占位语句\n3) 图片占位：若提供了 imagePrompts/imageAssets，请在文内合适位置以 Markdown 图片语法或提示词小节进行引用。\n输入：{ doc, review, intent, imagePrompts?, imageAssets? }\n输出：仅返回 Markdown 文本。`,
  'image-prompts': `你是图像提示词设计师。针对给定大纲章节，为每个章节生成 1 条中文图像提示词。要求：\n- 精准描述主体、场景、风格（如插画/写实/赛博/水墨）、光线与构图\n- 不含文字水印、不过度暴力或敏感内容\n- 句式简洁可被图像模型直接使用\n输出 JSON：{ images: [{ sectionId, title, prompt }] }。`,
};

let _store: Prompts = { ...defaultPrompts };

export function getPrompts(): Prompts { return _store; }
export function getPrompt(key: PromptKey): string { return _store[key]; }
export function setPrompts(next: Partial<Prompts>) { _store = { ..._store, ...next }; }
export function resetPrompts() { _store = { ...defaultPrompts }; }
export { defaultPrompts };