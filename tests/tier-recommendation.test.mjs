import { describe, it, expect } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

async function setup() {
  const { window } = await createSandboxWindow();
  loadService("services/tier-recommendation.js", window);
  return window.LumeoTierRecommendation;
}

describe("services/tier-recommendation.js", () => {
  it("detects live-like video contexts", async () => {
    const api = await setup();

    expect(api.isLiveLike({ title: "Lo-fi live stream - YouTube" })).toBe(true);
    expect(api.isLiveLike({ title: "Static tutorial - YouTube" })).toBe(false);
  });

  it("recommends tiers with user-facing rationale", async () => {
    const api = await setup();

    expect(api.recommendationFor({}, { tier: "caption" })).toContain("MiniMax 大模型翻译并朗读");
    expect(api.recommendationFor({}, { tier: "caption", captionUnavailable: true })).toContain("此视频没有可读字幕");
    expect(api.recommendationFor({}, { tier: "standard" })).toContain("字幕缺失");
  });
});
