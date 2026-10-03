/** 侧边栏主控：编排字幕抓取 / 纠错 / 总结 / ASR / 问答，负责全部 UI 渲染 */

const $ = (s) => document.querySelector(s);
const DEFAULT_BACKEND = 'http://127.0.0.1:8787';

/* ============================ 配置 ============================ */
const conf = { backend: DEFAULT_BACKEND, lang: 'auto', autoCorrect: true, autoStart: false };
async function loadConf() {
  const o = await chrome.storage.local.get('config');
  Object.assign(conf, o.config || {});
  conf.backend = (conf.backend || DEFAULT_BACKEND).replace(/\/+$/, '');
}
const saveConf = () => chrome.storage.local.set({ config: { ...conf } });
const base = () => conf.backend.replace(/\/+$/, '');

/* ============================ 网络 ============================ */
async function bg(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    throw new Error(e?.message || '扩展后台无响应');
  }
}
async function bgFetch(opts) {
  const r = await bg({ type: 'bgFetch', ...opts });
  if (r?.error) throw new Error(r.error);
  return r;
}
const errText = (r) => {
  try {
    return JSON.parse(r.text)?.error || (r.text || '').slice(0, 200) || 'HTTP ' + r.status;
  } catch {
    return (r.text || '').slice(0, 200) || 'HTTP ' + r.status;
  }
};
async function apiPost(path, body) {
  const r = await bgFetch({
    url: base() + path,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status >= 400) throw new Error(errText(r));
  return JSON.parse(r.text || '{}');
}
async function apiGet(path) {
  const r = await bgFetch({ url: base() + path });
  if (r.status >= 400) throw new Error(errText(r));
  return JSON.parse(r.text || '{}');
}

/* ============================ 状态 ============================ */
const state = {
  tabId: null,
  info: null,
  subtitles: [],
  chunks: [],
  global: null,
  sessionId: null,
  mode: null,
  busy: false,
  asr: { running: false, baseTime: 0, pending: [] },
  activeTabView: 'timeline',
  search: '',
  currentTime: 0,
};

/* ============================ 工具 ============================ */
const fmt = (t) => {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};
const parseTime = (str) => {
  const p = String(str).split(':').map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
};
function groupByChars(segs, max) {
  const groups = [];
  let cur = [], len = 0;
  for (const s of segs) {
    if (cur.length && len + s.text.length > max) {
      groups.push(cur); cur = []; len = 0;
    }
    cur.push(s); len += s.text.length;
  }
  if (cur.length) groups.push(cur);
  return groups;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setStatus(text, kind = '') {
  $('#statusText').textContent = text;
  const dot = $('#statusDot');
  dot.className = 'dot' + (kind ? ' ' + kind : '');
}
function setProgress(p) {
  if (p == null) {
    $('#progressWrap').hidden = true;
    return;
  }
  $('#progressWrap').hidden = false;
  $('#progressBar').style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
  if (p >= 1) setTimeout(() => ($('#progressWrap').hidden = true), 600);
}
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ============================ 与页面通信 ============================ */
async function contentMsg(msg) {
  if (state.tabId == null) throw new Error('未找到标签页');
  try {
    return await chrome.tabs.sendMessage(state.tabId, msg);
  } catch (e) {
    throw new Error('当前页面无法通信（请打开 B站/YouTube 视频页并刷新）');
  }
}

/* ============================ 初始化 ============================ */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshPage() {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  const changed = tab.id !== state.tabId;
  state.tabId = tab.id;
  try {
    const info = await chrome.tabs.sendMessage(tab.id, { type: 'VS_INFO' });
    if (!info?.ok || !info.site) {
      renderNoVideo();
      return;
    }
    const pageChanged = changed || state.info?.url !== info.url;
    state.info = info;
    renderHeader();
    if (pageChanged && state.mode) resetAnalysis();
    if (pageChanged && conf.autoStart) startFlow();
  } catch {
    renderNoVideo();
  }
}

function renderNoVideo() {
  state.info = null;
  $('#videoTitle').textContent = '等待视频…';
  $('#pageBadge').className = 'page-badge';
  setStatus('当前标签页不是 B站 / YouTube 视频页', 'err');
}

function renderHeader() {
  if (!state.info) return;
  $('#videoTitle').textContent = state.info.title || state.info.url;
  $('#videoTitle').title = state.info.url || '';
  const badge = $('#pageBadge');
  badge.className = 'page-badge show';
  badge.innerHTML = `<span class="pill">${state.info.site === 'bilibili' ? '哔哩哔哩' : 'YouTube'}</span><span class="pill">${esc(state.info.key || '')}</span>`;
}

function resetAnalysis() {
  state.subtitles = []; state.chunks = []; state.global = null; state.sessionId = null;
  state.mode = null; state.asr.pending = []; state.search = '';
  $('#subtitleList').innerHTML = ''; $('#timeline').innerHTML = ''; $('#moments').innerHTML = '';
  $('#keyPoints').innerHTML = ''; $('#questionList').innerHTML = '';
  $('#overviewCard').hidden = true; $('#momentsCard').hidden = true;
  $('#timelineEmpty').style.display = ''; $('#subtitleEmpty').style.display = '';
  $('#chatList').innerHTML = '<div class="empty"><div class="empty-emoji">🤖</div><p>基于已获取的字幕内容提问。</p></div>';
  $('#questionsEmpty').style.display = '';
}

/* ============================ 主流程 ============================ */
async function startFlow(forceAsr = false) {
  if (state.busy || state.asr.running) return;
  if (!state.info) {
    await refreshPage();
    if (!state.info) return toast('不是视频页面');
  }
  state.busy = true;
  $('#startBtn').disabled = true;
  try {
    resetAnalysis();
    if (!forceAsr) {
      setStatus('正在读取字幕…', 'busy');
      setProgress(null);
      let res = null;
      try {
        res = await contentMsg({ type: 'VS_SUBTITLES' });
        if (!res?.ok) res = null;
      } catch {}
      // 页面取不到时，回退到服务端抓取
      if (!res) {
        try {
          const d = await apiGet('/api/subtitle?url=' + encodeURIComponent(state.info.url));
          if (d?.segments?.length) res = { ...d, title: state.info.title };
        } catch {}
      }
      if (res?.segments?.length) {
        state.info.title = res.title || state.info.title;
        await runSubtitleFlow(res);
        return;
      }
      setStatus('未找到字幕，正在切换实时识别…', '');
      toast('无字幕，改用实时识别');
    }
    await startAsr();
  } finally {
    state.busy = false;
    $('#startBtn').disabled = false;
  }
}

async function runSubtitleFlow(res) {
  state.mode = 'cc';
  let segs = res.segments;
  const badge = $('#pageBadge');
  badge.innerHTML = `<span class="pill">${state.info.site === 'bilibili' ? '哔哩哔哩' : 'YouTube'}</span>` +
    `<span class="pill">${esc(state.info.key || '')}</span>` +
    `<span class="pill">${segs.length} 条字幕</span>` +
    (res.aiGenerated ? `<span class="pill ai">AI 字幕 · 已纠错</span>` : `<span class="pill">人工字幕</span>`);

  const needCorrect = conf.autoCorrect && res.aiGenerated;
  if (needCorrect) {
    const groups = groupByChars(segs, 2600);
    const out = [];
    for (let i = 0; i < groups.length; i++) {
      setStatus(`正在纠错字幕 ${i + 1}/${groups.length}…`, 'busy');
      setProgress(i / groups.length);
      try {
        const r = await apiPost('/api/correct', { segments: groups[i], lang: conf.lang, domain: domainKey() });
        out.push(...r.segments);
      } catch {
        out.push(...groups[i]);
      }
    }
    segs = out;
    setProgress(1);
  }

  state.subtitles = segs;
  renderSubtitles();

  const { sessionId } = await apiPost('/api/session', { domain: domainKey(), lang: conf.lang, title: state.info.title });
  state.sessionId = sessionId;

  const groups = groupByChars(segs, 1800);
  for (let i = 0; i < groups.length; i++) {
    setStatus(`正在生成总结 ${i + 1}/${groups.length}…`, 'busy');
    setProgress(i / groups.length);
    try {
      const r = await apiPost('/api/summarize', {
        sessionId, segments: groups[i], lang: conf.lang, domain: domainKey(), force: true,
      });
      if (r.chunks?.length) state.chunks.push(...r.chunks);
      if (r.global) state.global = r.global;
      renderTimeline();
      renderGlobal();
    } catch (e) {
      setStatus('总结失败：' + e.message, 'err');
      return;
    }
  }
  try {
    const r = await apiPost('/api/summarize', { sessionId, lang: conf.lang, final: true });
    if (r.global) state.global = r.global;
    renderGlobal();
  } catch {}

  setProgress(1);
  setStatus(`完成 · ${segs.length} 条字幕 · ${state.chunks.length} 个片段`, '');
  switchTab('timeline');
}

const domainKey = () => `${state.info?.site}:${state.info?.key}`;

/* ============================ ASR ============================ */
async function startAsr() {
  if (state.asr.running) return;
  const st = await contentMsg({ type: 'VS_STATUS' }).catch(() => ({ currentTime: 0 }));
  state.asr.baseTime = st.currentTime || 0;
  state.asr.pending = [];
  state.mode = 'asr';
  $('#asrBtn').textContent = '停止识别';
  $('#asrBtn').classList.add('stop');
  $('#asrBtn').classList.remove('ghost');
  setStatus('正在开始采集标签页音频…', 'busy');
  try {
    const { sessionId } = await apiPost('/api/session', { domain: domainKey(), lang: conf.lang, title: state.info.title });
    state.sessionId = sessionId;
    const r = await bg({
      type: 'ASR_START', tabId: state.tabId, backend: base(), session: domainKey(),
      lang: conf.lang, baseTime: state.asr.baseTime,
    });
    if (r?.error) throw new Error(r.error);
    state.asr.running = true;
    setStatus('实时识别中…（保持播放，可切到后台）', 'live');
    switchTab('subtitle');
  } catch (e) {
    resetAsrButtons();
    setStatus('采集失败：' + e.message + '（可点工具栏图标重试）', 'err');
  }
}

async function stopAsr() {
  if (!state.asr.running) return;
  state.asr.running = false;
  resetAsrButtons();
  try { await bg({ type: 'ASR_STOP' }); } catch {}
  await flushAsr(true).catch(() => {});
  setStatus('已停止识别', '');
}
function resetAsrButtons() {
  $('#asrBtn').textContent = '实时识别';
  $('#asrBtn').classList.remove('stop');
  $('#asrBtn').classList.add('ghost');
}

function onAsrSegment(seg) {
  if (!state.asr.running) return;
  state.subtitles.push(seg);
  state.asr.pending.push(seg);
  appendSubtitleLine(seg);
  const chars = state.asr.pending.reduce((n, s) => n + s.text.length, 0);
  if (chars >= 1200) flushAsr(false).catch(() => {});
}

async function flushAsr(final) {
  const p = state.asr.pending;
  if (!p.length) {
    if (final && state.sessionId) {
      try {
        const r = await apiPost('/api/summarize', { sessionId: state.sessionId, lang: conf.lang, final: true });
        if (r.global) { state.global = r.global; renderGlobal(); }
      } catch {}
    }
    return;
  }
  const batch = p;
  state.asr.pending = [];
  let segs = batch;
  if (conf.autoCorrect) {
    try {
      const r = await apiPost('/api/correct', { segments: batch, lang: conf.lang, domain: domainKey(), force: true });
      segs = r.segments;
      const startIdx = state.subtitles.length - batch.length;
      state.subtitles.splice(startIdx, batch.length, ...segs);
    } catch {}
  }
  try {
    const r = await apiPost('/api/summarize', {
      sessionId: state.sessionId, segments: segs, lang: conf.lang, domain: domainKey(), force: true, final,
    });
    if (r.chunks?.length) state.chunks.push(...r.chunks);
    if (r.global) state.global = r.global;
    renderTimeline();
    renderGlobal();
    if (state.asr.running) setStatus('实时识别中…', 'live');
  } catch (e) {
    setStatus('总结失败：' + e.message, 'err');
  }
}

/* ============================ 渲染 ============================ */
function renderGlobal() {
  const g = state.global;
  if (!g) return;
  if (g.overview) {
    $('#overviewCard').hidden = false;
    $('#overviewText').textContent = g.overview;
  }
  const kp = $('#keyPoints');
  kp.innerHTML = '';
  for (const k of g.keyPoints ?? []) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = k;
    kp.appendChild(c);
  }

  const moments = g.moments ?? [];
  const mc = $('#momentsCard');
  if (moments.length) {
    mc.hidden = false;
    $('#moments').innerHTML = '';
    for (const m of moments) {
      const el = document.createElement('div');
      el.className = 'moment';
      el.innerHTML = `<span class="emoji">${esc(m.emoji)}</span><span class="time">${esc(m.time)}</span><span class="m-title">${esc(m.title)}</span>`;
      el.onclick = () => seek(parseTime(m.time));
      $('#moments').appendChild(el);
    }
  }

  const q = g.openQuestions ?? [];
  $('#questionsEmpty').style.display = q.length ? 'none' : '';
  $('#questionList').innerHTML = q.map((x) => `<li>${esc(x)}</li>`).join('');
}

function renderTimeline() {
  if (!state.chunks.length) return;
  $('#timelineEmpty').style.display = 'none';
  const tl = $('#timeline');
  tl.innerHTML = '';
  state.chunks.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'tl-item';
    el.dataset.start = c.start;
    el.dataset.end = c.end;
    el.innerHTML =
      `<div class="tl-head"><span class="tl-emoji">${esc(c.emoji || '•')}</span><span class="tl-time">${fmt(c.start)}</span><span class="tl-title">${esc(c.title)}</span></div>` +
      (c.bullets?.length ? `<ul class="tl-bullets">${c.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '');
    el.onclick = () => seek(c.start);
    tl.appendChild(el);
  });
  updateActive();
}

function renderSubtitles() {
  $('#subtitleEmpty').style.display = state.subtitles.length ? 'none' : '';
  const list = $('#subtitleList');
  list.innerHTML = '';
  const q = state.search.trim().toLowerCase();
  for (const s of state.subtitles) {
    if (q && !s.text.toLowerCase().includes(q)) continue;
    list.appendChild(subLine(s));
  }
  updateActive();
}
function subLine(s) {
  const el = document.createElement('div');
  el.className = 'sub-line';
  el.dataset.start = s.start;
  el.dataset.end = s.end;
  el.innerHTML = `<span class="sub-time">${fmt(s.start)}</span><span class="sub-text">${esc(s.text)}</span>`;
  el.onclick = () => seek(s.start);
  return el;
}
function appendSubtitleLine(s) {
  const list = $('#subtitleList');
  $('#subtitleEmpty').style.display = 'none';
  list.appendChild(subLine(s));
  list.scrollTop = list.scrollHeight;
  $('#subtitleList').parentElement.scrollTop = $('#subtitleList').parentElement.scrollHeight;
}

function updateActive() {
  const t = state.currentTime;
  for (const el of $('#timeline').children) {
    el.classList.toggle('active', t >= +el.dataset.start && t < +el.dataset.end);
  }
  let activeSub = null;
  for (const el of $('#subtitleList').children) {
    const on = t >= +el.dataset.start && t < +el.dataset.end;
    el.classList.toggle('active', on);
    if (on) activeSub = el;
  }
  if (activeSub && !state.search) {
    const cont = $('#subtitleList').parentElement;
    const r = activeSub.getBoundingClientRect();
    const cr = cont.getBoundingClientRect();
    if (r.top < cr.top || r.bottom > cr.bottom) activeSub.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* ============================ 交互 ============================ */
function switchTab(name) {
  state.activeTabView = name;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== 'panel-' + name;
}
async function seek(t) {
  try {
    await contentMsg({ type: 'VS_SEEK', time: t });
  } catch (e) {
    toast(e.message);
  }
}

async function ask() {
  const input = $('#chatInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  addChat('user', q);
  const thinking = addChat('ai', '思考中…', true);
  try {
    const r = await apiPost('/api/chat', {
      sessionId: state.sessionId,
      question: q,
      segments: state.sessionId ? undefined : state.subtitles,
    });
    thinking.textContent = r.answer || '（无回答）';
    thinking.classList.remove('thinking');
  } catch (e) {
    thinking.textContent = '出错：' + e.message;
    thinking.classList.remove('thinking');
  }
}
function addChat(role, text, thinking = false) {
  const list = $('#chatList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'msg ' + role + (thinking ? ' thinking' : '');
  el.textContent = text;
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
  return el;
}

/* ============================ 设置 ============================ */
function openSettings(open) {
  $('#settingsDrawer').hidden = !open;
  if (open) checkHealth();
}
async function checkHealth() {
  const h = $('#health');
  h.textContent = '检测服务中…';
  h.className = 'health';
  try {
    const d = await apiGet('/api/health');
    h.className = 'health ' + (d.llm ? 'ok' : 'bad');
    h.textContent = d.llm
      ? `服务正常 · 模型 ${d.llmModel} · ASR ${d.asrProvider}`
      : '服务可达，但未配置 LLM_API_KEY';
  } catch (e) {
    h.className = 'health bad';
    h.textContent = '无法连接后端：' + e.message;
  }
}
function fillSettings() {
  $('#cfgBackend').value = conf.backend;
  $('#cfgLang').value = conf.lang;
  $('#cfgCorrect').checked = conf.autoCorrect;
  $('#cfgAutoStart').checked = conf.autoStart;
}
function readSettings() {
  conf.backend = ($('#cfgBackend').value.trim() || DEFAULT_BACKEND).replace(/\/+$/, '');
  conf.lang = $('#cfgLang').value;
  conf.autoCorrect = $('#cfgCorrect').checked;
  conf.autoStart = $('#cfgAutoStart').checked;
  saveConf();
}

/* ============================ 事件 ============================ */
function bind() {
  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t) switchTab(t.dataset.tab);
  });
  $('#startBtn').onclick = () => startFlow(false);
  $('#asrBtn').onclick = () => (state.asr.running ? stopAsr() : startFlow(true));
  $('#settingsBtn').onclick = () => openSettings(true);
  $('#settingsClose').onclick = () => openSettings(false);
  $('#saveSettings').onclick = () => { readSettings(); openSettings(false); toast('设置已保存'); checkHealth(); };
  $('#chatSend').onclick = ask;
  $('#chatInput').addEventListener('keydown', (e) => e.key === 'Enter' && ask());
  $('#searchInput').addEventListener('input', (e) => { state.search = e.target.value; renderSubtitles(); });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.tabId != null && state.tabId != null && msg.tabId !== state.tabId) return;
    if (msg?.type === 'ASR_SEGMENT' && msg.segment) onAsrSegment(msg.segment);
    else if (msg?.type === 'ASR_WARN') setStatus(msg.message || '未检测到声音', '');
    else if (msg?.type === 'ASR_ERROR') {
      state.asr.running = false;
      resetAsrButtons();
      setStatus('ASR 错误：' + msg.message, 'err');
    } else if (msg?.type === 'VS_CONTENT_CHANGED') {
      refreshPage();
    }
  });

  // 轮询进度高亮 + 标签页切换
  setInterval(async () => {
    if (!state.info) return;
    try {
      const st = await contentMsg({ type: 'VS_STATUS' });
      if (st?.ok) {
        state.currentTime = st.currentTime;
        updateActive();
      }
    } catch {}
  }, 1000);

  setInterval(refreshPage, 1500);
  chrome.tabs.onActivated.addListener(refreshPage);
}

/* ============================ 启动 ============================ */
(async () => {
  await loadConf();
  fillSettings();
  bind();
  await refreshPage();
  checkHealth();
})();
