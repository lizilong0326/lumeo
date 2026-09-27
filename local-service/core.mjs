export const SEGMENT_SECONDS = 300;
export const MAX_AHEAD = 3;

export function youtubeVideoId(input) {
  let url;
  try { url = new URL(String(input || "").trim()); }
  catch { throw new Error("请输入有效的 YouTube 视频链接。"); }
  if (url.protocol !== "https:") throw new Error("只支持 YouTube HTTPS 链接。");
  const host = url.hostname.toLowerCase();
  let id = "";
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
    else if (/^\/(shorts|live|embed)\//.test(url.pathname)) id = url.pathname.split("/")[2] || "";
  } else if (host === "youtu.be" || host === "www.youtu.be") {
    id = url.pathname.split("/")[1] || "";
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("链接中没有有效的 YouTube 视频 ID。");
  return id;
}

export function planSegments(duration, seconds = SEGMENT_SECONDS) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法获取视频时长，暂不支持直播。");
  return Array.from({ length: Math.ceil(duration / seconds) }, (_, index) => ({
    index,
    start: index * seconds,
    end: Math.min(duration, (index + 1) * seconds),
    status: "pending",
    step: "待处理",
    cues: [],
    error: "",
  }));
}

function parseTime(value) {
  const parts = String(value || "").replace(",", ".").split(":");
  if (parts.length !== 3) return NaN;
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
}

export function parseSrt(source, offset = 0, end = Infinity) {
  const cues = [];
  for (const block of String(source || "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const match = lines[timingIndex].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!match) continue;
    const start = offset + parseTime(match[1]);
    const cueEnd = Math.min(end, offset + parseTime(match[2]));
    const text = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (text && Number.isFinite(start) && cueEnd > start && start < end) cues.push({ start, end: cueEnd, text });
  }
  return cues;
}

export class SegmentQueue {
  constructor({ duration, processSegment, onChange = () => {}, maxAhead = MAX_AHEAD }) {
    this.segments = planSegments(duration);
    this.processSegment = processSegment;
    this.onChange = onChange;
    this.maxAhead = maxAhead;
    this.currentIndex = 0;
    this.running = null;
    this.closed = false;
    this.blocked = false;
  }

  snapshot() {
    return {
      currentIndex: this.currentIndex,
      maxAhead: this.maxAhead,
      blocked: this.blocked,
      segments: this.segments.map((segment) => ({ ...segment, cues: segment.cues.map((cue) => ({ ...cue })) })),
    };
  }

  setPlayhead(seconds) {
    if (this.closed) return;
    const index = Math.max(0, Math.min(this.segments.length - 1, Math.floor(Math.max(0, Number(seconds) || 0) / SEGMENT_SECONDS)));
    this.currentIndex = index;
    if (this.running && (this.running.index < index || this.running.index > index + this.maxAhead)) {
      this.running.controller.abort();
    }
    this.onChange(this.snapshot());
    this.schedule();
  }

  retry(index) {
    if (this.closed) return false;
    const segment = this.segments[index];
    if (!segment || segment.status !== "failed") return false;
    segment.status = "pending";
    segment.error = "";
    segment.step = "待处理";
    this.blocked = false;
    this.onChange(this.snapshot());
    this.schedule();
    return true;
  }

  schedule() {
    if (this.closed || this.blocked || this.running) return;
    const candidates = this.segments.slice(this.currentIndex, this.currentIndex + this.maxAhead + 1);
    const segment = candidates.find((item) => item.status === "pending");
    if (!segment) return;
    const controller = new AbortController();
    this.running = { index: segment.index, controller };
    segment.status = "running";
    segment.step = "准备音频";
    this.onChange(this.snapshot());
    const update = (step) => {
      if (this.closed || controller.signal.aborted) return;
      segment.step = step;
      this.onChange(this.snapshot());
    };
    Promise.resolve().then(() => this.processSegment(segment, { signal: controller.signal, update }))
      .then((cues) => {
        if (controller.signal.aborted || this.closed) {
          segment.status = "pending";
          segment.step = "待处理";
          return;
        }
        segment.cues = cues || [];
        segment.status = "ready";
        segment.step = "可播放";
      })
      .catch((error) => {
        if (controller.signal.aborted || this.closed) {
          segment.status = "pending";
          segment.step = "待处理";
          return;
        }
        segment.status = "failed";
        segment.error = error?.message || "片段处理失败";
        segment.step = "处理失败";
        this.blocked = true;
      })
      .finally(() => {
        if (this.running?.controller === controller) this.running = null;
        this.onChange(this.snapshot());
        this.schedule();
      });
  }

  close() {
    this.closed = true;
    this.running?.controller.abort();
  }
}
