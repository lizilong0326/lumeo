import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../local-service/server.mjs";
import { groupWordSegments, normalizeCues } from "../local-service/timeline.mjs";
import { synthesizeSpeech, transcribeWords } from "../local-service/minimax.mjs";
import { planSpeechGroups, speechOffsets } from "../local-service/dubbing.mjs";

async function withServer(options, run) {
  const dataDir = await mkdtemp(join(tmpdir(), "yimu-full-test-"));
  const server = createServer({ dataDir, minSpeechIntervalMs: 0, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function createJob(base, body) {
  const response = await fetch(`${base}/api/jobs`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: `chrome-extension://${"a".repeat(32)}` },
    body: JSON.stringify({ mode: "full", url: "https://www.youtube.com/watch?v=qYNweeDHiyU", apiKey: "test-key", ...body }),
  });
  expect(response.status).toBe(202);
  return response.json();
}

async function waitReady(base, id) {
  let result;
  await vi.waitFor(async () => {
    const response = await fetch(`${base}/api/jobs/${id}`);
    result = await response.json();
    expect(result.status).toBe("ready");
  }, { timeout: 3000 });
  return result;
}

async function waitFailed(base, id) {
  let result;
  await vi.waitFor(async () => {
    result = await (await fetch(`${base}/api/jobs/${id}`)).json();
    expect(result.status).toBe("failed");
  }, { timeout: 3000 });
  return result;
}

describe("整片字幕准备", () => {
  it("accepts extension health and stop requests", async () => {
    await withServer({}, async (base) => {
      const origin = `chrome-extension://${"a".repeat(32)}`;
      const health = await fetch(`${base}/api/health`, { headers: { Origin: origin } });
      expect(health.status).toBe(200);
      const created = await createJob(base, { duration: 3, cues: [{ start: 0, end: 2, text: "Hi" }] });
      const stopped = await fetch(`${base}/api/jobs/${created.id}`, { method: "DELETE", headers: { Origin: origin } });
      expect(stopped.status).toBe(200);
      expect((await stopped.json()).status).toBe("stopped");
    });
  });
  it("groups word timestamps into short cues and keeps video offsets", () => {
    expect(groupWordSegments([
      { start: 0, end: 0.5, text: "Hello" },
      { start: 0.5, end: 1.1, text: "world." },
      { start: 2.5, end: 3, text: "Next" },
    ], 300, 305)).toEqual([
      { start: 300, end: 301.1, text: "Hello world." },
      { start: 302.5, end: 303, text: "Next" },
    ]);
    expect(normalizeCues([{ start: 4, end: 5, text: " A  B " }, { start: -1, end: 1, text: "bad" }], 10))
      .toEqual([{ start: 4, end: 5, text: "A B" }]);
  });

  it("requests MiniMax word-level timestamps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yimu-asr-test-"));
    try {
      const audio = join(dir, "sample.wav");
      await writeFile(audio, Buffer.from([1, 2, 3]));
      const fetchFn = vi.fn(async (_url, request) => {
        expect(request.body.get("response_format")).toBe("verbose_json");
        expect(request.body.get("timestamp_level")).toBe("word");
        return new Response(JSON.stringify({ segments: [{ start: 0, end: 1, text: "hello" }] }), { status: 200 });
      });
      expect(await transcribeWords(audio, "test-key", { fetchFn })).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("groups nearby cues and maps generated word times back to cue offsets", () => {
    const tasks = [
      { cue: { start: 0, end: 2, translated: "你好" } },
      { cue: { start: 2.2, end: 4, translated: "世界" } },
      { cue: { start: 7, end: 9, translated: "结束" } },
    ];
    expect(planSpeechGroups(tasks).map((group) => group.tasks.length)).toEqual([2, 1]);
    expect(speechOffsets(["你好", "世界"], [
      { text: "你好", time_begin: 0, time_end: 1000 },
      { text: "世界", time_begin: 1000, time_end: 2000 },
    ], 2)).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  });

  it("requests one MiniMax audio with word timings for a group", async () => {
    const fetchFn = vi.fn(async (url, request) => {
      if (String(url).includes("/t2a_v2")) {
        const body = JSON.parse(request.body);
        expect(body).toMatchObject({ text: "你好\n世界", subtitle_enable: true, subtitle_type: "word" });
        return new Response(JSON.stringify({ data: {
          audio: "00ff", subtitle_file: "https://minimax-test.aliyuncs.com/subtitles.json",
        }, extra_info: { audio_length: 2000 }, base_resp: { status_code: 0 } }), { status: 200 });
      }
      return new Response(JSON.stringify([{ text: "你好", time_begin: 0, time_end: 1000 },
        { text: "世界", time_begin: 1000, time_end: 2000 }]), { status: 200 });
    });
    const result = await synthesizeSpeech("你好\n世界", "test-key", "male-qn-qingse", { fetchFn, withTimings: true });
    expect([...result.audio]).toEqual([0, 255]);
    expect(result.subtitles).toHaveLength(2);
    expect(result.durationSeconds).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("makes one speech request for adjacent cues and reuses one audio file when seeking", async () => {
    const synthesizeSpeechMock = vi.fn(async () => ({
      audio: Buffer.from([1, 2, 3]), durationSeconds: 4,
      subtitles: [{ text: "中文One", time_begin: 0, time_end: 2000 },
        { text: "中文Two", time_begin: 2000, time_end: 4000 }],
    }));
    await withServer({
      translateBatch: vi.fn(async (texts) => texts.map((text) => `中文${text}`)),
      synthesizeSpeech: synthesizeSpeechMock,
    }, async (base) => {
      const created = await createJob(base, { duration: 12, cues: [
        { start: 0, end: 2, text: "One" }, { start: 2.2, end: 4.2, text: "Two" },
      ] });
      const ready = await waitReady(base, created.id);
      expect(ready.speechGroupCount).toBe(1);
      expect(synthesizeSpeechMock).toHaveBeenCalledOnce();
      const timeline = await (await fetch(`${base}/api/jobs/${created.id}/timeline`)).json();
      const [first, second] = timeline.queue.segments[0].cues;
      expect(first).toMatchObject({ audioGroup: 0, audioStart: 0, audioEnd: 2 });
      expect(second).toMatchObject({ audioGroup: 0, audioStart: 2, audioEnd: 4 });
      const firstAudio = new Uint8Array(await (await fetch(`${base}${first.audioUrl}`)).arrayBuffer());
      const secondAudio = new Uint8Array(await (await fetch(`${base}${second.audioUrl}`)).arrayBuffer());
      expect([...firstAudio]).toEqual([...secondAudio]);
    });
  });

  it("skips a failed group while keeping all of its subtitles", async () => {
    const synthesizeSpeechMock = vi.fn(async (text) => {
      if (text.includes("中文One")) throw new Error("rate limit exceeded(RPM)");
      return { audio: Buffer.from([7, 8]), durationSeconds: 1, subtitles: [] };
    });
    await withServer({
      translateBatch: vi.fn(async (texts) => texts.map((text) => `中文${text}`)),
      synthesizeSpeech: synthesizeSpeechMock,
    }, async (base) => {
      const created = await createJob(base, { duration: 12, cues: [
        { start: 0, end: 2, text: "One" }, { start: 2.1, end: 4, text: "Two" },
        { start: 7, end: 8, text: "Three" },
      ] });
      const failed = await waitFailed(base, created.id);
      expect(failed.failedSpeechIndex).toBe(0);
      expect(failed.failedSpeechEndIndex).toBe(1);
      const response = await fetch(`${base}/api/jobs/${created.id}/skip`, {
        method: "POST", headers: { Origin: `chrome-extension://${"a".repeat(32)}`, "Content-Type": "application/json" }, body: "{}",
      });
      expect(response.status).toBe(202);
      expect((await waitReady(base, created.id)).skippedSpeechCount).toBe(2);
      const timeline = await (await fetch(`${base}/api/jobs/${created.id}/timeline`)).json();
      const [first, second, third] = timeline.queue.segments[0].cues;
      expect(first).toMatchObject({ translated: "中文One", audioUrl: null });
      expect(second).toMatchObject({ translated: "中文Two", audioUrl: null });
      expect(third.audioUrl).toContain("/audio/");
      expect(synthesizeSpeechMock.mock.calls.map(([text]) => text)).toEqual(["中文One\n中文Two", "中文Three"]);
    });
  });

  it("retries a temporary MiniMax rate limit before saving speech", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { audio: "00ff" }, base_resp: { status_code: 0 } }), { status: 200 }));
    expect([...await synthesizeSpeech("你好", "test-key", "male-qn-qingse", { fetchFn, rateLimitDelayMs: 0 })])
      .toEqual([0, 255]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries a provider RPM limit returned with HTTP 200", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "rate limit exceeded(RPM)" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { audio: "00ff" }, base_resp: { status_code: 0 } }), { status: 200 }));
    const onRetry = vi.fn();
    expect([...await synthesizeSpeech("你好", "test-key", "male-qn-qingse", { fetchFn, rateLimitDelayMs: 0, onRetry })])
      .toEqual([0, 255]);
    expect(onRetry).toHaveBeenCalledWith({ reason: "rate-limit", attempt: 1, maxAttempts: 3, waitMs: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("times out a speech request that never responds", async () => {
    const fetchFn = vi.fn((_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    await expect(synthesizeSpeech("你好", "test-key", "male-qn-qingse", { fetchFn, timeoutMs: 10 }))
      .rejects.toThrow("连接失败或超时");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("uses an existing full caption track and keeps playback locked until every voice is ready", async () => {
    let finishSpeech;
    const translateBatch = vi.fn(async (texts) => texts.map((value) => `中文${value}`));
    const synthesizeSpeech = vi.fn(() => new Promise((resolve) => { finishSpeech = resolve; }));
    await withServer({ translateBatch, synthesizeSpeech, inspectVideo: vi.fn() }, async (base) => {
      const created = await createJob(base, { duration: 30, title: "测试视频", cues: [{ start: 2, end: 5, text: "Hello" }] });
      await vi.waitFor(() => expect(finishSpeech).toBeTypeOf("function"));
      const pending = await fetch(`${base}/api/jobs/${created.id}/timeline`);
      expect(pending.status).toBe(409);
      finishSpeech(Buffer.from([1, 2, 3]));
      const ready = await waitReady(base, created.id);
      expect(ready.fullPreparation).toBe(true);
      expect(ready.source).toBe("captions");
      expect(ready.queue.segments[0].cues).toEqual([]);
      const timeline = await (await fetch(`${base}/api/jobs/${created.id}/timeline`)).json();
      expect(timeline.queue.segments[0].cues[0]).toMatchObject({ start: 2, end: 5, text: "Hello", translated: "中文Hello" });
      const voice = await fetch(`${base}${timeline.queue.segments[0].cues[0].audioUrl}`);
      expect([...new Uint8Array(await voice.arrayBuffer())]).toEqual([1, 2, 3]);
      expect(translateBatch).toHaveBeenCalledOnce();
    });
  });

  it("recognizes the full audio before translating when no captions exist", async () => {
    const transcribeWordsMock = vi.fn(async () => [
      { start: 0, end: 0.5, text: "Hello" }, { start: 0.5, end: 1, text: "world." },
    ]);
    await withServer({
      inspectVideo: vi.fn(async () => ({ title: "无字幕", duration: 12 })),
      downloadAudio: vi.fn(async () => "/tmp/source.mp3"),
      extractWav: vi.fn(async () => {}),
      transcribeWords: transcribeWordsMock,
      translateBatch: vi.fn(async (texts) => texts.map(() => "你好，世界。")),
      synthesizeSpeech: vi.fn(async () => Buffer.from([4, 5])),
    }, async (base) => {
      const created = await createJob(base, {});
      const ready = await waitReady(base, created.id);
      expect(ready.source).toBe("audio");
      expect(transcribeWordsMock).toHaveBeenCalledOnce();
      const timeline = await (await fetch(`${base}/api/jobs/${created.id}/timeline`)).json();
      expect(timeline.queue.segments[0].cues[0]).toMatchObject({ start: 0, end: 1, text: "Hello world.", translated: "你好，世界。" });
    });
  });

  it("uses existing YouTube captions for a pasted link before downloading audio", async () => {
    const downloadAudioMock = vi.fn();
    const downloadCaptionsMock = vi.fn(async () => ({ sourceLanguage: "en", cues: [{ start: 1, end: 3, text: "Hello" }] }));
    await withServer({
      inspectVideo: vi.fn(async () => ({ title: "有字幕", duration: 10, captionLanguage: "en" })),
      downloadCaptions: downloadCaptionsMock,
      downloadAudio: downloadAudioMock,
      translateBatch: vi.fn(async () => ["你好"]),
      synthesizeSpeech: vi.fn(async () => Buffer.from([1, 2])),
    }, async (base) => {
      const created = await createJob(base, {});
      const ready = await waitReady(base, created.id);
      expect(ready.source).toBe("captions");
      expect(downloadCaptionsMock).toHaveBeenCalledOnce();
      expect(downloadAudioMock).not.toHaveBeenCalled();
      const timeline = await (await fetch(`${base}/api/jobs/${created.id}/timeline`)).json();
      expect(timeline.queue.segments[0].cues[0]).toMatchObject({ translated: "你好" });
    });
  });

  it("stops after a failed group instead of launching later requests", async () => {
    let rejectFirst;
    const synthesizeSpeechMock = vi.fn(() => new Promise((_, reject) => { rejectFirst = reject; }));
    await withServer({
      translateBatch: vi.fn(async (texts) => texts.map((text) => `中文${text}`)),
      synthesizeSpeech: synthesizeSpeechMock,
    }, async (base) => {
      const created = await createJob(base, { duration: 30, cues: [
        { start: 0, end: 2, text: "One" },
        { start: 3, end: 5, text: "Two" },
        { start: 6, end: 8, text: "Three" },
      ] });
      await vi.waitFor(() => expect(synthesizeSpeechMock).toHaveBeenCalledOnce());
      rejectFirst(new Error("HTTP 429"));
      let status;
      await vi.waitFor(async () => {
        status = await (await fetch(`${base}/api/jobs/${created.id}`)).json();
        expect(status.status).toBe("failed");
      });
      expect(status.error).toContain("第 1–3 条中文配音失败");
      expect(status.progress.phase).toBe("failed");
      expect(synthesizeSpeechMock).toHaveBeenCalledOnce();
      const after = await (await fetch(`${base}/api/jobs/${created.id}`)).json();
      expect(after.status).toBe("failed");
    });
  });

  it("retries a failed sentence without regenerating cached speech", async () => {
    let failed = false;
    const synthesizeSpeechMock = vi.fn(async (text) => {
      if (text === "中文Two" && !failed) { failed = true; throw new Error("rate limit exceeded(RPM)"); }
      return Buffer.from([1, 2]);
    });
    await withServer({
      translateBatch: vi.fn(async (texts) => texts.map((text) => `中文${text}`)),
      synthesizeSpeech: synthesizeSpeechMock,
    }, async (base) => {
      const created = await createJob(base, { duration: 10, cues: [
        { start: 0, end: 2, text: "One" }, { start: 4, end: 5, text: "Two" },
      ] });
      const failedJob = await waitFailed(base, created.id);
      expect(failedJob.failedSpeechIndex).toBe(1);
      const response = await fetch(`${base}/api/jobs/${created.id}/restart`, {
        method: "POST", headers: { Origin: `chrome-extension://${"a".repeat(32)}`, "Content-Type": "application/json" }, body: "{}",
      });
      expect(response.status).toBe(202);
      await waitReady(base, created.id);
      expect(synthesizeSpeechMock.mock.calls.map(([text]) => text)).toEqual(["中文One", "中文Two", "中文Two"]);
    });
  });

  it("skips a failed sentence, retains its subtitle, and continues later speech", async () => {
    const synthesizeSpeechMock = vi.fn(async (text) => {
      if (text === "中文One") throw new Error("rate limit exceeded(RPM)");
      return Buffer.from([3, 4]);
    });
    await withServer({
      translateBatch: vi.fn(async (texts) => texts.map((text) => `中文${text}`)),
      synthesizeSpeech: synthesizeSpeechMock,
    }, async (base) => {
      const created = await createJob(base, { duration: 10, cues: [
        { start: 0, end: 2, text: "One" }, { start: 4, end: 5, text: "Two" },
      ] });
      expect((await waitFailed(base, created.id)).failedSpeechIndex).toBe(0);
      const response = await fetch(`${base}/api/jobs/${created.id}/skip`, {
        method: "POST", headers: { Origin: `chrome-extension://${"a".repeat(32)}`, "Content-Type": "application/json" }, body: "{}",
      });
      expect(response.status).toBe(202);
      const ready = await waitReady(base, created.id);
      expect(ready.skippedSpeechCount).toBe(1);
      const timeline = await (await fetch(`${base}/api/jobs/${created.id}/timeline`)).json();
      expect(timeline.queue.segments[0].cues[0]).toMatchObject({ translated: "中文One", audioUrl: null });
      expect(timeline.queue.segments[0].cues[1].audioUrl).toContain("/audio/");
      expect((await fetch(`${base}/api/jobs/${created.id}/audio/0/0`)).status).toBe(404);
      expect(synthesizeSpeechMock.mock.calls.map(([text]) => text)).toEqual(["中文One", "中文Two"]);
    });
  });

  it("skips a sentence during the rate-limit wait without waiting for all retries", async () => {
    const synthesizeSpeechMock = vi.fn(async (text, _key, _voice, { signal, onRetry }) => {
      if (text !== "中文One") return Buffer.from([3, 4]);
      onRetry({ reason: "rate-limit", attempt: 1, maxAttempts: 3, waitMs: 60_000 });
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await withServer({
      translateBatch: vi.fn(async (texts) => texts.map((text) => `中文${text}`)),
      synthesizeSpeech: synthesizeSpeechMock,
    }, async (base) => {
      const created = await createJob(base, { duration: 10, cues: [
        { start: 0, end: 2, text: "One" }, { start: 4, end: 5, text: "Two" },
      ] });
      let waiting;
      await vi.waitFor(async () => {
        waiting = await (await fetch(`${base}/api/jobs/${created.id}`)).json();
        expect(waiting.retryingSpeechIndex).toBe(0);
      }, { timeout: 3000 });
      expect(waiting.retryAt).toBeGreaterThan(Date.now());
      const response = await fetch(`${base}/api/jobs/${created.id}/skip`, {
        method: "POST", headers: { Origin: `chrome-extension://${"a".repeat(32)}`, "Content-Type": "application/json" }, body: "{}",
      });
      expect(response.status).toBe(202);
      expect((await waitReady(base, created.id)).skippedSpeechCount).toBe(1);
      const timeline = await (await fetch(`${base}/api/jobs/${created.id}/timeline`)).json();
      expect(timeline.queue.segments[0].cues[0]).toMatchObject({ translated: "中文One", audioUrl: null });
      expect(timeline.queue.segments[0].cues[1].audioUrl).toContain("/audio/");
    });
  });
});
