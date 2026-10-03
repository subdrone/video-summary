import process from 'node:process';

const env = (key, fallback) => (process.env[key] ?? fallback);

const num = (key, fallback) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
};

/**
 * 所有配置都可以用环境变量覆盖，见 README。
 * LLM 走 OpenAI 兼容协议，所以 OpenAI / DeepSeek / 通义 / 本地 Ollama / vLLM 都能用。
 */
export const config = {
  port: num('PORT', 8787),
  host: env('HOST', '0.0.0.0'),

  llm: {
    baseUrl: env('LLM_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: env('LLM_API_KEY', ''),
    model: env('LLM_MODEL', 'gpt-4o-mini'),
    // 纠错可以用更小/更便宜的模型
    correctModel: env('LLM_CORRECT_MODEL', env('LLM_MODEL', 'gpt-4o-mini')),
    temperature: num('LLM_TEMPERATURE', 0.2),
    timeoutMs: num('LLM_TIMEOUT_MS', 120000),
  },

  asr: {
    // openai | local | mock
    provider: env('ASR_PROVIDER', 'mock'),
    apiKey: env('ASR_API_KEY', env('LLM_API_KEY', '')),
    baseUrl: env('ASR_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env('ASR_MODEL', 'whisper-1'),
    // local 模式：调用本机 faster-whisper / whisper.cpp。{file} {lang} 会被替换
    localCmd: env('ASR_LOCAL_CMD', ''),
    localModel: env('ASR_LOCAL_MODEL', 'base'),
    language: env('ASR_LANGUAGE', 'auto'),
  },

  summary: {
    // 一次送给 LLM 的最大字符数（分块）
    chunkChars: num('SUMMARY_CHUNK_CHARS', 1800),
    // 全局摘要重写间隔（每收到 N 个块重算一次全局）
    mergeEvery: num('SUMMARY_MERGE_EVERY', 3),
    language: env('SUMMARY_LANGUAGE', 'auto'),
  },

  // 术语表/纠错记忆持久化位置
  dataDir: env('DATA_DIR', new URL('../data/', import.meta.url).pathname),
};

export function assertLlmConfigured() {
  if (!config.llm.apiKey) {
    throw new Error(
      '未配置 LLM_API_KEY。请在环境变量中设置（支持任何 OpenAI 兼容服务）。',
    );
  }
}
