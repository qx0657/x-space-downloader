export async function readJob() {
  const stored = await chrome.storage.session.get("job");
  return stored.job || null;
}

export async function publishJob(partial) {
  const prev = await readJob() || {};
  if (partial.progress) {
    if (prev.phase !== "downloading") return prev;
    if (partial.runId && prev.runId && String(prev.runId) !== String(partial.runId)) return prev;
  } else if (prev.phase === "downloading" && ["inspecting", "ready", "blocked"].includes(partial.phase)) {
    return prev;
  }
  const job = { ...prev, ...partial, updatedAt: Date.now() };
  delete job.progress;
  await chrome.storage.session.set({ job });
  chrome.runtime.sendMessage({ type: "job", job }).catch(() => {
    // 页面没打开，或上一条消息还没返回时，广播可能发不出去。
  });
  return job;
}
