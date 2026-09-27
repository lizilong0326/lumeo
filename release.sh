#!/usr/bin/env bash
# release.sh — 更新译幕版本、打包并发布到自己的 GitHub 仓库。
#
# Usage:
#   ./release.sh patch       # 2.0.0 → 2.0.1 (bug fix)
#   ./release.sh minor       # 2.0.0 → 2.1.0 (new feature)
#   ./release.sh major       # 2.0.0 → 3.0.0 (breaking change)
#   ./release.sh 2.0.1       # explicit version
#
# Then upload the resulting zip to:
#   https://chrome.google.com/webstore/devconsole
# (manual step — browser-based, can't automate without OAuth setup)

set -euo pipefail

cd "$(dirname "$0")"

REMOTE_URL=$(git remote get-url origin)
EXPECTED_REMOTE_URL="${YIMU_RELEASE_REMOTE_URL:-}"
if [ -z "$EXPECTED_REMOTE_URL" ] || [ "$REMOTE_URL" != "$EXPECTED_REMOTE_URL" ]; then
  echo "请先将 origin 设为自己的译幕仓库，并通过 YIMU_RELEASE_REMOTE_URL 指定同一个地址。" >&2
  exit 1
fi

if [ $# -lt 1 ]; then
  echo "用法：$0 <patch|minor|major|x.y.z>" >&2
  exit 64
fi

CUR=$(node -p "require('./manifest.json').version")
case "$1" in
  patch) NEW=$(node -e "const [a,b,c]='$CUR'.split('.').map(Number); console.log([a,b,c+1].join('.'))") ;;
  minor) NEW=$(node -e "const [a,b]='$CUR'.split('.').map(Number); console.log([a,b+1,0].join('.'))") ;;
  major) NEW=$(node -e "const [a]='$CUR'.split('.').map(Number); console.log([a+1,0,0].join('.'))") ;;
  *)     NEW="$1" ;;
esac

echo "正在更新版本 $CUR → $NEW"

# 同步扩展版本与内容脚本版本。
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
m.version = '$NEW';
fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
let c = fs.readFileSync('content.js', 'utf8');
c = c.replace(/const LUMEO_VERSION = \"[^\"]+\";/, 'const LUMEO_VERSION = \"$NEW\";');
fs.writeFileSync('content.js', c);
"

# Pack the zip
bash ./pack.sh

# Show the diff and ask for confirmation before pushing
echo
git diff --stat manifest.json content.js
echo
read -r -p "确认提交、打标签并推送到自己的仓库？[y/N] " ans
[ "$ans" = "y" ] || { echo "aborted; manifest + content.js were updated locally but not committed"; exit 1; }

git add manifest.json content.js
git commit -m "chore: release v$NEW"
git tag -a "v$NEW" -m "v$NEW"
git push
git push --tags

# Optional release notes — paste from CHANGELOG.md or write inline
ZIP="dist/yimu-v${NEW}.zip"
gh release create "v$NEW" "$ZIP" \
  --title "译幕 v$NEW" \
  --notes "在 Chrome 扩展程序页面开启开发者模式，解压 \`yimu-v${NEW}.zip\` 后选择加载未打包的扩展程序。"

echo
echo "✓ Released v$NEW"
echo "  Zip:    $ZIP"
echo "  GitHub: $(git remote get-url origin)"
echo
echo "下一步：手动更新 Chrome 应用商店版本："
echo "  1. https://chrome.google.com/webstore/devconsole"
echo "  2. 选择译幕项目"
echo "  3. Drag $ZIP into the package upload area"
echo "  4. 填写更新说明并提交审核"
echo "  5. 上线时间以 Chrome 审核结果为准"
