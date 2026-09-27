// Shared controls for the YouTube page's preparation and playback panels.
(() => {
  "use strict";
  if (window.YimuPanel) return;

  const POSITION_KEY = "yimu.panel.position";
  const PHASES = {
    inspecting: "检查视频",
    downloading: "读取音轨",
    transcribing: "识别字幕",
    translating: "翻译字幕",
    speaking: "生成配音",
    ready: "准备完成",
    failed: "处理暂停",
  };

  function attach(panel, header, { onClose } = {}) {
    let closeCallback = onClose;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "yimu-panel-close";
    closeButton.setAttribute("aria-label", "关闭译幕面板");
    closeButton.title = "关闭面板，后台继续准备";
    closeButton.textContent = "×";
    header.append(closeButton);

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "yimu-panel-restore";
    restoreButton.textContent = "译幕 · 查看进度";
    restoreButton.hidden = true;
    document.body.append(restoreButton);

    const progress = document.createElement("div");
    progress.className = "yimu-panel-progress";
    const progressLabelRow = document.createElement("div");
    progressLabelRow.className = "yimu-panel-progress-row";
    const orbHost = document.createElement("span");
    orbHost.className = "yimu-panel-progress-orb";
    orbHost.setAttribute("aria-hidden", "true");
    orbHost.hidden = true;
    const progressLabel = document.createElement("span");
    progressLabel.className = "yimu-panel-progress-label";
    progressLabel.textContent = "正在连接…";
    const bar = document.createElement("progress");
    bar.max = 100;
    bar.setAttribute("aria-label", "译幕准备进度");
    progressLabelRow.append(orbHost, progressLabel);
    progress.append(progressLabelRow, bar);

    let persistent = false;
    let pointer = null;
    let orbTimer = null;
    let orbController = null;
    let orbWanted = true;
    let orbState = "connecting";

    function stopOrb() {
      clearTimeout(orbTimer);
      orbTimer = null;
      orbController?.destroy();
      orbController = null;
      orbHost.hidden = true;
    }

    function scheduleOrb() {
      if (!orbWanted || panel.hidden || orbTimer || orbController || !window.YimuThinkingOrb) return;
      orbTimer = setTimeout(() => {
        orbTimer = null;
        if (!orbWanted || panel.hidden) return;
        orbController = window.YimuThinkingOrb.mount(orbHost, orbState);
        orbHost.hidden = !orbController;
      }, 2000);
    }

    function position(left, top) {
      const bounds = panel.getBoundingClientRect();
      const width = bounds.width || panel.offsetWidth || 344;
      const height = bounds.height || panel.offsetHeight || 180;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      const maxTop = Math.max(8, window.innerHeight - height - 8);
      panel.style.left = `${Math.min(maxLeft, Math.max(8, left))}px`;
      panel.style.top = `${Math.min(maxTop, Math.max(8, top))}px`;
      panel.style.right = "auto";
    }

    function hide({ keepClosed = false } = {}) {
      persistent = keepClosed;
      panel.hidden = true;
      restoreButton.hidden = false;
      stopOrb();
    }

    function show({ force = false } = {}) {
      if (persistent && !force) return;
      persistent = false;
      panel.hidden = false;
      restoreButton.hidden = true;
      scheduleOrb();
    }

    closeButton.addEventListener("click", () => {
      hide({ keepClosed: true });
      closeCallback?.();
    });
    restoreButton.addEventListener("click", () => show({ force: true }));

    function onMove(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      position(pointer.left + event.clientX - pointer.x, pointer.top + event.clientY - pointer.y);
    }

    function onEnd(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      pointer = null;
      header.classList.remove("is-dragging");
      try {
        const left = parseFloat(panel.style.left);
        const top = parseFloat(panel.style.top);
        if (Number.isFinite(left) && Number.isFinite(top)) {
          sessionStorage.setItem(POSITION_KEY, JSON.stringify({ left, top }));
        }
      } catch { /* Storage can be disabled by the browser. */ }
    }

    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const bounds = panel.getBoundingClientRect();
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
      header.classList.add("is-dragging");
      event.preventDefault();
    });
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
    window.addEventListener("resize", onResize);

    function onResize() {
      if (panel.style.left) position(parseFloat(panel.style.left), parseFloat(panel.style.top));
    }

    try {
      const saved = JSON.parse(sessionStorage.getItem(POSITION_KEY) || "null");
      if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) position(saved.left, saved.top);
    } catch { /* Ignore malformed or inaccessible saved positions. */ }
    scheduleOrb();

    return {
      progress,
      get keepClosed() { return persistent; },
      setOnClose(callback) { closeCallback = callback; },
      hide,
      show,
      setProgress(data = {}) {
        const phase = data.phase || "inspecting";
        const label = PHASES[phase] || "正在准备";
        const total = Number(data.total);
        const completed = Number(data.completed);
        orbState = phase === "inspecting" ? "searching" : phase === "downloading" ? "connecting" : "working";
        orbWanted = phase !== "ready" && phase !== "failed" && !(total > 0 && Number.isFinite(completed));
        if (orbWanted) {
          orbController?.setState(orbState);
          scheduleOrb();
        } else {
          stopOrb();
        }
        if (phase === "ready") {
          bar.value = 100;
          progressLabel.textContent = "准备完成 · 100%";
        } else if (phase === "failed") {
          bar.removeAttribute("value");
          progressLabel.textContent = label;
        } else if (total > 0 && Number.isFinite(completed)) {
          const count = Math.min(total, Math.max(0, completed));
          const percent = Math.round(count / total * 100);
          bar.value = percent;
          progressLabel.textContent = `${label} · ${count}/${total} · ${percent}%`;
        } else {
          bar.removeAttribute("value");
          progressLabel.textContent = `${label}中…`;
        }
      },
      destroy() {
        stopOrb();
        restoreButton.remove();
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onEnd);
        document.removeEventListener("pointercancel", onEnd);
        window.removeEventListener("resize", onResize);
      },
    };
  }

  window.YimuPanel = { attach };
})();
