import { createHash } from "node:crypto";

export function normalizeCues(input, duration) {
  if (!Array.isArray(input) || input.length > 20_000) throw new Error("字幕数量无效。");
  const limit = Number(duration);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("视频时长无效。");
  const cues = input.map((cue) => ({
    start: Number(cue?.start),
    end: Number(cue?.end),
    text: String(cue?.text || "").replace(/\s+/g, " ").trim(),
  })).filter((cue) =>
    Number.isFinite(cue.start) && Number.isFinite(cue.end) &&
    cue.start >= 0 && cue.end > cue.start && cue.start < limit && cue.text && cue.text.length <= 800
  ).map((cue) => ({ ...cue, end: Math.min(cue.end, limit) }));
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function joinWord(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  if (/^\s/.test(next) || /\s$/.test(previous)) return previous + next;
  if (/^[,.;:!?，。！？；：、]/u.test(next)) return previous + next;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(previous) ||
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(next)) return previous + next;
  return `${previous} ${next}`;
}

export function groupWordSegments(segments, offset = 0, end = Infinity) {
  if (!Array.isArray(segments)) throw new Error("识别结果缺少词级时间戳。");
  const words = segments.map((part) => ({
    start: offset + Number(part?.start),
    end: offset + Number(part?.end),
    text: String(part?.text || ""),
    speaker: part?.speaker ?? null,
  })).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) &&
    word.end > word.start && word.start < end && word.text.trim());
  words.sort((a, b) => a.start - b.start);
  const cues = [];
  let current = null;
  const flush = () => {
    if (current?.text.trim()) cues.push({ start: current.start, end: Math.min(current.end, end), text: current.text.trim() });
    current = null;
  };
  for (const word of words) {
    if (current && (word.start - current.end > 1.2 || word.end - current.start > 6 ||
        current.text.length + word.text.length > 72 ||
        (current.speaker !== null && word.speaker !== null && current.speaker !== word.speaker))) flush();
    if (!current) current = { ...word };
    else {
      current.text = joinWord(current.text, word.text);
      current.end = Math.max(current.end, word.end);
    }
    if (/[.!?。！？]$/u.test(current.text) && current.end - current.start >= 1.5) flush();
  }
  flush();
  return normalizeCues(cues, end);
}

export function sourceHash(videoId, cues) {
  return createHash("sha256").update(JSON.stringify([videoId, cues])).digest("hex").slice(0, 20);
}

export function segmentCues(cues, segments) {
  for (const segment of segments) segment.cues = [];
  for (const cue of cues) {
    const index = Math.min(segments.length - 1, Math.floor(cue.start / 300));
    if (index >= 0) segments[index].cues.push({ ...cue });
  }
  return segments;
}
