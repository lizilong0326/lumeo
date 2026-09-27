// Keep the video's cue timeline while asking the voice service to read several nearby cues at once.
export function planSpeechGroups(tasks, { maxCues = 8, maxSpan = 45, maxGap = 1.2, maxChars = 900 } = {}) {
  const groups = [];
  let group = null;
  for (const [index, task] of tasks.entries()) {
    const text = String(task.cue.translated || "").trim();
    if (!text) throw new Error(`第 ${index + 1} 条字幕没有可配音的译文。`);
    const previous = group?.tasks.at(-1)?.cue;
    if (!group || group.tasks.length >= maxCues || task.cue.end - group.tasks[0].cue.start > maxSpan ||
      task.cue.start - previous.end > maxGap || group.text.length + text.length + 1 > maxChars) {
      group = { index: groups.length, firstIndex: index, tasks: [], text: "" };
      groups.push(group);
    }
    group.tasks.push(task);
    group.text += `${group.text ? "\n" : ""}${text}`;
  }
  return groups;
}

function spokenLength(text) {
  return Math.max(1, Array.from(String(text || "").normalize("NFKC").replace(/[\p{P}\p{S}\s]/gu, "")).length);
}

// MiniMax timestamps are relative to the generated audio, in milliseconds.
// Translate original cue boundaries to that audio using cumulative spoken characters.
export function speechOffsets(texts, subtitles, durationSeconds) {
  const total = Math.max(0.05, Number(durationSeconds) || 0);
  const lengths = texts.map(spokenLength);
  const textTotal = lengths.reduce((sum, length) => sum + length, 0);
  const words = Array.isArray(subtitles) ? subtitles.filter((item) =>
    Number.isFinite(Number(item.time_begin)) && Number.isFinite(Number(item.time_end)) &&
    Number(item.time_end) > Number(item.time_begin)) : [];
  const wordTotal = words.reduce((sum, item) => sum + spokenLength(item.text), 0);
  function at(fraction) {
    if (!words.length || !wordTotal) return total * fraction;
    const position = fraction * wordTotal;
    let seen = 0;
    for (const item of words) {
      const length = spokenLength(item.text);
      if (position <= seen + length) {
        const share = Math.max(0, Math.min(1, (position - seen) / length));
        return Math.max(0, Math.min(total, (Number(item.time_begin) +
          (Number(item.time_end) - Number(item.time_begin)) * share) / 1000));
      }
      seen += length;
    }
    return total;
  }
  let seen = 0;
  return lengths.map((length, index) => {
    const start = index === 0 ? 0 : at(seen / textTotal);
    seen += length;
    const end = index === lengths.length - 1 ? total : at(seen / textTotal);
    return { start: Math.max(0, Math.min(total, start)), end: Math.max(start, Math.min(total, end)) };
  });
}
