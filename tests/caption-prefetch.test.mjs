import { describe, it, expect, vi } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

describe("字幕配音预取", () => {
  it("keeps the video paused until its first translated voice is ready", async () => {
    const { window } = await createSandboxWindow();
    let finishSpeech;
    window.LumeoMiniMax = {
      prefetch: vi.fn(() => new Promise((resolve) => { finishSpeech = resolve; })),
    };
    window.LumeoTranslate = {};
    window.LumeoSrtExport = {};
    window.LumeoTTS = { stop: vi.fn() };
    window.LumeoSonioxSTT = {};
    window.LumeoCaptions = {};
    const cues = [{ start: 0, end: 4, text: "hello", translated: "你好" }];
    const pipeline = {
      cues,
      start: vi.fn(async () => ({ ok: true, cues, meta: {} })),
      cueAt: () => ({ cue: cues[0], index: 0 }),
      speakCue: vi.fn(async () => true),
      stop: vi.fn(),
    };
    window.LumeoCaptionPipeline = { create: () => pipeline };
    loadService("pipelines/caption-orchestrator.js", window);
    const video = { currentTime: 0, paused: false, pause: vi.fn(() => { video.paused = true; }),
      play: vi.fn(async () => { video.paused = false; }) };
    let activeSession = null;
    const ctx = {
      getVideo: () => video, getPageToken: () => 2, getSession: () => activeSession,
      getSettings: () => ({ targetLanguage: "zh-CN", translateProvider: "minimax", minimaxKey: "key", captionTtsProvider: "minimax-tts" }),
      getLangName: () => "简体中文", getElements: () => ({}), getTranscriptController: () => null,
      buildOverlay: vi.fn(), setStatusText: vi.fn(), setTargetText: vi.fn(), setOverlayState: vi.fn(),
      applyTierToolbar: vi.fn(), applySourceVisibility: vi.fn(), onStateChange: vi.fn(),
      onSessionCreated: (s) => { activeSession = s; }, setCurrentTexts: vi.fn(), setTargetCue: vi.fn(),
      onSessionEnded: (reason, message) => { throw new Error(`${reason}: ${message}`); },
      setYTPauseHandler: vi.fn(), setYTPlayHandler: vi.fn(),
    };
    const starting = window.LumeoCaptionOrchestrator.start(ctx);
    await vi.waitFor(() => expect(finishSpeech).toBeTypeOf("function"));
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
    finishSpeech(new Uint8Array([1]));
    expect(await starting).toEqual({ ok: true });
    expect(video.play).toHaveBeenCalledOnce();
    clearInterval(activeSession.captionTimer);
    activeSession.prefetchStop();
  });
  it("only prepares nearby cues with bounded concurrency", async () => {
    const { window } = await createSandboxWindow();
    const pending = [];
    window.LumeoMiniMax = {
      prefetch: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
    };
    loadService("pipelines/caption-orchestrator.js", window);
    const pipeline = {
      cues: [
        { start: 0, end: 3, translated: "第一句" },
        { start: 5, end: 8, translated: "第二句" },
        { start: 12, end: 15, translated: "第三句" },
        { start: 50, end: 53, translated: "远处的一句" },
      ],
    };
    const video = { currentTime: 0 };
    const prefetcher = window.LumeoCaptionOrchestrator.createSpeechPrefetcher(pipeline, video, {
      captionTtsProvider: "minimax-tts", minimaxKey: "test-key", ttsRate: 1,
    });
    prefetcher.tick();
    await Promise.resolve();
    expect(window.LumeoMiniMax.prefetch).toHaveBeenCalledTimes(2);
    expect(window.LumeoMiniMax.prefetch.mock.calls.map(([text]) => text)).toEqual(["第一句", "第二句"]);

    pending[0](new Uint8Array([1]));
    await vi.waitFor(() => expect(window.LumeoMiniMax.prefetch).toHaveBeenCalledTimes(3));
    expect(window.LumeoMiniMax.prefetch.mock.calls[2][0]).toBe("第三句");
    prefetcher.stop();
    pending.slice(1).forEach((resolve) => resolve(new Uint8Array([1])));
  });

  it("aborts speech preparation on video pause and resumes from the playhead", async () => {
    const { window } = await createSandboxWindow();
    window.LumeoMiniMax = {
      prefetch: vi.fn((text, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })),
    };
    loadService("pipelines/caption-orchestrator.js", window);
    const video = { currentTime: 0, paused: false };
    const prefetcher = window.LumeoCaptionOrchestrator.createSpeechPrefetcher({
      cues: [{ start: 0, end: 2, translated: "第一句" }],
    }, video, { captionTtsProvider: "minimax-tts", minimaxKey: "key" });
    prefetcher.tick();
    await vi.waitFor(() => expect(window.LumeoMiniMax.prefetch).toHaveBeenCalledOnce());
    video.paused = true;
    prefetcher.pause();
    await vi.waitFor(() => expect(window.LumeoMiniMax.prefetch.mock.calls[0][1].signal.aborted).toBe(true));
    video.paused = false;
    prefetcher.resume();
    await vi.waitFor(() => expect(window.LumeoMiniMax.prefetch).toHaveBeenCalledTimes(2));
    prefetcher.stop();
  });
});
