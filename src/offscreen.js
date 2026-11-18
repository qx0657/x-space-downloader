import { asSpaceError, SpaceError } from "./lib/errors.js";
import { deviceConcurrency, downloadRecording } from "./lib/hls.js";
import { t } from "./lib/i18n.js";
import { fetchWithTimeout, isAllowedMediaUrl } from "./lib/net.js";
import { createTsRemuxer } from "./lib/remux.js";
import { cleanupOpfsStores, createOpfsStore, removeOpfsStore } from "./lib/store.js";

const STALE_RUN_MS = 7 * 24 * 3600 * 1000;
const PROGRESS_INTERVAL_MS = 300;

let active = null;
const finished = new Map();

function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => null);
}

function progressReporter(runId) {
  let last = 0;
  let timer = null;
  let pending = null;
  const flush = () => {
    timer = null;
    last = Date.now();
    if (pending) send({ type: "offscreen-progress", runId, progress: pending });
    pending = null;
  };
  const report = (progress) => {
    pending = progress;
    const urgent = progress.phase !== "segment" && progress.phase !== "mux";
    if (urgent || Date.now() - last >= PROGRESS_INTERVAL_MS) {
      clearTimeout(timer);
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, PROGRESS_INTERVAL_MS);
    }
  };
  report.stop = () => clearTimeout(timer);
  return report;
}

async function fetchCover(url, signal) {
  if (!url || !isAllowedMediaUrl(url)) return null;
  try {
    const response = await fetchWithTimeout(url, { signal, credentials: "omit" }, 8000);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes, type: "jpeg" };
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { bytes, type: "png" };
  } catch {
    // 封面拿不到不影响录音本身。
  }
  return null;
}

async function refreshMedia(runId) {
  const response = await send({ type: "offscreen-refresh", runId });
  if (!response?.ok || !response.mediaUrl) throw new SpaceError("expired", response?.error || t("replayUrlExpired"));
  return response.mediaUrl;
}

async function start(prepared) {
  const controller = new AbortController();
  const report = progressReporter(prepared.runId);
  active = { runId: prepared.runId, controller };
  try {
    await cleanupOpfsStores(STALE_RUN_MS, prepared.storeKey).catch(() => {});
    const store = await createOpfsStore(prepared.storeKey);
    const metadata = prepared.metadata
      ? { ...prepared.metadata, cover: await fetchCover(prepared.metadata.coverUrl, controller.signal) }
      : null;
    const Transmuxer = globalThis.muxjs?.Transmuxer;
    const file = await downloadRecording(prepared.mediaUrl, {
      mode: prepared.mode,
      signal: controller.signal,
      store,
      metadata,
      speakers: prepared.speakers || null,
      limits: deviceConcurrency(navigator, prepared.maxConcurrency),
      createRemuxer: prepared.videoFormat === "mp4" && Transmuxer ? () => createTsRemuxer(Transmuxer) : null,
      refreshMedia: () => refreshMedia(prepared.runId),
      onProgress: report,
    });
    report.stop();
    const url = URL.createObjectURL(file.blob);
    const speakersUrl = file.speakers
      ? URL.createObjectURL(new Blob([JSON.stringify(file.speakers)], { type: "application/json" }))
      : "";
    finished.set(prepared.runId, { url, speakersUrl, storeKey: prepared.storeKey });
    await send({
      type: "offscreen-file",
      runId: prepared.runId,
      url,
      speakersUrl,
      extension: file.extension,
      durationSeconds: file.durationSeconds,
      segmentCount: file.segmentCount,
      size: file.blob.size,
    });
  } catch (error) {
    report.stop();
    const wrapped = asSpaceError(error);
    await send({ type: "offscreen-error", runId: prepared.runId, code: wrapped.code, message: wrapped.message });
  } finally {
    active = null;
  }
}

function revoke(entry, kind) {
  const key = kind === "speakers" ? "speakersUrl" : "url";
  if (!entry?.[key]) return;
  URL.revokeObjectURL(entry[key]);
  entry[key] = "";
}

function isHolding(entry) {
  return Boolean(entry?.url || entry?.speakersUrl);
}

// 录音文件和发言人 JSON 是两次浏览器下载，各自下完才释放对应的 blob。
async function finishRun(runId, success) {
  const entry = finished.get(runId);
  if (!entry) return { holding: false };
  entry.settled = true;
  revoke(entry, "audio");
  if (!success) revoke(entry, "speakers");
  if (success) await removeOpfsStore(entry.storeKey);
  if (!isHolding(entry)) finished.delete(runId);
  return { holding: isHolding(finished.get(runId)) };
}

function releaseBlob(runId, kind) {
  const entry = finished.get(runId);
  if (!entry) return { holding: false };
  revoke(entry, kind);
  if (entry.settled && !isHolding(entry)) finished.delete(runId);
  return { holding: isHolding(finished.get(runId)) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case "offscreen-ping":
      sendResponse({ ready: true, running: Boolean(active), runId: active?.runId || null });
      return false;
    case "download-start":
      if (active) {
        sendResponse({ ok: false, error: t("busyGeneric") });
        return false;
      }
      start(message.prepared);
      sendResponse({ ok: true });
      return false;
    case "download-cancel":
      if (!message.runId || active?.runId === message.runId) active?.controller.abort();
      finishRun(message.runId, false);
      sendResponse({ ok: true });
      return false;
    case "finish-run":
      finishRun(message.runId, Boolean(message.success)).then(
        (result) => sendResponse({ ok: true, holding: Boolean(result?.holding) }),
        () => sendResponse({ ok: false, holding: true }),
      );
      return true;
    case "release-blob":
      sendResponse({ ok: true, ...releaseBlob(message.runId, message.kind) });
      return false;
    default:
      return false;
  }
});
