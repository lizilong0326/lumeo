#!/usr/bin/env bash
# pack.sh — 将译幕打包为可安装的扩展压缩包。
# Reads the version from manifest.json so the output filename auto-tracks bumps.
set -euo pipefail

cd "$(dirname "$0")"
VERSION=$(node -p "require('./manifest.json').version")
OUT_DIR="${1:-dist}"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/yimu-v${VERSION}.zip"

rm -f "$OUT"
zip -rq "$OUT" . \
  -x "*.DS_Store" "node_modules/*" ".git/*" "dist/*" "local-service/*" "*.swp" "Thumbs.db" "pack.sh" \
     "release.sh" "*.zip"

SIZE=$(du -h "$OUT" | cut -f1)
COUNT=$(unzip -l "$OUT" | tail -1 | awk '{print $2}')
echo "✓ 已打包 ${OUT}（${SIZE}，${COUNT} 个文件）"
