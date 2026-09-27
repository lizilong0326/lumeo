import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SegmentQueue, parseSrt, planSegments, youtubeVideoId } from "./core.mjs";
import { downloadAudio, downloadCaptions, extractWav, inspectVideo } from "./media.mjs";
import { synthesizeSpeech, transcribeSrt, transcribeWords, translateBatch } from "./minimax.mjs";
import { groupWordSegments, normalizeCues, segmentCues, sourceHash } from "./timeline.mjs";
import { planSpeechGroups, speechOffsets } from "./dubbing.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.YIMU_PORT || 8791);
const DATA_DIR = process.env.YIMU_DATA_DIR || join(ROOT, "data");
const jobs = new Map();

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readJson(request) {
  let text = "";
  for await (const bytes of request) {
    text += bytes;
    if (text.length > 8 * 1024 * 1024) throw new Error("请求内容过大。");
  }
  return JSON.parse(text || "{}");
}

async function exists(path) {
  try { return (await stat(path)).size > 0; }
  catch { return false; }
}

function snapshot(job) {
  const pendingRetry = job.pendingSpeechRetries?.values().next().value || null;
  const queue = job.fullPreparation && job.queue
    ? { currentIndex: 0, maxAhead: 0, blocked: false, segments: job.queue.segments.map(({ cues, ...segment }) => ({ ...segment, cueCount: cues.length, cues: [] })) }
    : job.queue?.snapshot() || null;
  return {
    id: job.id,
    videoId: job.videoId,
    status: job.status,
    error: job.error,
    title: job.metadata?.title || "",
    duration: job.metadata?.duration || 0,
    queue,
    fullPreparation: !!job.fullPreparation,
    source: job.source || "audio",
    progress: job.progress || null,
    failedSpeechIndex: Number.isInteger(job.failedSpeechIndex) ? job.failedSpeechIndex : null,
    skippedSpeechCount: job.skippedCueCount || 0,
    speechGroupCount: job.speechGroupCount || 0,
    retryingSpeechIndex: pendingRetry?.index ?? null,
    retryingSpeechEndIndex: pendingRetry?.endIndex ?? null,
    retryAt: pendingRetry?.until ?? null,
    retryAttempt: pendingRetry?.attempt ?? null,
    failedSpeechEndIndex: job.failedSpeechEndIndex ?? null,
  };
}

function setProgress(job, phase, completed, total, detail = "") {
  job.status = phase;
  job.progress = { phase, completed, total, detail };
}

async function prepareFullJob(job) {
  const signal = job.prepareController.signal;
  const deps = job.deps || {};
  try {
    let sourceCues = job.sourceCues;
    if (sourceCues?.length) {
      job.source = "captions";
      job.metadata = { title: job.sourceTitle || job.videoId, duration: job.sourceDuration };
      job.queue = { segments: planSegments(job.metadata.duration), close() {} };
      sourceCues = normalizeCues(sourceCues, job.metadata.duration);
      if (job.skipTranslation) sourceCues.forEach((cue) => { cue.translated = cue.text; });
      setProgress(job, "transcribing", 1, 1, "已读取整片原字幕");
    } else {
      job.source = "audio";
      setProgress(job, "inspecting", 0, 1, "正在读取视频信息");
      job.metadata = await (deps.inspectVideo || inspectVideo)(job.videoId, { signal, useChromeCookies: job.useChromeCookies });
      if (signal.aborted) return;
      job.queue = { segments: planSegments(job.metadata.duration), close() {} };
      await mkdir(job.directory, { recursive: true });
      const captions = job.metadata.captionLanguage
        ? await (deps.downloadCaptions || downloadCaptions)(job.videoId, job.directory, job.metadata.captionLanguage, { signal, useChromeCookies: job.useChromeCookies })
        : null;
      if (signal.aborted) return;
      if (captions?.cues?.length) {
        sourceCues = normalizeCues(captions.cues, job.metadata.duration);
        job.source = "captions";
        job.skipTranslation = /^zh(?:-|$)/i.test(captions.sourceLanguage || "");
        if (job.skipTranslation) sourceCues.forEach((cue) => { cue.translated = cue.text; });
        setProgress(job, "transcribing", 1, 1, "已读取整片原字幕");
      } else {
        setProgress(job, "downloading", 0, 1, "正在读取整片音轨");
        const existing = (await readdir(job.directory)).find((name) => /^source\.(m4a|mp3|webm|opus|ogg|aac|mp4)$/.test(name));
        job.audioPath = existing ? join(job.directory, existing) : await (deps.downloadAudio || downloadAudio)(job.videoId, job.directory, { signal, useChromeCookies: job.useChromeCookies });
        sourceCues = [];
        const segmentDir = join(job.directory, "segments");
        await mkdir(segmentDir, { recursive: true });
        for (const segment of job.queue.segments) {
          if (signal.aborted) return;
          setProgress(job, "transcribing", segment.index, job.queue.segments.length, `正在识别 ${segment.index + 1}/${job.queue.segments.length} 段`);
          const cachePath = join(segmentDir, `${segment.index}.words.json`);
          let words;
          if (await exists(cachePath)) words = JSON.parse(await readFile(cachePath, "utf8"));
          else {
            const wavPath = join(segmentDir, `${segment.index}.wav`);
            if (!(await exists(wavPath))) await (deps.extractWav || extractWav)(job.audioPath, wavPath, segment.start, segment.end - segment.start, { signal });
            words = await (deps.transcribeWords || transcribeWords)(wavPath, job.apiKey, { signal });
            await writeFile(cachePath, JSON.stringify(words));
          }
          sourceCues.push(...groupWordSegments(words, segment.start, segment.end));
        }
        setProgress(job, "transcribing", job.queue.segments.length, job.queue.segments.length, "整片字幕已生成");
      }
    }
    if (signal.aborted) return;
    if (!sourceCues.length) throw new Error("整片字幕为空，无法生成中文配音。");
    const hash = sourceHash(job.videoId, sourceCues);
    const fullDir = join(job.directory, "full", hash);
    const translatedPath = join(fullDir, "translated.json");
    await mkdir(fullDir, { recursive: true });
    let cues = await exists(translatedPath) ? JSON.parse(await readFile(translatedPath, "utf8")) : sourceCues;
    if (!Array.isArray(cues) || cues.length !== sourceCues.length) cues = sourceCues;
    for (let index = 0; index < cues.length; index += 10) {
      if (signal.aborted) return;
      const batch = cues.slice(index, index + 10);
      const missing = batch.filter((cue) => !cue.translated);
      setProgress(job, "translating", Math.min(index, cues.length), cues.length, `正在翻译 ${Math.min(index + 10, cues.length)}/${cues.length} 条字幕`);
      if (missing.length) {
        const translated = await (deps.translateBatch || translateBatch)(missing.map((cue) => cue.text), job.apiKey, { signal });
        missing.forEach((cue, position) => { cue.translated = translated[position]; });
        await writeFile(translatedPath, JSON.stringify(cues));
      }
    }
    setProgress(job, "translating", cues.length, cues.length, "整片字幕已翻译");
    segmentCues(cues, job.queue.segments);
    const ttsDir = join(fullDir, "tts", job.voiceCache);
    await mkdir(ttsDir, { recursive: true });
    job.fullAudioDirectory = ttsDir;
    job.groupAudioFiles = new Map();
    const tasks = job.queue.segments.flatMap((segment) => segment.cues.map((cue, cueIndex) => ({ segment, cue, cueIndex })));
    const groups = planSpeechGroups(tasks);
    job.speechGroupCount = groups.length;
    let completed = 0;
    job.failedSpeechIndex = null;
    job.failedSpeechEndIndex = null;
    job.failedSpeechGroupIndex = null;
    setProgress(job, "speaking", 0, groups.length, `正在生成整片中文语音，共 ${groups.length} 组`);
    for (const group of groups) {
      if (signal.aborted) return;
      const lastIndex = group.firstIndex + group.tasks.length - 1;
      const groupLabel = group.firstIndex === lastIndex
        ? `第 ${group.firstIndex + 1} 条` : `第 ${group.firstIndex + 1}–${lastIndex + 1} 条`;
      const output = join(ttsDir, `group-${group.index}-${createHash("sha256").update(group.text).digest("hex").slice(0, 12)}.mp3`);
      const metadataPath = `${output}.json`;
      try {
        if (!job.skippedSpeech.has(group.index) && (!(await exists(output)) || !(await exists(metadataPath)))) {
          const elapsed = Date.now() - (job.lastSpeechRequestAt || 0);
          const interval = Math.max(0, Number(deps.minSpeechIntervalMs ?? process.env.YIMU_TTS_MIN_INTERVAL_MS ?? 3000));
          if (elapsed < interval) await delay(interval - elapsed, undefined, { signal });
          const speechController = new AbortController();
          try {
            job.lastSpeechRequestAt = Date.now();
            const result = await (deps.synthesizeSpeech || synthesizeSpeech)(group.text, job.apiKey, job.voice, {
              signal: AbortSignal.any([signal, speechController.signal]), withTimings: true,
              onRetry: ({ reason, attempt, maxAttempts, waitMs }) => {
                if (reason === "rate-limit") {
                  job.pendingSpeechRetries.set(group.index, {
                    index: group.firstIndex, endIndex: lastIndex, groupIndex: group.index,
                    until: Date.now() + waitMs, attempt: attempt + 1, controller: speechController,
                  });
                }
                setProgress(job, "speaking", completed, groups.length,
                  `${groupLabel}${reason === "rate-limit" ? "遇到 MiniMax 限流" : "语音服务暂时出错"}，等待 ${Math.ceil(waitMs / 1000)} 秒后重试（${attempt + 1}/${maxAttempts}）`);
              },
            });
            if (!job.skippedSpeech.has(group.index)) {
              const audio = Buffer.isBuffer(result) ? result : result?.audio;
              if (!Buffer.isBuffer(audio) || !audio.length) throw new Error("MiniMax 没有返回有效语音。");
              const duration = Number(result?.durationSeconds) || group.tasks.reduce((sum, task) => sum + task.cue.end - task.cue.start, 0);
              const offsets = speechOffsets(group.tasks.map((task) => task.cue.translated), result?.subtitles, duration);
              await writeFile(output, audio);
              await writeFile(metadataPath, JSON.stringify({ offsets }));
            }
          } finally { job.pendingSpeechRetries.delete(group.index); }
        }
        if (job.skippedSpeech.has(group.index)) {
          for (const { cue } of group.tasks) cue.audioUrl = null;
        } else {
          const { offsets } = JSON.parse(await readFile(metadataPath, "utf8"));
          if (!Array.isArray(offsets) || offsets.length !== group.tasks.length) throw new Error("配音时间轴缓存无效。");
          group.tasks.forEach(({ segment, cue, cueIndex }, index) => {
            cue.audioUrl = `/api/jobs/${job.id}/audio/${segment.index}/${cueIndex}`;
            cue.audioGroup = group.index;
            cue.audioStart = offsets[index].start;
            cue.audioEnd = offsets[index].end;
            cue.audioDuration = offsets.at(-1).end;
          });
          job.groupAudioFiles.set(group.index, output);
        }
        completed += 1;
        setProgress(job, "speaking", completed, groups.length, `中文配音 ${completed}/${groups.length} 组（已处理到第 ${lastIndex + 1} 条字幕）`);
      } catch (error) {
        if (job.skippedSpeech.has(group.index) && !signal.aborted) {
          for (const { cue } of group.tasks) cue.audioUrl = null;
          completed += 1;
          setProgress(job, "speaking", completed, groups.length, `已跳过${groupLabel}的配音，保留中文字幕`);
          continue;
        }
        job.failedSpeechIndex = group.firstIndex;
        job.failedSpeechEndIndex = lastIndex;
        job.failedSpeechGroupIndex = group.index;
        throw new Error(`${groupLabel}中文配音失败：${error?.message || String(error)}`);
      }
    }
    if (signal.aborted) return;
    for (const segment of job.queue.segments) {
      segment.status = "ready";
      segment.step = "可播放";
    }
    setProgress(job, "ready", groups.length, groups.length, "整片中文配音已就绪");
    job.apiKey = "";
  } catch (error) {
    if (signal.aborted || job.closed) return;
    job.status = "failed";
    job.error = error?.message || "整片准备失败。";
    job.progress = { ...(job.progress || {}), phase: "failed", detail: job.error };
  }
}

async function processSegment(job, segment, { signal, update }) {
  const segmentDir = join(job.directory, "segments");
  const ttsDir = join(job.directory, "tts", job.voiceCache);
  await mkdir(segmentDir, { recursive: true });
  await mkdir(ttsDir, { recursive: true });
  const wavPath = join(segmentDir, `${segment.index}.wav`);
  const srtPath = join(segmentDir, `${segment.index}.srt`);
  const partialPath = join(segmentDir, `${segment.index}.partial.json`);
  const cuePath = join(segmentDir, `${segment.index}.json`);
  let cues;
  if (await exists(cuePath)) {
    cues = JSON.parse(await readFile(cuePath, "utf8"));
  } else {
    if (await exists(partialPath)) {
      try { cues = JSON.parse(await readFile(partialPath, "utf8")); }
      catch { cues = null; }
    }
    if (!Array.isArray(cues)) {
      let srt;
      if (await exists(srtPath)) {
        srt = await readFile(srtPath, "utf8");
      } else {
        update("切分音轨");
        await extractWav(job.audioPath, wavPath, segment.start, segment.end - segment.start, { signal });
        update("MiniMax 识别");
        srt = await transcribeSrt(wavPath, job.apiKey, { signal });
        await writeFile(srtPath, srt, "utf8");
      }
      cues = parseSrt(srt, segment.start, segment.end);
    }
    for (let index = 0; index < cues.length; index += 10) {
      const batch = cues.slice(index, index + 10);
      const missing = batch.filter((cue) => !cue.translated);
      if (!missing.length) continue;
      update(`翻译 ${Math.min(index + 10, cues.length)}/${cues.length}`);
      const translations = await translateBatch(missing.map((cue) => cue.text), job.apiKey, { signal });
      missing.forEach((cue, offset) => { cue.translated = translations[offset]; });
      await writeFile(partialPath, JSON.stringify(cues), "utf8");
    }
    await writeFile(cuePath, JSON.stringify(cues), "utf8");
  }
  let completed = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(3, cues.length) }, async () => {
    while (next < cues.length) {
      const cueIndex = next++;
      const cue = cues[cueIndex];
      const output = join(ttsDir, `${segment.index}-${cueIndex}.mp3`);
      if (signal.aborted) throw new Error("任务已取消。");
      if (!(await exists(output))) {
        const audio = await synthesizeSpeech(cue.translated, job.apiKey, job.voice, { signal });
        await writeFile(output, audio);
      }
      cue.audioUrl = `/api/jobs/${job.id}/audio/${segment.index}/${cueIndex}`;
      completed += 1;
      update(`中文配音 ${completed}/${cues.length}`);
    }
  });
  await Promise.all(workers);
  return cues;
}

async function prepareJob(job) {
  try {
    job.metadata = await inspectVideo(job.videoId, { signal: job.prepareController.signal, useChromeCookies: job.useChromeCookies });
    if (job.closed) return;
    job.status = "downloading";
    await mkdir(job.directory, { recursive: true });
    const existing = (await readdir(job.directory)).find((name) => /^source\.(m4a|mp3|webm|opus|ogg|aac|mp4)$/.test(name));
    job.audioPath = existing ? join(job.directory, existing) : await downloadAudio(job.videoId, job.directory, { signal: job.prepareController.signal, useChromeCookies: job.useChromeCookies });
    if (job.closed) return;
    job.queue = new SegmentQueue({
      duration: job.metadata.duration,
      processSegment: (segment, context) => processSegment(job, segment, context),
    });
    job.status = "processing";
    job.queue.schedule();
  } catch (error) {
    if (job.closed) return;
    job.status = "failed";
    job.error = error?.message || "视频准备失败。";
  }
}

async function serveAsset(response, name) {
  const asset = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] }[name];
  if (!asset) return false;
  const body = await readFile(join(ROOT, "public", asset[0]));
  response.writeHead(200, {
    "Content-Type": `${asset[1]}; charset=utf-8`,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com; media-src 'self'; img-src 'self' https: data:; style-src 'self'; connect-src 'self'",
  });
  response.end(body);
  return true;
}

function validLocalRequest(request, path) {
  const host = String(request.headers.host || "");
  if (!/^((127\.0\.0\.1)|(localhost)):\d+$/.test(host)) return false;
  const origin = request.headers.origin;
  if (!origin || origin === `http://${host}`) return true;
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
  if (request.method === "GET") return path === "/api/health" || /^\/api\/jobs\/[a-f0-9-]+(?:\/(?:timeline|audio\/\d+\/\d+))?$/.test(path);
  if (request.method === "DELETE") return /^\/api\/jobs\/[a-f0-9-]+$/.test(path);
  return request.method === "POST" && (path === "/api/jobs" || /^\/api\/jobs\/[a-f0-9-]+\/(?:playhead|restart|skip)$/.test(path));
}

export function createServer(options = {}) {
  return http.createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (!validLocalRequest(request, path)) return sendJson(response, 403, { error: "只接受本机页面请求。" });
      if (request.method === "GET" && await serveAsset(response, path)) return;
      if (path === "/api/health" && request.method === "GET") return sendJson(response, 200, { ok: true, service: "译幕本地服务" });
      if (path === "/api/jobs" && request.method === "POST") {
        const body = await readJson(request);
        if (request.headers.origin?.startsWith("chrome-extension://") && body.mode !== "full") {
          return sendJson(response, 403, { error: "扩展只能创建整片准备任务。" });
        }
        const videoId = youtubeVideoId(body.url);
        const apiKey = String(body.apiKey || (request.headers.origin?.startsWith("chrome-extension://") ? "" : process.env.MINIMAX_API_KEY) || "").trim();
        if (!apiKey) return sendJson(response, 400, { error: "请输入 MiniMax API 密钥。" });
        const fullPreparation = body.mode === "full";
        const sourceDuration = Number(body.duration || 0);
        if (fullPreparation && Array.isArray(body.cues) && (!Number.isFinite(sourceDuration) || sourceDuration <= 0)) {
          return sendJson(response, 400, { error: "字幕任务缺少视频时长。" });
        }
        const sourceCues = fullPreparation && Array.isArray(body.cues) ? normalizeCues(body.cues, sourceDuration) : null;
        for (const old of jobs.values()) {
          old.closed = true;
          old.prepareController.abort();
          old.queue?.close();
          old.apiKey = "";
        }
        const voice = String(body.voice || "male-qn-qingse").slice(0, 80);
        const job = {
          id: randomUUID(), videoId, apiKey,
          useChromeCookies: body.useChromeCookies === true,
          voice, voiceCache: createHash("sha256").update(voice).digest("hex").slice(0, 12),
          directory: join(options.dataDir || DATA_DIR, videoId), status: "inspecting", error: "",
          metadata: null, audioPath: "", queue: null, closed: false, prepareController: new AbortController(),
          fullPreparation, sourceCues, sourceDuration, sourceTitle: String(body.title || "").slice(0, 300),
          skipTranslation: /^zh(?:-|$)/i.test(String(body.sourceLanguage || "")),
          progress: null, source: sourceCues?.length ? "captions" : "audio", fullAudioDirectory: "",
          failedSpeechIndex: null, skippedSpeech: new Set(), pendingSpeechRetries: new Map(),
          failedSpeechEndIndex: null, skippedCueCount: 0, speechGroupCount: 0,
          lastSpeechRequestAt: 0, groupAudioFiles: new Map(),
          deps: options,
        };
        jobs.set(job.id, job);
        void (fullPreparation ? prepareFullJob(job) : prepareJob(job));
        return sendJson(response, 202, snapshot(job));
      }
      const match = path.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(.*))?$/);
      if (!match) return sendJson(response, 404, { error: "未找到接口。" });
      const job = jobs.get(match[1]);
      if (!job) return sendJson(response, 404, { error: "任务不存在。" });
      const action = match[2] || "";
      if (request.method === "GET" && !action) return sendJson(response, 200, snapshot(job));
      if (request.method === "GET" && action === "timeline") {
        if (job.fullPreparation && job.status !== "ready") return sendJson(response, 409, { error: "整片中文配音仍在准备。" });
        return sendJson(response, 200, { ...snapshot(job), queue: job.fullPreparation
          ? { currentIndex: 0, segments: job.queue.segments }
          : job.queue?.snapshot() || null });
      }
      if (request.method === "POST" && action === "restart") {
        if (job.closed || job.status !== "failed") return sendJson(response, 409, { error: "当前任务不能重新尝试读取。" });
        const body = await readJson(request);
        if (typeof body.useChromeCookies === "boolean") job.useChromeCookies = body.useChromeCookies;
        job.prepareController = new AbortController();
        job.status = "inspecting";
        job.error = "";
        void (job.fullPreparation ? prepareFullJob(job) : prepareJob(job));
        return sendJson(response, 202, snapshot(job));
      }
      if (request.method === "POST" && action === "skip") {
        const pendingRetry = job.pendingSpeechRetries.values().next().value;
        const failedSpeech = job.status === "failed" && Number.isInteger(job.failedSpeechIndex);
        const retryingSpeech = job.status === "speaking" && pendingRetry;
        if (!job.fullPreparation || job.closed || (!failedSpeech && !retryingSpeech)) {
          return sendJson(response, 409, { error: "当前没有可跳过的配音句子。" });
        }
        if (retryingSpeech) {
          job.skippedSpeech.add(pendingRetry.groupIndex);
          job.skippedCueCount += pendingRetry.endIndex - pendingRetry.index + 1;
          job.pendingSpeechRetries.delete(pendingRetry.groupIndex);
          pendingRetry.controller.abort();
          return sendJson(response, 202, snapshot(job));
        }
        const groupIndex = job.failedSpeechGroupIndex;
        job.skippedSpeech.add(groupIndex);
        job.skippedCueCount += job.failedSpeechEndIndex - job.failedSpeechIndex + 1;
        job.prepareController = new AbortController();
        job.status = "inspecting";
        job.error = "";
        void prepareFullJob(job);
        return sendJson(response, 202, snapshot(job));
      }
      if (request.method === "DELETE" && !action) {
        job.closed = true;
        job.prepareController.abort();
        job.queue?.close();
        job.status = "stopped";
        job.apiKey = "";
        return sendJson(response, 200, snapshot(job));
      }
      if (request.method === "POST" && action === "playhead") {
        const body = await readJson(request);
        job.queue?.setPlayhead?.(Number(body.seconds || 0));
        return sendJson(response, 200, snapshot(job));
      }
      const retry = action.match(/^retry\/(\d+)$/);
      if (request.method === "POST" && retry) return sendJson(response, 200, { retried: job.queue?.retry(Number(retry[1])) || false });
      const audio = action.match(/^audio\/(\d+)\/(\d+)$/);
      if (request.method === "GET" && audio) {
        const segmentIndex = Number(audio[1]);
        const cueIndex = Number(audio[2]);
        const segment = job.queue?.segments[segmentIndex];
        if (segment?.status !== "ready" || !segment.cues[cueIndex]?.audioUrl) return sendJson(response, 404, { error: "音频未就绪。" });
        const bytes = await readFile(job.fullPreparation
          ? job.groupAudioFiles.get(segment.cues[cueIndex].audioGroup)
          : join(job.directory, "tts", job.voiceCache, `${segmentIndex}-${cueIndex}.mp3`));
        response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": bytes.length, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
        return response.end(bytes);
      }
      return sendJson(response, 404, { error: "未找到接口。" });
    } catch (error) {
      sendJson(response, 400, { error: error?.message || "请求失败。" });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`译幕本地服务：http://127.0.0.1:${PORT}`);
  });
}
