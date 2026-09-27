(() => {
  "use strict";

  if (globalThis.LumeoTierRecommendation?.__loaded) return;

  function isLiveLike(tab = {}) {
    const text = `${tab.title || ""} ${tab.url || ""}`.toLowerCase();
    return /\blive\b|stream|premiere|podcast|webinar|conference|space\b/.test(text);
  }

  function recommendationFor(tab = {}, settings = {}) {
    const tier = settings.tier || "caption";
    if (tier === "standard") {
      return "字幕缺失、质量较差或更想听中文时，建议使用国内配音。";
    }
    if (settings.captionUnavailable) {
      return "此视频没有可读字幕，请尝试 MiniMax 国内配音。";
    }
    return "有字幕时用 MiniMax 大模型翻译并朗读；无字幕时可自动切到国内配音。";
  }

  globalThis.LumeoTierRecommendation = {
    __loaded: true,
    isLiveLike,
    recommendationFor,
  };
})();
