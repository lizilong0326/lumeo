// Prepare the entire video's timed transcript and Chinese voice before dubbed playback.
(() => {
  "use strict";
  if (window.YimuFullPrep) return;

  function request(action, extra = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "YIMU_LOCAL_SERVICE", action, port: 8791, ...extra }, (reply) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!reply?.ok) return reject(new Error(reply?.error || "本地服务请求失败。"));
        resolve(reply.data);
      });
    });
  }

  function createPreparationPanel(video) {
    const panel = document.createElement("aside");
    panel.className = "yimu-panel";
    const header = document.createElement("div");
    header.className = "yimu-panel-header";
    const mark = document.createElement("span");
    mark.className = "yimu-panel-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = '<svg viewBox="0 0 128 128"><path d="M41 30 64 56 87 30M64 56v23" fill="none" stroke="white" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><text x="64" y="112" fill="white" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="25" font-weight="700" letter-spacing="1">译幕</text></svg>';
    const title = document.createElement("strong");
    title.textContent = "译幕 · 正在准备整片中文配音";
    header.append(mark, title);
    const controls = window.YimuPanel.attach(panel, header, {
      onClose: () => { void video.play().catch(() => {}); },
    });
    const status = document.createElement("p");
    status.className = "yimu-panel-status";
    status.textContent = "正在检查视频字幕…";
    const actions = document.createElement("div");
    actions.className = "yimu-panel-actions";
    const dismiss = document.createElement("button");
    dismiss.textContent = "先看原视频，后台继续准备";
    dismiss.className = "yimu-panel-button yimu-panel-button-secondary";
    let minimized = false;
    dismiss.addEventListener("click", () => {
      minimized = true;
      controls.hide();
      void video.play().catch(() => {});
    });
    actions.append(dismiss);
    panel.append(header, status, controls.progress, actions);
    document.body.append(panel);
    return { panel, status, controls, get minimized() { return minimized || panel.hidden; } };
  }

  function start({ video, settings, onJobCreated, onError }) {
    let stopped = false;
    let handedOff = false;
    let activeJobId = "";
    video.pause();
    const ui = createPreparationPanel(video);
    const promise = (async () => {
      try {
        await request("health");
        if (stopped) return;
        const videoId = new URL(location.href).searchParams.get("v");
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) throw new Error("请先打开 YouTube 视频播放页。");
        ui.status.textContent = "正在读取整片字幕轨…";
        ui.controls.setProgress({ phase: "inspecting" });
        const diagnostics = {};
        let subtitles = null;
        try {
          subtitles = await window.LumeoCaptions.fetchSubtitles({ videoId, targetLanguage: "zh-CN", diagnostics });
        } catch {
          subtitles = null;
        }
        if (stopped) return;
        const cues = subtitles?.cues?.map(({ start, end, text }) => ({ start, end, text })).filter((cue) => cue.text);
        const measuredDuration = Number(video.duration || 0);
        const duration = Number.isFinite(measuredDuration) && measuredDuration > 0
          ? measuredDuration : (cues?.length ? Math.max(...cues.map((cue) => Number(cue.end) || 0)) : 0);
        ui.status.textContent = cues?.length
          ? `已读取 ${cues.length} 条字幕，正在准备整片翻译和配音…`
          : "没有可用的整片字幕，正在下载音轨并识别完整视频…";
        const created = await request("create", {
          apiKey: settings.minimaxKey,
          voice: settings.standardVoice || settings.minimaxVoice || "male-qn-qingse",
          title: document.title.replace(/\s*-\s*YouTube\s*$/i, ""),
          duration,
          sourceLanguage: subtitles?.sourceLanguage || "",
          useChromeCookies: settings.useChromeCookies === true,
          cues: cues?.length ? cues : undefined,
        });
        activeJobId = created.id;
        if (stopped) { void request("cancel", { jobId: activeJobId }).catch(() => {}); return; }
        handedOff = window.YimuLocalPlayback.connect(created.id, 8791, {
          minimized: ui.minimized,
          ...(ui.controls.keepClosed ? { keepClosed: true } : {}),
          handoff: { panel: ui.panel, controls: ui.controls },
        }) === true;
        if (!handedOff) {
          ui.controls.destroy();
          ui.panel.remove();
        }
        onJobCreated?.(created);
      } catch (error) {
        if (stopped) return;
        ui.controls.show();
        ui.controls.setProgress({ phase: "failed" });
        ui.status.textContent = `准备失败：${error?.message || String(error)}。请确认本地服务已运行。`;
        onError?.(error);
      }
    })();
    return {
      promise,
      stop() {
        stopped = true;
        if (!handedOff) {
          ui.controls.destroy();
          ui.panel.remove();
        }
        if (activeJobId) void request("cancel", { jobId: activeJobId }).catch(() => {});
      },
    };
  }

  window.YimuFullPrep = { start };
})();
