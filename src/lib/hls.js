import { asSpaceError, SpaceError } from "./errors.js";
import { t } from "./i18n.js";
import { assertMediaUrl, fetchWithTimeout, retryableError, sleep } from "./net.js";
import { createAacCollector, m4aHeader } from "./m4a.js";
import { createMemoryStore } from "./store.js";
import { extractAdtsFromTs } from "./ts-audio.js";

const VIDEO_CODECS = /avc1|hev1|hvc1|vp09|vp9|av01/i;
const MAX_SEGMENT_TRIES = 4;

export function isAudioOnly(codecs = "") {
  return /mp4a|aac/i.test(codecs) && !VIDEO_CODECS.test(codecs);
}

export function parseAttributeList(input) {
  const attrs = {};
  const pattern = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi;
  for (const match of input.matchAll(pattern)) {
    attrs[match[1].toUpperCase()] = match[3] != null ? match[3] : match[4];
  }
  return attrs;
}

function parseByteRange(value, previous) {
  if (!value) return null;
  const [lengthText, offsetText] = String(value).split("@");
  const length = Number(lengthText);
  const offset = offsetText != null ? Number(offsetText) : previous ? previous.offset + previous.length : 0;
  if (!Number.isFinite(length) || length < 0 || !Number.isFinite(offset) || offset < 0) return null;
  return { length, offset };
}

function parseIv(value) {
  if (!value) return null;
  const hex = String(value).replace(/^0x/i, "");
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length > 32) return null;
  const padded = hex.padStart(32, "0");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function parsePlaylist(text, playlistUrl) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const variants = [];
  const renditions = [];
  const segments = [];
  let pendingDuration = null;
  let pendingRange = null;
  let lastRange = null;
  let map = null;
  let key = { method: "NONE" };
  let endList = false;
  let mediaSequence = 0;
  let targetDuration = 0;
  let playlistType = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributeList(line.slice("#EXT-X-STREAM-INF:".length));
      const uri = lines[i + 1];
      if (uri && !uri.startsWith("#")) {
        variants.push({
          url: new URL(uri, playlistUrl).href,
          bandwidth: Number(attrs.BANDWIDTH) || 0,
          codecs: attrs.CODECS || "",
          resolution: attrs.RESOLUTION || "",
        });
        i += 1;
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributeList(line.slice("#EXT-X-MEDIA:".length));
      renditions.push({
        type: (attrs.TYPE || "").toUpperCase(),
        uri: attrs.URI ? new URL(attrs.URI, playlistUrl).href : "",
        codecs: attrs.CODECS || "",
        name: attrs.NAME || "",
        default: attrs.DEFAULT === "YES",
      });
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number(line.slice("#EXTINF:".length).split(",")[0]) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = parseByteRange(line.slice("#EXT-X-BYTERANGE:".length), lastRange);
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributeList(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) {
        map = {
          url: new URL(attrs.URI, playlistUrl).href,
          byterange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, null) : null,
        };
      }
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributeList(line.slice("#EXT-X-KEY:".length));
      key = {
        method: (attrs.METHOD || "NONE").toUpperCase(),
        uri: attrs.URI ? new URL(attrs.URI, playlistUrl).href : "",
        iv: parseIv(attrs.IV),
      };
      continue;
    }
    if (line.startsWith("#EXT-X-ENDLIST")) {
      endList = true;
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
      playlistType = line.split(":")[1] || "";
      continue;
    }
    if (line.startsWith("#") || pendingDuration == null) continue;
    const byterange = pendingRange;
    if (byterange) lastRange = byterange;
    segments.push({
      url: new URL(line, playlistUrl).href,
      duration: pendingDuration,
      byterange,
      key: key.method === "NONE" ? null : { ...key },
      sequence: mediaSequence + segments.length,
    });
    pendingDuration = null;
    pendingRange = null;
  }

  const durationSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);
  return {
    kind: variants.length > 0 && segments.length === 0 ? "master" : "media",
    url: playlistUrl,
    variants,
    renditions,
    segments,
    map,
    endList,
    mediaSequence,
    targetDuration,
    playlistType,
    durationSeconds,
    codecs: "",
    bandwidth: 0,
  };
}

const highest = (list) => [...list].sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
const lowest = (list) => [...list].sort((a, b) => a.bandwidth - b.bandwidth)[0] || null;

export function selectPlaylistTarget(parsed, mode) {
  if (parsed.kind === "media") {
    return { url: parsed.url, bandwidth: parsed.bandwidth || 0, codecs: parsed.codecs || "", resolution: "" };
  }
  if (mode !== "video") {
    const audio = parsed.renditions.filter((item) => item.type === "AUDIO" && item.uri);
    const chosen = audio.find((item) => item.default) || audio[0];
    if (chosen) return { url: chosen.uri, bandwidth: 0, codecs: chosen.codecs || "mp4a", resolution: "" };
    const audioVariants = parsed.variants.filter((item) => isAudioOnly(item.codecs));
    if (audioVariants.length) return highest(audioVariants);
    return lowest(parsed.variants);
  }
  return highest(parsed.variants);
}

export async function fetchText(url, signal) {
  assertMediaUrl(url);
  const response = await fetchWithTimeout(url, { signal, credentials: "omit", headers: { accept: "*/*" } });
  if (response.status === 401 || response.status === 403) {
    throw new SpaceError("expired", t("playlistHttp", response.status));
  }
  if (!response.ok) throw new SpaceError("http", t("playlistHttp", response.status));
  return response.text();
}

export async function resolveMedia(entryUrl, mode, readText = fetchText) {
  let url = entryUrl;
  let codecs = "";
  let bandwidth = 0;
  for (let depth = 0; depth < 4; depth += 1) {
    const parsed = parsePlaylist(await readText(url), url);
    if (parsed.kind === "media") return { ...parsed, codecs, bandwidth };
    const target = selectPlaylistTarget(parsed, mode);
    if (!target?.url) throw new SpaceError("playlist", t("playlistNoAudio"));
    url = target.url;
    codecs = target.codecs || codecs;
    bandwidth = target.bandwidth || bandwidth;
  }
  throw new SpaceError("playlist", t("playlistNested"));
}

export function mediaKind(media) {
  if (media.map) return "fmp4";
  const sample = media.segments[0]?.url || "";
  if (/\.ts($|\?)/i.test(sample)) return "ts";
  if (/\.aac($|\?)/i.test(sample)) return "aac";
  if (/\.(m4s|mp4|cmfv|cmfa)($|\?)/i.test(sample)) return "fmp4";
  if (VIDEO_CODECS.test(media.codecs || "")) return "fmp4";
  return "unknown";
}

async function fetchBytes(url, { signal, byterange } = {}) {
  assertMediaUrl(url);
  const headers = { accept: "*/*" };
  if (byterange) headers.range = `bytes=${byterange.offset}-${byterange.offset + byterange.length - 1}`;
  const response = await fetchWithTimeout(url, { signal, credentials: "omit", headers });
  if (response.status === 401 || response.status === 403) {
    throw new SpaceError("expired", t("segmentHttp", response.status));
  }
  if (response.status === 429 || response.status >= 500) {
    throw new SpaceError("retry", t("segmentHttp", response.status));
  }
  if (!response.ok) throw new SpaceError("http", t("segmentHttp", response.status));
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchBytesWithRetry(url, options) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchBytes(url, options);
    } catch (error) {
      if (!retryableError(error) || attempt >= MAX_SEGMENT_TRIES) throw error;
      await sleep(400 * attempt);
    }
  }
}

function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  let value = BigInt(sequence);
  for (let i = 15; i >= 0; i -= 1) {
    iv[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return iv;
}

async function decryptSegment(bytes, segment, keyCache, signal) {
  if (!segment.key || segment.key.method === "NONE") return bytes;
  if (segment.key.method !== "AES-128") throw new SpaceError("encrypted", t("encryptedUnsupported"));
  let key = keyCache.get(segment.key.uri);
  if (!key) {
    key = fetchBytesWithRetry(segment.key.uri, { signal }).then((raw) =>
      crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]),
    );
    keyCache.set(segment.key.uri, key);
    key.catch(() => keyCache.delete(segment.key.uri));
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: segment.key.iv || sequenceIv(segment.sequence) },
    await key,
    bytes,
  );
  return new Uint8Array(plain);
}

export function sniff(data) {
  if (!data) return "unknown";
  if (data.length >= 3 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return "aac";
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return "aac";
  if (data.length >= 188 && data[0] === 0x47 && data.length % 188 === 0) return "ts";
  if (data.length >= 8) {
    const brand = String.fromCharCode(data[4], data[5], data[6], data[7]);
    if (brand === "ftyp" || brand === "styp" || brand === "moof") return "fmp4";
  }
  return "unknown";
}

function fmp4HasVideo(init, codecs) {
  if (VIDEO_CODECS.test(codecs || "")) return true;
  const head = init.subarray(0, Math.min(init.length, 8192));
  return /avc1|hvc1|hev1|vp09|av01/.test(new TextDecoder("latin1").decode(head));
}

export function deviceConcurrency(env = globalThis.navigator || {}, maxOverride = 0) {
  const cores = env.hardwareConcurrency || 4;
  const memory = env.deviceMemory || 4;
  const net = env.connection || {};
  let start = cores >= 12 ? 10 : cores >= 8 ? 8 : cores >= 4 ? 5 : 3;
  let max = Math.min(24, Math.max(start + 2, cores * 3));
  if (memory <= 2) {
    start = Math.min(start, 3);
    max = Math.min(max, 4);
  } else if (memory <= 4) {
    max = Math.min(max, 8);
  }
  if (net.effectiveType === "slow-2g" || net.effectiveType === "2g") {
    start = 2;
    max = 3;
  } else if (net.effectiveType === "3g") {
    start = Math.min(start, 4);
    max = Math.min(max, 6);
  } else if (typeof net.downlink === "number" && net.downlink >= 20) {
    start = Math.max(start, 8);
    max = Math.max(max, 16);
  }
  if (maxOverride > 0) max = maxOverride;
  const min = Math.min(2, max);
  return { start: Math.max(min, Math.min(start, max)), min, max };
}

// Runs `worker` over `items` with a concurrency limit that grows while responses are fast
// and shrinks on slow or failed requests. Retryable failures go back to the queue; an
// expired signature triggers one shared `refresh()` before the item is tried again.
async function adaptiveMap(items, worker, { limits, onTune, refresh }) {
  let limit = limits.start;
  const queue = items.map((item) => ({ item, tries: 0, refreshed: false }));
  let inflight = 0;
  let waiting = 0;
  let failure = null;
  const samples = [];
  let sinceBump = 0;
  onTune?.(limit);

  await new Promise((resolve, reject) => {
    const tune = (next) => {
      if (next === limit) return;
      limit = next;
      sinceBump = 0;
      onTune?.(limit);
    };
    const requeueLater = (job, ms, before = () => {}) => {
      waiting += 1;
      Promise.resolve()
        .then(() => sleep(ms))
        .then(before)
        .then(
          () => queue.unshift(job),
          (error) => {
            if (!failure) failure = error;
          },
        )
        .finally(() => {
          waiting -= 1;
          pump();
        });
    };
    const pump = () => {
      if (failure) {
        if (inflight === 0 && waiting === 0) reject(failure);
        return;
      }
      if (queue.length === 0 && inflight === 0 && waiting === 0) {
        resolve();
        return;
      }
      while (inflight < limit && queue.length > 0) {
        const job = queue.shift();
        inflight += 1;
        const began = Date.now();
        worker(job.item).then(
          () => {
            inflight -= 1;
            samples.push(Date.now() - began);
            if (samples.length > 8) samples.shift();
            const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
            sinceBump += 1;
            if (sinceBump >= 6 && average < 700 && limit < limits.max) tune(Math.min(limits.max, limit + 2));
            else if (average > 2500 && limit > limits.min) tune(limit - 1);
            pump();
          },
          (error) => {
            inflight -= 1;
            if (error?.code === "expired" && refresh && !job.refreshed) {
              job.refreshed = true;
              requeueLater(job, 0, refresh);
            } else if (retryableError(error) && job.tries < MAX_SEGMENT_TRIES - 1) {
              job.tries += 1;
              tune(Math.max(limits.min, Math.floor(limit * 0.6)));
              requeueLater(job, 500 * job.tries);
            } else if (!failure) {
              failure = error;
            }
            pump();
          },
        );
      }
    };
    pump();
  });
}

function segmentName(url) {
  try {
    return new URL(url).pathname.split("/").pop();
  } catch {
    return "";
  }
}

export async function downloadRecording(entryUrl, options = {}) {
  const {
    mode = "audio",
    signal,
    onProgress,
    maxSegments = Infinity,
    store = createMemoryStore(),
    refreshMedia,
    metadata = null,
    createRemuxer = null,
    limits = deviceConcurrency(),
  } = options;
  try {
    onProgress?.({ phase: "playlist", completed: 0, total: 0 });
    const readText = (url) => fetchText(url, signal);
    const media = await resolveMedia(entryUrl, mode, readText);
    if (!media.endList) throw new SpaceError("live", t("replayNotReady"));
    if (!media.segments.length) throw new SpaceError("empty", t("playlistEmpty"));
    if (media.segments.length > 20000) throw new SpaceError("playlist", t("playlistTooLong"));
    const count = Number.isFinite(maxSegments) ? Math.max(0, maxSegments) : media.segments.length;
    const segments = media.segments.slice(0, count).map((segment) => ({ ...segment }));
    if (!segments.length) throw new SpaceError("empty", t("noSegments"));
    const total = segments.length;

    await store.prepare({
      mode,
      total,
      first: segmentName(segments[0].url),
      last: segmentName(segments[total - 1].url),
    });
    const done = await store.completed();
    let completed = done.size;
    let lanes = limits.start;
    const report = () => onProgress?.({ phase: "segment", completed, total, concurrency: lanes });
    report();

    let refreshing = null;
    const refresh = refreshMedia
      ? () => {
          refreshing ||= (async () => {
            const fresh = await resolveMedia(await refreshMedia(), mode, readText);
            if (fresh.segments.length < total) throw new SpaceError("playlist", t("playlistChanged"));
            segments.forEach((segment, index) => {
              segment.url = fresh.segments[index].url;
              segment.key = fresh.segments[index].key;
            });
            if (fresh.map) media.map = fresh.map;
          })();
          return refreshing;
        }
      : null;

    const keyCache = new Map();
    const missing = segments.map((_, index) => index).filter((index) => !done.has(index));
    await adaptiveMap(
      missing,
      async (index) => {
        const segment = segments[index];
        let bytes = await fetchBytes(segment.url, { signal, byterange: segment.byterange });
        bytes = await decryptSegment(bytes, segment, keyCache, signal);
        if (mode !== "video" && sniff(bytes) === "ts") bytes = extractAdtsFromTs(bytes);
        await store.put(index, bytes);
        completed += 1;
        report();
      },
      {
        limits,
        refresh,
        onTune: (limit) => {
          lanes = limit;
          report();
        },
      },
    );

    const durationSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);
    return await assemble({ media, total, store, mode, signal, onProgress, metadata, createRemuxer, durationSeconds });
  } catch (error) {
    throw asSpaceError(error);
  }
}

async function segmentFiles(store, total) {
  const files = [];
  for (let i = 0; i < total; i += 1) files.push(await store.segmentFile(i));
  return files;
}

async function assembleAac({ store, total, onProgress, metadata, signal }) {
  const collector = createAacCollector();
  const writer = await store.writer("body");
  try {
    for (let i = 0; i < total; i += 1) {
      if (signal?.aborted) throw new SpaceError("cancelled", t("cancelled"));
      const raw = collector.push(await store.get(i));
      if (raw) await writer.write(raw);
      onProgress?.({ phase: "mux", completed: i + 1, total });
    }
  } finally {
    await writer.close();
  }
  const summary = collector.finish();
  const blob = new Blob([m4aHeader(summary, metadata), await store.file("body")], {
    type: "application/octet-stream",
  });
  return { blob, extension: "m4a", mime: "audio/mp4", durationSeconds: summary.durationSeconds, segmentCount: total };
}

async function remuxTs({ store, total, onProgress, signal, createRemuxer }) {
  const remuxer = createRemuxer();
  const writer = await store.writer("video");
  try {
    for (let i = 0; i < total; i += 1) {
      if (signal?.aborted) throw new SpaceError("cancelled", t("cancelled"));
      for (const piece of remuxer.push(await store.get(i))) await writer.write(piece);
      onProgress?.({ phase: "mux", completed: i + 1, total });
    }
  } finally {
    await writer.close();
  }
  if (!remuxer.init) throw new SpaceError("video", t("remuxFailed"));
  return new Blob([remuxer.init, await store.file("video")], { type: "video/mp4" });
}

async function assemble({ media, total, store, mode, signal, onProgress, metadata, createRemuxer, durationSeconds }) {
  onProgress?.({ phase: "mux", completed: 0, total });
  const detected = media.map ? "fmp4" : sniff(await store.get(0));

  if (detected === "aac" || (detected === "ts" && mode !== "video")) {
    return assembleAac({ store, total, onProgress, metadata, signal });
  }

  if (detected === "ts") {
    if (createRemuxer) {
      try {
        const blob = await remuxTs({ store, total, onProgress, signal, createRemuxer });
        return { blob, extension: "mp4", mime: "video/mp4", durationSeconds, segmentCount: total };
      } catch (error) {
        if (error?.code === "cancelled") throw error;
      }
    }
    const blob = new Blob(await segmentFiles(store, total), { type: "video/mp2t" });
    return { blob, extension: "ts", mime: "video/mp2t", durationSeconds, segmentCount: total };
  }

  if (detected === "fmp4") {
    const init = media.map
      ? await fetchBytesWithRetry(media.map.url, { signal, byterange: media.map.byterange })
      : new Uint8Array(0);
    const files = await segmentFiles(store, total);
    if (mode !== "video") {
      const probe = init.length ? init : await store.get(0);
      if (fmp4HasVideo(probe, media.codecs)) throw new SpaceError("video", t("useVideoDownload"));
      const blob = new Blob([init, ...files], { type: "application/octet-stream" });
      return { blob, extension: "m4a", mime: "audio/mp4", durationSeconds, segmentCount: total };
    }
    const blob = new Blob([init, ...files], { type: "video/mp4" });
    return { blob, extension: "mp4", mime: "video/mp4", durationSeconds, segmentCount: total };
  }

  throw new SpaceError("audio", t("unknownAudioFormat"));
}
