const HOST_ID = "x-space-downloader-host";

function spaceIdFromLocation(href) {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    if (!["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"].includes(host)) return null;
    const match = url.pathname.match(/\/i\/spaces\/([0-9A-Za-z]{13,})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  return `${minutes}:${pad(secs)}`;
}

function stateLabel(state, replay) {
  if (state === "Running") return "直播中";
  if (state === "NotStarted") return "未开始";
  if (state === "Ended" || state === "TimedOut") return replay ? "已结束 · 有回放" : "已结束 · 无回放";
  return state || "";
}

let dismissedFor = null;
let host = null;
let refs = null;
let optimistic = false;
let holdUntil = 0;
let painted = null;

function ensurePanel() {
  const spaceId = spaceIdFromLocation(location.href);
  if (!spaceId || dismissedFor === spaceId) {
    host?.remove();
    host = null;
    refs = null;
    return null;
  }
  if (host?.isConnected) return spaceId;
  host = document.createElement("div");
  host.id = HOST_ID;
  host.style.position = "fixed";
  host.style.right = "16px";
  host.style.bottom = "16px";
  host.style.zIndex = "2147483646";
  host.style.width = "300px";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        display: grid;
        gap: 8px;
        padding: 12px;
        border: 1px solid #2f3336;
        border-radius: 14px;
        background: #0f1419;
        color: #e7e9ea;
        font: 13px/1.4 "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
      }
      header { display: flex; justify-content: space-between; align-items: center; }
      strong { font-size: 13px; }
      h2 { margin: 0; font-size: 14px; line-height: 1.35; }
      p { margin: 0; color: #8b98a5; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
      button {
        border: 0;
        border-radius: 999px;
        padding: 7px 12px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      button.primary { background: #1d9bf0; color: #fff; }
      button.ghost { background: transparent; color: #e7e9ea; border: 1px solid #536471; }
      button.link { background: transparent; color: #8b98a5; padding: 0; }
      button:disabled { opacity: 0.45; cursor: default; }
      .bar { height: 6px; background: #2f3336; border-radius: 99px; overflow: hidden; }
      .bar span { display: block; height: 100%; width: 0; background: #1d9bf0; transition: width 0.2s linear; }
      .bar.indeterminate span { width: 35%; animation: xspace-slide 1s ease-in-out infinite; }
      @keyframes xspace-slide { from { transform: translateX(-120%); } to { transform: translateX(320%); } }
      .error { color: #f4212e; }
      .ok { color: #00ba7c; }
      .progress { color: #e7e9ea; font-weight: 600; }
    </style>
    <section class="panel">
      <header>
        <strong>X Space 录音</strong>
        <button class="link" type="button" data-close>关闭</button>
      </header>
      <h2 data-title>这场 Space</h2>
      <p data-meta></p>
      <div class="row">
        <button class="primary" type="button" data-inspect>解析</button>
        <button class="primary" type="button" data-download disabled>下载录音</button>
        <button class="ghost" type="button" data-video hidden>下载视频</button>
        <button class="ghost" type="button" data-cancel hidden>取消</button>
      </div>
      <div class="bar" data-bar hidden><span data-fill></span></div>
      <p data-message></p>
    </section>
  `;
  refs = {
    title: shadow.querySelector("[data-title]"),
    meta: shadow.querySelector("[data-meta]"),
    inspect: shadow.querySelector("[data-inspect]"),
    download: shadow.querySelector("[data-download]"),
    video: shadow.querySelector("[data-video]"),
    cancel: shadow.querySelector("[data-cancel]"),
    bar: shadow.querySelector("[data-bar]"),
    fill: shadow.querySelector("[data-fill]"),
    message: shadow.querySelector("[data-message]"),
  };
  shadow.querySelector("[data-close]").addEventListener("click", () => {
    dismissedFor = spaceIdFromLocation(location.href);
    host.remove();
    host = null;
  });
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  refs.inspect.addEventListener("click", (event) => {
    stop(event);
    ask("inspect");
  });
  refs.download.addEventListener("click", (event) => {
    stop(event);
    clickDownload(false);
  });
  refs.video.addEventListener("click", (event) => {
    stop(event);
    clickDownload(true);
  });
  refs.cancel.addEventListener("click", (event) => {
    stop(event);
    ask("cancel");
  });
  host.addEventListener("click", stop);
  document.documentElement.append(host);
  if (painted?.spaceId === spaceId) paint(painted);
  return spaceId;
}

function scriptUrls() {
  return [...document.scripts].map((script) => script.src).filter(Boolean);
}

function showPreparing(text) {
  if (!refs) return;
  refs.inspect.disabled = true;
  refs.download.hidden = true;
  refs.video.hidden = true;
  refs.cancel.hidden = false;
  refs.bar.hidden = false;
  refs.bar.classList.add("indeterminate");
  refs.fill.style.width = "35%";
  showMessage(text, "progress");
}

function beginLocal(text) {
  optimistic = true;
  holdUntil = Date.now();
  showPreparing(text);
}

function failLocal(text) {
  optimistic = false;
  if (!refs) return;
  refs.inspect.disabled = false;
  refs.download.hidden = false;
  refs.cancel.hidden = true;
  refs.bar.hidden = true;
  refs.bar.classList.remove("indeterminate");
  showMessage(text, "error");
}

function sendWithTimeout(message, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("后台没有响应，请重试")), ms);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function keepAlive() {
  if (keepAlive.port) return;
  try {
    keepAlive.port = chrome.runtime.connect({ name: "space-download" });
    keepAlive.port.onDisconnect.addListener(() => {
      keepAlive.port = null;
    });
  } catch {
    keepAlive.port = null;
  }
}

async function clickDownload(video) {
  const spaceId = spaceIdFromLocation(location.href);
  if (!spaceId) return;
  optimistic = false;
  keepAlive();
  showPreparing("正在检查已合成的录音…");
  try {
    const reused = await sendWithTimeout({
      type: "save-pending",
      url: location.href,
      title: painted?.title || "",
    }, 180000);
    if (reused?.saved || reused?.already) {
      if (reused.job) paint(reused.job);
      return;
    }
    showPreparing(video ? "正在获取视频地址…" : "正在获取回放地址…");
    let mediaUrl = painted?.spaceId === spaceId ? (video ? painted.videoMediaUrl : painted.audioMediaUrl) : "";
    let segmentCount = painted?.spaceId === spaceId ? (painted.segmentCount || 0) : 0;
    if (!mediaUrl) {
      const resolved = await sendWithTimeout({
        type: "resolve",
        url: location.href,
        video: Boolean(video),
      }, 15000);
      if (!resolved?.ok || !resolved.mediaUrl) throw new Error(resolved?.error || "没有拿到回放地址");
      mediaUrl = resolved.mediaUrl;
      segmentCount = resolved.segmentCount || segmentCount;
      if (resolved.title && painted) painted = { ...painted, title: resolved.title, segmentCount };
    }
    showMessage(segmentCount ? `正在读取播放列表… 共 ${segmentCount} 段` : "正在读取播放列表…", "progress");
    const started = await sendWithTimeout({
      type: "download",
      url: location.href,
      video: Boolean(video),
      mediaUrl,
      segmentCount,
      title: painted?.title || "",
    }, 10000);
    if (!started?.ok) throw new Error(started?.error || "下载没有开始");
    if (started.job) paint(started.job);
  } catch (error) {
    failLocal(error.message || "下载没有开始");
  }
}

function ask(type, extra = {}) {
  const spaceId = spaceIdFromLocation(location.href);
  if (!spaceId && type !== "cancel") return;
  if (type === "cancel") showMessage("正在取消…", "progress");
  sendWithTimeout({
    type,
    url: location.href,
    scriptUrls: type === "inspect" ? scriptUrls() : [],
    ...extra,
  }, 20000).then((response) => {
    if (response?.job) paint(response.job);
    else if (!response?.ok) failLocal(response?.error || "请求失败");
  }).catch((error) => failLocal(error.message || "请求失败"));
}

function showMessage(text, kind) {
  if (!refs) return;
  refs.message.textContent = text || "";
  refs.message.className = kind || "";
}

function renderJob(job) {
  if (!job) return;
  const spaceId = ensurePanel();
  if (!spaceId || !refs || job.spaceId !== spaceId) return;
  paint(job);
}

function paint(job) {
  if (!refs) return;
  painted = job;
  refs.title.textContent = job.title || "这场 Space";
  const who = job.handle ? `@${job.handle}` : (job.creatorName || "");
  const duration = formatDuration(job.durationSeconds);
  refs.meta.textContent = [who, stateLabel(job.state, job.replay), duration].filter(Boolean).join(" · ");
  if (job.phase === "downloading") keepAlive();
  if (job.phase === "downloading" || job.phase === "done" || job.phase === "error" || job.phase === "cancelled") {
    optimistic = false;
  }
  const busy = job.phase === "inspecting" || job.phase === "downloading";
  refs.inspect.disabled = busy;
  refs.download.disabled = busy || !job.canDownload;
  refs.download.hidden = job.phase === "downloading";
  refs.cancel.hidden = job.phase !== "downloading";
  refs.video.hidden = !job.videoAvailable || job.phase === "downloading";
  refs.video.disabled = busy || !job.canDownload;
  const showBar = job.phase === "downloading" || job.phase === "done";
  refs.bar.hidden = !showBar;
  const completed = job.completed || 0;
  const indeterminate = job.phase === "downloading" && !completed;
  refs.bar.classList.toggle("indeterminate", indeterminate);
  const pct = job.total
    ? (job.phase === "done"
      ? 100
      : (completed ? Math.max(1, Math.min(99, Math.round((100 * completed) / job.total))) : 0))
    : 0;
  refs.fill.style.width = indeterminate ? "35%" : `${pct}%`;
  if (job.phase === "error") showMessage(job.message || "解析失败", "error");
  else if (job.phase === "done") showMessage(job.filename ? `已保存 ${job.filename}` : "已保存到下载文件夹", "ok");
  else if (job.phase === "downloading") showMessage(job.message || "正在下载…", "progress");
  else showMessage(job.message || "", "");
}

async function syncJob() {
  if (!host?.isConnected || !refs) return;
  const spaceId = spaceIdFromLocation(location.href);
  if (!spaceId) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-job" });
    const job = response?.job;
    if (!job || job.spaceId !== spaceId) return;
    renderJob(job);
  } catch {
    // 后台暂时没起来时，下一秒再同步。
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "collect-scripts") {
    sendResponse({ urls: scriptUrls() });
    return false;
  }
  if (message?.type === "job") renderJob(message.job);
  return false;
});

setInterval(() => {
  try {
    ensurePanel();
    syncJob();
  } catch {
    // 页面结构变化时不要影响 X 本身。
  }
}, 1000);

ensurePanel();
syncJob();
