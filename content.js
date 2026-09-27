// 译幕 content script — owns the in-page
// overlay panel, and YT video element capture. Background tells us when to
// start/stop/update; we tell background what's happening via CONTENT_STATE.
// Caption translation and audio dubbing share the YouTube page runtime.
//
// Layered: F9 version guard, F6 token-guarded async, F5 captureStream retry,
// F1 overlay panel, F2 history, F3 source captions.

(() => {
  // ───── F9 — Idempotent version guard ──────────────────────────────────────
  const LUMEO_VERSION = "1.2.3";
  const GLOBAL_KEY = "__lumeoContentVersion";
  if (window[GLOBAL_KEY] === LUMEO_VERSION) return;
  // Older copy may have left UI behind; clean up before re-installing listeners.
  document.querySelectorAll(".ec-root").forEach((el) => el.remove());
  window[GLOBAL_KEY] = LUMEO_VERSION;

  // ───── Suppress YouTube Polymer insertBefore errors ───────────────────────
  // YouTube's internal framework (Polymer/lit) uses insertBefore during SPA
  // navigation. Our DOM mutations can trigger its MutationObservers, which
  // then throw NotFoundError when reference nodes have been detached. These
  // errors are harmless but pollute chrome://extensions. Swallow them.
  window.addEventListener("error", (e) => {
    if (e.error?.name === "NotFoundError" && e.error?.message?.includes("insertBefore")) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener("unhandledrejection", (e) => {
    const err = e.reason;
    if (err?.name === "NotFoundError" && err?.message?.includes("insertBefore")) {
      e.preventDefault();
    }
  });

  // ───── Constants ──────────────────────────────────────────────────────────
  const SESSION_LIMIT_MS = 60 * 60 * 1000;
  const SESSION_WARNING_MS = 55 * 60 * 1000;
  const CAPTION_POLL_MS = 350;
  const HISTORY_MAX = 16;
  const VOICE_GAIN_MAX = 2.0;          // unity at slider 50, 2× boost at 100
  const LAYOUT_KEY = "lumeoOverlayLayout";
  const CAPTION_STYLE_KEY = "lumeoCaptionStyle";
  const RTL_LANGS = new Set(["ar", "fa", "he", "ur"]);

  const LANGUAGES = [
    ["en", "English"], ["vi", "Vietnamese"], ["ja", "Japanese"],
    ["ko", "Korean"], ["zh", "Chinese"], ["fr", "French"],
    ["es", "Spanish"], ["de", "German"], ["pt", "Portuguese"],
    ["hi", "Hindi"], ["id", "Indonesian"], ["it", "Italian"],
    ["ru", "Russian"],
  ];
  const LANG_NAME = Object.fromEntries(LANGUAGES);
  const chineseLanguageNames = new Intl.DisplayNames(["zh-CN"], { type: "language" });
  function displayLanguage(code, fallback = code) {
    if (code === "zh") return "中文";
    if (code === "zh-CN") return "简体中文";
    if (code === "zh-TW") return "繁体中文";
    try { return chineseLanguageNames.of(code) || fallback; } catch { return fallback; }
  }
  const STANDARD_DEFAULT_VOICE = window.LumeoVoicePicker?.STANDARD_DEFAULT_VOICE || "English_magnetic_voiced_man";
  const browserApi = window.LumeoBrowserApi;

  function getYouTubeVideoId() {
    try { return new URL(location.href).searchParams.get("v") || null; } catch { return null; }
  }

  function getYouTubeChannelId() {
    const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
    const channelMatch = canonical.match(/youtube\.com\/channel\/([^/?#]+)/i)
      || location.pathname.match(/^\/(?:channel|c|user|@)([^/?#]+)/i);
    return channelMatch?.[1] || null;
  }

  function getOverlayLayoutKey() {
    const videoId = getYouTubeVideoId();
    if (videoId) return `${LAYOUT_KEY}:video:${videoId}`;
    const channelId = getYouTubeChannelId();
    return channelId ? `${LAYOUT_KEY}:channel:${channelId}` : LAYOUT_KEY;
  }

  // Standard pipeline tunables. CHUNK_MS too short = wasteful per-call
  // overhead; too long = unbearable lag. 5s is the sweet spot for podcast/
  // keynote speech where sentences average 3-6s.
  const STANDARD_CHUNK_MS = window.LumeoStandardPipeline?.DEFAULT_CHUNK_MS || 5000;

  // ───── F6 — Token-guarded session state ───────────────────────────────────
  // Every async callback that could mutate session state captures `pageToken`
  // in closure and checks `if (token !== pageToken) return` before mutating.
  // Each new session bumps pageToken so stale callbacks are silently dropped.
  let pageToken = 0;
  let session = null;     // active session
  let settings = null;
  let currentTargetText = "";
  let currentSourceText = "";
  let lastDisplayedCue = null;
  let captionPollTimer = null;
  let warningTimer = null;
  let limitTimer = null;
  let warningShown = false;
  let videoEl = null;
  let onYTPause = null;
  let onYTPlay = null;
  let lastSpaUrl = location.href;
  let sessionVideoId = null;
  let captionStyle = loadCaptionStyle();

  // ───── Background channel ─────────────────────────────────────────────────
  function notifyBackground(msg) {
    browserApi.sendRuntimeMessage(msg).catch(() => {});
  }
  function emitState(partial) {
    notifyBackground({ type: "CONTENT_STATE", ...partial });
  }
  function emitEnded(reason) {
    notifyBackground({ type: "CONTENT_ENDED", reason });
  }

  // ───── F1 — Overlay panel ─────────────────────────────────────────────────
  function createInlineOverlayController(options = {}) {
    const doc = options.document || document;
    const languages = options.languages || [];
    let inlineRoot = null;
    let inlineElements = {};

    function build() {
      if (inlineRoot) return inlineRoot;
      inlineRoot = doc.createElement("aside");
      inlineRoot.className = "ec-root is-side-collapsed";
      inlineRoot.dataset.state = "ready";
      inlineRoot.innerHTML = `
        <div class="ec-toolbar" data-ec-drag>
          <span class="ec-dot"></span>
          <select class="ec-select" data-ec-language aria-label="目标语言"></select>
          <span class="ec-toolbar-cap" data-ec-tts-cap hidden>朗读</span>
          <select class="ec-select" data-ec-voice aria-label="声音"></select>
          <span class="ec-spacer"></span>
          <button class="ec-btn" type="button" data-ec-pip aria-label="切换画中画字幕" title="画中画字幕">PiP</button>
          <button class="ec-btn" type="button" data-ec-settings title="设置">⚙️</button>
          <button class="ec-btn" type="button" data-ec-help aria-label="快捷键" title="快捷键（? 或 h）">?</button>
          <button class="ec-btn" type="button" data-ec-hide title="展开译幕控件">展开</button>
          <button class="ec-btn ec-btn-primary" type="button" data-ec-stop>停止</button>
        </div>
        <div class="ec-style-popover" data-ec-settings-panel hidden>
          <label><span>字号</span> <input type="range" data-ec-style-size min="12" max="36" step="1"><output data-ec-style-size-value></output></label>
          <label><span>位置</span> <input type="range" data-ec-style-position min="0" max="80" step="1"><output data-ec-style-position-value></output></label>
          <label class="ec-style-field-select"><span>布局</span><select class="ec-select" data-ec-layout-preset><option value="stacked">双语叠加</option><option value="translated-only">仅显示译文</option><option value="source-only">仅显示原文</option></select></label>
          <label><span>原声音量</span><input type="range" data-ec-original-volume min="0" max="100" step="1"><output data-ec-original-volume-value></output></label>
          <label><span>配音音量</span><input type="range" data-ec-voice-volume min="0" max="100" step="1"><output data-ec-voice-volume-value></output></label>
          <label><span>静音原声</span><input type="checkbox" data-ec-mute-original></label>
          <label><span>显示译文</span><input type="checkbox" data-ec-show-translated></label>
          <label><span>显示原文</span><input type="checkbox" data-ec-show-source></label>
          <label><span>高对比度</span><input type="checkbox" data-ec-high-contrast></label>
        </div>
      `;
      doc.documentElement.appendChild(inlineRoot);
      inlineElements = {
        langSelect: inlineRoot.querySelector("[data-ec-language]"),
        voiceSelect: inlineRoot.querySelector("[data-ec-voice]"),
        ttsCap: inlineRoot.querySelector("[data-ec-tts-cap]"),
        hideBtn: inlineRoot.querySelector("[data-ec-hide]"),
        stopBtn: inlineRoot.querySelector("[data-ec-stop]"),
        pipBtn: inlineRoot.querySelector("[data-ec-pip]"),
        helpBtn: inlineRoot.querySelector("[data-ec-help]"),
        settingsBtn: inlineRoot.querySelector("[data-ec-settings]"),
        settingsPanel: inlineRoot.querySelector("[data-ec-settings-panel]"),
        styleSize: inlineRoot.querySelector("[data-ec-style-size]"),
        styleSizeValue: inlineRoot.querySelector("[data-ec-style-size-value]"),
        stylePosition: inlineRoot.querySelector("[data-ec-style-position]"),
        stylePositionValue: inlineRoot.querySelector("[data-ec-style-position-value]"),
        layoutPreset: inlineRoot.querySelector("[data-ec-layout-preset]"),
        highContrast: inlineRoot.querySelector("[data-ec-high-contrast]"),
        originalVolume: inlineRoot.querySelector("[data-ec-original-volume]"),
        originalVolumeValue: inlineRoot.querySelector("[data-ec-original-volume-value]"),
        voiceVolume: inlineRoot.querySelector("[data-ec-voice-volume]"),
        voiceVolumeValue: inlineRoot.querySelector("[data-ec-voice-volume-value]"),
        muteOriginal: inlineRoot.querySelector("[data-ec-mute-original]"),
        showTranslated: inlineRoot.querySelector("[data-ec-show-translated]"),
        showSource: inlineRoot.querySelector("[data-ec-show-source]"),
        target: null,
        source: null,
        history: null,
      };
      for (const [code, name] of languages) {
        const opt = doc.createElement("option");
        opt.value = code;
        opt.textContent = displayLanguage(code, name);
        inlineElements.langSelect?.appendChild(opt);
      }
      inlineElements.settingsBtn?.addEventListener("click", () => {
        if (inlineElements.settingsPanel) inlineElements.settingsPanel.hidden = !inlineElements.settingsPanel.hidden;
      });
      inlineElements.helpBtn?.addEventListener("click", () => showToast("快捷键：Esc 收起；? 或 h 查看帮助；Ctrl/Cmd+Shift+L 显示或隐藏", 6000));
      inlineElements.hideBtn?.addEventListener("click", () => toggleSideCollapsed());
      return inlineRoot;
    }

    function destroy() {
      inlineRoot?.remove();
      inlineRoot = null;
      inlineElements = {};
    }

    function toggleSideCollapsed() {
      if (!inlineRoot) return;
      inlineRoot.classList.toggle("is-side-collapsed");
      const collapsed = inlineRoot.classList.contains("is-side-collapsed");
      if (inlineElements.hideBtn) {
        inlineElements.hideBtn.textContent = collapsed ? "展开" : "收起";
        inlineElements.hideBtn.title = collapsed ? "展开译幕控件" : "收起译幕控件";
      }
    }

    function showToast(text, opts, durationMs) {
      if (!inlineRoot) return;
      if (typeof opts === "number") durationMs = opts;
      const toast = doc.createElement("div");
      toast.className = "ec-toast";
      toast.textContent = String(text || "");
      inlineRoot.appendChild(toast);
      setTimeout(() => toast.remove(), durationMs || 8000);
    }

    return {
      build,
      destroy,
      getRoot: () => inlineRoot,
      getElements: () => inlineElements,
      applyLayout: () => {},
      refreshLayoutKey: () => {},
      applyCaptionStyle: () => {},
      syncCaptionControls: (captionStyle = {}) => {
        if (inlineElements.styleSize) inlineElements.styleSize.value = String(captionStyle.fontSize || 22);
        if (inlineElements.styleSizeValue) inlineElements.styleSizeValue.value = `${captionStyle.fontSize || 22}px`;
        if (inlineElements.stylePosition) inlineElements.stylePosition.value = String(captionStyle.bottomOffset || 14);
        if (inlineElements.stylePositionValue) inlineElements.stylePositionValue.value = `${captionStyle.bottomOffset || 14}%`;
        if (inlineElements.highContrast) inlineElements.highContrast.checked = !!captionStyle.highContrast;
        if (inlineElements.layoutPreset) inlineElements.layoutPreset.value = captionStyle.layoutPreset || "stacked";
        if (inlineElements.originalVolume) inlineElements.originalVolume.value = String(captionStyle.originalVolume ?? 18);
        if (inlineElements.originalVolumeValue) inlineElements.originalVolumeValue.value = String(captionStyle.originalVolume ?? 18);
        if (inlineElements.voiceVolume) inlineElements.voiceVolume.value = String(captionStyle.voiceVolume ?? 100);
        if (inlineElements.voiceVolumeValue) inlineElements.voiceVolumeValue.value = String(captionStyle.voiceVolume ?? 100);
        if (inlineElements.muteOriginal) inlineElements.muteOriginal.checked = !!captionStyle.muteOriginal;
        if (inlineElements.showTranslated) inlineElements.showTranslated.checked = captionStyle.showTranslatedSub !== false;
        if (inlineElements.showSource) inlineElements.showSource.checked = captionStyle.showSourceSub !== false;
      },
      setState: (state) => { if (inlineRoot) inlineRoot.dataset.state = state; },
      setStatusText: () => {},
      showToast,
      toggleSideCollapsed,
    };
  }

  const subtitleOverlay = window.LumeoSubtitleOverlay?.createSubtitleOverlayController?.();
  const overlayController = window.LumeoOverlay?.createOverlayController?.({
    layoutKey: getOverlayLayoutKey,
    languages: LANGUAGES,
    collapsedOnStart: true,
  }) || createInlineOverlayController({ languages: LANGUAGES });
  let root = null;
  let elements = {};

  function loadCaptionStyle() {
    try {
      return {
        fontSize: 22,
        bottomOffset: 14,
        highContrast: false,
        showSource: true,
        muteOriginal: false,
        originalVolume: settings?.originalVolume ?? 18,
        voiceVolume: settings?.voiceVolume ?? 100,
        showTranslatedSub: true,
        showSourceSub: true,
        layoutPreset: "stacked",
        ...JSON.parse(localStorage.getItem(CAPTION_STYLE_KEY) || "{}"),
      };
    } catch {
      return { fontSize: 22, bottomOffset: 14, highContrast: false, showSource: true, muteOriginal: false, showTranslatedSub: true, showSourceSub: true, layoutPreset: "stacked" };
    }
  }
  function saveCaptionStyle() {
    try { localStorage.setItem(CAPTION_STYLE_KEY, JSON.stringify(captionStyle)); } catch {}
  }
  function applyLayoutPreset(preset) {
    captionStyle.layoutPreset = preset || "stacked";
    if (captionStyle.layoutPreset === "translated-only") {
      captionStyle.showTranslatedSub = true;
      captionStyle.showSourceSub = false;
      captionStyle.showSource = false;
    } else if (captionStyle.layoutPreset === "source-only") {
      captionStyle.showTranslatedSub = false;
      captionStyle.showSourceSub = true;
      captionStyle.showSource = true;
    } else {
      captionStyle.showTranslatedSub = true;
      captionStyle.showSourceSub = true;
      captionStyle.showSource = true;
    }
  }
  function applyCaptionStyle() {
    if (!root) return;
    overlayController?.applyCaptionStyle(captionStyle);
    subtitleOverlay?.applyStyle(captionStyle);
    const video = videoEl || findVideo();
    if (video) video.muted = !!captionStyle.muteOriginal;
  }

  function buildOverlay() {
    if (root) return;
    if (!overlayController) throw new Error("译幕悬浮控件未加载");
    root = overlayController.build();
    elements = overlayController.getElements();

    populateVoicePicker(settings?.tier || "caption");
    elements.langSelect.value = settings?.targetLanguage || "zh-CN";

    elements.langSelect.addEventListener("change", () => {
      const newLang = elements.langSelect.value;
      if (settings?.tier === "caption") {
        settings.targetLanguage = newLang;
        notifyBackground({ type: "UPDATE_SETTINGS", settings: { targetLanguage: newLang } });
        showToast("请停止后重新开始，以翻译新的目标语言", 5000);
      } else if (settings?.tier === "standard") {
        settings.targetLanguage = newLang;
        notifyBackground({ type: "UPDATE_SETTINGS", settings: { targetLanguage: newLang } });
        setStatusText("正在切换为" + displayLanguage(newLang));
        setOverlayState("live");
      }
    });
    elements.voiceSelect.addEventListener("change", () => {
      const newVoice = elements.voiceSelect.value;
      if (settings?.tier === "caption") {
        settings.captionTtsProvider = newVoice;
        notifyBackground({ type: "UPDATE_SETTINGS", settings: { captionTtsProvider: newVoice } });
      } else if (settings?.tier === "standard") {
        settings.standardVoice = newVoice;
        notifyBackground({ type: "UPDATE_SETTINGS", settings: { standardVoice: newVoice } });
      }
    });
    elements.hideBtn.addEventListener("click", () => overlayController.toggleSideCollapsed());
    elements.stopBtn.addEventListener("click", () => {
      stopSession("user-stop");
      notifyBackground({ type: "CONTENT_STATE", running: false, status: "已停止" });
      emitEnded("已停止");
    });
    elements.pipBtn?.addEventListener("click", async () => {
      const result = await subtitleOverlay?.togglePictureInPicture?.();
      if (!result?.ok) {
        showToast("画中画字幕需要 Chrome 支持文档画中画", 5000);
        return;
      }
      showToast(result.open ? "画中画字幕已开启" : "画中画字幕已关闭", 2000);
    });
    elements.originalVolume?.addEventListener("input", () => {
      const value = Number(elements.originalVolume.value);
      captionStyle.originalVolume = value;
      settings = { ...(settings || {}), originalVolume: value };
      saveCaptionStyle();
      overlayController.syncCaptionControls(captionStyle);
      applyVolumes(settings.originalVolume, settings.voiceVolume);
      notifyBackground({ type: "UPDATE_SETTINGS", settings: { originalVolume: value } });
    });
    elements.voiceVolume?.addEventListener("input", () => {
      const value = Number(elements.voiceVolume.value);
      captionStyle.voiceVolume = value;
      settings = { ...(settings || {}), voiceVolume: value };
      saveCaptionStyle();
      overlayController.syncCaptionControls(captionStyle);
      applyVolumes(settings.originalVolume, settings.voiceVolume);
      notifyBackground({ type: "UPDATE_SETTINGS", settings: { voiceVolume: value } });
    });
    elements.muteOriginal?.addEventListener("change", () => {
      captionStyle.muteOriginal = elements.muteOriginal.checked;
      settings = { ...(settings || {}), originalVolume: captionStyle.muteOriginal ? 0 : (captionStyle.originalVolume || 18) };
      saveCaptionStyle();
      applyCaptionStyle();
      applyVolumes(settings.originalVolume, settings.voiceVolume);
      notifyBackground({ type: "UPDATE_SETTINGS", settings: { originalVolume: settings.originalVolume } });
    });
    elements.showTranslated?.addEventListener("change", () => {
      captionStyle.showTranslatedSub = elements.showTranslated.checked;
      saveCaptionStyle();
      applyCaptionStyle();
    });
    elements.showSource?.addEventListener("change", () => {
      captionStyle.showSourceSub = elements.showSource.checked;
      captionStyle.showSource = elements.showSource.checked;
      saveCaptionStyle();
      applyCaptionStyle();
    });
    elements.styleSize?.addEventListener("input", () => {
      captionStyle.fontSize = Number(elements.styleSize.value);
      saveCaptionStyle();
      overlayController.syncCaptionControls(captionStyle);
      applyCaptionStyle();
    });
    elements.stylePosition?.addEventListener("input", () => {
      captionStyle.bottomOffset = Number(elements.stylePosition.value);
      saveCaptionStyle();
      overlayController.syncCaptionControls(captionStyle);
      applyCaptionStyle();
    });
    elements.layoutPreset?.addEventListener("change", () => {
      applyLayoutPreset(elements.layoutPreset.value);
      saveCaptionStyle();
      overlayController.syncCaptionControls(captionStyle);
      applyCaptionStyle();
      setTargetCue(lastDisplayedCue);
    });
    elements.highContrast?.addEventListener("change", () => {
      captionStyle.highContrast = elements.highContrast.checked;
      saveCaptionStyle();
      applyCaptionStyle();
    });

    captionStyle.originalVolume = settings?.originalVolume ?? captionStyle.originalVolume ?? 18;
    captionStyle.voiceVolume = settings?.voiceVolume ?? captionStyle.voiceVolume ?? 100;
    captionStyle.muteOriginal = (settings?.originalVolume ?? captionStyle.originalVolume) === 0 || !!captionStyle.muteOriginal;

    if (elements.pipBtn && !subtitleOverlay?.isPictureInPictureSupported?.()) {
      elements.pipBtn.setAttribute("aria-disabled", "true");
      elements.pipBtn.title = "此浏览器不支持画中画字幕";
    }
    overlayController.syncCaptionControls(captionStyle);
    applyCaptionStyle();
  }

  function applyTierToolbar() {
    if (elements.exportBtn) elements.exportBtn.hidden = !session;
    if (elements.ttsCap) elements.ttsCap.hidden = settings?.tier !== "caption";
  }

  function populateVoicePicker(tier) {
    window.LumeoVoicePicker?.populate(elements.voiceSelect, tier, settings || {});
  }

  function setOverlayState(state) {
    overlayController?.setState(state);
  }
  function setStatusText(text) {
    overlayController?.setStatusText(text);
  }
  function setTargetText(text) {
    const value = text == null ? "" : String(text);
    if (elements.target) {
      elements.target.textContent = value;
      const lang = settings?.targetLanguage;
      elements.target.dir = RTL_LANGS.has(lang) ? "rtl" : "ltr";
    }
    subtitleOverlay?.updateCue(value ? { text: value, translated: value } : null, {
      captionStyle,
      targetLanguage: settings?.targetLanguage,
      rtlLangs: RTL_LANGS,
    });
  }
  /**
   * Show a cue as a proper bilingual subtitle pair:
   *   Line 1 (bold): translated text
   *   Line 2 (dim):  original source text (if showSource enabled)
   * Updates BOTH the panel target and the in-video subtitle overlay.
   */
  function setTargetCue(cue) {
    lastDisplayedCue = cue || null;
    // Update the side panel target
    if (elements.target) {
      elements.target.textContent = "";
      if (cue) {
        if (captionStyle.layoutPreset !== "source-only") {
          const translated = document.createElement("div");
          translated.className = "ec-target-translated";
          translated.textContent = cue.translated || cue.text || "";
          elements.target.appendChild(translated);
        }
        if (captionStyle.showSource !== false && captionStyle.layoutPreset !== "translated-only" && cue.text && cue.text !== cue.translated) {
          const source = document.createElement("div");
          source.className = "ec-target-source";
          source.textContent = cue.text;
          elements.target.appendChild(source);
        }
        const lang = settings?.targetLanguage;
        elements.target.dir = RTL_LANGS.has(lang) ? "rtl" : "ltr";
      }
    }
    subtitleOverlay?.updateCue(cue, {
      captionStyle,
      targetLanguage: settings?.targetLanguage,
      rtlLangs: RTL_LANGS,
    });
  }
  function showToast(text, opts, durationMs) {
    overlayController?.showToast(text, opts, durationMs);
  }
  function removeOverlay() {
    if (!root) return;
    overlayController?.destroy();
    root = null;
    elements = {};
    subtitleOverlay?.remove();
  }

  // ───── F3 — Source caption polling ────────────────────────────────────────
  let lastSeenCaption = "";
  const readYTCaptions = window.LumeoCaptions?.readYTCaptions || (() => "");
  function startCaptionPoll() {
    stopCaptionPoll();
    lastSeenCaption = "";
    captionPollTimer = setInterval(() => {
      if (!settings?.showSource) return;
      const text = readYTCaptions();
      if (!text || text === lastSeenCaption) return;
      lastSeenCaption = text;
      currentSourceText = text;
      if (elements.source) {
        elements.source.textContent = text.slice(-220);
      }
    }, CAPTION_POLL_MS);
  }
  function stopCaptionPoll() {
    if (captionPollTimer) {
      clearInterval(captionPollTimer);
      captionPollTimer = null;
    }
  }
  function applySourceVisibility() {
    if (!elements.source) return;
    elements.source.hidden = !settings?.showSource;
  }

  // ───── F5 — captureStream re-acquisition with playback nudge ──────────────
  // Audio helpers live in lib/audio-utils.js so the Standard pipeline and
  // the Groq/OpenAI direct pipelines can reuse them. We keep local aliases
  // so the rest of this file reads the same as before the split.
  const _audioUtils = window.LumeoAudioUtils;
  if (!_audioUtils) {
    console.error("[译幕] lib/audio-utils.js not loaded — aborting.");
    return;
  }
  const findVideo = _audioUtils.findVideo;
  const nudgePlay = _audioUtils.nudgePlay;
  const captureWithRetry = _audioUtils.captureWithRetry;
  const _kyma = window.LumeoKyma;
  if (!_kyma) {
    console.error("[译幕] services/kyma-client.js not loaded — aborting.");
    return;
  }

  // ───── Heartbeat + session timer (60-min cap, one-shot 55-min warning) ────
  function startSessionTimer() {
    clearSessionTimer();
    warningShown = false;
    warningTimer = setTimeout(() => {
      if (warningShown) return;
      warningShown = true;
      showToast("当前会话将在 5 分钟后结束", 6000);
    }, SESSION_WARNING_MS);
    limitTimer = setTimeout(() => {
      stopSession("auto-stop-60min");
      emitEnded("已在 60 分钟后自动停止；请重新开始以继续。");
    }, SESSION_LIMIT_MS);
  }
  function clearSessionTimer() {
    if (warningTimer) { clearTimeout(warningTimer); warningTimer = null; }
    if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
  }

  function computeGain(voiceVolume) {
    return voiceVolume === 0 ? 0 : (voiceVolume / 100) * VOICE_GAIN_MAX;
  }

  function applyVolumes(originalVolume, voiceVolume) {
    if (videoEl) {
      videoEl.volume = (originalVolume ?? 18) / 100;
      videoEl.muted = (originalVolume ?? 0) === 0;
    }
    if (session?.outputGain) {
      session.outputGain.gain.value = computeGain(voiceVolume ?? 100);
    } else if (session?.remoteAudio) {
      session.remoteAudio.volume = Math.min((voiceVolume ?? 100) / 100, 1.0);
      session.remoteAudio.muted = voiceVolume === 0;
    }
  }

  // ───── Synchronized chunked dubbing ───────────────────────────────────────
  function seekVideo(video, time) {
    if (Math.abs(video.currentTime - time) < 0.05) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener("seeked", done);
        resolve();
      };
      video.addEventListener("seeked", done, { once: true });
      try { video.currentTime = time; } catch { done(); }
      setTimeout(done, 1800);
    });
  }

  async function startStandardSession() {
    const useMiniMax = settings.dubProvider === "minimax-dub";
    if (useMiniMax && !settings.minimaxKey) {
      return {
        ok: false,
        error: "请在标准配音设置中填写 MiniMax API 密钥后重新开始。",
        errorCode: "missing-dub-key",
        missingProviders: ["minimax-dub"],
        slotsMissingKeys: ["dubPipeline"],
      };
    }
    if (!useMiniMax && !settings.kymaKey) {
      return {
        ok: false,
        error: "请在标准配音设置中填写 Kyma 密钥后重新开始。",
        errorCode: "missing-dub-key",
        missingProviders: ["kyma"],
        slotsMissingKeys: ["dubPipeline"],
      };
    }
    const video = findVideo();
    if (!video) return { ok: false, error: "当前页面没有 YouTube 视频。" };
    videoEl = video;
    const token = ++pageToken;
    const initialTime = video.currentTime;
    const savedVideoVisibility = video.style.visibility;
    video.style.visibility = "hidden";
    video.pause();
    video.muted = true;

    let stream;
    try {
      buildOverlay();
      setStatusText("正在准备第一段配音");
      setOverlayState("connecting");
      stream = await captureWithRetry(video);
      video.pause();
      await seekVideo(video, initialTime);
      if (token !== pageToken) {
        stream.getTracks().forEach((track) => track.stop());
        video.pause();
        video.style.visibility = savedVideoVisibility;
        return { ok: false, error: "启动已取消。" };
      }
    } catch (err) {
      video.pause();
      video.style.visibility = savedVideoVisibility;
      removeOverlay();
      return { ok: false, error: err.message || "无法采集 YouTube 音频，请先播放视频后重试。" };
    }

    const recorderMime = window.LumeoStandardPipeline.pickRecorderMime(_audioUtils);
    if (!recorderMime) {
      stream.getTracks().forEach((t) => t.stop());
      video.style.visibility = savedVideoVisibility;
      removeOverlay();
      return { ok: false, error: "此浏览器无法录制标准配音所需的 YouTube 音频，请使用 Chrome 或 Edge 重试。" };
    }

    let audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      video.style.visibility = savedVideoVisibility;
      removeOverlay();
      return { ok: false, error: "音频处理不可用：" + err.message };
    }
    const outputGain = audioCtx.createGain();
    outputGain.gain.value = computeGain(settings.voiceVolume ?? 100);
    outputGain.connect(audioCtx.destination);

    const newSession = {
      token,
      type: "standard",
      stream,
      audioCtx,
      outputGain,
      remoteAudio: null,
      pc: null,
      dc: null,
      kymaSessionId: null,
      kymaKey: settings.kymaKey,
      recorderMime,
      activeRecorder: null,
      nextPlayAt: 0,
      stopFlag: false,
      paused: false,
      pauseEpoch: 0,
      playingSources: new Set(),
      savedVideoVisibility,
      phase: "buffering",
      playbackSegment: null,
      preparedAudio: null,
      // One AbortController for the whole session — every fetch in
      // processStandardChunk hangs off this signal so a Stop click cancels
      // in-flight whisper/translate/TTS calls instead of silently burning
      // ~5-10s of Kyma credits per orphaned pipeline.
      abortController: new AbortController(),
    };
    session = newSession;
    applyTierToolbar();

    setStatusText("正在准备第一段配音");
    setOverlayState("connecting");
    startSessionTimer();
    applyVolumes(settings.originalVolume, settings.voiceVolume);
    applySourceVisibility();
    if (settings.showSource) startCaptionPoll();

    onYTPause = () => {
      if (newSession.ignoreNextPause) {
        newSession.ignoreNextPause = false;
        return;
      }
      window.LumeoStandardPipeline.pauseSession(newSession);
      video.style.visibility = savedVideoVisibility;
      setStatusText("已暂停");
      setOverlayState("paused");
      emitState({ paused: true, status: "已暂停" });
    };
    onYTPlay = () => {
      if (newSession.ignoreNextPlay) {
        newSession.ignoreNextPlay = false;
        return;
      }
      window.LumeoStandardPipeline.resumeSession(newSession);
      if (newSession.phase !== "replay") {
        newSession.ignoreNextPause = !video.paused;
        video.pause();
        setStatusText("正在准备中文配音");
        setOverlayState("connecting");
        return;
      }
      if (newSession.playbackSegment?.audioBuffer) {
        const segment = newSession.playbackSegment;
        window.LumeoStandardPipeline.playBuffer(newSession, segment.audioBuffer, {
          segmentDuration: segment.endTime - segment.startTime,
          videoOffset: Math.max(0, video.currentTime - segment.startTime),
        });
      }
      setStatusText("正在配音");
      setOverlayState("live");
      emitState({ paused: false, status: "正在配音" });
    };
    video.addEventListener("pause", onYTPause);
    video.addEventListener("play", onYTPlay);

    void window.LumeoStandardPipeline.runSynchronizedLoop(newSession, {
      getActiveSession: () => session,
      processChunk: (sessionRef, blob) => window.LumeoStandardPipeline.processChunk(sessionRef, blob, standardPipelineContext()),
      chunkMs: STANDARD_CHUNK_MS,
      onCaptureStart: async (sessionRef) => {
        sessionRef.phase = "capture";
        video.style.visibility = "hidden";
        video.muted = true;
        setStatusText("正在准备下一段配音");
        setOverlayState("connecting");
        const startTime = video.currentTime;
        sessionRef.ignoreNextPlay = video.paused;
        await video.play();
        return startTime;
      },
      onCaptureEnd: (sessionRef) => {
        const endTime = video.currentTime;
        sessionRef.ignoreNextPause = !video.paused;
        video.pause();
        sessionRef.phase = "buffering";
        setStatusText("正在识别和生成中文语音");
        return endTime;
      },
      onDiscard: async (sessionRef, startTime) => {
        if (session !== sessionRef || sessionRef.stopFlag) return;
        await seekVideo(video, startTime);
        video.style.visibility = savedVideoVisibility;
        sessionRef.phase = "buffering";
      },
      onPlayback: async (sessionRef, segment) => {
        await seekVideo(video, segment.startTime);
        if (sessionRef.stopFlag || sessionRef.paused || session !== sessionRef) return;
        sessionRef.playbackSegment = segment;
        sessionRef.phase = "replay";
        video.style.visibility = savedVideoVisibility;
        applyVolumes(settings.originalVolume, settings.voiceVolume);
        sessionRef.ignoreNextPlay = video.paused;
        await video.play();
        if (segment.audioBuffer) {
          window.LumeoStandardPipeline.playBuffer(sessionRef, segment.audioBuffer, {
            segmentDuration: segment.endTime - segment.startTime,
          });
        }
        setStatusText("正在配音");
        setOverlayState("live");
        emitState({ running: true, paused: false, status: "正在配音" });
        while (session === sessionRef && !sessionRef.stopFlag &&
            video.currentTime < segment.endTime - 0.06 &&
            video.currentTime >= segment.startTime - 0.3) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (session !== sessionRef || sessionRef.stopFlag) return;
        sessionRef.playbackSegment = null;
        window.LumeoStandardPipeline.stopPlayingSources(sessionRef);
        sessionRef.ignoreNextPause = !video.paused;
        video.pause();
        sessionRef.phase = "buffering";
      },
      onError: (error) => {
        const message = error?.message || "配音准备失败。";
        stopSession("pipeline-error");
        emitEnded(message);
      },
    });
    emitState({ running: true, paused: false, status: "正在准备第一段配音" });
    return { ok: true };
  }


  function standardPipelineContext() {
    return {
      getActiveSession: () => session,
      getPageToken: () => pageToken,
      getSettings: () => settings || {},
      langNameByCode: LANG_NAME,
      standardDefaultVoice: STANDARD_DEFAULT_VOICE,
      kymaBase: _kyma.KYMA_BASE,
      parseKymaError: _kyma.parseError,
      audioUtils: _audioUtils,
      miniMax: window.LumeoMiniMax,
      translate: window.LumeoTranslate,
      fetch,
      FormData,
      onSourceText: (text) => {
        currentSourceText = text;
        if (elements.source && settings.showSource) elements.source.textContent = text.slice(-220);
      },
      onTargetText: (text) => {
        currentTargetText = text;
        setTargetText(text);
        setOverlayState("live");
      },
      onError: (parsed) => {
        showStandardError(parsed);
        if (session?.type === "standard") session.preparationError = new Error(parsed.user || "配音准备失败。");
      },
      onAudioReady: (sessionRef, audioBuffer) => { sessionRef.preparedAudio = audioBuffer; },
      onChunkDone: () => {},
    };
  }

  function showStandardError(parsed) {
    setStatusText(parsed.user || "配音流程出错");
    showToast(parsed.user, { cta: parsed.cta, ctaLabel: parsed.ctaLabel }, 6000);
  }

  // ───── Start session (token-bumped on each call) ──────────────────────────
  async function startSession(incomingSettings) {
    // The viewer may start the next video before the SPA navigation timer runs.
    if (session && sessionVideoId !== getYouTubeVideoId()) stopSession("yt-navigation");
    if (session) return { ok: false, error: "已有会话正在运行。" };
    sessionVideoId = getYouTubeVideoId();
    settings = { ...incomingSettings };
    history = [];
    currentTargetText = "";
    currentSourceText = "";

    // Whole-video preparation is the default Chinese dubbing path. The
    // preparation task runs asynchronously so closing the popup never stops it.
    if (settings.targetLanguage === "zh-CN" || settings.targetLanguage === "zh") {
      videoEl = videoEl || findVideo();
      if (!videoEl) return { ok: false, error: "当前页面没有 YouTube 视频。" };
      if (!settings.minimaxKey) return { ok: false, error: "请先填写 MiniMax API 密钥。" };
      if (!window.YimuFullPrep || !window.YimuLocalPlayback) {
        return { ok: false, error: "整片准备组件未加载，请重新加载扩展和视频页。" };
      }
      pageToken++;
      const fullSession = { type: "full", controller: null, jobCreated: false };
      session = fullSession;
      fullSession.controller = window.YimuFullPrep.start({
        video: videoEl,
        settings,
        onJobCreated: () => {
          if (session !== fullSession) return;
          fullSession.jobCreated = true;
          emitState({ running: true, paused: false, status: "正在准备整片中文配音" });
        },
        onError: (error) => {
          if (session !== fullSession) return;
          session = null;
          emitState({ running: false, paused: false, status: "整片准备失败", errorMessage: error?.message || String(error) });
        },
      });
      emitState({ running: true, paused: false, status: "正在准备整片字幕" });
      return { ok: true };
    }

    if (settings.tier === "caption") {
      console.log("[译幕] Starting caption tier, checking orchestrator...");
      if (!window.LumeoCaptionOrchestrator) {
        console.error("[译幕] 字幕协调模块未加载");
        return { ok: false, error: "译幕字幕组件未加载" };
      }
      console.log("[译幕] 字幕协调模块已加载，开始处理");
      videoEl = videoEl || findVideo();
      pageToken++;
      return window.LumeoCaptionOrchestrator.start({
        getSession: () => session,
        getSettings: () => settings,
        getPageToken: () => pageToken,
        getVideo: () => videoEl,
        getElements: () => elements,
        getLangName: (code) => LANG_NAME[code],
        getTranscriptController: () => null,
        applyTierToolbar,
        setStatusText,
        setOverlayState,
        showToast,
        setTargetCue,
        setTargetText,
        applySourceVisibility,
        removeOverlay,
        buildOverlay,
        captureWithRetry,
        readYTCaptions,
        onSessionCreated: (newSession) => { session = newSession; },
        onSessionEnded: (reason, msg) => { stopSession(reason); emitEnded(msg || reason); },
        onStateChange: (partial) => { emitState(partial); },
        onUpdateSettings: (newSettings) => { notifyBackground({ type: "UPDATE_SETTINGS", settings: newSettings }); },
        onOpenPopup: (slot) => { notifyBackground({ type: "OPEN_POPUP_TO_SLOT", slot }); },
        onSwitchToStandard: async (pipeline) => {
          if (videoEl && onYTPause) videoEl.removeEventListener("pause", onYTPause);
          if (videoEl && onYTPlay) videoEl.removeEventListener("play", onYTPlay);
          onYTPause = null;
          onYTPlay = null;
          if (session?.captionTimer) clearInterval(session.captionTimer);
          session?.prefetchStop?.();
          pipeline?.stop?.();
          session = null;
          settings = { ...settings, tier: "standard", dubProvider: "minimax-dub", standardVoice: "male-qn-qingse" };
          notifyBackground({ type: "UPDATE_SETTINGS", settings: { tier: "standard", dubProvider: "minimax-dub", standardVoice: "male-qn-qingse" } });
          const reply = await startStandardSession();
          if (!reply?.ok) {
            showToast(reply?.error || "无法启动标准配音。", 7000);
            emitState({ running: false, status: "标准配音出错", errorMessage: reply?.error || "标准配音出错" });
          }
        },
        setCurrentTexts: (source, target) => { currentSourceText = source; currentTargetText = target; },
        getCurrentTexts: () => ({ source: currentSourceText, target: currentTargetText }),
        setYTPauseHandler: (handler) => { 
          onYTPause = handler; 
          if(videoEl) videoEl.addEventListener("pause", onYTPause); 
        },
        setYTPlayHandler: (handler) => { 
          onYTPlay = handler; 
          if(videoEl) videoEl.addEventListener("play", onYTPlay); 
        }
      });
    }
    if (settings.tier === "standard") {
      return startStandardSession();
    }
    return { ok: false, error: "未知模式：" + settings.tier };
  }

  function stopSession(reason = "stop") {
    pageToken += 1;
    clearSessionTimer();
    stopCaptionPoll();
    if (videoEl) {
      if (onYTPause) videoEl.removeEventListener("pause", onYTPause);
      if (onYTPlay) videoEl.removeEventListener("play", onYTPlay);
      if (reason === "user-stop" || reason === "backend-stop") videoEl.pause();
      if (session?.savedVideoVisibility !== undefined) videoEl.style.visibility = session.savedVideoVisibility;
      videoEl.muted = false;
      videoEl.volume = 1.0;
      videoEl = null;
    }
    onYTPause = null;
    onYTPlay = null;
    if (session) {
      try {
        if (session.type === "caption") {
          if (session.captionTimer) {
            clearInterval(session.captionTimer);
            session.captionTimer = null;
          }
          session.prefetchStop?.();
          session.pipeline?.stop?.();
          session.sttLoop?.stop?.();
        }
        if (session.type === "full") {
          session.controller?.stop?.();
          if (session.jobCreated) window.YimuLocalPlayback?.close?.();
        }
        // Standard tier: halt the recorder loop so no further chunks fire,
        // and abort any in-flight whisper/translate/TTS fetch so we stop
        // burning Kyma credits the moment the user clicks Stop.
        if (session.type === "standard") {
          session.stopFlag = true;
          for (const source of session.playingSources || []) { try { source.stop(); } catch {} }
          session.playingSources?.clear();
          if (session.abortController) {
            try { session.abortController.abort(); } catch {}
          }
          if (session.activeRecorder && session.activeRecorder.state !== "inactive") {
            try { session.activeRecorder.stop(); } catch {}
          }
        }
        if (session.remoteAudio) {
          session.remoteAudio.pause();
          session.remoteAudio.srcObject = null;
          session.remoteAudio.remove();
        }
        if (session.outputGain) session.outputGain.disconnect();
        if (session.audioCtx) session.audioCtx.close();
        if (session.dc) session.dc.close();
        if (session.pc) session.pc.close();
        if (session.stream) session.stream.getTracks().forEach((t) => t.stop());
      } catch {}
      session = null;
    }
    history = [];
    currentTargetText = "";
    removeOverlay();
  }

  function applySettingsLive(newSettings) {
    const prev = settings || {};
    settings = { ...prev, ...newSettings };
    // Tier swap mid-session needs a full restart (different pipelines, can't
    // hot-swap). Surface the constraint so the user knows why their toggle
    // didn't take effect; they can press Stop then Start.
    if ("tier" in newSettings && newSettings.tier !== prev.tier && session) {
      showToast("请停止后重新开始，以切换模式", 5000);
    }
    if (elements.langSelect && newSettings.targetLanguage) {
      elements.langSelect.value = newSettings.targetLanguage;
    }
    // Voice select shape depends on tier — repopulate before assigning value
    // so the new id exists in the dropdown.
    if (elements.voiceSelect &&
        (newSettings.standardVoice !== undefined ||
         newSettings.captionTtsProvider !== undefined)) {
      const tier = settings.tier || "caption";
      populateVoicePicker(tier);
    }
    applyTierToolbar();
    if ("showSource" in newSettings) {
      applySourceVisibility();
      if (settings.showSource && session) startCaptionPoll();
      else stopCaptionPoll();
    }
    if ("originalVolume" in newSettings || "voiceVolume" in newSettings) {
      applyVolumes(settings.originalVolume, settings.voiceVolume);
    }
  }

  // ───── SPA navigation handling ────────────────────────────────────────────
  // YT navigates internally without full page reload. Our static manifest
  // ensures content.js loads on /watch URLs, but a /watch → /watch nav
  // happens via History API. Detect URL change and stop session cleanly.
  setInterval(() => {
    if (location.href !== lastSpaUrl) {
      lastSpaUrl = location.href;
      overlayController?.refreshLayoutKey?.();
      if (session && getYouTubeVideoId() !== sessionVideoId) {
        stopSession("yt-navigation");
        emitEnded("YouTube 页面已切换。");
      }
    }
  }, 500);

  // ───── Background message router ──────────────────────────────────────────
  browserApi.addRuntimeMessageListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case "CONTENT_PING":
          sendResponse({
            ok: true,
            version: LUMEO_VERSION,
            browserApi: !!window.LumeoBrowserApi,
            captionPipeline: !!window.LumeoCaptionPipeline,
            standardPipeline: !!window.LumeoStandardPipeline,
            translateService: !!window.LumeoTranslate,
            captionService: !!window.LumeoCaptions,
            kymaService: !!window.LumeoKyma,
            srtService: !!window.LumeoSrtExport,
            ttsService: !!window.LumeoTTS,
            minimaxService: !!window.LumeoMiniMax,
            sonioxService: !!window.LumeoSonioxSTT,
            audioUtils: !!window.LumeoAudioUtils,
            tokenGuard: !!window.LumeoTokenGuard,
            groqService: !!window.LumeoGroqSTT,
            openaiTts: !!window.LumeoOpenAITTS,
            overlayModule: !!window.LumeoOverlay,
            subtitleOverlayModule: !!window.LumeoSubtitleOverlay,
            captionFallbackChoice: !!window.LumeoCaptionFallbackChoice,
            captionOrchestrator: !!window.LumeoCaptionOrchestrator,
            localPanel: !!window.YimuPanel,
            localPlayback: !!window.YimuLocalPlayback,
            fullPrep: !!window.YimuFullPrep,
          });
          break;
        case "CONTENT_START":
          sendResponse(await startSession(msg.settings || {}));
          break;
        case "CONTENT_STOP":
          stopSession("backend-stop");
          sendResponse({ ok: true });
          break;
        case "CONTENT_UPDATE_SETTINGS":
          applySettingsLive(msg.settings || {});
          sendResponse({ ok: true });
          break;
        case "CONTENT_UPDATE_VOLUME":
          settings = { ...(settings || {}), originalVolume: msg.originalVolume, voiceVolume: msg.voiceVolume };
          applyVolumes(msg.originalVolume, msg.voiceVolume);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "未知页面消息：" + msg?.type });
      }
    })();
    return true;
  });
})();
