#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -x .venv/bin/yt-dlp ] && [ -x .venv/bin/ffmpeg ]; then
  export YIMU_YTDLP="$PWD/.venv/bin/yt-dlp"
  export YIMU_FFMPEG="$PWD/.venv/bin/ffmpeg"
elif ! command -v yt-dlp >/dev/null 2>&1 || ! command -v ffmpeg >/dev/null 2>&1; then
  echo "请先运行 bash local-service/setup.sh 安装 yt-dlp 和 FFmpeg。" >&2
  exit 1
fi

node server.mjs
