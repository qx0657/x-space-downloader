// Segment storage for one download run. Segments are written as separate files so an
// interrupted download can resume, and the final file is a Blob of disk-backed parts so
// a multi-gigabyte recording never has to sit in memory.

const RUNS_DIR = "runs";
const META = "meta.json";

function sameSignature(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function createMemoryStore() {
  let signature = null;
  const segments = new Map();
  const outputs = new Map();
  return {
    async prepare(next) {
      if (!sameSignature(signature, next)) {
        segments.clear();
        outputs.clear();
      }
      signature = next;
    },
    async completed() {
      return new Set(segments.keys());
    },
    async put(index, bytes) {
      segments.set(index, bytes.slice());
    },
    async get(index) {
      return segments.get(index);
    },
    async segmentFile(index) {
      return new Blob([segments.get(index)]);
    },
    async writer(name) {
      const chunks = [];
      return {
        async write(bytes) {
          chunks.push(bytes.slice());
        },
        async close() {
          outputs.set(name, new Blob(chunks));
        },
      };
    },
    async file(name) {
      return outputs.get(name);
    },
    async destroy() {
      segments.clear();
      outputs.clear();
    },
  };
}

async function runsRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RUNS_DIR, { create: true });
}

async function readMeta(dir) {
  try {
    const handle = await dir.getFileHandle(META);
    return JSON.parse(await (await handle.getFile()).text());
  } catch {
    return null;
  }
}

async function writeFile(dir, name, data) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

const segmentName = (index) => `s${String(index).padStart(6, "0")}`;

export async function createOpfsStore(key) {
  const root = await runsRoot();
  let dir = await root.getDirectoryHandle(key, { create: true });

  async function touch(signature) {
    await writeFile(dir, META, JSON.stringify({ signature, updatedAt: Date.now() }));
  }

  return {
    async prepare(signature) {
      const meta = await readMeta(dir);
      if (meta && !sameSignature(meta.signature, signature)) {
        await root.removeEntry(key, { recursive: true });
        dir = await root.getDirectoryHandle(key, { create: true });
      }
      await touch(signature);
    },
    async completed() {
      const done = new Set();
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "file" || !/^s\d{6}$/.test(name)) continue;
        // createWritable() only commits on close(), so any segment file that exists is whole.
        done.add(Number(name.slice(1)));
      }
      return done;
    },
    async put(index, bytes) {
      await writeFile(dir, segmentName(index), bytes);
    },
    async get(index) {
      const handle = await dir.getFileHandle(segmentName(index));
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    },
    async segmentFile(index) {
      return (await dir.getFileHandle(segmentName(index))).getFile();
    },
    async writer(name) {
      const handle = await dir.getFileHandle(`out-${name}`, { create: true });
      const writable = await handle.createWritable();
      return {
        write: (bytes) => writable.write(bytes),
        close: () => writable.close(),
      };
    },
    async file(name) {
      return (await dir.getFileHandle(`out-${name}`)).getFile();
    },
    async destroy() {
      await root.removeEntry(key, { recursive: true }).catch(() => {});
    },
  };
}

export async function removeOpfsStore(key) {
  const root = await runsRoot();
  await root.removeEntry(key, { recursive: true }).catch(() => {});
}

export async function cleanupOpfsStores(maxAgeMs, keep = "") {
  const root = await runsRoot();
  const now = Date.now();
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== "directory" || name === keep) continue;
    const meta = await readMeta(handle);
    if (!meta || now - (meta.updatedAt || 0) > maxAgeMs) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  }
}
