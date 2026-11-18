import { asSpaceError, SpaceError } from "./lib/errors.js";
import { audioSaveName, baseNameOf, fileBase, formatDuration } from "./lib/format.js";
import { downloadRecording } from "./lib/hls.js";
import { putPendingFile, readPendingFile } from "./lib/idb-file.js";
import { publishJob, readJob } from "./lib/job.js";
import { spaceIdFromText, spacePageUrl } from "./lib/space-url.js";
import {
  activateGuest,
  DEFAULT_QUERY_ID,
  discoverQueryId,
  inspectSpace,
  prepareDownload,
  presentable,
} from "./lib/x-api.js";

async function cookieValue(name) {
  for (const url of ["https://x.com/", "https://twitter.com/"]) {
    const cookie = await chrome.cookies.get({ url, name });
    if (cookie?.value) return cookie.value;
  }
  return "";
}

async function userSession() {
  const [auth, csrf] = await Promise.all([cookieValue("auth_token"), cookieValue("ct0")]);
  if (!auth || !csrf) return null;
  return { mode: "user", csrf };
}

async function withSession(fn) {
  const user = await userSession();
  if (user) {
    try {
      return await fn(user);
    } catch (error) {
      if (error?.code !== "auth") throw error;
    }
  }
  const guestToken = await activateGuest();
  return fn({ mode: "guest", guestToken });
}

async function runWithQuery(spaceId, scriptUrls, fn) {
  const stored = await chrome.storage.local.get("queryId");
  const queryId = stored.queryId || DEFAULT_QUERY_ID;
  try {
    return await withSession((session) => fn(session, queryId));
  } catch (error) {
    if (error?.code !== "query") throw error;
    const found = await discoverQueryId(scriptUrls);
    if (!found || found === queryId) {
      throw new SpaceError("query", "X 的 Space 接口变了，暂时解析不了。打开一场 Space 页面后再试。");
    }
    await chrome.storage.local.set({ queryId: found });
    return withSession((session) => fn(session, found));
  }
}

let openingOffscreen = null;
let startingDownload = false;
let saveResolver = null;
let cancelRequested = false;
let activeController = null;
const keepalivePorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "space-download") return;
  keepalivePorts.add(port);
  port.onDisconnect.addListener(() => keepalivePorts.delete(port));
});

function preparingMessage(job, spaceId) {
  if (!job || job.spaceId !== spaceId) return "正在准备下载…";
  const total = job.segmentCount || 0;
  const duration = formatDuration(job.durationSeconds);
  if (total && duration) return `正在准备下载… 时长 ${duration}，共 ${total} 段`;
  if (total) return `正在准备下载… 共 ${total} 段`;
  if (duration) return `正在准备下载… 时长 ${duration}`;
  return "正在准备下载…";
}

async function offscreenDocumentOpen() {
  const url = chrome.runtime.getURL("src/offscreen.html");
  const docs = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  return docs.length > 0;
}

function sendMessageTimeout(message, ms = 1500) {
  return Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]);
}

async function offscreenIsRunning() {
  if (!(await offscreenDocumentOpen())) return false;
  try {
    const response = await sendMessageTimeout({ type: "offscreen-ping" });
    return Boolean(response?.running);
  } catch {
    return false;
  }
}

async function downloadStillActive(job) {
  if (startingDownload || activeController) return true;
  if (job?.phase !== "downloading") return false;
  return false;
}

async function ensureOffscreen() {
  if (!openingOffscreen) {
    openingOffscreen = (async () => {
      const url = chrome.runtime.getURL("src/offscreen.html");
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [url],
      });
      if (!existing.length) {
        await Promise.race([
          chrome.offscreen.createDocument({
            url: "src/offscreen.html",
            reasons: ["BLOBS"],
            justification: "把合成好的 Space 录音交给浏览器保存",
          }),
          new Promise((_, reject) => {
            setTimeout(() => reject(new SpaceError("internal", "保存组件启动超时")), 8000);
          }),
        ]);
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const response = await sendMessageTimeout({ type: "offscreen-ping" }, 300);
          if (response?.ready) return;
        } catch {
          // 文档还在启动。
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new SpaceError("internal", "下载组件没有启动");
    })().catch((error) => {
      openingOffscreen = null;
      throw error;
    });
  }
  return openingOffscreen;
}

function resetCard(spaceId) {
  return {
    phase: "inspecting",
    spaceId,
    url: spacePageUrl(spaceId),
    title: "",
    creatorName: "",
    handle: "",
    state: "",
    replay: false,
    contentType: "",
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    segmentCount: 0,
    mediaKind: "",
    canDownload: false,
    videoAvailable: false,
    videoBytesEstimate: 0,
    message: "正在解析…",
    savedPath: "",
    filename: "",
    completed: 0,
    total: 0,
  };
}

async function inspect(message) {
  const current = await readJob();
  if (current?.phase === "downloading") return { ok: true, job: current };
  const spaceId = spaceIdFromText(message.url);
  if (!spaceId) throw new SpaceError("url", "这不是 Space 链接。打开 x.com/i/spaces/… 或把链接贴进来。");
  await publishJob(resetCard(spaceId));
  const info = await runWithQuery(spaceId, message.scriptUrls, (session, queryId) => inspectSpace(spaceId, session, { queryId }));
  const job = await publishJob({
    ...presentable(info),
    audioMediaUrl: info.audioMediaUrl || "",
    videoMediaUrl: info.videoMediaUrl || "",
    phase: info.canDownload ? "ready" : "blocked",
    savedPath: "",
    filename: "",
    completed: 0,
    total: info.segmentCount || 0,
  });
  return { ok: true, job };
}

async function resolveDownload(message) {
  const spaceId = spaceIdFromText(message.url);
  if (!spaceId) throw new SpaceError("url", "这不是 Space 链接。打开 x.com/i/spaces/… 或把链接贴进来。");
  const prepared = await runWithQuery(spaceId, message.scriptUrls, (session, queryId) =>
    prepareDownload(spaceId, session, { video: Boolean(message.video), queryId }));
  await publishJob({
    ...presentable(prepared),
    audioMediaUrl: message.video ? "" : prepared.mediaUrl,
    videoMediaUrl: message.video ? prepared.mediaUrl : "",
    phase: "ready",
    canDownload: true,
    segmentCount: prepared.segmentCount || 0,
    total: prepared.segmentCount || 0,
    message: "已拿到回放地址",
  });
  return {
    ok: true,
    mediaUrl: prepared.mediaUrl,
    segmentCount: prepared.segmentCount || 0,
    title: prepared.title || "",
  };
}

async function startDownload(message) {
  if (startingDownload) return { ok: true, job: await readJob(), already: true };
  const spaceId = spaceIdFromText(message.url);
  if (!spaceId) throw new SpaceError("url", "这不是 Space 链接。打开 x.com/i/spaces/… 或把链接贴进来。");
  const current = await readJob();
  if (await downloadStillActive(current)) return { ok: true, job: current, already: true };
  const video = Boolean(message.video);
  const mediaUrl = message.mediaUrl || (current?.spaceId === spaceId ? (video ? current.videoMediaUrl : current.audioMediaUrl) : "");
  if (!mediaUrl) throw new SpaceError("unavailable", "没有回放地址，请先点解析");
  startingDownload = true;
  cancelRequested = false;
  let handedOff = false;
  try {
    const knownTotal = message.segmentCount || (current?.spaceId === spaceId ? (current.segmentCount || 0) : 0);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = await publishJob({
      phase: "downloading",
      runId,
      spaceId,
      url: spacePageUrl(spaceId),
      completed: 0,
      total: knownTotal,
      message: knownTotal ? `正在读取播放列表… 共 ${knownTotal} 段` : "正在读取播放列表…",
      savedPath: "",
      filename: "",
      mode: video ? "video" : "audio",
      audioMediaUrl: video ? (current?.audioMediaUrl || "") : mediaUrl,
      videoMediaUrl: video ? mediaUrl : (current?.videoMediaUrl || ""),
    });
    handedOff = true;
    continueDownload({
      mediaUrl,
      mode: video ? "video" : "audio",
      baseName: fileBase({ ...current, spaceId, title: current?.title || message.title }),
      spaceId,
      title: current?.title || message.title || "",
      runId,
    }).catch(async (error) => {
      const wrapped = asSpaceError(error);
      if (wrapped.code === "cancelled" || cancelRequested) {
        await publishJob({ phase: "cancelled", runId, message: "已取消下载" });
        return;
      }
      await publishJob({
        phase: "error",
        runId,
        message: wrapped.message,
        audioMediaUrl: "",
        videoMediaUrl: "",
      });
    }).finally(() => {
      startingDownload = false;
    });
    return { ok: true, job };
  } finally {
    if (!handedOff) startingDownload = false;
  }
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
      if (delta.state?.current === "interrupted") finish(false, new Error(delta.error?.current || "浏览器取消了保存"));
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item?.state === "complete") finish(true);
      if (item?.state === "interrupted") finish(false, new Error(item.error || "浏览器取消了保存"));
    });
  });
}

function waitForSaveResult() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      saveResolver = null;
      reject(new SpaceError("download", "保存超时"));
    }, 180000);
    saveResolver = (message) => {
      clearTimeout(timer);
      saveResolver = null;
      if (message?.ok) resolve(message.filename);
      else reject(new SpaceError("download", message?.error || "保存失败"));
    };
  });
}

async function saveViaPage(filename) {
  await chrome.storage.session.set({ pendingSave: { filename } });
  const result = waitForSaveResult();
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL("src/save.html"),
    active: false,
  });
  try {
    return await result;
  } finally {
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function saveFile(bytes, filename, mime) {
  const name = audioSaveName(filename, mime);
  const type = /\.m4a$/i.test(name) ? "application/octet-stream" : mime;
  await putPendingFile(new Blob([bytes], { type }));
  return saveViaPage(name);
}

async function savePending(message) {
  if (startingDownload || activeController) return { ok: true, job: await readJob(), already: true };
  const blob = await readPendingFile();
  if (!blob || blob.size < 100000) return { ok: true, saved: false };
  const spaceId = spaceIdFromText(message.url);
  const current = await readJob();
  const filename = `X-Spaces/${fileBase({
    ...(current || {}),
    spaceId: spaceId || current?.spaceId,
    title: message.title || current?.title || "space",
  })}.m4a`;
  startingDownload = true;
  try {
    await publishJob({
      phase: "downloading",
      spaceId: spaceId || current?.spaceId,
      message: "正在保存已合成的录音…",
      completed: current?.total || current?.segmentCount || 1,
      total: current?.total || current?.segmentCount || 1,
    });
    const savedPath = await saveViaPage(filename);
    const visibleName = baseNameOf(savedPath) || filename.split("/").pop();
    const job = await publishJob({
      phase: "done",
      spaceId: spaceId || current?.spaceId,
      message: "已保存到下载文件夹",
      savedPath,
      filename: visibleName,
      completed: current?.total || current?.segmentCount || 1,
      total: current?.total || current?.segmentCount || 1,
    });
    try {
      chrome.notifications.create(`space-saved-${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "Space 录音已保存",
        message: visibleName,
      });
    } catch {
      // 通知失败不影响已经保存的文件。
    }
    return { ok: true, saved: true, job };
  } finally {
    startingDownload = false;
  }
}

function downloadStatus(progress) {
  if (progress.phase === "mux") return "分片已下完，正在合成音频…";
  if (progress.phase === "playlist") return "正在读取播放列表…";
  const total = progress.total || 0;
  const completed = progress.completed || 0;
  if (!total) return "正在读取播放列表…";
  const pct = Math.max(completed ? 1 : 0, Math.min(99, Math.round((100 * completed) / total)));
  const lanes = progress.concurrency ? ` · ${progress.concurrency} 路` : "";
  return `正在下载 ${completed}/${total} · ${pct}%${lanes}`;
}

async function continueDownload(prepared) {
  if (cancelRequested) {
    await publishJob({ phase: "cancelled", runId: prepared.runId, message: "已取消下载" });
    return;
  }
  activeController = new AbortController();
  let lastPublish = 0;
  let timer = null;
  let latest = null;
  const report = (progress) => {
    latest = progress;
    const flush = () => {
      timer = null;
      lastPublish = Date.now();
      const current = latest;
      if (!current) return;
      const patch = {
        progress: true,
        phase: "downloading",
        runId: prepared.runId,
        spaceId: prepared.spaceId,
        completed: current.completed || 0,
        detail: current.phase,
        message: downloadStatus(current),
      };
      if (current.total) patch.total = current.total;
      publishJob(patch).catch(() => {});
    };
    if (progress.phase !== "segment" || Date.now() - lastPublish >= 250) {
      if (timer) clearTimeout(timer);
      flush();
      return;
    }
    if (!timer) timer = setTimeout(flush, 250);
  };
  try {
    const file = await downloadRecording(prepared.mediaUrl, {
      mode: prepared.mode,
      signal: activeController.signal,
      onProgress: report,
    });
    if (timer) clearTimeout(timer);
    await publishJob({
      progress: true,
      phase: "downloading",
      runId: prepared.runId,
      spaceId: prepared.spaceId,
      completed: file.segmentCount,
      total: file.segmentCount,
      message: "正在保存文件…",
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
  } finally {
    if (timer) clearTimeout(timer);
    activeController = null;
  }
}

async function cancel() {
  cancelRequested = true;
  activeController?.abort();
  const current = await readJob();
  if (current?.phase === "downloading") {
    await publishJob({ phase: "cancelled", runId: current.runId, message: "已取消下载" });
  }
  return { ok: true, job: await readJob() };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type === "job" || message.type === "save-result") {
    if (message?.type === "job") updateBadge(message.job);
    if (message?.type === "save-result") saveResolver?.(message);
    return false;
  }
  if (message.type === "offscreen-ping" || message.type === "download-start" || message.type === "download-cancel" || message.type === "collect-scripts") {
    return false;
  }
  const task = async () => {
    if (message.type === "save-pending") return savePending(message);
    if (message.type === "inspect" || message.type === "resolve") {
      return message.type === "resolve" ? resolveDownload(message) : inspect(message);
    }
    if (message.type === "download") return startDownload(message);
    if (message.type === "cancel") return cancel();
    if (message.type === "get-job") {
      const job = await readJob();
      if (job?.phase === "downloading" && !startingDownload && !activeController) {
        const again = await readJob();
        if (!again || again.phase !== "downloading" || again.runId !== job.runId || startingDownload || activeController) {
          return { ok: true, job: again };
        }
        if (Date.now() - (again.updatedAt || 0) > 20000) {
          const healed = await publishJob({
            phase: "error",
            runId: again.runId,
            message: "上次下载中断了，请再点一次下载",
          });
          return { ok: true, job: healed };
        }
        return { ok: true, job: again };
      }
      return { ok: true, job };
    }
    return { ok: false, error: "未知请求" };
  };
  task()
    .then((result) => sendResponse(result))
    .catch(async (error) => {
      const wrapped = asSpaceError(error);
      const current = await readJob().catch(() => null);
      const keepRunning = current?.phase === "downloading" && wrapped.code !== "cancelled";
      if (!keepRunning) {
        try {
          await publishJob({ phase: "error", message: wrapped.message });
        } catch {
          // 状态写不进去时，仍然把错误交回界面。
        }
      }
      sendResponse({ ok: false, error: wrapped.message });
    });
  return true;
});

function updateBadge(job) {
  if (!job) return;
  if (job.phase === "downloading") {
    const pct = job.total ? Math.min(99, Math.round((100 * (job.completed || 0)) / job.total)) : 0;
    chrome.action.setBadgeBackgroundColor({ color: "#1d9bf0" });
    chrome.action.setBadgeText({ text: pct ? String(pct) : "…" });
    return;
  }
  if (job.phase === "done") {
    chrome.action.setBadgeBackgroundColor({ color: "#00ba7c" });
    chrome.action.setBadgeText({ text: "OK" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
    return;
  }
  chrome.action.setBadgeText({ text: "" });
}
