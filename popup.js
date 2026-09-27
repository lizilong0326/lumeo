// 译幕 popup: passive renderer. Background owns runtime state; this file
// renders mode-aware provider slots so users can see which keys each workflow
// accepts before they press Start.

const $ = (id) => document.getElementById(id);

const tierSelect = $("tier");
const voiceSelect = $("voice");
const customVoiceField = $("customVoiceField");
const customVoiceInput = $("customVoiceId");
const langSelect = $("lang");
const setupStack = $("setupStack");
const keyVaultAllBody = $("keyVaultAllBody");
const keyVaultBadge = $("keyVaultBadge");
const toggleBtn = $("toggle");
const clearCaptionCacheBtn = $("clearCaptionCache");
const exportCaptionBundleBtn = $("exportCaptionBundle");
const importCaptionBundleInput = $("importCaptionBundle");
const captionBundleStatus = $("captionBundleStatus");
const statusEl = $("status");
const tabContext = $("tabContext");
const tabTitle = $("tabTitle");
const tabMeta = $("tabMeta");
const tabBadge = $("tabBadge");
const originalVolumeInput = $("originalVolume");
const voiceVolumeInput = $("voiceVolume");
const originalOut = $("originalOut");
const voiceOut = $("voiceOut");
const showSourceCheckbox = $("showSource");
const useChromeCookiesCheckbox = $("useChromeCookies");
const tierMeta = $("tierMeta");
const buildBadge = $("buildBadge");
const modeRadios = Array.from(document.querySelectorAll('input[name="modeProxy"]'));
const providerRegistry = globalThis.LumeoProviders;
const browserApi = globalThis.LumeoBrowserApi;

const DUB_LANGUAGES = [
  ["en", "English"], ["vi", "Vietnamese"], ["ja", "Japanese"],
  ["ko", "Korean"], ["zh", "Chinese"], ["fr", "French"],
  ["es", "Spanish"], ["de", "German"], ["pt", "Portuguese"],
  ["hi", "Hindi"], ["id", "Indonesian"], ["it", "Italian"],
  ["ru", "Russian"],
];
const CAPTION_LANGUAGES = [
  ...DUB_LANGUAGES,
  ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"],
  ["th", "Thai"], ["ms", "Malay"], ["fil", "Filipino"], ["my", "Myanmar"],
  ["km", "Khmer"], ["lo", "Lao"], ["bn", "Bengali"], ["ta", "Tamil"],
  ["te", "Telugu"], ["ur", "Urdu"], ["ar", "Arabic"], ["fa", "Persian"],
  ["he", "Hebrew"], ["tr", "Turkish"], ["nl", "Dutch"], ["pl", "Polish"],
  ["ro", "Romanian"], ["cs", "Czech"], ["sv", "Swedish"], ["da", "Danish"],
  ["fi", "Finnish"], ["no", "Norwegian"], ["el", "Greek"], ["hu", "Hungarian"],
  ["uk", "Ukrainian"], ["af", "Afrikaans"], ["sq", "Albanian"], ["am", "Amharic"],
  ["hy", "Armenian"], ["az", "Azerbaijani"], ["eu", "Basque"], ["be", "Belarusian"],
  ["bs", "Bosnian"], ["bg", "Bulgarian"], ["ca", "Catalan"], ["hr", "Croatian"],
  ["et", "Estonian"], ["ka", "Georgian"], ["gl", "Galician"], ["gu", "Gujarati"],
  ["ht", "Haitian Creole"], ["ha", "Hausa"], ["is", "Icelandic"], ["ig", "Igbo"],
  ["ga", "Irish"], ["jw", "Javanese"], ["kn", "Kannada"], ["kk", "Kazakh"],
  ["rw", "Kinyarwanda"], ["ku", "Kurdish"], ["ky", "Kyrgyz"], ["la", "Latin"],
  ["lv", "Latvian"], ["lt", "Lithuanian"], ["lb", "Luxembourgish"], ["mk", "Macedonian"],
  ["mg", "Malagasy"], ["ml", "Malayalam"], ["mt", "Maltese"], ["mi", "Maori"],
  ["mr", "Marathi"], ["mn", "Mongolian"], ["ne", "Nepali"], ["ny", "Chichewa"],
  ["or", "Odia"], ["ps", "Pashto"], ["pa", "Punjabi"], ["sm", "Samoan"],
  ["gd", "Scots Gaelic"], ["sr", "Serbian"], ["st", "Sesotho"], ["sn", "Shona"],
  ["sd", "Sindhi"], ["si", "Sinhala"], ["sk", "Slovak"], ["sl", "Slovenian"],
  ["so", "Somali"], ["su", "Sundanese"], ["sw", "Swahili"], ["tg", "Tajik"],
  ["tt", "Tatar"], ["tk", "Turkmen"], ["ug", "Uyghur"], ["uz", "Uzbek"],
  ["cy", "Welsh"], ["xh", "Xhosa"], ["yi", "Yiddish"], ["yo", "Yoruba"],
  ["zu", "Zulu"],
];

const chineseLanguageNames = new Intl.DisplayNames(["zh-CN"], { type: "language" });
function languageName(code, fallback = code) {
  if (code === "zh-CN") return "简体中文";
  if (code === "zh-TW") return "繁体中文";
  if (code === "zh") return "中文";
  try { return chineseLanguageNames.of(code) || fallback; } catch { return fallback; }
}

const CAPTION_VOICES = [
  { id: "off", name: "关闭朗读" },
  { id: "minimax-tts", name: "MiniMax 中文朗读" },
  { id: "browser", name: "浏览器朗读" },
  { id: "google-cloud", name: "Google Cloud 朗读" },
];
const MINIMAX_VOICES = [
  { id: "male-qn-qingse", name: "MiniMax 青涩男声" },
  { id: "female-shaonv", name: "MiniMax 少女声" },
  { id: "Chinese (Mandarin)_Reliable_Executive", name: "沉稳高管" },
  { id: "Chinese (Mandarin)_News_Anchor", name: "新闻女声" },
  { id: "Chinese (Mandarin)_Warm_Bestie", name: "温暖闺蜜" },
  { id: "Chinese (Mandarin)_Gentle_Youth", name: "温润青年" },
  { id: "Chinese (Mandarin)_Radio_Host", name: "电台男主播" },
];
const KYMA_VOICES = [
  { id: "English_magnetic_voiced_man", name: "磁性男声" },
  { id: "English_captivating_female1", name: "温柔女声" },
  { id: "English_ManWithDeepVoice", name: "低沉男声" },
  { id: "English_ConfidentWoman", name: "自信女声" },
  { id: "Chinese (Mandarin)_News_Anchor", name: "中文播音员" },
];
const CUSTOM_VOICE_OPTION = "__custom_voice__";

const KEY_FIELDS = [
  "kymaKey", "geminiKey", "openRouterKey", "groqApiKey",
  "huggingFaceToken", "openaiKey", "googleCloudKey", "libreTranslateUrl",
  "libreTranslateKey", "sonioxApiKey", "elevenLabsKey", "minimaxKey",
  "replicateKey",
];

let activeTabInfo = null;
let providerSaveTimer = null;
let volumeDebounce = null;
let highlightSlotId = "";

let state = {
  running: false,
  connecting: false,
  paused: false,
  tier: "caption",
  targetLanguage: "zh-CN",
  translateProvider: "minimax",
  sttProvider: "minimax-asr",
  captionTtsProvider: "minimax-tts",
  dubProvider: "minimax-dub",
  kymaKey: "",
  geminiKey: "",
  openRouterKey: "",
  openaiKey: "",
  groqApiKey: "",
  huggingFaceToken: "",
  googleCloudKey: "",
  libreTranslateUrl: "",
  libreTranslateKey: "",
  sonioxApiKey: "",
  elevenLabsKey: "",
  minimaxKey: "",
  replicateKey: "",
  standardVoice: "male-qn-qingse",
  originalVolume: 18,
  voiceVolume: 100,
  showSource: false,
  useChromeCookies: false,
  status: "就绪",
};

function send(message) {
  return browserApi.sendRuntimeMessage(message);
}

function isBenign(msg) {
  return /message channel closed|asynchronous response|message port closed|Receiving end does not exist/i.test(msg || "");
}

function setStateClass(name) {
  document.body.dataset.state = name;
}

function keyValue(fieldId) {
  const input = document.getElementById(fieldId);
  return input ? input.value.trim() : String(state[fieldId] || "").trim();
}

function allKeyValues() {
  return Object.fromEntries(KEY_FIELDS.map((fieldId) => [fieldId, keyValue(fieldId)]));
}

function slotValueForState(slot) {
  const raw = state[slot.storageKey] || slot.defaultProvider;
  return slot.id === "tts" && raw === "google-cloud" ? "google-cloud-tts" : raw;
}

function stateValueForSlot(slot, providerId) {
  return slot.id === "tts" && providerId === "google-cloud-tts" ? "google-cloud" : providerId;
}

function selectedProviderForSlot(slot) {
  const providers = providerRegistry.providersForSlot(state.tier, slot.id);
  const wanted = slotValueForState(slot);
  const selected = providers.find((provider) => provider.id === wanted);
  if (selected && selected.status !== "coming-soon") return selected;
  return providers.find((provider) => provider.id === slot.defaultProvider) ||
    providers.find((provider) => provider.status !== "coming-soon") ||
    providers[0] ||
    null;
}

function providerStatus(provider, slot) {
  if (!provider) return { label: "缺少服务", tone: "missing" };
  const capabilities = providerRegistry.providerCapabilities?.(provider) || {};
  if (capabilities.comingSoon) return { label: "尚未开放", tone: "soon" };
  if (!capabilities.requiresKey) return { label: capabilities.localOnly ? "本地" : "免费", tone: "free" };
  if (providerRegistry.hasRequiredKeys(provider.id, allKeyValues())) return { label: "就绪", tone: "ready" };
  return { label: slot?.required ? "需要密钥" : "可选密钥", tone: "missing" };
}

function providerMicrocopy(provider) {
  const capabilities = providerRegistry.providerCapabilities?.(provider) || {};
  if (capabilities.comingSoon) return "此服务仍在规划中，暂不可启动。";
  if (capabilities.localOnly) return "在 Chrome 本地运行，无需服务密钥。";
  if (capabilities.standardDub) return "配音时会把音频发送给所选服务；费用取决于视频时长和服务定价。";
  if (capabilities.stt) return "仅在视频无可读字幕且选择该备用方案时上传音频。";
  if (capabilities.tts) return "启用字幕朗读后，译文会发送给语音合成服务。";
  if (capabilities.translate && capabilities.requiresKey) return "字幕文本会通过你的密钥发送给所选翻译服务。";
  return "此方案无需服务密钥。";
}

function populateLanguages(tier = state.tier, preferred = state.targetLanguage) {
  const list = tier === "caption" ? [["zh-CN", "简体中文"]] : DUB_LANGUAGES;
  langSelect.replaceChildren();
  for (const [code, name] of list) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = languageName(code, name);
    langSelect.appendChild(opt);
  }
  langSelect.value = list.some(([code]) => code === preferred) ? preferred : (tier === "caption" ? "zh-CN" : "zh");
}

function repopulateVoices(tier, preferredVoiceId) {
  const list = tier === "caption"
    ? MINIMAX_VOICES
    : (state.dubProvider === "kyma" ? KYMA_VOICES : MINIMAX_VOICES);
  voiceSelect.replaceChildren();
  for (const voice of list) {
    const opt = document.createElement("option");
    opt.value = voice.id;
    opt.textContent = voice.name;
    voiceSelect.appendChild(opt);
  }
  if (list === MINIMAX_VOICES) {
    const custom = document.createElement("option");
    custom.value = CUSTOM_VOICE_OPTION;
    custom.textContent = "其他音色：输入音色 ID";
    voiceSelect.appendChild(custom);
  }
  const isPreset = list.some((voice) => voice.id === preferredVoiceId);
  voiceSelect.value = isPreset ? preferredVoiceId
    : (list === MINIMAX_VOICES && preferredVoiceId ? CUSTOM_VOICE_OPTION : list[0].id);
  if (voiceSelect.value === CUSTOM_VOICE_OPTION && document.activeElement !== customVoiceInput) {
    customVoiceInput.value = preferredVoiceId || "";
  }
  customVoiceField.hidden = voiceSelect.value !== CUSTOM_VOICE_OPTION;
}

function selectedVoiceId() {
  return voiceSelect.value === CUSTOM_VOICE_OPTION
    ? customVoiceInput.value.trim()
    : voiceSelect.value;
}

function renderProviderSelect(slot, providers, activeProvider) {
  const label = document.createElement("label");
  label.className = "field slot-provider";
  const caption = document.createElement("span");
  caption.textContent = "服务";
  const select = document.createElement("select");
  select.dataset.slot = slot.id;
  select.dataset.setting = slot.storageKey;
  for (const provider of providers) {
    const opt = document.createElement("option");
    opt.value = provider.id;
    opt.disabled = provider.status === "coming-soon";
    opt.textContent = provider.status === "coming-soon" ? `${provider.label} · 尚未开放` : provider.label;
    select.appendChild(opt);
  }
  select.value = activeProvider?.id || providers[0]?.id || "";
  label.append(caption, select);
  return label;
}

function renderKeyFields(card, provider, renderedKeys) {
  if (!provider || provider.status === "coming-soon") return;
  for (const fieldId of providerRegistry.keyFieldsForProvider(provider.id)) {
    if (renderedKeys.has(fieldId)) continue;
    renderedKeys.add(fieldId);
    const meta = providerRegistry.keyFields[fieldId];
    if (!meta) continue;
    const label = document.createElement("label");
    label.className = "secret slot-secret";
    const span = document.createElement("span");
    span.textContent = meta.label;
    const input = document.createElement("input");
    input.id = fieldId;
    input.dataset.keyField = fieldId;
    input.type = meta.secret === false ? "text" : "password";
    input.placeholder = meta.placeholder || "";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = keyValue(fieldId);
    label.append(span, input);
    card.appendChild(label);
  }
}

function renderSetupStack() {
  if (!setupStack || !providerRegistry) return;
  state.tier = tierSelect.value || state.tier;
  setupStack.replaceChildren();
  const renderedKeys = new Set();

  if (state.tier === "caption") {
    const card = document.createElement("article");
    card.className = "slot-card";
    const title = document.createElement("strong");
    title.textContent = "MiniMax 服务";
    const copy = document.createElement("p");
    copy.className = "slot-copy";
    copy.textContent = "整片识别、翻译与中文配音共用一把密钥；请先启动本地服务。";
    card.append(title, copy);
    renderKeyFields(card, providerRegistry.providerById("minimax"), renderedKeys);
    setupStack.append(card);
    renderKeyVaultSummary();
    return;
  }

  for (const slot of providerRegistry.slotsForMode(state.tier)) {
    const providers = providerRegistry.providersForSlot(state.tier, slot.id);
    const provider = selectedProviderForSlot(slot);
    if (!provider) continue;
    state[slot.storageKey] = stateValueForSlot(slot, provider.id);
    const status = providerStatus(provider, slot);

    const card = document.createElement("article");
    card.className = "slot-card";
    card.dataset.slot = slot.id;
    card.classList.toggle("is-highlighted", highlightSlotId === slot.id || highlightSlotId === provider.id);
    card.classList.toggle("needs-key", status.tone === "missing");

    const header = document.createElement("div");
    header.className = "slot-header";
    const titleWrap = document.createElement("span");
    titleWrap.className = "slot-title";
    const kicker = document.createElement("span");
    kicker.className = "slot-kicker";
    kicker.textContent = slot.required ? "必需" : "可选";
    const title = document.createElement("strong");
    title.textContent = slot.label;
    titleWrap.append(kicker, title);
    const badge = document.createElement("span");
    badge.className = `slot-status ${status.tone}`;
    badge.textContent = status.label;
    header.append(titleWrap, badge);
    card.appendChild(header);

    const copy = document.createElement("small");
    copy.className = "slot-copy";
    copy.textContent = slot.copy;
    card.appendChild(copy);
    card.appendChild(renderProviderSelect(slot, providers, provider));

    const providerCopy = document.createElement("p");
    providerCopy.className = "provider-copy";
    providerCopy.textContent = provider.description || "";
    card.appendChild(providerCopy);
    const providerMeta = document.createElement("p");
    providerMeta.className = "provider-copy provider-meta";
    providerMeta.textContent = providerMicrocopy(provider);
    card.appendChild(providerMeta);
    renderKeyFields(card, provider, renderedKeys);

    const footer = document.createElement("div");
    footer.className = "slot-footer";
    if (provider.helpUrl) {
      const link = document.createElement("a");
      link.href = provider.helpUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "provider-help-link";
      link.textContent = `获取 ${provider.label} 密钥`;
      footer.appendChild(link);
    }
    if (provider.status === "coming-soon") {
      const soon = document.createElement("span");
      soon.className = "soon-note";
      soon.textContent = "尚未开放，暂不可选择";
      footer.appendChild(soon);
    }
    if (footer.childNodes.length) card.appendChild(footer);
    setupStack.appendChild(card);
  }
  renderKeyVaultSummary();
}

function renderKeyVaultSummary() {
  if (!keyVaultAllBody || !providerRegistry) return;
  keyVaultAllBody.replaceChildren();
  const saved = KEY_FIELDS.filter((fieldId) => keyValue(fieldId));
  keyVaultBadge.textContent = `已保存 ${saved.length} 个`;
  keyVaultBadge.classList.toggle("ok", saved.length > 0);

  const note = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = "密钥保存在本机 Chrome 存储中。";
  note.append(strong, "国内字幕翻译、语音识别和朗读共用一把 MiniMax 密钥。");
  keyVaultAllBody.appendChild(note);

  const groups = new Map();
  for (const provider of Object.values(providerRegistry.providers)) {
    if (!provider.keyFields?.length) continue;
      if (provider.status === "coming-soon") continue;
      const group = groups.get(provider.group) || [];
    group.push(provider);
    groups.set(provider.group, group);
  }

  for (const [groupName, providers] of groups) {
    const group = document.createElement("div");
    group.className = "key-group";
    const title = document.createElement("div");
    title.className = "key-group-title";
    title.textContent = groupName;
    group.appendChild(title);
    for (const provider of providers) {
      const row = document.createElement("div");
      row.className = "provider-row summary-row";
      const head = document.createElement("div");
      head.className = "provider-head";
      const name = document.createElement("strong");
      name.textContent = provider.label;
      const badge = document.createElement("span");
      const ready = providerRegistry.hasRequiredKeys(provider.id, allKeyValues());
      badge.className = `provider-badge ${ready ? "ok" : provider.status === "coming-soon" ? "soon" : "missing"}`;
      badge.textContent = provider.status === "coming-soon" ? "待开放" : ready ? "已保存" : "未填写";
      head.append(name, badge);
      const desc = document.createElement("small");
      desc.textContent = provider.keyFields.map((fieldId) => providerRegistry.keyFields[fieldId]?.label || fieldId).join(", ");
      row.append(head, desc);
      if (provider.helpUrl) {
        const link = document.createElement("a");
        link.href = provider.helpUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "获取密钥";
        row.appendChild(link);
      }
      group.appendChild(row);
    }
    keyVaultAllBody.appendChild(group);
  }
}

function syncModeProxy(tier) {
  for (const radio of modeRadios) radio.checked = radio.value === tier;
  if (tierMeta) tierMeta.textContent = "整片准备 · MiniMax";
  renderSetupStack();
}

function activeVoiceForTier(tier) {
  if (tier === "caption") return state.standardVoice || MINIMAX_VOICES[0].id;
  if (tier === "standard") return state.standardVoice || (state.dubProvider === "kyma" ? KYMA_VOICES[0].id : MINIMAX_VOICES[0].id);
  return state.standardVoice || MINIMAX_VOICES[0].id;
}

function readSettings() {
  const tier = tierSelect.value || "caption";
  const voiceKey = tier === "caption" ? "captionTtsProvider" : "standardVoice";
  const settings = {
    ...allKeyValues(),
    tier,
    targetLanguage: langSelect.value || (tier === "caption" ? "zh-CN" : "zh"),
    translateProvider: state.translateProvider || "minimax",
    sttProvider: state.sttProvider || "minimax-asr",
    captionTtsProvider: state.captionTtsProvider || "minimax-tts",
    dubProvider: state.dubProvider || "minimax-dub",
    [voiceKey]: selectedVoiceId(),
    standardVoice: selectedVoiceId(),
    originalVolume: Number(originalVolumeInput.value),
    voiceVolume: Number(voiceVolumeInput.value),
    showSource: showSourceCheckbox.checked,
    useChromeCookies: useChromeCookiesCheckbox.checked,
  };
  if (tier === "caption") settings.captionTtsProvider = "minimax-tts";
  return settings;
}

async function pushSettings() {
  try {
    const reply = await send({ type: "UPDATE_SETTINGS", settings: readSettings() });
    if (reply?.state) applyState(reply.state);
  } catch (err) {
    if (!isBenign(err.message)) {
      statusEl.textContent = err.message;
      setStateClass("error");
    }
  }
}

function scheduleProviderSave() {
  clearTimeout(providerSaveTimer);
  providerSaveTimer = setTimeout(() => {
    void pushSettings();
    renderKeyVaultSummary();
  }, 500);
}

function applyState(s) {
  state = { ...state, ...s };
  if (state.captionTtsProvider === "google-cloud-tts") state.captionTtsProvider = "google-cloud";
  const tier = "caption";
  if (tierSelect.value !== tier) tierSelect.value = tier;
  populateLanguages(tier, state.targetLanguage);
  if (typeof state.targetLanguage === "string") {
    const hasLanguage = Array.from(langSelect.options).some((opt) => opt.value === state.targetLanguage);
    langSelect.value = hasLanguage ? state.targetLanguage : (tier === "caption" ? "zh-CN" : "zh");
  }
  repopulateVoices(tier, activeVoiceForTier(tier));
  if (typeof state.originalVolume === "number") {
    originalVolumeInput.value = state.originalVolume;
    originalOut.textContent = state.originalVolume;
  }
  if (typeof state.voiceVolume === "number") {
    voiceVolumeInput.value = state.voiceVolume;
    voiceOut.textContent = state.voiceVolume;
  }
  if (typeof state.showSource === "boolean") showSourceCheckbox.checked = state.showSource;
  useChromeCookiesCheckbox.checked = state.useChromeCookies === true;
  const missingSlots = Array.isArray(state.slotsMissingKeys) ? state.slotsMissingKeys : [];
  const missingProviders = Array.isArray(state.missingProviders) ? state.missingProviders : [];
  highlightSlotId = missingSlots[0] || missingProviders[0] || highlightSlotId;
  syncModeProxy(tier);

  if (state.connecting) {
    setStateClass("connecting");
    statusEl.textContent = state.status || "正在连接";
    toggleBtn.textContent = "停止";
    toggleBtn.classList.add("is-live");
  } else if (state.running && state.paused) {
    setStateClass("paused");
    statusEl.textContent = "已暂停";
    toggleBtn.textContent = "停止";
    toggleBtn.classList.add("is-live");
  } else if (state.running) {
    setStateClass("active");
    const langName = languageName(state.targetLanguage);
    statusEl.textContent = state.status && !/^Translating$/i.test(state.status)
      ? state.status
      : `正在翻译为${langName}`;
    toggleBtn.textContent = "停止";
    toggleBtn.classList.add("is-live");
  } else if (state.errorMessage) {
    setStateClass("error");
    statusEl.textContent = state.errorMessage;
    toggleBtn.textContent = "开始准备整片";
    toggleBtn.classList.remove("is-live");
  } else {
    setStateClass("idle");
    statusEl.textContent = "已就绪";
    toggleBtn.textContent = "开始准备整片";
    toggleBtn.classList.remove("is-live");
  }
  toggleBtn.disabled = false;
}

function getVideoIdFromUrl(url) {
  try {
    const parsed = new URL(url || "");
    return parsed.hostname.includes("youtube.com") ? parsed.searchParams.get("v") : null;
  } catch {
    return null;
  }
}

async function loadActiveTabContext() {
  try {
    const [tab] = await browserApi.queryTabs({ active: true, currentWindow: true });
    activeTabInfo = tab || null;
    const videoId = getVideoIdFromUrl(tab?.url);
    const isYouTubeWatch = !!videoId;
    tabContext?.classList.toggle("is-invalid", !isYouTubeWatch);
    tabTitle.textContent = isYouTubeWatch
      ? (tab.title || "YouTube 视频").replace(/\s+-\s+YouTube$/i, "")
      : "请先打开 YouTube 视频";
    tabTitle.title = tab.title || "";
    tabMeta.textContent = isYouTubeWatch
      ? `youtube.com/watch · ${videoId}`
      : "请在当前标签页打开 YouTube 视频";
    tabBadge.textContent = isYouTubeWatch ? "已连接" : "无视频";
    syncModeProxy(state.tier || tierSelect.value || "caption");
  } catch (err) {
    tabTitle.textContent = "无法读取当前标签页";
    tabMeta.textContent = err.message || String(err);
    tabBadge.textContent = "错误";
    tabContext?.classList.add("is-invalid");
  }
}

function onVolumeChange() {
  originalOut.textContent = originalVolumeInput.value;
  voiceOut.textContent = voiceVolumeInput.value;
  clearTimeout(volumeDebounce);
  volumeDebounce = setTimeout(() => {
    browserApi.sendRuntimeMessage({
      type: "UPDATE_VOLUME",
      originalVolume: Number(originalVolumeInput.value),
      voiceVolume: Number(voiceVolumeInput.value),
    }).catch(() => {});
  }, 60);
}

function validationMissing(settings) {
  if (settings.tier === "caption") return settings.minimaxKey ? [] : ["minimax"];
  const required = providerRegistry?.requiredProvidersForMode(settings.tier, settings) || [];
  return required.filter((providerId) => {
    const provider = providerRegistry.providerById(providerId);
    return provider?.status === "coming-soon" || !providerRegistry.hasRequiredKeys(providerId, settings);
  });
}

async function clearCaptionCache() {
  if (!clearCaptionCacheBtn) return;
  clearCaptionCacheBtn.disabled = true;
  try {
    const reply = await send({ action: "captionCacheClear" });
    if (!reply?.ok) throw new Error(reply?.error || "无法清除字幕缓存。");
    statusEl.textContent = "字幕缓存已清除。";
    if (captionBundleStatus) captionBundleStatus.textContent = "字幕缓存已清空。";
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  } finally {
    clearCaptionCacheBtn.disabled = false;
  }
}

function activeVideoId() {
  return getVideoIdFromUrl(activeTabInfo?.url);
}

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function exportCaptionBundle() {
  if (!exportCaptionBundleBtn) return;
  exportCaptionBundleBtn.disabled = true;
  try {
    const videoId = activeVideoId();
    if (!videoId) throw new Error("请先打开 YouTube 视频再导出。");
    const reply = await send({ action: "captionCacheGet" });
    if (!reply?.ok) throw new Error(reply?.error || "无法读取字幕缓存。");
    const entries = Object.values(reply.cache?.entries || {});
    const targetLanguage = langSelect.value || state.targetLanguage;
    const entry = entries.find((item) => item?.meta?.videoId === videoId && item?.meta?.targetLanguage === targetLanguage)
      || entries.find((item) => item?.meta?.videoId === videoId);
    const bundle = window.LumeoTranslationBundle.createBundle(entry, {
      videoId,
      targetLanguage,
      provider: state.translateProvider || "google-free",
      title: tabTitle.textContent || activeTabInfo?.title || "YouTube 视频",
    });
    downloadJson(bundle, window.LumeoTranslationBundle.filenameForBundle(bundle));
    statusEl.textContent = "字幕包已导出。";
    if (captionBundleStatus) captionBundleStatus.textContent = `已导出 ${bundle.cues.length} 条${bundle.targetLanguage}字幕。`;
  } catch (err) {
    statusEl.textContent = err.message || String(err);
    if (captionBundleStatus) captionBundleStatus.textContent = err.message || String(err);
  } finally {
    exportCaptionBundleBtn.disabled = false;
  }
}

async function importCaptionBundle(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = window.LumeoTranslationBundle.parseBundle(await file.text());
    const reply = await send({ action: "captionCacheGet" });
    if (!reply?.ok) throw new Error(reply?.error || "无法读取字幕缓存。");
    const cache = reply.cache || { entries: {} };
    cache.entries ||= {};
    cache.entries[parsed.key] = parsed.entry;
    const saved = await send({ action: "captionCacheSet", cache });
    if (!saved?.ok) throw new Error(saved?.error || "无法导入字幕缓存。");
    statusEl.textContent = "字幕包已导入。";
    if (captionBundleStatus) captionBundleStatus.textContent = `已恢复 ${parsed.bundle.cues.length} 条${parsed.bundle.targetLanguage}字幕。`;
  } catch (err) {
    statusEl.textContent = err.message || String(err);
    if (captionBundleStatus) captionBundleStatus.textContent = err.message || String(err);
  } finally {
    event.target.value = "";
  }
}

async function onToggle() {
  toggleBtn.disabled = true;
  try {
    if (state.running || state.connecting) {
      const reply = await send({ type: "STOP" });
      if (reply?.state) applyState(reply.state);
      else applyState({ running: false, connecting: false, paused: false });
      return;
    }
    const settings = readSettings();
    if (!settings.standardVoice) {
      statusEl.textContent = "请填写 MiniMax 音色 ID。";
      setStateClass("error");
      toggleBtn.disabled = false;
      customVoiceInput.focus();
      return;
    }
    const missing = validationMissing(settings);
    if (missing.length) {
      const provider = providerRegistry.providerById(missing[0]);
      highlightSlotId = provider?.slot || provider?.id || "";
      renderSetupStack();
      statusEl.textContent = provider?.status === "coming-soon"
        ? `${provider.label} 尚未开放，请选择可用服务。`
        : providerRegistry.missingKeyMessage?.(provider?.id) || `请填写 ${provider?.label || "服务"} 密钥，然后重新开始。`;
      setStateClass("error");
      toggleBtn.disabled = false;
      return;
    }
    const reply = await send({ type: "START", settings });
    if (!reply?.ok) {
      statusEl.textContent = reply?.error || "无法启动。";
      setStateClass("error");
      if (reply?.slotsMissingKeys?.[0]) highlightSlotId = reply.slotsMissingKeys[0];
      else if (reply?.missingProviders?.[0]) highlightSlotId = reply.missingProviders[0];
      if (reply?.state) applyState(reply.state);
      renderSetupStack();
      state.running = false;
      state.connecting = false;
      toggleBtn.textContent = "开始准备整片";
      toggleBtn.classList.remove("is-live");
      toggleBtn.disabled = false;
      return;
    }
    if (reply?.state) applyState(reply.state);
  } catch (err) {
    toggleBtn.disabled = false;
    if (isBenign(err.message)) return;
    statusEl.textContent = err.message;
    setStateClass("error");
    state.running = false;
    state.connecting = false;
    toggleBtn.textContent = "开始准备整片";
    toggleBtn.classList.remove("is-live");
  }
}

function applyTierChange(tier) {
  state.tier = tier;
  populateLanguages(tier, langSelect.value || state.targetLanguage);
  repopulateVoices(tier, activeVoiceForTier(tier));
  syncModeProxy(tier);
}

for (const radio of modeRadios) {
  radio.addEventListener("change", () => {
    if (radio.disabled || !radio.checked) return;
    tierSelect.value = radio.value;
    applyTierChange(radio.value);
    void pushSettings();
  });
}
tierSelect.addEventListener("change", () => {
  applyTierChange(tierSelect.value);
  void pushSettings();
});
voiceSelect.addEventListener("change", () => {
  customVoiceField.hidden = voiceSelect.value !== CUSTOM_VOICE_OPTION;
  if (voiceSelect.value === CUSTOM_VOICE_OPTION) {
    customVoiceInput.focus();
    return;
  }
  state.standardVoice = voiceSelect.value;
  void pushSettings();
});
customVoiceInput.addEventListener("change", () => {
  if (voiceSelect.value !== CUSTOM_VOICE_OPTION || !customVoiceInput.value.trim()) return;
  state.standardVoice = customVoiceInput.value.trim();
  void pushSettings();
});
langSelect.addEventListener("change", pushSettings);
showSourceCheckbox.addEventListener("change", pushSettings);
useChromeCookiesCheckbox.addEventListener("change", pushSettings);
originalVolumeInput.addEventListener("input", onVolumeChange);
voiceVolumeInput.addEventListener("input", onVolumeChange);
toggleBtn.addEventListener("click", onToggle);
clearCaptionCacheBtn?.addEventListener("click", clearCaptionCache);
exportCaptionBundleBtn?.addEventListener("click", exportCaptionBundle);
importCaptionBundleInput?.addEventListener("change", importCaptionBundle);

setupStack?.addEventListener("change", (event) => {
  const select = event.target.closest("select[data-slot]");
  if (!select) return;
  const slot = providerRegistry.slotDefinitions[select.dataset.slot];
  if (!slot) return;
  state[slot.storageKey] = stateValueForSlot(slot, select.value);
  highlightSlotId = "";
  if (slot.id === "tts") voiceSelect.value = state.captionTtsProvider;
  if (slot.id === "dubPipeline") repopulateVoices("standard", activeVoiceForTier("standard"));
  renderSetupStack();
  void pushSettings();
});
setupStack?.addEventListener("input", (event) => {
  const input = event.target.closest("input[data-key-field]");
  if (!input) return;
  state[input.dataset.keyField] = input.value.trim();
  input.closest(".slot-card")?.classList.remove("is-highlighted");
  scheduleProviderSave();
});
setupStack?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const input = event.target.closest("input[data-key-field]");
  if (!input) return;
  event.preventDefault();
  clearTimeout(providerSaveTimer);
  state[input.dataset.keyField] = input.value.trim();
  void pushSettings();
  renderSetupStack();
});

browserApi.addRuntimeMessageListener((message) => {
  if (message?.type === "BACKGROUND_STATE_UPDATE" && message.state) applyState(message.state);
  if (message?.type === "OPEN_POPUP_TO_SLOT" && message.slot) {
    highlightSlotId = message.slot;
    renderSetupStack();
  }
});

try {
  const manifest = browserApi.getManifest();
  buildBadge.textContent = manifest.version_name || `v${manifest.version}`;
} catch {
  buildBadge.textContent = "开发版";
}

loadActiveTabContext();
populateLanguages(state.tier, state.targetLanguage);
repopulateVoices(state.tier, activeVoiceForTier(state.tier));
renderSetupStack();

(async () => {
  try {
    const reply = await send({ type: "GET_STATE" });
    if (reply?.state) applyState(reply.state);
  } catch (err) {
    if (!isBenign(err.message)) {
      statusEl.textContent = err.message;
      setStateClass("error");
    }
  }
})();
