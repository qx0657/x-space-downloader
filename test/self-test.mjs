import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { writeFile } from "node:fs/promises";

import { concat } from "../src/lib/bytes.js";
import { createAacCollector } from "../src/lib/m4a.js";
import { deviceConcurrency, parsePlaylist, downloadRecording } from "../src/lib/hls.js";
import { spaceIdFromText } from "../src/lib/space-url.js";
import { activateGuest, findQueryId, inspectSpace } from "../src/lib/x-api.js";

const execFileAsync = promisify(execFile);
const nativeFetch = globalThis.fetch;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

globalThis.fetch = (url, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (!headers.has("user-agent")) headers.set("user-agent", BROWSER_UA);
  return nativeFetch(url, { ...options, headers });
};

function makeAdts(payloadLength) {
  const frameLength = 7 + payloadLength;
  const header = new Uint8Array(7);
  header[0] = 0xff;
  header[1] = 0xf1;
  header[2] = (1 << 6) | (3 << 2);
  header[3] = (2 << 6) | ((frameLength >> 11) & 0x03);
  header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 0x07) << 5) | 0x1f;
  header[6] = 0xfc;
  const payload = new Uint8Array(payloadLength).fill(0x11);
  return concat([header, payload]);
}

function id3Wrap(body) {
  const header = new Uint8Array(10);
  header.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  header[6] = (body.length >> 21) & 0x7f;
  header[7] = (body.length >> 14) & 0x7f;
  header[8] = (body.length >> 7) & 0x7f;
  header[9] = body.length & 0x7f;
  return concat([header, body]);
}

function boxes(bytes) {
  const found = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (size < 8) break;
    found.push(type);
    if (type === "mdat") break;
    offset += size;
  }
  return found;
}

test("picks fewer parallel downloads on small devices", () => {
  const phone = deviceConcurrency({
    hardwareConcurrency: 4,
    deviceMemory: 2,
    connection: { effectiveType: "3g", downlink: 1.5 },
  });
  const desktop = deviceConcurrency({
    hardwareConcurrency: 16,
    deviceMemory: 16,
    connection: { effectiveType: "4g", downlink: 40 },
  });
  assert.ok(phone.start <= 4);
  assert.ok(phone.max <= 6);
  assert.ok(desktop.start >= 8);
  assert.ok(desktop.max >= phone.max);
  assert.ok(desktop.start <= desktop.max);
});

test("parses a Space URL", () => {
  assert.equal(spaceIdFromText("https://x.com/i/spaces/1OwxWwQOPlNxQ"), "1OwxWwQOPlNxQ");
  assert.equal(spaceIdFromText("https://twitter.com/i/spaces/1OwxWwQOPlNxQ/peek"), "1OwxWwQOPlNxQ");
  assert.equal(spaceIdFromText("1OwxWwQOPlNxQ"), "1OwxWwQOPlNxQ");
  assert.equal(spaceIdFromText("https://x.com/home"), null);
});

test("finds a rotated AudioSpace query id", () => {
  const source = 'e.exports={queryId:"abcDEF123456",operationName:"AudioSpaceById",operationType:"query"}';
  assert.equal(findQueryId(source), "abcDEF123456");
});

test("parses a master playlist whose codecs contain commas", () => {
  const text = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=224x392,CODECS="avc1.640015,mp4a.40.2"',
    "/low/playlist.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=720x1280,CODECS="avc1.64001e,mp4a.40.2"',
    "high/playlist.m3u8",
  ].join("\n");
  const parsed = parsePlaylist(text, "https://cdn.example/master.m3u8");
  assert.equal(parsed.kind, "master");
  assert.equal(parsed.variants.length, 2);
  assert.equal(parsed.variants[0].codecs, "avc1.640015,mp4a.40.2");
  assert.equal(parsed.variants[0].url, "https://cdn.example/low/playlist.m3u8");
  assert.equal(parsed.variants[1].url, "https://cdn.example/high/playlist.m3u8");
});

test("muxes AAC frames that begin with an ID3 tag", () => {
  const collector = createAacCollector();
  const frame = makeAdts(16);
  collector.push(concat([id3Wrap(new Uint8Array([1, 2, 3])), frame]));
  collector.push(frame.subarray(0, 4));
  collector.push(frame.subarray(4));
  const file = collector.finish();
  assert.equal(file.frameCount, 2);
  assert.equal(file.sampleRate, 48000);
  assert.equal(file.channels, 2);
  assert.deepEqual(boxes(file.bytes).slice(0, 3), ["ftyp", "moov", "mdat"]);
});

test("downloads two real audio segments into a playable m4a", async () => {
  const guestToken = await activateGuest();
  const info = await inspectSpace("1OwxWwQOPlNxQ", { mode: "guest", guestToken });
  assert.equal(info.canDownload, true);
  assert.match(info.title, /Everybody in/);
  assert.equal(info.handle, "mtbarra");
  assert.ok(info.durationSeconds > 500);
  const file = await downloadRecording(info.audioMediaUrl, { mode: "audio", maxSegments: 2 });
  assert.equal(file.extension, "m4a");
  assert.ok(file.durationSeconds > 5 && file.durationSeconds < 8);
  const path = "/tmp/x-space-sample.m4a";
  await writeFile(path, file.bytes);
  const { stdout } = await execFileAsync("afinfo", [path]);
  assert.match(stdout, /Data format:.*aac/i);
  assert.match(stdout, /48000 Hz/);
  assert.match(stdout, /2 ch/);
  assert.match(stdout, /Stereo/);
});

test("extracts audio from one video Space segment", async () => {
  const guestToken = await activateGuest();
  const info = await inspectSpace("1DXGydznBYWKM", { mode: "guest", guestToken });
  assert.equal(info.canDownload, true);
  assert.equal(info.videoAvailable, true);
  const file = await downloadRecording(info.audioMediaUrl, { mode: "audio", maxSegments: 1 });
  assert.equal(file.extension, "m4a");
  const path = "/tmp/x-space-video-audio.m4a";
  await writeFile(path, file.bytes);
  const { stdout } = await execFileAsync("afinfo", [path]);
  assert.match(stdout, /Data format:.*aac/i);
});
