import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const BASE = "https://api.minimax.cn/v1";

async function checked(response, stage) {
  const body = await response.text();
  if (!response.ok) throw new Error(`MiniMax ${stage}失败：HTTP ${response.status} ${body.slice(0, 160)}`);
  return body;
}

export async function transcribeSrt(wavPath, apiKey, { signal, fetchFn = fetch } = {}) {
  const form = new FormData();
  form.append("model", "asr-1.0");
  form.append("response_format", "srt");
  form.append("timestamp_level", "sentence");
  form.append("file", new Blob([await readFile(wavPath)], { type: "audio/wav" }), "segment.wav");
  const response = await fetchFn(`${BASE}/speech_to_text`, {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal,
  });
  return checked(response, "识别");
}

export async function transcribeWords(wavPath, apiKey, { signal, fetchFn = fetch } = {}) {
  const form = new FormData();
  form.append("model", "asr-1.0");
  form.append("response_format", "verbose_json");
  form.append("timestamp_level", "word");
  form.append("file", new Blob([await readFile(wavPath)], { type: "audio/wav" }), "segment.wav");
  const response = await fetchFn(`${BASE}/speech_to_text`, {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal,
  });
  const data = JSON.parse(await checked(response, "识别"));
  if (!Array.isArray(data?.segments)) throw new Error("MiniMax 没有返回词级时间戳。");
  return data.segments;
}

export function parseTranslationArray(raw, count) {
  const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("MiniMax 翻译没有返回 JSON 数组。");
  const items = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(items) || items.length !== count || items.some((item) => typeof item !== "string")) {
    throw new Error("MiniMax 翻译句数与原文不一致。");
  }
  return items.map((item) => item.trim());
}

export function parseIndexedTranslations(raw, count) {
  const result = Array(count).fill("");
  let current = -1;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const match = line.match(/^\s*\[(\d+)\]\s*(.*)$/);
    if (match) {
      current = Number(match[1]);
      if (current < count) result[current] = match[2].trim();
    } else if (current >= 0 && current < count && line.trim()) {
      result[current] = `${result[current]} ${line.trim()}`.trim();
    }
  }
  return result;
}

async function chatCompletion(messages, apiKey, { signal, fetchFn }) {
  const response = await fetchFn(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "MiniMax-M3",
      temperature: 0.2,
      thinking: { type: "disabled" }, reasoning_split: true,
      messages,
    }),
    signal,
  });
  const data = JSON.parse(await checked(response, "翻译"));
  if (Number(data?.base_resp?.status_code || 0) !== 0) throw new Error(`MiniMax 翻译失败：${data.base_resp.status_msg}`);
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

export async function translateBatch(texts, apiKey, { signal, fetchFn = fetch } = {}) {
  if (!texts.length) return [];
  const raw = await chatCompletion([
    { role: "system", content: "将每一行准确翻译成简体中文，尽量简洁以适配配音时长。保留每行开头的 [数字] 编号，每个编号恰好输出一次；不要使用 JSON、引号、代码块或解释。" },
    { role: "user", content: texts.map((value, index) => `[${index}] ${String(value).replace(/\s+/g, " ").trim()}`).join("\n") },
  ], apiKey, { signal, fetchFn });
  let translations = parseIndexedTranslations(raw, texts.length);
  if (translations.some((value) => !value)) {
    try {
      translations = parseTranslationArray(raw, texts.length);
    } catch {
      for (let index = 0; index < texts.length; index += 1) {
        if (translations[index]) continue;
        const single = await chatCompletion([
          { role: "system", content: "只将用户内容翻译成简体中文，尽量简洁。只输出译文，不加编号、引号或解释。" },
          { role: "user", content: texts[index] },
        ], apiKey, { signal, fetchFn });
        translations[index] = single.replace(/^```(?:text)?\s*/i, "").replace(/\s*```$/, "").trim();
        if (!translations[index]) throw new Error(`MiniMax 第 ${index + 1} 句翻译为空，请重试。`);
      }
    }
  }
  return translations;
}

export async function synthesizeSpeech(text, apiKey, voice, {
  signal, fetchFn = fetch, retryDelayMs = 1500, rateLimitDelayMs = 60_000,
  timeoutMs = 90_000, onRetry = () => {}, withTimings = false,
} = {}) {
  const body = JSON.stringify({
    model: "speech-2.8-turbo", text, stream: false, output_format: "hex",
    ...(withTimings ? { subtitle_enable: true, subtitle_type: "word" } : {}),
    voice_setting: { voice_id: voice || "male-qn-qingse", speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
  });
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetchFn(`${BASE}/t2a_v2`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`MiniMax 语音合成连接失败或超时：${error?.message || String(error)}`);
    }
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    const providerMessage = String(data?.base_resp?.status_msg || "");
    const rateLimited = response.status === 429 || /rate limit exceeded\s*\(RPM\)/i.test(providerMessage);
    const temporaryFailure = [500, 502, 503, 504].includes(response.status);
    if (!rateLimited && !temporaryFailure) {
      if (!response.ok) throw new Error(`MiniMax 语音合成失败：HTTP ${response.status} ${raw.slice(0, 160)}`);
      if (Number(data?.base_resp?.status_code || 0) !== 0) throw new Error(`MiniMax 语音合成失败：${providerMessage}`);
      const hex = data?.data?.audio;
      if (typeof hex !== "string" || !hex.length || hex.length % 2 || /[^0-9a-f]/i.test(hex)) {
        throw new Error("MiniMax 没有返回有效语音。");
      }
      const audio = Buffer.from(hex, "hex");
      if (!withTimings) return audio;
      let subtitles = [];
      if (data?.data?.subtitle_file) {
        const url = new URL(data.data.subtitle_file);
        const allowed = url.protocol === "https:" && ["aliyuncs.com", "minimax.cn", "minimaxi.com", "minimax.io"]
          .some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
        if (!allowed) throw new Error("MiniMax 返回的字幕下载地址不受信任。");
        const subtitleResponse = await fetchFn(url, { signal, redirect: "error" });
        if (!subtitleResponse.ok) throw new Error(`MiniMax 配音时间戳下载失败：HTTP ${subtitleResponse.status}`);
        const parsed = await subtitleResponse.json();
        if (Array.isArray(parsed)) subtitles = parsed;
      }
      return { audio, subtitles, durationSeconds: Number(data?.extra_info?.audio_length) / 1000 || 0 };
    }
    if (attempt === 2) {
      throw new Error(rateLimited
        ? `MiniMax 语音合成达到每分钟请求上限，等待重试后仍受限：${providerMessage || `HTTP ${response.status}`}`
        : `MiniMax 语音合成失败：HTTP ${response.status} ${raw.slice(0, 160)}`);
    }
    const waitMs = rateLimited ? rateLimitDelayMs : retryDelayMs * 2 ** attempt;
    onRetry({ reason: rateLimited ? "rate-limit" : "temporary-error", attempt: attempt + 1, maxAttempts: 3, waitMs });
    await delay(waitMs, undefined, { signal });
  }
  throw new Error("MiniMax 语音合成未返回结果。");
}
