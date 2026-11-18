export function epochMs(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function formatClock(ms) {
  if (ms == null) return "";
  const date = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${p(m)}:${p(s)}`;
  return `${m}:${p(s)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function stateLabel(state, replay) {
  if (state === "Running") return "直播中";
  if (state === "NotStarted") return "未开始";
  if (state === "Ended" || state === "TimedOut") {
    return replay ? "已结束 · 有回放" : "已结束 · 无回放";
  }
  return state || "未知状态";
}

export function fileBase(info) {
  const when = info.startedAt ? new Date(info.startedAt) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  const date = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
  const who = info.handle ? `@${info.handle}` : (info.creatorName || "space");
  const title = info.title || info.spaceId || "space";
  return sanitize(`${date} ${who} ${title}`).slice(0, 120);
}

export function sanitize(value) {
  return String(value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "space";
}

export function audioSaveName(filename, mime = "") {
  const audio = /audio\/(mp4|x-m4a|m4a)/i.test(mime) || /\.m4a$/i.test(filename);
  if (!audio) return filename;
  return String(filename).replace(/\.(mp4|m4a)$/i, "") + ".m4a";
}

export function baseNameOf(path) {
  if (!path) return "";
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
