(() => {
  "use strict";

  if (window.LumeoSonioxSTT?.__loaded) return;

  let active = false;
  let paused = false;
  let stream = null;
  let audioCtx = null;
  let processor = null;
  let source = null;
  let callbacks = {};

  function emit(name, payload) {
    try { callbacks[name]?.(payload); } catch {}
  }

  function floatToPCM16(float32) {
    const out = new Array(float32.length);
    for (let i = 0; i < float32.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, float32[i]));
      out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return out.map((value) => value | 0);
  }

  function detectLangHints() {
    const hints = [];
    const htmlLang = document.documentElement.lang?.split("-")[0];
    if (htmlLang) hints.push(htmlLang);
    if (!hints.includes("en")) hints.push("en");
    return hints;
  }

  async function start(options = {}) {
    if (active) return { ok: true, alreadyActive: true };
    const apiKey = String(options.apiKey || "").trim();
    if (!apiKey) throw new Error("缺少 Soniox API 密钥。");
    callbacks = {
      status: options.onStatus,
      result: options.onResult,
      error: options.onError,
    };

    emit("status", "正在请求标签页音频权限");
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
      preferCurrentTab: true,
    });
    stream.getVideoTracks().forEach((track) => track.stop());
    if (!stream.getAudioTracks().length) {
      stop();
      throw new Error('没有音频轨道。请在提示出现时勾选“共享标签页音频”。');
    }

    active = true;
    paused = false;
    emit("status", "正在连接 Soniox");
    chrome.runtime.sendMessage({
      action: "startSonioxWs",
      apiKey,
      langHints: options.langHints || detectLangHints(),
    });

    audioCtx = new AudioContext({ sampleRate: 16000 });
    source = audioCtx.createMediaStreamSource(stream);
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("services/audio-processor.js"));
    processor = new AudioWorkletNode(audioCtx, "pcm-processor");
    processor.port.onmessage = (event) => {
      if (!active || paused) return;
      chrome.runtime.sendMessage({
        action: "sonioxAudio",
        samples: floatToPCM16(event.data),
      });
    };
    source.connect(processor);
    // Keep the worklet alive. Gain is zero so the captured audio is not doubled.
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(audioCtx.destination);
    emit("status", "正在识别语音");
    return { ok: true };
  }

  function stop() {
    active = false;
    paused = false;
    try { processor?.disconnect(); } catch {}
    try { source?.disconnect(); } catch {}
    try { audioCtx?.close(); } catch {}
    try { stream?.getTracks().forEach((track) => track.stop()); } catch {}
    processor = null;
    source = null;
    audioCtx = null;
    stream = null;
    chrome.runtime.sendMessage({ action: "stopSonioxWs" }).catch(() => {});
    emit("status", "已停止");
  }

  function pause() {
    if (!active || paused) return;
    paused = true;
    void audioCtx?.suspend?.();
  }

  function resume() {
    if (!active || !paused) return;
    paused = false;
    void audioCtx?.resume?.();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !active) return;
    if (message.action === "sonioxStatus") {
      emit("status", message.status);
    }
    if (message.action === "sonioxResult") {
      if (paused) return;
      emit("result", message.data);
    }
    if (message.action === "sonioxError") {
      emit("error", message.error);
      stop();
    }
  });

  window.LumeoSonioxSTT = {
    __loaded: true,
    start,
    pause,
    resume,
    stop,
    isActive: () => active,
  };
})();
