import { describe, it, expect, vi } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

async function setup() {
  const { window } = await createSandboxWindow();
  loadService("ui/caption-fallback-choice.js", window);
  return { window, api: window.LumeoCaptionFallbackChoice };
}

describe("ui/caption-fallback-choice.js", () => {
  it("renders no-caption fallback choices and track diagnostics", async () => {
    const { window, api } = await setup();
    const callbacks = {
      onMiniMax: vi.fn(),
      onGroq: vi.fn(),
      onSoniox: vi.fn(),
      onStandard: vi.fn(),
      onRetry: vi.fn(),
      onCancel: vi.fn(),
    };

    const node = api.create({
      reason: "No track",
      diagnostics: { reason: "no-target-language", tracks: [{ languageCode: "en", kind: "asr", name: "English" }] },
      ...callbacks,
    });

    expect(node.querySelector("strong").textContent).toBe("没有匹配的字幕语言");
    expect(node.textContent).toContain("No track");
    expect(node.textContent).toContain("检测到 1 条字幕轨道");
    expect(node.textContent).toContain("en · 自动生成 — English");

    const buttons = Array.from(node.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "用 MiniMax 识别并中文配音",
      "尝试 Groq Whisper 语音识别",
      "尝试 Soniox 语音识别",
      "切换到标准配音",
      "重新获取字幕",
      "取消",
    ]);

    for (const button of buttons) button.click();
    expect(callbacks.onMiniMax).toHaveBeenCalledOnce();
    expect(callbacks.onGroq).toHaveBeenCalledOnce();
    expect(callbacks.onSoniox).toHaveBeenCalledOnce();
    expect(callbacks.onStandard).toHaveBeenCalledOnce();
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(window.LumeoCaptionFallbackChoice.__loaded).toBe(true);
  });

  it("maps fallback titles by failure reason", async () => {
    const { api } = await setup();

    expect(api.fallbackTitle({ reason: "timedtext-empty-body" })).toBe("YouTube 返回了空字幕");
    expect(api.fallbackTitle({ reason: "other" })).toBe("没有找到 YouTube 字幕");
  });
});
