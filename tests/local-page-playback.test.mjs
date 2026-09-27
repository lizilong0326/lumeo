import { describe, expect, it, vi } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

describe("本地网页配音播放器", () => {
  it("shows retry and skip for a failed speech cue", async () => {
    const { dom, window } = await createSandboxWindow({ url: "http://127.0.0.1:8791/" });
    window.document.body.innerHTML = `
      <form id="start-form"><input id="video-url"><input id="api-key"><input id="voice"><input id="chrome-cookies" type="checkbox"></form>
      <section id="workspace"><span id="status"></span><div id="segments"></div>
      <div id="preparation"><span id="preparation-detail"></span><progress id="preparation-progress"></progress><button id="watch-original"></button></div>
      <div id="ready-choice"><button id="play-from-start"></button><button id="play-from-current"></button></div>
      <button id="play"></button><button id="preview"></button><button id="stop"></button><button id="change-video"></button>
      <button id="retry-read" hidden></button><button id="skip-speech" hidden></button>
      <span id="video-title"></span><div id="subtitle"></div><a id="original-link"></a><button id="copy-original"></button></section>`;
    window.sessionStorage.setItem("yimu.localJobId", "job-1");
    const failed = { id: "job-1", videoId: "qYNweeDHiyU", status: "failed", fullPreparation: true,
      failedSpeechIndex: 30, error: "第 31 条中文配音失败", queue: { segments: [] } };
    const paths = [];
    window.fetch = vi.fn(async (path) => {
      paths.push(path);
      return { ok: true, json: async () => failed };
    });
    try {
      loadService("local-service/public/app.js", window);
      await vi.waitFor(() => expect(window.document.querySelector("#skip-speech").hidden).toBe(false));
      expect(window.document.querySelector("#retry-read").textContent).toBe("继续重试");
      expect(window.document.querySelector("#skip-speech").textContent).toContain("第 31 句");
      window.document.querySelector("#skip-speech").click();
      await vi.waitFor(() => expect(paths).toContain("/api/jobs/job-1/skip"));
    } finally { dom.window.close(); }
  });

  it("waits for voice metadata, keeps the seek position, and limits visible subtitles", async () => {
    const { dom, window } = await createSandboxWindow({ url: "http://127.0.0.1:8791/" });
    window.document.body.innerHTML = `
      <form id="start-form"><input id="video-url"><input id="api-key"><input id="voice"><input id="chrome-cookies" type="checkbox"></form>
      <section id="workspace"><span id="status"></span><div id="segments"></div>
      <div id="preparation"><span id="preparation-detail"></span><progress id="preparation-progress"></progress><button id="watch-original"></button></div>
      <div id="ready-choice"><button id="play-from-start"></button><button id="play-from-current"></button></div>
      <button id="play" disabled></button><button id="preview"></button><button id="stop"></button><button id="change-video"></button><button id="retry-read"></button><button id="skip-speech"></button>
      <span id="video-title"></span><div id="subtitle"></div><a id="original-link"></a><button id="copy-original"></button></section>`;
    window.sessionStorage.setItem("yimu.localJobId", "job-1");
    const translated = "开头介绍这个主题，随后讲到第一个例子。中间进一步解释原因，还展示了相关画面。最后归纳出重点，提醒观众注意细节。";
    const snapshot = {
      id: "job-1", videoId: "qYNweeDHiyU", title: "测试视频", status: "processing",
      queue: { currentIndex: 0, segments: [{ index: 0, start: 0, end: 300, status: "ready", cues: [
        { start: 0, end: 60, translated, audioUrl: "/voice.mp3" },
      ] }] },
    };
    window.fetch = vi.fn(async () => ({ ok: true, json: async () => snapshot }));
    const audios = [];
    window.Audio = class extends window.EventTarget {
      constructor(src) {
        super();
        this.src = src;
        this.readyState = 0;
        this.duration = 30;
        this.currentTime = 0;
        audios.push(this);
      }
      load() {}
      play() { return Promise.resolve(); }
      pause() {}
    };
    let seconds = 30;
    let state = 2;
    let player;
    window.YT = {
      PlayerState: { PLAYING: 1 },
      Player: class {
        constructor(_element, options) {
          player = this;
          this.options = options;
          queueMicrotask(() => options.events.onReady({ target: this }));
        }
        getCurrentTime() { return seconds; }
        getPlayerState() { return state; }
        getPlaybackRate() { return 1; }
        mute() {}
        pauseVideo() { state = 2; this.options.events.onStateChange({ data: state }); }
        playVideo() { state = 1; this.options.events.onStateChange({ data: state }); }
      },
    };
    try {
      loadService("local-service/public/app.js", window);
      await vi.waitFor(() => expect(window.document.querySelector("#play").disabled).toBe(false), { timeout: 2500 });
      expect(window.document.querySelector("#status").textContent).toContain("全部片段已就绪");
      window.document.querySelector("#play").click();
      expect(player.getCurrentTime()).toBe(30);
      expect(player.getPlayerState()).toBe(2);
      await vi.waitFor(() => expect(audios).toHaveLength(1));
      audios[0].readyState = 1;
      audios[0].dispatchEvent(new window.Event("loadedmetadata"));
      await vi.waitFor(() => expect(player.getPlayerState()).toBe(1));
      await vi.waitFor(() => expect(audios[0].currentTime).toBeCloseTo(15, 1));
      const subtitle = window.document.querySelector("#subtitle");
      expect(subtitle.textContent.length).toBeLessThanOrEqual(34);
      expect(subtitle.textContent).not.toBe(translated);
      seconds = 50;
      await vi.waitFor(() => expect(audios[0].currentTime).toBeCloseTo(25, 1));
      expect(subtitle.textContent.length).toBeLessThanOrEqual(34);
    } finally {
      dom.window.close();
    }
  });

  it("reuses group audio and seeks within it on the local page", async () => {
    const { dom, window } = await createSandboxWindow({ url: "http://127.0.0.1:8791/" });
    window.document.body.innerHTML = `
      <form id="start-form"><input id="video-url"><input id="api-key"><input id="voice"><input id="chrome-cookies" type="checkbox"></form>
      <section id="workspace"><span id="status"></span><div id="segments"></div>
      <div id="preparation"><span id="preparation-detail"></span><progress id="preparation-progress"></progress><button id="watch-original"></button></div>
      <div id="ready-choice"><button id="play-from-start"></button><button id="play-from-current"></button></div>
      <button id="play" disabled></button><button id="preview"></button><button id="stop"></button><button id="change-video"></button><button id="retry-read"></button><button id="skip-speech"></button>
      <span id="video-title"></span><div id="subtitle"></div><a id="original-link"></a><button id="copy-original"></button></section>`;
    window.sessionStorage.setItem("yimu.localJobId", "job-1");
    const cues = [
      { start: 0, end: 5, translated: "第一句", audioUrl: "/audio/0/0", audioGroup: 0, audioStart: 0, audioEnd: 10, audioDuration: 20 },
      { start: 5, end: 10, translated: "第二句", audioUrl: "/audio/0/1", audioGroup: 0, audioStart: 10, audioEnd: 20, audioDuration: 20 },
    ];
    const snapshot = { id: "job-1", videoId: "qYNweeDHiyU", status: "processing",
      queue: { currentIndex: 0, segments: [{ index: 0, start: 0, end: 300, status: "ready", cues }] } };
    window.fetch = vi.fn(async () => ({ ok: true, json: async () => snapshot }));
    const audios = [];
    window.Audio = class extends window.EventTarget {
      constructor(src) { super(); this.src = src; this.readyState = 1; this.duration = 20; this.currentTime = 0; audios.push(this); }
      load() {}
      play() { return Promise.resolve(); }
      pause() {}
    };
    let seconds = 6;
    let state = 2;
    window.YT = { PlayerState: { PLAYING: 1 }, Player: class {
      constructor(_element, options) { this.options = options; queueMicrotask(() => options.events.onReady({ target: this })); }
      getCurrentTime() { return seconds; }
      getPlayerState() { return state; }
      getPlaybackRate() { return 1; }
      mute() {}
      pauseVideo() { state = 2; this.options.events.onStateChange({ data: state }); }
      playVideo() { state = 1; this.options.events.onStateChange({ data: state }); }
    } };
    try {
      loadService("local-service/public/app.js", window);
      await vi.waitFor(() => expect(window.document.querySelector("#play").disabled).toBe(false), { timeout: 2500 });
      window.document.querySelector("#play").click();
      await vi.waitFor(() => expect(audios[0]?.currentTime).toBeCloseTo(12, 1));
      seconds = 1;
      await vi.waitFor(() => expect(audios[0]?.currentTime).toBeCloseTo(2, 1));
      expect(audios).toHaveLength(1);
    } finally { dom.window.close(); }
  });

  it("shows a resume action when the embedded video pauses during dubbing", async () => {
    const { dom, window } = await createSandboxWindow({ url: "http://127.0.0.1:8791/" });
    window.document.body.innerHTML = `
      <form id="start-form"><input id="video-url"><input id="api-key"><input id="voice"><input id="chrome-cookies" type="checkbox"></form>
      <section id="workspace"><span id="status"></span><div id="segments"></div>
      <div id="preparation"><span id="preparation-detail"></span><progress id="preparation-progress"></progress><button id="watch-original"></button></div>
      <div id="ready-choice" hidden><strong>整片中文配音已就绪</strong><p>选择位置</p><button id="play-from-start"></button><button id="play-from-current"></button></div>
      <button id="play" disabled></button><button id="preview"></button><button id="stop"></button><button id="change-video"></button><button id="retry-read"></button><button id="skip-speech"></button>
      <span id="video-title"></span><div id="subtitle"></div><a id="original-link"></a><button id="copy-original"></button></section>`;
    window.sessionStorage.setItem("yimu.localJobId", "job-1");
    const snapshot = { id: "job-1", videoId: "qYNweeDHiyU", status: "ready", fullPreparation: true,
      queue: { currentIndex: 0, segments: [{ index: 0, start: 0, end: 300, status: "ready", cues: [
        { start: 0, end: 10, translated: "你好", audioUrl: "/audio/0/0" },
      ] }] } };
    window.fetch = vi.fn(async () => ({ ok: true, json: async () => snapshot }));
    window.Audio = class extends window.EventTarget {
      constructor() { super(); this.readyState = 1; this.duration = 5; this.currentTime = 0; }
      load() {}
      play() { return Promise.resolve(); }
      pause() {}
    };
    let state = 2;
    let player;
    window.YT = { PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 }, Player: class {
      constructor(_element, options) { player = this; this.options = options; queueMicrotask(() => options.events.onReady({ target: this })); }
      getCurrentTime() { return 4; }
      getPlayerState() { return state; }
      getPlaybackRate() { return 1; }
      mute() {}
      pauseVideo() { state = 2; this.options.events.onStateChange({ data: state }); }
      playVideo() { state = 1; this.options.events.onStateChange({ data: state }); }
    } };
    try {
      loadService("local-service/public/app.js", window);
      const readyChoice = window.document.querySelector("#ready-choice");
      await vi.waitFor(() => expect(readyChoice.hidden).toBe(false), { timeout: 2500 });
      window.document.querySelector("#play-from-current").click();
      await vi.waitFor(() => expect(readyChoice.hidden).toBe(true));
      player.pauseVideo();
      expect(readyChoice.hidden).toBe(false);
      expect(readyChoice.textContent).toContain("继续中文配音");
      expect(window.document.querySelector("#play-from-current").classList.contains("primary-button")).toBe(true);
      expect(window.document.querySelector("#play-from-start").classList.contains("quiet-button")).toBe(true);
      expect(window.document.querySelector("#status").textContent).toContain("视频已暂停");
    } finally { dom.window.close(); }
  });

  it("pauses on a far seek until the uncached voice loads, then resumes at the new offset", async () => {
    const { dom, window } = await createSandboxWindow({ url: "http://127.0.0.1:8791/" });
    window.document.body.innerHTML = `
      <form id="start-form"><input id="video-url"><input id="api-key"><input id="voice"><input id="chrome-cookies" type="checkbox"></form>
      <section id="workspace"><span id="status"></span><div id="segments"></div>
      <div id="preparation"><span id="preparation-detail"></span><progress id="preparation-progress"></progress><button id="watch-original"></button></div>
      <div id="ready-choice"><button id="play-from-start"></button><button id="play-from-current"></button></div>
      <button id="play" disabled></button><button id="preview"></button><button id="stop"></button><button id="change-video"></button><button id="retry-read"></button><button id="skip-speech"></button>
      <span id="video-title"></span><div id="subtitle"></div><a id="original-link"></a><button id="copy-original"></button></section>`;
    window.sessionStorage.setItem("yimu.localJobId", "job-1");
    const snapshot = { id: "job-1", videoId: "qYNweeDHiyU", status: "processing", queue: { currentIndex: 0, segments: [
      { index: 0, start: 0, end: 300, status: "ready", cues: [{ start: 0, end: 10, translated: "开头", audioUrl: "/first", audioGroup: 0, audioStart: 0, audioEnd: 10, audioDuration: 10 }] },
      { index: 1, start: 300, end: 600, status: "ready", cues: [{ start: 300, end: 310, translated: "快进后", audioUrl: "/later", audioGroup: 1, audioStart: 10, audioEnd: 20, audioDuration: 20 }] },
    ] } };
    window.fetch = vi.fn(async () => ({ ok: true, json: async () => snapshot }));
    const audios = [];
    window.Audio = class extends window.EventTarget {
      constructor(src) { super(); this.src = src; this.readyState = src === "/first" ? 1 : 0; this.duration = src === "/first" ? 10 : 20; this.currentTime = 0; this.load = vi.fn(); this.play = vi.fn(async () => {}); this.pause = vi.fn(); audios.push(this); }
    };
    let seconds = 1;
    let state = 2;
    window.YT = { PlayerState: { PLAYING: 1, PAUSED: 2 }, Player: class {
      constructor(_element, options) { this.options = options; queueMicrotask(() => options.events.onReady({ target: this })); }
      getCurrentTime() { return seconds; }
      getPlayerState() { return state; }
      getPlaybackRate() { return 1; }
      mute() {}
      pauseVideo() { state = 2; this.options.events.onStateChange({ data: state }); }
      playVideo() { state = 1; this.options.events.onStateChange({ data: state }); }
    } };
    try {
      loadService("local-service/public/app.js", window);
      await vi.waitFor(() => expect(window.document.querySelector("#play").disabled).toBe(false), { timeout: 2500 });
      window.document.querySelector("#play").click();
      await vi.waitFor(() => expect(audios[0]?.play).toHaveBeenCalled());
      seconds = 306;
      await vi.waitFor(() => expect(state).toBe(2));
      const later = audios.find((audio) => audio.src === "/later");
      expect(later.load).toHaveBeenCalled();
      expect(window.document.querySelector("#status").textContent).toContain("快进位置");
      later.readyState = 1;
      later.dispatchEvent(new window.Event("loadedmetadata"));
      await vi.waitFor(() => expect(state).toBe(1));
      await vi.waitFor(() => expect(later.play).toHaveBeenCalled());
      expect(later.currentTime).toBeCloseTo(16, 1);
    } finally { dom.window.close(); }
  });

  it("lets the viewer retry when the browser rejects voice playback", async () => {
    const { dom, window } = await createSandboxWindow({ url: "http://127.0.0.1:8791/" });
    window.document.body.innerHTML = `
      <form id="start-form"><input id="video-url"><input id="api-key"><input id="voice"><input id="chrome-cookies" type="checkbox"></form>
      <section id="workspace"><span id="status"></span><div id="segments"></div>
      <div id="preparation"><span id="preparation-detail"></span><progress id="preparation-progress"></progress><button id="watch-original"></button></div>
      <div id="ready-choice"><button id="play-from-start"></button><button id="play-from-current"></button></div>
      <button id="play" disabled></button><button id="preview"></button><button id="stop"></button><button id="change-video"></button><button id="retry-read"></button><button id="skip-speech"></button>
      <span id="video-title"></span><div id="subtitle"></div><a id="original-link"></a><button id="copy-original"></button></section>`;
    window.sessionStorage.setItem("yimu.localJobId", "job-1");
    const snapshot = { id: "job-1", videoId: "qYNweeDHiyU", status: "processing", queue: { currentIndex: 0, segments: [
      { index: 0, start: 0, end: 300, status: "ready", cues: [{ start: 0, end: 10, translated: "你好", audioUrl: "/voice" }] },
    ] } };
    window.fetch = vi.fn(async () => ({ ok: true, json: async () => snapshot }));
    let playCount = 0;
    window.Audio = class extends window.EventTarget {
      constructor() { super(); this.readyState = 1; this.duration = 10; this.currentTime = 0; }
      load() {}
      play() { playCount += 1; return playCount === 1 ? Promise.reject(new Error("blocked")) : Promise.resolve(); }
      pause() {}
    };
    let state = 2;
    window.YT = { PlayerState: { PLAYING: 1, PAUSED: 2 }, Player: class {
      constructor(_element, options) { this.options = options; queueMicrotask(() => options.events.onReady({ target: this })); }
      getCurrentTime() { return 2; }
      getPlayerState() { return state; }
      getPlaybackRate() { return 1; }
      mute() {}
      pauseVideo() { state = 2; this.options.events.onStateChange({ data: state }); }
      playVideo() { state = 1; this.options.events.onStateChange({ data: state }); }
    } };
    try {
      loadService("local-service/public/app.js", window);
      const playButton = window.document.querySelector("#play");
      await vi.waitFor(() => expect(playButton.disabled).toBe(false), { timeout: 2500 });
      playButton.click();
      await vi.waitFor(() => expect(window.document.querySelector("#status").textContent).toContain("重试"));
      expect(state).toBe(2);
      playButton.click();
      await vi.waitFor(() => expect(playCount).toBe(2));
      expect(state).toBe(1);
    } finally { dom.window.close(); }
  });
});
