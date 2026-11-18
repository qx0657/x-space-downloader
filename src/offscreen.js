import { asSpaceError } from "./lib/errors.js";
import { baseNameOf } from "./lib/format.js";
import { downloadRecording } from "./lib/hls.js";
import { deletePendingFile, readPendingFile } from "./lib/idb-file.js";
import { publishJob } from "./lib/job.js";

let controller = null;
let lastProgressAt = 0;
let progressTimer = null;
let pendingProgress = null;

function progressMessage(progress) {
  if (progress.phase === "mux") return "分片已下完，正在合成音频…";
  if (progress.phase === "playlist") return "正在读取播放列表…";
  const total = progress.total || 0;
  const completed = progress.completed || 0;
  if (!total) return "正在下载…";
  const pct = Math.max(completed ? 1 : 0, Math.min(99, Math.round((100 * completed) / total)));
  if (!completed) return `正在下载 0/${total}`;
  return `正在下载 ${completed}/${total} · ${pct}%`;
}

function queueProgress(prepared, progress) {
  pendingProgress = progress;
  const flush = () => {
    progressTimer = null;
    lastProgressAt = Date.now();
    const current = pendingProgress;
    if (!current) return;
    const patch = {
      progress: true,
      phase: "downloading",
      runId: prepared.runId,
      spaceId: prepared.spaceId,
      completed: current.completed || 0,
      detail: current.phase,
      message: progressMessage(current),
    };
    if (current.total) patch.total = current.total;
    publishJob(patch).catch(() => {});
  };
  const now = Date.now();
  if (progress.phase !== "segment" || now - lastProgressAt >= 300) {
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    flush();
    return;
  }
  if (!progressTimer) progressTimer = setTimeout(flush, 300);
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      if (ok) resolve();
      else reject(error);
    };
    const onChanged = (delta) => {
      if (delta.id !== id) return;
      if (delta.state?.current === "complete") finish(true);
      if (delta.state?.current === "interrupted") {
        finish(false, new Error(delta.error?.current || "浏览器取消了保存"));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item?.state === "complete") finish(true);
      if (item?.state === "interrupted") finish(false, new Error(item.error || "浏览器取消了保存"));
    });
  });
}

async function saveFile(bytes, filename, mime) {
  const url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime }));
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
    });
    await waitForDownload(downloadId);
    const [item] = await chrome.downloads.search({ id: downloadId });
    return item?.filename || filename;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function savePendingFile(filename) {
  const blob = await readPendingFile();
  if (!blob) throw new Error("没有找到已合成的录音");
  const saved = await saveFile(blob, filename, blob.type || "audio/mp4");
  await deletePendingFile();
  return saved;
}

async function start(prepared) {
  if (controller) return;
  controller = new AbortController();
  try {
    const file = await downloadRecording(prepared.mediaUrl, {
      mode: prepared.mode,
      signal: controller.signal,
      onProgress: (progress) => queueProgress(prepared, progress),
    });
    const filename = `X-Spaces/${prepared.baseName}.${file.extension}`;
    const savedPath = await saveFile(file.bytes, filename, file.mime);
    const visibleName = baseNameOf(savedPath) || `${prepared.baseName}.${file.extension}`;
    await publishJob({
      phase: "done",
      runId: prepared.runId,
      spaceId: prepared.spaceId,
      message: "已保存到下载文件夹",
      savedPath,
      filename: visibleName,
      completed: file.segmentCount,
      total: file.segmentCount,
      durationSeconds: file.durationSeconds,
    });
    try {
      chrome.notifications.create(`space-${prepared.spaceId}-${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: prepared.mode === "video" ? "Space 视频已保存" : "Space 录音已保存",
        message: visibleName,
      });
    } catch {
      // 通知失败不影响已经保存的文件。
    }
  } catch (error) {
    const wrapped = asSpaceError(error);
    await publishJob({
      phase: wrapped.code === "cancelled" ? "cancelled" : "error",
      runId: prepared.runId,
      spaceId: prepared.spaceId,
      message: wrapped.message,
      audioMediaUrl: "",
      videoMediaUrl: "",
    });
  } finally {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    pendingProgress = null;
    controller = null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "offscreen-ping") {
    sendResponse({ ready: true, running: Boolean(controller) });
    return true;
  }
  if (message?.type === "download-cancel") {
    controller?.abort();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "save-file") {
    savePendingFile(message.filename)
      .then((saved) => sendResponse({ ok: true, filename: saved }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "保存失败" }));
    return true;
  }
  if (message?.type === "download-start") {
    sendResponse({ ok: true });
    start(message.prepared).catch((error) => {
      publishJob({ phase: "error", message: asSpaceError(error).message }).catch(() => {});
    });
    return true;
  }
  return false;
});
