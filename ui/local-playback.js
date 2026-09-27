// Connect a preprocessed local-service job to the original YouTube player.
(() => {
  if (window.__yimuLocalPlayback) return;
  function currentVideoId() {
    if (location.pathname !== "/watch") return "";
    const id = new URL(location.href).searchParams.get("v") || "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
  }
  let videoId = currentVideoId();
  let bindingKey = videoId ? `yimu.fullJob.${videoId}` : "";
  const match = videoId ? location.hash.match(/^#yimu-local=(\d{1,5}):([a-f0-9-]{36})$/) : null;
  const saved = bindingKey ? sessionStorage.getItem(bindingKey)?.match(/^(\d{1,5}):([a-f0-9-]{36})$/) : null;
  let port = Number(match?.[1] || saved?.[1] || 0);
  let jobId = match?.[2] || saved?.[2] || "";
  window.__yimuLocalPlayback = true;
  if (match) history.replaceState(history.state, "", location.pathname + location.search);

  let job = null;
  let video = null;
  let started = false;
  let closed = false;
  let waitingIndex = null;
  let currentCueKey = "";
  let currentAudio = null;
  let currentAudioKey = "";
  let audioEpoch = 0;
  let starting = false;
  let waitingAudioKey = "";
  let voicePlayPending = false;
  let originalMuted = false;
  const audioCache = new Map();
  const audioLoads = new Map();
  let panel;
  let panelControls;
  let pendingHandoff = null;
  let pendingVisibility = null;
  let status;
  let startButton;
  let retryButton;
  let skipButton;
  let recovering = false;
  let subtitle;
  let dismissButton;
  let fromStartButton;
  let timeline = null;
  let timelineLoading = null;
  let readyNotified = false;
  let initialized = false;
  const timers = [];
  let videoPauseHandler;
  let videoSeekHandler;
  let videoPlayHandler;

  const MAX_SUBTITLE_CHARS = 34;

  function subtitlePieces(text) {
    const clauses = String(text || "").trim().match(/[^，。！？!?；;,.]+[，。！？!?；;,.]?/gu) || [];
    const pieces = [];
    let current = "";
    for (const clause of clauses) {
      let rest = clause.trim();
      while (rest.length > MAX_SUBTITLE_CHARS) {
        if (current) { pieces.push(current); current = ""; }
        pieces.push(rest.slice(0, MAX_SUBTITLE_CHARS));
        rest = rest.slice(MAX_SUBTITLE_CHARS);
      }
      if (!rest) continue;
      if (current && (current + rest).length > MAX_SUBTITLE_CHARS) {
        pieces.push(current);
        current = "";
      }
      current += rest;
    }
    if (current) pieces.push(current);
    return pieces;
  }

  function subtitleAt(cue, seconds) {
    const pieces = subtitlePieces(cue?.translated);
    if (!pieces.length) return "";
    if (pieces.length === 1) return pieces[0];
    const duration = Math.max(0.1, cue.end - cue.start);
    const target = Math.max(0, Math.min(0.999999, (seconds - cue.start) / duration)) *
      pieces.reduce((sum, piece) => sum + piece.length, 0);
    let count = 0;
    return pieces.find((piece) => { count += piece.length; return target < count; }) || pieces.at(-1);
  }

  function request(action, extra = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "YIMU_LOCAL_SERVICE", action, port, jobId, ...extra }, (reply) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!reply?.ok) return reject(new Error(reply?.error || "本地服务请求失败。"));
        resolve(reply.data);
      });
    });
  }

  function setStatus(message) { if (status) status.textContent = message; }

  function progressText(data) {
    if (Number.isInteger(data.retryingSpeechIndex) && Number.isFinite(data.retryAt)) {
      const remaining = Math.max(0, Math.ceil((data.retryAt - Date.now()) / 1000));
      const range = Number.isInteger(data.retryingSpeechEndIndex) && data.retryingSpeechEndIndex > data.retryingSpeechIndex
        ? `第 ${data.retryingSpeechIndex + 1}–${data.retryingSpeechEndIndex + 1} 条`
        : `第 ${data.retryingSpeechIndex + 1} 条`;
      return remaining
        ? `${range}遇到 MiniMax 限流，${remaining} 秒后重试（${data.retryAttempt}/3）；也可跳过本组。`
        : `正在重试${range}中文配音；也可跳过本组。`;
    }
    return data.progress?.detail || "正在准备整片字幕和配音…";
  }

  function stopAudio() {
    audioEpoch += 1;
    voicePlayPending = false;
    if (currentAudio) currentAudio.pause();
    currentAudio = null;
    currentCueKey = "";
    currentAudioKey = "";
  }

  function segmentAt(seconds) {
    const segments = job?.queue?.segments || [];
    return segments[Math.max(0, Math.min(segments.length - 1, Math.floor(seconds / 300)))];
  }

  function audioKey(segmentIndex, cueIndex, cue) {
    return Number.isInteger(cue?.audioGroup) ? `group:${cue.audioGroup}` : `${segmentIndex}:${cueIndex}`;
  }

  async function loadAudio(segmentIndex, cueIndex, cue) {
    const key = audioKey(segmentIndex, cueIndex, cue);
    if (audioCache.has(key)) return audioCache.get(key);
    if (audioLoads.has(key)) return audioLoads.get(key);
    const loading = (async () => {
      const { base64 } = await request("audio", { segment: segmentIndex, cue: cueIndex });
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      const audio = new Audio(url);
      audio.preload = "auto";
      audioCache.set(key, audio);
      if (audioCache.size > 24) {
        for (const [oldKey, oldAudio] of audioCache) {
          if (oldAudio === currentAudio) continue;
          audioCache.delete(oldKey);
          URL.revokeObjectURL(oldAudio.src);
          if (audioCache.size <= 20) break;
        }
      }
      return audio;
    })();
    audioLoads.set(key, loading);
    try { return await loading; }
    finally { audioLoads.delete(key); }
  }

  function audioReady(audio) {
    if (audio.readyState >= 1) return Promise.resolve(audio);
    return new Promise((resolve, reject) => {
      const ready = () => { cleanup(); resolve(audio); };
      const failed = () => { cleanup(); reject(new Error("中文语音加载失败，请重试。")); };
      const cleanup = () => {
        audio.removeEventListener("loadedmetadata", ready);
        audio.removeEventListener("error", failed);
      };
      audio.addEventListener("loadedmetadata", ready, { once: true });
      audio.addEventListener("error", failed, { once: true });
      audio.load();
    });
  }

  function preloadAudio(segment, time) {
    if (segment?.status !== "ready") return;
    for (let index = 0; index < segment.cues.length; index += 1) {
      const cue = segment.cues[index];
      if (!cue.audioUrl || cue.end < time || cue.start > time + 20) continue;
      const key = audioKey(segment.index, index, cue);
      if (!audioCache.has(key) && !audioLoads.has(key)) void loadAudio(segment.index, index, cue).then(audioReady).catch(() => {});
    }
  }

  function fitAudio(audio, cue) {
    const sourceRate = Math.max(0.1, Number(video.playbackRate) || 1);
    const slot = Math.max(0.3, cue.end - cue.start);
    const measuredDuration = Number(audio.duration);
    const scale = Number.isFinite(measuredDuration) && measuredDuration > 0 && Number(cue.audioDuration) > 0
      ? measuredDuration / cue.audioDuration : 1;
    const start = (Number(cue.audioStart) || 0) * scale;
    const end = Number.isFinite(Number(cue.audioEnd)) ? Number(cue.audioEnd) * scale
      : (Number.isFinite(measuredDuration) && measuredDuration > 0 ? measuredDuration : slot);
    const duration = Number.isFinite(measuredDuration) && measuredDuration > 0 ? measuredDuration : end;
    audio.playbackRate = Math.max(0.5, Math.min(4, Math.max(0.1, end - start) * sourceRate / slot));
    const expected = Math.max(start, start + (video.currentTime - cue.start) * audio.playbackRate / sourceRate);
    if (Math.abs(audio.currentTime - expected) > 0.35) audio.currentTime = Math.min(duration, expected);
  }

  function playCueAudio(audio, cue, key, epoch) {
    if (voicePlayPending || closed || video.paused || epoch !== audioEpoch || currentAudio !== audio) return;
    fitAudio(audio, cue);
    voicePlayPending = true;
    Promise.resolve().then(() => audio.play()).then(() => {
      if (epoch === audioEpoch) voicePlayPending = false;
    }).catch(() => {
      if (epoch !== audioEpoch || currentCueKey !== key) return;
      video.pause();
      stopAudio();
      setStatus("中文语音未能播放，请点击视频继续重试。");
    });
  }

  function sync() {
    if (closed || !started || !video || !job?.queue || video.paused) return;
    const segment = segmentAt(video.currentTime);
    if (!segment || segment.status !== "ready") {
      waitingIndex = segment?.index ?? 0;
      video.pause();
      stopAudio();
      if (subtitle) subtitle.textContent = "";
      setStatus(segment?.status === "failed" ? "片段处理失败，请返回本地服务重试。" : "正在等待当前片段的中文配音…");
      return;
    }
    preloadAudio(segment, video.currentTime);
    const cueIndex = segment.cues.findIndex((cue) => cue.start <= video.currentTime && video.currentTime < cue.end);
    const cue = segment.cues[cueIndex];
    const key = cue ? `${segment.index}:${cueIndex}` : "";
    const groupKey = cue ? audioKey(segment.index, cueIndex, cue) : "";
    if (subtitle) subtitle.textContent = cue ? subtitleAt(cue, video.currentTime) : "";
    if (key === currentCueKey) {
      if (currentAudio && cue) {
        fitAudio(currentAudio, cue);
        if (currentAudio.paused) playCueAudio(currentAudio, cue, key, audioEpoch);
      }
      return;
    }
    if (cue?.audioUrl && currentAudio && currentAudioKey === groupKey) {
      currentCueKey = key;
      fitAudio(currentAudio, cue);
      if (currentAudio.paused) playCueAudio(currentAudio, cue, key, audioEpoch);
      return;
    }
    stopAudio();
    if (!cue?.audioUrl) return;
    if (!audioCache.has(groupKey) || audioCache.get(groupKey).readyState < 1) {
      if (waitingAudioKey === key) return;
      waitingAudioKey = key;
      video.pause();
      setStatus("正在加载当前句的中文语音…");
      void loadAudio(segment.index, cueIndex, cue).then(audioReady).then(() => {
        if (closed || !started || waitingAudioKey !== key || video.currentTime < cue.start || video.currentTime >= cue.end) return;
        waitingAudioKey = "";
        void video.play().catch(() => setStatus("语音已就绪，请点击视频继续播放。"));
      }).catch((error) => { if (waitingAudioKey === key) { waitingAudioKey = ""; setStatus(error.message); } });
      return;
    }
    currentCueKey = key;
    const epoch = audioEpoch;
    loadAudio(segment.index, cueIndex, cue).then((audio) => {
      if (closed || !started || video.paused || epoch !== audioEpoch || currentCueKey !== key) return;
      currentAudio = audio;
      currentAudioKey = groupKey;
      playCueAudio(audio, cue, key, epoch);
    }).catch((error) => {
      if (epoch !== audioEpoch || currentCueKey !== key) return;
      video.pause();
      stopAudio();
      setStatus(`${error.message} 请点击视频重试。`);
    });
  }

  function stop() {
    closed = true;
    started = false;
    waitingAudioKey = "";
    stopAudio();
    if (video) {
      video.pause();
      video.muted = originalMuted;
      if (videoPauseHandler) video.removeEventListener("pause", videoPauseHandler);
      if (videoSeekHandler) video.removeEventListener("seeking", videoSeekHandler);
      if (videoPlayHandler) video.removeEventListener("play", videoPlayHandler);
    }
    for (const timer of timers.splice(0)) clearInterval(timer);
    for (const audio of audioCache.values()) URL.revokeObjectURL(audio.src);
    audioCache.clear();
    if (pendingHandoff) {
      pendingHandoff.controls.destroy();
      pendingHandoff.panel.remove();
      pendingHandoff = null;
    }
    pendingVisibility = null;
    panelControls?.destroy();
    panelControls = null;
    panel?.remove();
    subtitle?.remove();
    sessionStorage.removeItem(bindingKey);
  }

  function createUi() {
    const handoff = pendingHandoff;
    pendingHandoff = null;
    panel = handoff?.panel || document.createElement("aside");
    panel.className = "yimu-panel";
    const header = panel.querySelector(".yimu-panel-header") || document.createElement("div");
    header.className = "yimu-panel-header";
    if (handoff) {
      header.querySelector("strong").textContent = "译幕 · 本地中文配音";
      panelControls = handoff.controls;
      panelControls.setOnClose(null);
    } else {
      const mark = document.createElement("span");
      mark.className = "yimu-panel-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.innerHTML = '<svg viewBox="0 0 128 128"><path d="M41 30 64 56 87 30M64 56v23" fill="none" stroke="white" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><text x="64" y="112" fill="white" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="25" font-weight="700" letter-spacing="1">译幕</text></svg>';
      const title = document.createElement("strong");
      title.textContent = "译幕 · 本地中文配音";
      header.append(mark, title);
      panelControls = window.YimuPanel.attach(panel, header);
    }
    status = document.createElement("p");
    status.className = "yimu-panel-status";
    status.textContent = "正在连接本地服务…";
    const actions = document.createElement("div");
    actions.className = "yimu-panel-actions";
    startButton = document.createElement("button");
    startButton.textContent = "等待前 5 分钟准备完成";
    startButton.disabled = true;
    startButton.className = "yimu-panel-button yimu-panel-button-primary";
    startButton.addEventListener("click", async () => {
      const segment = video ? segmentAt(video.currentTime) : null;
      if (starting || !video || segment?.status !== "ready") return;
      starting = true;
      startButton.disabled = true;
      video.pause();
      setStatus("正在加载当前位置的中文语音…");
      try {
        const cueIndex = segment.cues.findIndex((cue) => cue.start <= video.currentTime && video.currentTime < cue.end);
        if (cueIndex >= 0 && segment.cues[cueIndex].audioUrl) await audioReady(await loadAudio(segment.index, cueIndex, segment.cues[cueIndex]));
      } catch (error) {
        setStatus(error.message);
        starting = false;
        startButton.disabled = false;
        return;
      }
      if (closed || segmentAt(video.currentTime)?.status !== "ready") return;
      started = true;
      starting = false;
      waitingIndex = null;
      waitingAudioKey = "";
      fromStartButton.hidden = true;
      dismissButton.hidden = true;
      startButton.hidden = true;
      stopAudio();
      video.pause();
      video.muted = true;
      video.play().catch(() => setStatus("请在视频播放器中点击播放。"));
      setStatus("正在按原视频时间同步中文配音");
    });
    fromStartButton = document.createElement("button");
    fromStartButton.textContent = "从头播放中文";
    fromStartButton.hidden = true;
    fromStartButton.className = "yimu-panel-button yimu-panel-button-secondary";
    fromStartButton.addEventListener("click", () => {
      if (!video || startButton.disabled) return;
      video.currentTime = 0;
      startButton.click();
    });
    dismissButton = document.createElement("button");
    dismissButton.textContent = "先看原视频，后台继续准备";
    dismissButton.className = "yimu-panel-button yimu-panel-button-text";
    dismissButton.addEventListener("click", () => {
      panelControls.hide();
      const source = video || document.querySelector("video.html5-main-video");
      if (source) { source.muted = originalMuted; void source.play().catch(() => {}); }
    });
    const stopButton = document.createElement("button");
    stopButton.textContent = "停止当前任务";
    stopButton.className = "yimu-panel-button yimu-panel-button-danger";
    stopButton.addEventListener("click", stop);
    const more = document.createElement("details");
    more.className = "yimu-panel-more";
    const moreLabel = document.createElement("summary");
    moreLabel.textContent = "任务操作";
    more.append(moreLabel, stopButton);
    retryButton = document.createElement("button");
    retryButton.textContent = "继续重试";
    retryButton.hidden = true;
    retryButton.className = "yimu-panel-button yimu-panel-button-primary";
    skipButton = document.createElement("button");
    skipButton.hidden = true;
    skipButton.className = "yimu-panel-button yimu-panel-button-secondary";
    async function recover(action) {
      if (recovering || (job?.status !== "failed" && !(action === "skip" && Number.isInteger(job?.retryingSpeechIndex)))) return;
      recovering = true;
      retryButton.disabled = true;
      skipButton.disabled = true;
      try {
        job = await request(action);
        setStatus(action === "skip" ? "已跳过这一组配音，正在继续生成…" : "正在继续生成配音…");
        retryButton.hidden = true;
        skipButton.hidden = true;
        void poll();
      } catch (error) { setStatus(error.message); }
      finally { recovering = false; retryButton.disabled = false; skipButton.disabled = false; }
    }
    retryButton.addEventListener("click", () => { void recover("retry"); });
    skipButton.addEventListener("click", () => { void recover("skip"); });
    actions.append(startButton, fromStartButton, dismissButton, retryButton, skipButton);
    panel.replaceChildren(header, status, panelControls.progress, actions, more);
    if (!panel.isConnected) document.body.append(panel);
    subtitle = document.createElement("div");
    subtitle.style.cssText = "position:absolute;left:12%;right:12%;bottom:13%;z-index:2147483647;color:white;text-align:center;font:700 25px/1.45 sans-serif;max-height:3em;overflow:hidden;text-shadow:0 2px 5px #000,0 0 14px #000;pointer-events:none";
    document.body.append(subtitle);
  }

  async function poll() {
    if (closed) return;
    try {
      const data = await request("status");
      if (closed) return;
      job = timeline?.id === data.id && data.status === "ready" ? { ...data, queue: timeline.queue } : data;
      if (job.videoId !== videoId) throw new Error("本地任务与当前 YouTube 视频不一致。");
      panelControls.setProgress(job.progress || { phase: job.status });
      if (job.status === "failed" || job.status === "stopped") {
        panelControls.show();
        setStatus(job.error || "本地任务已停止。");
        startButton.disabled = true;
        retryButton.hidden = job.status !== "failed";
        skipButton.hidden = job.status !== "failed" || !job.fullPreparation || !Number.isInteger(job.failedSpeechIndex);
        if (!skipButton.hidden) skipButton.textContent = Number.isInteger(job.failedSpeechEndIndex) && job.failedSpeechEndIndex > job.failedSpeechIndex
          ? `跳过第 ${job.failedSpeechIndex + 1}–${job.failedSpeechEndIndex + 1} 条配音（保留字幕）`
          : `跳过第 ${job.failedSpeechIndex + 1} 句继续（仅保留字幕）`;
        if (started) video?.pause();
        return;
      }
      retryButton.hidden = true;
      skipButton.hidden = !Number.isInteger(job.retryingSpeechIndex);
      if (!skipButton.hidden) skipButton.textContent = Number.isInteger(job.retryingSpeechEndIndex) && job.retryingSpeechEndIndex > job.retryingSpeechIndex
        ? `跳过第 ${job.retryingSpeechIndex + 1}–${job.retryingSpeechEndIndex + 1} 条配音（保留字幕）`
        : `跳过第 ${job.retryingSpeechIndex + 1} 句继续（仅保留字幕）`;
      if (job.fullPreparation && job.status !== "ready") {
        startButton.hidden = false;
        startButton.disabled = true;
        startButton.textContent = "等待整片中文配音";
        fromStartButton.hidden = true;
        dismissButton.hidden = false;
        setStatus(progressText(job));
        return;
      }
      if (job.fullPreparation && !timeline && !timelineLoading) {
        timelineLoading = request("timeline").then((loaded) => { timeline = loaded; }).catch((error) => setStatus(error.message)).finally(() => { timelineLoading = null; });
        await timelineLoading;
        if (timeline) job = { ...job, queue: timeline.queue };
      }
      if (job.fullPreparation && timeline && !readyNotified) {
        readyNotified = true;
        panelControls.show();
        fromStartButton.hidden = false;
        dismissButton.hidden = true;
        setStatus("整片中文配音已就绪。选择从头播放或从当前位置继续。");
      }
      const currentSegment = video ? segmentAt(video.currentTime) : null;
      const currentReady = currentSegment?.status === "ready";
      startButton.disabled = !currentReady || !video || starting || (job.fullPreparation && !timeline);
      startButton.hidden = (started && !video?.paused) || (job.fullPreparation && !started && Number(video?.currentTime || 0) < 2);
      fromStartButton.hidden = !job.fullPreparation || (started && !video?.paused);
      startButton.textContent = currentReady ? (started && video?.paused ? "继续中文配音" : "从当前位置播放中文配音") : "等待当前位置的中文配音";
      startButton.classList.toggle("yimu-panel-button-primary", !startButton.hidden);
      startButton.classList.toggle("yimu-panel-button-secondary", startButton.hidden);
      fromStartButton.classList.toggle("yimu-panel-button-primary", startButton.hidden);
      fromStartButton.classList.toggle("yimu-panel-button-secondary", !startButton.hidden);
      if (!started && !starting && !job.fullPreparation) setStatus(currentReady ? "配音已准备好，点击开始。" : (currentSegment?.step || "正在准备当前位置的配音…"));
      if (currentReady) preloadAudio(currentSegment, video.currentTime);
      if (started && waitingIndex !== null && job.queue?.segments[waitingIndex]?.status === "ready") {
        waitingIndex = null;
        video.play().catch(() => setStatus("片段已就绪，请点击视频继续播放。"));
      }
    } catch (error) {
      setStatus(`本地服务连接失败：${error.message}`);
    }
  }

  function attachVideo() {
    if (closed || video) return;
    video = document.querySelector("video.html5-main-video");
    if (!video) return;
    originalMuted = video.muted;
    videoPauseHandler = stopAudio;
    videoSeekHandler = stopAudio;
    videoPlayHandler = sync;
    video.addEventListener("pause", videoPauseHandler);
    video.addEventListener("seeking", videoSeekHandler);
    video.addEventListener("play", videoPlayHandler);
    startButton.disabled = segmentAt(video.currentTime)?.status !== "ready";
    const player = document.querySelector("#movie_player") || video.parentElement;
    if (player && subtitle) player.appendChild(subtitle);
  }

  function init() {
    if (initialized || closed) return;
    initialized = true;
    createUi();
    if (pendingVisibility?.minimized) panelControls.hide({ keepClosed: pendingVisibility.keepClosed === true });
    pendingVisibility = null;
    const attachTimer = setInterval(() => {
      if (closed) return clearInterval(attachTimer);
      if (new URL(location.href).searchParams.get("v") !== videoId) {
        stop();
        clearInterval(attachTimer);
        return;
      }
      attachVideo();
    }, 250);
    timers.push(attachTimer);
    timers.push(setInterval(() => { if (!closed) void poll(); }, 1000));
    timers.push(setInterval(sync, 120));
    timers.push(setInterval(() => {
      if (closed || !started || !video) return;
      void request("playhead", { seconds: video.currentTime }).catch((error) => setStatus(error.message));
    }, 2000));
    void poll();
  }

  function connect(nextJobId, nextPort = 8791, options = {}) {
    if (!/^[a-f0-9-]{36}$/.test(String(nextJobId)) || !Number.isInteger(Number(nextPort)) || Number(nextPort) < 1 || Number(nextPort) > 65535) {
      throw new Error("本地配音任务编号无效。");
    }
    const nextVideoId = currentVideoId();
    if (!nextVideoId) throw new Error("请先打开 YouTube 视频播放页。");
    if (initialized && !closed && jobId === nextJobId && videoId === nextVideoId) {
      if (options.minimized) panelControls.hide({ keepClosed: options.keepClosed === true });
      return true;
    }
    if ((initialized || pendingHandoff) && !closed && (jobId !== nextJobId || videoId !== nextVideoId)) stop();
    if (closed) {
      closed = false;
      initialized = false;
      started = false;
      starting = false;
      video = null;
      job = null;
      timeline = null;
      timelineLoading = null;
      readyNotified = false;
      waitingIndex = null;
      waitingAudioKey = "";
    }
    videoId = nextVideoId;
    bindingKey = `yimu.fullJob.${videoId}`;
    jobId = nextJobId;
    port = Number(nextPort);
    sessionStorage.setItem(bindingKey, `${port}:${jobId}`);
    pendingHandoff = options.handoff || null;
    pendingVisibility = options;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
    else init();
    return true;
  }

  window.YimuLocalPlayback = { connect, close: stop };
  if (jobId && port) connect(jobId, port);
})();
