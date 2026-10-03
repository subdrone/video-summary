# video-summary · AI 视频实时总结

在 B站 / YouTube 观看视频时，用 **浏览器侧边栏** 实时生成内容总结。

- **有字幕就抓字幕**：人工字幕直接用；平台的 **AI 自动字幕** 会先过一遍 LLM 纠错。
- **没字幕就听音频**：扩展用 `tabCapture` 采集标签页音频 → 服务端 ASR（Whisper）→ 实时转写。
- **滚动总结**：每段小结（带 emoji）+ 全局总览 + **时间戳关键节点**，全部可点击跳转。
- **随时提问**：基于字幕内容问答，答案可带时间依据。
- **越用越准**：纠错时自动积累术语表（同音字/专名误识别 → 标准写法），持久化复用。

```
浏览器侧边栏(扩展)                        本地服务(Node)
 ┌──────────────────┐  bgFetch 代理跨域   ┌──────────────────────────┐
 │ 字幕抓取 / tabCapture│ ─────────────────▶ │ 纠错 → 分块总结 → 全局总览  │
 │ 总览/时间轴/问答 UI │ ◀───────────────── │ LLM API / Whisper API/本地 │
 └──────────────────┘      JSON / 流式      └──────────────────────────┘
```

---

## 一、快速开始

### 1. 启动后端

```bash
cd video-summary
npm install

# 最小配置：一个 OpenAI 兼容的 LLM
export LLM_BASE_URL="https://api.openai.com/v1"   # 或 DeepSeek/通义/本地 Ollama 等
export LLM_API_KEY="sk-..."
export LLM_MODEL="gpt-4o-mini"

# ASR（没有字幕的视频才需要）
export ASR_PROVIDER="openai"                       # openai | local | mock
export ASR_API_KEY="sk-..."                        # 默认复用 LLM_API_KEY
export ASR_MODEL="whisper-1"

npm start
```

启动后：

- 控制台：<http://localhost:8787/public/>（调试字幕抓取、总结、麦克风 ASR）
- 用户脚本：<http://localhost:8787/userscript/video-summary.user.js>

### 2. 安装浏览器扩展（推荐）

Chrome / Edge 直接加载 `extension/` 目录，无需油猴：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角 **开发者模式**。
2. 点 **加载已解压的扩展程序**，选择本项目里的 `extension/` 文件夹。
3. 打开任意 B站 / YouTube 视频页，**点击工具栏的扩展图标打开侧边栏**，点 **开始分析**。

侧边栏有三个标签页：

| 标签 | 内容 |
| --- | --- |
| **时间轴** | 按时间排列的片段小结，点击跳转，播放时自动高亮当前片段 |
| **字幕** | 完整字幕，支持搜索、点击跳转、跟随播放高亮 |
| **问答** | 基于字幕内容的对话 |
| **待解问题** | 视频中提出但未解答的问题 |

顶部的 **关键节点** 会给出带时间戳的精彩片段，一键跳转。

> ⚠️ 若用 OpenAI 官方接口，浏览器所在网络需能访问 `api.openai.com`；否则把后端部署到能访问的机器上，并在侧边栏设置里把“后端地址”改成那台机器。

<details>
<summary>可选：油猴脚本（不想装扩展时）</summary>

1. 浏览器装 **Tampermonkey**。
2. 打开 <http://localhost:8787/userscript/video-summary.user.js> 安装（或新建脚本粘贴 `userscript/video-summary.user.js`）。
3. 无字幕时脚本用 `getDisplayMedia` 共享标签页音频；扩展则用 tabCapture，更省心。

</details>

---

## 二、配置项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 服务监听地址 |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容接口，需带 `/v1` |
| `LLM_API_KEY` | – | LLM 密钥（必填） |
| `LLM_MODEL` | `gpt-4o-mini` | 总结用模型 |
| `LLM_CORRECT_MODEL` | =`LLM_MODEL` | 纠错用模型（可用更便宜的） |
| `ASR_PROVIDER` | `mock` | `openai` / `local` / `mock` |
| `ASR_BASE_URL` | =`LLM_BASE_URL` | 兼容 OpenAI 的 `/audio/transcriptions` |
| `ASR_API_KEY` / `ASR_MODEL` | =`LLM_API_KEY` / `whisper-1` | |
| `ASR_LOCAL_CMD` | – | `local` 模式命令行模板，见下 |
| `ASR_LOCAL_MODEL` | `base` | 本地模型名，替换 `{model}` |
| `SUMMARY_CHUNK_CHARS` | `1800` | 每块字幕的字符阈值 |
| `SUMMARY_MERGE_EVERY` | `3` | 每 N 个片段刷新一次全局总览 |
| `DATA_DIR` | `./data` | 术语表等持久化目录 |

### 用本地 Whisper（免费、隐私）

写一个输出纯文本到 stdout 的脚本，例如 `scripts/whisper_cli.py`：

```python
# pip install faster-whisper
import sys, argparse
from faster_whisper import WhisperModel
ap = argparse.ArgumentParser(); ap.add_argument("file"); ap.add_argument("--model", default="base"); ap.add_argument("--lang", default="auto")
a = ap.parse_args()
m = WhisperModel(a.model, device="auto", compute_type="int8")
segments, _ = m.transcribe(a.file, language=None if a.lang == "auto" else a.lang)
print(" ".join(s.text.strip() for s in segments))
```

然后：

```bash
export ASR_PROVIDER=local
export ASR_LOCAL_CMD="python3 scripts/whisper_cli.py --model {model} --lang {lang} {file}"
export ASR_LOCAL_MODEL=base
```

也支持 whisper.cpp：`ASR_LOCAL_CMD="/opt/whisper.cpp/main -m /models/ggml-{model}.bin -f {file} -l {lang} -otxt -of {out}"`。

---

## 三、使用说明

| 操作 | 说明 |
| --- | --- |
| 工具栏图标 | 打开 / 关闭侧边栏 |
| **开始分析** | 优先读平台字幕；失败自动转实时识别；识别中再点=停止 |
| **实时识别** | 强制用 `tabCapture` 采集标签页音频做 ASR |
| 关键节点 / 时间轴 / 字幕行 | 点击跳转到对应时间点，播放时自动高亮 |
| **问答** | 基于已获取的字幕内容提问，答案可带时间依据 |
| ⚙ 设置 | 后端地址、语言、自动纠错、自动分析 |

### 字幕来源与纠错

- B站：新版 `x/player/wbi/v2`（旧 `x/player/v2` 兜底）的字幕列表，过滤空 `subtitle_url`，按 `ai_type` 区分 **人工 / AI 字幕**；AI 字幕标记 `auto-cc` 进入纠错。请求在页面上下文带 Cookie 发出，无需额外配置。
- YouTube：优先读页面 `ytInitialPlayerResponse.captions`（`kind=asr` 为自动字幕），取不到时由后台拉取 watch 页兜底；字幕走 `timedtext ...&fmt=json3`。
- 纠错两段式：
  1. **确定性替换**：用已积累术语表把误识别别名换成标准写法（零成本、即时）。
  2. **LLM 上下文纠错**：结合前后文修正同音字、专名、标点，并抽取新术语回写术语表。

术语表按视频（`platform:videoId`）隔离，公共词条可放在 `data/glossary.json` 的 `global` 域。

---

## 四、HTTP / WebSocket 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务与配置状态 |
| GET | `/api/subtitle?url=` | 服务端抓取字幕（B站/YouTube） |
| POST | `/api/subtitle/parse` | 解析 VTT / json3 / B站字幕 |
| POST | `/api/correct` | 字幕纠错 |
| POST | `/api/summarize` | 增量总结（`sessionId`、`force`、`final`） |
| POST | `/api/chat` | 基于字幕问答 |
| POST | `/api/asr/chunk?session=&lang=` | HTTP 版 ASR（二进制 PCM16），用户脚本走这里 |
| POST | `/api/asr/reset` | 重置某会话的音频偏移 |
| WS | `/ws/asr` | WebSocket 流式 ASR（控制台/同源页面用） |

音频格式：**16kHz、单声道、PCM16 little-endian**（用户脚本用 AudioWorklet 实时重采样）。

---

## 五、已知限制

- **DRM 视频无法采集**：如 Netflix 等 DRM 站点，扩展的 tabCapture 也拿不到音频，只能依赖官方字幕。
- **HTTPS 页面无法直连 `ws://localhost`**（混合内容限制）：扩展统一走后台 fetch + HTTP 分片接口，天然规避；油猴脚本用 `GM_xmlhttpRequest`；服务端 WS 仅用于本地页面调试。
- 扩展采集标签页音频时会短暂接管播放（已在 offscreen 里回放，用户仍能听到）；首次点击“开始分析”若视频无声，确认是在当前标签页点按钮。
- **B站字幕常需登录**：`wbi/v2` 未登录时可能不返回字幕列表，此时会回退到实时 ASR。
- **实时性与成本**：当前为“近实时”（窗口 3–6 秒），非逐字流式；长视频全量纠错+总结的 LLM 调用量与时长成正比。

---

## 六、目录结构

```
video-summary/
├─ server/
│  ├─ index.js               Express + WS 入口
│  ├─ config.js              环境变量配置
│  ├─ lib/
│  │  ├─ llm.js              OpenAI 兼容客户端（含流式/JSON 提取）
│  │  ├─ correct.js          两段式字幕纠错
│  │  ├─ glossary.js         术语表 / 纠错记忆
│  │  ├─ summarize.js        分块摘要 + 滚动全局总览
│  │  ├─ asr-stream.js       WS 近实时转写
│  │  ├─ wav.js              PCM16 → WAV
│  │  └─ store.js            JSON 持久化
│  └─ providers/
│     ├─ asr.js              openai / local / mock ASR
│     └─ subtitles.js        B站 / YouTube 字幕抓取与解析
├─ extension/                浏览器扩展（MV3，推荐）
│  ├─ manifest.json
│  ├─ icons/                 由 scripts/gen-icons.js 生成
│  └─ src/
│     ├─ background.js       请求代理 + offscreen 管理 + 侧边栏
│     ├─ content.js          页面桥：字幕抓取 / 跳转 / 进度
│     ├─ sidepanel.html      侧边栏 UI
│     ├─ sidepanel.css       主题（自动明暗）
│     ├─ sidepanel.js        主控：编排 / 渲染 / 问答
│     ├─ offscreen.html
│     └─ offscreen.js        tabCapture 采集 + 16k 重采样 + ASR
├─ userscript/
│  └─ video-summary.user.js  油猴脚本（备选方案）
├─ public/index.html         调试控制台
├─ scripts/
│  ├─ smoke.js               端到端冒烟测试
│  ├─ whisper_cli.py         本地 faster-whisper 示例
│  └─ gen-icons.js           生成扩展图标
└─ README.md
```

## 七、测试

无需真实 API Key，用内置假 LLM + mock ASR：

```bash
node scripts/smoke.js
```

## 八、参考与致谢

本项目在设计时参考了以下高星开源项目（思路与接口用法，非代码复制）：

- [IndieKKY/bilibili-subtitle](https://github.com/IndieKKY/bilibili-subtitle)（哔哔君）：侧边栏 UX、`x/player/wbi/v2` 字幕接口与空 `subtitle_url` 过滤、带时间戳的结构化总结。
- [jdepoix/youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api)：YouTube 字幕/自动字幕的抓取方式与语言优先级。
- [JimmyLv/BibiGPT-v1](https://github.com/JimmyLv/BibiGPT-v1)：字幕总结的产品形态与提示词思路。

## License

MIT
