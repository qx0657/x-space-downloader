import { audioSaveName } from "./lib/format.js";
import { deletePendingFile, readPendingFile } from "./lib/idb-file.js";

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

async function finish(result) {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "save-result", ...result }, () => resolve());
  });
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) chrome.tabs.remove(tab.id);
}

try {
  if (!chrome.downloads?.download) throw new Error("这个页面不能保存文件");
  const stored = await chrome.storage.session.get("pendingSave");
  const filename = audioSaveName(stored.pendingSave?.filename || "X-Spaces/space.m4a", "");
  const blob = await readPendingFile();
  if (!blob) throw new Error("没有找到已合成的录音");
  const file = /\.m4a$/i.test(filename) ? blob.slice(0, blob.size, "application/octet-stream") : blob;
  const url = URL.createObjectURL(file);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
    });
    await waitForDownload(downloadId);
    const [item] = await chrome.downloads.search({ id: downloadId });
    await deletePendingFile();
    await chrome.storage.session.remove("pendingSave");
    await finish({ ok: true, filename: item?.filename || filename });
  } finally {
    URL.revokeObjectURL(url);
  }
} catch (error) {
  await finish({ ok: false, error: error?.message || "保存失败" });
}
