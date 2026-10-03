/**
 * 内容脚本（页面桥）：
 *  - 在页面上下文用 credentials 请求 B站 / YouTube 字幕
 *  - 提供视频信息、跳转、当前进度
 * 侧边栏通过 chrome.tabs.sendMessage 调用这些能力。
 */
(function () {
  'use strict';

  const detectSite = () => {
    const h = location.hostname;
    if (/bilibili\.com$/.test(h)) return 'bilibili';
    if (/youtube\.com$/.test(h)) return 'youtube';
    return null;
  };

  function videoKey() {
    const site = detectSite();
    if (site === 'bilibili') {
      const bv = location.pathname.match(/(BV[0-9A-Za-z]{10})/)?.[1] || new URLSearchParams(location.search).get('bvid');
      if (bv) return bv;
      const ep = location.pathname.match(/\/ep(\d+)/)?.[1] || new URLSearchParams(location.search).get('ep_id');
      if (ep) return 'ep' + ep;
      const av = location.pathname.match(/\/av(\d+)/i)?.[1];
      if (av) return 'av' + av;
    }
    if (site === 'youtube') {
      return location.search.match(/[?&]v=([0-9A-Za-z_-]{11})/)?.[1] || location.pathname.split('/').pop();
    }
    return 'unknown';
  }

  function getVideo() {
    const vids = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0);
    if (!vids.length) return document.querySelector('video');
    return vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  }

  const jsonFetch = async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };

  async function biliResolve() {
    const pathKey = videoKey();
    if (/^av\d+$/i.test(pathKey)) {
      const aid = pathKey.slice(2);
      const pages = await jsonFetch(`https://api.bilibili.com/x/player/pagelist?aid=${aid}`);
      const p = pages?.data?.[0];
      return { aid, cid: p?.cid, title: p?.part };
    }
    if (/^BV/.test(pathKey)) {
      const view = await jsonFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${pathKey}`);
      if (view.code !== 0) throw new Error(view.message || 'B站接口错误');
      const p = Number(new URLSearchParams(location.search).get('p') || 1);
      const pages = view.data.pages || [];
      const cid = (pages[p - 1] || pages[0])?.cid ?? view.data.cid;
      return { aid: view.data.aid, cid, title: view.data.title, bvid: pathKey };
    }
    // 番剧
    const epId = location.pathname.match(/\/ep(\d+)/)?.[1] || new URLSearchParams(location.search).get('ep_id');
    const ssId = location.pathname.match(/\/ss(\d+)/)?.[1];
    const q = epId ? `ep_id=${epId}` : `season_id=${ssId}`;
    const data = await jsonFetch(`https://api.bilibili.com/pgc/view/web/season?${q}`);
    const result = data.result ?? data.data?.result;
    if (!result) throw new Error('番剧接口无数据');
    const eps = result.episodes || [];
    const target = (epId ? eps.find((e) => String(e.id) === String(epId) || String(e.ep_id) === String(epId)) : eps[0]) || eps[0];
    if (!target) throw new Error('未找到剧集');
    return { aid: target.aid, cid: target.cid, title: result.title, bvid: target.bvid };
  }

  async function biliPlayerData(aid, cid) {
    for (const api of ['x/player/wbi/v2', 'x/player/v2']) {
      try {
        const json = await jsonFetch(`https://api.bilibili.com/${api}?aid=${aid}&cid=${cid}`);
        if (json?.code === 0) return json.data;
      } catch {}
    }
    return null;
  }

  async function getBilibiliSubtitles() {
    const { aid, cid, title, bvid } = await biliResolve();
    const data = await biliPlayerData(aid, cid);
    const subs = (data?.subtitle?.subtitles ?? []).filter((s) => s.subtitle_url);
    if (!subs.length) throw new Error('该视频没有可用字幕（UP 未上传或未登录）');
    const pick =
      subs.find((s) => /^zh/i.test(s.lan) && !s.ai_type) ||
      subs.find((s) => /^zh/i.test(s.lan)) ||
      subs.find((s) => /^en/i.test(s.lan)) ||
      subs[0];
    let url = pick.subtitle_url.startsWith('//') ? 'https:' + pick.subtitle_url : pick.subtitle_url;
    url = url.replace(/^http:\/\//, 'https://');
    const json = await jsonFetch(url);
    const segments = (json.body ?? []).map((b) => ({
      start: +b.from || 0,
      end: +b.to || 0,
      text: String(b.content ?? '').trim(),
      source: pick.ai_type ? 'auto-cc' : 'official',
      lang: pick.lan,
    }));
    if (!segments.length) throw new Error('字幕内容为空');
    return { segments, title: title || document.title, aiGenerated: !!pick.ai_type, lang: pick.lan, bvid };
  }

  function getYtPlayerResponse() {
    for (const s of document.scripts) {
      const t = s.textContent;
      if (!t || t.indexOf('ytInitialPlayerResponse') === -1) continue;
      const m = t.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch {}
      }
    }
    return null;
  }

  const bg = (msg) => chrome.runtime.sendMessage(msg);

  function parseYouTubeJson3(json) {
    const out = [];
    for (const ev of json?.events ?? []) {
      const text = (ev.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/\n/g, ' ').trim();
      if (!text) continue;
      const start = (ev.tStartMs ?? 0) / 1000;
      out.push({ start, end: start + (ev.dDurationMs ?? 0) / 1000, text, source: '' });
    }
    // 合并相邻行
    const merged = [];
    for (const s of out) {
      const p = merged[merged.length - 1];
      if (p && s.start - p.end < 0.35 && p.text.length < 60) {
        p.text = (p.text + ' ' + s.text).trim();
        p.end = s.end;
      } else merged.push({ ...s });
    }
    return merged;
  }

  async function getYouTubeSubtitles() {
    let pr = getYtPlayerResponse();
    let tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!tracks.length) {
      try {
        const r = await bg({ type: 'bgFetch', url: `https://www.youtube.com/watch?v=${videoKey()}`, credentials: 'include' });
        const m = (r?.text || '').match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
        if (m) {
          pr = JSON.parse(m[1]);
          tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
        }
      } catch {}
    }
    if (!tracks.length) throw new Error('该视频没有可用字幕');
    const pick =
      tracks.find((t) => /^(zh|en)/i.test(t.languageCode) && t.kind !== 'asr') ||
      tracks.find((t) => t.kind !== 'asr') ||
      tracks.find((t) => /^zh/i.test(t.languageCode)) ||
      tracks[0];
    const url = pick.baseUrl + (pick.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    const r = await bg({ type: 'bgFetch', url });
    if (!r || r.status >= 400 || r.error) throw new Error('字幕下载失败');
    const segments = parseYouTubeJson3(JSON.parse(r.text)).map((s) => ({
      ...s,
      source: pick.kind === 'asr' ? 'auto-cc' : 'official',
    }));
    if (!segments.length) throw new Error('字幕内容为空');
    return {
      segments,
      title: pr?.videoDetails?.title || document.title,
      aiGenerated: pick.kind === 'asr',
      lang: pick.languageCode,
    };
  }

  /* ------------------ 消息处理 ------------------ */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.type) {
          case 'VS_PING':
            sendResponse({ ok: true, site: detectSite(), key: videoKey(), url: location.href });
            break;
          case 'VS_INFO':
            sendResponse({
              ok: true,
              site: detectSite(),
              key: videoKey(),
              url: location.href,
              title: document.title.replace(/\s*[-_|]\s*(哔哩哔哩|bilibili|YouTube).*$/i, '').trim(),
            });
            break;
          case 'VS_SUBTITLES': {
            const site = detectSite();
            const data = site === 'bilibili' ? await getBilibiliSubtitles() : await getYouTubeSubtitles();
            sendResponse({ ok: true, ...data, site });
            break;
          }
          case 'VS_STATUS': {
            const v = getVideo();
            sendResponse({ ok: true, currentTime: v?.currentTime ?? 0, duration: v?.duration ?? 0, paused: v?.paused ?? true });
            break;
          }
          case 'VS_SEEK': {
            const v = getVideo();
            if (v) {
              v.currentTime = Math.max(0, Number(msg.time) || 0);
              if (v.paused) v.play().catch(() => {});
            }
            sendResponse({ ok: !!v });
            break;
          }
          default:
            sendResponse({ ok: false, error: 'unknown ' + msg?.type });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  });

  // SPA 切换通知侧边栏
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      chrome.runtime.sendMessage({ type: 'VS_CONTENT_CHANGED', url: location.href, key: videoKey(), site: detectSite() }).catch(() => {});
    }
  }, 1200);
})();
