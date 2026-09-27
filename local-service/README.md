# 译幕本地服务（预览版）

粘贴 YouTube 视频链接后，本机读取整片音轨。MiniMax 识别完整视频、翻译成简体中文并合成全部中文语音。全部完成后可选择从头或从当前位置播放中文。准备期间可以先看原视频，后台任务继续运行。

使用时必须保持本地服务运行。只在本地网页粘贴链接和播放时，不需要安装浏览器扩展；要在 YouTube 原页启动任务或播放中文配音，还需要加载译幕 Chrome 扩展。两种方式都需要自行提供 MiniMax API Key。

## 启动

需要 Node.js 22+、Python 3.10+，推荐安装 `uv`。首次在项目根目录执行：

```bash
npm run local:setup
npm run local:serve
```

打开 <http://127.0.0.1:8791>，填写视频链接和 MiniMax API 密钥，点击“开始准备”。`local:setup` 只在 `local-service/.venv/` 安装 `yt-dlp[default]` 与 `imageio-ffmpeg`。服务只监听 `127.0.0.1`；密钥只保存在当前服务进程内存中，不写进项目文件。音频与文本会发送给 MiniMax，可能产生 API 费用。

如果 `8791` 已被占用，可运行 `YIMU_PORT=8792 npm run local:serve` 并打开对应端口。

## 工作方式

1. `yt-dlp` 读取视频信息。有可读字幕时先下载整片字幕；无字幕时下载完整音轨一次。
2. 无字幕的音轨按约 5 分钟切成识别任务，MiniMax `asr-1.0` 返回词级时间戳，再组合成短字幕。这些片段只用于处理和缓存，不再决定何时开放中文播放。
3. MiniMax M3 翻译整片字幕。相邻字幕按最多 8 条、45 秒合成一个语音请求；默认两次请求至少间隔 3 秒。语音和组内时间轴保存在本机，失败后可按组重试或跳过。完成前中文播放保持锁定。
4. 本地网页可先看原视频；完成后选择从头或从当前进度播放中文。若嵌入播放器要求登录，复制同步链接到已加载译幕 1.2.3 扩展的 Chrome，在 YouTube 原页按视频时间同步配音。
5. 扩展直接在 YouTube 视频页启动时，优先读取整片已有字幕，跳过音轨下载和识别；没有字幕时自动使用上述音轨识别流程。

## 已知限制

- 中文配音需要等待整片音轨识别、翻译和语音合成。视频越长，等待时间和 MiniMax 费用通常越高；等待时可观看原视频。
- 可设置 `YIMU_TTS_MIN_INTERVAL_MS=5000 npm run local:serve` 拉长组间请求间隔。合并请求和节流可降低触发 RPM 限流的概率，但实际限额仍由 MiniMax 账号决定。
- 有的视频要求 YouTube 登录验证，有的视频禁止嵌入播放。本地服务会显示相应错误。确有权限并自行提供 cookies 文件时，可在启动前设置 `YIMU_YTDLP_COOKIES_FILE=/绝对路径/cookies.txt`；请妥善保管该文件，不要放进项目或分享给他人。默认不会读取浏览器 Cookie。
- 遇到“Sign in to confirm you’re not a bot”时，可先在 Chrome 登录 YouTube，再手动勾选页面里的“使用本机 Chrome 登录状态”，点击“重新尝试读取”。默认不会读取 Chrome Cookie。该选项会让 `yt-dlp` 读取 Chrome 的全部网站 Cookie，因此只在需要时启用；服务不会把 Cookie 保存到项目中，也不会把 Cookie 传给 MiniMax。若使用 Chrome 登录状态仍失败，可按 [yt-dlp 官方 Cookie 说明](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)自行提供 Netscape 格式的 Cookie 文件。
- 这里的“本地”指服务和任务队列运行在本机；识别、翻译、合成仍调用 MiniMax。实测语音效果、不同视频的提取兼容性和费用取决于网络、视频与账号。
- 在 YouTube 原页可以由译幕扩展直接创建整片任务，也可以从本地页的同步链接连接已有任务；本地服务需要继续运行。同步链接只包含任务编号和本机端口，不含 MiniMax 密钥。
- 中文配音优先使用 MiniMax 返回的语音时间戳映射到原字幕；若未返回，则按译文长度估算。过长的译文可能需要较快的播放速度，无法保证每个字与原视频口型同步。
- 有字幕的视频以原字幕时间戳为准；无字幕的视频使用词级识别时间戳组合短句。语音会按字幕时间段调整速度，长译文仍可能听起来偏快，且无法保证口型同步。

## 同类开源项目

- [kekedubing](https://github.com/johunsang/kekedubing)：本地网页、YouTube 链接导入、Whisper/Argos/Supertonic 同步配音；模型与流程比本服务更完整，但未提供这里的 MiniMax 5 分钟滚动队列。
- [VideoHub](https://github.com/cacity/VideoHub)：中文桌面工具，支持 YouTube 导入、字幕和 MiniMax 配音，重点是视频制作与成片输出。
- [Foreign-Whisper](https://github.com/mego74/Foreign-Whisper)：YouTube URL 到最终配音视频的完整处理流水线。
