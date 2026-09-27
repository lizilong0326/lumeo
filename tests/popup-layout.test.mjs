import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";
import { createChromeMock } from "./helpers/chrome-mock.mjs";

describe("插件弹窗精简布局", () => {
  it("initializes the MiniMax card and keeps voice, cookie and start controls usable", async () => {
    const { dom, window } = await createSandboxWindow({ url: "chrome-extension://lumeo/popup.html" });
    window.document.documentElement.innerHTML = readFileSync(resolve(process.cwd(), "popup.html"), "utf8")
      .replace(/^<!doctype html>/i, "")
      .replace(/<script\b[^>]*><\/script>/g, "");
    const chrome = createChromeMock({
      tabs: [{ id: 1, url: "https://www.youtube.com/watch?v=qYNweeDHiyU", title: "测试视频 - YouTube" }],
      onRuntimeMessage: (message) => message.type === "GET_STATE"
        ? { ok: true, state: { running: false, minimaxKey: "", standardVoice: "previous-custom-voice", status: "就绪" } }
        : { ok: true, state: { running: false } },
    });
    window.chrome = chrome;
    try {
      for (const file of ["services/providers.js", "services/tier-recommendation.js", "services/srt-export.js", "services/translation-bundle.js", "lib/browser-api.js", "popup.js"]) {
        loadService(file, window);
      }
      await vi.waitFor(() => expect(window.document.querySelector("#setupStack input#minimaxKey")).not.toBeNull());
      expect(window.document.querySelectorAll('input[name="modeProxy"]')).toHaveLength(0);
      await vi.waitFor(() => expect(window.document.querySelector("#tabTitle").textContent).toBe("测试视频"));
      const voice = window.document.querySelector("#voice");
      expect(Array.from(voice.options).map((option) => option.value)).toContain("Chinese (Mandarin)_News_Anchor");
      await vi.waitFor(() => expect(voice.value).toBe("__custom_voice__"));
      expect(window.document.querySelector("#customVoiceId").value).toBe("previous-custom-voice");
      voice.value = "__custom_voice__";
      voice.dispatchEvent(new window.Event("change", { bubbles: true }));
      const customVoice = window.document.querySelector("#customVoiceId");
      expect(window.document.querySelector("#customVoiceField").hidden).toBe(false);
      customVoice.value = "my-custom-voice-id";
      customVoice.dispatchEvent(new window.Event("change", { bubbles: true }));
      expect(window.document.querySelector("#useChromeCookies")).not.toBeNull();
      const key = window.document.querySelector("#minimaxKey");
      key.value = "test-key";
      key.dispatchEvent(new window.Event("input", { bubbles: true }));
      window.document.querySelector("#toggle").click();
      await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "START", settings: expect.objectContaining({ minimaxKey: "test-key", standardVoice: "my-custom-voice-id" }) }),
        expect.any(Function),
      ));
    } finally { dom.window.close(); }
  });
});
