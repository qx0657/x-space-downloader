import { t } from "./i18n.js";

export const DEFAULT_TEMPLATE = "{date} {handle} {title}";
export const DEFAULT_FOLDER = "X-Spaces";

const pad = (n) => String(n).padStart(2, "0");

export function epochMs(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function formatClock(ms) {
  if (ms == null) return "";
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function stateLabel(state, replay) {
  if (state === "Running") return t("stateRunning");
  if (state === "NotStarted") return t("stateNotStarted");
  if (state === "Ended" || state === "TimedOut") {
    return replay ? t("stateEndedReplay") : t("stateEndedNoReplay");
  }
  return state || t("stateUnknown");
}

export function progressPercent(job) {
  if (!job?.total) return 0;
  if (job.phase === "done") return 100;
  const completed = job.completed || 0;
  if (!completed) return 0;
  return Math.max(1, Math.min(99, Math.round((100 * completed) / job.total)));
}

export function fileBase(info, template = DEFAULT_TEMPLATE) {
  const when = info.startedAt ? new Date(info.startedAt) : new Date();
  const values = {
    date: `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
    time: `${pad(when.getHours())}${pad(when.getMinutes())}`,
    handle: info.handle ? `@${info.handle}` : info.creatorName || "",
    name: info.creatorName || "",
    title: info.title || "",
    id: info.spaceId || "",
  };
  const text = String(template || DEFAULT_TEMPLATE).replace(/\{(\w+)\}/g, (match, key) =>
    key in values ? values[key] : match,
  );
  const name = sanitize(text, "").slice(0, 120).trim();
  return name || sanitize(info.spaceId || "space");
}

export function sanitize(value, fallback = "space") {
  return (
    String(value)
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "") || fallback
  );
}

export function sanitizeFolder(folder) {
  const parts = String(folder ?? "")
    .split(/[\\/]+/)
    .map((part) => sanitize(part, ""))
    .filter((part) => part && part !== "." && part !== "..");
  return parts.join("/");
}

export function baseNameOf(path) {
  if (!path) return "";
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
