/**
 * 服务端字幕抓取与解析（可选加速路径）。
 * 浏览器端用户脚本优先从页面直接取字幕；当用户脚本取不到时，可回退到本服务。
 * 注意：
 *  - B站 player/v2 对部分视频需要登录 Cookie，无 Cookie 时可能拿不到字幕列表。
 *  - YouTube 需要服务器能访问 youtube.com（国内服务器通常不可达）。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': UA, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res;
}

/** @returns {Array<{start:number,end:number,text:string,source:string,lang?:string}>} */
export function parseBilibiliSubtitle(json) {
  const body = json?.body ?? [];
  return body.map((b) => ({
    start: Number(b.from) || 0,
    end: Number(b.to) || 0,
    text: String(b.content ?? '').trim(),
    source: 'official',
  }));
}

/** YouTube json3 字幕 */
export function parseYouTubeJson3(json) {
  const events = json?.events ?? [];
  const out = [];
  for (const ev of events) {
    const text = (ev.segs ?? [])
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\n/g, ' ')
      .trim();
    if (!text) continue;
    const start = (ev.tStartMs ?? 0) / 1000;
    const dur = (ev.dDurationMs ?? 0) / 1000;
    out.push({ start, end: start + dur, text, source: 'official' });
  }
  return mergeAdjacent(out);
}

/** WebVTT / SRT 通用解析 */
export function parseVtt(vtt) {
  const out = [];
  const blocks = vtt.replace(/\r/g, '').split('\n\n');
  const t = (s) => {
    const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
    if (!m) return 0;
    const [, h = '0', mm, ss, ms] = m;
    return Number(h) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
  };
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l && !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()));
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [a, b] = timeLine.split('-->');
    const text = lines
      .filter((l) => l !== timeLine)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text) out.push({ start: t(a), end: t(b), text, source: 'official' });
  }
  return mergeAdjacent(out);
}

function mergeAdjacent(segs) {
  const out = [];
  for (const s of segs) {
    const prev = out.at(-1);
    if (prev && s.start - prev.end < 0.35 && prev.text.length < 60) {
      prev.text = `${prev.text} ${s.text}`.trim();
      prev.end = s.end;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function extractBvid(url) {
  const m = url.match(/(BV[0-9A-Za-z]{10})/);
  return m?.[1] ?? null;
}

async function fetchBilibiliPlayer(aid, cid) {
  // 新版 wbi 接口优先，旧接口兜底
  for (const api of ['x/player/wbi/v2', 'x/player/v2']) {
    try {
      const res = await get(`https://api.bilibili.com/${api}?aid=${aid}&cid=${cid}`);
      const json = await res.json();
      if (json?.code === 0) return json.data;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function fetchBilibili(bvid) {
  const viewRes = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const view = await viewRes.json();
  if (view.code !== 0) throw new Error(`B站 view 接口: ${view.message}`);
  const { aid, cid } = view.data;
  const data = await fetchBilibiliPlayer(aid, cid);
  const subs = (data?.subtitle?.subtitles ?? []).filter((s) => s.subtitle_url);
  if (!subs.length) throw new Error('该视频没有可用字幕（可能需要登录 Cookie 或 UP 未上传）');
  // 优先中文人工字幕，其次中文，再任意
  const track =
    subs.find((s) => /zh/i.test(s.lan) && !s.ai_type) ??
    subs.find((s) => /zh/i.test(s.lan)) ??
    subs[0];
  let subUrl = track.subtitle_url.startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url;
  subUrl = subUrl.replace(/^http:\/\//, 'https://');
  const subRes = await get(subUrl);
  const json = await subRes.json();
  const segments = parseBilibiliSubtitle(json).map((s) => ({
    ...s,
    source: track.ai_type ? 'auto-cc' : 'official',
    lang: track.lan,
  }));
  return { segments, lang: track.lan, aiGenerated: Boolean(track.ai_type) };
}

function extractYouTubeId(url) {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([0-9A-Za-z_-]{11})/,
  );
  return m?.[1] ?? null;
}

async function fetchYouTube(videoId) {
  const res = await get(`https://www.youtube.com/watch?v=${videoId}`);
  const html = await res.text();
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
  if (!m) throw new Error('无法解析 ytInitialPlayerResponse');
  const pr = JSON.parse(m[1]);
  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) throw new Error('该视频没有可用字幕');
  const track =
    tracks.find((t) => t.kind !== 'asr' && /en|zh/i.test(t.languageCode)) ??
    tracks.find((t) => t.kind !== 'asr') ??
    tracks[0];
  const url = `${track.baseUrl}${track.baseUrl.includes('?') ? '&' : '?'}fmt=json3`;
  const subRes = await get(url);
  const json = await subRes.json();
  const segments = parseYouTubeJson3(json).map((s) => ({
    ...s,
    source: track.kind === 'asr' ? 'auto-cc' : 'official',
    lang: track.languageCode,
  }));
  return { segments, lang: track.languageCode, aiGenerated: track.kind === 'asr' };
}

/**
 * 根据视频页面 URL 抓取字幕。
 * @param {string} pageUrl
 */
export async function fetchSubtitles(pageUrl) {
  const bvid = extractBvid(pageUrl);
  if (bvid) {
    const r = await fetchBilibili(bvid);
    return { platform: 'bilibili', bvid, ...r };
  }
  const yt = extractYouTubeId(pageUrl);
  if (yt) {
    const r = await fetchYouTube(yt);
    return { platform: 'youtube', videoId: yt, ...r };
  }
  throw new Error('无法识别的视频链接（仅支持 B站 / YouTube）');
}
