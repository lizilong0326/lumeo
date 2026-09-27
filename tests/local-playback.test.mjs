import { describe, expect, it, vi } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

const VIDEO_ID = "qYNweeDHiyU";
const JOB_ID = "01234567-89ab-cdef-0123-456789abcdef";

describe("YouTube 原页本地配音", () => {
  it("can start after navigating from the YouTube homepage to a watch page", async () => {
    const { dom, window } = await createSandboxWindow({ url: "https://www.youtube.com/" });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    video.pause = vi.fn();
    window.document.body.append(video);
    const snapshot = { id: JOB_ID, videoId: VIDEO_ID, fullPreparation: true, status: "speaking",
      progress: { phase: "speaking", completed: 1, total: 2, detail: "中文配音 1/2" }, queue: { segments: [] } };
    window.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => callback({ ok: true, data: snapshot }) } };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      expect(window.YimuLocalPlayback?.connect).toBeTypeOf("function");
      window.history.pushState({}, "", `/watch?v=${VIDEO_ID}`);
      window.YimuLocalPlayback.connect(JOB_ID, 8791);
      await vi.waitFor(() => expect(window.document.querySelector(".yimu-panel-status")?.textContent).toContain("中文配音 1/2"));
      expect(window.document.querySelector(".yimu-panel")).not.toBeNull();
    } finally { dom.window.close(); }
  });

  it("rebinds to the new video after YouTube navigates between watch pages", async () => {
    const secondVideoId = "phOhGqpXss4";
    const secondJobId = "fedcba98-7654-3210-fedc-ba9876543210";
    const { dom, window } = await createSandboxWindow({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}` });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    video.pause = vi.fn();
    window.document.body.append(video);
    window.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => {
      const second = message.jobId === secondJobId;
      callback({ ok: true, data: { id: message.jobId, videoId: second ? secondVideoId : VIDEO_ID,
        fullPreparation: true, status: "speaking", progress: { detail: second ? "新视频任务" : "旧视频任务" }, queue: { segments: [] } } });
    } } };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      window.YimuLocalPlayback.connect(JOB_ID, 8791);
      await vi.waitFor(() => expect(window.document.querySelector(".yimu-panel-status")?.textContent).toBe("旧视频任务"));
      window.history.pushState({}, "", `/watch?v=${secondVideoId}`);
      window.YimuLocalPlayback.connect(secondJobId, 8791);
      await vi.waitFor(() => expect(window.document.querySelector(".yimu-panel-status")?.textContent).toBe("新视频任务"));
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(window.document.querySelector(".yimu-panel")).not.toBeNull();
      expect(window.sessionStorage.getItem(`yimu.fullJob.${secondVideoId}`)).toBe(`8791:${secondJobId}`);
    } finally { dom.window.close(); }
  });

  it("shows a countdown and immediate skip during automatic rate-limit retries", async () => {
    const { dom, window } = await createSandboxWindow({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}` });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    video.pause = vi.fn();
    window.document.body.append(video);
    const waiting = { id: JOB_ID, videoId: VIDEO_ID, fullPreparation: true, status: "speaking",
      retryingSpeechIndex: 71, retryAt: Date.now() + 60_000, retryAttempt: 2,
      progress: { detail: "第 72 条遇到 MiniMax 限流，等待 60 秒后重试（2/3）" }, queue: { segments: [] } };
    const actions = [];
    window.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => {
      actions.push(message.action);
      callback({ ok: true, data: waiting });
    } } };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      window.YimuLocalPlayback.connect(JOB_ID, 8791);
      await vi.waitFor(() => expect(window.document.querySelector("aside p")?.textContent).toContain("秒后重试"));
      const skip = [...window.document.querySelectorAll("aside button")].find((button) => button.textContent.includes("跳过第 72 句"));
      expect(skip.hidden).toBe(false);
      skip.click();
      await vi.waitFor(() => expect(actions).toContain("skip"));
    } finally { dom.window.close(); }
  });

  it.each(["retry", "skip"])("offers %s when a full speech job fails", async (action) => {
    const { dom, window } = await createSandboxWindow({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}` });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    video.pause = vi.fn();
    window.document.body.append(video);
    const failed = { id: JOB_ID, videoId: VIDEO_ID, fullPreparation: true, status: "failed",
      failedSpeechIndex: 30, error: "第 31 条中文配音失败：rate limit exceeded(RPM)", queue: { segments: [] } };
    const recovering = { ...failed, status: "speaking", error: "", progress: { detail: "正在生成整片中文语音" } };
    const actions = [];
    let state = failed;
    window.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => {
      actions.push(message.action);
      if (message.action === action) state = recovering;
      callback({ ok: true, data: state });
    } } };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      window.YimuLocalPlayback.connect(JOB_ID, 8791);
      await vi.waitFor(() => expect(window.document.querySelector("aside p")?.textContent).toContain("第 31 条"));
      const buttons = [...window.document.querySelectorAll("aside button")];
      const target = buttons.find((button) => button.textContent.includes(action === "retry" ? "继续重试" : "跳过第 31 句"));
      expect(target.hidden).toBe(false);
      target.click();
      await vi.waitFor(() => expect(actions).toContain(action));
      await vi.waitFor(() => expect(target.hidden).toBe(true));
    } finally { dom.window.close(); }
  });

  it("lets the viewer dismiss preparation and choose playback after the whole video is ready", async () => {
    const { dom, window } = await createSandboxWindow({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}` });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    video.currentTime = 42;
    video.pause = vi.fn();
    video.play = vi.fn(async () => {});
    window.document.body.append(video);
    let ready = false;
    const pending = { id: JOB_ID, videoId: VIDEO_ID, fullPreparation: true, status: "speaking", progress: { phase: "speaking", completed: 1, total: 2, detail: "中文配音 1/2" }, queue: { segments: [] } };
    const completed = { ...pending, status: "ready", queue: { segments: [{ index: 0, start: 0, end: 300, status: "ready", cues: [] }] } };
    window.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => {
      callback({ ok: true, data: message.action === "timeline" ? completed : ready ? completed : pending });
    } } };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      window.YimuLocalPlayback.connect(JOB_ID, 8791);
      await vi.waitFor(() => expect(window.document.querySelector("aside p")?.textContent).toContain("中文配音 1/2"));
      const panel = window.document.querySelector("aside");
      expect(panel.querySelector("progress").value).toBe(50);
      expect(panel.querySelector(".yimu-panel-actions button").disabled).toBe(true);
      [...panel.querySelectorAll("button")].find((button) => button.textContent.includes("先看原视频")).click();
      expect(panel.hidden).toBe(true);
      expect(video.play).toHaveBeenCalledOnce();
      ready = true;
      await vi.waitFor(() => expect(panel.hidden).toBe(false), { timeout: 2500 });
      expect(panel.textContent).toContain("从头播放中文");
      expect(panel.textContent).toContain("从当前位置播放中文配音");
      expect(video.currentTime).toBe(42);
    } finally { dom.window.close(); }
  });

  it("keeps a manually closed panel hidden when the whole-video job becomes ready", async () => {
    const { dom, window } = await createSandboxWindow({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}` });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    video.pause = vi.fn();
    window.document.body.append(video);
    let ready = false;
    const pending = { id: JOB_ID, videoId: VIDEO_ID, fullPreparation: true, status: "speaking",
      progress: { phase: "speaking", completed: 1, total: 2, detail: "中文配音 1/2" }, queue: { segments: [] } };
    const completed = { ...pending, status: "ready", progress: { phase: "ready", completed: 2, total: 2 },
      queue: { segments: [{ index: 0, start: 0, end: 300, status: "ready", cues: [] }] } };
    window.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => {
      callback({ ok: true, data: message.action === "timeline" ? completed : ready ? completed : pending });
    } } };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      window.YimuLocalPlayback.connect(JOB_ID, 8791);
      await vi.waitFor(() => expect(window.document.querySelector("aside p")?.textContent).toContain("中文配音 1/2"));
      const panel = window.document.querySelector("aside");
      panel.querySelector(".yimu-panel-close").click();
      expect(panel.hidden).toBe(true);
      ready = true;
      await vi.waitFor(() => expect(panel.querySelector("progress").value).toBe(100), { timeout: 2500 });
      expect(panel.hidden).toBe(true);
      window.document.querySelector(".yimu-panel-restore").click();
      expect(panel.hidden).toBe(false);
    } finally { dom.window.close(); }
  });
  it("pairs by video ID, starts at the current position, and pauses at an unready segment", async () => {
    const { dom, window } = await createSandboxWindow({
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}#yimu-local=8791:${JOB_ID}`,
    });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    window.document.body.append(video);
    let paused = false;
    Object.defineProperty(video, "paused", { get: () => paused });
    video.pause = vi.fn(() => { paused = true; video.dispatchEvent(new window.Event("pause")); });
    video.play = vi.fn(async () => { paused = false; video.dispatchEvent(new window.Event("play")); });
    const segment = (index, status) => ({ index, start: index * 300, end: (index + 1) * 300, status, cues: [] });
    const snapshot = {
      id: JOB_ID, videoId: VIDEO_ID, status: "processing",
      queue: { segments: [segment(0, "ready"), segment(1, "pending")] },
    };
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (message, callback) => {
          if (message.action === "status") callback({ ok: true, data: snapshot });
          else callback({ ok: true, data: {} });
        },
      },
    };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
      await vi.waitFor(() => expect(window.document.querySelector(".yimu-panel-actions button")?.disabled).toBe(false));
      expect(window.location.hash).toBe("");
      video.currentTime = 42;
      window.document.querySelector(".yimu-panel-actions button").click();
      await vi.waitFor(() => expect(video.play).toHaveBeenCalled());
      expect(video.pause).toHaveBeenCalled();
      expect(video.currentTime).toBe(42);
      expect(video.muted).toBe(true);
      video.currentTime = 301;
      await vi.waitFor(() => expect(video.paused).toBe(true));
      expect(window.document.querySelector("aside p").textContent).toContain("等待当前片段");
    } finally {
      dom.window.close();
    }
  });

  it("shows one short subtitle and seeks inside the matching voice cue", async () => {
    const { dom, window } = await createSandboxWindow({
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}#yimu-local=8791:${JOB_ID}`,
    });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    window.document.body.append(video);
    let paused = false;
    Object.defineProperty(video, "paused", { get: () => paused });
    video.pause = vi.fn(() => { paused = true; video.dispatchEvent(new window.Event("pause")); });
    video.play = vi.fn(async () => { paused = false; video.dispatchEvent(new window.Event("play")); });
    video.currentTime = 30;
    const translated = "开头介绍这个主题，随后讲到第一个例子。中间进一步解释原因，还展示了相关画面。最后归纳出重点，提醒观众注意细节。";
    const snapshot = {
      id: JOB_ID, videoId: VIDEO_ID, status: "processing",
      queue: { segments: [{ index: 0, start: 0, end: 300, status: "ready", cues: [
        { start: 0, end: 60, translated, audioUrl: "/audio/0.mp3" },
      ] }] },
    };
    const audios = [];
    const stream = { getAudioTracks: () => [{ readyState: "live" }] };
    const glowController = { setStream: vi.fn(), destroy: vi.fn() };
    window.YimuVoiceGlow = { prime: vi.fn(), mount: vi.fn(() => glowController) };
    window.Audio = class extends window.EventTarget {
      constructor(src) {
        super();
        this.src = src;
        this.readyState = 1;
        this.duration = 30;
        this.currentTime = 0;
        audios.push(this);
      }
      load() {}
      play() { return Promise.resolve(); }
      pause() {}
      captureStream() { return stream; }
    };
    window.URL.createObjectURL = vi.fn(() => "blob:voice");
    window.URL.revokeObjectURL = vi.fn();
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (message, callback) => callback(message.action === "status"
          ? { ok: true, data: snapshot }
          : { ok: true, data: { base64: "AA==" } }),
      },
    };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
      await vi.waitFor(() => expect(window.document.querySelector(".yimu-panel-actions button")?.disabled).toBe(false));
      window.document.querySelector(".yimu-panel-actions button").click();
      await vi.waitFor(() => expect(audios[0]?.currentTime).toBeCloseTo(15, 1));
      await vi.waitFor(() => expect(glowController.setStream).toHaveBeenCalledWith(stream));
      expect(window.YimuVoiceGlow.prime).toHaveBeenCalledOnce();
      expect(window.document.querySelector(".yimu-voice-glow-host").hidden).toBe(false);
      const subtitle = Array.from(window.document.querySelectorAll("div")).find((node) => node.style.pointerEvents === "none");
      expect(subtitle?.textContent.length).toBeLessThanOrEqual(34);
      expect(subtitle?.textContent).not.toBe(translated);
      video.currentTime = 50;
      video.dispatchEvent(new window.Event("seeking"));
      await vi.waitFor(() => expect(audios[0]?.currentTime).toBeCloseTo(25, 1));
      expect(subtitle?.textContent.length).toBeLessThanOrEqual(34);
      video.dispatchEvent(new window.Event("pause"));
      expect(glowController.setStream).toHaveBeenCalledWith(null);
      expect(window.document.querySelector(".yimu-voice-glow-host").hidden).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it("seeks to the correct offset inside a shared group audio file", async () => {
    const { dom, window } = await createSandboxWindow({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}` });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    window.document.body.append(video);
    let paused = false;
    Object.defineProperty(video, "paused", { get: () => paused });
    video.pause = vi.fn(() => { paused = true; video.dispatchEvent(new window.Event("pause")); });
    video.play = vi.fn(async () => { paused = false; video.dispatchEvent(new window.Event("play")); });
    video.currentTime = 6;
    const cues = [
      { start: 0, end: 5, translated: "第一句", audioUrl: "/audio/0/0", audioGroup: 0, audioStart: 0, audioEnd: 10, audioDuration: 20 },
      { start: 5, end: 10, translated: "第二句", audioUrl: "/audio/0/1", audioGroup: 0, audioStart: 10, audioEnd: 20, audioDuration: 20 },
    ];
    const snapshot = { id: JOB_ID, videoId: VIDEO_ID, status: "processing",
      queue: { segments: [{ index: 0, start: 0, end: 300, status: "ready", cues }] } };
    const audios = [];
    window.Audio = class extends window.EventTarget {
      constructor(src) { super(); this.src = src; this.readyState = 1; this.duration = 20; this.currentTime = 0; audios.push(this); }
      load() {}
      play() { return Promise.resolve(); }
      pause() {}
    };
    window.URL.createObjectURL = vi.fn(() => "blob:group");
    window.URL.revokeObjectURL = vi.fn();
    let fetches = 0;
    window.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => {
      if (message.action === "audio") fetches += 1;
      callback(message.action === "status" ? { ok: true, data: snapshot } : { ok: true, data: { base64: "AA==" } });
    } } };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      window.YimuLocalPlayback.connect(JOB_ID, 8791);
      await vi.waitFor(() => expect(window.document.querySelector(".yimu-panel-actions button")?.disabled).toBe(false));
      window.document.querySelector(".yimu-panel-actions button").click();
      await vi.waitFor(() => expect(audios[0]?.currentTime).toBeCloseTo(12, 1));
      video.currentTime = 1;
      video.dispatchEvent(new window.Event("seeking"));
      await vi.waitFor(() => expect(audios[0]?.currentTime).toBeCloseTo(2, 1));
      expect(audios).toHaveLength(1);
      expect(fetches).toBe(1);
    } finally { dom.window.close(); }
  });

  it("loads a distant uncached voice before resuming the original YouTube player", async () => {
    const { dom, window } = await createSandboxWindow({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}` });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    window.document.body.append(video);
    let paused = false;
    Object.defineProperty(video, "paused", { get: () => paused });
    video.pause = vi.fn(() => { paused = true; video.dispatchEvent(new window.Event("pause")); });
    video.play = vi.fn(async () => { paused = false; video.dispatchEvent(new window.Event("play")); });
    video.currentTime = 1;
    const snapshot = { id: JOB_ID, videoId: VIDEO_ID, status: "processing", queue: { segments: [
      { index: 0, start: 0, end: 300, status: "ready", cues: [{ start: 0, end: 10, translated: "开头", audioUrl: "/first", audioGroup: 0, audioStart: 0, audioEnd: 10, audioDuration: 10 }] },
      { index: 1, start: 300, end: 600, status: "ready", cues: [{ start: 300, end: 310, translated: "快进后", audioUrl: "/later", audioGroup: 1, audioStart: 10, audioEnd: 20, audioDuration: 20 }] },
    ] } };
    const audios = [];
    window.Audio = class extends window.EventTarget {
      constructor(src) { super(); this.src = src; this.readyState = audios.length ? 0 : 1; this.duration = audios.length ? 20 : 10; this.currentTime = 0; this.load = vi.fn(); this.play = vi.fn(async () => {}); this.pause = vi.fn(); audios.push(this); }
    };
    window.URL.createObjectURL = vi.fn(() => `blob:voice-${audios.length}`);
    window.URL.revokeObjectURL = vi.fn();
    window.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => callback(message.action === "status"
      ? { ok: true, data: snapshot } : { ok: true, data: { base64: "AA==" } }) } };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      window.YimuLocalPlayback.connect(JOB_ID, 8791);
      await vi.waitFor(() => expect(window.document.querySelector(".yimu-panel-actions button")?.disabled).toBe(false));
      window.document.querySelector(".yimu-panel-actions button").click();
      await vi.waitFor(() => expect(audios[0]?.play).toHaveBeenCalled());
      video.currentTime = 306;
      video.dispatchEvent(new window.Event("seeking"));
      await vi.waitFor(() => expect(video.paused).toBe(true));
      const later = audios[1];
      expect(later.load).toHaveBeenCalled();
      expect(window.document.querySelector("aside p").textContent).toContain("正在加载当前句");
      later.readyState = 1;
      later.dispatchEvent(new window.Event("loadedmetadata"));
      await vi.waitFor(() => expect(video.paused).toBe(false));
      await vi.waitFor(() => expect(later.play).toHaveBeenCalled());
      expect(later.currentTime).toBeCloseTo(16, 1);
    } finally { dom.window.close(); }
  });
});
