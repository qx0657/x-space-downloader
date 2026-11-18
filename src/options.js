import { fileBase } from "./lib/format.js";
import { applyI18n, t } from "./lib/i18n.js";
import { getSettings, normalizeSettings, saveSettings } from "./lib/settings.js";

applyI18n(document);

const form = document.querySelector("#form");
const preview = document.querySelector("#preview");
const status = document.querySelector("#status");
const SAMPLE = {
  spaceId: "1OwxWwQOPlNxQ",
  title: "Weekly AMA",
  handle: "example",
  creatorName: "Example",
  startedAt: Date.UTC(2026, 0, 15, 14, 30),
};

function read() {
  return {
    folder: form.folder.value,
    template: form.template.value,
    videoFormat: form.videoFormat.value,
    maxConcurrency: Number(form.maxConcurrency.value) || 0,
    embedMetadata: form.embedMetadata.checked,
    showPanel: form.showPanel.checked,
  };
}

function fill(settings) {
  form.folder.value = settings.folder;
  form.template.value = settings.template;
  form.videoFormat.value = settings.videoFormat;
  form.maxConcurrency.value = String(settings.maxConcurrency);
  form.embedMetadata.checked = settings.embedMetadata;
  form.showPanel.checked = settings.showPanel;
  updatePreview(settings);
}

function updatePreview(settings) {
  const path = [settings.folder, `${fileBase(SAMPLE, settings.template)}.m4a`].filter(Boolean).join("/");
  preview.textContent = t("optPreview", path);
}

let statusTimer = null;

async function persist() {
  const saved = await saveSettings(read());
  updatePreview(saved);
  status.textContent = t("optSaved");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = "";
  }, 1500);
}

form.addEventListener("input", (event) => {
  if (event.target.name === "template" || event.target.name === "folder") updatePreview(normalizeSettings(read()));
});
form.addEventListener("change", () => persist().catch((error) => (status.textContent = error.message)));
form.addEventListener("submit", (event) => event.preventDefault());

fill(await getSettings());
