import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseSrt } from "./core.mjs";

export const YTDLP = process.env.YIMU_YTDLP || "yt-dlp";
export const FFMPEG = process.env.YIMU_FFMPEG || "ffmpeg";
const YTDLP_RUNTIME = ["--js-runtimes", `node:${process.execPath}`];

export function youtubeCookieArgs(options = {}) {
  if (options.useChromeCookies) return ["--cookies-from-browser", "chrome"];
  const file = process.env.YIMU_YTDLP_COOKIES_FILE;
  return file ? ["--cookies", file] : [];
}

export function explainYoutubeError(error, options = {}) {
  const message = error?.message || String(error);
  if (/Sign in to confirm you.re not a bot/i.test(message)) {
    return new Error(options.useChromeCookies
      ? "YouTube 仍要求验证。请确认本机 Chrome 已登录 YouTube；若仍失败，可按 yt-dlp 官方说明提供 YouTube Cookie 文件。"
      : "YouTube 要求登录验证，无法匿名读取此视频。请在 Chrome 登录 YouTube，再在页面勾选“使用本机 Chrome 登录状态”并点击“重新尝试读取”。");
  }
  return error;
}

export function runCommand(command, args, { signal, cwd, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (bytes) => { stdout = (stdout + bytes).slice(-4_000_000); });
    child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-8_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} 失败：${stderr.trim() || `退出码 ${code}`}`));
    });
  });
}

export async function inspectVideo(videoId, options = {}) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  let output;
  try {
    output = await runCommand(options.ytdlp || YTDLP,
      ["--no-playlist", "--skip-download", "--dump-single-json", "--no-warnings", ...YTDLP_RUNTIME, ...youtubeCookieArgs(options), url], options);
  } catch (error) {
    throw explainYoutubeError(error, options);
  }
  const data = JSON.parse(output);
  const duration = Number(data.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法获取视频时长，暂不支持直播。");
  const manual = Object.keys(data.subtitles || {});
  const automatic = Object.keys(data.automatic_captions || {});
  const original = String(data.language || "");
  const available = manual.length ? manual : automatic;
  const captionLanguage = [original, "en", "zh", ...available]
    .find((language) => available.includes(language)) || available[0] || "";
  return { videoId, title: String(data.title || videoId), duration, url, captionLanguage };
}

export async function downloadCaptions(videoId, directory, language, options = {}) {
  if (!language) return null;
  const files = await readdir(directory);
  const cached = files.find((name) => /^captions\.[\w-]+\.srt$/.test(name) && name === `captions.${language}.srt`);
  if (!cached) {
    try {
      await runCommand(options.ytdlp || YTDLP, [
        "--no-playlist", "--skip-download", "--write-subs", "--write-auto-subs",
        "--sub-langs", language, "--sub-format", "vtt/best", "--convert-subs", "srt",
        "--ffmpeg-location", options.ffmpeg || FFMPEG,
        "--no-warnings", ...YTDLP_RUNTIME, ...youtubeCookieArgs(options),
        "-o", join(directory, "captions.%(ext)s"),
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { ...options, timeoutMs: 5 * 60_000 });
    } catch (error) {
      if (/Sign in to confirm you.re not a bot/i.test(error?.message || "")) throw explainYoutubeError(error, options);
      return null;
    }
  }
  const saved = (await readdir(directory)).find((name) => name === `captions.${language}.srt`);
  if (!saved) return null;
  const cues = parseSrt(await readFile(join(directory, saved), "utf8"));
  return cues.length ? { cues, sourceLanguage: language } : null;
}

export async function downloadAudio(videoId, directory, options = {}) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    await runCommand(options.ytdlp || YTDLP,
      ["--no-playlist", "--no-warnings", ...YTDLP_RUNTIME, ...youtubeCookieArgs(options), "--ffmpeg-location", options.ffmpeg || FFMPEG,
        "-f", "bestaudio", "-o", join(directory, "source.%(ext)s"), url],
      { ...options, timeoutMs: 30 * 60_000 });
  } catch (error) {
    throw explainYoutubeError(error, options);
  }
  const files = await readdir(directory);
  const name = files.find((file) => /^source\.(m4a|mp3|webm|opus|ogg|aac|mp4)$/.test(file));
  if (!name) throw new Error("未找到下载后的音轨。");
  return join(directory, name);
}

export async function extractWav(audioPath, outputPath, start, duration, options = {}) {
  await runCommand(options.ffmpeg || FFMPEG, [
    "-y", "-v", "error", "-ss", String(start), "-i", audioPath,
    "-t", String(duration), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath,
  ], { ...options, timeoutMs: 3 * 60_000 });
  return outputPath;
}
