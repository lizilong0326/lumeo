import { describe, it, expect, vi } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

async function setup() {
  const { window } = await createSandboxWindow();
  loadService("services/minimax.js", window);
  return window.LumeoMiniMax;
}

describe("MiniMax 国内语音 API", () => {
  it("fits narration duration to the matching subtitle cue without extreme speed", async () => {
    const api = await setup();
    expect(api.playbackRateForCue(6, 4)).toBe(1.5);
    expect(api.playbackRateForCue(12, 4)).toBe(3);
    expect(api.playbackRateForCue(1, 4)).toBe(0.5);
    expect(api.playbackRateForCue(NaN, 4)).toBe(1);
  });
  it("uses multipart WAV input for ASR and surfaces API errors", async () => {
    const api = await setup();
    const fetch = vi.fn(async (url, init) => {
      expect(url).toBe("https://api.minimax.cn/v1/speech_to_text");
      expect(init.headers.Authorization).toBe("Bearer test-key");
      expect(init.body.get("model")).toBe("asr-1.0");
      expect(init.body.get("file").name).toBe("chunk.wav");
      return { ok: true, status: 200, json: async () => ({ text: "Hello world", duration: 5 }) };
    });
    expect(await api.transcribe(new Blob(["wav"]), { apiKey: "test-key", fetch })).toBe("Hello world");
    await expect(api.transcribe(new Blob(["wav"]), { apiKey: "" })).rejects.toThrow("MiniMax API 密钥");
  });

  it("decodes hex TTS audio and rejects provider-level failures", async () => {
    const api = await setup();
    const fetch = vi.fn(async (url, init) => {
      expect(url).toBe("https://api.minimax.cn/v1/t2a_v2");
      const body = JSON.parse(init.body);
      expect(body.model).toBe("speech-2.8-turbo");
      expect(body.voice_setting.voice_id).toBe("male-qn-qingse");
      return { ok: true, status: 200, json: async () => ({ data: { audio: "00ff10" }, base_resp: { status_code: 0 } }) };
    });
    expect(Array.from(await api.synthesize("你好", { apiKey: "test-key", fetch }))).toEqual([0, 255, 16]);
    const failed = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ base_resp: { status_code: 1008, status_msg: "余额不足" } }) }));
    await expect(api.synthesize("新的句子", { apiKey: "test-key", fetch: failed })).rejects.toThrow("余额不足");
  });

  it("reuses prefetched speech and separates caches by API key", async () => {
    const api = await setup();
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { audio: "00ff10" }, base_resp: { status_code: 0 } }),
    }));
    const first = api.prefetch("即将播放", { apiKey: "key-a", fetch });
    const second = api.synthesize("即将播放", { apiKey: "key-a", fetch });
    expect(api.isCached("即将播放", { apiKey: "key-a" })).toBe(false);
    expect(await first).toEqual(await second);
    expect(api.isCached("即将播放", { apiKey: "key-a" })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await api.synthesize("即将播放", { apiKey: "key-b", fetch });
    expect(api.isCached("即将播放", { apiKey: "key-a" })).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
