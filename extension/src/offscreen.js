/** offscreen 文档：tabCapture 采集标签页音频 -> 重采样 16k PCM -> 调后端 ASR -> 回传字幕段 */

const WORKLET = `
class PCMCapture extends AudioWorkletProcessor {
  constructor(){ super(); this.phase=0; this.ratio=sampleRate/16000; this.buf=[]; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if(!ch) return true;
    for(let i=0;i<ch.length;i++){
      this.phase += 1;
      if(this.phase >= this.ratio){
        this.phase -= this.ratio;
        let s = Math.max(-1, Math.min(1, ch[i]));
        this.buf.push(s<0 ? s*0x8000 : s*0x7fff);
      }
    }
    if(this.buf.length >= 4800){ // ~0.3s
      const arr = Int16Array.from(this.buf);
      this.port.postMessage(arr.buffer, [arr.buffer]);
      this.buf = [];
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);`;

const SAMPLE_RATE = 16000;
const FLUSH_SAMPLES = SAMPLE_RATE * 5; // 每 5 秒转写一次

const session = {
  active: false,
  tabId: null,
  backend: '',
  sessionKey: '',
  lang: 'auto',
  baseTime: 0,
  ctx: null,
  node: null,
  src: null,
  sink: null,
  stream: null,
  buffers: [],
  pendingSamples: 0,
  chain: Promise.resolve(),
  lastSound: 0,
  warned: false,
  errored: false,
};

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function start(msg) {
  if (session.active) await stop();
  Object.assign(session, {
    active: true,
    tabId: msg.tabId,
    backend: msg.backend.replace(/\/+$/, ''),
    sessionKey: msg.session,
    lang: msg.lang || 'auto',
    baseTime: msg.baseTime || 0,
    buffers: [],
    pendingSamples: 0,
    lastSound: Date.now(),
    warned: false,
    errored: false,
  });

  // 重置后端音频偏移
  await fetch(`${session.backend}/api/asr/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: session.sessionKey }),
  }).catch(() => {});

  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: msg.streamId,
      },
    },
  });
  session.stream = media;

  const ctx = new AudioContext();
  await ctx.resume();
  session.ctx = ctx;
  const src = ctx.createMediaStreamSource(media);
  session.src = src;

  // 让用户仍能听到标签页声音（tabCapture 默认会静音标签页）
  src.connect(ctx.destination);

  await ctx.audioWorklet.addModule(
    URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })),
  );
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  session.node = node;
  src.connect(node);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);
  session.sink = sink;

  node.port.onmessage = (e) => pushPcm(e.data);
}

function pushPcm(buffer) {
  if (!session.active) return;
  const i16 = new Int16Array(buffer);

  let peak = 0;
  for (let i = 0; i < i16.length; i += 8) peak = Math.max(peak, Math.abs(i16[i]));
  if (peak > 400) session.lastSound = Date.now();
  else if (Date.now() - session.lastSound > 4000 && !session.warned) {
    session.warned = true;
    send({ type: 'ASR_WARN', tabId: session.tabId, message: '未检测到标签页声音，请确认视频正在播放' });
  }

  session.buffers.push(buffer);
  session.pendingSamples += i16.length;
  if (session.pendingSamples >= FLUSH_SAMPLES) flush();
}

function flush() {
  if (!session.buffers.length) return;
  const merged = mergeBuffers(session.buffers, session.pendingSamples);
  session.buffers = [];
  session.pendingSamples = 0;
  const chunk = merged;
  session.chain = session.chain
    .then(() => transcribe(chunk))
    .catch((e) => {
      if (!session.errored) {
        session.errored = true;
        send({ type: 'ASR_ERROR', tabId: session.tabId, message: String(e?.message || e) });
      }
    });
}

function mergeBuffers(buffers, totalSamples) {
  const out = new Int16Array(totalSamples);
  let off = 0;
  for (const b of buffers) {
    const a = new Int16Array(b);
    out.set(a, off);
    off += a.length;
  }
  return out.buffer;
}

async function transcribe(buffer) {
  if (!buffer.byteLength) return;
  const url = `${session.backend}/api/asr/chunk?session=${encodeURIComponent(
    session.sessionKey,
  )}&lang=${encodeURIComponent(session.lang)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: buffer,
  });
  if (!res.ok) throw new Error('ASR HTTP ' + res.status);
  const data = await res.json();
  if (!data.text) return;
  send({
    type: 'ASR_SEGMENT',
    tabId: session.tabId,
    segment: {
      start: session.baseTime + (data.start || 0),
      end: session.baseTime + (data.end || 0),
      text: data.text,
      source: 'asr',
      lang: data.lang || session.lang,
    },
  });
}

async function stop() {
  if (!session.active && !session.ctx) return;
  session.active = false;
  flush();
  try { session.node?.disconnect(); } catch {}
  try { session.src?.disconnect(); } catch {}
  try { session.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { await session.ctx?.close(); } catch {}
  session.ctx = session.node = session.src = session.sink = session.stream = null;
  // 等待剩余转写完成
  await session.chain.catch(() => {});
  send({ type: 'ASR_STOPPED', tabId: session.tabId });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'OFFSCREEN_START') {
    start(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        send({ type: 'ASR_ERROR', tabId: msg.tabId, message: String(e?.message || e) });
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
    return true;
  }
  if (msg?.type === 'OFFSCREEN_STOP') {
    stop()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }
});
