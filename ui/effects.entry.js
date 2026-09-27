import React from "react";
import { createRoot } from "react-dom/client";
import { ThinkingOrb } from "thinking-orbs";
import { VoiceBeam, getAudioContext } from "voice-glow";

// A small React island for the otherwise framework-free content script.
window.YimuThinkingOrb = {
  mount(container, initialState) {
    const root = createRoot(container);
    const render = (state) => root.render(React.createElement(ThinkingOrb, {
      state,
      size: 20,
      theme: "dark",
      "aria-hidden": true,
    }));
    render(initialState);
    return { setState: render, destroy: () => root.unmount() };
  },
};

window.YimuVoiceGlow = {
  // Called by the user's playback click so audio analysis can resume on browsers
  // that require a user gesture for AudioContext.
  prime() { getAudioContext(); },
  mount(container) {
    const root = createRoot(container);
    const render = (stream) => root.render(stream ? React.createElement(VoiceBeam, {
      stream,
      theme: "dark",
      className: "yimu-voice-beam",
    }, React.createElement("div", { className: "yimu-voice-card" },
      React.createElement("strong", null, "正在播放中文配音"),
      React.createElement("span", null, "光效跟随当前语音"),
    )) : null);
    return { setStream: render, destroy: () => root.unmount() };
  },
};
