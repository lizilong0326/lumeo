# Chrome 应用商店打包计划（尚未上架）

此清单源于早期扩展打包计划。当前 GitHub 源码包含需单独启动的本地服务，尚无面向普通用户的服务安装包；因此扩展 zip 本身不是可独立使用的正式商店发行物。

## Preflight

1. Confirm `manifest.json` and `package.json` versions match the planned release.
2. Confirm privacy policy URL is hosted and reachable.
3. Confirm `store-assets/web-store-metadata.md` copy matches current behavior.
4. Prepare current screenshots using [screenshots-guide.md](screenshots-guide.md); do not reuse screenshots of removed realtime or multi-mode UI.
5. Provide a clear installation and update path for the required local service before submitting the extension.

## Required local checks

```powershell
npm run check:all
npm test
```

## Package allowlist

Include:

- `manifest.json`
- `background.js`
- `content.js`
- `content.css`
- `popup.html`
- `popup.js`
- `popup.css`
- `lib/`
- `services/`
- `pipelines/`
- `ui/`
- `icons/`

Optional, if desired for reviewer context:

- `docs/privacy.html`
- `README.md`
- `SECURITY.md`

Exclude:

- `.git/`, `.github/`
- `.sisyphus/`, `.playwright-mcp/`
- `node_modules/`
- `coverage/`
- `output/`
- `tests/`
- generated browser profiles
- generated screenshots
- local logs
- `.env*`

## Windows package command

Use PowerShell from repo root:

```powershell
$dest = "store-assets/yimu-v1.2.3.zip"
Remove-Item -LiteralPath $dest -ErrorAction SilentlyContinue
Compress-Archive -LiteralPath @(
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "popup.css",
  "lib",
  "services",
  "pipelines",
  "ui",
  "icons"
) -DestinationPath $dest
```

## Shell package command

Use Git Bash or WSL from repo root:

```bash
zip -r store-assets/yimu-v1.2.3.zip \
  manifest.json background.js content.js content.css popup.html popup.js popup.css \
  lib services pipelines ui icons
```

## Post-package audit

```powershell
$tmp = Join-Path $env:TEMP "yimu-package-check"
Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath "store-assets/yimu-v1.2.3.zip" -DestinationPath $tmp -Force
Get-ChildItem -Recurse -File $tmp | ForEach-Object { $_.FullName.Replace($tmp, "") } | Sort-Object
```

Verify no excluded paths appear.

## Manual blocks

- Chrome Web Store upload is manual.
- Store form approval is manual.
- Clean Chrome profile test is manual unless a safe local profile script is added later.
