import { describe, expect, it, vi } from "vitest";
import { createSandboxWindow, loadService } from "./helpers/load-service.mjs";

describe("YouTube page task panel controls", () => {
  it("moves within the viewport, closes until restored, and shows measured phase progress", async () => {
    const { dom, window } = await createSandboxWindow();
    try {
      loadService("ui/local-panel.js", window);
      const panel = window.document.createElement("aside");
      const header = window.document.createElement("div");
      panel.append(header);
      window.document.body.append(panel);
      panel.getBoundingClientRect = vi.fn(() => ({ left: 650, top: 80, width: 300, height: 200 }));
      const controls = window.YimuPanel.attach(panel, header);
      panel.append(controls.progress);

      header.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 680, clientY: 100 }));
      window.document.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientX: 1000, clientY: 170 }));
      window.document.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true }));
      expect(panel.style.left).toBe("716px");
      expect(panel.style.top).toBe("150px");

      const bar = controls.progress.querySelector("progress");
      controls.setProgress({ phase: "speaking", completed: 3, total: 12 });
      expect(bar.value).toBe(25);
      expect(controls.progress.textContent).toContain("生成配音 · 3/12 · 25%");
      controls.setProgress({ phase: "downloading" });
      expect(bar.hasAttribute("value")).toBe(false);
      controls.setProgress({ phase: "ready" });
      expect(bar.value).toBe(100);

      header.querySelector(".yimu-panel-close").click();
      expect(panel.hidden).toBe(true);
      expect(controls.keepClosed).toBe(true);
      controls.show();
      expect(panel.hidden).toBe(true);
      const restore = window.document.querySelector(".yimu-panel-restore");
      restore.click();
      expect(panel.hidden).toBe(false);
      expect(restore.hidden).toBe(true);
      controls.destroy();
      expect(window.document.querySelector(".yimu-panel-restore")).toBeNull();
    } finally { dom.window.close(); }
  });
});
