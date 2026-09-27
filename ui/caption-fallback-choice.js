(() => {
  "use strict";

  if (window.LumeoCaptionFallbackChoice?.__loaded) return;

  function fallbackTitle(diagnostics = {}) {
    if (diagnostics.reason === "no-target-language") return "没有匹配的字幕语言";
    if (diagnostics.reason === "timedtext-empty-body") return "YouTube 返回了空字幕";
    return "没有找到 YouTube 字幕";
  }

  function createButton(doc, className, text, onClick) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function createTrackInfo(doc, tracks = []) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const trackInfo = doc.createElement("div");
    trackInfo.className = "ec-choice-tracks";
    const head = doc.createElement("strong");
    head.textContent = `检测到 ${tracks.length} 条字幕轨道`;
    trackInfo.appendChild(head);
    const list = doc.createElement("ul");
    for (const track of tracks.slice(0, 12)) {
      const item = doc.createElement("li");
      const tag = track.kind === "asr" ? " · 自动生成" : "";
      item.textContent = `${track.languageCode}${tag}${track.name ? ` — ${track.name}` : ""}`;
      list.appendChild(item);
    }
    trackInfo.appendChild(list);
    return trackInfo;
  }

  function create(options = {}) {
    const doc = options.document || document;
    const diagnostics = options.diagnostics || {};
    const wrap = doc.createElement("div");
    wrap.className = "ec-choice";

    const title = doc.createElement("strong");
    title.textContent = fallbackTitle(diagnostics);

    const copy = doc.createElement("small");
    copy.textContent = options.reason || "此视频没有可读取的字幕轨道。";

    const trackInfo = createTrackInfo(doc, diagnostics.tracks);
    const actions = doc.createElement("div");
    actions.className = "ec-choice-actions";
    actions.append(
      createButton(doc, "ec-choice-btn", "用 MiniMax 识别并中文配音", () => options.onMiniMax?.()),
      createButton(doc, "ec-choice-btn", "尝试 Groq Whisper 语音识别", () => options.onGroq?.()),
      createButton(doc, "ec-choice-btn", "尝试 Soniox 语音识别", () => options.onSoniox?.()),
      createButton(doc, "ec-choice-btn", "切换到标准配音", () => options.onStandard?.()),
      createButton(doc, "ec-choice-btn ec-choice-btn-muted", "重新获取字幕", () => options.onRetry?.()),
      createButton(doc, "ec-choice-btn ec-choice-btn-muted", "取消", () => options.onCancel?.()),
    );

    wrap.append(title, copy);
    if (trackInfo) wrap.append(trackInfo);
    wrap.append(actions);
    return wrap;
  }

  window.LumeoCaptionFallbackChoice = {
    __loaded: true,
    fallbackTitle,
    create,
  };
})();
