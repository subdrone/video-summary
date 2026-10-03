import { chat, extractJson } from './llm.js';
import { config, assertLlmConfigured } from '../config.js';
import { allTerms, applyTerms, mergeTerms } from './glossary.js';

const SYSTEM = `你是一个字幕校对引擎。用户会给你带编号的字幕行，可能来自语音识别(ASR)或平台的 AI 自动字幕，存在同音字错误、专有名词错误、英文术语拼写错误、缺少标点等问题。

你的任务：
1. 只纠正明显的识别错误、错别字、专有名词/术语、断句和标点。保持原意与口语风格，不要翻译，不要总结，不要增删内容。
2. 每行必须保持对应的编号 i，且不能合并或拆分行。
3. 同时对整段做上下文纠错（结合前后文判断同音字）。
4. 抽取你修正过的专有名词/术语，给出标准写法 canonical 与可能被误识别的别名 aliases。

只输出 JSON，格式：
{"lines":[{"i":0,"text":"纠正后的文本"}],"terms":[{"canonical":"OpenAI","aliases":["open ai","欧朋ai"]}]}
若某行无需修改也要原样返回。`;

function batchSegments(segments, maxChars = 2500) {
  const batches = [];
  let cur = [];
  let len = 0;
  for (const seg of segments) {
    const t = seg.text ?? '';
    if (cur.length && len + t.length > maxChars) {
      batches.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(seg);
    len += t.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function correctBatch(batch, { lang, terms, domain }) {
  const numbered = batch.map((seg, i) => `${i}: ${seg.text}`).join('\n');
  const glossaryHint = terms.length
    ? `已知术语（请优先采用这些标准写法）：\n${terms
        .slice(0, 80)
        .map((t) => `- ${t.canonical}${t.aliases?.length ? `（误识别可能是：${t.aliases.join('、')}）` : ''}`)
        .join('\n')}`
    : '（暂无已知术语）';

  const user = `语言：${lang === 'auto' ? '自动判断' : lang}\n${glossaryHint}\n\n待校对字幕：\n${numbered}`;

  const raw = await chat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    { model: config.llm.correctModel, json: true, temperature: 0 },
  );

  const parsed = extractJson(raw);
  const map = new Map();
  for (const line of parsed?.lines ?? []) {
    if (typeof line?.i === 'number') map.set(line.i, String(line.text ?? ''));
  }
  const out = batch.map((seg, i) => ({
    ...seg,
    text: map.has(i) ? map.get(i) : seg.text,
    corrected: map.has(i) && map.get(i) !== seg.text,
  }));
  return { segments: out, terms: parsed?.terms ?? [] };
}

/**
 * 对字幕做纠错。
 * @param {Array<{start:number,end:number,text:string,source?:string}>} segments
 * @param {{lang?:string, domain?:string, force?:boolean}} opts
 */
export async function correctSegments(segments, opts = {}) {
  const { lang = config.summary.language, domain = 'global', force = false } = opts;

  const needLlm = segments.some(
    (s) => force || s.source === 'asr' || s.source === 'auto-cc' || s.source === 'auto',
  );

  const terms = await allTerms(domain);

  // 1) 确定性术语替换（零成本）
  let work = segments.map((s) => ({ ...s, text: applyTerms(s.text, terms) }));

  if (!needLlm) {
    return { segments: work, corrected: false, terms: [] };
  }

  assertLlmConfigured();

  // 2) LLM 上下文纠错（分批）
  const batches = batchSegments(work);
  const collectedTerms = [];
  const result = [];
  for (const batch of batches) {
    try {
      const { segments: fixed, terms: newTerms } = await correctBatch(batch, {
        lang,
        terms,
        domain,
      });
      result.push(...fixed);
      collectedTerms.push(...newTerms);
    } catch (err) {
      console.error('[correct] 批次失败，保留原文:', err.message);
      result.push(...batch);
    }
  }

  if (collectedTerms.length) {
    await mergeTerms(domain, collectedTerms);
    // 用新术语再来一次确定性替换，巩固
    const fresh = await allTerms(domain);
    for (const s of result) s.text = applyTerms(s.text, fresh);
  }

  return {
    segments: result,
    corrected: result.some((s) => s.corrected),
    terms: collectedTerms,
  };
}
