#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if command -v uv >/dev/null 2>&1; then
  if [ ! -x .venv/bin/python ]; then uv venv .venv; fi
  uv pip install --python .venv/bin/python 'yt-dlp[default]' imageio-ffmpeg
else
  if [ ! -x .venv/bin/python ]; then python3 -m venv .venv; fi
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install 'yt-dlp[default]' imageio-ffmpeg
fi

FFMPEG_BIN=$(.venv/bin/python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')
ln -sf "$FFMPEG_BIN" .venv/bin/ffmpeg

echo "依赖已安装。运行 bash local-service/run.sh 后打开 http://127.0.0.1:8791"
