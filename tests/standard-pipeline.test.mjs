import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

async function setup() {
  const { window } = await createSandboxWindow();
  loadService("pipelines/standard.js", window);
  return window.LumeoStandardPipeline;
}

describe("pipelines/standard.js", () => {
  let api;

  beforeEach(async () => {
    api = await setup();
  });

  it("publishes Standard pipeline constants and helper surface", () => {
    expect(api.__loaded).toBe(true);
    expect(api.DEFAULT_CHUNK_MS).toBe(5000);
    expect(api.MIN_CHUNK_BYTES).toBe(2000);
    expect(api.RECORDER_MIMES).toContain("audio/webm;codecs=opus");
    expect(typeof api.pickRecorderMime).toBe("function");
    expect(typeof api.shouldProcessChunk).toBe("function");
  });

  it("delegates recorder MIME selection to audio utils with Standard candidates", () => {
    const pickRecorderMime = vi.fn(() => "audio/webm");
    expect(api.pickRecorderMime({ pickRecorderMime })).toBe("audio/webm");
    expect(pickRecorderMime).toHaveBeenCalledWith(api.RECORDER_MIMES);
  });

  it("rejects stale, inactive, and tiny chunks", () => {
    const active = { token: 2 };
    expect(api.shouldProcessChunk(active, active, 2, { size: 2000 })).toBe(true);
    expect(api.shouldProcessChunk(active, {}, 2, { size: 2000 })).toBe(false);
    expect(api.shouldProcessChunk(active, active, 3, { size: 2000 })).toBe(false);
    expect(api.shouldProcessChunk(active, active, 2, { size: 1999 })).toBe(false);
  });

  it("records one chunk and passes the combined blob to processChunk", () => {
    const timers = [];
    const processChunk = vi.fn(async () => {});
    class FakeRecorder {
      constructor() {
        this.listeners = new Map();
        this.state = "inactive";
      }
      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      }
      start() {
        this.state = "recording";
        this.listeners.get("dataavailable")?.({ data: new Blob(["abcd"], { type: "audio/webm" }) });
      }
      stop() {
        this.state = "inactive";
        this.listeners.get("stop")?.();
      }
    }
    const session = { token: 1, stream: {}, recorderMime: "audio/webm", stopFlag: false };
    api.runChunkLoop(session, {
      getActiveSession: () => session,
      isVideoPaused: () => false,
      MediaRecorder: FakeRecorder,
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      processChunk,
    });
    expect(timers).toHaveLength(1);
    timers[0]();
    session.stopFlag = true;
    expect(processChunk).toHaveBeenCalledOnce();
    expect(processChunk.mock.calls[0][0]).toBe(session);
    expect(processChunk.mock.calls[0][1].type).toBe("audio/webm");
  });

  it("processes Standard STT, translation, TTS, and playback", async () => {
    const sourceNode = { connect: vi.fn(), start: vi.fn() };
    const audioBuffer = { duration: 1.25 };
    const audioCtx = {
      currentTime: 3,
      decodeAudioData: vi.fn(async () => audioBuffer),
      createBufferSource: vi.fn(() => sourceNode),
    };
    const session = {
      token: 7,
      kymaKey: "kyma-test",
      audioCtx,
      outputGain: {},
      nextPlayAt: 0,
      abortController: new AbortController(),
    };
    const formData = { append: vi.fn() };
    const fetch = vi.fn(async (url) => {
      if (url.endsWith("/audio/transcriptions")) return { ok: true, json: async () => ({ text: "hello" }) };
      if (url.endsWith("/chat/completions")) return { ok: true, json: async () => ({ choices: [{ message: { content: "xin chào" } }] }) };
      if (url.endsWith("/audio/speech")) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      throw new Error("unexpected url");
    });
    const callbacks = {
      onSourceText: vi.fn(),
      onTargetText: vi.fn(),
      onChunkDone: vi.fn(),
      onError: vi.fn(),
    };

    await api.processChunk(session, { size: 3000 }, {
      getActiveSession: () => session,
      getPageToken: () => 7,
      getSettings: () => ({ targetLanguage: "vi", standardVoice: "English_magnetic_voiced_man" }),
      langNameByCode: { vi: "Vietnamese" },
      kymaBase: "https://kyma.test/v1",
      audioUtils: { webmBlobToWav: vi.fn(async () => new Blob(["wav"])) },
      fetch,
      FormData: vi.fn(function() { return formData; }),
      parseKymaError: vi.fn(),
      ...callbacks,
    });

    expect(formData.append).toHaveBeenCalledWith("model", "whisper-v3-turbo");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(callbacks.onSourceText).toHaveBeenCalledWith("hello");
    expect(callbacks.onTargetText).toHaveBeenCalledWith("xin chào");
    expect(sourceNode.connect).toHaveBeenCalledWith(session.outputGain);
    expect(sourceNode.start).toHaveBeenCalledWith(3.05);
    expect(session.nextPlayAt).toBe(4.3);
    expect(callbacks.onChunkDone).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("runs MiniMax ASR, LLM translation and TTS in order", async () => {
    const calls = [];
    const sourceNode = { connect: vi.fn(), start: vi.fn() };
    const audioCtx = {
      currentTime: 2,
      decodeAudioData: vi.fn(async () => ({ duration: 1.5 })),
      createBufferSource: vi.fn(() => sourceNode),
    };
    const session = { token: 3, audioCtx, outputGain: {}, nextPlayAt: 0, stopFlag: false, abortController: new AbortController() };
    await api.processChunk(session, { size: 3000 }, {
      getActiveSession: () => session,
      getPageToken: () => 3,
      getSettings: () => ({ dubProvider: "minimax-dub", minimaxKey: "mm-key", targetLanguage: "zh-CN", standardVoice: "male-qn-qingse" }),
      audioUtils: { webmBlobToWav: async () => new Blob(["wav"]) },
      miniMax: {
        DEFAULT_VOICE: "male-qn-qingse",
        transcribe: async () => { calls.push("asr"); return "hello"; },
        synthesize: async (text, opts) => { calls.push("tts"); expect(text).toBe("你好"); expect(opts.voice).toBe("male-qn-qingse"); return new Uint8Array([1, 2]); },
      },
      translate: { translateBatch: async (texts, language, opts) => {
        calls.push("translate");
        expect(texts).toEqual(["hello"]);
        expect(language).toBe("zh-CN");
        expect(opts.provider).toBe("minimax");
        return ["你好"];
      } },
      onSourceText: vi.fn(),
      onTargetText: vi.fn(),
      onError: vi.fn(),
    });
    expect(calls).toEqual(["asr", "translate", "tts"]);
    expect(sourceNode.start).toHaveBeenCalledWith(2.05);
    expect(session.pendingChunks).toBe(0);
  });

  it("stops recording and playback on pause, then ignores the old ASR result after resume", async () => {
    let finishAsr;
    const source = { stop: vi.fn() };
    const recorder = { state: "recording", stop: vi.fn(() => { recorder.state = "inactive"; }) };
    const session = {
      token: 4, stream: {}, audioCtx: { currentTime: 0, decodeAudioData: vi.fn() },
      outputGain: {}, nextPlayAt: 5, stopFlag: false, paused: false,
      activeRecorder: recorder, playingSources: new Set([source]), abortController: new AbortController(),
    };
    const translate = { translateBatch: vi.fn() };
    const work = api.processChunk(session, { size: 3000 }, {
      getActiveSession: () => session,
      getPageToken: () => 4,
      getSettings: () => ({ dubProvider: "minimax-dub", minimaxKey: "key" }),
      audioUtils: { webmBlobToWav: async () => new Blob(["wav"]) },
      miniMax: { transcribe: () => new Promise((resolve) => { finishAsr = resolve; }), synthesize: vi.fn() },
      translate,
    });
    await vi.waitFor(() => expect(finishAsr).toBeTypeOf("function"));
    api.pauseSession(session);
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(source.stop).toHaveBeenCalledOnce();
    expect(session.nextPlayAt).toBe(0);
    expect(session.abortController.signal.aborted).toBe(true);
    api.resumeSession(session);
    finishAsr("hello");
    await work;
    expect(translate.translateBatch).not.toHaveBeenCalled();
    expect(session.paused).toBe(false);
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it("fits a decoded voice segment to its video segment", async () => {
    const source = { connect: vi.fn(), start: vi.fn(), playbackRate: { value: 1 } };
    const session = {
      audioCtx: { currentTime: 2, createBufferSource: () => source },
      outputGain: {}, nextPlayAt: 0, paused: false, stopFlag: false,
    };
    api.playBuffer(session, { duration: 8 }, { segmentDuration: 5, videoOffset: 1 });
    expect(source.playbackRate.value).toBe(1.6);
    expect(source.start).toHaveBeenCalledWith(2.05, 1.6);
    expect(session.nextPlayAt).toBeCloseTo(6.05);
  });

  it("captures, converts, and replays one segment before recording another", async () => {
    const order = [];
    class Recorder {
      constructor() { this.listeners = new Map(); this.state = "inactive"; }
      addEventListener(name, handler) { this.listeners.set(name, handler); }
      start() {
        this.state = "recording";
        this.listeners.get("dataavailable")?.({ data: new Blob([new Uint8Array(3000)]) });
      }
      stop() { this.state = "inactive"; this.listeners.get("stop")?.(); }
    }
    const session = { stream: {}, recorderMime: "audio/webm", stopFlag: false, paused: false, pauseEpoch: 0 };
    await api.runSynchronizedLoop(session, {
      getActiveSession: () => session,
      MediaRecorder: Recorder,
      setTimeout: (fn) => fn(),
      onCaptureStart: async () => { order.push("capture-start"); return 10; },
      onCaptureEnd: async () => { order.push("capture-end"); return 15; },
      processChunk: async (ref) => { order.push("process"); ref.preparedAudio = { duration: 5 }; },
      onPlayback: async (ref, segment) => {
        order.push("replay");
        expect(segment).toMatchObject({ startTime: 10, endTime: 15, audioBuffer: { duration: 5 } });
        ref.stopFlag = true;
      },
    });
    expect(order).toEqual(["capture-start", "capture-end", "process", "replay"]);
  });

  it("returns to the captured start when paused during conversion", async () => {
    const order = [];
    class Recorder {
      constructor() { this.listeners = new Map(); this.state = "inactive"; }
      addEventListener(name, handler) { this.listeners.set(name, handler); }
      start() {
        this.state = "recording";
        this.listeners.get("dataavailable")?.({ data: new Blob([new Uint8Array(3000)]) });
      }
      stop() { this.state = "inactive"; this.listeners.get("stop")?.(); }
    }
    const session = { stream: {}, recorderMime: "audio/webm", stopFlag: false, paused: false, pauseEpoch: 0 };
    await api.runSynchronizedLoop(session, {
      getActiveSession: () => session,
      MediaRecorder: Recorder,
      setTimeout: (fn) => fn(),
      onCaptureStart: async () => 12,
      onCaptureEnd: async () => 17,
      processChunk: async (ref) => { ref.paused = true; ref.pauseEpoch += 1; },
      onDiscard: async (ref, startTime) => {
        order.push(startTime);
        ref.stopFlag = true;
      },
      onPlayback: () => { throw new Error("must not replay canceled audio"); },
    });
    expect(order).toEqual([12]);
  });
});
