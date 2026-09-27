import { describe, it, expect, beforeAll } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

describe("services/providers.js", () => {
  let api;

  beforeAll(async () => {
    const { window } = await createSandboxWindow();
    loadService("services/providers.js", window);
    api = window.LumeoProviders;
  });

  it("reports hasRequiredKeys for no-key providers as true", () => {
    expect(api.hasRequiredKeys("google-free", {})).toBe(true);
    expect(api.hasRequiredKeys("browser", {})).toBe(true);
    expect(api.hasRequiredKeys("off", {})).toBe(true);
  });

  it("reports hasRequiredKeys based on the declared keyFields", () => {
    expect(api.hasRequiredKeys("gemini", {})).toBe(false);
    expect(api.hasRequiredKeys("gemini", { geminiKey: "AIza" })).toBe(true);
    expect(api.hasRequiredKeys("openrouter", { openRouterKey: "sk-or-x" })).toBe(true);
  });

  it("builds actionable missing-key copy", () => {
    expect(api.missingKeyMessage("gemini"))
      .toBe("请在字幕翻译中填写 Gemini 密钥，然后重新开始。");
  });

  it("resolves required providers per mode using the current selection", () => {
    expect(api.requiredProvidersForMode("caption", {})).toEqual(["minimax"]);
    expect(api.requiredProvidersForMode("caption", { translateProvider: "gemini" })).toEqual(["gemini"]);
    expect(api.requiredProvidersForMode("standard", { dubProvider: "kyma" })).toEqual(["kyma"]);
    expect(api.requiredProvidersForMode("standard", {})).toEqual(["minimax-dub"]);
    expect(api.modes.realtime).toBeUndefined();
    expect(api.providerById("kyma-realtime")).toBeNull();
  });

  it("filters available providers for a given slot and mode", () => {
    const translators = api.providersForSlot("caption", "translator").map((p) => p.id);
    expect(translators).toContain("google-free");
    expect(translators).toContain("gemini");
    expect(translators).not.toContain("kyma");
    expect(translators).not.toContain("huggingface");
  });

  it("can include roadmap-only providers explicitly", () => {
    const translators = api.providersForSlot("caption", "translator", { includeRoadmap: true }).map((p) => p.id);
    expect(translators).toContain("huggingface");
  });

  it("exposes keyFieldsForProvider including optional fields", () => {
    const libreFields = api.keyFieldsForProvider("libretranslate");
    expect(libreFields).toContain("libreTranslateUrl");
    expect(libreFields).toContain("libreTranslateKey");
    expect(api.keyFieldsForProvider("openai-tts")).toContain("openaiKey");
  });

  it("derives capability flags from provider slots and status", () => {
    expect(api.providerCapabilities(api.providerById("google-free"))).toMatchObject({
      translate: true,
      stt: false,
      requiresKey: false,
      free: true,
      comingSoon: false,
    });
    expect(api.providerCapabilities(api.providerById("groq-whisper"))).toMatchObject({
      stt: true,
      requiresKey: true,
      localOnly: false,
    });
    expect(api.providerCapabilities(api.providerById("kyma"))).toMatchObject({
      standardDub: true,
      requiresKey: true,
    });
    expect(api.providerCapabilities(api.providerById("openai-direct-dub"))).toMatchObject({
      standardDub: true,
      comingSoon: true,
    });
  });
});
