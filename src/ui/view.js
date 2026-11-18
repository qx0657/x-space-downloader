import { formatBytes, formatClock, formatDuration, progressPercent, stateLabel } from "../lib/format.js";
import { t } from "../lib/i18n.js";

// refs: { title, meta, time?, inspect, download, video, cancel, bar, fill, message }

export function setMessage(refs, text, kind = "") {
  refs.message.textContent = text || "";
  refs.message.className = kind;
}

function setBar(refs, { hidden, indeterminate = false, pct = 0 }) {
  refs.bar.hidden = hidden;
  refs.bar.classList.toggle("indeterminate", indeterminate);
  refs.fill.style.width = indeterminate ? "35%" : `${pct}%`;
  if (indeterminate) refs.bar.removeAttribute("aria-valuenow");
  else refs.bar.setAttribute("aria-valuenow", String(pct));
}

export function showBusy(refs, text) {
  refs.inspect.disabled = true;
  refs.download.hidden = true;
  refs.video.hidden = true;
  refs.cancel.hidden = false;
  setBar(refs, { hidden: false, indeterminate: true });
  setMessage(refs, text, "progress");
}

export function showFailure(refs, text) {
  refs.inspect.disabled = false;
  refs.download.hidden = false;
  refs.cancel.hidden = true;
  setBar(refs, { hidden: true });
  setMessage(refs, text, "error");
}

export function describeJob(job) {
  const who = job.handle ? `@${job.handle}` : job.creatorName || "";
  const meta = [who, stateLabel(job.state, job.replay)].filter(Boolean).join(" · ");
  const time = [
    formatClock(job.startedAt),
    formatDuration(job.durationSeconds),
    job.segmentCount ? t("segments", job.segmentCount) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { meta, time };
}

export function renderJob(refs, job) {
  refs.title.textContent = job.title || t("thisSpace");
  const { meta, time } = describeJob(job);
  if (refs.time) {
    refs.meta.textContent = meta;
    refs.time.textContent = time;
  } else {
    refs.meta.textContent = [meta, formatDuration(job.durationSeconds)].filter(Boolean).join(" · ");
  }

  const busy = job.phase === "inspecting" || job.phase === "downloading";
  refs.inspect.disabled = busy;
  refs.download.disabled = busy || !job.canDownload;
  refs.download.hidden = job.phase === "downloading";
  refs.cancel.hidden = job.phase !== "downloading";
  refs.video.hidden = !job.videoAvailable || job.phase === "downloading";
  refs.video.disabled = busy || !job.canDownload;
  const estimate = formatBytes(job.videoBytesEstimate);
  refs.video.textContent = estimate ? t("downloadVideoSize", estimate) : t("downloadVideo");

  const indeterminate = job.phase === "downloading" && !job.completed;
  setBar(refs, {
    hidden: job.phase !== "downloading" && job.phase !== "done",
    indeterminate,
    pct: progressPercent(job),
  });

  if (job.phase === "error") setMessage(refs, job.message || t("inspectFailed"), "error");
  else if (job.phase === "cancelled") setMessage(refs, job.message || t("cancelledDownload"));
  else if (job.phase === "done")
    setMessage(refs, job.filename ? t("savedAs", job.filename) : t("savedToDownloads"), "ok");
  else if (job.phase === "downloading") setMessage(refs, job.message || t("downloading"), "progress");
  else if (job.phase === "blocked") setMessage(refs, job.message || t("noRecording"));
  else setMessage(refs, job.message || "");
}

// Another Space is downloading: keep this card but lock its buttons and say why.
export function renderBusyElsewhere(refs, job) {
  refs.inspect.disabled = true;
  refs.download.disabled = true;
  refs.video.disabled = true;
  refs.cancel.hidden = true;
  setBar(refs, { hidden: true });
  const pct = progressPercent(job);
  setMessage(refs, t("busyElsewhere", job.title || job.spaceId, pct), "progress");
}
