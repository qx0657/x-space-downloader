// A run-scoped update (one carrying runId) only lands while that run is still downloading,
// so a late "done" can never overwrite "cancelled". Card updates without runId never
// interrupt an active download. `start: true` begins a new run.
export function nextJob(prev, partial, now = Date.now()) {
  const current = prev || {};
  const { start, ...patch } = partial;
  if (!start) {
    if (patch.runId) {
      if (current.runId !== patch.runId || current.phase !== "downloading") return null;
    } else if (current.phase === "downloading") {
      return null;
    }
  }
  return { ...current, ...patch, updatedAt: now };
}

export async function readJob() {
  const stored = await chrome.storage.session.get("job");
  return stored.job || null;
}

let queue = Promise.resolve();

export function publishJob(partial) {
  const run = queue.then(async () => {
    const prev = await readJob();
    const job = nextJob(prev, partial);
    if (!job) return prev;
    await chrome.storage.session.set({ job });
    return job;
  });
  queue = run.catch(() => {});
  return run;
}
