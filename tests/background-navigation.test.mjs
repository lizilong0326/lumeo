import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMock } from "./helpers/chrome-mock.mjs";

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.LumeoBrowserApi;
  vi.resetModules();
});

describe("background YouTube navigation", () => {
  it("starts the next video even when Start beats the tab update callback", async () => {
    const tabs = [{ id: 1, url: "https://www.youtube.com/watch?v=qYNweeDHiyU" }];
    const chrome = createChromeMock({ tabs, onTabMessage: () => ({ ok: true }) });
    globalThis.chrome = chrome;
    vi.resetModules();
    await import("../background.js");
    const send = (type, extra = {}) => new Promise((resolve) => {
      chrome.__runtimeListeners[0]({ type, ...extra }, {}, resolve);
    });
    expect((await send("START", { settings: { targetLanguage: "zh-CN" } })).ok).toBe(true);
    tabs[0].url = "https://www.youtube.com/watch?v=phOhGqpXss4";
    const next = await send("START", { settings: { targetLanguage: "zh-CN" } });
    expect(next.ok).toBe(true);
    expect(next.state.videoId).toBe("phOhGqpXss4");
  });

  it("keeps the session on timestamp changes and stops it on a different video", async () => {
    const tabs = [{ id: 1, url: "https://www.youtube.com/watch?v=qYNweeDHiyU" }];
    const chrome = createChromeMock({ tabs, onTabMessage: () => ({ ok: true }) });
    globalThis.chrome = chrome;
    vi.resetModules();
    await import("../background.js");

    const send = (type, extra = {}) => new Promise((resolve) => {
      chrome.__runtimeListeners[0]({ type, ...extra }, {}, resolve);
    });
    const started = await send("START", { settings: { targetLanguage: "zh-CN" } });
    expect(started.ok).toBe(true);
    expect(started.state.videoId).toBe("qYNweeDHiyU");

    tabs[0].url = "https://www.youtube.com/watch?v=qYNweeDHiyU&t=120#chapter";
    chrome.__tabUpdatedListeners[0](1, { url: tabs[0].url });
    expect((await send("GET_STATE")).state.running).toBe(true);

    tabs[0].url = "https://www.youtube.com/watch?v=phOhGqpXss4";
    chrome.__tabUpdatedListeners[0](1, { url: tabs[0].url });
    await vi.waitFor(async () => expect((await send("GET_STATE")).state.running).toBe(false));
    expect(chrome.tabs.sendMessage.mock.calls.some(([id, message]) => id === 1 && message.type === "CONTENT_STOP")).toBe(true);
  });
});
