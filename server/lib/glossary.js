import { load, save } from './store.js';

/**
 * 术语/纠错记忆表。
 * 结构：{ [domain]: { terms: [{ canonical, aliases: string[], hits: number }], updatedAt } }
 * domain 例如 "global" / "bilibili:BV1xx" / "youtube:dQw4w9WgXcQ" / "channel:xxx"
 */

const FILE = 'glossary';

export async function getDomain(domain = 'global') {
  const db = await load(FILE, {});
  return db[domain] ?? { terms: [], updatedAt: Date.now() };
}

export async function allTerms(domain = 'global') {
  const db = await load(FILE, {});
  const global = db.global?.terms ?? [];
  const local = domain === 'global' ? [] : db[domain]?.terms ?? [];
  // 合并，本地优先
  const map = new Map();
  for (const t of [...global, ...local]) map.set(t.canonical, t);
  return [...map.values()];
}

/** 把 LLM 发现的术语合并进 domain */
export async function mergeTerms(domain, newTerms = []) {
  if (!newTerms.length) return;
  const db = await load(FILE, {});
  const entry = db[domain] ?? { terms: [], updatedAt: Date.now() };
  const byCanonical = new Map(entry.terms.map((t) => [t.canonical, t]));
  for (const t of newTerms) {
    if (!t || !t.canonical) continue;
    const canon = String(t.canonical).trim();
    if (!canon) continue;
    const aliases = new Set(
      (Array.isArray(t.aliases) ? t.aliases : [])
        .map((a) => String(a).trim())
        .filter((a) => a && a !== canon),
    );
    const prev = byCanonical.get(canon);
    if (prev) {
      for (const a of aliases) prev.aliases.push(a);
      prev.aliases = [...new Set(prev.aliases)];
      prev.hits = (prev.hits ?? 0) + 1;
    } else {
      byCanonical.set(canon, { canonical: canon, aliases: [...aliases], hits: 1 });
    }
  }
  entry.terms = [...byCanonical.values()].slice(0, 500);
  entry.updatedAt = Date.now();
  db[domain] = entry;
  await save(FILE, db);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 用已知术语做一次确定性的字符串替换（别名 -> 标准写法） */
export function applyTerms(text, terms) {
  if (!text || !terms?.length) return text;
  let out = text;
  for (const t of terms) {
    for (const alias of t.aliases ?? []) {
      if (!alias || alias === t.canonical) continue;
      const re = new RegExp(escapeRe(alias), 'gi');
      out = out.replace(re, t.canonical);
    }
  }
  return out;
}
