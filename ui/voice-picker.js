(() => {
  "use strict";

  if (window.LumeoVoicePicker?.__loaded) return;

  const CAPTION_TTS_OPTIONS = Object.freeze([
    ["off", "关闭朗读"],
    ["minimax-tts", "MiniMax 中文朗读"],
    ["browser", "浏览器朗读"],
    ["google-cloud", "Google Cloud 朗读"],
    ["openai-tts", "OpenAI 朗读"],
  ]);

  const MINIMAX_VOICES = Object.freeze([
    ["male-qn-qingse", "MiniMax 青涩男声"],
    ["female-shaonv", "MiniMax 少女声"],
    ["Chinese (Mandarin)_Reliable_Executive", "沉稳高管"],
    ["Chinese (Mandarin)_News_Anchor", "新闻女声"],
    ["Chinese (Mandarin)_Warm_Bestie", "温暖闺蜜"],
    ["Chinese (Mandarin)_Gentle_Youth", "温润青年"],
    ["Chinese (Mandarin)_Radio_Host", "电台男主播"],
  ]);
  const KYMA_VOICES = Object.freeze([
    ["English_magnetic_voiced_man", "磁性男声"],
    ["English_captivating_female1", "温柔女声"],
    ["English_ManWithDeepVoice", "低沉男声"],
    ["English_ConfidentWoman", "自信女声"],
    ["Chinese (Mandarin)_News_Anchor", "中文播音员"],
  ]);
  const STANDARD_VOICES = Object.freeze([...MINIMAX_VOICES, ...KYMA_VOICES]);

  const STANDARD_DEFAULT_VOICE = STANDARD_VOICES[0][0];

  function appendOption(selectEl, value, label) {
    const opt = selectEl.ownerDocument.createElement("option");
    opt.value = value;
    opt.textContent = label;
    selectEl.appendChild(opt);
  }

  function populate(selectEl, tier, settings = {}) {
    if (!selectEl) return;
    selectEl.replaceChildren();

    if (tier === "caption") {
      selectEl.setAttribute("aria-label", "朗读译文");
      selectEl.title = "朗读中文字幕；选择浏览器朗读即可免费使用本机语音。";
      for (const [id, name] of CAPTION_TTS_OPTIONS) appendOption(selectEl, id, name);
      selectEl.value = settings.captionTtsProvider || "minimax-tts";
      return;
    }

    if (tier === "standard") {
      selectEl.setAttribute("aria-label", "配音声音");
      selectEl.removeAttribute("title");
      const isKyma = settings.dubProvider === "kyma";
      const voices = isKyma ? KYMA_VOICES : MINIMAX_VOICES;
      for (const [id, name] of voices) appendOption(selectEl, id, name);
      if (!isKyma && settings.standardVoice && !voices.some(([id]) => id === settings.standardVoice)) {
        appendOption(selectEl, settings.standardVoice, `自定义音色：${settings.standardVoice}`);
      }
      selectEl.value = Array.from(selectEl.options).some((option) => option.value === settings.standardVoice)
        ? settings.standardVoice : voices[0][0];
      return;
    }

  }

  window.LumeoVoicePicker = {
    __loaded: true,
    CAPTION_TTS_OPTIONS,
    STANDARD_VOICES,
    STANDARD_DEFAULT_VOICE,
    populate,
  };
})();
