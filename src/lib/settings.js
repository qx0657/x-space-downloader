import { DEFAULT_FOLDER, DEFAULT_TEMPLATE, sanitizeFolder } from "./format.js";

export const DEFAULT_SETTINGS = Object.freeze({
  folder: DEFAULT_FOLDER,
  template: DEFAULT_TEMPLATE,
  showPanel: true,
  maxConcurrency: 0,
  videoFormat: "mp4",
  embedMetadata: true,
});

export function normalizeSettings(raw = {}) {
  const value = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const concurrency = Math.round(Number(value.maxConcurrency));
  return {
    folder: sanitizeFolder(value.folder),
    template: String(value.template || "").trim() || DEFAULT_TEMPLATE,
    showPanel: value.showPanel !== false,
    maxConcurrency: Number.isFinite(concurrency) ? Math.max(0, Math.min(32, concurrency)) : 0,
    videoFormat: value.videoFormat === "ts" ? "ts" : "mp4",
    embedMetadata: value.embedMetadata !== false,
  };
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return normalizeSettings(stored.settings);
}

export async function saveSettings(patch) {
  const next = normalizeSettings({ ...(await getSettings()), ...patch });
  await chrome.storage.sync.set({ settings: next });
  return next;
}
