import { applyI18n, t } from "./lib/i18n.js";
import { getSettings } from "./lib/settings.js";
import { spaceIdFromText } from "./lib/space-url.js";
import { renderJob, setMessage, showBusy, showFailure } from "./ui/view.js";

applyI18n(document);

const $ = (selector) => document.querySelector(selector);
const urlInput = $("#url");
const card = $("#card");
const refs = {
  title: $("#title"),
  meta: $("#meta"),
  time: $("#time"),
  inspect: $("#inspect"),
  download: $("#download"),
  video: $("#video"),
  cancel: $("#cancel"),
  bar: $("#bar"),
  fill: $("#bar-fill"),
  message: $("#message"),
};

let currentJob = null;

function render(job) {
  currentJob = job;
  if (!job?.spaceId) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  renderJob(refs, job);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function scriptUrls() {
  try {
    const tab = await activeTab();
    if (!tab?.id || !spaceIdFromText(tab.url)) return [];
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
    scriptUrls: type === "cancel" ? [] : await scriptUrls(),
    ...extra,
  });
  if (response?.job) render(response.job);
  if (!response?.ok) throw new Error(response?.error || t("requestFailed"));
  return response;
}

refs.inspect.addEventListener("click", () => {
  card.hidden = false;
  showBusy(refs, t("inspecting"));
  refs.cancel.hidden = true;
  send("inspect").catch((error) => showFailure(refs, error.message));
});

async function clickDownload(video) {
  showBusy(refs, video ? t("fetchingVideoUrl") : t("fetchingReplayUrl"));
  try {
    await send("download", { video });
  } catch (error) {
    if (currentJob?.phase !== "downloading") showFailure(refs, error.message);
    else setMessage(refs, error.message, "error");
  }
}

refs.download.addEventListener("click", () => clickDownload(false));
refs.video.addEventListener("click", () => clickDownload(true));
refs.cancel.addEventListener("click", () => {
  setMessage(refs, t("cancelling"), "progress");
  send("cancel").catch((error) => setMessage(refs, error.message, "error"));
});
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") refs.inspect.click();
});
$("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.job?.newValue) render(changes.job.newValue);
});

const [tab, stored, settings] = await Promise.all([
  activeTab(),
  chrome.runtime.sendMessage({ type: "get-job" }),
  getSettings(),
]);
$("#folder").textContent = settings.folder ? t("savedIn", settings.folder) : t("savedInRoot");
const job = stored?.job;
if (spaceIdFromText(tab?.url)) urlInput.value = tab.url;
if (job?.phase === "downloading" || job?.phase === "inspecting") {
  if (job.url) urlInput.value = job.url;
  render(job);
} else if (urlInput.value && (!job || job.spaceId !== spaceIdFromText(urlInput.value))) {
  refs.inspect.click();
} else if (job) {
  if (!urlInput.value && job.url) urlInput.value = job.url;
  render(job);
}
