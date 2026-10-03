import { config } from '../config.js';

/**
 * 极简 OpenAI 兼容 Chat Completions 客户端（基于全局 fetch，Node18+）。
 * 适配 OpenAI / DeepSeek / Moonshot / 通义兼容模式 / Ollama / vLLM 等。
 */

function endpoint(path) {
  return `${config.llm.baseUrl}${path}`;
}

function headers() {
  if (!config.llm.apiKey) {
    throw new Error('未配置 LLM_API_KEY');
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${config.llm.apiKey}`,
  };
}

/**
 * @param {Array<{role:string, content:string}>} messages
 * @param {{model?:string, temperature?:number, json?:boolean, signal?:AbortSignal}} opts
 * @returns {Promise<string>} assistant 文本
 */
export async function chat(messages, opts = {}) {
  const {
    model = config.llm.model,
    temperature = config.llm.temperature,
    json = false,
    signal,
  } = opts;

  const body = {
    model,
    messages,
    temperature,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  let res;
  try {
    res = await fetch(endpoint('/chat/completions'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

/**
 * 流式版本，逐个 token 回调。onDelta(text) 可为 async。
 */
export async function chatStream(messages, onDelta, opts = {}) {
  const { model = config.llm.model, temperature = config.llm.temperature } = opts;
  const res = await fetch(endpoint('/chat/completions'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model, messages, temperature, stream: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${text.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          full += delta;
          await onDelta(delta);
        }
      } catch {
        /* 忽略不完整行 */
      }
    }
  }
  return full;
}

/** 从可能带 ```json 包裹的文本里提取 JSON */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
