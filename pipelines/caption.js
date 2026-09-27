(() => {
  "use strict";

  if (window.LumeoCaptionPipeline?.__loaded) return;

  const DEFAULT_TRANSLATE_PROVIDER = "google-free";
  const DEFAULT_TARGET_LANGUAGE = "zh-CN";
  const CACHE_LIMIT = 50;
  const CACHE_VERSION = 2;
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  // 5 MB soft cap — each cached video's translated cues average ~40 KB, so
  // 50 videos ≈ 2 MB. Cap is defense against edge cases: 3-hour podcasts,
  // users who flip languages several times in a session, etc.
  const CACHE_MAX_BYTES = 5 * 1024 * 1024;

  function now() {
    return Date.now();
  }

  function cacheKey(videoId, targetLanguage, provider, sourceLanguage) {
    return [videoId, targetLanguage, provider, sourceLanguage || "auto"].join("::");
  }

  async function readCache() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "captionCacheGet" }, (reply) => {
        resolve(reply?.ok ? reply.cache : { entries: {} });
      });
    });
  }

  async function writeCache(cache) {
    // Sort newest-first, then drop entries that exceed either the count cap
    // or the byte budget. JSON.stringify length is a coarse but zero-dep
    // proxy for storage footprint; chrome.storage.local has a 10 MB default
    // so 5 MB leaves headroom for settings + the legacy caption cache.
    const sorted = Object.entries(cache.entries || {}).sort(
      (a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0),
    );
    const keptEntries = [];
    let totalBytes = 0;
    const cutoff = now() - CACHE_TTL_MS;
    for (const entry of sorted) {
      if (keptEntries.length >= CACHE_LIMIT) break;
      const value = entry[1] || {};
      if (value.version !== CACHE_VERSION || (value.updatedAt || 0) < cutoff) continue;
      const size = safeSize(value);
      if (totalBytes + size > CACHE_MAX_BYTES && keptEntries.length > 0) break;
      keptEntries.push(entry);
      totalBytes += size;
    }
    const nextCache = {
      entries: Object.fromEntries(keptEntries),
      version: CACHE_VERSION,
      stats: { bytes: totalBytes, count: keptEntries.length, updatedAt: now(), ttlMs: CACHE_TTL_MS },
    };
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "captionCacheSet", cache: nextCache }, () => resolve());
    });
  }

  function safeSize(value) {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }

  function isFreshCacheEntry(entry) {
    if (!entry?.cues?.length) return false;
    if (entry.version !== CACHE_VERSION) return false;
    if ((entry.updatedAt || 0) < now() - CACHE_TTL_MS) return false;
    return countTranslated(entry.cues) === entry.cues.length;
  }

  async function setCachedResult(key, value) {
    const cache = await readCache();
    cache.entries ||= {};
    cache.entries[key] = { ...value, version: CACHE_VERSION, updatedAt: now() };
    await writeCache(cache);
  }

  function countTranslated(cues = []) {
    return cues.filter((cue) => typeof cue?.translated === "string" && cue.translated.length > 0).length;
  }

  function mergeCachedCues(sourceCues, cachedCues = []) {
    return sourceCues.map((cue, index) => {
      const translated = cachedCues[index]?.translated;
      return typeof translated === "string" && translated.length > 0
        ? { ...cue, translated }
        : { ...cue };
    });
  }

  function isResumableCacheEntry(entry, total) {
    if (!entry?.cues?.length) return false;
    if (entry.version !== CACHE_VERSION) return false;
    if ((entry.updatedAt || 0) < now() - CACHE_TTL_MS) return false;
    const completed = countTranslated(entry.cues);
    return completed > 0 && completed < total;
  }

  function progressMeta(meta, completed, total) {
    return { ...meta, progress: { completed, total }, resume: completed < total };
  }

  function withAbortError(signal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  }

  function describeCaptionQuality(meta = {}) {
    if (!meta) return "未知字幕";
    const tracks = Array.isArray(meta.tracks) ? meta.tracks : [];
    const sourceTrack = tracks.find((track) => track.languageCode === meta.sourceLanguage) || tracks[0];
    const source = meta.nativeTarget
      ? "YouTube 原生字幕"
      : sourceTrack?.kind === "asr"
        ? "自动生成字幕"
        : meta.sourceLanguage
          ? "YouTube 字幕"
          : "未知字幕";
    const mode = meta.cached
      ? "已缓存"
      : meta.nativeTarget
        ? "直接使用"
        : "已翻译";
    return `${source} · ${mode}`;
  }

  function explainCaptionFailure(diagnostics, targetLanguageName) {
    const reason = diagnostics?.reason;
    const tracks = diagnostics?.tracks || [];
    const tracksLabel = tracks.length
      ? tracks
          .slice(0, 6)
          .map((t) => `${t.languageCode}${t.kind === "asr" ? " 自动生成" : ""}`)
          .join(", ")
      : "";
    if (reason === "no-tracks") {
      return "此视频没有提供字幕轨道，频道可能关闭了字幕和自动字幕。";
    }
    if (reason === "no-target-language") {
      return tracksLabel
        ? `已找到字幕轨道（${tracksLabel}），但没有${targetLanguageName}。请选择现有语言或下方备用方案。`
        : `没有匹配${targetLanguageName}的字幕轨道。`;
    }
    if (reason === "timedtext-empty-body" || reason === "timedtext-fetch-failed") {
      return `YouTube 字幕暂不可用${tracksLabel ? `（轨道：${tracksLabel}）` : ""}。请点一次播放器的字幕按钮后重试；若仍失败，请选择下方备用方案。`;
    }
    if (reason === "timedtext-unparsable") {
      return "字幕已下载但无法读取，请重试或选择下方备用方案。";
    }
    if (reason === "no-video-id") {
      return "请打开 YouTube 视频播放页后使用免费字幕。";
    }
    return "无法加载此视频的 YouTube 字幕。";
  }

  class CaptionPipeline {
    constructor() {
      this.token = 0;
      this.abortController = null;
      this.cues = [];
      this.meta = null;
      this.backgroundTranslation = null;
    }

    stop() {
      this.token += 1;
      this.abortController?.abort();
      this.abortController = null;
      this.backgroundTranslation = null;
      window.LumeoTTS?.stop?.();
      window.LumeoSonioxSTT?.stop?.();
    }

    async start(options = {}) {
      this.stop();
      const token = ++this.token;
      this.abortController = new AbortController();
      const signal = this.abortController.signal;

      const targetLanguage = options.targetLanguage || DEFAULT_TARGET_LANGUAGE;
      const provider = options.translateProvider || DEFAULT_TRANSLATE_PROVIDER;
      const diagnostics = {};
      const subtitles = await window.LumeoCaptions.fetchSubtitles({
        targetLanguage,
        videoId: options.videoId,
        diagnostics,
      });
      withAbortError(signal);
      if (token !== this.token) return { ok: false, error: "stale" };
      if (!subtitles?.cues?.length) {
        return {
          ok: false,
          error: explainCaptionFailure(diagnostics, options.targetLanguageName || targetLanguage),
          diagnostics,
        };
      }

      const key = cacheKey(subtitles.videoId, targetLanguage, provider, subtitles.sourceLanguage);
      const cache = await readCache();
      const cached = cache.entries?.[key] || null;
      if (isFreshCacheEntry(cached)) {
        options.onProgress?.({ phase: "cached", completed: cached.cues.length, total: cached.cues.length });
        this.cues = cached.cues;
        this.meta = { ...subtitles, cached: true, provider };
        return { ok: true, cues: this.cues, meta: this.meta };
      }

      let cues = subtitles.cues;
      if (!subtitles.nativeTarget) {
        const total = cues.length;
        const resumable = isResumableCacheEntry(cached, total);
        cues = resumable ? mergeCachedCues(cues, cached.cues) : cues;
        let completed = resumable ? countTranslated(cues) : 0;
        options.onProgress?.({ phase: resumable ? "resuming" : "translating", completed, total });
        const batchSize = Math.max(1, Number(options.batchSize || 40));
        const translateRange = async (start, end) => {
          const batchIndexes = [];
          const sourceTexts = [];
          for (let index = start; index < end; index += 1) {
            if (cues[index]?.translated) continue;
            batchIndexes.push(index);
            sourceTexts.push(cues[index].text);
          }
          if (!sourceTexts.length) return;
          const translated = await window.LumeoTranslate.translateBatch(
            sourceTexts,
            targetLanguage,
            {
              ...options,
              provider,
              signal,
              targetLanguageName: options.targetLanguageName || targetLanguage,
            },
          );
          withAbortError(signal);
          if (token !== this.token) return { ok: false, error: "stale" };
          batchIndexes.forEach((index, translatedIndex) => {
            cues[index] = { ...cues[index], translated: translated[translatedIndex] || cues[index].text };
          });
          completed = countTranslated(cues);
          this.cues = cues;
          this.meta = progressMeta({ ...subtitles, provider, cached: false }, completed, total);
          await setCachedResult(key, {
            cues,
            meta: this.meta,
          });
          options.onCueUpdate?.({ start, end, cues });
          options.onProgress?.({ phase: completed === total ? "translated" : "translating", completed, total });
        };

        if (options.progressive) {
          const playhead = Math.max(0, Number(options.playheadSeconds || 0));
          const firstIndex = Math.max(0, cues.findIndex((cue) => cue.end > playhead));
          const firstEnd = Math.min(firstIndex + Math.min(batchSize, 12), total);
          await translateRange(firstIndex, firstEnd);
          this.cues = cues;
          this.meta = progressMeta({ ...subtitles, provider, cached: false }, completed, total);
          const ranges = [];
          for (let start = firstEnd; start < total; start += batchSize) {
            ranges.push([start, Math.min(start + batchSize, total)]);
          }
          for (let start = 0; start < firstIndex; start += batchSize) {
            ranges.push([start, Math.min(start + batchSize, firstIndex)]);
          }
          this.backgroundTranslation = (async () => {
            for (const [start, end] of ranges) {
              withAbortError(signal);
              if (token !== this.token) return;
              await translateRange(start, end);
            }
          })().catch((error) => {
            if (error?.name !== "AbortError" && token === this.token) options.onBackgroundError?.(error);
          });
          return { ok: true, cues: this.cues, meta: this.meta };
        }

        for (let start = 0; start < total; start += batchSize) {
          await translateRange(start, Math.min(start + batchSize, total));
        }
      }

      if (subtitles.nativeTarget) {
        options.onProgress?.({ phase: "native", completed: cues.length, total: cues.length });
      }
      this.cues = cues;
      this.meta = {
        ...subtitles,
        provider,
        cached: false,
        progress: { completed: cues.length, total: cues.length },
        resume: false,
      };
      await setCachedResult(key, { cues, meta: this.meta });
      return { ok: true, cues, meta: this.meta };
    }

    cueAt(timeSeconds) {
      const t = Number(timeSeconds || 0);
      let lo = 0;
      let hi = this.cues.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.cues[mid].start <= t) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best >= 0 && t < this.cues[best].end) {
        return { cue: this.cues[best], index: best };
      }
      return { cue: null, index: -1 };
    }

    speakCue(cue, options = {}) {
      if (!cue?.translated) return Promise.resolve(false);
      return window.LumeoTTS.speak(
        cue.translated,
        options.targetLanguage || DEFAULT_TARGET_LANGUAGE,
        { ...options, syncDuration: options.syncDuration ?? Math.max(0.3, Number(cue.end) - Number(cue.start)), volume: options.volume ?? 1 },
      );
    }

    exportZip(title = "video") {
      const blob = window.LumeoSrtExport.makeSubtitleZip(this.cues, title);
      const safeTitle = window.LumeoSrtExport.sanitizeFilename(title);
      window.LumeoSrtExport.downloadBlob(blob, `${safeTitle}_yimu_subtitles.zip`);
    }
  }

  window.LumeoCaptionPipeline = {
    __loaded: true,
    CaptionPipeline,
    CACHE_VERSION,
    CACHE_TTL_MS,
    describeCaptionQuality,
    create: () => new CaptionPipeline(),
  };
})();
