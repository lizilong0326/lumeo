import { describe, expect, it, vi } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

const JOB_ID = "01234567-89ab-cdef-0123-456789abcdef";

describe("整片准备入口", () => {
  it("lets the viewer watch the original while caption preparation continues", async () => {
    const { dom, window } = await createSandboxWindow({ url: "https://www.youtube.com/watch?v=qYNweeDHiyU" });
    const video = window.document.createElement("video");
    video.pause = vi.fn();
    video.play = vi.fn(async () => {});
    window.document.body.append(video);
    let releaseCaptions;
    window.LumeoCaptions = { fetchSubtitles: vi.fn(() => new Promise((resolve) => { releaseCaptions = resolve; })) };
    const connect = vi.fn();
    window.YimuLocalPlayback = { connect };
    const messages = [];
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (message, callback) => {
          messages.push(message);
          callback({ ok: true, data: message.action === "create" ? { id: JOB_ID } : { ok: true } });
        },
      },
    };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/full-prep.js", window);
      const controller = window.YimuFullPrep.start({ video, settings: { minimaxKey: "test-key" } });
      expect(video.pause).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(releaseCaptions).toBeTypeOf("function"));
      const panel = window.document.querySelector("aside");
      expect(panel.textContent).toContain("正在读取整片字幕轨");
      panel.querySelector(".yimu-panel-actions button").click();
      expect(panel.hidden).toBe(true);
      expect(video.play).toHaveBeenCalledOnce();
      releaseCaptions({ sourceLanguage: "en", cues: [{ start: 0, end: 2, text: "Hello" }] });
      await controller.promise;
      expect(messages.find((message) => message.action === "create")).toMatchObject({
        cues: [{ start: 0, end: 2, text: "Hello" }], sourceLanguage: "en", apiKey: "test-key",
      });
      expect(connect).toHaveBeenCalledWith(JOB_ID, 8791, expect.objectContaining({
        minimized: true, handoff: expect.objectContaining({ panel }),
      }));
      expect(window.document.querySelector("aside")).toBeNull();
    } finally { dom.window.close(); }
  });

  it("starts full audio transcription when the video has no usable captions", async () => {
    const { dom, window } = await createSandboxWindow({ url: "https://www.youtube.com/watch?v=qYNweeDHiyU" });
    const video = window.document.createElement("video");
    video.pause = vi.fn();
    window.document.body.append(video);
    window.LumeoCaptions = { fetchSubtitles: vi.fn(async () => null) };
    window.YimuLocalPlayback = { connect: vi.fn() };
    let createMessage;
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (message, callback) => {
          if (message.action === "create") createMessage = message;
          callback({ ok: true, data: message.action === "create" ? { id: JOB_ID } : { ok: true } });
        },
      },
    };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/full-prep.js", window);
      await window.YimuFullPrep.start({ video, settings: { minimaxKey: "test-key" } }).promise;
      expect(createMessage.action).toBe("create");
      expect(createMessage.cues).toBeUndefined();
      expect(window.YimuLocalPlayback.connect).toHaveBeenCalledWith(JOB_ID, 8791, expect.objectContaining({
        minimized: false, handoff: expect.objectContaining({ panel: expect.any(window.HTMLElement) }),
      }));
    } finally { dom.window.close(); }
  });

  it("keeps the panel closed across the handoff to the background job", async () => {
    const { dom, window } = await createSandboxWindow({ url: "https://www.youtube.com/watch?v=qYNweeDHiyU" });
    const video = window.document.createElement("video");
    video.pause = vi.fn();
    video.play = vi.fn(async () => {});
    window.document.body.append(video);
    let releaseCaptions;
    window.LumeoCaptions = { fetchSubtitles: vi.fn(() => new Promise((resolve) => { releaseCaptions = resolve; })) };
    const connect = vi.fn();
    window.YimuLocalPlayback = { connect };
    window.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => {
      callback({ ok: true, data: message.action === "create" ? { id: JOB_ID } : {} });
    } } };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/full-prep.js", window);
      const controller = window.YimuFullPrep.start({ video, settings: { minimaxKey: "test-key" } });
      await vi.waitFor(() => expect(releaseCaptions).toBeTypeOf("function"));
      const panel = window.document.querySelector("aside");
      panel.querySelector(".yimu-panel-close").click();
      expect(panel.hidden).toBe(true);
      expect(video.play).toHaveBeenCalledOnce();
      releaseCaptions({ sourceLanguage: "en", cues: [{ start: 0, end: 2, text: "Hello" }] });
      await controller.promise;
      expect(connect).toHaveBeenCalledWith(JOB_ID, 8791, expect.objectContaining({
        minimized: true, keepClosed: true, handoff: expect.objectContaining({ panel }),
      }));
    } finally { dom.window.close(); }
  });

  it("keeps one visible progress panel when creation hands off to playback", async () => {
    const { dom, window } = await createSandboxWindow({ url: "https://www.youtube.com/watch?v=qYNweeDHiyU" });
    const video = window.document.createElement("video");
    video.className = "html5-main-video";
    video.pause = vi.fn();
    window.document.body.append(video);
    window.LumeoCaptions = { fetchSubtitles: vi.fn(async () => ({
      sourceLanguage: "en", cues: [{ start: 0, end: 2, text: "Hello" }],
    })) };
    const snapshot = { id: JOB_ID, videoId: "qYNweeDHiyU", fullPreparation: true, status: "speaking",
      progress: { phase: "speaking", completed: 1, total: 2, detail: "中文配音 1/2" }, queue: { segments: [] } };
    window.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => {
      callback({ ok: true, data: message.action === "create" ? { id: JOB_ID } : message.action === "status" ? snapshot : {} });
    } } };
    try {
      loadService("ui/local-panel.js", window);
      loadService("ui/local-playback.js", window);
      loadService("ui/full-prep.js", window);
      const controller = window.YimuFullPrep.start({ video, settings: { minimaxKey: "test-key" } });
      const panel = window.document.querySelector(".yimu-panel");
      await controller.promise;
      await vi.waitFor(() => expect(panel.querySelector(".yimu-panel-status")?.textContent).toContain("中文配音 1/2"));
      expect(window.document.querySelector(".yimu-panel")).toBe(panel);
      expect(window.document.querySelectorAll(".yimu-panel")).toHaveLength(1);
      expect(window.document.querySelectorAll(".yimu-panel-restore")).toHaveLength(1);
      expect(panel.querySelector("progress").value).toBe(50);
    } finally { dom.window.close(); }
  });
});
