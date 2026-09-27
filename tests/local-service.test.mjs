import { describe, expect, it, vi } from "vitest";
import { SegmentQueue, parseSrt, planSegments, youtubeVideoId } from "../local-service/core.mjs";
import { parseIndexedTranslations, parseTranslationArray, translateBatch } from "../local-service/minimax.mjs";
import { createServer } from "../local-service/server.mjs";
import { explainYoutubeError, youtubeCookieArgs } from "../local-service/media.mjs";

describe("译幕本地服务", () => {
  it("accepts only concrete YouTube video URLs", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=qYNweeDHiyU&t=20")).toBe("qYNweeDHiyU");
    expect(youtubeVideoId("https://youtu.be/qYNweeDHiyU")).toBe("qYNweeDHiyU");
    expect(() => youtubeVideoId("http://127.0.0.1/private")).toThrow();
    expect(() => youtubeVideoId("https://example.com/watch?v=qYNweeDHiyU")).toThrow();
  });

  it("plans five-minute segments including a short final segment", () => {
    expect(planSegments(650).map(({ start, end }) => [start, end])).toEqual([[0, 300], [300, 600], [600, 650]]);
  });

  it("moves sentence timestamps to the video timeline", () => {
    const cues = parseSrt("1\n00:00:01,200 --> 00:00:03,000\nHello world.\n\n2\n00:00:04,000 --> 00:00:06,000\nNext line.\n", 300, 305);
    expect(cues).toEqual([
      { start: 301.2, end: 303, text: "Hello world." },
      { start: 304, end: 305, text: "Next line." },
    ]);
  });

  it("keeps processing within the current segment and the next three", async () => {
    const seen = [];
    const queue = new SegmentQueue({
      duration: 1800,
      processSegment: async (segment) => { seen.push(segment.index); return []; },
    });
    queue.schedule();
    await vi.waitFor(() => expect(queue.segments[3].status).toBe("ready"));
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(queue.segments[4].status).toBe("pending");
    queue.setPlayhead(301);
    await vi.waitFor(() => expect(queue.segments[4].status).toBe("ready"));
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    queue.close();
  });

  it("cancels work outside the window after seeking and prevents retries after stop", async () => {
    let aborted = false;
    const queue = new SegmentQueue({
      duration: 1800,
      processSegment: (_segment, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
      }),
    });
    queue.schedule();
    await vi.waitFor(() => expect(queue.segments[0].status).toBe("running"));
    queue.setPlayhead(1501);
    await vi.waitFor(() => expect(aborted).toBe(true));
    queue.close();
    expect(queue.retry(0)).toBe(false);
  });

  it("rejects malformed translation batches before making voice files", () => {
    expect(parseTranslationArray('```json\n["你好", "世界"]\n```', 2)).toEqual(["你好", "世界"]);
    expect(() => parseTranslationArray('["你好"]', 2)).toThrow("句数");
    expect(parseIndexedTranslations("[0] 你好\n[1] 世界", 2)).toEqual(["你好", "世界"]);
  });

  it("recovers missing translations with individual MiniMax requests", async () => {
    const contents = ["[0] 你好", "世界"];
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: contents.shift() } }],
      base_resp: { status_code: 0 },
    }), { status: 200 }));
    expect(await translateBatch(["Hello", "World"], "test", { fetchFn })).toEqual(["你好", "世界"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("recovers when MiniMax returns a malformed JSON array", async () => {
    const contents = ['["你好", "世"界"]', "你好", "世界"];
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: contents.shift() } }],
      base_resp: { status_code: 0 },
    }), { status: 200 }));
    expect(await translateBatch(["Hello", "World"], "test", { fetchFn })).toEqual(["你好", "世界"]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("uses browser cookies only after explicit opt-in and explains the verification error", () => {
    expect(youtubeCookieArgs({ useChromeCookies: true })).toEqual(["--cookies-from-browser", "chrome"]);
    const error = explainYoutubeError(new Error("ERROR: Sign in to confirm you’re not a bot"));
    expect(error.message).toContain("登录验证");
    expect(error.message).toContain("重新尝试读取");
  });

  it("serves only the local origin", async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = server.address().port;
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect((await health.json()).ok).toBe(true);
      const foreign = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://youtu.be/qYNweeDHiyU", apiKey: "test" }),
      });
      expect(foreign.status).toBe(403);
      const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
      const jobPath = `/api/jobs/01234567-89ab-cdef-0123-456789abcdef`;
      const extensionRead = await fetch(`http://127.0.0.1:${port}${jobPath}`, { headers: { Origin: extensionOrigin } });
      expect(extensionRead.status).toBe(404);
      const extensionCreate = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: "POST", headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://youtu.be/qYNweeDHiyU", apiKey: "test" }),
      });
      expect(extensionCreate.status).toBe(403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
