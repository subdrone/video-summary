/**
 * 端到端冒烟测试：
 * 1) 起一个假的 OpenAI 兼容 LLM 服务
 * 2) 用 mock ASR 启动本服务
 * 3) 依次验证 /api/correct /api/summarize /api/chat /api/asr/chunk
 *
 * 运行： node scripts/smoke.js
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const LLM_PORT = 9911;
const APP_PORT = 8790;
const BASE = `http://127.0.0.1:${APP_PORT}`;

const fakeLlm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const payload = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            emoji: '🎯',
            title: '示例片段',
            bullets: ['要点一', '要点二'],
            terms: [{ canonical: 'OpenAI', aliases: ['open ai'] }],
            overview: '这是整体概述。',
            keyPoints: ['核心结论'],
            moments: [{ time: '00:03', emoji: '⭐', title: '关键节点' }],
            openQuestions: ['还有疑问？'],
            lines: [],
          }),
        },
      },
    ],
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
});

function waitForServer(url, tries = 50) {
  return new Promise((resolve, reject) => {
    const tick = async (n) => {
      try {
        const r = await fetch(url);
        if (r.ok) return resolve();
      } catch {}
      if (n <= 0) return reject(new Error('服务启动超时'));
      setTimeout(() => tick(n - 1), 200);
    };
    tick(tries);
  });
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

async function main() {
  await new Promise((r) => fakeLlm.listen(LLM_PORT, r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-smoke-'));

  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
      LLM_API_KEY: 'test',
      ASR_PROVIDER: 'mock',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitForServer(`${BASE}/api/health`);
    check('服务启动 /api/health', true);

    const health = await (await fetch(`${BASE}/api/health`)).json();
    check('健康信息包含 llm/asr', health.llm === true && health.asrProvider === 'mock', JSON.stringify(health));

    const segments = [
      { start: 0, end: 3, text: '大家好 今天我们讲 open ai 的 interface', source: 'auto-cc' },
      { start: 3, end: 6, text: '以及 transformer 架构', source: 'auto-cc' },
    ];

    const corr = await (
      await fetch(`${BASE}/api/correct`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ segments, lang: 'zh', domain: 'smoke' }),
      })
    ).json();
    check('字幕纠错 /api/correct', Array.isArray(corr.segments) && corr.segments.length === 2, `terms=${corr.terms?.length ?? 0}`);

    const terms = await (await fetch(`${BASE}/api/terms?domain=smoke`)).json();
    check('术语表已写入 /api/terms', (terms.terms ?? []).some((t) => t.canonical === 'OpenAI'));

    const s1 = await (
      await fetch(`${BASE}/api/summarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ segments, lang: 'zh', domain: 'smoke', force: true, final: true }),
      })
    ).json();
    check('总结 /api/summarize', s1.chunks?.length === 1 && !!s1.global, `session=${s1.sessionId}`);
    check('分块含 emoji', s1.chunks?.[0]?.emoji === '🎯');
    check('总览含时间戳关键节点', Array.isArray(s1.global?.moments) && s1.global.moments.length >= 1, JSON.stringify(s1.global?.moments));

    const chat = await (
      await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: s1.sessionId, question: '讲了什么？' }),
      })
    ).json();
    check('问答 /api/chat', typeof chat.answer === 'string' && chat.answer.length > 0);

    // ASR chunk：发送 1 秒 16k PCM16 静音
    const pcm = Buffer.alloc(16000 * 2);
    const asr = await (
      await fetch(`${BASE}/api/asr/chunk?session=smoke&lang=zh`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: pcm,
      })
    ).json();
    check('ASR 分片 /api/asr/chunk', typeof asr.text === 'string' && asr.end > 0, `end=${asr.end}`);
  } finally {
    child.kill('SIGTERM');
    fakeLlm.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
