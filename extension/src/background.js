/**
 * MV3 service worker：
 *  - 代理跨域网络请求（平台字幕接口、后端 API）
 *  - 管理 offscreen 文档做 tabCapture 音频采集与实时 ASR
 *  - 点击工具栏图标打开侧边栏
 */

let creatingOffscreen = null;

// 点击图标即打开侧边栏
function enableActionOpenPanel() {
  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});
  } catch {}
}
chrome.runtime.onInstalled.addListener(enableActionOpenPanel);
enableActionOpenPanel();

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'src/offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: '采集当前标签页音频以进行实时语音转写，并回放标签页声音',
    })
    .catch((e) => {
      if (!String(e).includes('Only a single offscreen')) throw e;
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  return creatingOffscreen;
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function proxyFetch({ url, method = 'GET', headers, body, credentials = 'omit', responseType }) {
  try {
    const res = await fetch(url, { method, headers, body, credentials });
    const text = await res.text();
    return { status: res.status, text, responseType };
  } catch (e) {
    return { status: 0, text: '', error: String(e) };
  }
}

/** 广播到所有扩展页面（侧边栏监听） */
function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'bgFetch':
          sendResponse(await proxyFetch(msg));
          return;

        case 'ASR_START': {
          const tabId = msg.tabId ?? sender.tab?.id;
          if (tabId == null) throw new Error('无法确定标签页');
          await ensureOffscreen();
          const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
          await chrome.runtime.sendMessage({
            type: 'OFFSCREEN_START',
            streamId,
            tabId,
            backend: msg.backend,
            session: msg.session,
            lang: msg.lang,
            baseTime: msg.baseTime || 0,
          });
          sendResponse({ ok: true });
          return;
        }

        case 'ASR_STOP':
          await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
          await closeOffscreen();
          sendResponse({ ok: true });
          return;

        // offscreen -> 广播给侧边栏
        case 'ASR_SEGMENT':
        case 'ASR_WARN':
        case 'ASR_ERROR':
        case 'ASR_STOPPED':
          broadcast(msg);
          sendResponse({ ok: true });
          return;

        default:
          sendResponse({ ok: false, error: 'unknown message ' + msg?.type });
      }
    } catch (e) {
      sendResponse({ status: 0, error: String(e?.message || e) });
    }
  })();
  return true;
});
