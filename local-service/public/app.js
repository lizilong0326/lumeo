const form = document.querySelector("#start-form");
const workspace = document.querySelector("#workspace");
const urlInput = document.querySelector("#video-url");
const keyInput = document.querySelector("#api-key");
const voiceInput = document.querySelector("#voice");
const chromeCookiesInput = document.querySelector("#chrome-cookies");
const statusNode = document.querySelector("#status");
const segmentsNode = document.querySelector("#segments");
const segmentsDetail = document.querySelector("#segments-detail");
const segmentsSummary = document.querySelector("#segments-summary");
const taskTools = document.querySelector("#task-tools");
const embedHelp = document.querySelector("#embed-help");
const playButton = document.querySelector("#play");
const previewButton = document.querySelector("#preview");
const stopButton = document.querySelector("#stop");
const changeVideoButton = document.querySelector("#change-video");
const retryReadButton = document.querySelector("#retry-read");
const skipSpeechButton = document.querySelector("#skip-speech");
const titleNode = document.querySelector("#video-title");
const subtitleNode = document.querySelector("#subtitle");
const preparationNode = document.querySelector("#preparation");
const preparationDetail = document.querySelector("#preparation-detail");
const preparationProgress = document.querySelector("#preparation-progress");
const watchOriginalButton = document.querySelector("#watch-original");
const readyChoice = document.querySelector("#ready-choice");
const readyHeading = readyChoice.querySelector("strong");
const readyDescription = readyChoice.querySelector("p");
const playFromStart = document.querySelector("#play-from-start");
const playFromCurrent = document.querySelector("#play-from-current");
const originalLink = document.querySelector("#original-link");

let jobId = sessionStorage.getItem("yimu.localJobId") || "";
let job = null;
let player = null;
let playerReady = false;
let playingAudio = null;
let currentCueKey = "";
let currentAudioKey = "";
let voicePlayPending = false;
let loadingVoice = null;
let audioEpoch = 0;
let waitingForSegment = null;
let audioCache = new Map();
let embedError = "";
let playMode = "idle";
let starting = false;
let startEpoch = 0;
let timeline = null;
let timelineLoading = null;
let preparationDismissed = false;

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

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function formatTime(seconds) {
  const total = Math.floor(seconds || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function stopAudio() {
  audioEpoch += 1;
  voicePlayPending = false;
  if (playingAudio) { playingAudio.pause(); playingAudio = null; }
  currentCueKey = "";
  currentAudioKey = "";
}

function audioKey(cue) {
  return Number.isInteger(cue?.audioGroup) ? `${jobId}:group:${cue.audioGroup}` : cue?.audioUrl;
}

function audioReady(audio) {
  if (audio.readyState >= 1) return Promise.resolve(audio);
  return new Promise((resolve, reject) => {
    const ready = () => { cleanup(); resolve(audio); };
    const failed = () => { cleanup(); reject(new Error("当前位置的中文语音加载失败，请重试。")); };
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", ready);
      audio.removeEventListener("error", failed);
    };
    audio.addEventListener("loadedmetadata", ready, { once: true });
    audio.addEventListener("error", failed, { once: true });
    audio.load();
  });
}

function ensurePlayer(videoId) {
  if (player || !window.YT?.Player) return;
  player = new YT.Player("player", {
    videoId, playerVars: { playsinline: 1, rel: 0, origin: location.origin },
    events: {
      onReady: (event) => { playerReady = true; event.target.mute(); previewButton.disabled = false; },
      onStateChange: (event) => {
        if (event.data !== YT.PlayerState.PLAYING) stopAudio();
        if (job) updateUi(job);
      },
      onError: () => {
        embedError = "YouTube 要求登录或限制嵌入。请使用下方链接在安装译幕扩展的 Chrome 中打开。";
        previewButton.disabled = true;
        if (embedHelp) embedHelp.hidden = false;
        statusNode.textContent = embedError;
      },
    },
  });
}

window.onYouTubeIframeAPIReady = () => { if (job?.videoId) ensurePlayer(job.videoId); };

function updateUi(data) {
  job = timeline?.id === data.id && data.status === "ready" ? { ...data, queue: timeline.queue } : data;
  workspace.dataset.state = data.status;
  if (data.fullPreparation) form.hidden = true;
  titleNode.textContent = data.title || "正在读取视频";
  originalLink.hidden = !data.videoId;
  if (data.videoId) originalLink.href = `https://www.youtube.com/watch?v=${data.videoId}#yimu-local=${location.port}:${data.id}`;
  if (embedHelp) embedHelp.hidden = !embedError;
  const current = data.queue?.currentIndex || 0;
  const segments = job.queue?.segments || [];
  if (segmentsSummary) segmentsSummary.textContent = segments.length
    ? `${segments.filter((segment) => segment.status === "ready").length}/${segments.length} 段已就绪`
    : "正在读取视频";
  if (segmentsDetail) {
    segmentsDetail.hidden = data.status === "ready" || segments.length === 0;
    if (data.status === "failed") segmentsDetail.open = true;
  }
  if (taskTools) taskTools.hidden = data.status === "ready" || data.status === "stopped";
  segmentsNode.replaceChildren(...segments.map((segment) => {
    const item = document.createElement("div");
    item.className = `segment ${segment.status} ${segment.index === current ? "current" : ""}`;
    const label = document.createElement("strong");
    label.textContent = `${formatTime(segment.start)}–${formatTime(segment.end)}`;
    const detail = document.createElement("small");
    detail.textContent = segment.error || segment.step;
    item.append(label, detail);
    if (segment.status === "failed") {
      const retry = document.createElement("button");
      retry.className = "secondary";
      retry.textContent = "重试";
      retry.addEventListener("click", () => { api(`/api/jobs/${jobId}/retry/${segment.index}`, { method: "POST" }).catch(showError); });
      item.append(retry);
    }
    return item;
  }));
  const playbackTime = playerReady ? Number(player.getCurrentTime() || 0) : 0;
  const playbackIndex = Math.max(0, Math.min(segments.length - 1, Math.floor(playbackTime / 300)));
  const currentReady = segments[playbackIndex]?.status === "ready";
  const firstReady = segments[0]?.status === "ready";
  const allReady = segments.length > 0 && segments.every((segment) => segment.status === "ready");
  if (data.videoId) ensurePlayer(data.videoId);
  playButton.disabled = starting || !currentReady || !playerReady || Boolean(embedError) || data.status === "stopped" || (data.fullPreparation && data.status !== "ready");
  playButton.hidden = !!data.fullPreparation;
  previewButton.disabled = !playerReady || Boolean(embedError);
  previewButton.hidden = data.status !== "ready" || playMode === "original";
  watchOriginalButton.disabled = !playerReady || Boolean(embedError);
  playButton.textContent = currentReady ? "从当前位置播放中文配音" : "等待当前位置的中文配音";
  retryReadButton.hidden = data.status !== "failed";
  retryReadButton.textContent = data.fullPreparation ? "继续重试" : "重新尝试读取";
  const skipIndex = data.status === "failed" ? data.failedSpeechIndex : data.retryingSpeechIndex;
  const skipEndIndex = data.status === "failed" ? data.failedSpeechEndIndex : data.retryingSpeechEndIndex;
  skipSpeechButton.hidden = !data.fullPreparation || !Number.isInteger(skipIndex);
  if (!skipSpeechButton.hidden) skipSpeechButton.textContent = Number.isInteger(skipEndIndex) && skipEndIndex > skipIndex
    ? `跳过第 ${skipIndex + 1}–${skipEndIndex + 1} 条配音（保留字幕）`
    : `跳过第 ${skipIndex + 1} 句继续（仅保留字幕）`;
  const fullReady = data.fullPreparation && data.status === "ready";
  const playerState = playerReady ? player.getPlayerState?.() : null;
  const pausedDub = playMode === "dubbed" && playerState === (YT?.PlayerState?.PAUSED ?? 2);
  const endedDub = playMode === "dubbed" && playerState === (YT?.PlayerState?.ENDED ?? 0);
  preparationNode.hidden = !data.fullPreparation || preparationDismissed || fullReady || data.status === "failed" || data.status === "stopped";
  readyChoice.hidden = Boolean(loadingVoice) || !fullReady || (playMode === "dubbed" && !pausedDub && !endedDub);
  if (readyHeading) readyHeading.textContent = pausedDub ? "中文配音已暂停" : endedDub ? "视频已播放结束" : "整片中文配音已就绪";
  if (readyDescription) readyDescription.textContent = pausedDub ? "可以从当前进度继续中文配音。" : endedDub ? "已播放结束，可以重新从头观看。" : "从头播放，或接着当前进度观看。";
  playFromStart.textContent = endedDub ? "重新播放中文" : "从头播放中文";
  playFromCurrent.textContent = pausedDub ? "继续中文配音" : "从当前位置播放中文";
  playFromCurrent.hidden = endedDub || (!pausedDub && playbackTime < 2);
  playFromCurrent.classList.toggle("primary-button", pausedDub);
  playFromCurrent.classList.toggle("quiet-button", !pausedDub);
  playFromStart.classList.toggle("primary-button", !pausedDub);
  playFromStart.classList.toggle("quiet-button", pausedDub);
  playFromStart.disabled = !playerReady || !timeline || starting || Boolean(embedError);
  playFromCurrent.disabled = playFromStart.disabled;
  const progress = data.progress || {};
  preparationDetail.textContent = progress.detail || "正在准备整片字幕和配音…";
  preparationProgress.value = progress.total ? Math.round(100 * progress.completed / progress.total) : 0;
  const retryRange = Number.isInteger(data.retryingSpeechEndIndex) && data.retryingSpeechEndIndex > data.retryingSpeechIndex
    ? `第 ${data.retryingSpeechIndex + 1}–${data.retryingSpeechEndIndex + 1} 条` : `第 ${data.retryingSpeechIndex + 1} 条`;
  const retryText = Number.isInteger(data.retryingSpeechIndex) && Number.isFinite(data.retryAt)
    ? `${retryRange}遇到 MiniMax 限流，${Math.max(0, Math.ceil((data.retryAt - Date.now()) / 1000))} 秒后重试（${data.retryAttempt}/3）；也可跳过本组。`
    : "";
  statusNode.textContent = embedError || data.error || retryText || (loadingVoice ? "正在加载快进位置的中文语音…" : "") || (waitingForSegment !== null && data.status === "processing"
    ? `正在等待 ${formatTime(segments[waitingForSegment]?.start || 0)} 后的中文配音…`
    : data.fullPreparation ? (fullReady
      ? pausedDub ? "视频已暂停，可以从当前位置继续中文配音。"
        : endedDub ? "视频已结束，可以从头重播中文配音。"
          : playMode === "dubbed" ? "正在按视频进度播放中文配音。" : "整片中文配音已就绪，请选择播放位置。"
      : progress.detail || "正在准备整片中文配音…")
      : ({ inspecting: "正在读取视频信息…", downloading: "正在下载音轨…", processing: allReady ? "全部片段已就绪，可从当前位置播放中文配音。" : firstReady ? "前 5 分钟已就绪，后台继续准备后续片段。" : (segments[0]?.step || "正在处理第一段…"), stopped: "任务已停止。" }[data.status] || "准备中…"));
  if (playMode === "dubbed" && data.status === "processing" && waitingForSegment !== null && segments[waitingForSegment]?.status === "ready" && playerReady) {
    waitingForSegment = null;
    player.playVideo();
  }
}

function showError(error) { statusNode.textContent = error?.message || String(error); }

async function poll() {
  if (!jobId) return;
  try {
    const data = await api(`/api/jobs/${jobId}`);
    updateUi(data);
    if (data.fullPreparation && data.status === "ready" && timeline?.id !== data.id && !timelineLoading) {
      timelineLoading = api(`/api/jobs/${jobId}/timeline`).then((loaded) => {
        timeline = loaded;
        updateUi(data);
      }).catch(showError).finally(() => { timelineLoading = null; });
    }
  }
  catch (error) {
    if (error.message === "任务不存在。") {
      jobId = "";
      sessionStorage.removeItem("yimu.localJobId");
      form.hidden = false;
      statusNode.textContent = "本地服务已重启，原任务已失效。请重新填写链接和密钥。";
      playButton.disabled = true;
      retryReadButton.hidden = true;
      skipSpeechButton.hidden = true;
      return;
    }
    showError(error);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  startEpoch += 1;
  loadingVoice = null;
  starting = false;
  stopAudio();
  audioCache.clear();
  waitingForSegment = null;
  embedError = "";
  playMode = "idle";
  timeline = null;
  preparationDismissed = false;
  workspace.hidden = false;
  statusNode.textContent = "正在创建任务…";
  try {
    const data = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ mode: "full", url: urlInput.value, apiKey: keyInput.value, voice: voiceInput.value, useChromeCookies: chromeCookiesInput.checked }),
    });
    jobId = data.id;
    sessionStorage.setItem("yimu.localJobId", jobId);
    keyInput.value = "";
    form.hidden = true;
    if (player) { player.destroy(); player = null; playerReady = false; }
    updateUi(data);
  } catch (error) { showError(error); }
});

playButton.addEventListener("click", async () => {
  if (starting || !playerReady || !job?.queue) return;
  const time = Number(player.getCurrentTime() || 0);
  const segment = job.queue.segments[Math.floor(time / 300)];
  if (segment?.status !== "ready") return;
  starting = true;
  const epoch = ++startEpoch;
  loadingVoice = null;
  playButton.disabled = true;
  player.pauseVideo();
  stopAudio();
  subtitleNode.textContent = "";
  player.mute();
  const cueIndex = segment.cues.findIndex((cue) => cue.start <= time && time < cue.end);
  const cue = segment.cues[cueIndex];
  try {
    if (cue?.audioUrl) {
      const key = audioKey(cue);
      const audio = audioCache.get(key) || new Audio(cue.audioUrl);
      audioCache.set(key, audio);
      await audioReady(audio);
    }
  } catch (error) {
    if (epoch !== startEpoch) return;
    starting = false;
    playButton.disabled = false;
    showError(error);
    return;
  }
  if (epoch !== startEpoch) return;
  if (Math.abs(Number(player.getCurrentTime() || 0) - time) > 0.5 || job.queue.segments[Math.floor(time / 300)]?.status !== "ready") {
    starting = false;
    playButton.disabled = false;
    return;
  }
  playMode = "dubbed";
  starting = false;
  player.playVideo();
});

playFromCurrent.addEventListener("click", () => playButton.click());
playFromStart.addEventListener("click", async () => {
  if (!playerReady) return;
  player.pauseVideo();
  player.seekTo(0, true);
  for (let attempt = 0; attempt < 40 && Number(player.getCurrentTime() || 0) > 0.5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (Number(player.getCurrentTime() || 0) > 0.5) { showError(new Error("视频尚未跳到开头，请重试。")); return; }
  playButton.click();
});

watchOriginalButton.addEventListener("click", () => {
  if (playOriginal()) {
    preparationDismissed = true;
    preparationNode.hidden = true;
  }
});

changeVideoButton.addEventListener("click", () => {
  form.hidden = false;
  form.scrollIntoView?.({ behavior: "smooth", block: "center" });
  urlInput.focus();
});

function playOriginal() {
  if (!playerReady || embedError) return false;
  startEpoch += 1;
  loadingVoice = null;
  starting = false;
  playMode = "original";
  waitingForSegment = null;
  stopAudio();
  subtitleNode.textContent = "";
  player.unMute();
  player.playVideo();
  return true;
}

previewButton.addEventListener("click", playOriginal);

stopButton.addEventListener("click", async () => {
  startEpoch += 1;
  loadingVoice = null;
  starting = false;
  player?.pauseVideo();
  stopAudio();
  playMode = "idle";
  waitingForSegment = null;
  if (jobId) {
    try { updateUi(await api(`/api/jobs/${jobId}`, { method: "DELETE" })); }
    catch (error) { showError(error); }
  }
});

retryReadButton.addEventListener("click", async () => {
  if (!jobId) return;
  retryReadButton.disabled = true;
  try {
    updateUi(await api(`/api/jobs/${jobId}/restart`, {
      method: "POST",
      body: JSON.stringify({ useChromeCookies: chromeCookiesInput.checked }),
    }));
  } catch (error) { showError(error); }
  finally { retryReadButton.disabled = false; }
});

skipSpeechButton.addEventListener("click", async () => {
  if (!jobId) return;
  retryReadButton.disabled = true;
  skipSpeechButton.disabled = true;
  try { updateUi(await api(`/api/jobs/${jobId}/skip`, { method: "POST", body: "{}" })); }
  catch (error) { showError(error); }
  finally { retryReadButton.disabled = false; skipSpeechButton.disabled = false; }
});

function preloadUpcoming(cues, time) {
  for (const cue of cues) {
    const key = audioKey(cue);
    if (cue.end < time || cue.start > time + 20 || !cue.audioUrl || audioCache.has(key)) continue;
    const audio = new Audio(cue.audioUrl);
    audio.preload = "auto";
    audio.load();
    audioCache.set(key, audio);
  }
  if (audioCache.size > 24) {
    for (const [url, audio] of audioCache) {
      if (audio === playingAudio) continue;
      audioCache.delete(url);
      if (audioCache.size <= 20) break;
    }
  }
}

function playCueAudio(audio, cue, key) {
  if (voicePlayPending || playingAudio !== audio || player.getPlayerState() !== YT.PlayerState.PLAYING) return;
  fitAudioToVideo(audio, cue, Number(player.getCurrentTime() || 0));
  const epoch = audioEpoch;
  voicePlayPending = true;
  Promise.resolve().then(() => audio.play()).then(() => {
    if (epoch === audioEpoch) voicePlayPending = false;
  }).catch(() => {
    if (epoch !== audioEpoch || currentCueKey !== key) return;
    stopAudio();
    player.pauseVideo();
    statusNode.textContent = "中文语音未能播放，请点击“继续中文配音”重试。";
  });
}

function fitAudioToVideo(audio, cue, time) {
  const duration = Number(audio.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const slot = Math.max(0.3, cue.end - cue.start);
  const videoRate = Math.max(0.1, Number(player.getPlaybackRate?.() || 1));
  const scale = Number(cue.audioDuration) > 0 ? duration / cue.audioDuration : 1;
  const start = (Number(cue.audioStart) || 0) * scale;
  const end = Number.isFinite(Number(cue.audioEnd)) ? Number(cue.audioEnd) * scale : duration;
  audio.playbackRate = Math.max(0.5, Math.min(4, Math.max(0.1, end - start) * videoRate / slot));
  const expected = Math.max(start, Math.min(duration, start + (time - cue.start) * audio.playbackRate / videoRate));
  if (Math.abs(audio.currentTime - expected) > 0.3) audio.currentTime = expected;
}

function syncPlayback() {
  if (playMode !== "dubbed" || !playerReady || !job?.queue || player.getPlayerState() !== YT.PlayerState.PLAYING) return;
  const time = Number(player.getCurrentTime() || 0);
  const index = Math.min(job.queue.segments.length - 1, Math.floor(time / 300));
  const segment = job.queue.segments[index];
  if (!segment || segment.status !== "ready") {
    waitingForSegment = index;
    player.pauseVideo();
    stopAudio();
    subtitleNode.textContent = "";
    statusNode.textContent = `正在等待 ${formatTime(segment?.start || time)} 后的中文配音…`;
    return;
  }
  preloadUpcoming(segment.cues, time);
  const cueIndex = segment.cues.findIndex((cue) => cue.start <= time && time < cue.end);
  const cue = segment.cues[cueIndex];
  const key = cue ? `${index}:${cueIndex}` : "";
  const groupKey = cue ? audioKey(cue) : "";
  subtitleNode.textContent = cue ? subtitleAt(cue, time) : "";
  if (key === currentCueKey) {
    if (cue && playingAudio?.readyState >= 1) {
      fitAudioToVideo(playingAudio, cue, time);
      if (playingAudio.paused) playCueAudio(playingAudio, cue, key);
    }
    return;
  }
  if (cue?.audioUrl && playingAudio && currentAudioKey === groupKey) {
    currentCueKey = key;
    fitAudioToVideo(playingAudio, cue, time);
    if (playingAudio.paused) playCueAudio(playingAudio, cue, key);
    return;
  }
  stopAudio();
  if (!cue?.audioUrl) return;
  const audio = audioCache.get(groupKey) || new Audio(cue.audioUrl);
  audioCache.set(groupKey, audio);
  if (audio.readyState < 1) {
    if (loadingVoice?.key === key) return;
    const load = { key, epoch: startEpoch };
    loadingVoice = load;
    player.pauseVideo();
    statusNode.textContent = "正在加载快进位置的中文语音…";
    void audioReady(audio).then(() => {
      if (loadingVoice !== load || load.epoch !== startEpoch || playMode !== "dubbed") return;
      loadingVoice = null;
      player.playVideo();
    }).catch((error) => {
      if (loadingVoice !== load) return;
      loadingVoice = null;
      if (job) updateUi(job);
      statusNode.textContent = error.message;
    });
    return;
  }
  currentCueKey = key;
  playingAudio = audio;
  currentAudioKey = groupKey;
  playCueAudio(audio, cue, key);
}

setInterval(() => { void poll(); }, 1000);
if (jobId) { workspace.hidden = false; void poll(); }
setInterval(syncPlayback, 120);
setInterval(() => {
  if (playMode !== "dubbed" || !jobId || !playerReady || !job?.queue) return;
  const time = Number(player.getCurrentTime() || 0);
  void api(`/api/jobs/${jobId}/playhead`, { method: "POST", body: JSON.stringify({ seconds: time }) }).catch(() => {});
}, 2000);
