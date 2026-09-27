import { describe, it, expect, beforeEach } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

async function setup() {
  const { window } = await createSandboxWindow();
  loadService("ui/voice-picker.js", window);
  const select = window.document.createElement("select");
  window.document.body.appendChild(select);
  return { window, api: window.LumeoVoicePicker, select };
}

function optionValues(select) {
  return Array.from(select.options).map((option) => option.value);
}

function optionLabels(select) {
  return Array.from(select.options).map((option) => option.textContent);
}

describe("ui/voice-picker.js", () => {
  let api;
  let select;

  beforeEach(async () => {
    ({ api, select } = await setup());
  });

  it("renders caption TTS options with accessible copy", () => {
    api.populate(select, "caption", { captionTtsProvider: "browser" });
    expect(optionValues(select)).toEqual(["off", "minimax-tts", "browser", "google-cloud", "openai-tts"]);
    expect(select.value).toBe("browser");
    expect(select.getAttribute("aria-label")).toBe("朗读译文");
    expect(select.title).toContain("朗读中文字幕");
  });

  it("renders MiniMax voices by default", () => {
    api.populate(select, "standard", {});
    expect(optionValues(select)).toContain("male-qn-qingse");
    expect(optionLabels(select)).toContain("MiniMax 青涩男声");
    expect(select.value).toBe(api.STANDARD_DEFAULT_VOICE);
    expect(select.getAttribute("aria-label")).toBe("配音声音");
    expect(select.hasAttribute("title")).toBe(false);
  });

  it("honors selected Standard voice", () => {
    api.populate(select, "standard", { dubProvider: "kyma", standardVoice: "English_ConfidentWoman" });
    expect(select.value).toBe("English_ConfidentWoman");
  });

  it("keeps a custom MiniMax voice selected on the page", () => {
    api.populate(select, "standard", { dubProvider: "minimax-dub", standardVoice: "my-custom-voice-id" });
    expect(select.value).toBe("my-custom-voice-id");
    expect(optionLabels(select)).toContain("自定义音色：my-custom-voice-id");
  });

});
