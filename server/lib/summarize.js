import { chat, extractJson } from './llm.js';
import { config, assertLlmConfigured } from '../config.js';

/** @typedef {{start:number,end:number,text:string,source?:string}} Segment */

const CHUNK_SYSTEM = `你是视频内容分析助手。根据给定的字幕片段（带时间戳）生成结构化摘要。
要求：忠实于原文，不编造；忽略无意义的语气词/水词；保留关键数字、人名、术语、结论。
只输出 JSON：
{"emoji":"最能代表本片段的1个emoji","title":"该片段的一句话小标题(<=18字)","bullets":["要点1","要点2"],"terms":["出现的专有名词/术语"]}
bullets 2-4 条，每条一句话。`;

const GLOBAL_SYSTEM = `你是视频总览助手。根据"已有总览"和"新增片段摘要"，滚动更新整段视频的总览。
要求：随着新内容不断修正和补充；合并重复；突出主线逻辑与结论；不编造。
只输出 JSON：
{"overview":"2-4句话的整体概述","keyPoints":["全局关键点"],"moments":[{"time":"MM:SS","emoji":"🎯","title":"这一关键节点的标题(<=14字)"}],"openQuestions":["视频中提出但未解答/值得追问的问题"],"terms":["重要术语"]}
keyPoints 最多 8 条，按重要性排序；moments 挑选 3-8 个最值得跳转的关键节点，time 用分:秒（从已有片段的时间范围推断）。`;

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function chunkText(segments) {
  return segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
}

async function makeChunkSummary(segments, lang) {
  const raw = await chat(
    [
      { role: 'system', content: CHUNK_SYSTEM },
      {
        role: 'user',
        content: `语言：${lang === 'auto' ? '自动' : lang}\n时间范围：${fmtTime(
          segments[0]?.start,
        )} - ${fmtTime(segments.at(-1)?.end)}\n\n字幕：\n${chunkText(segments)}`,
      },
    ],
    { json: true, temperature: 0.2 },
  );
  const parsed = extractJson(raw) ?? {};
  return {
    start: segments[0]?.start ?? 0,
    end: segments.at(-1)?.end ?? 0,
    emoji: typeof parsed.emoji === 'string' ? parsed.emoji.slice(0, 4) : '•',
    title: parsed.title || '片段',
    bullets: Array.isArray(parsed.bullets) ? parsed.bullets : [],
    terms: Array.isArray(parsed.terms) ? parsed.terms : [],
  };
}

async function makeGlobalSummary(prev, chunks, lang) {
  const history = prev
    ? `已有总览：\n${JSON.stringify(prev)}\n`
    : '暂无已有总览。\n';
  const fresh = chunks
    .map((c) => `- [${fmtTime(c.start)}-${fmtTime(c.end)}] ${c.title}：${c.bullets.join('；')}`)
    .join('\n');
  const raw = await chat(
    [
      { role: 'system', content: GLOBAL_SYSTEM },
      { role: 'user', content: `语言：${lang === 'auto' ? '自动' : lang}\n${history}\n新增片段摘要：\n${fresh}` },
    ],
    { json: true, temperature: 0.2 },
  );
  const parsed = extractJson(raw) ?? {};
  const moments = Array.isArray(parsed.moments)
    ? parsed.moments
        .map((m) => ({
          time: String(m?.time ?? '').trim(),
          emoji: typeof m?.emoji === 'string' ? m.emoji.slice(0, 4) : '•',
          title: String(m?.title ?? '').trim(),
        }))
        .filter((m) => m.time && m.title)
        .slice(0, 10)
    : prev?.moments ?? [];
  return {
    overview: parsed.overview || prev?.overview || '',
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : prev?.keyPoints ?? [],
    moments,
    openQuestions: Array.isArray(parsed.openQuestions)
      ? parsed.openQuestions
      : prev?.openQuestions ?? [],
    terms: Array.isArray(parsed.terms) ? parsed.terms : prev?.terms ?? [],
    updatedAt: Date.now(),
  };
}

/** 把 "MM:SS" / "HH:MM:SS" 解析成秒 */
export function parseMomentsTime(t) {
  const parts = String(t).split(':').map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

export class SummarySession {
  constructor({ id, domain = 'global', lang = 'auto', title = '' }) {
    this.id = id;
    this.domain = domain;
    this.lang = lang;
    this.title = title;
    this.segments = [];
    this.pendingText = '';
    this.pendingStart = null;
    this.pendingEnd = null;
    this.chunks = [];
    this.global = null;
    this.createdAt = Date.now();
    this._busy = false;
  }

  push(segments) {
    for (const seg of segments) {
      this.segments.push(seg);
      if (this.pendingStart == null) this.pendingStart = seg.start;
      this.pendingEnd = seg.end;
      this.pendingText += seg.text;
    }
  }

  get pendingChars() {
    return this.pendingText.length;
  }
}

const sessions = new Map();

export function createSession(opts) {
  const session = new SummarySession(opts);
  sessions.set(session.id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id);
}

export function deleteSession(id) {
  sessions.delete(id);
}

/**
 * 摄入新字幕段：必要时生成片段摘要、更新全局摘要。
 * @returns {Promise<{chunks:any[], global:any|null}>}
 */
export async function ingest(session, segments, { force = false, final = false } = {}) {
  assertLlmConfigured();
  session.push(segments);

  const newChunks = [];
  if (session.pendingChars >= config.summary.chunkChars || (force && session.pendingText)) {
    // 用一个游标避免重复摘要同一段
    const from = session._summarizedUntil ?? 0;
    const toSummarize = session.segments.filter((s) => s.start >= from);
    if (toSummarize.length) {
      const chunk = await makeChunkSummary(toSummarize, session.lang);
      session.chunks.push(chunk);
      newChunks.push(chunk);
      session._summarizedUntil = (toSummarize.at(-1)?.end ?? from) + 0.001;
      session.pendingText = '';
      session.pendingStart = null;
      session.pendingEnd = null;
    }
  }

  let global = null;
  const dueForMerge = session.chunks.length % config.summary.mergeEvery === 0;
  if (session.chunks.length && (dueForMerge || final)) {
    global = await makeGlobalSummary(session.global, newChunks, session.lang);
    session.global = global;
  }

  return { chunks: newChunks, global };
}
