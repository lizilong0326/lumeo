// MiniMax China API: chunked ASR and Chinese speech synthesis.
(() => {
  "use strict";
  if (window.LumeoMiniMax?.__loaded) return;

  const BASE = "https://api.minimax.cn/v1";
  const ASR_MODEL = "asr-1.0";
  const SPEECH_MODEL = "speech-2.8-turbo";
  const DEFAULT_VOICE = "male-qn-qingse";
  const SPEECH_CACHE_LIMIT = 24;
  const SPEECH_CACHE_MAX_BYTES = 12 * 1024 * 1024;
  const speechCache = new Map();
  let speechCacheKey = "";
  let speechCacheBytes = 0;
  let currentAudio = null;
  let currentAudioUrl = null;
  let playbackGeneration = 0;

  function assertKey(value) {
    const key = String(value || "").trim();
    if (!key) throw new Error("请填写 MiniMax API 密钥。");
    return key;
  }

  async function responseData(response, stage) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || Number(data?.base_resp?.status_code || 0) !== 0) {
      const detail = data?.base_resp?.status_msg || data?.error?.message || `HTTP ${response.status}`;
      throw new Error(`MiniMax ${stage}失败：${String(detail).slice(0, 180)}`);
    }
    return data;
  }

  async function transcribe(wavBlob, options = {}) {
    const key = assertKey(options.apiKey);
    const form = new FormData();
    form.append("model", ASR_MODEL);
    form.append("response_format", "json");
    form.append("file", wavBlob, "chunk.wav");
    const response = await (options.fetch || fetch)(`${BASE}/speech_to_text`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: options.signal,
    });
    const data = await responseData(response, "语音识别");
    return String(data.text || "").trim();
  }

  function hexToBytes(hex) {
    if (typeof hex !== "string" || !hex.length || hex.length % 2 || /[^0-9a-f]/i.test(hex)) {
      throw new Error("MiniMax 没有返回有效音频。");
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  async function requestSpeech(clean, key, options) {
    const response = await (options.fetch || fetch)(`${BASE}/t2a_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SPEECH_MODEL,
        text: clean,
        stream: false,
        output_format: "hex",
        voice_setting: { voice_id: options.voice || DEFAULT_VOICE, speed: Number(options.speed || 1), vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      }),
      signal: options.signal,
    });
    const data = await responseData(response, "语音合成");
    return hexToBytes(data?.data?.audio);
  }

  async function synthesize(text, options = {}) {
    const clean = String(text || "").trim();
    if (!clean) return null;
    const key = assertKey(options.apiKey);
    if (speechCacheKey !== key) {
      speechCache.clear();
      speechCacheBytes = 0;
      speechCacheKey = key;
    }
    const cacheKey = [options.voice || DEFAULT_VOICE, Number(options.speed || 1), clean].join("\u0001");
    const cached = speechCache.get(cacheKey);
    if (cached && !cached.signal?.aborted) {
      speechCache.delete(cacheKey);
      speechCache.set(cacheKey, cached);
      return cached.promise;
    }
    if (cached) {
      speechCache.delete(cacheKey);
      speechCacheBytes -= cached.size;
    }
    const entry = { promise: null, size: 0, signal: options.signal, ready: false };
    entry.promise = requestSpeech(clean, key, options).then((bytes) => {
      entry.ready = true;
      if (speechCache.get(cacheKey) === entry) {
        entry.size = bytes.byteLength;
        speechCacheBytes += entry.size;
        while (speechCache.size > SPEECH_CACHE_LIMIT || speechCacheBytes > SPEECH_CACHE_MAX_BYTES) {
          const oldestKey = speechCache.keys().next().value;
          const oldest = speechCache.get(oldestKey);
          speechCache.delete(oldestKey);
          speechCacheBytes -= oldest.size;
        }
      }
      return bytes;
    }).catch((error) => {
      if (speechCache.get(cacheKey) === entry) speechCache.delete(cacheKey);
      throw error;
    });
    speechCache.set(cacheKey, entry);
    return entry.promise;
  }

  function prefetch(text, options = {}) {
    return synthesize(text, options);
  }

  function isCached(text, options = {}) {
    if (!options.apiKey || speechCacheKey !== String(options.apiKey).trim()) return false;
    const cacheKey = [options.voice || DEFAULT_VOICE, Number(options.speed || 1), String(text || "").trim()].join("\u0001");
    const entry = speechCache.get(cacheKey);
    return !!entry?.ready && !entry.signal?.aborted;
  }

  function stop() {
    playbackGeneration += 1;
    if (currentAudio) { try { currentAudio.pause(); } catch {} currentAudio = null; }
    if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
  }

  function playbackRateForCue(audioDuration, cueDuration) {
    if (!Number.isFinite(audioDuration) || !Number.isFinite(cueDuration) ||
        audioDuration <= 0 || cueDuration <= 0) return 1;
    return Math.max(0.5, Math.min(4, audioDuration / cueDuration));
  }

  async function speak(text, options = {}) {
    const generation = ++playbackGeneration;
    const bytes = await synthesize(text, options);
    if (!bytes || generation !== playbackGeneration) return false;
    if (currentAudio) { try { currentAudio.pause(); } catch {} currentAudio = null; }
    if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    currentAudioUrl = url;
    const audio = new Audio(url);
    currentAudio = audio;
    audio.volume = Math.max(0, Math.min(1, Number(options.volume ?? 1)));
    if (Number(options.syncDuration) > 0) {
      const setRate = () => {
        audio.playbackRate = playbackRateForCue(audio.duration, Number(options.syncDuration));
      };
      audio.addEventListener("loadedmetadata", setRate, { once: true });
      if (audio.readyState >= 1) setRate();
    }
    audio.addEventListener("ended", () => { if (currentAudio === audio) stop(); }, { once: true });
    try { await audio.play(); } catch (error) { if (currentAudio === audio) stop(); throw error; }
    return true;
  }

  window.LumeoMiniMax = { __loaded: true, BASE, ASR_MODEL, SPEECH_MODEL, DEFAULT_VOICE, transcribe, synthesize, prefetch, isCached, speak, stop, playbackRateForCue, hexToBytes };
})();
