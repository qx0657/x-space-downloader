import { formatBytes, formatClock, formatDuration, stateLabel } from "./lib/format.js";
import { spaceIdFromText } from "./lib/space-url.js";

const urlInput = document.querySelector("#url");
const inspectButton = document.querySelector("#inspect");
const card = document.querySelector("#card");
const title = document.querySelector("#title");
const meta = document.querySelector("#meta");
const time = document.querySelector("#time");
const downloadButton = document.querySelector("#download");
const videoButton = document.querySelector("#video");
const cancelButton = document.querySelector("#cancel");
const bar = document.querySelector("#bar");
const barFill = document.querySelector("#bar-fill");
const message = document.querySelector("#message");

let currentJob = null;
let optimistic = false;
let holdUntil = 0;

function setMessage(text, kind) {
  message.textContent = text || "";
  message.className = kind || "";
}

function render(job) {
  currentJob = job;
  if (!job || !job.spaceId) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  title.textContent = job.title || "正在解析…";
  const who = job.handle ? `@${job.handle}` : (job.creatorName || "");
  const bits = [who, stateLabel(job.state, job.replay)].filter(Boolean);
  meta.textContent = bits.join(" · ");
  const when = formatClock(job.startedAt);
  const duration = formatDuration(job.durationSeconds);
  const pieces = [];
  if (when) pieces.push(when);
  if (duration) pieces.push(duration);
  if (job.segmentCount) pieces.push(`${job.segmentCount} 段`);
  time.textContent = pieces.join(" · ");

  if (job.phase === "downloading" || job.phase === "done" || job.phase === "error" || job.phase === "cancelled") {
    optimistic = false;
  }
  const busy = job.phase === "inspecting" || job.phase === "downloading";
  inspectButton.disabled = busy;
  downloadButton.disabled = busy || !job.canDownload;
  downloadButton.hidden = job.phase === "downloading";
  cancelButton.hidden = job.phase !== "downloading";
  videoButton.hidden = !job.videoAvailable || job.phase === "downloading";
  videoButton.disabled = busy || !job.canDownload;
  const estimate = formatBytes(job.videoBytesEstimate);
  videoButton.textContent = estimate ? `下载视频 · 约 ${estimate}` : "下载视频";

  const showBar = job.phase === "downloading" || job.phase === "done";
  bar.hidden = !showBar;
  const completed = job.completed || 0;
  const indeterminate = job.phase === "downloading" && !completed;
  bar.classList.toggle("indeterminate", indeterminate);
  const pct = job.total
    ? (job.phase === "done"
      ? 100
      : (completed ? Math.max(1, Math.min(99, Math.round((100 * completed) / job.total))) : 0))
    : 0;
  barFill.style.width = indeterminate ? "35%" : `${pct}%`;

  if (job.phase === "error") setMessage(job.message || "解析失败", "error");
  else if (job.phase === "cancelled") setMessage(job.message || "已取消下载", "");
  else if (job.phase === "done") setMessage(job.filename ? `已保存 ${job.filename}` : "已保存到下载文件夹", "ok");
  else if (job.phase === "downloading") setMessage(job.message || "正在下载…", "progress");
  else if (job.phase === "blocked") setMessage(job.message || "这场没有可下载的录音", "");
  else if (job.message) setMessage(job.message, "");
  else setMessage("");
}

function showBusy(text) {
  optimistic = true;
  holdUntil = Date.now();
  card.hidden = false;
  inspectButton.disabled = true;
  downloadButton.hidden = true;
  videoButton.hidden = true;
  cancelButton.hidden = false;
  bar.hidden = false;
  bar.classList.add("indeterminate");
  barFill.style.width = "35%";
  setMessage(text, "progress");
}

async function scriptUrls() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return [];
    const collected = await chrome.tabs.sendMessage(tab.id, { type: "collect-scripts" });
    return collected?.urls || [];
  } catch {
    return [];
  }
}

async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({
    type,
    url: urlInput.value.trim(),
    scriptUrls: await scriptUrls(),
    ...extra,
  });
  if (response?.job) render(response.job);
  if (!response?.ok) throw new Error(response?.error || "请求失败");
  return response;
}

inspectButton.addEventListener("click", () => {
  send("inspect").catch((error) => setMessage(error.message, "error"));
});

function showFailure(error) {
  optimistic = false;
  if (currentJob?.phase === "downloading") return;
  downloadButton.hidden = false;
  cancelButton.hidden = true;
  inspectButton.disabled = false;
  bar.hidden = true;
  bar.classList.remove("indeterminate");
  setMessage(error.message, "error");
}

async function clickDownload(video) {
  showBusy("正在检查已合成的录音…");
  optimistic = false;
  try {
    const reused = await chrome.runtime.sendMessage({
      type: "save-pending",
      url: urlInput.value.trim(),
      title: currentJob?.title || "",
    });
    if (reused?.saved || reused?.already) {
      if (reused.job) render(reused.job);
      return;
    }
    showBusy(video ? "正在获取视频地址…" : "正在获取回放地址…");
    let mediaUrl = video ? currentJob?.videoMediaUrl : currentJob?.audioMediaUrl;
    let segmentCount = currentJob?.segmentCount || 0;
    if (!mediaUrl) {
      const resolved = await chrome.runtime.sendMessage({
        type: "resolve",
        url: urlInput.value.trim(),
        video,
      });
      if (!resolved?.ok || !resolved.mediaUrl) throw new Error(resolved?.error || "没有拿到回放地址");
      mediaUrl = resolved.mediaUrl;
      segmentCount = resolved.segmentCount || segmentCount;
    }
    setMessage(segmentCount ? `正在读取播放列表… 共 ${segmentCount} 段` : "正在读取播放列表…", "progress");
    const started = await chrome.runtime.sendMessage({
      type: "download",
      url: urlInput.value.trim(),
      video,
      mediaUrl,
      segmentCount,
      title: currentJob?.title || "",
    });
    if (!started?.ok) throw new Error(started?.error || "下载没有开始");
    if (started.job) render(started.job);
  } catch (error) {
    showFailure(error);
  }
}

downloadButton.addEventListener("click", () => {
  clickDownload(false);
});

videoButton.addEventListener("click", () => {
  clickDownload(true);
});

cancelButton.addEventListener("click", () => {
  setMessage("正在取消…", "progress");
  send("cancel").catch((error) => setMessage(error.message, "error"));
});

urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") inspectButton.click();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "job" || !message.job) return;
  render(message.job);
});

setInterval(() => {
  if (!optimistic && currentJob?.phase !== "downloading") return;
  chrome.runtime.sendMessage({ type: "get-job" }).then((response) => {
    if (!response?.job) return;
    render(response.job);
  }).catch(() => {});
}, 500);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const stored = await chrome.runtime.sendMessage({ type: "get-job" });
const tabUrl = tab?.url || "";
if (spaceIdFromText(tabUrl)) urlInput.value = tabUrl;
if (stored?.job?.phase === "downloading" || stored?.job?.phase === "inspecting") {
  render(stored.job);
} else if (urlInput.value) {
  inspectButton.click();
} else if (stored?.job) {
  if (!urlInput.value && stored.job.url) urlInput.value = stored.job.url;
  render(stored.job);
}
