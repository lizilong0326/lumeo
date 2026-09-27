// 译幕 — background service worker.
// Single source of truth for session state across the popup and content script.
//
// Popup is a passive renderer: it never reads chrome.storage to decide running
// state. Content script owns the WebRTC PeerConnection lifecycle for the
// Standard / Realtime dubbing pipelines, and the timedtext fetch loop for the
// Caption pipeline. Background glues them: ensureContentScript(tabId) makes
// Start work without a refresh, state.* is the canonical snapshot,
// BACKGROUND_STATE_UPDATE pushes to popup, CONTENT_UPDATE pushes to the active
// YT tab.
//
// Coordinates caption translation and dubbing sessions across extension views.

import "./lib/browser-api.js";

const browserApi = globalThis.LumeoBrowserApi;

const DEFAULT_SETTINGS = {
  tier: "caption",
  targetLanguage: "zh-CN",
  translateProvider: "minimax",
  sttProvider: "minimax-asr",
  captionTtsProvider: "minimax-tts",
  dubProvider: "minimax-dub",
  openaiKey: "",
  openaiModel: "gpt-4o-mini",
  geminiKey: "",
  geminiModel: "gemini-2.5-flash-lite",
  openRouterKey: "",
  openRouterModel: "openrouter/free",
  groqApiKey: "",
  groqModel: "llama-3.3-70b-versatile",
  // Reserved provider fields stay in settings so popup/storage migrations do
  // not churn while the corresponding registry entries remain coming-soon.
  huggingFaceToken: "",
  hfModel: "",
  googleCloudKey: "",
  libreTranslateUrl: "",
  libreTranslateKey: "",
  sonioxApiKey: "",
  elevenLabsKey: "",
  minimaxKey: "",
  replicateKey: "",
  translationContext: "",
  // Standard tier (Minimax chunked pipeline). Default voice is Magnetic Man,
  // the male voice Son ranked highest in the 2026-05-08 listening test.
  standardVoice: "male-qn-qingse",
  useChromeCookies: false,
  originalVolume: 18,
  voiceVolume: 100,
  showSource: false,
  kymaKey: "",
};

// In-memory state. Resets when the service worker cold-starts; that's
// intentional — the user gets a clean idle on cold start.
const state = {
  running: false,
  connecting: false,
  paused: false,
  tabId: null,
  videoId: null,
  status: "已就绪",
  errorMessage: "",
  errorCode: "",
  missingProviders: [],
  slotsMissingKeys: [],
  ...DEFAULT_SETTINGS,
};

// Restrict storage access so rogue page scripts on youtube.com cannot read
// the user's Kyma key. Sticky, no retry needed.
browserApi.setStorageAccessLevel("TRUSTED_CONTEXTS").catch(() => {});

let lastBroadcastAt = 0;
const BROADCAST_DEBOUNCE_MS = 50;
let sonioxWs = null;
let sonioxTabId = null;

function snapshot() {
  return { ...state };
}

function broadcastToPopup() {
  // Debounce: 1 broadcast per 50 ms. Popup re-renders are cheap but spamming
  // is wasteful while volume sliders drag.
  const now = Date.now();
  if (now - lastBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
  lastBroadcastAt = now;
  browserApi.sendRuntimeMessage({ type: "BACKGROUND_STATE_UPDATE", state: snapshot() }).catch(() => {});
}

async function relayToContent(tabId, message) {
  if (!tabId) throw new Error("没有可连接的标签页。");
  return browserApi.sendTabMessage(tabId, message);
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchJSON(url, init = {}) {
  const response = await fetch(url, {
    method: init.method || "GET",
    headers: init.headers || {},
    body: init.body || undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.error || `HTTP ${response.status}`);
  }
  return data;
}

async function localServiceRequest(message, sender) {
  if (!isYouTubeUrl(sender.tab?.url)) throw new Error("仅支持在 YouTube 视频页连接本地配音。");
  const jobId = String(message.jobId || "");
  const port = Number(message.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("本地配音连接信息无效。");
  }
  const origin = `http://127.0.0.1:${port}`;
  if (message.action === "health") return fetchJSON(`${origin}/api/health`);
  if (message.action === "create") {
    const videoId = new URL(sender.tab.url).searchParams.get("v");
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) throw new Error("当前页面不是 YouTube 视频。");
    return fetchJSON(`${origin}/api/jobs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "full", url: `https://www.youtube.com/watch?v=${videoId}`,
        apiKey: String(message.apiKey || ""), voice: String(message.voice || "male-qn-qingse"),
        title: String(message.title || ""), duration: Number(message.duration || 0),
        sourceLanguage: String(message.sourceLanguage || ""),
        useChromeCookies: message.useChromeCookies === true,
        cues: Array.isArray(message.cues) ? message.cues : undefined,
      }),
    });
  }
  if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error("本地配音连接信息无效。");
  const base = `http://127.0.0.1:${port}/api/jobs/${jobId}`;
  if (message.action === "status") return fetchJSON(base);
  if (message.action === "timeline") return fetchJSON(`${base}/timeline`);
  if (message.action === "retry" || message.action === "skip") {
    return fetchJSON(`${base}/${message.action === "retry" ? "restart" : "skip"}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
  }
  if (message.action === "cancel") return fetchJSON(base, { method: "DELETE" });
  if (message.action === "playhead") {
    const seconds = Number(message.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("视频进度无效。");
    return fetchJSON(`${base}/playhead`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds }),
    });
  }
  if (message.action === "audio") {
    const segment = Number(message.segment);
    const cue = Number(message.cue);
    if (!Number.isInteger(segment) || !Number.isInteger(cue) || segment < 0 || cue < 0) {
      throw new Error("本地配音片段编号无效。");
    }
    const response = await fetch(`${base}/audio/${segment}/${cue}`);
    if (!response.ok) throw new Error(`配音音频读取失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let base64 = "";
    for (let index = 0; index < bytes.length; index += 8190) {
      base64 += btoa(String.fromCharCode(...bytes.subarray(index, index + 8190)));
    }
    return { base64, byteLength: bytes.length };
  }
  throw new Error("未知本地配音操作。");
}

function isYouTubeUrl(url) {
  return typeof url === "string" && /^https?:\/\/[^/]*youtube\.com\//.test(url);
}

function videoIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const id = parsed.pathname === "/watch" ? parsed.searchParams.get("v") : null;
    return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
  } catch { return null; }
}

async function activeYouTubeTab() {
  const [tab] = await browserApi.queryTabs({ active: true, currentWindow: true });
  if (!tab) throw new Error("没有当前标签页。");
  if (!isYouTubeUrl(tab.url)) throw new Error("请先打开 YouTube 视频。");
  return tab;
}

const CONTENT_SCRIPT_FILES = [
  "lib/browser-api.js",
  "lib/token-guard.js",
  "lib/audio-utils.js",
  "ui/overlay.js",
  "ui/subtitle-overlay.js",
  "ui/voice-picker.js",
  "ui/caption-fallback-choice.js",
  "services/providers.js",
  "services/minimax.js",
  "services/translate.js",
  "services/srt-export.js",
  "services/tts-browser.js",
  "services/tts-openai.js",
  "services/stt-soniox.js",
  "services/stt-groq.js",
  "services/captions.js",
  "services/kyma-client.js",
  "pipelines/caption.js",
  "pipelines/caption-orchestrator.js",
  "pipelines/standard.js",
  "ui/local-panel.js",
  "ui/local-playback.js",
  "ui/full-prep.js",
  "content.js",
];
const EXPECTED_CONTENT_VERSION = "1.2.3";
const CAPTION_CACHE_KEY = "lumeoCaptionCacheV1";

async function readCaptionCache() {
  const stored = await chrome.storage.local.get(CAPTION_CACHE_KEY);
  return stored[CAPTION_CACHE_KEY] || { entries: {} };
}

async function writeCaptionCache(cache) {
  await chrome.storage.local.set({ [CAPTION_CACHE_KEY]: cache || { entries: {} } });
}

// Ensure content script and its support modules are alive in the target tab.
// PING first; if the old content script is present but the new Caption modules
// are missing (common after extension reload on an already-open YouTube tab),
// inject support files again before starting.
async function ensureContentScript(tabId) {
  let shouldReset = false;
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" });
    if (reply?.ok &&
        reply.version === EXPECTED_CONTENT_VERSION &&
        reply.browserApi &&
        reply.captionPipeline &&
        reply.standardPipeline &&
        reply.translateService &&
        reply.captionService &&
        reply.kymaService &&
        reply.srtService &&
        reply.ttsService &&
        reply.minimaxService &&
        reply.sonioxService &&
        reply.audioUtils &&
        reply.tokenGuard &&
        reply.groqService &&
        reply.openaiTts &&
        reply.overlayModule &&
        reply.subtitleOverlayModule &&
        reply.captionFallbackChoice &&
        reply.captionOrchestrator &&
        reply.localPanel &&
        reply.localPlayback &&
        reply.fullPrep) {
      return;
    }
    shouldReset = !!reply?.ok;
  } catch {
    // Not yet injected.
  }
  if (shouldReset) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try { window.YimuLocalPlayback?.close?.(); } catch {}
          delete window.__lumeoContentVersion;
          for (const key of [
            "LumeoBrowserApi",
            "LumeoTokenGuard",
            "LumeoAudioUtils",
            "LumeoOverlay",
            "LumeoSubtitleOverlay",
            "LumeoVoicePicker",
            "LumeoCaptionFallbackChoice",
            "LumeoProviders",
            "LumeoMiniMax",
            "LumeoTranslate",
            "LumeoSrtExport",
            "LumeoTTS",
            "LumeoOpenAITTS",
            "LumeoSonioxSTT",
            "LumeoGroqSTT",
            "LumeoCaptions",
            "LumeoKyma",
            "LumeoCaptionPipeline",
            "LumeoCaptionOrchestrator",
            "LumeoRealtimePipeline",
            "LumeoStandardPipeline",
            "YimuPanel",
            "YimuLocalPlayback",
            "YimuFullPrep",
            "__yimuLocalPlayback",
          ]) {
            try { delete window[key]; } catch {}
          }
          document.querySelectorAll(".ec-root, .yimu-panel, .yimu-panel-restore").forEach((el) => el.remove());
        },
      });
    } catch {
      // If reset fails, the following injection still covers fresh tabs.
    }
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPT_FILES,
  });
  // Inserting CSS via scripting API too, since content_scripts manifest entry
  // does not run on the just-injected page if the tab pre-existed extension.
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });
  } catch {
    // CSS may already be present from manifest static match — harmless.
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const migration = await chrome.storage.local.get("yimuDomesticPipelineV1");
  if (!migration.yimuDomesticPipelineV1) {
    Object.assign(stored, {
      translateProvider: "minimax",
      sttProvider: "minimax-asr",
      captionTtsProvider: "minimax-tts",
      dubProvider: "minimax-dub",
      standardVoice: "male-qn-qingse",
    });
    await chrome.storage.local.set({
      yimuDomesticPipelineV1: true,
      translateProvider: stored.translateProvider,
      sttProvider: stored.sttProvider,
      captionTtsProvider: stored.captionTtsProvider,
      dubProvider: stored.dubProvider,
      standardVoice: stored.standardVoice,
    });
  }
  if (stored.tier === "realtime") {
    stored.tier = "caption";
    await chrome.storage.local.set({ tier: "caption" });
  }
  Object.assign(state, stored);
  return stored;
}

async function persistSettings(partial) {
  if (partial.tier === "realtime") partial = { ...partial, tier: "caption" };
  Object.assign(state, partial);
  const persistable = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (k in partial) persistable[k] = state[k];
  }
  if (Object.keys(persistable).length) {
    await chrome.storage.local.set(persistable);
  }
}

async function handleStart(settings) {
  if (state.running || state.connecting) {
    // A quick SPA switch can reach Start before the tab update callback.
    const current = await activeYouTubeTab().catch(() => null);
    const nextVideoId = videoIdFromUrl(current?.url);
    if (state.running && current?.id === state.tabId && nextVideoId && nextVideoId !== state.videoId) {
      await handleStop();
    } else {
      return { ok: false, error: "已有会话正在运行。" };
    }
  }
  await persistSettings(settings || {});
  let tab;
  try {
    tab = await activeYouTubeTab();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const activeVideoId = videoIdFromUrl(tab.url);
  if (!activeVideoId) return { ok: false, error: "请先打开 YouTube 视频播放页。" };
  state.tabId = tab.id;
  state.videoId = activeVideoId;
  state.connecting = true;
  state.errorMessage = "";
  state.errorCode = "";
  state.missingProviders = [];
  state.slotsMissingKeys = [];
  state.status = "正在连接";
  broadcastToPopup();

  try {
    await ensureContentScript(tab.id);
    const reply = await relayToContent(tab.id, {
      type: "CONTENT_START",
      settings: snapshot(),
    });
    if (!reply?.ok) {
      state.connecting = false;
      state.running = false;
      state.errorMessage = reply?.error || "无法启动翻译。";
      state.errorCode = reply?.errorCode || "";
      state.missingProviders = reply?.missingProviders || [];
      state.slotsMissingKeys = reply?.slotsMissingKeys || [];
      state.status = state.errorMessage;
      state.tabId = null;
      state.videoId = null;
      broadcastToPopup();
      return {
        ok: false,
        error: state.errorMessage,
        errorCode: state.errorCode,
        missingProviders: state.missingProviders,
        slotsMissingKeys: state.slotsMissingKeys,
        state: snapshot(),
      };
    }
    state.connecting = false;
    state.running = true;
    state.status = settings?.targetLanguage === "zh-CN" || settings?.targetLanguage === "zh"
      ? "正在准备整片中文配音" : "正在翻译";
    broadcastToPopup();
    return { ok: true, state: snapshot() };
  } catch (err) {
    state.connecting = false;
    state.running = false;
    state.errorMessage = err.message || String(err);
    state.errorCode = err.errorCode || err.code || "";
    state.missingProviders = err.missingProviders || [];
    state.slotsMissingKeys = err.slotsMissingKeys || [];
    state.status = state.errorMessage;
    state.tabId = null;
    state.videoId = null;
    broadcastToPopup();
    return { ok: false, error: state.errorMessage };
  }
}

async function handleStop() {
  const tabId = state.tabId;
  state.running = false;
  state.connecting = false;
  state.paused = false;
  state.errorMessage = "";
  state.errorCode = "";
  state.missingProviders = [];
  state.slotsMissingKeys = [];
  state.status = "已停止";
  broadcastToPopup();
  if (tabId) {
    try {
      await relayToContent(tabId, { type: "CONTENT_STOP" });
    } catch {
      // Tab may be gone; that's fine.
    }
  }
  state.tabId = null;
  state.videoId = null;
  return { ok: true, state: snapshot() };
}

async function handleUpdateSettings(settings) {
  await persistSettings(settings || {});
  if (!state.running && !state.connecting) {
    state.errorMessage = "";
    state.errorCode = "";
    state.missingProviders = [];
    state.slotsMissingKeys = [];
    state.status = "已就绪";
  }
  broadcastToPopup();
  if (state.tabId && (state.running || state.connecting)) {
    try {
      const reply = await relayToContent(state.tabId, {
        type: "CONTENT_UPDATE_SETTINGS",
        settings: snapshot(),
      });
      if (reply?.state) Object.assign(state, reply.state);
    } catch (err) {
      state.errorMessage = err.message || String(err);
      broadcastToPopup();
    }
  }
  return { ok: true, state: snapshot() };
}

async function handleUpdateVolume(originalVolume, voiceVolume) {
  if (typeof originalVolume === "number") state.originalVolume = originalVolume;
  if (typeof voiceVolume === "number") state.voiceVolume = voiceVolume;
  // Persist debounced — slider drag fires many times.
  chrome.storage.local
    .set({ originalVolume: state.originalVolume, voiceVolume: state.voiceVolume })
    .catch(() => {});
  if (state.tabId) {
    try {
      await relayToContent(state.tabId, {
        type: "CONTENT_UPDATE_VOLUME",
        originalVolume: state.originalVolume,
        voiceVolume: state.voiceVolume,
      });
    } catch {
      // Tab gone; volume will be re-applied next start.
    }
  }
  return { ok: true };
}

// Content-side push: session live state + transient events.
function handleContentEvent(message) {
  if (message.type === "UPDATE_SETTINGS" && message.settings && typeof message.settings === "object") {
    void persistSettings(message.settings).then(() => broadcastToPopup());
  }
  if (message.type === "CONTENT_STATE") {
    if (typeof message.running === "boolean") state.running = message.running;
    if (typeof message.paused === "boolean") state.paused = message.paused;
    if (typeof message.status === "string") state.status = message.status;
    if (typeof message.errorMessage === "string") state.errorMessage = message.errorMessage;
    if (typeof message.errorCode === "string") state.errorCode = message.errorCode;
    if (Array.isArray(message.missingProviders)) state.missingProviders = message.missingProviders;
    if (Array.isArray(message.slotsMissingKeys)) state.slotsMissingKeys = message.slotsMissingKeys;
    broadcastToPopup();
  }
  if (message.type === "OPEN_POPUP_TO_SLOT") {
    chrome.runtime
      .sendMessage({ type: "OPEN_POPUP_TO_SLOT", slot: message.slot || message.provider || "" })
      .catch(() => {});
  }
  if (message.type === "CONTENT_ENDED") {
    state.running = false;
    state.connecting = false;
    state.paused = false;
    state.tabId = null;
    state.videoId = null;
    state.status = message.reason || "已停止";
    broadcastToPopup();
  }
}

function startSonioxWebSocket(apiKey, langHints) {
  closeSonioxWebSocket();

  sonioxWs = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");

  sonioxWs.onopen = () => {
    sonioxWs.send(JSON.stringify({
      api_key: apiKey,
      // stt-rt-v4 is the current real-time model. Soniox auto-routes
      // stt-rt-preview to v4 after 2026-02-28 but we pin the version
      // explicitly so a future rename fails loudly instead of silent drift.
      model: "stt-rt-v4",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      num_channels: 1,
      language_hints: langHints || [],
      enable_endpoint_detection: true,
      enable_language_identification: true,
    }));
    forwardToSonioxTab({ action: "sonioxStatus", status: "connected" });
  };

  sonioxWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.error_code) {
        forwardToSonioxTab({
          action: "sonioxError",
          error: `${data.error_code}: ${data.error_message}`,
        });
        closeSonioxWebSocket();
        return;
      }
      forwardToSonioxTab({ action: "sonioxResult", data });
    } catch {
      // Ignore malformed upstream frames; the next valid frame recovers.
    }
  };

  sonioxWs.onerror = () => {
    forwardToSonioxTab({ action: "sonioxError", error: "实时连接失败" });
  };

  sonioxWs.onclose = () => {
    forwardToSonioxTab({ action: "sonioxResult", data: { tokens: [], finished: true } });
    sonioxWs = null;
  };
}

function closeSonioxWebSocket() {
  if (!sonioxWs) return;
  try {
    if (sonioxWs.readyState === WebSocket.OPEN) sonioxWs.send("");
  } catch {
    // Best-effort flush before closing.
  }
  try { sonioxWs.close(); } catch {}
  sonioxWs = null;
}

function forwardToSonioxTab(msg) {
  if (sonioxTabId) chrome.tabs.sendMessage(sonioxTabId, msg).catch(() => {});
}

function handleLegacyCaptionMessage(message, sender, sendResponse) {
  switch (message?.action) {
    case "fetchUrl":
      fetchText(message.url)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "fetchJSON":
      fetchJSON(message.url, message)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "startSonioxWs":
      sonioxTabId = sender.tab?.id || state.tabId;
      startSonioxWebSocket(message.apiKey, message.langHints);
      sendResponse({ ok: true });
      return false;
    case "sonioxAudio":
      if (sonioxWs?.readyState === WebSocket.OPEN) {
        sonioxWs.send(new Int16Array(message.samples).buffer);
      }
      return false;
    case "stopSonioxWs":
      closeSonioxWebSocket();
      sendResponse({ ok: true });
      return false;
    case "captionCacheGet":
      readCaptionCache()
        .then((cache) => sendResponse({ ok: true, cache }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "captionCacheSet":
      writeCaptionCache(message.cache)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "captionCacheClear":
      writeCaptionCache({ entries: {}, stats: { bytes: 0, count: 0, clearedAt: Date.now() } })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    default:
      return null;
  }
}

// Popup → background → content router.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const legacyHandled = handleLegacyCaptionMessage(message, sender, sendResponse);
  if (legacyHandled !== null) return legacyHandled;

  // Content-originated messages (have sender.tab).
  if (sender.tab) {
    if (message?.type === "YIMU_LOCAL_SERVICE") {
      localServiceRequest(message, sender)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    handleContentEvent(message);
    sendResponse?.({ ok: true });
    return false;
  }

  // Popup-originated messages (no sender.tab).
  (async () => {
    try {
      switch (message?.type) {
        case "GET_STATE":
          await loadSettings();
          if (!state.running && !state.connecting) {
            state.errorMessage = "";
            state.errorCode = "";
            state.missingProviders = [];
            state.slotsMissingKeys = [];
            state.status = "已就绪";
          }
          sendResponse({ ok: true, state: snapshot() });
          break;
        case "START":
          sendResponse(await handleStart(message.settings));
          break;
        case "STOP":
          sendResponse(await handleStop());
          break;
        case "UPDATE_SETTINGS":
          sendResponse(await handleUpdateSettings(message.settings));
          break;
        case "UPDATE_VOLUME":
          sendResponse(await handleUpdateVolume(
            message.originalVolume,
            message.voiceVolume,
          ));
          break;
        case "OPEN_POPUP_TO_SLOT":
          chrome.runtime
            .sendMessage({ type: "OPEN_POPUP_TO_SLOT", slot: message.slot || message.provider || "" })
            .catch(() => {});
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "未知消息：" + message?.type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;  // async sendResponse
});

// Tab close / navigate away → stop session cleanly so Kyma sees the /end.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sonioxTabId) {
    closeSonioxWebSocket();
    sonioxTabId = null;
  }
  if (tabId === state.tabId) {
    void handleStop();
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== state.tabId) return;
  if (!changeInfo.url) return;
  // Time stamps, chapters, and hash changes on the same video keep its job.
  if (videoIdFromUrl(changeInfo.url) === state.videoId) return;
  const activeVideoId = state.videoId;
  void chrome.tabs.get(tabId).then((tab) => {
    // A delayed update from the previous video must not stop a new session.
    if (state.tabId === tabId && state.videoId === activeVideoId && videoIdFromUrl(tab.url) !== activeVideoId) {
      void handleStop();
    }
  }).catch(() => {
    if (state.tabId === tabId && state.videoId === activeVideoId) void handleStop();
  });
});

void loadSettings();
