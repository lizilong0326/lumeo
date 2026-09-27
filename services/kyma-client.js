(() => {
  "use strict";

  if (window.LumeoKyma?.__loaded) return;

  const KYMA_BASE = "https://api.kymaapi.com/v1";

  function parseError(status, errText) {
    try {
      const parsed = JSON.parse(errText);
      const err = parsed.error || {};
      if (err.code === "insufficient_balance") {
        return {
          user: "Kyma 余额不足。",
          cta: err.cta_url || "https://kymaapi.com/billing",
          ctaLabel: "去充值",
        };
      }
      if (err.code === "too_many_sessions") {
        return { user: "Kyma 会话数已达上限，请先停止另一段译幕配音后重试。" };
      }
      if (err.code === "upstream_error") {
        return { user: "Kyma 服务暂不可用，请稍后重试。" };
      }
      if (err.code === "rate_limited") {
        return { user: "Kyma 请求过于频繁，请等待 30 秒后重试。" };
      }
      if (err.message) return { user: `Kyma 错误 ${status}：${err.message}。请检查密钥和会话后重试。` };
    } catch {
      // Fall through to raw text.
    }
    return { user: `Kyma 错误 ${status}：${(errText || "").slice(0, 160)}。请检查密钥和会话后重试。` };
  }

  async function post(path, kymaKey, options = {}) {
    const response = await fetch(`${KYMA_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${kymaKey}`,
        ...(options.json ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      body: options.json ? JSON.stringify(options.json) : options.body,
      keepalive: !!options.keepalive,
      signal: options.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const parsed = parseError(response.status, text);
      const error = new Error(parsed.user);
      error.cta = parsed.cta;
      error.ctaLabel = parsed.ctaLabel;
      error.status = response.status;
      throw error;
    }
    return options.raw ? response : response.json().catch(() => ({}));
  }

  function heartbeat(sessionId, kymaKey) {
    if (!sessionId || !kymaKey) return Promise.resolve();
    return post(`/realtime/translations/sessions/${sessionId}/heartbeat`, kymaKey)
      .catch(() => {});
  }

  function endSession(sessionId, kymaKey) {
    if (!sessionId || !kymaKey) return Promise.resolve();
    return post(`/realtime/translations/sessions/${sessionId}/end`, kymaKey, { keepalive: true })
      .catch(() => {});
  }

  window.LumeoKyma = {
    __loaded: true,
    KYMA_BASE,
    parseError,
    post,
    heartbeat,
    endSession,
  };
})();
