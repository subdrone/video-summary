#!/usr/bin/env python3
"""本地 faster-whisper 转写 CLI，供 ASR_PROVIDER=local 调用。

安装：pip install faster-whisper
用法：ASR_LOCAL_CMD="python3 scripts/whisper_cli.py --model {model} --lang {lang} {file}"
"""
import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--model", default="base")
    ap.add_argument("--lang", default="auto")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("请先安装：pip install faster-whisper", file=sys.stderr)
        return 1

    model = WhisperModel(args.model, device="auto", compute_type="int8")
    language = None if args.lang in ("auto", "", None) else args.lang
    segments, _ = model.transcribe(args.file, language=language, vad_filter=True)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
