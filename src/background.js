import { asSpaceError, SpaceError } from "./lib/errors.js";
import { baseNameOf, fileBase, formatDuration } from "./lib/format.js";
import { t } from "./lib/i18n.js";
import { publishJob, readJob } from "./lib/job.js";
import { isAllowedMediaUrl } from "./lib/net.js";
import { getSettings } from "./lib/settings.js";
import { spaceIdFromText, spacePageUrl } from "./lib/space-url.js";
import { activateGuest, DEFAULT_QUERY_ID, discoverQueryId, inspectSpace, presentable } from "./lib/x-api.js";

const OFFSCREEN_URL = "src/offscreen.html";
const HEADER_RULE_ID = 1;
const GUEST_TTL_MS = 90 * 60 * 1000;
const MEDIA_TTL_MS = 10 * 60 * 1000;
const STALE_JOB_MS = 20000;
const SPACE_TAB_PATTERNS = [
  "https://x.com/i/spaces/*",
  "https://twitter.com/i/spaces/*",
  "https://mobile.x.com/i/spaces/*",
  "https://mobile.twitter.com/i/spaces/*",
];

// 只改扩展自己（后台和 offscreen，不属于任何标签页）发出的请求，不碰网页里的请求。
const headerRuleReady = chrome.declarativeNetRequest
  .updateSessionRules({
    removeRuleIds: [HEADER_RULE_ID],
    addRules: [
      {
        id: HEADER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "origin", operation: "set", value: "https://x.com" },
            { header: "referer", operation: "set", value: "https://x.com/" },
          ],
        },
        condition: {
          requestDomains: ["x.com", "twitter.com", "pscp.tv", "twimg.com"],
          tabIds: [-1],
          resourceTypes: ["xmlhttprequest"],
        },
      },
    ],
  })
  .catch((error) => console.warn("header rule", error));

chrome.runtime.onInstalled.addListener(() => {
  // 1.0.x 把合成好的文件放在这个 IndexedDB 里。
  indexedDB.deleteDatabase("x-space-downloader");
});

// ---------- X 会话 ----------

async function cookieValue(name) {
  for (const url of ["https://x.com/", "https://twitter.com/"]) {
    const cookie = await chrome.cookies.get({ url, name });
    if (cookie?.value) return cookie.value;
  }
  return "";
}

async function userSession() {
  const [auth, csrf] = await Promise.all([cookieValue("auth_token"), cookieValue("ct0")]);
  return auth && csrf ? { mode: "user", csrf } : null;
}

async function guestToken(force = false) {
  const { guest } = await chrome.storage.session.get("guest");
  if (!force && guest?.token && Date.now() - guest.at < GUEST_TTL_MS) return guest.token;
  const token = await activateGuest();
  await chrome.storage.session.set({ guest: { token, at: Date.now() } });
  return token;
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
  try {
    return await fn({ mode: "guest", guestToken: await guestToken() });
  } catch (error) {
    if (error?.code !== "auth") throw error;
    return fn({ mode: "guest", guestToken: await guestToken(true) });
  }
}

async function runWithQuery(scriptUrls, fn) {
  await headerRuleReady;
  const stored = await chrome.storage.local.get("queryId");
  const queryId = stored.queryId || DEFAULT_QUERY_ID;
  try {
    return await withSession((session) => fn(session, queryId));
  } catch (error) {
    if (error?.code !== "query") throw error;
    const found = await discoverQueryId(scriptUrls);
    if (!found || found === queryId) throw new SpaceError("query", t("queryChanged"));
    await chrome.storage.local.set({ queryId: found });
    return withSession((session) => fn(session, found));
  }
}

async function inspectWithSession(spaceId, scriptUrls) {
  const info = await runWithQuery(scriptUrls, (session, queryId) => inspectSpace(spaceId, session, { queryId }));
  await chrome.storage.session.set({
    media: { spaceId, audio: info.audioMediaUrl || "", video: info.videoMediaUrl || "", at: Date.now() },
  });
  return info;
}

async function cachedMedia(spaceId) {
  const { media } = await chrome.storage.session.get("media");
  if (!media || media.spaceId !== spaceId || Date.now() - media.at > MEDIA_TTL_MS) return null;
  return media;
}

// ---------- offscreen ----------

let openingOffscreen = null;

async function offscreenOpen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

function sendMessageTimeout(message, ms = 1500) {
  let timer;
  return Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function pingOffscreen() {
  if (!(await offscreenOpen())) return null;
  try {
    return await sendMessageTimeout({ type: "offscreen-ping" }, 800);
  } catch {
    return null;
  }
}

function ensureOffscreen() {
  openingOffscreen ||= (async () => {
    if (!(await offscreenOpen())) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["BLOBS"],
        justification: "Download replay segments and hand the finished recording to chrome.downloads",
      });
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await pingOffscreen();
      if (response?.ready) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new SpaceError("internal", t("offscreenFailed"));
  })().finally(() => {
    openingOffscreen = null;
  });
  return openingOffscreen;
}

async function closeOffscreen() {
  const ping = await pingOffscreen();
  if (ping && !ping.running) await chrome.offscreen.closeDocument().catch(() => {});
}

async function finishRun(runId, success) {
  if (!(await offscreenOpen())) return;
  const response = await sendMessageTimeout({ type: "finish-run", runId, success }, 10000).catch(() => null);
  if (!response?.holding) await closeOffscreen();
}

async function releaseBlob(runId, kind) {
  if (!(await offscreenOpen())) return;
  const response = await sendMessageTimeout({ type: "release-blob", runId, kind }, 10000).catch(() => null);
  if (!response?.holding) await closeOffscreen();
}

// ---------- 任务 ----------

let starting = false;

function resetCard(spaceId) {
  return {
    phase: "inspecting",
    runId: null,
    downloadId: null,
    spaceId,
    url: spacePageUrl(spaceId),
    title: "",
    creatorName: "",
    handle: "",
    avatarUrl: "",
    state: "",
    replay: false,
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    segmentCount: 0,
    mediaKind: "",
    canDownload: false,
    videoAvailable: false,
    videoBytesEstimate: 0,
    message: t("inspecting"),
    savedPath: "",
    filename: "",
    completed: 0,
    total: 0,
  };
}

async function runAlive(job) {
  if (starting) return true;
  if (job?.phase !== "downloading") return false;
  if (job.downloadId) {
    const [item] = await chrome.downloads.search({ id: job.downloadId });
    return item?.state === "in_progress";
  }
  const ping = await pingOffscreen();
  return Boolean(ping?.running && ping.runId === job.runId);
}

function busyError(job) {
  return new SpaceError("busy", t("busyOther", job.title || job.spaceId));
}

function requireSpaceId(url) {
  const spaceId = spaceIdFromText(url);
  if (!spaceId) throw new SpaceError("url", t("notSpaceUrlHelp"));
  return spaceId;
}

async function inspect(message) {
  const spaceId = requireSpaceId(message.url);
  const current = await readJob();
  if (current?.phase === "downloading" && (await runAlive(current))) {
    if (current.spaceId === spaceId) return { ok: true, job: current };
    throw busyError(current);
  }
  await publishJob({ ...resetCard(spaceId), start: true });
  const info = await inspectWithSession(spaceId, message.scriptUrls);
  const job = await publishJob({
    ...presentable(info),
    phase: info.canDownload ? "ready" : "blocked",
    completed: 0,
    total: info.segmentCount || 0,
  });
  return { ok: true, job };
}

function metadataFor(info) {
  return {
    title: info.title || "",
    artist: info.creatorName || (info.handle ? `@${info.handle}` : ""),
    album: "X Spaces",
    date: info.startedAt ? new Date(info.startedAt).toISOString() : "",
    comment: spacePageUrl(info.spaceId),
    coverUrl: info.avatarUrl || "",
  };
}

function speakerSource(info) {
  return {
    roster: {
      host: {
        id: info.roster?.host?.id || "",
        handle: info.roster?.host?.handle || info.handle || "",
        name: info.roster?.host?.name || info.creatorName || "",
      },
      people: info.roster?.people || [],
    },
    space: {
      id: info.spaceId,
      url: info.url || spacePageUrl(info.spaceId),
      title: info.title || "",
      startedAt: info.startedAt || null,
      endedAt: info.endedAt || null,
    },
  };
}

async function startDownload(message) {
  const spaceId = requireSpaceId(message.url);
  const video = Boolean(message.video);
  const current = await readJob();
  if (current?.phase === "downloading" && (await runAlive(current))) {
    if (current.spaceId === spaceId) return { ok: true, job: current, already: true };
    throw busyError(current);
  }
  if (starting) return { ok: true, job: current, already: true };
  starting = true;
  let runId = null;
  try {
    const settings = await getSettings();
    let info = current?.spaceId === spaceId && current.title ? current : null;
    const media = await cachedMedia(spaceId);
    let mediaUrl = media ? (video ? media.video : media.audio) : "";
    if (!info || !mediaUrl) {
      const fresh = await inspectWithSession(spaceId, message.scriptUrls);
      if (!fresh.canDownload) throw new SpaceError("unavailable", fresh.message || t("noRecording"));
      info = presentable(fresh);
      mediaUrl = video ? fresh.videoMediaUrl : fresh.audioMediaUrl;
    }
    if (video && !info.videoAvailable) throw new SpaceError("video", t("noVideo"));
    if (settings.saveSpeakers && !video && !info.roster) {
      try {
        const fresh = await inspectWithSession(spaceId, message.scriptUrls);
        info = { ...info, roster: fresh.roster };
      } catch {
        // 名单没拿到时，时间线里仍有音频分片记录的账号。
      }
    }
    if (!mediaUrl) throw new SpaceError("unavailable", t("noReplayUrl"));
    if (!isAllowedMediaUrl(mediaUrl)) throw new SpaceError("playlist", t("mediaUrlRejected"));

    runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mode = video ? "video" : "audio";
    const target = [settings.folder, fileBase(info, settings.template)].filter(Boolean).join("/");
    const total = info.segmentCount || 0;
    const job = await publishJob({
      ...info,
      start: true,
      phase: "downloading",
      runId,
      downloadId: null,
      speakersDownloadId: null,
      spaceId,
      url: spacePageUrl(spaceId),
      mode,
      target,
      completed: 0,
      total,
      savedPath: "",
      filename: "",
      message: preparingMessage(info),
    });
    await ensureOffscreen();
    const started = await sendMessageTimeout(
      {
        type: "download-start",
        prepared: {
          runId,
          spaceId,
          mode,
          mediaUrl,
          storeKey: `${spaceId}-${mode}`,
          maxConcurrency: settings.maxConcurrency,
          videoFormat: settings.videoFormat,
          metadata: settings.embedMetadata && mode === "audio" ? metadataFor(info) : null,
          speakers: settings.saveSpeakers && mode === "audio" ? speakerSource(info) : null,
        },
      },
      5000,
    );
    if (!started?.ok) throw new SpaceError("internal", started?.error || t("downloadNotStarted"));
    return { ok: true, job };
  } catch (error) {
    if (runId) await publishJob({ runId, phase: "error", message: asSpaceError(error).message });
    throw error;
  } finally {
    starting = false;
  }
}

function preparingMessage(info) {
  const total = info.segmentCount || 0;
  const duration = formatDuration(info.durationSeconds);
  if (total && duration) return t("preparingWithBoth", duration, total);
  if (total) return t("preparingWithSegments", total);
  return t("readingPlaylist");
}

function progressMessage(progress) {
  const total = progress.total || 0;
  const completed = progress.completed || 0;
  if (progress.phase === "playlist" || !total) return t("readingPlaylist");
  const pct = Math.max(completed ? 1 : 0, Math.min(99, Math.round((100 * completed) / total)));
  if (progress.phase === "mux") return t("muxing", pct);
  const lanes = progress.concurrency ? t("lanes", progress.concurrency) : "";
  return t("downloadingProgress", completed, total, pct) + lanes;
}

async function onOffscreenProgress({ runId, progress }) {
  const patch = { runId, detail: progress.phase, message: progressMessage(progress) };
  if (progress.phase === "segment") {
    patch.completed = progress.completed || 0;
    if (progress.total) patch.total = progress.total;
  }
  await publishJob(patch);
}

const speakerDownloads = new Map();

async function rememberSpeakersDownload(runId, downloadId) {
  if (!downloadId) return null;
  speakerDownloads.set(downloadId, runId);
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (item && item.state !== "in_progress") {
    speakerDownloads.delete(downloadId);
    await releaseBlob(runId, "speakers");
    return null;
  }
  return downloadId;
}

async function onOffscreenFile(message) {
  const job = await readJob();
  if (job?.runId !== message.runId || job.phase !== "downloading") {
    await finishRun(message.runId, false);
    return;
  }
  let speakersDownloadId = null;
  try {
    if (message.speakersUrl) {
      speakersDownloadId = await rememberSpeakersDownload(
        job.runId,
        await chrome.downloads.download({
          url: message.speakersUrl,
          filename: `${job.target || fileBase(job)}.speakers.json`,
          conflictAction: "uniquify",
          saveAs: false,
        }),
      );
    }
    const downloadId = await chrome.downloads.download({
      url: message.url,
      filename: `${job.target || fileBase(job)}.${message.extension}`,
      conflictAction: "uniquify",
      saveAs: false,
    });
    await publishJob({
      runId: job.runId,
      downloadId,
      speakersDownloadId,
      message: t("savingFile"),
      completed: message.segmentCount,
      total: message.segmentCount,
      durationSeconds: message.durationSeconds || job.durationSeconds,
    });
  } catch (error) {
    if (speakersDownloadId) {
      speakerDownloads.delete(speakersDownloadId);
      await chrome.downloads.cancel(speakersDownloadId).catch(() => {});
    }
    await publishJob({ runId: job.runId, phase: "error", message: asSpaceError(error).message });
    await finishRun(job.runId, false);
  }
}

async function onOffscreenError(message) {
  const cancelled = message.code === "cancelled";
  await publishJob({
    runId: message.runId,
    phase: cancelled ? "cancelled" : "error",
    message: cancelled ? t("cancelledDownload") : message.message,
  });
}

async function onOffscreenRefresh(message) {
  const job = await readJob();
  if (job?.runId !== message.runId || job.phase !== "downloading") throw new SpaceError("cancelled", t("cancelled"));
  const info = await inspectWithSession(job.spaceId, []);
  const mediaUrl = job.mode === "video" ? info.videoMediaUrl : info.audioMediaUrl;
  if (!mediaUrl || !isAllowedMediaUrl(mediaUrl)) throw new SpaceError("expired", t("replayUrlExpired"));
  return { ok: true, mediaUrl };
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const speakerRunId = speakerDownloads.get(delta.id);
  if (speakerRunId) {
    if (delta.state.current === "complete" || delta.state.current === "interrupted") {
      speakerDownloads.delete(delta.id);
      await releaseBlob(speakerRunId, "speakers");
    }
    return;
  }
  const job = await readJob();
  if (!job?.downloadId || job.downloadId !== delta.id || job.phase !== "downloading") return;
  if (delta.state.current === "complete") {
    const [item] = await chrome.downloads.search({ id: delta.id });
    const filename = baseNameOf(item?.filename) || baseNameOf(job.target);
    const done = await publishJob({
      runId: job.runId,
      phase: "done",
      savedPath: item?.filename || "",
      filename,
      message: t("savedToDownloads"),
    });
    if (done.phase === "done") notifySaved(job.mode, filename);
    await finishRun(job.runId, true);
  } else if (delta.state.current === "interrupted") {
    await publishJob({
      runId: job.runId,
      phase: "error",
      message: t("saveInterrupted", delta.error?.current || ""),
    });
    await finishRun(job.runId, false);
  }
});

function notifySaved(mode, filename) {
  chrome.notifications
    .create(`space-saved-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: mode === "video" ? t("notifyVideoSaved") : t("notifyAudioSaved"),
      message: filename,
    })
    .catch(() => {});
}

async function cancel() {
  const job = await readJob();
  if (job?.phase !== "downloading") return { ok: true, job };
  await sendMessageTimeout({ type: "download-cancel", runId: job.runId }).catch(() => {});
  if (job.downloadId) await chrome.downloads.cancel(job.downloadId).catch(() => {});
  if (job.speakersDownloadId) {
    speakerDownloads.delete(job.speakersDownloadId);
    await chrome.downloads.cancel(job.speakersDownloadId).catch(() => {});
  }
  const next = await publishJob({ runId: job.runId, phase: "cancelled", message: t("cancelledDownload") });
  return { ok: true, job: next };
}

async function getJob() {
  const job = await readJob();
  if (job?.phase !== "downloading" || Date.now() - (job.updatedAt || 0) < STALE_JOB_MS) return { ok: true, job };
  if (await runAlive(job)) return { ok: true, job };
  const healed = await publishJob({ runId: job.runId, phase: "error", message: t("interruptedResume") });
  return { ok: true, job: healed };
}

const handlers = {
  inspect,
  download: startDownload,
  cancel,
  "get-job": getJob,
  "offscreen-progress": onOffscreenProgress,
  "offscreen-file": onOffscreenFile,
  "offscreen-error": onOffscreenError,
  "offscreen-refresh": onOffscreenRefresh,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  const fromOffscreen = message.type.startsWith("offscreen-");
  if (fromOffscreen && sender.url !== chrome.runtime.getURL(OFFSCREEN_URL)) return false;
  handler(message)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch(async (error) => {
      const wrapped = asSpaceError(error);
      if (!fromOffscreen && wrapped.code !== "busy") {
        await publishJob({ phase: "error", message: wrapped.message }).catch(() => {});
      }
      sendResponse({ ok: false, error: wrapped.message, code: wrapped.code });
    });
  return true;
});

// ---------- 状态广播和角标 ----------

async function broadcast(job) {
  const tabs = await chrome.tabs.query({ url: SPACE_TAB_PATTERNS }).catch(() => []);
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "job", job }).catch(() => {});
  }
}

let badgeTimer = null;

function updateBadge(job) {
  clearTimeout(badgeTimer);
  if (job?.phase === "downloading") {
    const pct = job.total ? Math.min(99, Math.round((100 * (job.completed || 0)) / job.total)) : 0;
    chrome.action.setBadgeBackgroundColor({ color: "#1d9bf0" });
    chrome.action.setBadgeText({ text: pct ? String(pct) : "…" });
    return;
  }
  if (job?.phase === "done") {
    chrome.action.setBadgeBackgroundColor({ color: "#00ba7c" });
    chrome.action.setBadgeText({ text: "OK" });
    badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
    return;
  }
  chrome.action.setBadgeText({ text: "" });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.job) return;
  const job = changes.job.newValue || null;
  updateBadge(job);
  broadcast(job);
});
