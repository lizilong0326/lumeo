// pipelines/caption-orchestrator.js

(() => {
  window.LumeoCaptionOrchestrator = {
    missingCaptionDependencies() {
      const required = [
        ["LumeoTranslate", window.LumeoTranslate],
        ["LumeoSrtExport", window.LumeoSrtExport],
        ["LumeoTTS", window.LumeoTTS],
        ["LumeoSonioxSTT", window.LumeoSonioxSTT],
        ["LumeoCaptions", window.LumeoCaptions],
        ["LumeoCaptionPipeline", window.LumeoCaptionPipeline],
      ];
      return required.filter(([, value]) => !value).map(([name]) => name);
    },

    async enableYouTubeCaptions() {
      const button = document.querySelector(".ytp-subtitles-button");
      if (!button) return false;
      const label = button.getAttribute("aria-label") || "";
      if (/unavailable/i.test(label)) return false;
      if (button.getAttribute("aria-pressed") !== "true") {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      return button.getAttribute("aria-pressed") === "true";
    },

    async translateLiveCaptionLine(text, ctx) {
      const settings = ctx.getSettings();
      const [translated] = await window.LumeoTranslate.translateBatch([text], settings.targetLanguage || "zh-CN", {
        provider: settings.translateProvider || "google-free",
        targetLanguageName: ctx.getLangName(settings.targetLanguage) || settings.targetLanguage || "Chinese (Simplified)",
        openaiKey: settings.openaiKey,
        openaiModel: settings.openaiModel,
        geminiKey: settings.geminiKey,
        geminiModel: settings.geminiModel,
        openRouterKey: settings.openRouterKey,
        openRouterModel: settings.openRouterModel,
        groqApiKey: settings.groqApiKey,
        groqModel: settings.groqModel,
        minimaxKey: settings.minimaxKey,
        googleCloudKey: settings.googleCloudKey,
        libreTranslateUrl: settings.libreTranslateUrl,
        libreTranslateKey: settings.libreTranslateKey,
        context: settings.translationContext,
      });
      return translated || text;
    },

    async appendLiveSttCue(video, pipeline, sourceText, ctx) {
      const session = ctx.getSession();
      const settings = ctx.getSettings();
      const clean = String(sourceText || "").trim();
      if (!clean || session?.type !== "caption" || !session.liveStt) return;

      const start = video.currentTime || 0;
      const cue = { start, end: start + 4, text: clean, translated: clean };
      try {
        cue.translated = await this.translateLiveCaptionLine(clean, ctx);
      } catch {
        cue.translated = clean;
      }

      if (session?.type !== "caption" || !session.liveStt) return;
      cue.end = Math.max(video.currentTime || cue.end, cue.start + 2);
      session.cues.push(cue);
      pipeline.cues = session.cues;

      ctx.setCurrentTexts(cue.text, cue.translated);
      ctx.setTargetCue(cue);

      const elements = ctx.getElements();
      if (elements.source && settings.showSource) {
        elements.source.textContent = cue.text.slice(-260);
      }

      const transcript = ctx.getTranscriptController();
      transcript?.appendCaptionRow(cue, session.cues.length - 1);
      transcript?.updateCaptionTranscriptCount(session.cues.length);
      transcript?.updateCaptionTranscriptHighlight(session.cues.length - 1);

      if (settings.captionTtsProvider && settings.captionTtsProvider !== "off") {
        pipeline.speakCue(cue, {
          provider: settings.captionTtsProvider,
          targetLanguage: settings.targetLanguage || "zh-CN",
          googleCloudKey: settings.googleCloudKey,
          openaiKey: settings.openaiKey,
          minimaxKey: settings.minimaxKey,
          rate: settings.ttsRate || 1,
          volume: Math.min((settings.voiceVolume ?? 100) / 100, 1),
        }).catch(() => { });
      }
    },

    renderCaptionFallbackChoice(video, token, pipeline, reason, diagnostics, ctx) {
      const session = {
        token,
        type: "caption",
        choiceOnly: true,
        pipeline,
        captionTimer: null,
        lastCueIndex: -1,
        kymaKey: null,
        stream: null,
        pc: null,
        dc: null,
      };
      ctx.onSessionCreated(session);
      ctx.applyTierToolbar();
      ctx.setStatusText("选择备用方案");
      ctx.setOverlayState("error");

      const elements = ctx.getElements();
      if (elements.history) elements.history.hidden = true;
      if (!elements.target) return;
      elements.target.textContent = "";

      const wrap = window.LumeoCaptionFallbackChoice.create({
        reason,
        diagnostics,
        onMiniMax: () => this.startMiniMaxChoice(pipeline, ctx),
        onGroq: () => this.startGroqChoice(video, token, pipeline, reason, ctx),
        onSoniox: () => this.startSonioxChoice(video, token, pipeline, reason, ctx),
        onStandard: () => ctx.onSwitchToStandard(pipeline),
        onRetry: () => this.retryCaptionChoice(pipeline, ctx),
        onCancel: () => ctx.onSessionEnded("caption-fallback-cancel", "已取消字幕备用方案。"),
      });
      elements.target.appendChild(wrap);

      ctx.onStateChange({
        running: true,
        paused: false,
        status: "选择备用方案",
        errorMessage: "",
        errorCode: "missing-caption-track",
        missingProviders: ["minimax-dub", "soniox", "kyma"],
        slotsMissingKeys: [],
      });
    },

    async startMiniMaxChoice(pipeline, ctx) {
      const settings = ctx.getSettings();
      if (!settings.minimaxKey) {
        ctx.showToast("请在服务设置中填写 MiniMax API 密钥。", 7000);
        ctx.onStateChange({
          running: true,
          status: "填写 MiniMax 密钥",
          errorMessage: "",
          errorCode: "missing-caption-track",
          missingProviders: ["minimax-dub"],
          slotsMissingKeys: ["dubPipeline"],
        });
        ctx.onOpenPopup("dubPipeline");
        return;
      }
      await ctx.onSwitchToStandard(pipeline);
    },

    async startGroqChoice(video, token, pipeline, reason, ctx) {
      const settings = ctx.getSettings();
      if (!settings.groqApiKey) {
        ctx.showToast("请在无字幕备用方案中填写 Groq 密钥。", 7000);
        ctx.onStateChange({
          running: true,
          status: "填写 Groq 密钥",
          errorMessage: "",
          errorCode: "missing-caption-track",
          missingProviders: ["groq-whisper"],
          slotsMissingKeys: ["stt"],
        });
        ctx.onOpenPopup("stt");
        return;
      }
      const reply = await this.startCaptionGroqFallback(video, token, pipeline, reason, ctx);
      if (!reply?.ok) {
        ctx.showToast(reply?.error || "无法启动 Groq Whisper 语音识别。", 7000);
        ctx.onStateChange({ running: false, status: "Groq 出错", errorMessage: reply?.error || "Groq 出错" });
      }
    },

    async startSonioxChoice(video, token, pipeline, reason, ctx) {
      const settings = ctx.getSettings();
      if (!settings.sonioxApiKey) {
        ctx.showToast("请在弹窗中填写 Soniox 密钥。", 7000);
        ctx.onStateChange({
          running: true,
          status: "填写 Soniox 密钥",
          errorMessage: "",
          errorCode: "missing-caption-track",
          missingProviders: ["soniox"],
          slotsMissingKeys: ["stt"],
        });
        ctx.onOpenPopup("stt");
        return;
      }
      const reply = await this.startCaptionSonioxFallback(video, token, pipeline, reason, ctx);
      if (!reply?.ok) {
        ctx.showToast(reply?.error || "无法启动 Soniox 语音识别。", 7000);
        ctx.onStateChange({ running: false, status: "Soniox 出错", errorMessage: reply?.error || "Soniox 出错" });
      }
    },

    async retryCaptionChoice(pipeline, ctx) {
      pipeline.stop?.();
      ctx.onSessionCreated(null);
      const reply = await this.start(ctx);
      if (!reply?.ok) ctx.showToast(reply?.error || "重试失败。", 7000);
    },

    async startCaptionDomFallback(video, token, pipeline, reason, diagnostics, ctx) {
      const captionsEnabled = await this.enableYouTubeCaptions();
      if (token !== ctx.getPageToken()) return { ok: false, error: "会话已过期。" };

      const session = {
        token,
        type: "caption",
        liveDomCc: true,
        pipeline,
        captionTimer: null,
        lastCueIndex: -1,
        lastDomText: "",
        lastDomAt: Date.now(),
        cues: [],
        kymaKey: null,
        stream: null,
        pc: null,
        dc: null,
      };
      ctx.onSessionCreated(session);
      ctx.setCurrentTexts("", "");
      ctx.applyTierToolbar();
      ctx.applySourceVisibility();

      const transcript = ctx.getTranscriptController();
      transcript?.renderCaptionTranscript(session.cues);
      ctx.setStatusText(captionsEnabled ? "YouTube 字幕已开启" : "正在等待字幕");
      ctx.setOverlayState("connecting");
      ctx.setTargetText("正在等待 YouTube 字幕…");
      ctx.onStateChange({ running: true, paused: false, status: "正在显示 YouTube 字幕" });

      let translating = false;
      const startedAt = Date.now();
      const settings = ctx.getSettings();
      const elements = ctx.getElements();

      const tick = async () => {
        const currentSession = ctx.getSession();
        if (currentSession?.type !== "caption" || !currentSession.liveDomCc || currentSession.token !== token) return;
        const text = ctx.readYTCaptions();
        if (!text) {
          if (!currentSession.cues.length && Date.now() - startedAt > (captionsEnabled ? 9000 : 2500)) {
            if (settings.minimaxKey && settings.sttProvider === "minimax-asr") {
              ctx.onSwitchToStandard(pipeline);
              return;
            }
            this.renderCaptionFallbackChoice(
              video,
              token,
              pipeline,
              captionsEnabled
                ? `${reason} YouTube 字幕已开启，但画面上没有出现字幕。`
                : `${reason} YouTube 播放器显示字幕不可用。`,
              diagnostics,
              ctx
            );
          }
          return;
        }
        currentSession.lastDomAt = Date.now();
        if (text === currentSession.lastDomText || translating) return;
        currentSession.lastDomText = text;
        translating = true;
        const start = video.currentTime || 0;
        const cue = { start, end: start + 3, text, translated: text };
        try {
          cue.translated = await this.translateLiveCaptionLine(text, ctx);
        } catch {
          cue.translated = text;
        } finally {
          translating = false;
        }

        const latestSession = ctx.getSession();
        if (latestSession?.type !== "caption" || !latestSession.liveDomCc || latestSession.token !== token) return;
        cue.end = Math.max(video.currentTime || cue.end, cue.start + 1.5);
        latestSession.cues.push(cue);
        pipeline.cues = latestSession.cues;

        ctx.setCurrentTexts(cue.text, cue.translated);
        ctx.setTargetCue(cue);
        if (elements.source && settings.showSource) elements.source.textContent = cue.text.slice(-260);

        transcript?.appendCaptionRow(cue, latestSession.cues.length - 1);
        transcript?.updateCaptionTranscriptCount(latestSession.cues.length);
        transcript?.updateCaptionTranscriptHighlight(latestSession.cues.length - 1);

        if (settings.captionTtsProvider && settings.captionTtsProvider !== "off") {
          pipeline.speakCue(cue, {
            provider: settings.captionTtsProvider,
            targetLanguage: settings.targetLanguage || "zh-CN",
            googleCloudKey: settings.googleCloudKey,
            openaiKey: settings.openaiKey,
            minimaxKey: settings.minimaxKey,
            rate: settings.ttsRate || 1,
            volume: Math.min((settings.voiceVolume ?? 100) / 100, 1),
            syncDuration: Math.max(0.3, Number(cue.end) - Number(video.currentTime)),
          }).catch(() => { });
        }
        ctx.setStatusText("YouTube 字幕已开启");
        ctx.setOverlayState("live");
      };

      session.captionTimer = setInterval(() => { void tick(); }, 350);
      void tick();

      ctx.setYTPauseHandler(() => {
        window.LumeoTTS?.stop?.();
        session.lastCueIndex = -1;
        ctx.setStatusText("已暂停");
        ctx.setOverlayState("paused");
        ctx.onStateChange({ paused: true, status: "已暂停" });
      });
      ctx.setYTPlayHandler(() => {
        ctx.setStatusText("YouTube 字幕已开启");
        ctx.setOverlayState("live");
        ctx.onStateChange({ paused: false, status: "正在显示 YouTube 字幕" });
      });

      try { await video.play(); }
      catch {
        ctx.setStatusText("请点击视频播放，以读取 YouTube 字幕");
        ctx.setOverlayState("paused");
        ctx.onStateChange({ paused: true, status: "请点击视频播放" });
      }

      return { ok: true };
    },

    async startCaptionGroqFallback(video, token, pipeline, reason, ctx) {
      if (!window.LumeoGroqSTT) {
        ctx.removeOverlay();
        return { ok: false, error: "Groq 语音识别服务未加载。" };
      }
      ctx.setStatusText("Groq Whisper");
      ctx.setOverlayState("connecting");
      ctx.showToast(reason ? `${reason} 正在启动 Groq Whisper 语音识别。` : "正在启动 Groq Whisper 语音识别。", 5000);

      let stream;
      try {
        stream = await ctx.captureWithRetry(video);
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }

      const session = {
        token,
        type: "caption",
        liveStt: true,
        pipeline,
        captionTimer: null,
        lastCueIndex: -1,
        cues: [],
        kymaKey: null,
        stream,
        pc: null,
        dc: null,
        sttLoop: null,
      };
      ctx.onSessionCreated(session);
      ctx.applyTierToolbar();
      ctx.getTranscriptController()?.renderCaptionTranscript(session.cues);

      const settings = ctx.getSettings();
      try {
        const loop = window.LumeoGroqSTT.create({
          stream,
          apiKey: settings.groqApiKey,
          model: settings.groqSttModel || "whisper-large-v3-turbo",
          language: settings.sourceLanguage || "",
          onText: (result) => {
            void this.appendLiveSttCue(video, pipeline, result?.text || "", ctx);
          },
          onError: (err) => {
            ctx.setStatusText("Groq 出错");
            ctx.showToast(err?.message || "Groq Whisper 语音识别出错", 7000);
            ctx.onStateChange({ running: false, paused: false, status: "Groq 出错", errorMessage: err?.message || "Groq Whisper 语音识别出错" });
          },
        });
        session.sttLoop = loop;
        loop.start();
      } catch (err) {
        stream.getTracks().forEach((track) => track.stop());
        ctx.removeOverlay();
        return { ok: false, error: err?.message || String(err) };
      }

      ctx.setStatusText("Groq Whisper 实时识别中");
      ctx.setOverlayState("live");
      ctx.onStateChange({ running: true, paused: false, status: "正在显示 Groq 识别结果" });
      ctx.setYTPauseHandler(() => {
        session.sttLoop?.pause();
        window.LumeoTTS?.stop?.();
        ctx.setStatusText("已暂停");
        ctx.setOverlayState("paused");
        ctx.onStateChange({ paused: true, status: "已暂停" });
      });
      ctx.setYTPlayHandler(() => {
        session.sttLoop?.resume();
        ctx.setStatusText("Groq Whisper 实时识别中");
        ctx.setOverlayState("live");
        ctx.onStateChange({ paused: false, status: "正在显示 Groq 识别结果" });
      });
      try { await video.play(); }
      catch { session.sttLoop?.pause(); }
      return { ok: true };
    },

    async startCaptionSonioxFallback(video, token, pipeline, reason, ctx) {
      if (!window.LumeoSonioxSTT) {
        ctx.removeOverlay();
        return { ok: false, error: "Soniox 语音识别服务未加载。" };
      }
      ctx.setStatusText("Soniox 语音识别");
      ctx.setOverlayState("connecting");
      ctx.showToast(reason ? `${reason} 正在启动 Soniox 语音识别。` : "正在启动 Soniox 语音识别。", 5000);

      const session = {
        token,
        type: "caption",
        liveStt: true,
        pipeline,
        captionTimer: null,
        lastCueIndex: -1,
        cues: [],
        tokenBuffer: [],
        kymaKey: null,
        stream: null,
        pc: null,
        dc: null,
      };
      ctx.onSessionCreated(session);
      ctx.applyTierToolbar();
      ctx.getTranscriptController()?.renderCaptionTranscript(session.cues);

      const settings = ctx.getSettings();
      const elements = ctx.getElements();

      const flushBuffer = async () => {
        const currentSession = ctx.getSession();
        if (currentSession?.type !== "caption" || !currentSession.liveStt || !currentSession.tokenBuffer.length) return;
        const sourceText = currentSession.tokenBuffer.map((t) => t.text || "").join("").trim();
        currentSession.tokenBuffer = [];
        if (!sourceText) return;
        await this.appendLiveSttCue(video, pipeline, sourceText, ctx);
      };

      try {
        await window.LumeoSonioxSTT.start({
          apiKey: settings.sonioxApiKey,
          onStatus: (status) => {
            ctx.setStatusText(status === "connected" ? "Soniox 实时识别中" : status || "Soniox 语音识别");
            ctx.setOverlayState("live");
            ctx.onStateChange({ running: true, paused: false, status: "正在显示语音识别结果" });
          },
          onError: (error) => {
            ctx.setStatusText("Soniox 出错");
            ctx.showToast(error || "Soniox 出错", 7000);
            ctx.onStateChange({ running: false, paused: false, status: "Soniox 出错", errorMessage: error || "Soniox 出错" });
          },
          onResult: (data) => {
            const currentSession = ctx.getSession();
            if (!currentSession) return;
            if (data?.finished) {
              void flushBuffer();
              return;
            }
            const tokens = (data?.tokens || []).filter((t) => t?.text && !String(t.text).startsWith("<"));
            const finals = tokens.filter((t) => t.is_final);
            if (finals.length) currentSession.tokenBuffer.push(...finals);
            const interim = tokens.filter((t) => !t.is_final).map((t) => t.text).join("").trim();
            const finalText = currentSession.tokenBuffer.map((t) => t.text || "").join("").trim();
            const preview = (finalText + " " + interim).trim();
            if (preview) {
              ctx.setCurrentTexts(preview, ctx.getCurrentTexts().target);
              ctx.setTargetText(preview);
              if (elements.source && settings.showSource) elements.source.textContent = preview.slice(-260);
            }
            if (/[.!?。！？]$/.test(finalText) || finalText.length > 120) {
              void flushBuffer();
            }
          },
        });
      } catch (err) {
        ctx.removeOverlay();
        return { ok: false, error: err?.message || String(err) };
      }

      ctx.setStatusText("Soniox 实时识别中");
      ctx.setOverlayState("live");
      ctx.onStateChange({ running: true, paused: false, status: "正在显示语音识别结果" });
      ctx.setYTPauseHandler(() => {
        window.LumeoSonioxSTT.pause();
        session.tokenBuffer = [];
        window.LumeoTTS?.stop?.();
        ctx.setStatusText("已暂停");
        ctx.setOverlayState("paused");
        ctx.onStateChange({ paused: true, status: "已暂停" });
      });
      ctx.setYTPlayHandler(() => {
        window.LumeoSonioxSTT.resume();
        ctx.setStatusText("Soniox 实时识别中");
        ctx.setOverlayState("live");
        ctx.onStateChange({ paused: false, status: "正在显示语音识别结果" });
      });
      try { await video.play(); }
      catch { window.LumeoSonioxSTT.pause(); }
      return { ok: true };
    },

    updateCaptionProgress(progress = {}, ctx) {
      const completed = Number(progress.completed || 0);
      const total = Number(progress.total || 0);
      const suffix = total ? ` ${completed}/${total}` : "";
      let status;
      if (progress.phase === "cached") status = `字幕缓存${suffix}`;
      else if (progress.phase === "native") status = `原生字幕${suffix}`;
      else if (progress.phase === "translated") status = `已翻译字幕${suffix}`;
      else status = `正在翻译字幕${suffix}`;
      ctx.setStatusText(status);
      ctx.setTargetText(status);
      ctx.onStateChange({ running: true, paused: false, status });
    },

    createSpeechPrefetcher(pipeline, video, settings) {
      if (settings.captionTtsProvider !== "minimax-tts" || !settings.minimaxKey || !window.LumeoMiniMax?.prefetch) {
        return { tick() {}, pause() {}, resume() {}, stop() {} };
      }
      const requested = new Set();
      const controllers = new Map();
      let active = 0;
      let stopped = false;
      let paused = !!video.paused;
      const tick = () => {
        if (stopped || paused || video.paused) return;
        const time = Number(video.currentTime || 0);
        for (const [index, controller] of controllers) {
          const cue = pipeline.cues[index];
          if (!cue || cue.end < time - 5 || cue.start > time + 45) controller.abort();
        }
        if (active >= 2) return;
        const upcoming = [];
        for (let index = 0; index < pipeline.cues.length; index += 1) {
          const cue = pipeline.cues[index];
          if (cue?.start > time + 24) break;
          if (cue?.translated && cue.end >= time) upcoming.push({ cue, index });
          if (upcoming.length >= 8) break;
        }
        for (const { cue, index } of upcoming) {
          if (active >= 2) break;
          if (requested.has(index)) continue;
          requested.add(index);
          active += 1;
          const controller = new AbortController();
          controllers.set(index, controller);
          Promise.resolve().then(() => window.LumeoMiniMax.prefetch(cue.translated, {
            apiKey: settings.minimaxKey,
            voice: settings.minimaxVoice || "male-qn-qingse",
            speed: settings.ttsRate || 1,
            signal: controller.signal,
          })).catch(() => {
            if (controller.signal.aborted) requested.delete(index);
          }).finally(() => {
            controllers.delete(index);
            active -= 1;
            if (!stopped && !paused) tick();
          });
        }
      };
      return {
        tick,
        pause() {
          paused = true;
          for (const controller of controllers.values()) controller.abort();
        },
        resume() {
          if (stopped) return;
          paused = false;
          tick();
        },
        stop() {
          stopped = true;
          for (const controller of controllers.values()) controller.abort();
          controllers.clear();
        },
      };
    },

    async start(ctx) {
      const video = ctx.getVideo();
      if (!video) return { ok: false, error: "当前页面没有 YouTube 视频。" };
      video.pause();

      ctx.buildOverlay();
      ctx.setStatusText("正在加载字幕");
      ctx.setTargetText("正在加载字幕…");
      ctx.setOverlayState("connecting");
      ctx.applyTierToolbar();
      ctx.applySourceVisibility();
      ctx.onStateChange({ running: true, paused: false, status: "正在加载字幕" });

      const token = ctx.getPageToken();
      const missingDeps = this.missingCaptionDependencies();
      if (missingDeps.length) {
        return {
          ok: false,
          error: `字幕组件未加载：${missingDeps.join("、")}。请重新加载扩展和当前 YouTube 标签页。`,
        };
      }

      const pipeline = window.LumeoCaptionPipeline.create();
      const settings = ctx.getSettings();

      let result;
      try {
        result = await pipeline.start({
          targetLanguage: settings.targetLanguage || "zh-CN",
          targetLanguageName: ctx.getLangName(settings.targetLanguage) || settings.targetLanguage || "Chinese (Simplified)",
          translateProvider: settings.translateProvider || "google-free",
          openaiKey: settings.openaiKey,
          openaiModel: settings.openaiModel,
          geminiKey: settings.geminiKey,
          geminiModel: settings.geminiModel,
          openRouterKey: settings.openRouterKey,
          openRouterModel: settings.openRouterModel,
          groqApiKey: settings.groqApiKey,
          groqModel: settings.groqModel,
          minimaxKey: settings.minimaxKey,
          googleCloudKey: settings.googleCloudKey,
          libreTranslateUrl: settings.libreTranslateUrl,
          libreTranslateKey: settings.libreTranslateKey,
          context: settings.translationContext,
          progressive: true,
          playheadSeconds: video.currentTime,
          onProgress: (p) => {
            if (ctx.getSession()?.type === "caption") return;
            this.updateCaptionProgress(p, ctx);
          },
          onCueUpdate: () => {
            const currentSession = ctx.getSession();
            if (currentSession?.type !== "caption" || currentSession.token !== token) return;
            currentSession.lastCueIndex = -1;
            ctx.getTranscriptController()?.renderCaptionTranscript(pipeline.cues);
            currentSession.speechPrefetcher?.tick();
          },
          onBackgroundError: (error) => {
            if (ctx.getSession()?.type === "caption") ctx.showToast(`后续字幕翻译中断：${error.message}`, 7000);
          },
        });
      } catch (err) {
        ctx.removeOverlay();
        return { ok: false, error: err?.message || String(err) };
      }

      if (token !== ctx.getPageToken()) {
        pipeline.stop();
        ctx.removeOverlay();
        return { ok: false, error: "字幕加载前已取消。" };
      }

      if (!result?.ok) {
        return this.startCaptionDomFallback(
          video,
          token,
          pipeline,
          result?.error || "无法加载字幕。",
          result?.diagnostics,
          ctx
        );
      }

      const session = {
        token,
        type: "caption",
        pipeline,
        captionTimer: null,
        lastCueIndex: -1,
        kymaKey: null,
        stream: null,
        pc: null,
        dc: null,
        readyCues: new Set(),
        bufferingCueIndex: null,
        ignoreNextPause: false,
      };
      session.speechPrefetcher = this.createSpeechPrefetcher(pipeline, video, settings);
      session.startupSpeechController = new AbortController();
      session.prefetchStop = () => {
        session.startupSpeechController.abort();
        session.speechPrefetcher.stop();
      };
      ctx.onSessionCreated(session);
      ctx.setCurrentTexts("", "");

      const firstSpokenCueIndex = pipeline.cues.findIndex((cue) =>
        cue?.translated && cue.end > video.currentTime && cue.start < video.currentTime + 24
      );
      const firstSpokenCue = pipeline.cues[firstSpokenCueIndex];
      if (firstSpokenCue && settings.captionTtsProvider === "minimax-tts" && settings.minimaxKey) {
        ctx.setStatusText("正在准备首段中文朗读");
        ctx.setOverlayState("connecting");
        try {
          await window.LumeoMiniMax.prefetch(firstSpokenCue.translated, {
            apiKey: settings.minimaxKey,
            voice: settings.minimaxVoice || "male-qn-qingse",
            speed: settings.ttsRate || 1,
            signal: session.startupSpeechController.signal,
          });
          session.readyCues.add(firstSpokenCueIndex);
        } catch (error) {
          if (token !== ctx.getPageToken()) return { ok: false, error: "启动已取消。" };
          ctx.onSessionEnded("speech-preparation-failed", error?.message || "中文朗读准备失败。");
          return { ok: false, error: error?.message || "中文朗读准备失败。" };
        }
      }
      if (token !== ctx.getPageToken()) return { ok: false, error: "启动已取消。" };

      ctx.setStatusText(window.LumeoCaptionPipeline.describeCaptionQuality?.(result.meta) || (result.meta?.nativeTarget ? "原生字幕" : "免费字幕"));
      ctx.setOverlayState("live");
      ctx.getTranscriptController()?.renderCaptionTranscript(result.cues || pipeline.cues || []);
      ctx.applyTierToolbar();
      ctx.onStateChange({ running: true, paused: false, status: "正在显示字幕" });

      const elements = ctx.getElements();

      const tick = () => {
        const currentSession = ctx.getSession();
        if (currentSession?.type !== "caption" || currentSession.token !== token) return;
        currentSession.speechPrefetcher.tick();
        const current = pipeline.cueAt(video.currentTime);
        if (current.index === currentSession.lastCueIndex) return;
        currentSession.lastCueIndex = current.index;

        if (!current.cue) {
          ctx.setCurrentTexts("", "");
          ctx.setTargetCue(null);
          if (elements.source) elements.source.textContent = "";
          ctx.getTranscriptController()?.updateCaptionTranscriptHighlight(-1);
          return;
        }

        const sourceText = current.cue.text;
        const targetText = current.cue.translated || current.cue.text;
        ctx.setCurrentTexts(sourceText, targetText);
        ctx.setTargetCue(current.cue);

        if (elements.source && settings.showSource) {
          elements.source.textContent = sourceText.slice(-260);
        }
        ctx.getTranscriptController()?.updateCaptionTranscriptHighlight(current.index);

        if (settings.captionTtsProvider === "minimax-tts" && settings.minimaxKey &&
            window.LumeoMiniMax.isCached?.(current.cue.translated, {
              apiKey: settings.minimaxKey,
              voice: settings.minimaxVoice || "male-qn-qingse",
              speed: settings.ttsRate || 1,
            })) currentSession.readyCues.add(current.index);

        if (settings.captionTtsProvider === "minimax-tts" && settings.minimaxKey &&
            !video.paused && !currentSession.readyCues.has(current.index)) {
          currentSession.bufferingCueIndex = current.index;
          currentSession.ignoreNextPause = true;
          video.pause();
          ctx.setStatusText("正在同步这一句的中文语音");
          ctx.setOverlayState("connecting");
          Promise.resolve().then(async () => {
            const deadline = Date.now() + 20000;
            while (!current.cue.translated && Date.now() < deadline) {
              if (currentSession.startupSpeechController.signal.aborted) return;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (!current.cue.translated) throw new Error("这句字幕翻译超时，请稍后重试。");
            await window.LumeoMiniMax.prefetch(current.cue.translated, {
              apiKey: settings.minimaxKey,
              voice: settings.minimaxVoice || "male-qn-qingse",
              speed: settings.ttsRate || 1,
              signal: currentSession.startupSpeechController.signal,
            });
          }).then(async () => {
            if (ctx.getSession() !== currentSession || currentSession.token !== ctx.getPageToken()) return;
            currentSession.readyCues.add(current.index);
            currentSession.bufferingCueIndex = null;
            currentSession.lastCueIndex = -1;
            if (pipeline.cueAt(video.currentTime).index === current.index) await video.play();
            else tick();
          }).catch((error) => {
            if (ctx.getSession() !== currentSession || currentSession.token !== ctx.getPageToken()) return;
            currentSession.bufferingCueIndex = null;
            ctx.setStatusText(error?.message || "中文语音准备失败");
            ctx.setOverlayState("error");
          });
          return;
        }

        if (!video.paused && settings.captionTtsProvider && settings.captionTtsProvider !== "off") {
          pipeline.speakCue(current.cue, {
            provider: settings.captionTtsProvider,
            targetLanguage: settings.targetLanguage || "zh-CN",
            googleCloudKey: settings.googleCloudKey,
            openaiKey: settings.openaiKey,
            minimaxKey: settings.minimaxKey,
            rate: settings.ttsRate || 1,
            volume: Math.min((settings.voiceVolume ?? 100) / 100, 1),
            syncDuration: Math.max(0.3, Number(current.cue.end) - Number(video.currentTime)),
          }).catch(() => { });
        }
      };

      session.captionTimer = setInterval(tick, 120);
      tick();

      ctx.setYTPauseHandler(() => {
        if (session.ignoreNextPause) {
          session.ignoreNextPause = false;
          return;
        }
        if (session.bufferingCueIndex !== null) return;
        session.speechPrefetcher.pause();
        window.LumeoTTS?.stop?.();
        session.lastCueIndex = -1;
        ctx.setStatusText("已暂停");
        ctx.setOverlayState("paused");
        ctx.onStateChange({ paused: true, status: "已暂停" });
      });
      ctx.setYTPlayHandler(() => {
        if (session.bufferingCueIndex !== null) {
          session.ignoreNextPause = !video.paused;
          video.pause();
          return;
        }
        session.speechPrefetcher.resume();
        session.lastCueIndex = -1;
        tick();
        ctx.setStatusText("正在显示字幕");
        ctx.setOverlayState("live");
        ctx.onStateChange({ paused: false, status: "正在显示字幕" });
      });
      try {
        await video.play();
      } catch {
        ctx.setStatusText("译声已准备，请点击视频播放");
        ctx.setOverlayState("paused");
        ctx.onStateChange({ paused: true, status: "请点击视频播放" });
      }
      return { ok: true };
    }
  };
})();
