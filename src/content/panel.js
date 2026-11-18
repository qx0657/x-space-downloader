import { t } from "../lib/i18n.js";
import { getSettings, normalizeSettings, saveSettings } from "../lib/settings.js";
import { spaceIdFromText } from "../lib/space-url.js";
import { renderBusyElsewhere, renderJob, showBusy, showFailure, setMessage } from "../ui/view.js";

const HOST_ID = "x-space-downloader-host";

let enabled = true;
let dismissedFor = null;
let host = null;
let refs = null;
let lastJob = null;

const currentSpaceId = () => spaceIdFromText(location.href);

function pageTheme() {
  const color = getComputedStyle(document.body).backgroundColor;
  const match = color.match(/\d+(\.\d+)?/g);
  if (!match || match.length < 3) return "dark";
  const [r, g, b] = match.map(Number);
  if (match.length >= 4 && Number(match[3]) === 0) return "dark";
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? "light" : "dark";
}

const STYLE = `
  :host { all: initial; }
  .panel {
    --bg: #0f1419; --fg: #e7e9ea; --muted: #8b98a5; --line: #2f3336; --ghost: #536471;
    display: grid; gap: 8px; padding: 12px;
    border: 1px solid var(--line); border-radius: 14px;
    background: var(--bg); color: var(--fg);
    font: 13px/1.4 "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  }
  :host([data-theme="light"]) .panel {
    --bg: #fff; --fg: #0f1419; --muted: #536471; --line: #cfd9de; --ghost: #cfd9de;
    box-shadow: 0 8px 28px rgba(15, 20, 25, 0.15);
  }
  header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  header nav { display: flex; gap: 10px; }
  strong { font-size: 13px; }
  h2 { margin: 0; font-size: 14px; line-height: 1.35; }
  p { margin: 0; color: var(--muted); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  button { border: 0; border-radius: 999px; padding: 7px 12px; font: inherit; font-weight: 700; cursor: pointer; }
  button.primary { background: #1d9bf0; color: #fff; }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--ghost); }
  button.link { background: transparent; color: var(--muted); padding: 0; font-weight: 600; }
  button:disabled { opacity: 0.45; cursor: default; }
  button:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 2px; }
  .bar { height: 6px; background: var(--line); border-radius: 99px; overflow: hidden; }
  .bar span { display: block; height: 100%; width: 0; background: #1d9bf0; transition: width 0.2s linear; }
  .bar.indeterminate span { width: 35%; animation: busy-sweep 1s ease-in-out infinite; }
  @keyframes busy-sweep { from { transform: translateX(-120%); } to { transform: translateX(320%); } }
  @media (prefers-reduced-motion: reduce) {
    .bar.indeterminate span { animation: none; width: 100%; opacity: 0.5; }
  }
  .error { color: #f4212e; }
  .ok { color: #00ba7c; }
  .progress { color: var(--fg); font-weight: 600; }
`;

function removePanel() {
  host?.remove();
  host = null;
  refs = null;
}

function buildPanel() {
  host = document.createElement("div");
  host.id = HOST_ID;
  Object.assign(host.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483646", width: "300px" });
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${STYLE}</style>
    <section class="panel" role="region" aria-label="${t("appName")}">
      <header>
        <strong>${t("appName")}</strong>
        <nav>
          <button class="link" type="button" data-hide title="${t("hideForeverHint")}">${t("hideForever")}</button>
          <button class="link" type="button" data-close>${t("close")}</button>
        </nav>
      </header>
      <h2 data-title>${t("thisSpace")}</h2>
      <p data-meta></p>
      <div class="row">
        <button class="primary" type="button" data-inspect>${t("inspect")}</button>
        <button class="primary" type="button" data-download disabled>${t("downloadAudio")}</button>
        <button class="ghost" type="button" data-video hidden>${t("downloadVideo")}</button>
        <button class="ghost" type="button" data-cancel hidden>${t("cancel")}</button>
      </div>
      <div class="bar" data-bar role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="${t("progress")}" hidden><span data-fill></span></div>
      <p data-message role="status" aria-live="polite"></p>
    </section>
  `;
  const q = (selector) => shadow.querySelector(selector);
  refs = {
    title: q("[data-title]"),
    meta: q("[data-meta]"),
    inspect: q("[data-inspect]"),
    download: q("[data-download]"),
    video: q("[data-video]"),
    cancel: q("[data-cancel]"),
    bar: q("[data-bar]"),
    fill: q("[data-fill]"),
    message: q("[data-message]"),
  };
  const on = (element, fn) =>
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      fn();
    });
  on(q("[data-close]"), () => {
    dismissedFor = currentSpaceId();
    removePanel();
  });
  on(q("[data-hide]"), () => {
    saveSettings({ showPanel: false });
    removePanel();
  });
  on(refs.inspect, inspect);
  on(refs.download, () => download(false));
  on(refs.video, () => download(true));
  on(refs.cancel, cancel);
  host.addEventListener("click", (event) => event.stopPropagation());
  document.documentElement.append(host);
}

function sync() {
  const spaceId = currentSpaceId();
  if (!enabled || !spaceId || dismissedFor === spaceId) {
    removePanel();
    return;
  }
  if (host?.isConnected && host.dataset.spaceId !== spaceId) removePanel();
  if (!host?.isConnected) {
    buildPanel();
    host.dataset.spaceId = spaceId;
    requestJob();
  }
  host.dataset.theme = pageTheme();
  if (lastJob) paint(lastJob);
}

function paint(job) {
  lastJob = job;
  const spaceId = currentSpaceId();
  if (!refs || !job || !spaceId) return;
  if (job.spaceId === spaceId) {
    renderJob(refs, job);
  } else if (job.phase === "downloading") {
    renderBusyElsewhere(refs, job);
  }
}

function send(message, ms = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t("backgroundTimeout"))), ms);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

const scriptUrls = () => [...document.scripts].map((script) => script.src).filter(Boolean);

async function request(type, extra = {}) {
  const response = await send({ type, url: location.href, scriptUrls: scriptUrls(), ...extra });
  if (response?.job) paint(response.job);
  if (!response?.ok) throw new Error(response?.error || t("requestFailed"));
  return response;
}

function requestJob() {
  send({ type: "get-job" }, 5000)
    .then((response) => response?.job && paint(response.job))
    .catch(() => {});
}

function inspect() {
  if (!refs) return;
  showBusy(refs, t("inspecting"));
  refs.cancel.hidden = true;
  request("inspect").catch((error) => refs && showFailure(refs, error.message));
}

async function download(video) {
  if (!refs) return;
  showBusy(refs, video ? t("fetchingVideoUrl") : t("fetchingReplayUrl"));
  try {
    await request("download", { video });
  } catch (error) {
    if (refs) showFailure(refs, error.message);
  }
}

function cancel() {
  if (refs) setMessage(refs, t("cancelling"), "progress");
  request("cancel", { scriptUrls: [] }).catch((error) => refs && showFailure(refs, error.message));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "collect-scripts") {
    sendResponse({ urls: scriptUrls() });
    return false;
  }
  if (message?.type === "job" && message.job) paint(message.job);
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  enabled = normalizeSettings(changes.settings.newValue).showPanel;
  sync();
});

globalThis.navigation?.addEventListener?.("currententrychange", () => setTimeout(sync, 0));
addEventListener("popstate", sync);
// 兜底：只在本页做字符串比较，不会唤醒后台。
let lastHref = location.href;
setInterval(() => {
  if (location.href === lastHref) return;
  lastHref = location.href;
  sync();
}, 2000);
// X 切换主题时只改 body 的背景色，不触发导航。
new MutationObserver(() => host && (host.dataset.theme = pageTheme())).observe(document.body, {
  attributes: true,
  attributeFilter: ["style", "class"],
});

getSettings()
  .then((settings) => {
    enabled = settings.showPanel;
  })
  .catch(() => {})
  .finally(sync);
