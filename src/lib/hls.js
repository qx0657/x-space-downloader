import { concat } from "./bytes.js";
import { asSpaceError, SpaceError } from "./errors.js";
import { fetchWithTimeout } from "./net.js";
import { createAacCollector } from "./m4a.js";
import { extractAdtsFromTs } from "./ts-audio.js";

const VIDEO_CODECS = /avc1|hev1|hvc1|vp09|vp9|av01/i;

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
  const offset = offsetText != null
    ? Number(offsetText)
    : (previous ? previous.offset + previous.length : 0);
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

function highest(list) {
  return [...list].sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
}

function lowest(list) {
  return [...list].sort((a, b) => a.bandwidth - b.bandwidth)[0] || null;
}

export function selectPlaylistTarget(parsed, mode) {
  if (parsed.kind === "media") {
    return { url: parsed.url, bandwidth: parsed.bandwidth || 0, codecs: parsed.codecs || "", resolution: "" };
  }
  if (mode !== "video") {
    const audio = parsed.renditions.find((item) => item.type === "AUDIO" && item.uri && (item.default || item.uri));
    const preferred = parsed.renditions.find((item) => item.type === "AUDIO" && item.uri && item.default)
      || parsed.renditions.find((item) => item.type === "AUDIO" && item.uri);
    if (preferred || audio) {
      const chosen = preferred || audio;
      return { url: chosen.uri, bandwidth: 0, codecs: chosen.codecs || "mp4a", resolution: "" };
    }
    const audioVariants = parsed.variants.filter((item) => isAudioOnly(item.codecs));
    if (audioVariants.length) return highest(audioVariants);
    return lowest(parsed.variants);
  }
  return highest(parsed.variants);
}

export async function fetchText(url, signal) {
  assertHttpUrl(url);
  const response = await fetchWithTimeout(url, {
    signal,
    credentials: "omit",
    headers: { accept: "*/*", referer: "https://x.com/" },
  });
  if (!response.ok) throw new SpaceError("http", `打不开播放列表（${response.status}）`);
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
    if (!target?.url) throw new SpaceError("playlist", "播放列表里没有可下载的音轨");
    url = target.url;
    codecs = target.codecs || codecs;
    bandwidth = target.bandwidth || bandwidth;
  }
  throw new SpaceError("playlist", "播放列表嵌套异常");
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

function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SpaceError("playlist", "播放地址不可用");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SpaceError("playlist", "播放地址不可用");
  }
}

async function fetchBytes(url, { signal, byterange }) {
  assertHttpUrl(url);
  const headers = { accept: "*/*", referer: "https://x.com/" };
  if (byterange) {
    const end = byterange.offset + byterange.length - 1;
    headers.range = `bytes=${byterange.offset}-${end}`;
  }
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, { signal, credentials: "omit", headers });
      if (response.status === 404 || response.status === 403 || response.status === 401) {
        throw new SpaceError("http", `分片下载失败（${response.status}）`);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new SpaceError("retry", `分片下载失败（${response.status}）`);
      }
      if (!response.ok) throw new SpaceError("http", `分片下载失败（${response.status}）`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "cancelled" || error?.code === "http" || error?.code === "playlist") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  const code = lastError?.code === "timeout" || lastError?.code === "retry" ? lastError.code : "http";
  throw new SpaceError(code, lastError?.message || "分片下载失败");
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
  if (segment.key.method !== "AES-128") {
    throw new SpaceError("encrypted", "这条回放的加密方式暂不支持");
  }
  let key = keyCache.get(segment.key.uri);
  if (!key) {
    const raw = await fetchBytes(segment.key.uri, { signal });
    key = await crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]);
    keyCache.set(segment.key.uri, key);
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: segment.key.iv || sequenceIv(segment.sequence) },
    key,
    bytes,
  );
  return new Uint8Array(plain);
}

function sniff(data) {
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
  const text = new TextDecoder("latin1").decode(head);
  return /avc1|hvc1|hev1|vp09|av01/.test(text);
}

export function deviceConcurrency(env = globalThis.navigator || {}) {
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
  return { start: Math.max(2, Math.min(start, max)), min: 2, max };
}

function retryableDownloadError(error) {
  return error?.code === "timeout" || error?.code === "retry" || error?.code === "network";
}

async function adaptiveMap(items, fn, onTune) {
  const limits = deviceConcurrency();
  let limit = limits.start;
  const results = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index, tries: 0 }));
  let inflight = 0;
  let failure = null;
  const samples = [];
  let sinceBump = 0;
  onTune?.({ concurrency: limit });

  await new Promise((resolve, reject) => {
    const pump = () => {
      if (failure && inflight === 0) {
        reject(failure);
        return;
      }
      if (!failure && queue.length === 0 && inflight === 0) {
        resolve();
        return;
      }
      while (!failure && inflight < limit && queue.length > 0) {
        const job = queue.shift();
        inflight += 1;
        const began = Date.now();
        fn(job.item, job.index).then((value) => {
          results[job.index] = value;
          inflight -= 1;
          const elapsed = Date.now() - began;
          samples.push(elapsed);
          if (samples.length > 8) samples.shift();
          const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
          sinceBump += 1;
          if (sinceBump >= 6 && average < 700 && limit < limits.max) {
            limit = Math.min(limits.max, limit + 2);
            sinceBump = 0;
            onTune?.({ concurrency: limit });
          } else if (average > 2500 && limit > limits.min) {
            limit -= 1;
            sinceBump = 0;
            onTune?.({ concurrency: limit });
          }
          pump();
        }).catch((error) => {
          inflight -= 1;
          if (retryableDownloadError(error) && job.tries < 2) {
            job.tries += 1;
            queue.push(job);
            limit = Math.max(limits.min, Math.floor(limit * 0.6));
            sinceBump = 0;
            onTune?.({ concurrency: limit });
            pump();
            return;
          }
          if (!failure) failure = error;
          pump();
        });
      }
    };
    pump();
  });
  return results;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!failure) failure = error;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}

function resultFile(bytes, extension, mime, durationSeconds, segmentCount) {
  return { bytes, extension, mime, durationSeconds, segmentCount };
}

async function assemble(media, segments, { mode, signal, onProgress }) {
  const total = segments.length;
  let completed = 0;
  let lanes = deviceConcurrency().start;
  let detected = media.map ? "fmp4" : "";
  const keyCache = new Map();
  const pieces = await adaptiveMap(segments, async (segment, index) => {
    onProgress?.({ phase: "segment", completed, total, active: index + 1, concurrency: lanes });
    let bytes = await fetchBytes(segment.url, { signal, byterange: segment.byterange });
    bytes = await decryptSegment(bytes, segment, keyCache, signal);
    const kind = sniff(bytes);
    if (!detected) detected = kind;
    if (mode !== "video" && kind === "ts") bytes = extractAdtsFromTs(bytes);
    completed += 1;
    onProgress?.({ phase: "segment", completed, total, active: index + 1, concurrency: lanes });
    return bytes;
  }, (tune) => {
    if (tune.concurrency) lanes = tune.concurrency;
    onProgress?.({ phase: "segment", completed, total, concurrency: lanes });
  });
  onProgress?.({ phase: "mux", completed: total, total });
  const durationSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);

  if (mode === "video") {
    if (detected === "aac") {
      const muxed = muxAacPieces(pieces);
      return resultFile(muxed.bytes, "m4a", "audio/x-m4a", muxed.durationSeconds, total);
    }
    if (detected === "fmp4") {
      const bytes = await concatFragmented(media, pieces, signal);
      return resultFile(bytes, "mp4", "video/mp4", durationSeconds, total);
    }
    return resultFile(concat(pieces), "ts", "video/mp2t", durationSeconds, total);
  }

  if (detected === "aac" || detected === "ts") {
    const muxed = muxAacPieces(pieces);
    return resultFile(muxed.bytes, "m4a", "audio/x-m4a", muxed.durationSeconds, total);
  }
  if (detected === "fmp4") {
    const init = media.map
      ? await fetchBytes(media.map.url, { signal, byterange: media.map.byterange })
      : new Uint8Array(0);
    if (fmp4HasVideo(init.length ? init : pieces[0], media.codecs)) {
      throw new SpaceError("video", "这条回放是视频分段，请改用下载视频");
    }
    const bytes = concat(init.length ? [init, ...pieces] : pieces);
    return resultFile(bytes, "m4a", "audio/x-m4a", durationSeconds, total);
  }
  throw new SpaceError("audio", "认不出回放的音频格式");
}

function muxAacPieces(pieces) {
  const collector = createAacCollector();
  for (const piece of pieces) collector.push(piece);
  return collector.finish();
}

async function concatFragmented(media, pieces, signal) {
  if (!media.map) return concat(pieces);
  const init = await fetchBytes(media.map.url, { signal, byterange: media.map.byterange });
  return concat([init, ...pieces]);
}

export async function downloadRecording(entryUrl, options = {}) {
  const { mode = "audio", signal, onProgress, maxSegments = Infinity } = options;
  try {
    onProgress?.({ phase: "playlist", completed: 0, total: 0 });
    const media = await resolveMedia(entryUrl, mode, (url) => fetchText(url, signal));
    if (!media.endList) {
      throw new SpaceError("live", "回放还没有生成完整文件。若这场仍在直播，请等结束后再下载。");
    }
    if (!media.segments.length) throw new SpaceError("empty", "播放列表是空的");
    if (media.segments.length > 20000) throw new SpaceError("playlist", "播放列表异常地长，已停止");
    const limit = Number.isFinite(maxSegments) ? Math.max(0, maxSegments) : media.segments.length;
    const segments = media.segments.slice(0, limit);
    if (!segments.length) throw new SpaceError("empty", "没有可下载的音频分片");
    return await assemble(media, segments, { mode, signal, onProgress });
  } catch (error) {
    throw asSpaceError(error);
  }
}
