(() => {
  "use strict";

  if (window.LumeoStandardPipeline?.__loaded) return;

  const DEFAULT_CHUNK_MS = 5000;
  const MIN_CHUNK_BYTES = 2000;
  const RECORDER_MIMES = Object.freeze([
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ]);

  function pickRecorderMime(audioUtils = window.LumeoAudioUtils) {
    return audioUtils?.pickRecorderMime?.(RECORDER_MIMES) || "";
  }

  function shouldProcessChunk(sessionRef, activeSession, pageToken, blob) {
    if (sessionRef !== activeSession) return false;
    if (sessionRef?.token !== pageToken) return false;
    if (sessionRef?.paused || sessionRef?.stopFlag) return false;
    return Number(blob?.size || 0) >= MIN_CHUNK_BYTES;
  }

  function pauseSession(sessionRef) {
    if (sessionRef.paused || sessionRef.stopFlag) return;
    sessionRef.paused = true;
    sessionRef.pauseEpoch = (sessionRef.pauseEpoch || 0) + 1;
    sessionRef.abortController?.abort();
    try {
      if (sessionRef.activeRecorder?.state !== "inactive") sessionRef.activeRecorder.stop();
    } catch {}
    stopPlayingSources(sessionRef);
  }

  function resumeSession(sessionRef) {
    if (!sessionRef.paused || sessionRef.stopFlag) return;
    sessionRef.abortController = new AbortController();
    sessionRef.paused = false;
  }

  function stopPlayingSources(sessionRef) {
    for (const source of sessionRef.playingSources || []) {
      try { source.stop(); } catch {}
    }
    sessionRef.playingSources?.clear();
    sessionRef.nextPlayAt = 0;
  }

  function playbackRateForSegment(audioDuration, segmentDuration) {
    if (!Number.isFinite(audioDuration) || !Number.isFinite(segmentDuration) ||
        audioDuration <= 0 || segmentDuration <= 0) return 1;
    return Math.max(0.5, Math.min(4, audioDuration / segmentDuration));
  }

  function playBuffer(sessionRef, audioBuffer, options = {}) {
    if (sessionRef.paused || sessionRef.stopFlag) return;
    if (sessionRef.nextPlayAt < sessionRef.audioCtx.currentTime) sessionRef.nextPlayAt = 0;
    const startAt = Math.max(sessionRef.audioCtx.currentTime + 0.05, sessionRef.nextPlayAt);
    const source = sessionRef.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    const rate = playbackRateForSegment(audioBuffer.duration, Number(options.segmentDuration));
    if (source.playbackRate) source.playbackRate.value = rate;
    source.connect(sessionRef.outputGain);
    sessionRef.playingSources ||= new Set();
    sessionRef.playingSources.add(source);
    source.addEventListener?.("ended", () => sessionRef.playingSources.delete(source), { once: true });
    const offset = Math.max(0, Number(options.videoOffset || 0) * rate);
    try {
      if (offset > 0) source.start(startAt, Math.min(offset, audioBuffer.duration));
      else source.start(startAt);
    } catch { sessionRef.playingSources.delete(source); return; }
    sessionRef.nextPlayAt = startAt + Math.max(0, audioBuffer.duration - offset) / rate;
  }

  function recordOneChunk(sessionRef, options = {}) {
    const Recorder = options.MediaRecorder || window.MediaRecorder;
    const BlobCtor = options.BlobCtor || Blob;
    const setTimer = options.setTimeout || setTimeout;
    return new Promise((resolve, reject) => {
      let recorder;
      try {
        recorder = new Recorder(sessionRef.stream, { mimeType: sessionRef.recorderMime });
      } catch {
        try { recorder = new Recorder(sessionRef.stream); }
        catch (error) { reject(error); return; }
      }
      sessionRef.activeRecorder = recorder;
      const parts = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) parts.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        if (sessionRef.activeRecorder === recorder) sessionRef.activeRecorder = null;
        resolve(new BlobCtor(parts, { type: sessionRef.recorderMime }));
      }, { once: true });
      try { recorder.start(); }
      catch (error) { sessionRef.activeRecorder = null; reject(error); return; }
      setTimer(() => {
        try { if (recorder.state !== "inactive") recorder.stop(); } catch {}
      }, options.chunkMs || DEFAULT_CHUNK_MS);
    });
  }

  async function runSynchronizedLoop(sessionRef, options = {}) {
    const isCurrent = () => sessionRef === options.getActiveSession?.() && !sessionRef.stopFlag;
    while (isCurrent()) {
      if (sessionRef.paused) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      const epoch = sessionRef.pauseEpoch || 0;
      try {
        sessionRef.preparedAudio = null;
        sessionRef.preparationError = null;
        const startTime = await options.onCaptureStart(sessionRef);
        if (!isCurrent()) break;
        const blob = await recordOneChunk(sessionRef, options);
        const endTime = await options.onCaptureEnd(sessionRef, startTime);
        if (!isCurrent()) break;
        if (sessionRef.paused || (sessionRef.pauseEpoch || 0) !== epoch) {
          await options.onDiscard?.(sessionRef, startTime);
          continue;
        }
        if (blob.size >= MIN_CHUNK_BYTES) await options.processChunk(sessionRef, blob);
        if (!isCurrent()) break;
        if (sessionRef.paused || (sessionRef.pauseEpoch || 0) !== epoch) {
          await options.onDiscard?.(sessionRef, startTime);
          continue;
        }
        if (sessionRef.preparationError) throw sessionRef.preparationError;
        await options.onPlayback(sessionRef, {
          startTime,
          endTime,
          audioBuffer: sessionRef.preparedAudio,
        });
      } catch (error) {
        if (!isCurrent()) break;
        options.onError?.(error);
        break;
      }
    }
  }

  function runChunkLoop(sessionRef, options = {}) {
    const {
      getActiveSession = () => null,
      isVideoPaused = () => false,
      MediaRecorder: Recorder = window.MediaRecorder,
      BlobCtor = Blob,
      setTimeout: setTimer = setTimeout,
      processChunk = () => Promise.resolve(),
      chunkMs = DEFAULT_CHUNK_MS,
      retryPausedMs = 400,
      retryErrorMs = 1000,
    } = options;

    const cycle = () => {
      if (sessionRef !== getActiveSession() || sessionRef.stopFlag) return;
      if (sessionRef.paused || isVideoPaused()) {
        setTimer(cycle, retryPausedMs);
        return;
      }

      let recorder;
      try {
        recorder = new Recorder(sessionRef.stream, { mimeType: sessionRef.recorderMime });
      } catch {
        try {
          recorder = new Recorder(sessionRef.stream);
        } catch {
          setTimer(cycle, retryErrorMs);
          return;
        }
      }

      sessionRef.activeRecorder = recorder;
      const recordingEpoch = sessionRef.pauseEpoch || 0;
      const parts = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) parts.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        if (sessionRef !== getActiveSession() || sessionRef.stopFlag) return;
        if (!sessionRef.paused && !isVideoPaused() &&
            (sessionRef.pauseEpoch || 0) === recordingEpoch && parts.length) {
          const blob = new BlobCtor(parts, { type: sessionRef.recorderMime });
          processChunk(sessionRef, blob).catch(() => {});
        }
        cycle();
      });

      try {
        recorder.start();
      } catch {
        setTimer(cycle, retryErrorMs);
        return;
      }

      setTimer(() => {
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {}
      }, chunkMs);
    };

    cycle();
  }

  async function processChunk(sessionRef, blob, context = {}) {
    const activeSession = context.getActiveSession?.();
    const pageToken = context.getPageToken?.();
    if (!shouldProcessChunk(sessionRef, activeSession, pageToken, blob)) return;
    const pauseEpoch = sessionRef.pauseEpoch || 0;

    if ((context.getSettings?.()?.dubProvider || "kyma") === "minimax-dub") {
      // Keep recognition, translation and playback in video order. Drop a
      // chunk if the provider is already more than two chunks behind.
      if ((sessionRef.pendingChunks || 0) >= 2) return;
      sessionRef.pendingChunks = (sessionRef.pendingChunks || 0) + 1;
      const previous = sessionRef.workQueue || Promise.resolve();
      const work = previous.catch(() => {}).then(() => {
        if (sessionRef.paused || (sessionRef.pauseEpoch || 0) !== pauseEpoch) return;
        return processMiniMaxChunk(sessionRef, blob, context);
      });
      sessionRef.workQueue = work.finally(() => { sessionRef.pendingChunks -= 1; });
      return sessionRef.workQueue;
    }

    const settings = context.getSettings?.() || {};
    const token = sessionRef.token;
    const kymaKey = sessionRef.kymaKey;
    const language = settings.targetLanguage || "zh-CN";
    const languageName = context.langNameByCode?.[language] || language;
    const voiceId = settings.standardVoice || context.standardDefaultVoice || "English_magnetic_voiced_man";
    const kymaBase = context.kymaBase || "https://api.kymaapi.com/v1";
    const audioUtils = context.audioUtils || window.LumeoAudioUtils;
    const fetchFn = context.fetch || fetch;
    const FormDataCtor = context.FormData || FormData;
    const parseKymaError = context.parseKymaError || ((status, body) => ({ status, user: body || "配音流程出错" }));
    const signal = sessionRef.abortController.signal;
    const isCurrent = () => sessionRef === context.getActiveSession?.() &&
      sessionRef.token === context.getPageToken?.() && !sessionRef.paused && !sessionRef.stopFlag &&
      (sessionRef.pauseEpoch || 0) === pauseEpoch && !signal.aborted;

    let wavBlob;
    try {
      wavBlob = await audioUtils.webmBlobToWav(blob, sessionRef.audioCtx);
    } catch {
      return;
    }
    if (!isCurrent()) return;

    const formData = new FormDataCtor();
    formData.append("file", wavBlob, "chunk.wav");
    formData.append("model", "whisper-v3-turbo");
    formData.append("response_format", "json");

    let transcriptionResponse;
    try {
      transcriptionResponse = await fetchFn(`${kymaBase}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: "Bearer " + kymaKey },
        body: formData,
        signal,
      });
    } catch {
      return;
    }
    if (!isCurrent()) return;
    if (!transcriptionResponse.ok) {
      const body = await transcriptionResponse.text().catch(() => "");
      context.onError?.(parseKymaError(transcriptionResponse.status, body));
      return;
    }

    const transcription = await transcriptionResponse.json().catch(() => ({}));
    const sourceText = String(transcription.text || "").trim();
    if (!sourceText || sourceText.length < 2) return;
    context.onSourceText?.(sourceText);

    let translationResponse;
    try {
      translationResponse = await fetchFn(`${kymaBase}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + kymaKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `You are a live dubbing translator. Translate the user's sentence into ${languageName}. Output ONLY the translation. No quotes, no commentary, no explanation, no labels. Preserve names, brand names, and technical terms verbatim.`,
            },
            { role: "user", content: sourceText },
          ],
          temperature: 0.2,
        }),
        signal,
      });
    } catch {
      return;
    }
    if (!isCurrent()) return;
    if (!translationResponse.ok) {
      const body = await translationResponse.text().catch(() => "");
      context.onError?.(parseKymaError(translationResponse.status, body));
      return;
    }

    const translation = await translationResponse.json().catch(() => ({}));
    const targetText = String(translation?.choices?.[0]?.message?.content || "").trim();
    if (!targetText) return;
    context.onTargetText?.(targetText);

    let speechResponse;
    try {
      speechResponse = await fetchFn(`${kymaBase}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + kymaKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "minimax-speech-turbo",
          input: targetText,
          voice_id: voiceId,
          response_format: "mp3",
        }),
        signal,
      });
    } catch {
      return;
    }
    if (!isCurrent()) return;
    if (!speechResponse.ok) {
      const body = await speechResponse.text().catch(() => "");
      context.onError?.(parseKymaError(speechResponse.status, body));
      return;
    }

    const arrayBuffer = await speechResponse.arrayBuffer();
    if (!isCurrent()) return;

    let audioBuffer;
    try {
      audioBuffer = await sessionRef.audioCtx.decodeAudioData(arrayBuffer);
    } catch {
      return;
    }
    if (!isCurrent()) return;

    if (context.onAudioReady) context.onAudioReady(sessionRef, audioBuffer);
    else playBuffer(sessionRef, audioBuffer);
    context.onChunkDone?.();
  }

  async function processMiniMaxChunk(sessionRef, blob, context = {}) {
    const pauseEpoch = sessionRef.pauseEpoch || 0;
    const signal = sessionRef.abortController.signal;
    const isCurrent = () => sessionRef === context.getActiveSession?.() &&
      sessionRef.token === context.getPageToken?.() && !sessionRef.stopFlag && !sessionRef.paused &&
      (sessionRef.pauseEpoch || 0) === pauseEpoch && !signal.aborted;
    if (!isCurrent()) return;
    const settings = context.getSettings?.() || {};
    const miniMax = context.miniMax || window.LumeoMiniMax;
    const translator = context.translate || window.LumeoTranslate;
    if (!miniMax || !translator) {
      context.onError?.({ user: "MiniMax 配音组件未加载，请重新加载扩展。" });
      return;
    }
    try {
      const wav = await (context.audioUtils || window.LumeoAudioUtils).webmBlobToWav(blob, sessionRef.audioCtx);
      if (!isCurrent()) return;
      const sourceText = await miniMax.transcribe(wav, {
        apiKey: settings.minimaxKey,
        signal,
      });
      if (!isCurrent() || !sourceText) return;
      context.onSourceText?.(sourceText);

      const language = settings.targetLanguage || "zh-CN";
      const [targetText] = await translator.translateBatch([sourceText], language, {
        provider: "minimax",
        minimaxKey: settings.minimaxKey,
        targetLanguageName: context.langNameByCode?.[language] || language,
        context: settings.translationContext || "",
        signal,
      });
      if (!isCurrent() || !targetText) return;
      context.onTargetText?.(targetText);

      const bytes = await miniMax.synthesize(targetText, {
        apiKey: settings.minimaxKey,
        voice: settings.standardVoice || miniMax.DEFAULT_VOICE,
        signal,
      });
      if (!isCurrent() || !bytes?.length) return;
      const audioBuffer = await sessionRef.audioCtx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      if (!isCurrent()) return;
      if (context.onAudioReady) context.onAudioReady(sessionRef, audioBuffer);
      else playBuffer(sessionRef, audioBuffer);
      context.onChunkDone?.();
    } catch (error) {
      if (isCurrent() && error?.name !== "AbortError") context.onError?.({ user: error?.message || "MiniMax 配音失败。" });
    }
  }

  window.LumeoStandardPipeline = {
    __loaded: true,
    DEFAULT_CHUNK_MS,
    MIN_CHUNK_BYTES,
    RECORDER_MIMES,
    pickRecorderMime,
    shouldProcessChunk,
    pauseSession,
    resumeSession,
    stopPlayingSources,
    playbackRateForSegment,
    playBuffer,
    recordOneChunk,
    runSynchronizedLoop,
    runChunkLoop,
    processChunk,
    processMiniMaxChunk,
  };
})();
