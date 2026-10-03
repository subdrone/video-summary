import { transcribePcm } from '../providers/asr.js';

/**
 * 近实时 ASR：接收浏览器推来的 16k 单声道 PCM16，按窗口切分转写。
 * 不是真正的流式解码，但延迟可控（窗口 3-6 秒），实现简单稳定。
 */
export class AsrStream {
  constructor(ws, opts = {}) {
    this.ws = ws;
    this.sampleRate = opts.sampleRate ?? 16000;
    this.lang = opts.lang ?? 'auto';
    this.windowSec = opts.windowSec ?? 5;
    this.prompt = opts.prompt ?? '';
    this.buffer = Buffer.alloc(0);
    this.offsetSec = 0; // 已处理到的音频时间
    this.closed = false;
    this.processing = false;
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  configure(opts = {}) {
    if (opts.lang) this.lang = opts.lang;
    if (opts.windowSec) this.windowSec = opts.windowSec;
    if (opts.prompt) this.prompt = opts.prompt;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const bytesPerSec = this.sampleRate * 2;
    const windowBytes = Math.floor(this.windowSec * bytesPerSec);
    while (this.buffer.length >= windowBytes) {
      const slice = this.buffer.subarray(0, windowBytes);
      this.buffer = this.buffer.subarray(windowBytes);
      this._process(slice);
    }
  }

  async _process(pcm) {
    if (this.processing) {
      // 简单背压：上一段没处理完，拼接进 buffer 前面稍后处理
      this.buffer = Buffer.concat([pcm, this.buffer]);
      return;
    }
    this.processing = true;
    const start = this.offsetSec;
    const end = start + pcm.length / (this.sampleRate * 2);
    this.offsetSec = end;
    try {
      const res = await transcribePcm(pcm, { lang: this.lang, prompt: this.prompt });
      if (res.text) {
        // 用最近识别文本作为下次的 prompt，提升术语连续性
        this.prompt = res.text.slice(-200);
        this.send({
          type: 'final',
          text: res.text,
          start,
          end,
          lang: res.lang ?? this.lang,
        });
      } else {
        this.send({ type: 'silence', start, end });
      }
    } catch (err) {
      this.send({ type: 'error', message: err.message });
    } finally {
      this.processing = false;
    }
  }

  /** 断开时把剩余不足一个窗口的音频也转写掉 */
  async flush() {
    if (this.buffer.length > this.sampleRate * 2 * 0.6) {
      const pcm = this.buffer;
      this.buffer = Buffer.alloc(0);
      await this._process(pcm);
    }
  }
}
