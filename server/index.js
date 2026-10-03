import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { chat } from './lib/llm.js';
import { correctSegments } from './lib/correct.js';
import {
  createSession,
  getSession,
  ingest,
  deleteSession,
} from './lib/summarize.js';
import { AsrStream } from './lib/asr-stream.js';
import { transcribePcm } from './providers/asr.js';
import { fetchSubtitles, parseVtt, parseYouTubeJson3, parseBilibiliSubtitle } from './providers/subtitles.js';
import { allTerms } from './lib/glossary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const app = express();
app.use(express.json({ limit: '25mb' }));

// 本地工具，放开 CORS，方便页面内 fetch 与用户脚本调用
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/public', express.static(path.join(rootDir, 'public')));
app.use('/userscript', express.static(path.join(rootDir, 'userscript')));

app.get('/', (_req, res) => {
  res.json({
    name: 'video-summary',
    endpoints: [
      'GET  /api/health',
      'GET  /api/config',
      'GET  /api/terms?domain=',
      'GET  /api/subtitle?url=',
      'POST /api/subtitle/parse',
      'POST /api/correct',
      'POST /api/summarize',
      'POST /api/session',
      'POST /api/chat',
      'WS   /ws/asr',
    ],
    ui: '/public/',
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    llm: Boolean(config.llm.apiKey),
    llmModel: config.llm.model,
    asrProvider: config.asr.provider,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    llmModel: config.llm.model,
    correctModel: config.llm.correctModel,
    asrProvider: config.asr.provider,
    languages: ['auto', 'zh', 'en', 'ja', 'ko'],
  });
});

app.get('/api/terms', async (req, res, next) => {
  try {
    res.json({ terms: await allTerms(req.query.domain || 'global') });
  } catch (e) {
    next(e);
  }
});

// 服务端抓字幕（可选路径，浏览器端取不到时回退）
app.get('/api/subtitle', async (req, res, next) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url 必填' });
    const data = await fetchSubtitles(String(url));
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// 解析浏览器传来的原始字幕（VTT / YouTube json3 / B站 json）
app.post('/api/subtitle/parse', (req, res, next) => {
  try {
    const { kind, data } = req.body ?? {};
    let segments = [];
    if (kind === 'vtt' || kind === 'srt') segments = parseVtt(String(data));
    else if (kind === 'youtube-json3') segments = parseYouTubeJson3(data);
    else if (kind === 'bilibili-json') segments = parseBilibiliSubtitle(data);
    else return res.status(400).json({ error: '未知 kind' });
    res.json({ segments });
  } catch (e) {
    next(e);
  }
});

app.post('/api/correct', async (req, res, next) => {
  try {
    const { segments = [], lang, domain, force } = req.body ?? {};
    const result = await correctSegments(segments, { lang, domain, force });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

app.post('/api/session', (req, res) => {
  const { id, domain, lang, title } = req.body ?? {};
  const sessionId = id || crypto.randomUUID();
  const session = createSession({ id: sessionId, domain, lang, title });
  res.json({ sessionId: session.id });
});

app.post('/api/summarize', async (req, res, next) => {
  try {
    const {
      sessionId,
      segments = [],
      lang,
      domain,
      title,
      force = false,
      final = false,
    } = req.body ?? {};
    let session = sessionId ? getSession(sessionId) : null;
    if (!session) {
      const id = sessionId || crypto.randomUUID();
      session = createSession({ id, domain, lang, title });
    }
    const result = await ingest(session, segments, { force, final });
    res.json({
      sessionId: session.id,
      chunks: result.chunks,
      global: result.global ?? session.global,
      chunkCount: session.chunks.length,
      segmentCount: session.segments.length,
    });
  } catch (e) {
    next(e);
  }
});

app.post('/api/chat', async (req, res, next) => {
  try {
    const { sessionId, question, segments } = req.body ?? {};
    const session = sessionId ? getSession(sessionId) : null;
    const transcript = (session?.segments ?? segments ?? [])
      .map((s) => `[${Math.floor(s.start)}s] ${s.text}`)
      .join('\n')
      .slice(-14000);
    if (!transcript) return res.status(400).json({ error: '没有可用的字幕内容' });
    const answer = await chat(
      [
        {
          role: 'system',
          content:
            '你是视频内容问答助手。只根据提供的字幕回答问题；字幕没有的信息就说"视频中未提到"。回答简洁，可在句末用 [秒数] 标注依据位置。',
        },
        { role: 'user', content: `字幕：\n${transcript}\n\n问题：${question}` },
      ],
      { temperature: 0.3 },
    );
    res.json({ answer });
  } catch (e) {
    next(e);
  }
});

app.delete('/api/session/:id', (req, res) => {
  deleteSession(req.params.id);
  res.json({ ok: true });
});

// ---- 供用户脚本使用的 HTTP 版 ASR（GM_xmlhttpRequest 可绕过 https 页面的混合内容限制）----
const asrChunkSessions = new Map();

app.post(
  '/api/asr/chunk',
  express.raw({ type: () => true, limit: '25mb' }),
  async (req, res, next) => {
    try {
      const sessionId = String(req.query.session || 'default');
      const lang = String(req.query.lang || config.asr.language);
      const pcm = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
      if (!pcm.length) return res.json({ text: '' });

      const st = asrChunkSessions.get(sessionId) ?? { offset: 0, prompt: '' };
      const start = st.offset;
      const end = start + pcm.length / (16000 * 2);
      const result = await transcribePcm(pcm, { lang, prompt: st.prompt });
      st.offset = end;
      if (result.text) st.prompt = result.text.slice(-200);
      asrChunkSessions.set(sessionId, st);

      res.json({
        text: result.text || '',
        start,
        end,
        lang: result.lang ?? lang,
      });
    } catch (e) {
      next(e);
    }
  },
);

app.post('/api/asr/reset', (req, res) => {
  asrChunkSessions.delete(String(req.body?.session || 'default'));
  res.json({ ok: true });
});

// 统一错误处理
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/asr' });

wss.on('connection', (ws) => {
  const stream = new AsrStream(ws, {
    lang: config.asr.language,
    windowSec: 5,
  });
  stream.send({ type: 'ready', provider: config.asr.provider });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      stream.push(Buffer.from(data));
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'config') stream.configure(msg);
      if (msg.type === 'flush') stream.flush();
    } catch {
      /* ignore */
    }
  });

  ws.on('close', () => {
    stream.flush().catch(() => {});
  });
  ws.on('error', () => {});
});

server.listen(config.port, config.host, () => {
  console.log(`video-summary 服务已启动: http://localhost:${config.port}`);
  console.log(`  控制台: http://localhost:${config.port}/public/`);
  console.log(`  用户脚本: http://localhost:${config.port}/userscript/video-summary.user.js`);
  console.log(`  LLM: ${config.llm.model} @ ${config.llm.baseUrl} (key ${config.llm.apiKey ? '已配置' : '缺失'})`);
  console.log(`  ASR: ${config.asr.provider}`);
});
