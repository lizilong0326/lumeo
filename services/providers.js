(() => {
  "use strict";

  if (globalThis.LumeoProviders?.__loaded) return;

  const providers = Object.freeze({
    none: {
      id: "none",
      label: "不启用",
      slot: "stt",
      group: "无字幕备用方案",
      keyFields: [],
      modes: ["caption"],
      status: "available",
      noKey: true,
      description: "无字幕时不使用语音识别备用方案。",
    },
    ttsOff: {
      id: "off",
      label: "关闭",
      slot: "tts",
      group: "字幕朗读",
      keyFields: [],
      modes: ["caption"],
      status: "available",
      noKey: true,
      description: "只显示字幕，不朗读译文。",
    },
    browserTts: {
      id: "browser",
      label: "浏览器朗读",
      slot: "tts",
      group: "字幕朗读",
      keyFields: [],
      modes: ["caption"],
      status: "available",
      noKey: true,
      description: "使用本机 Chrome 的语音朗读。",
    },
    googleFree: {
      id: "google-free",
      label: "Google 免费翻译",
      slot: "translator",
      group: "字幕翻译",
      keyFields: [],
      modes: ["caption"],
      status: "available",
      noKey: true,
      free: true,
      description: "视频有可用字幕时，无需密钥即可翻译。",
    },
    minimaxTranslate: {
      id: "minimax", label: "MiniMax 大模型翻译", slot: "translator", group: "字幕翻译",
      keyFields: ["minimaxKey"], modes: ["caption"], status: "available",
      helpUrl: "https://platform.minimax.cn/user-center/basic-information/interface-key",
      description: "使用 MiniMax M3 大模型翻译字幕。",
    },
    minimaxStt: {
      id: "minimax-asr", label: "MiniMax 语音识别", slot: "stt", group: "无字幕备用方案",
      keyFields: ["minimaxKey"], modes: ["caption"], status: "available",
      helpUrl: "https://platform.minimax.cn/docs/api-reference/speech-to-text",
      description: "无字幕时把短音频片段交给 MiniMax 识别，随后生成译文。",
    },
    gemini: {
      id: "gemini",
      label: "Gemini",
      slot: "translator",
      group: "字幕翻译",
      keyFields: ["geminiKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://aistudio.google.com/app/apikey",
      description: "可用自己的密钥翻译字幕，具体额度由 Gemini 决定。",
    },
    openrouter: {
      id: "openrouter",
      label: "OpenRouter",
      slot: "translator",
      group: "字幕翻译",
      keyFields: ["openRouterKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://openrouter.ai/keys",
      description: "使用 OpenRouter 中所选的模型翻译字幕。",
    },
    groq: {
      id: "groq",
      label: "Groq",
      slot: "translator",
      group: "字幕翻译",
      keyFields: ["groqApiKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://console.groq.com/keys",
      description: "通过 Groq 模型和自己的密钥快速翻译字幕。",
    },
    openai: {
      id: "openai",
      label: "OpenAI",
      slot: "translator",
      group: "字幕翻译",
      keyFields: ["openaiKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://platform.openai.com/api-keys",
      description: "使用自己的密钥翻译字幕。",
    },
    googleCloud: {
      id: "google-cloud",
      label: "Google Cloud",
      slot: "translator",
      group: "翻译与朗读",
      keyFields: ["googleCloudKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://console.cloud.google.com/apis/credentials",
      description: "使用 Google Cloud 翻译和 Chirp3-HD 语音。",
    },
    googleCloudTts: {
      id: "google-cloud-tts",
      label: "Google Cloud 朗读",
      slot: "tts",
      group: "字幕朗读",
      keyFields: ["googleCloudKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://console.cloud.google.com/apis/credentials",
      description: "使用 Google Cloud 朗读中文字幕。",
    },
    openaiTts: {
      id: "openai-tts",
      label: "OpenAI 朗读",
      slot: "tts",
      group: "字幕朗读",
      keyFields: ["openaiKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://platform.openai.com/api-keys",
      description: "使用 OpenAI 朗读中文字幕。",
    },
    libretranslate: {
      id: "libretranslate",
      label: "LibreTranslate",
      slot: "translator",
      group: "字幕翻译",
      keyFields: ["libreTranslateUrl"],
      optionalKeyFields: ["libreTranslateKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://libretranslate.com",
      description: "使用托管或自建的翻译服务地址。",
    },
    soniox: {
      id: "soniox",
      label: "Soniox",
      slot: "stt",
      group: "语音识别备用方案",
      keyFields: ["sonioxApiKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://soniox.com/console",
      fallbackFor: ["missing-caption-track"],
      description: "视频无可读字幕时，将标签页音频传给 Soniox 实时识别。",
    },
    kyma: {
      id: "kyma",
      label: "Kyma 标准配音",
      slot: "dubPipeline",
      group: "配音",
      keyFields: ["kymaKey"],
      modes: ["standard"],
      status: "available",
      helpUrl: "https://kymaapi.com",
      description: "Kyma 标准配音：Whisper 识别、Gemini 翻译、MiniMax 合成语音。",
    },
    // Reserved keyFields support stable popup rendering and storage migrations.
    // Runtime key validation ignores providers with status "coming-soon".
    openaiDirectDub: {
      id: "openai-direct-dub",
      label: "OpenAI 语音识别与朗读",
      slot: "dubPipeline",
      group: "配音",
      keyFields: ["openaiKey"],
      modes: ["standard"],
      status: "coming-soon",
      helpUrl: "https://platform.openai.com/api-keys",
      description: "规划中：直接使用自己的 OpenAI 密钥完成识别、翻译和配音。",
    },
    elevenLabsDub: {
      id: "elevenlabs-dubbing",
      label: "ElevenLabs 配音",
      slot: "dubPipeline",
      group: "配音",
      keyFields: ["elevenLabsKey"],
      modes: ["standard"],
      status: "coming-soon",
      helpUrl: "https://elevenlabs.io/app/settings/api-keys",
      description: "规划中：使用 ElevenLabs 为视频配音。",
    },
    elevenLabsTts: {
      id: "elevenlabs-tts",
      label: "ElevenLabs 朗读",
      slot: "tts",
      group: "字幕朗读",
      keyFields: ["elevenLabsKey"],
      modes: ["caption"],
      status: "coming-soon",
      helpUrl: "https://elevenlabs.io/app/settings/api-keys",
      description: "规划中：使用 ElevenLabs 朗读译文。",
    },
    minimaxTts: {
      id: "minimax-tts",
      label: "MiniMax 朗读",
      slot: "tts",
      group: "字幕朗读",
      keyFields: ["minimaxKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://platform.minimax.cn/docs/api-reference/speech-t2a-http",
      description: "使用 MiniMax Speech 2.8 Turbo 朗读译文。",
    },
    minimaxDub: {
      id: "minimax-dub", label: "MiniMax 国内配音", slot: "dubPipeline", group: "配音",
      keyFields: ["minimaxKey"], modes: ["standard"], status: "available",
      helpUrl: "https://platform.minimax.cn/docs/api-reference/speech-to-text",
      description: "短音频分段：MiniMax 语音识别 → M3 翻译 → Speech 2.8 Turbo 朗读。约数秒延迟。",
    },
    replicateDub: {
      id: "replicate-dub",
      label: "Replicate",
      slot: "dubPipeline",
      group: "配音",
      keyFields: ["replicateKey"],
      modes: ["standard"],
      // Reserved only: no runtime direct Replicate path exists yet.
      status: "coming-soon",
      helpUrl: "https://replicate.com/account/api-tokens",
      description: "规划中：通过托管开源模型尝试配音。",
    },
    groqWhisper: {
      id: "groq-whisper",
      label: "Groq Whisper 语音识别",
      slot: "stt",
      group: "语音识别备用方案",
      keyFields: ["groqApiKey"],
      modes: ["caption"],
      status: "available",
      helpUrl: "https://console.groq.com/keys",
      description: "视频无可读字幕时，将音频片段传给 Groq Whisper 识别。",
    },
    webSpeech: {
      id: "web-speech",
      label: "浏览器语音识别",
      slot: "stt",
      group: "语音识别备用方案",
      keyFields: [],
      modes: ["caption"],
      status: "coming-soon",
      noKey: true,
      description: "实验性浏览器语音识别；支持的语言取决于 Chrome 环境。",
    },
    huggingface: {
      id: "huggingface",
      label: "Hugging Face",
      slot: "translator",
      group: "高级选项",
      keyFields: ["huggingFaceToken"],
      modes: ["caption"],
      advanced: true,
      status: "coming-soon",
      helpUrl: "https://huggingface.co/settings/tokens",
      description: "预留的高级服务选项。",
    },
  });

  const slotDefinitions = Object.freeze({
    translator: {
      id: "translator",
      label: "字幕翻译",
      required: true,
      storageKey: "translateProvider",
      defaultProvider: "minimax",
      copy: "选择用于翻译 YouTube 字幕的服务。",
    },
    stt: {
      id: "stt",
      label: "无字幕备用方案",
      required: false,
      storageKey: "sttProvider",
      defaultProvider: "minimax-asr",
      copy: "仅在 YouTube 没有提供字幕轨道时使用。",
    },
    tts: {
      id: "tts",
      label: "字幕朗读",
      required: false,
      storageKey: "captionTtsProvider",
      defaultProvider: "minimax-tts",
      copy: "可选：把中文字幕朗读出来。",
    },
    dubPipeline: {
      id: "dubPipeline",
      label: "国内配音流程",
      required: true,
      storageKey: "dubProvider",
      defaultProvider: "minimax-dub",
      copy: "使用国内 MiniMax 大模型分段识别、翻译和配音。",
    },
  });

  const modes = Object.freeze({
    caption: {
      id: "caption",
      label: "智能字幕",
      badge: "字幕 · MiniMax",
      slots: ["translator", "stt", "tts"],
      engines: ["minimax", "google-free", "gemini", "openrouter", "groq", "libretranslate", "openai", "google-cloud"],
      defaultEngine: "minimax",
      requiredProviders: [],
      optionalFallbackProviders: ["soniox"],
      copy: "优先翻译 YouTube 已有字幕。",
    },
    standard: {
      id: "standard",
      label: "国内配音",
      badge: "MiniMax · 配音",
      slots: ["dubPipeline"],
      engines: ["minimax-dub", "kyma", "openai-direct-dub", "elevenlabs-dubbing", "replicate-dub"],
      requiredProviders: ["minimax-dub"],
      optionalFallbackProviders: [],
      copy: "分段翻译音频并配音。",
    },
  });

  const keyFields = Object.freeze({
    kymaKey: { label: "Kyma 标准配音密钥", placeholder: "ky-...", secret: true },
    geminiKey: { label: "Gemini API 密钥", placeholder: "AIza...", secret: true },
    openRouterKey: { label: "OpenRouter 密钥", placeholder: "sk-or-...", secret: true },
    groqApiKey: { label: "Groq 密钥", placeholder: "gsk_...", secret: true },
    huggingFaceToken: { label: "Hugging Face 令牌", placeholder: "hf_...", secret: true },
    openaiKey: { label: "OpenAI 密钥", placeholder: "sk-...", secret: true },
    googleCloudKey: { label: "Google Cloud 密钥", placeholder: "AIza...", secret: true },
    libreTranslateUrl: { label: "LibreTranslate 地址", placeholder: "http://localhost:5000", secret: false },
    libreTranslateKey: { label: "LibreTranslate 密钥", placeholder: "可选 API 密钥", secret: true },
    sonioxApiKey: { label: "Soniox 密钥", placeholder: "Soniox API 密钥", secret: true },
    elevenLabsKey: { label: "ElevenLabs API 密钥", placeholder: "sk_...", secret: true },
    minimaxKey: { label: "MiniMax API 密钥", placeholder: "MiniMax 密钥", secret: true },
    replicateKey: { label: "Replicate 令牌", placeholder: "r8_...", secret: true },
  });

  const capabilityBySlot = Object.freeze({
    translator: "translate",
    stt: "stt",
    tts: "tts",
    dubPipeline: "standardDub",
  });

  const localOnlyProviders = new Set(["none", "off", "browser", "web-speech"]);

  function providerCapabilities(provider) {
    if (!provider) {
      return {
        translate: false,
        stt: false,
        tts: false,
        standardDub: false,
        requiresKey: false,
        free: false,
        localOnly: false,
        comingSoon: false,
      };
    }
    const capability = capabilityBySlot[provider.slot];
    return {
      translate: capability === "translate",
      stt: capability === "stt",
      tts: capability === "tts",
      standardDub: capability === "standardDub",
      requiresKey: !provider.noKey && !provider.free && (provider.keyFields || []).length > 0,
      free: !!provider.free || !!provider.noKey,
      localOnly: localOnlyProviders.has(provider.id),
      comingSoon: provider.status === "coming-soon",
    };
  }

  function withCapabilities(provider) {
    return provider ? { ...provider, capabilities: providerCapabilities(provider) } : null;
  }

  function providerById(id) {
    return Object.values(providers).find((provider) => provider.id === id) || null;
  }

  function keyFieldsForProvider(providerId) {
    const provider = providerById(providerId);
    if (!provider) return [];
    return [...(provider.keyFields || []), ...(provider.optionalKeyFields || [])];
  }

  function hasRequiredKeys(providerId, values = {}) {
    const provider = providerById(providerId);
    if (!provider) return false;
    if (provider.noKey || provider.free) return true;
    return (provider.keyFields || []).every((key) => String(values[key] || "").trim());
  }

  function missingKeyMessage(providerId) {
    const provider = providerById(providerId);
    const label = provider?.label || "该服务";
    const slot = slotDefinitions[provider?.slot];
    const destination = slot?.label || "服务设置";
    return `请在${destination}中填写 ${label} 密钥，然后重新开始。`;
  }

  function providersForSlot(modeId, slotId, options = {}) {
    return Object.values(providers).filter((provider) =>
      provider.slot === slotId &&
      (provider.modes || []).includes(modeId) &&
      (options.includeRoadmap || provider.status !== "coming-soon")
    );
  }

  function slotsForMode(modeId) {
    const mode = modes[modeId] || modes.caption;
    return (mode.slots || []).map((slotId) => slotDefinitions[slotId]).filter(Boolean);
  }

  function selectedProviderForSlot(slotId, values = {}) {
    const slot = slotDefinitions[slotId];
    if (!slot) return null;
    return providerById(values[slot.storageKey] || slot.defaultProvider);
  }

  function requiredProvidersForMode(modeId, valuesOrEngine = {}) {
    const values = typeof valuesOrEngine === "string"
      ? { translateProvider: valuesOrEngine }
      : valuesOrEngine || {};
    return slotsForMode(modeId)
      .filter((slot) => slot.required)
      .map((slot) => selectedProviderForSlot(slot.id, values)?.id)
      .filter(Boolean);
  }

  globalThis.LumeoProviders = {
    __loaded: true,
    providers,
    modes,
    slotDefinitions,
    keyFields,
    capabilityBySlot,
    providerCapabilities,
    withCapabilities,
    providerById,
    keyFieldsForProvider,
    hasRequiredKeys,
    missingKeyMessage,
    providersForSlot,
    slotsForMode,
    selectedProviderForSlot,
    requiredProvidersForMode,
  };
})();
