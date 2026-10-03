// ==UserScript==
// @name         AI 视频实时总结 (B站 / YouTube)
// @namespace    https://github.com/video-summary
// @version      0.1.0
// @description  优先读取平台字幕（人工/AI 字幕），用 LLM 纠错 + 滚动总结；无字幕时实时采集音频走 ASR。支持时间轴跳转与内容问答。
// @author       you
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      api.bilibili.com
// @connect      hdslb.com
// @connect      bilibili.com
// @connect      youtube.com
// @connect      googlevideo.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.1.0';
  const DEFAULT_BACKEND = 'http://127.0.0.1:8787';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  /* ============================ 配置持久化 ============================ */
  const conf = Object.assign(
    { backend: DEFAULT_BACKEND, lang: 'auto', autoCorrect: true, autoStart: false },
    gmGet('config', {}),
  );
  function gmGet(k, d) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(k, d);
      return JSON.parse(localStorage.getItem('vs_' + k)) ?? d;
    } catch {
      return d;
    }
  }
  function gmSet(k, v) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(k, v);
      else localStorage.setItem('vs_' + k, JSON.stringify(v));
    } catch {}
  }
  const saveConf = () => gmSet('config', conf);
  const base = () => conf.backend.replace(/\/+$/, '');

  /* ============================ 网络层 ============================ */
  function xhr(opt) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: opt.method || 'GET',
          url: opt.url,
          headers: opt.headers,
          data: opt.data,
          binary: opt.binary,
          responseType: opt.responseType,
          timeout: opt.timeout || 300000,
          onload: (r) => resolve(r),
          onerror: () => reject(new Error('网络错误: ' + opt.url)),
          ontimeout: () => reject(new Error('请求超时: ' + opt.url)),
        });
      } else {
        fetch(opt.url, {
          method: opt.method || 'GET',
          headers: opt.headers,
          body: opt.data,
          credentials: 'include',
        })
          .then(async (r) => {
            const text = await r.text();
            let response = text;
            if (opt.responseType === 'json') {
              try {
                response = JSON.parse(text);
              } catch {}
            }
            resolve({ status: r.status, responseText: text, response });
          })
          .catch(reject);
      }
    });
  }

  const errText = (r) => {
    try {
      return r.response?.error || r.responseText?.slice(0, 300) || `HTTP ${r.status}`;
    } catch {
      return `HTTP ${r.status}`;
    }
  };

  async function apiPost(path, body) {
    const r = await xhr({
      method: 'POST',
      url: base() + path,
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify(body),
      responseType: 'json',
    });
    if (r.status >= 400) throw new Error(errText(r));
    return typeof r.response === 'object' ? r.response : JSON.parse(r.responseText || '{}');
  }
  async function apiGet(path) {
    const r = await xhr({ method: 'GET', url: base() + path, responseType: 'json' });
    if (r.status >= 400) throw new Error(errText(r));
    return typeof r.response === 'object' ? r.response : JSON.parse(r.responseText || '{}');
  }
  async function apiPostPcm(path, buffer) {
    const r = await xhr({
      method: 'POST',
      url: base() + path,
      headers: { 'content-type': 'application/octet-stream' },
      data: buffer,
      binary: true,
      responseType: 'json',
    });
    if (r.status >= 400) throw new Error(errText(r));
    return typeof r.response === 'object' ? r.response : JSON.parse(r.responseText || '{}');
  }

  /* 页面上下文请求：B站同站接口 / YouTube timedtext，可带 Cookie */
  async function pageFetch(url) {
    const r = await W.fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  }
  async function smartGetJson(url) {
    try {
      return await (await pageFetch(url)).json();
    } catch (_) {}
    const r = await xhr({ method: 'GET', url, responseType: 'json' });
    if (r.status >= 400) throw new Error(errText(r));
    return typeof r.response === 'object' ? r.response : JSON.parse(r.responseText);
  }

  /* ============================ 字幕解析 ============================ */
  function mergeAdjacent(segs) {
    const out = [];
    for (const s of segs) {
      const p = out[out.length - 1];
      if (p && s.start - p.end < 0.35 && p.text.length < 60) {
        p.text = (p.text + ' ' + s.text).trim();
        p.end = s.end;
      } else out.push({ ...s });
    }
    return out;
  }
  function parseYouTubeJson3(json) {
    const out = [];
    for (const ev of json?.events ?? []) {
      const text = (ev.segs ?? [])
        .map((s) => s.utf8 ?? '')
        .join('')
        .replace(/\n/g, ' ')
        .trim();
      if (!text) continue;
      const start = (ev.tStartMs ?? 0) / 1000;
      out.push({ start, end: start + (ev.dDurationMs ?? 0) / 1000, text });
    }
    return mergeAdjacent(out);
  }
  function parseVtt(vtt) {
    const out = [];
    const t = (s) => {
      const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
      if (!m) return 0;
      return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    };
    for (const block of vtt.replace(/\r/g, '').split('\n\n')) {
      const lines = block.split('\n').filter((l) => l && !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()));
      const timeLine = lines.find((l) => l.includes('-->'));
      if (!timeLine) continue;
      const [a, b] = timeLine.split('-->');
      const text = lines.filter((l) => l !== timeLine).join(' ').replace(/<[^>]+>/g, '').trim();
      if (text) out.push({ start: t(a), end: t(b), text });
    }
    return mergeAdjacent(out);
  }

  /* ============================ 平台适配 ============================ */
  function detectSite() {
    const h = location.hostname;
    if (/bilibili\.com$/.test(h)) return 'bilibili';
    if (/youtube\.com$/.test(h)) return 'youtube';
    return null;
  }
  function videoKey() {
    if (detectSite() === 'bilibili') {
      const bv = location.pathname.match(/(BV[0-9A-Za-z]{10})/)?.[1];
      if (bv) return bv;
      const ep = location.pathname.match(/\/ep(\d+)/)?.[1] || new URLSearchParams(location.search).get('ep_id');
      if (ep) return 'ep' + ep;
    }
    if (detectSite() === 'youtube') {
      return location.search.match(/[?&]v=([0-9A-Za-z_-]{11})/)?.[1] || location.pathname.split('/').pop();
    }
    return 'unknown';
  }

  async function biliResolveCid() {
    const bvid = location.pathname.match(/(BV[0-9A-Za-z]{10})/)?.[1];
    if (bvid) {
      const view = await smartGetJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
      if (view.code !== 0) throw new Error('B站接口: ' + view.message);
      const p = Number(new URLSearchParams(location.search).get('p') || 1);
      const pages = view.data.pages || [];
      const cid = (pages[p - 1] || pages[0])?.cid ?? view.data.cid;
      return { aid: view.data.aid, cid, title: view.data.title, bvid };
    }
    const epId = location.pathname.match(/\/ep(\d+)/)?.[1] || new URLSearchParams(location.search).get('ep_id');
    const ssId = location.pathname.match(/\/ss(\d+)/)?.[1];
    const q = epId ? `ep_id=${epId}` : `season_id=${ssId}`;
    const data = await smartGetJson(`https://api.bilibili.com/pgc/view/web/season?${q}`);
    const result = data.result ?? data.data?.result;
    if (!result) throw new Error('番剧接口无数据');
    const eps = result.episodes || [];
    const ep = epId ? eps.find((e) => String(e.id) === String(epId) || String(e.ep_id) === String(epId)) : eps[0];
    const target = ep || eps[0];
    if (!target) throw new Error('未找到剧集');
    return { aid: target.aid, cid: target.cid, title: result.title, bvid: target.bvid };
  }

  async function getBilibiliSubtitles() {
    const { aid, cid, title, bvid } = await biliResolveCid();
    const q = new URLSearchParams({ aid: String(aid), cid: String(cid) });
    if (bvid) q.set('bvid', bvid);
    const pv = await smartGetJson(`https://api.bilibili.com/x/player/v2?${q}`);
    const subs = pv?.data?.subtitle?.subtitles ?? [];
    if (!subs.length) throw new Error('该视频无可用字幕（UP 未上传 / 未登录）');
    const pick =
      subs.find((s) => /^zh/i.test(s.lan) && !s.ai_type) ||
      subs.find((s) => /^zh/i.test(s.lan)) ||
      subs.find((s) => /^en/i.test(s.lan)) ||
      subs[0];
    let url = pick.subtitle_url.startsWith('//') ? 'https:' + pick.subtitle_url : pick.subtitle_url;
    const json = await smartGetJson(url);
    const segments = (json.body ?? []).map((b) => ({
      start: +b.from || 0,
      end: +b.to || 0,
      text: String(b.content ?? '').trim(),
      source: pick.ai_type ? 'auto-cc' : 'official',
      lang: pick.lan,
    }));
    if (!segments.length) throw new Error('字幕内容为空');
    return { segments, title, aiGenerated: !!pick.ai_type, lang: pick.lan };
  }

  function getYtPlayerResponse() {
    if (W.ytInitialPlayerResponse) return W.ytInitialPlayerResponse;
    for (const s of document.scripts) {
      const m = s.textContent && s.textContent.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch {}
      }
    }
    return null;
  }

  async function getYouTubeSubtitles() {
    const pr = getYtPlayerResponse();
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!tracks.length) throw new Error('该视频无可用字幕');
    const pick =
      tracks.find((t) => /^(zh|en)/i.test(t.languageCode) && t.kind !== 'asr') ||
      tracks.find((t) => t.kind !== 'asr') ||
      tracks.find((t) => /^zh/i.test(t.languageCode)) ||
      tracks[0];
    const url = pick.baseUrl + (pick.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    const json = await smartGetJson(url);
    const segments = parseYouTubeJson3(json).map((s) => ({
      ...s,
      source: pick.kind === 'asr' ? 'auto-cc' : 'official',
      lang: pick.languageCode,
    }));
    if (!segments.length) throw new Error('字幕内容为空');
    return {
      segments,
      title: pr?.videoDetails?.title || document.title,
      aiGenerated: pick.kind === 'asr',
      lang: pick.languageCode,
    };
  }

  async function getSubtitles() {
    const site = detectSite();
    if (site === 'bilibili') return getBilibiliSubtitles();
    if (site === 'youtube') return getYouTubeSubtitles();
    throw new Error('不支持的站点');
  }

  /* ============================ 状态 ============================ */
  const state = {
    info: null,
    segments: [],
    sessionId: null,
    chunks: [],
    global: null,
    mode: null,
    busy: false,
    progress: '',
    asr: { running: false, ctx: null, node: null, src: null, stream: null, baseTime: 0, chain: Promise.resolve(), rawPending: [], lastSound: 0, silentWarned: false },
    ttsUrl: null,
  };

  /* ============================ UI ============================ */
  let ui = {};
  function buildUI() {
    const host = document.createElement('div');
    host.id = 'vs-root';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{all:initial}
        *{box-sizing:border-box;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
        .float{position:fixed;right:18px;bottom:80px;z-index:2147483646;width:48px;height:48px;border-radius:50%;
          background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;display:flex;align-items:center;justify-content:center;
          cursor:pointer;box-shadow:0 6px 20px rgba(99,102,241,.5);font-size:22px;user-select:none}
        .float:active{transform:scale(.94)}
        .panel{position:fixed;right:18px;bottom:140px;z-index:2147483647;width:390px;max-height:78vh;display:flex;flex-direction:column;
          background:rgba(17,19,28,.96);color:#e5e7eb;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;
          box-shadow:0 20px 60px rgba(0,0,0,.55);backdrop-filter:blur(12px);font-size:13px;line-height:1.55}
        .panel.hidden{display:none}
        .panel.min .body,.panel.min .foot{display:none}
        header{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;
          background:linear-gradient(90deg,rgba(99,102,241,.25),rgba(139,92,246,.12));border-bottom:1px solid rgba(255,255,255,.06)}
        header .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e}
        header .t{font-weight:600;font-size:13px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        header button{all:unset;cursor:pointer;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:6px;color:#cbd5e1}
        header button:hover{background:rgba(255,255,255,.1)}
        .body{padding:10px 12px;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
        .body::-webkit-scrollbar{width:6px}.body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
        .status{font-size:12px;color:#94a3b8;display:flex;align-items:center;gap:6px}
        .status .spin{width:12px;height:12px;border:2px solid rgba(148,163,184,.4);border-top-color:#818cf8;border-radius:50%;animation:sp .8s linear infinite}
        @keyframes sp{to{transform:rotate(360deg)}}
        .card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:9px 11px}
        .card h4{margin:0 0 5px;font-size:12px;color:#a5b4fc;font-weight:600;letter-spacing:.3px}
        .overview{font-size:13px;color:#e2e8f0}
        ul.kp{margin:6px 0 0;padding-left:16px;display:flex;flex-direction:column;gap:3px}
        ul.kp li{color:#cbd5e1;font-size:12.5px}
        .tl{display:flex;flex-direction:column;gap:6px}
        .tl-item{border-left:2px solid rgba(129,140,248,.5);padding:5px 0 5px 9px;cursor:pointer;border-radius:0 6px 6px 0;transition:.15s}
        .tl-item:hover{background:rgba(129,140,248,.12)}
        .tl-item.active{background:rgba(129,140,248,.18);border-left-color:#818cf8}
        .tl-item .th{display:flex;gap:8px;align-items:baseline}
        .tl-item .time{font-size:11px;color:#818cf8;font-variant-numeric:tabular-nums;flex-shrink:0}
        .tl-item .tt{font-size:12.5px;color:#f1f5f9;font-weight:500}
        .tl-item .tb{font-size:12px;color:#94a3b8;margin-top:2px}
        .live{font-size:12px;color:#94a3b8;max-height:96px;overflow-y:auto;white-space:pre-wrap}
        .live b{color:#e2e8f0;font-weight:500}
        .ask{display:flex;gap:6px}
        .ask input{flex:1;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);color:#e5e7eb;border-radius:8px;padding:7px 9px;font-size:12.5px;outline:none}
        .ask input:focus{border-color:#818cf8}
        .ask button,.btn{all:unset;cursor:pointer;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border-radius:8px;padding:7px 12px;font-size:12.5px;text-align:center}
        .btn:hover,.ask button:hover{filter:brightness(1.1)}
        .btn.ghost{background:rgba(255,255,255,.08)}
        .answer{font-size:12.5px;color:#dbeafe;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.25);border-radius:8px;padding:8px 10px;white-space:pre-wrap}
        .foot{padding:8px 12px;display:flex;gap:8px;border-top:1px solid rgba(255,255,255,.06)}
        .settings{padding:10px 12px;display:none;flex-direction:column;gap:8px;border-top:1px solid rgba(255,255,255,.06)}
        .settings.show{display:flex}
        .settings label{font-size:12px;color:#94a3b8;display:flex;flex-direction:column;gap:4px}
        .settings input[type=text],.settings select{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);color:#e5e7eb;border-radius:7px;padding:6px 8px;font-size:12.5px;outline:none}
        .hint{font-size:11px;color:#64748b}
        .tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(250,204,21,.18);color:#fde047;margin-left:6px}
      </style>
      <div class="float" part="float" title="AI 视频总结">✦</div>
      <div class="panel hidden" part="panel">
        <header>
          <span class="dot"></span>
          <span class="t">AI 视频总结</span>
          <button data-act="settings" title="设置">⚙</button>
          <button data-act="min" title="最小化">–</button>
          <button data-act="close" title="关闭">×</button>
        </header>
        <div class="body" part="body">
          <div class="status"></div>
          <div class="card global hidden">
            <h4>整体总结</h4>
            <div class="overview"></div>
            <ul class="kp"></ul>
          </div>
          <div class="card live-card hidden">
            <h4>实时字幕</h4>
            <div class="live"></div>
          </div>
          <div class="tl"></div>
          <div class="answer hidden"></div>
          <div class="ask">
            <input type="text" placeholder="就视频内容提问…" />
            <button data-act="ask">问</button>
          </div>
        </div>
        <div class="foot">
          <button class="btn" data-act="start">开始分析</button>
          <button class="btn ghost" data-act="tabcap">共享标签页音频</button>
        </div>
        <div class="settings">
          <label>后端地址
            <input type="text" data-k="backend" />
          </label>
          <label>语言
            <select data-k="lang">
              <option value="auto">自动</option>
              <option value="zh">中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
            </select>
          </label>
          <label style="flex-direction:row;align-items:center;gap:6px">
            <input type="checkbox" data-k="autoCorrect" /> 对 AI 字幕 / ASR 做 LLM 纠错
          </label>
          <div class="hint">后端需运行 video-summary 服务。修改后点“保存”。</div>
          <div style="display:flex;gap:8px">
            <button class="btn" data-act="save">保存</button>
            <button class="btn ghost" data-act="reload">重新分析</button>
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    ui = {
      host,
      root,
      float: root.querySelector('.float'),
      panel: root.querySelector('.panel'),
      title: root.querySelector('.t'),
      status: root.querySelector('.status'),
      global: root.querySelector('.global'),
      overview: root.querySelector('.overview'),
      kp: root.querySelector('.kp'),
      liveCard: root.querySelector('.live-card'),
      live: root.querySelector('.live'),
      tl: root.querySelector('.tl'),
      answer: root.querySelector('.answer'),
      askInput: root.querySelector('.ask input'),
      settings: root.querySelector('.settings'),
      body: root.querySelector('.body'),
      foot: root.querySelector('.foot'),
    };

    // 事件
    ui.float.onclick = () => ui.panel.classList.toggle('hidden');
    ui.root.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      if (act === 'close') ui.panel.classList.add('hidden');
      if (act === 'min') ui.panel.classList.toggle('min');
      if (act === 'settings') ui.settings.classList.toggle('show');
      if (act === 'save') saveSettings();
      if (act === 'reload') location.reload();
      if (act === 'ask') askQuestion();
      if (act === 'start') startFlow(false);
      if (act === 'tabcap') startAsr('display');
    });
    ui.askInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') askQuestion();
    });

    // 载入设置
    ui.root.querySelector('[data-k=backend]').value = conf.backend;
    ui.root.querySelector('[data-k=lang]').value = conf.lang;
    ui.root.querySelector('[data-k=autoCorrect]').checked = conf.autoCorrect;

    makeDraggable(ui.panel, ui.panel.querySelector('header'));
  }

  function saveSettings() {
    conf.backend = ui.root.querySelector('[data-k=backend]').value.trim() || DEFAULT_BACKEND;
    conf.lang = ui.root.querySelector('[data-k=lang]').value;
    conf.autoCorrect = ui.root.querySelector('[data-k=autoCorrect]').checked;
    saveConf();
    setStatus('设置已保存');
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const nx = ox + (e.clientX - sx);
      const ny = oy + (e.clientY - sy);
      el.style.left = nx + 'px';
      el.style.top = ny + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => (dragging = false));
  }

  function setStatus(text, spinning = false) {
    ui.status.innerHTML = (spinning ? '<span class="spin"></span>' : '') + '<span></span>';
    ui.status.lastChild.textContent = text;
  }

  function renderGlobal() {
    const g = state.global;
    if (!g) return;
    ui.global.classList.remove('hidden');
    ui.overview.textContent = g.overview || '';
    ui.kp.innerHTML = '';
    for (const k of g.keyPoints ?? []) {
      const li = document.createElement('li');
      li.textContent = k;
      ui.kp.appendChild(li);
    }
  }

  const fmt = (t) => {
    t = Math.max(0, Math.floor(t || 0));
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };

  function renderChunks() {
    ui.tl.innerHTML = '';
    state.chunks.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'tl-item';
      el.dataset.start = c.start;
      el.dataset.end = c.end;
      el.innerHTML = `<div class="th"><span class="time">${fmt(c.start)}</span><span class="tt"></span></div><div class="tb"></div>`;
      el.querySelector('.tt').textContent = c.title;
      el.querySelector('.tb').textContent = (c.bullets ?? []).join(' · ');
      el.title = (c.bullets ?? []).join('\n');
      el.onclick = () => seek(c.start);
      ui.tl.appendChild(el);
    });
  }

  function renderLive() {
    const segs = state.segments.slice(-6);
    ui.live.textContent = segs.map((s) => s.text).join(' ');
    ui.live.scrollTop = ui.live.scrollHeight;
  }

  function showLiveCard(show) {
    ui.liveCard.classList.toggle('hidden', !show);
  }

  function seek(t) {
    const v = getVideo();
    if (!v) return;
    v.currentTime = t;
    if (v.paused) v.play().catch(() => {});
  }

  function getVideo() {
    const vids = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0);
    if (!vids.length) return document.querySelector('video');
    return vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  }

  /* 高亮当前片段 */
  setInterval(() => {
    if (!ui.tl || !state.chunks.length) return;
    const v = getVideo();
    if (!v) return;
    const t = v.currentTime;
    let active = null;
    for (const el of ui.tl.children) {
      const s = +el.dataset.start, e = +el.dataset.end;
      if (t >= s && t < e) active = el;
    }
    for (const el of ui.tl.children) el.classList.toggle('active', el === active);
  }, 500);

  /* ============================ 字幕模式流程 ============================ */
  function groupByChars(segs, max) {
    const groups = [];
    let cur = [], len = 0;
    for (const s of segs) {
      if (cur.length && len + s.text.length > max) {
        groups.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(s);
      len += s.text.length;
    }
    if (cur.length) groups.push(cur);
    return groups;
  }

  async function runSubtitleFlow(found) {
    state.mode = 'cc';
    state.info.title = found.title || state.info.title;
    state.info.domain = `${detectSite()}:${videoKey()}`;
    ui.title.textContent = state.info.title.slice(0, 40);
    let segs = found.segments;

    const needCorrect =
      conf.autoCorrect && segs.some((s) => s.source === 'auto-cc' || s.source === 'asr');

    if (needCorrect) {
      setStatus('正在纠错字幕…', true);
      const groups = groupByChars(segs, 2600);
      const out = [];
      for (let i = 0; i < groups.length; i++) {
        setStatus(`正在纠错字幕 ${i + 1}/${groups.length}…`, true);
        try {
          const r = await apiPost('/api/correct', {
            segments: groups[i],
            lang: conf.lang,
            domain: state.info.domain,
          });
          out.push(...r.segments);
        } catch (e) {
          out.push(...groups[i]);
        }
      }
      segs = out;
      const tag = ui.title.querySelector('.tag');
      if (tag) tag.remove();
      ui.title.insertAdjacentHTML('beforeend', '<span class="tag">已纠错</span>');
    }

    state.segments = segs;
    renderLive();
    showLiveCard(false);

    const { sessionId } = await apiPost('/api/session', {
      domain: state.info.domain,
      lang: conf.lang,
      title: state.info.title,
    });
    state.sessionId = sessionId;

    const groups = groupByChars(segs, 1800);
    for (let i = 0; i < groups.length; i++) {
      setStatus(`正在生成总结 ${i + 1}/${groups.length}…`, true);
      try {
        const r = await apiPost('/api/summarize', {
          sessionId,
          segments: groups[i],
          lang: conf.lang,
          domain: state.info.domain,
          force: true,
        });
        if (r.chunks?.length) state.chunks.push(...r.chunks);
        if (r.global) state.global = r.global;
        renderChunks();
        renderGlobal();
      } catch (e) {
        setStatus('总结失败: ' + e.message);
        return;
      }
    }
    // 最终全局
    try {
      const r = await apiPost('/api/summarize', { sessionId, lang: conf.lang, final: true });
      if (r.global) state.global = r.global;
      renderGlobal();
    } catch {}

    setStatus(`完成 · ${state.segments.length} 条字幕 · ${state.chunks.length} 个片段`);
    ui.foot.querySelector('[data-act=start]').textContent = '重新分析';
  }

  /* ============================ ASR 模式流程 ============================ */
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
        if(this.buf.length >= 1600){
          const arr = Int16Array.from(this.buf);
          this.port.postMessage(arr.buffer, [arr.buffer]);
          this.buf = [];
        }
        return true;
      }
    }
    registerProcessor('pcm-capture', PCMCapture);`;

  async function getAudioStream(video, mode) {
    if (mode !== 'display' && video?.captureStream) {
      try {
        const s = video.captureStream();
        if (s.getAudioTracks().length) return s;
      } catch (_) {}
    }
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    return new MediaStream(s.getAudioTracks());
  }

  async function startAsr(mode = 'auto') {
    if (state.asr.running) return;
    const site = detectSite();
    state.info = {
      platform: site,
      id: videoKey(),
      domain: `${site}:${videoKey()}`,
      title: document.title.replace(/[_\-|].*$/, '').trim() || '当前视频',
    };
    ui.title.textContent = state.info.title.slice(0, 40);
    state.mode = 'asr';
    showLiveCard(true);
    setStatus('正在获取音频…', true);
    try {
      await apiPost('/api/asr/reset', { session: state.info.domain });
      const video = getVideo();
      state.asr.baseTime = video?.currentTime ?? 0;
      const stream = await getAudioStream(video, mode);
      const ctx = new (W.AudioContext || W.webkitAudioContext)();
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const blobUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(blobUrl);
      const node = new AudioWorkletNode(ctx, 'pcm-capture');
      src.connect(node);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(ctx.destination);

      Object.assign(state.asr, { running: true, ctx, node, src, stream, lastSound: Date.now(), silentWarned: false });
      node.port.onmessage = (e) => enqueuePcm(e.data);
      const { sessionId } = await apiPost('/api/session', {
        domain: state.info.domain,
        lang: conf.lang,
        title: state.info.title,
      });
      state.sessionId = sessionId;
      state.chunks = [];
      renderChunks();
      ui.foot.querySelector('[data-act=start]').textContent = '停止识别';
      setStatus('实时识别中…（保持播放）', true);
    } catch (e) {
      setStatus('采集失败: ' + e.message + '，可尝试“共享标签页音频”');
    }
  }

  function stopAsr() {
    const a = state.asr;
    if (!a.running) return;
    a.running = false;
    try { a.node?.disconnect(); } catch {}
    try { a.src?.disconnect(); } catch {}
    try { a.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { a.ctx?.close(); } catch {}
    a.chain = a.chain.then(() => flushAsr(true).catch(() => {}));
    ui.foot.querySelector('[data-act=start]').textContent = '开始分析';
    setStatus('已停止识别');
  }

  function enqueuePcm(buffer) {
    const a = state.asr;
    if (!a.running) return;
    // 检测是否静音（跨域视频可能导致采集为空）
    const i16 = new Int16Array(buffer);
    let peak = 0;
    for (let i = 0; i < i16.length; i += 8) peak = Math.max(peak, Math.abs(i16[i]));
    if (peak > 400) a.lastSound = Date.now();
    else if (Date.now() - a.lastSound > 3500 && !a.silentWarned) {
      a.silentWarned = true;
      setStatus('疑似未采到声音，试试“共享标签页音频”');
    }
    a.chain = a.chain
      .then(() => postPcm(buffer))
      .catch((e) => setStatus('ASR 错误: ' + e.message));
  }

  async function postPcm(buffer) {
    const res = await apiPostPcm(
      `/api/asr/chunk?session=${encodeURIComponent(state.info.domain)}&lang=${encodeURIComponent(conf.lang)}`,
      buffer,
    );
    if (!res.text) return;
    const seg = {
      start: state.asr.baseTime + res.start,
      end: state.asr.baseTime + res.end,
      text: res.text,
      source: 'asr',
      lang: res.lang,
    };
    state.segments.push(seg);
    state.asr.rawPending.push(seg);
    renderLive();
    const pendingChars = state.asr.rawPending.reduce((n, s) => n + s.text.length, 0);
    if (pendingChars >= 1200) await flushAsr();
  }

  async function flushAsr(final = false) {
    const a = state.asr;
    if (!a.rawPending.length) {
      if (final && state.sessionId) {
        try {
          const r = await apiPost('/api/summarize', { sessionId: state.sessionId, lang: conf.lang, final: true });
          if (r.global) { state.global = r.global; renderGlobal(); }
        } catch {}
      }
      return;
    }
    const batch = a.rawPending;
    a.rawPending = [];
    let segs = batch;
    if (conf.autoCorrect) {
      try {
        const r = await apiPost('/api/correct', {
          segments: batch,
          lang: conf.lang,
          domain: state.info.domain,
          force: true,
        });
        segs = r.segments;
        // 用纠错结果替换 state.segments 中的对应项
        const startIdx = state.segments.length - batch.length;
        state.segments.splice(startIdx, batch.length, ...segs);
      } catch {}
    }
    try {
      const r = await apiPost('/api/summarize', {
        sessionId: state.sessionId,
        segments: segs,
        lang: conf.lang,
        domain: state.info.domain,
        force: true,
        final,
      });
      if (r.chunks?.length) state.chunks.push(...r.chunks);
      if (r.global) state.global = r.global;
      renderChunks();
      renderGlobal();
      if (state.asr.running) setStatus('实时识别中…', true);
    } catch (e) {
      setStatus('总结失败: ' + e.message);
    }
  }

  /* ============================ 问答 ============================ */
  async function askQuestion() {
    const q = ui.askInput.value.trim();
    if (!q) return;
    ui.answer.classList.remove('hidden');
    ui.answer.textContent = '思考中…';
    try {
      const r = await apiPost('/api/chat', {
        sessionId: state.sessionId,
        question: q,
        segments: state.sessionId ? undefined : state.segments,
      });
      ui.answer.textContent = r.answer || '（无回答）';
    } catch (e) {
      ui.answer.textContent = '出错: ' + e.message;
    }
  }

  /* ============================ 入口 ============================ */
  async function startFlow(forceAsr = false) {
    if (state.busy) return;
    if (state.asr.running) {
      stopAsr();
      return;
    }
    state.busy = true;
    ui.panel.classList.remove('hidden');
    try {
      const site = detectSite();
      if (!site) {
        setStatus('当前页面不是受支持的视频站点');
        return;
      }
      state.info = { platform: site, id: videoKey(), domain: `${site}:${videoKey()}`, title: document.title };

      // 先尝试字幕
      if (!forceAsr) {
        setStatus('正在读取字幕…', true);
        try {
          const found = await getSubtitles();
          await runSubtitleFlow(found);
          return;
        } catch (e) {
          setStatus('未找到字幕: ' + e.message + '，可实时识别');
        }
      }
      // 回退 ASR
      await startAsr('auto');
    } finally {
      state.busy = false;
    }
  }

  function boot() {
    buildUI();
    setStatus('点击“开始分析”（优先读字幕，无字幕则实时识别）');
    const site = detectSite();
    if (site) {
      state.info = { platform: site, id: videoKey(), domain: `${site}:${videoKey()}`, title: document.title };
      if (conf.autoStart) startFlow(false);
    }
  }

  // SPA 页面切换检测（YouTube）
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (detectSite()) {
        state.chunks = [];
        state.global = null;
        state.segments = [];
        state.sessionId = null;
        stopAsr();
        renderChunks();
        if (ui.global) ui.global.classList.add('hidden');
        setStatus('页面已切换，点击“开始分析”');
      }
    }
  }, 1500);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('AI 视频总结：开始/停止', () => startFlow(false));
    GM_registerMenuCommand('AI 视频总结：显示面板', () => ui.panel?.classList.remove('hidden'));
  }

  boot();
})();
