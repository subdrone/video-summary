import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { pcm16ToWav } from '../lib/wav.js';

const execFileAsync = promisify(execFile);

/** @typedef {{ text: string, lang?: string, segments?: any[] }} AsrResult */

/**
 * 转写一段音频（输入为 16k 单声道 PCM16 Buffer）。
 * provider: openai | local | mock
 */
export async function transcribePcm(pcm, { lang = config.asr.language, prompt = '' } = {}) {
  const wav = pcm16ToWav(pcm, { sampleRate: 16000, channels: 1 });
  return transcribeWav(wav, { lang, prompt });
}

/** 转写 WAV Buffer */
export async function transcribeWav(wav, { lang = config.asr.language, prompt = '' } = {}) {
  switch (config.asr.provider) {
    case 'openai':
      return transcribeOpenAI(wav, { lang, prompt });
    case 'local':
      return transcribeLocal(wav, { lang });
    case 'mock':
    default:
      return { text: '[mock] 未配置 ASR，请设置 ASR_PROVIDER=openai 或 local', lang };
  }
}

async function transcribeOpenAI(wav, { lang, prompt }) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', config.asr.model);
  form.append('response_format', 'verbose_json');
  if (lang && lang !== 'auto') form.append('language', lang);
  if (prompt) form.append('prompt', prompt);

  const res = await fetch(`${config.asr.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.asr.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`ASR(openai) ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    text: (data.text ?? '').trim(),
    lang: data.language,
    segments: (data.segments ?? []).map((s) => ({
      start: s.start,
      end: s.end,
      text: (s.text ?? '').trim(),
    })),
  };
}

/**
 * 本机命令行转写。ASR_LOCAL_CMD 支持占位符 {file} {lang} {model}。
 * 例（faster-whisper 脚本）：
 *   ASR_LOCAL_CMD="python3 scripts/whisper_cli.py --model {model} --lang {lang} {file}"
 * 例（whisper.cpp）：
 *   ASR_LOCAL_CMD="/opt/whisper.cpp/main -m /models/ggml-{model}.bin -f {file} -l {lang} -otxt -of {out}"
 * 要求命令把识别纯文本输出到 stdout（whisper.cpp 用 -otxt 会写文件，可用 {out}）。
 */
async function transcribeLocal(wav, { lang }) {
  if (!config.asr.localCmd) {
    throw new Error('ASR_PROVIDER=local 但未设置 ASR_LOCAL_CMD');
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-'));
  const inFile = path.join(dir, 'in.wav');
  const outBase = path.join(dir, 'out');
  await fs.writeFile(inFile, wav);

  const command = config.asr.localCmd
    .replaceAll('{file}', inFile)
    .replaceAll('{out}', outBase)
    .replaceAll('{lang}', lang && lang !== 'auto' ? lang : 'auto')
    .replaceAll('{model}', config.asr.localModel);

  try {
    const { stdout } = await execFileAsync('bash', ['-lc', command], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    let text = stdout.trim();
    if (!text) {
      // whisper.cpp -otxt 写文件
      text = await fs.readFile(`${outBase}.txt`, 'utf8').catch(() => '');
    }
    // 去掉 whisper.cpp 的时间戳前缀 [00:00:00.000 --> ...] 与空行
    const cleaned = text
      .split('\n')
      .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim())
      .filter(Boolean)
      .join('')
      .trim();
    return { text: cleaned, lang };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
